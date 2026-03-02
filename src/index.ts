import * as core from '@actions/core';
import * as github from '@actions/github';
import { ActionConfig, ActionResult, GeneratedTest, LLMProvider, DiffMode, TraceMode } from './types';
import { createLLMClient } from './providers';
import { DiffAnalyzer } from './diff/analyzer';
import { TestGenerator } from './generator/test-generator';
import { GitOps } from './utils/git-ops';
import { TraceUploader } from './utils/trace-uploader';

async function run(): Promise<void> {
  try {
    // ─── Parse Inputs ───
    const config = parseConfig();
    core.info(`AutoSpec AI starting...`);
    core.info(`Provider: ${config.llm.provider} | Model: ${config.llm.model || '(default)'}`);
    core.info(`Test dir: ${config.testDirectory} | Framework: ${config.framework}`);

    // ─── Initialize LLM Client ───
    const llm = createLLMClient(config.llm);

    // ─── Analyze Diff ───
    core.startGroup('📋 Analyzing changes');
    const analyzer = new DiffAnalyzer(config);
    const diff = await analyzer.analyze();
    core.info(`${diff.summary}`);
    core.info(`${diff.files.length} files changed`);
    diff.files.forEach(f => core.info(`  ${f.status}: ${f.filename} (+${f.additions}/-${f.deletions})`));
    core.endGroup();

    if (diff.files.length === 0) {
      const result: ActionResult = {
        testsGenerated: 0,
        testFiles: [],
        summary: 'No testable changes detected.',
      };
      setOutputs(result);
      return;
    }

    // ─── Generate Tests ───
    core.startGroup('🧪 Generating tests');
    const generator = new TestGenerator(config, llm);
    const tests = await generator.generate(diff);
    core.endGroup();

    if (tests.length === 0) {
      const result: ActionResult = {
        testsGenerated: 0,
        testFiles: [],
        summary: 'LLM determined no new E2E tests are needed for these changes.',
      };
      setOutputs(result);
      return;
    }

    // ─── Write or Preview ───
    if (config.dryRun) {
      core.startGroup('🔍 Dry Run Preview');
      const enabledFeatures = getEnabledFeatures(config);
      if (enabledFeatures.length > 0) {
        core.info(`Features enabled: ${enabledFeatures.join(', ')}`);
      }
      for (const test of tests) {
        core.info(`\n${'─'.repeat(60)}`);
        core.info(`File: ${test.filepath}`);
        core.info(`Description: ${test.description}`);
        core.info(`Severity: ${test.severity}`);
        core.info(`Source: ${test.sourceFiles.join(', ')}`);
        core.info(`${'─'.repeat(60)}`);
        core.info(test.content);
      }
      core.endGroup();

      const result: ActionResult = {
        testsGenerated: tests.length,
        testFiles: tests.map(t => t.filepath),
        summary: `[DRY RUN] Would generate ${tests.length} test(s): ${tests.map(t => t.filename).join(', ')}`,
      };
      setOutputs(result);
      return;
    }

    // Write tests to disk
    core.startGroup('💾 Writing test files');
    const writtenFiles = await generator.writeTests(tests);
    core.endGroup();

    // Write fixture files (API mock extraction)
    let fixtureFiles: string[] = [];
    if (config.generateApiMocks) {
      core.startGroup('📦 Writing fixture files');
      fixtureFiles = await generator.writeFixtures();
      if (fixtureFiles.length > 0) {
        core.info(`Wrote ${fixtureFiles.length} fixture file(s)`);
      }
      core.endGroup();
    }

    // ─── Commit / PR ───
    let prNumber: number | undefined;

    // [FIX #4] Warn if both auto_pr and auto_commit are enabled
    if (config.autoPr && config.autoCommit) {
      core.warning('Both auto_pr and auto_commit are enabled; auto_pr takes precedence.');
    }

    if (config.autoPr) {
      core.startGroup('🔀 Creating Pull Request');
      const gitOps = new GitOps();
      const baseBranch = getBaseBranch();
      prNumber = await gitOps.createPR(tests, baseBranch, diff.headSha, config, fixtureFiles);
      core.endGroup();
    } else if (config.autoCommit) {
      core.startGroup('📝 Committing tests');
      const gitOps = new GitOps();
      await gitOps.commitTests(tests, diff.headSha, fixtureFiles);
      core.endGroup();
    }

    // Upload traces if enabled
    if (config.traceOnFailure) {
      core.startGroup('📤 Uploading traces');
      await TraceUploader.uploadTraces('test-results');
      core.endGroup();
    }

    // ─── Set Outputs ───
    const result: ActionResult = {
      testsGenerated: tests.length,
      testFiles: writtenFiles,
      fixtureFiles: fixtureFiles.length > 0 ? fixtureFiles : undefined,
      prNumber,
      summary: `Generated ${tests.length} test(s): ${tests.map(t => t.filename).join(', ')}${prNumber ? ` (PR #${prNumber})` : ''}`,
    };
    setOutputs(result);

    // Job summary
    await writeSummary(tests, result, config);

    core.info(`\n✅ AutoSpec AI complete: ${result.summary}`);
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(`AutoSpec AI failed: ${error.message}`);
    } else {
      core.setFailed('AutoSpec AI failed with an unknown error');
    }
  }
}

