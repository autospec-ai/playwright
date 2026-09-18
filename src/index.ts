import * as core from '@actions/core';
import * as github from '@actions/github';
import { ActionConfig, ActionResult, GeneratedTest } from './types';
import { parseConfig } from './config';
import { createLLMClient } from './providers';
import { DiffAnalyzer } from './diff/analyzer';
import { TestGenerator } from './generator/test-generator';
import { GitOps } from './utils/git-ops';

export async function run(): Promise<void> {
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
    generator.preflightWrites(tests);
    core.startGroup('💾 Writing test files');
    const writtenFiles = await generator.writeTests(tests);
    core.endGroup();

    // Write POM files (when pomOutputDirectory is configured)
    let pomFiles: string[] = [];
    if (config.pomOutputDirectory && generator.getGeneratedPomFiles().length > 0) {
      core.startGroup('📄 Writing page object files');
      pomFiles = await generator.writePomFiles();
      core.info(`Wrote ${pomFiles.length} page object file(s)`);
      core.endGroup();
    }

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
      prNumber = await gitOps.createPR(tests, baseBranch, diff.headSha, config, fixtureFiles, pomFiles);
      core.endGroup();
    } else if (config.autoCommit) {
      core.startGroup('📝 Committing tests');
      const gitOps = new GitOps();
      await gitOps.commitTests(tests, diff.headSha, [...fixtureFiles, ...pomFiles]);
      core.endGroup();
    }

    // ─── Set Outputs ───
    const result: ActionResult = {
      testsGenerated: tests.length,
      testFiles: writtenFiles,
      fixtureFiles: fixtureFiles.length > 0 ? fixtureFiles : undefined,
      pomFiles: pomFiles.length > 0 ? pomFiles : undefined,
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

function getBaseBranch(): string {
  const context = github.context;
  if (context.payload.pull_request) {
    return context.payload.pull_request.base.ref;
  }
  // For push events, target the PR's source branch (the branch being pushed to).
  // The AutoSpec PR should merge INTO this branch, not into main.
  const branch = context.ref.replace('refs/heads/', '');
  core.info(`Base branch for AutoSpec PR: ${branch} (from ${context.eventName} event)`);
  return branch;
}

// ─── Outputs ───

function setOutputs(result: ActionResult): void {
  core.setOutput('tests_generated', result.testsGenerated.toString());
  core.setOutput('test_files', JSON.stringify(result.testFiles));
  core.setOutput('summary', result.summary);
  core.setOutput('pr_number', result.prNumber?.toString() ?? '');
  core.setOutput('fixture_files', JSON.stringify(result.fixtureFiles ?? []));
  core.setOutput('pom_files', JSON.stringify(result.pomFiles ?? []));
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
