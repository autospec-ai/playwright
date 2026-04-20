import * as core from '@actions/core';
import * as fs from 'fs';
import * as path from 'path';
import { glob } from 'glob';
import {
  ActionConfig,
  DiffResult,
  ExistingTest,
  ExtractedFixture,
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
}

function validateTestPath(filepath: string, testDirectory: string): void {
  const resolvedDir = path.resolve(testDirectory);
  const resolvedPath = path.resolve(filepath);
  if (!resolvedPath.startsWith(resolvedDir + path.sep) && resolvedPath !== resolvedDir) {
    throw new Error(`Test filepath "${filepath}" resolves outside the test directory "${testDirectory}".`);
  }
}

interface GeneratedPomFile {
  filename: string;
  filepath: string;
  content: string;
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
    const existingTests = await this.discoverExistingTests();
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
        validateTestPath(test.filepath, this.config.testDirectory);

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

    for (let i = 1; i < parts.length; i += 2) {
      const filename = parts[i].trim();
      const pomContent = (parts[i + 1] || '').trim();

      if (filename && pomContent) {
        const filepath = path.join(pomDir, filename);
        this.generatedPomFiles.push({ filename, filepath, content: pomContent });
        core.info(`Extracted POM file: ${filepath}`);
      }
    }

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
      const plan = JSON.parse(cleaned) as TestPlan;
      core.info(`Plan reasoning: ${plan.reasoning}`);
      return plan;
    } catch (err) {
      core.warning(`Failed to parse test plan JSON: ${err}\nRaw response:\n${response.content}`);
      return { reasoning: 'Failed to parse LLM response', tests: [] };
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

  private async discoverExistingTests(): Promise<ExistingTest[]> {
    const seen = new Set<string>();
    const tests: ExistingTest[] = [];
    for (const pattern of this.config.testPatterns) {
      const matches = await glob(pattern, { absolute: true });
      for (const filepath of matches) {
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
      validateTestPath(test.filepath, this.config.testDirectory);

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
}