// ─── Config Parsing ───

const VALID_PROVIDERS: LLMProvider[] = ['anthropic', 'openai', 'custom'];
const VALID_DIFF_MODES: DiffMode[] = ['auto', 'pr', 'push'];
const VALID_TRACE_MODES: TraceMode[] = ['on', 'off', 'retain-on-failure', 'on-first-retry'];

function parseConfig(): ActionConfig {
  // [FIX #8] Validate LLM provider at runtime
  const rawProvider = core.getInput('llm_provider') || 'anthropic';
  if (!VALID_PROVIDERS.includes(rawProvider as LLMProvider)) {
    throw new Error(`Invalid llm_provider "${rawProvider}". Must be one of: ${VALID_PROVIDERS.join(', ')}`);
  }
  const provider = rawProvider as LLMProvider;

  // [FIX #11] Validate diff mode at runtime
  const rawDiffMode = core.getInput('diff_mode') || 'auto';
  if (!VALID_DIFF_MODES.includes(rawDiffMode as DiffMode)) {
    throw new Error(`Invalid diff_mode "${rawDiffMode}". Must be one of: ${VALID_DIFF_MODES.join(', ')}`);
  }

  const model = core.getInput('llm_model');

  // [FIX #5] Validate max_test_files is a valid positive integer
  const rawMax = parseInt(core.getInput('max_test_files') || '5', 10);
  if (isNaN(rawMax) || rawMax < 1) {
    throw new Error(`Invalid max_test_files value: "${core.getInput('max_test_files')}". Must be a positive integer.`);
  }

  // [Feature] Validate trace mode
  const rawTraceMode = core.getInput('trace_mode') || 'retain-on-failure';
  if (!VALID_TRACE_MODES.includes(rawTraceMode as TraceMode)) {
    throw new Error(`Invalid trace_mode "${rawTraceMode}". Must be one of: ${VALID_TRACE_MODES.join(', ')}`);
  }

  // [Feature] Validate fixture extraction threshold
  const rawThreshold = parseInt(core.getInput('fixture_extraction_threshold') || '3', 10);
  if (isNaN(rawThreshold) || rawThreshold < 1) {
    throw new Error(`Invalid fixture_extraction_threshold value: "${core.getInput('fixture_extraction_threshold')}". Must be a positive integer.`);
  }

  return {
    llm: {
      provider,
      apiKey: core.getInput('llm_api_key', { required: true }),
      model: model || '',
      baseUrl: core.getInput('llm_base_url') || undefined,
    },
    testDirectory: core.getInput('test_directory') || 'e2e/generated',
    testPatterns: parseCSV(core.getInput('test_pattern') || 'e2e/**/*.spec.ts,*-e2e/**/*.spec.ts'),
    baseUrl: core.getInput('base_url') || 'http://localhost:3000',
    framework: core.getInput('framework') || 'generic',
    diffMode: rawDiffMode as DiffMode,
    includePaths: parseCSV(core.getInput('include_paths')),
    excludePaths: parseCSV(core.getInput('exclude_paths') || 'test/,tests/,e2e/,__tests__/,.github/,docs/,README'),
    autoCommit: core.getBooleanInput('auto_commit'),
    autoPr: core.getBooleanInput('auto_pr'),
    maxTestFiles: rawMax,
    dryRun: core.getBooleanInput('dry_run'),
    customInstructions: core.getInput('custom_instructions') || '',

    // Feature: Trace Viewer Integration
    traceOnFailure: core.getBooleanInput('trace_on_failure'),
    traceMode: rawTraceMode as TraceMode,

    // Feature: API Mock Generation
    generateApiMocks: core.getBooleanInput('generate_api_mocks'),
    mockErrorStates: core.getBooleanInput('mock_error_states'),
    fixtureExtractionThreshold: rawThreshold,

    // Feature: Visual Regression Baselines
    visualRegression: core.getBooleanInput('visual_regression'),
    visualThreshold: parseFloat(core.getInput('visual_threshold') || '0.2'),
    visualMaxDiffRatio: parseFloat(core.getInput('visual_max_diff_ratio') || '0.05'),
    visualFullPage: core.getBooleanInput('visual_full_page'),

    // Feature: Accessibility / Aria Snapshot Assertions
    accessibilityAssertions: core.getBooleanInput('accessibility_assertions'),
    axeScan: core.getBooleanInput('axe_scan'),
    axeStandard: core.getInput('axe_standard') || 'wcag2aa',
  };
}

