import * as core from '@actions/core';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { glob } from 'glob';
import {
  ActionConfig,
  DiffResult,
  ExistingTest,
  ExtractedFixture,
  GeneratedPomFile,
  GeneratedTest,
  LLMClient,
  TestPlan,
} from '../types';
import { PromptBuilder } from './prompts';
import { TestPostProcessor } from '../utils/test-post-processor';
import { FixtureExtractor } from '../utils/fixture-extractor';
import { ProjectScanner } from '../discovery/project-scanner';

// [FIX #3] Safe filename pattern: allow alphanumeric, hyphens, underscores, dots, forward slashes
// but no '..' segments, no absolute paths, no backslashes
const SAFE_FILENAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._\-/]*$/;
const DISCOVERY_IGNORE = ['**/node_modules/**', '**/dist/**', '**/.git/**'];

function validateTestFilename(filename: string): void {
  if (!SAFE_FILENAME_PATTERN.test(filename)) {
    throw new Error(`Unsafe test filename rejected: "${filename}". Only alphanumeric, hyphens, underscores, dots, and forward slashes are allowed.`);
  }
  if (filename.includes('..')) {
    throw new Error(`Unsafe test filename rejected: "${filename}". Path traversal (..) is not allowed.`);
  }
  if (path.isAbsolute(filename)) {
    throw new Error(`Unsafe test filename rejected: "${filename}". Absolute paths are not allowed.`);
  }
  if (!filename.endsWith('.spec.ts')) {
    throw new Error(`Unsafe test filename rejected: "${filename}". Generated tests must use the .spec.ts extension.`);
  }
}

function validateGeneratedFilename(filename: string, kind: string, extensions: string[]): void {
  if (!SAFE_FILENAME_PATTERN.test(filename) || filename.includes('..') || path.isAbsolute(filename)) {
    throw new Error(`Unsafe ${kind} filename rejected: "${filename}".`);
  }
  if (!extensions.some(extension => filename.endsWith(extension))) {
    throw new Error(`${kind} filename "${filename}" must end with ${extensions.join(' or ')}.`);
  }
}

function validateContainedPath(filepath: string, directory: string, label: string): void {
  const resolvedDir = path.resolve(directory);
  const resolvedPath = path.resolve(filepath);
  if (!resolvedPath.startsWith(resolvedDir + path.sep) && resolvedPath !== resolvedDir) {
    throw new Error(`${label} filepath "${filepath}" resolves outside the configured directory "${directory}".`);
  }
}

function validateTypeScript(code: string, filename: string): void {
  const result = ts.transpileModule(code, {
    fileName: filename,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
  });
  const errors = (result.diagnostics ?? []).filter(
    diagnostic => diagnostic.category === ts.DiagnosticCategory.Error
  );
  if (errors.length > 0) {
    const message = ts.flattenDiagnosticMessageText(errors[0].messageText, '\n');
    throw new Error(`Generated TypeScript in "${filename}" is invalid: ${message}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateTestPlan(value: unknown, diff: DiffResult): TestPlan {
  if (!isRecord(value) || typeof value.reasoning !== 'string' || !Array.isArray(value.tests)) {
    throw new Error('Plan must contain a string reasoning field and a tests array.');
  }
  if (value.tests.length > 100) {
    throw new Error('Plan contains more than 100 tests.');
  }

  const changedFiles = new Set(diff.files.map(file => file.filename));
  const tests = value.tests.map((candidate, index) => {
    if (!isRecord(candidate)) throw new Error(`Plan test ${index + 1} must be an object.`);
    const requiredStrings = ['targetFile', 'testFilename', 'description'] as const;
    for (const field of requiredStrings) {
      if (typeof candidate[field] !== 'string' || candidate[field].trim() === '') {
        throw new Error(`Plan test ${index + 1} has an invalid ${field}.`);
      }
    }
    if (!changedFiles.has(candidate.targetFile as string)) {
      throw new Error(`Plan test ${index + 1} targets a file that is not in the analyzed diff.`);
    }
    validateTestFilename(candidate.testFilename as string);
    if (!Array.isArray(candidate.userFlows) || !candidate.userFlows.every(flow => typeof flow === 'string')) {
      throw new Error(`Plan test ${index + 1} has invalid userFlows.`);
    }
    if (!['high', 'medium', 'low'].includes(candidate.priority as string)) {
      throw new Error(`Plan test ${index + 1} has an invalid priority.`);
    }
    if (!['sev1', 'sev2', 'sev3', 'sev4'].includes(candidate.severity as string)) {
      throw new Error(`Plan test ${index + 1} has an invalid severity.`);
    }

    let apiDependencies: TestPlan['tests'][number]['apiDependencies'];
    if (candidate.apiDependencies !== undefined) {
      if (!Array.isArray(candidate.apiDependencies)) {
        throw new Error(`Plan test ${index + 1} has invalid apiDependencies.`);
      }
      apiDependencies = candidate.apiDependencies.map((dependency, dependencyIndex) => {
        if (!isRecord(dependency)) {
          throw new Error(`API dependency ${dependencyIndex + 1} in plan test ${index + 1} must be an object.`);
        }
        for (const field of ['url', 'method', 'description'] as const) {
          if (typeof dependency[field] !== 'string') {
            throw new Error(`API dependency ${dependencyIndex + 1} in plan test ${index + 1} has an invalid ${field}.`);
          }
        }
        if (dependency.responseShape !== undefined && typeof dependency.responseShape !== 'string') {
          throw new Error(`API dependency ${dependencyIndex + 1} has an invalid responseShape.`);
        }
        if (dependency.isWebSocket !== undefined && typeof dependency.isWebSocket !== 'boolean') {
          throw new Error(`API dependency ${dependencyIndex + 1} has an invalid isWebSocket value.`);
        }
        return {
          url: dependency.url as string,
          method: dependency.method as string,
          description: dependency.description as string,
          responseShape: dependency.responseShape as string | undefined,
          isWebSocket: dependency.isWebSocket as boolean | undefined,
        };
      });
    }

    return {
      targetFile: candidate.targetFile as string,
      testFilename: candidate.testFilename as string,
      description: candidate.description as string,
      userFlows: candidate.userFlows as string[],
      priority: candidate.priority as 'high' | 'medium' | 'low',
      severity: candidate.severity as 'sev1' | 'sev2' | 'sev3' | 'sev4',
      apiDependencies,
    };
  });

  return { reasoning: value.reasoning, tests };
}

export class TestGenerator {
  private config: ActionConfig;
  private llm: LLMClient;
  private prompts: PromptBuilder;
  private extractedFixtures: ExtractedFixture[] = [];
  private generatedPomFiles: GeneratedPomFile[] = [];

  constructor(config: ActionConfig, llm: LLMClient) {
    this.config = config;
    this.llm = llm;
    this.prompts = new PromptBuilder(config);
  }

  async generate(diff: DiffResult): Promise<GeneratedTest[]> {
    if (diff.files.length === 0) {
      core.info('No relevant file changes detected. Skipping test generation.');
      return [];
    }

    // Step 1: Discover existing tests for style reference + dedup
    const existingTests = await this.discoverExistingTests(diff);
    core.info(`Found ${existingTests.length} existing test files for reference`);

    // Step 1b: Scan project structure for POM, utilities, and coverage
    const scanner = new ProjectScanner(this.config);
    const projectContext = await scanner.scan(diff);
    this.prompts.setProjectContext(projectContext);

    // Step 2: Generate test plan
    const plan = await this.generatePlan(diff, existingTests);
    if (plan.tests.length === 0) {
      core.info('Test plan determined no new tests are needed.');
      return [];
    }

    core.info(`Test plan: ${plan.tests.length} tests planned`);
    plan.tests.forEach(t =>
      core.info(`  → [${t.priority}] [@${t.severity}] ${t.testFilename}: ${t.description}`)
    );

    // Step 3: Generate test code for each planned test
    const styleRef = this.pickStyleReference(existingTests);
    const tests: GeneratedTest[] = [];

    // Respect max_test_files limit, prioritize high > medium > low
    const sorted = [...plan.tests].sort((a, b) => {
      const order = { high: 0, medium: 1, low: 2 };
      return order[a.priority] - order[b.priority];
    });
    const toGenerate = sorted.slice(0, this.config.maxTestFiles);

    for (const entry of toGenerate) {
      try {
        // [FIX #3] Validate filename before using it
        validateTestFilename(entry.testFilename);

        core.info(`Generating test: ${entry.testFilename}...`);
        const test = await this.generateTest(entry, diff, existingTests, styleRef);

        // [FIX #3] Validate the resolved path stays within testDirectory
        validateContainedPath(test.filepath, this.config.testDirectory, 'Test');

        tests.push(test);
        core.info(`  ✓ Generated ${test.filepath} (${test.content.length} chars)`);
      } catch (err) {
        core.warning(`Failed to generate test for ${entry.testFilename}: ${err}`);
      }
    }

    // ─── Fixture Extraction ───
    if (this.config.generateApiMocks) {
      this.extractedFixtures = FixtureExtractor.extractFixtures(
        tests,
        this.config.fixtureExtractionThreshold,
        this.config.testDirectory
      );
      if (this.extractedFixtures.length > 0) {
        for (const test of tests) validateTypeScript(test.content, test.filename);
        for (const fixture of this.extractedFixtures) validateTypeScript(fixture.content, fixture.filepath);
        core.info(`Extracted ${this.extractedFixtures.length} fixture file(s) from tests with heavy API mocking`);
      }
    }

    return tests;
  }

  // ─── Fixture Writing ───

  async writeFixtures(): Promise<string[]> {
    if (this.extractedFixtures.length === 0) {
      return [];
    }

    const written: string[] = [];

    for (const fixture of this.extractedFixtures) {
      const fullPath = path.resolve(fixture.filepath);
      const dir = path.dirname(fullPath);

      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(fullPath, fixture.content, 'utf-8');
      written.push(fixture.filepath);
      core.info(`Wrote fixture: ${fixture.filepath}`);
    }

    return written;
  }

  getExtractedFixtures(): ExtractedFixture[] {
    return this.extractedFixtures;
  }

  getGeneratedPomFiles(): GeneratedPomFile[] {
    return this.generatedPomFiles;
  }

  async writePomFiles(): Promise<string[]> {
    if (this.generatedPomFiles.length === 0) return [];
    const written: string[] = [];

    for (const pom of this.generatedPomFiles) {
      const fullPath = path.resolve(pom.filepath);
      const dir = path.dirname(fullPath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(fullPath, pom.content, 'utf-8');
      written.push(pom.filepath);
      core.info(`Wrote POM: ${pom.filepath}`);
    }

    return written;
  }

  /**
   * Extract `// POM_FILE: <filename>` blocks from LLM output.
   * Returns the test code with POM blocks removed.
   */
  private extractPomFiles(code: string): string {
    const pomDir = this.config.pomOutputDirectory;
    if (!pomDir) return code;

    const pomMarker = /^\/\/\s*POM_FILE:\s*(.+)$/gm;
    const parts = code.split(pomMarker);

    // If no POM_FILE markers found, return code as-is
    if (parts.length <= 1) return code;

    // parts[0] is the test code before any POM_FILE marker
    // parts[1] is the filename, parts[2] is the POM content, etc.
    const testCode = parts[0];

    const extracted: GeneratedPomFile[] = [];
    for (let i = 1; i < parts.length; i += 2) {
      const filename = parts[i].trim();
      const pomContent = (parts[i + 1] || '').trim();

      if (filename && pomContent) {
        validateGeneratedFilename(filename, 'POM', ['.ts', '.tsx']);
        const filepath = path.join(pomDir, filename);
        validateContainedPath(filepath, pomDir, 'POM');
        validateTypeScript(pomContent, filepath);
        extracted.push({ filename, filepath, content: pomContent });
        core.info(`Extracted POM file: ${filepath}`);
      }
    }

    this.generatedPomFiles.push(...extracted);

    return testCode.trim();
  }

  // ─── Phase 1: Planning ───

  private async generatePlan(
    diff: DiffResult,
    existingTests: ExistingTest[]
  ): Promise<TestPlan> {
    const prompt = this.prompts.buildPlanPrompt(diff, existingTests);

    const response = await this.llm.generate(
      [
        {
          role: 'system',
          content:
            'You are a QA automation architect. Respond only with valid JSON. No markdown, no explanation.',
        },
        { role: 'user', content: prompt },
      ],
      { maxTokens: 4096, temperature: 0 }
    );

    // Parse the JSON response
    const cleaned = response.content
      .replace(/```json\s*/g, '')
      .replace(/```\s*/g, '')
      .trim();

    try {
      const plan = validateTestPlan(JSON.parse(cleaned) as unknown, diff);
      core.info(`Plan reasoning: ${plan.reasoning}`);
      return plan;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      core.debug(`Invalid plan response preview: ${response.content.slice(0, 500)}`);
      throw new Error(`LLM returned an invalid test plan: ${detail}`);
    }
  }

  // ─── Phase 2: Code Generation ───

  private async generateTest(
    planEntry: TestPlan['tests'][number],
    diff: DiffResult,
    existingTests: ExistingTest[],
    styleReference?: string
  ): Promise<GeneratedTest> {
    const prompt = this.prompts.buildTestPrompt(
      planEntry,
      diff,
      existingTests,
      styleReference
    );

    const response = await this.llm.generate(
      [
        {
          role: 'system',
          content:
            'You are an expert Playwright test author. Respond with ONLY valid TypeScript code. No markdown fences, no commentary.',
        },
        { role: 'user', content: prompt },
      ],
      { maxTokens: 8192, temperature: 0 }
    );

    // Clean potential markdown fences from response
    let code = response.content
      .replace(/^```(?:typescript|ts)?\s*\n?/gm, '')
      .replace(/\n?```\s*$/gm, '')
      .trim();

    // ─── Extract POM files if pomOutputDirectory is configured ───
    if (this.config.pomOutputDirectory) {
      code = this.extractPomFiles(code);
    }

    // Ensure the file starts with an import
    if (!code.startsWith('import')) {
      const importIndex = code.indexOf('import');
      if (importIndex > 0) {
        code = code.slice(importIndex);
      }
    }

    // ─── Post-processing pipeline ───
    // Order: inject trace → ensure axe import → normalize screenshots
    if (this.config.traceOnFailure) {
      code = TestPostProcessor.injectTraceConfig(code, this.config.traceMode);
    }
    if (this.config.axeScan) {
      code = TestPostProcessor.ensureAxeImport(code);
    }
    if (this.config.visualRegression) {
      code = TestPostProcessor.normalizeScreenshotOptions(
        code,
        this.config.visualThreshold,
        this.config.visualMaxDiffRatio,
        this.config.visualFullPage
      );
    }

    if (!/from\s+['"]@playwright\/test['"]/.test(code) || !/\btest(?:\.describe)?\s*\(/.test(code)) {
      throw new Error(`Generated test "${planEntry.testFilename}" is missing a Playwright import or test declaration.`);
    }
    validateTypeScript(code, planEntry.testFilename);

    const filepath = path.join(this.config.testDirectory, planEntry.testFilename);

    return {
      filename: planEntry.testFilename,
      filepath,
      content: code,
      sourceFiles: [planEntry.targetFile],
      description: planEntry.description,
      severity: planEntry.severity,
    };
  }

  // ─── Existing Test Discovery ───

  private async discoverExistingTests(diff: DiffResult): Promise<ExistingTest[]> {
    const seen = new Set<string>();
    const tests: ExistingTest[] = [];
    for (const pattern of this.config.testPatterns) {
      const matches = await glob(pattern, { absolute: true, ignore: DISCOVERY_IGNORE });
      const rankedMatches = matches.sort((a, b) => {
        const relativeA = path.relative(process.cwd(), a);
        const relativeB = path.relative(process.cwd(), b);
        const score = (candidate: string): number => diff.files.reduce((total, changed) => {
          const candidateParts = candidate.split(path.sep);
          const changedParts = changed.filename.split('/');
          let shared = 0;
          while (shared < candidateParts.length && shared < changedParts.length && candidateParts[shared] === changedParts[shared]) {
            shared++;
          }
          return Math.max(total, shared);
        }, 0);
        return score(relativeB) - score(relativeA) || relativeA.localeCompare(relativeB);
      });
      for (const filepath of rankedMatches) {
        if (tests.length >= 10) break;
        const rel = path.relative(process.cwd(), filepath);
        if (seen.has(rel)) continue;
        seen.add(rel);
        try {
          const content = fs.readFileSync(filepath, 'utf-8');
          tests.push({ filepath: rel, content: content.slice(0, 3000) });
        } catch { /* skip */ }
      }
      if (tests.length >= 10) break;
    }
    return tests;
  }

  private pickStyleReference(existingTests: ExistingTest[]): string | undefined {
    if (existingTests.length === 0) return undefined;
    // Pick the most representative test (largest, likely most complete)
    const sorted = [...existingTests].sort(
      (a, b) => b.content.length - a.content.length
    );
    return sorted[0]?.content;
  }

  // ─── Write Tests to Disk ───

  async writeTests(tests: GeneratedTest[]): Promise<string[]> {
    const written: string[] = [];

    for (const test of tests) {
      // [FIX #3] Re-validate before writing to disk
      validateContainedPath(test.filepath, this.config.testDirectory, 'Test');

      const fullPath = path.resolve(test.filepath);
      const dir = path.dirname(fullPath);

      // Ensure directory exists
      fs.mkdirSync(dir, { recursive: true });

      // Write the test file
      fs.writeFileSync(fullPath, test.content, 'utf-8');
      written.push(test.filepath);
      core.info(`Wrote: ${test.filepath}`);
    }

    return written;
  }

  preflightWrites(tests: GeneratedTest[]): void {
    const targets = [
      ...tests.map(test => ({ filepath: test.filepath, directory: this.config.testDirectory, label: 'Test' })),
      ...this.extractedFixtures.map(fixture => ({ filepath: fixture.filepath, directory: this.config.testDirectory, label: 'Fixture' })),
      ...this.generatedPomFiles.map(pom => ({ filepath: pom.filepath, directory: this.config.pomOutputDirectory, label: 'POM' })),
    ];
    const seen = new Set<string>();
    for (const target of targets) {
      validateContainedPath(target.filepath, target.directory, target.label);
      const resolved = path.resolve(target.filepath);
      if (seen.has(resolved)) {
        throw new Error(`Multiple generated artifacts target the same path: "${target.filepath}".`);
      }
      seen.add(resolved);
      if (!this.config.overwriteExistingFiles && fs.existsSync(resolved)) {
        throw new Error(
          `Refusing to overwrite existing ${target.label.toLowerCase()} file "${target.filepath}". ` +
          'Set overwrite_existing_files to true to allow this.'
        );
      }
    }
  }
}