function parseCSV(input: string): string[] {
  return input
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

function getBaseBranch(): string {
  const context = github.context;
  if (context.payload.pull_request) {
    return context.payload.pull_request.base.ref;
  }
  return context.ref.replace('refs/heads/', '');
}

// ─── Outputs ───

function setOutputs(result: ActionResult): void {
  core.setOutput('tests_generated', result.testsGenerated.toString());
  core.setOutput('test_files', JSON.stringify(result.testFiles));
  core.setOutput('summary', result.summary);
  if (result.prNumber) {
    core.setOutput('pr_number', result.prNumber.toString());
  }
  if (result.fixtureFiles) {
    core.setOutput('fixture_files', JSON.stringify(result.fixtureFiles));
  }
}

function getEnabledFeatures(config: ActionConfig): string[] {
  const features: string[] = [];
  if (config.traceOnFailure) features.push(`Trace (${config.traceMode})`);
  if (config.generateApiMocks) features.push('API Mocks');
  if (config.visualRegression) features.push('Visual Regression');
  if (config.accessibilityAssertions) features.push('Aria Snapshots');
  if (config.axeScan) features.push(`Axe Scan (${config.axeStandard})`);
  return features;
}

// [FIX #9] Removed dead `rows` variable
async function writeSummary(tests: GeneratedTest[], result: ActionResult, config?: ActionConfig): Promise<void> {
  const enabledFeatures = config ? getEnabledFeatures(config) : [];
  const featuresLine = enabledFeatures.length > 0
    ? `\n**Features enabled:** ${enabledFeatures.join(', ')}\n`
    : '';

  await core.summary
    .addHeading('🤖 AutoSpec AI - Test Generation Report', 2)
    .addRaw(`\n${result.summary}\n${featuresLine}\n`)
    .addTable([
      [
        { data: 'Test File', header: true },
        { data: 'Severity', header: true },
        { data: 'Description', header: true },
        { data: 'Source', header: true },
        ...(enabledFeatures.length > 0 ? [{ data: 'Features', header: true }] : []),
      ],
      ...tests.map(t => {
        const features: string[] = [];
        if (config?.traceOnFailure) features.push('trace');
        if (config?.visualRegression) features.push('visual');
        if (config?.axeScan) features.push('axe');
        if (config?.accessibilityAssertions) features.push('aria');
        return [
          `\`${t.filename}\``,
          `\`@${t.severity}\``,
          t.description,
          t.sourceFiles.map(f => `\`${f}\``).join(', '),
          ...(enabledFeatures.length > 0 ? [features.join(', ')] : []),
        ];
      }),
    ])
    .write();
}

run();
