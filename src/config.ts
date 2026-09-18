import * as core from '@actions/core';
import * as path from 'path';
import {
  ActionConfig,
  AxeStandard,
  DiffMode,
  LLMProvider,
  TraceMode,
} from './types';

const VALID_PROVIDERS: LLMProvider[] = ['anthropic', 'openai', 'custom'];
const VALID_DIFF_MODES: DiffMode[] = ['auto', 'pr', 'push'];
const VALID_TRACE_MODES: TraceMode[] = ['on', 'off', 'retain-on-failure', 'on-first-retry'];
const VALID_AXE_STANDARDS: AxeStandard[] = [
  'wcag2a',
  'wcag2aa',
  'wcag21a',
  'wcag21aa',
  'best-practice',
];
const VALID_FRAMEWORKS = ['react', 'vue', 'svelte', 'angular', 'nextjs', 'generic'] as const;

export function parseCSV(input: string): string[] {
  return input
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
}

function parseIntegerInRange(name: string, fallback: string, minimum: number, maximum: number): number {
  const raw = core.getInput(name) || fallback;
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error(`Invalid ${name} value: "${raw}". Must be an integer between ${minimum} and ${maximum}.`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Invalid ${name} value: "${raw}". Must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function parseRatio(name: string, fallback: string): number {
  const raw = core.getInput(name) || fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`Invalid ${name} value: "${raw}". Must be a number between 0 and 1.`);
  }
  return value;
}

function parseEnum<T extends string>(name: string, fallback: T, values: readonly T[]): T {
  const raw = core.getInput(name) || fallback;
  if (!values.includes(raw as T)) {
    throw new Error(`Invalid ${name} "${raw}". Must be one of: ${values.join(', ')}`);
  }
  return raw as T;
}

function parseRepositoryDirectory(name: string, fallback = ''): string {
  const raw = core.getInput(name) || fallback;
  if (!raw) return '';
  if (path.isAbsolute(raw)) {
    throw new Error(`Invalid ${name} "${raw}". Directory must be relative to the repository root.`);
  }
  const repositoryRoot = path.resolve(process.cwd());
  const resolved = path.resolve(repositoryRoot, raw);
  if (resolved !== repositoryRoot && !resolved.startsWith(repositoryRoot + path.sep)) {
    throw new Error(`Invalid ${name} "${raw}". Directory resolves outside the repository root.`);
  }
  return path.normalize(raw);
}

function parseHttpUrl(name: string, fallback = ''): string | undefined {
  const raw = core.getInput(name) || fallback;
  if (!raw) return undefined;
  try {
    const value = new URL(raw);
    if (value.protocol !== 'http:' && value.protocol !== 'https:') throw new Error('unsupported protocol');
  } catch {
    throw new Error(`Invalid ${name} "${raw}". Must be an http or https URL.`);
  }
  return raw;
}

export function parseConfig(): ActionConfig {
  const provider = parseEnum('llm_provider', 'anthropic', VALID_PROVIDERS);
  const diffMode = parseEnum('diff_mode', 'auto', VALID_DIFF_MODES);
  const traceMode = parseEnum('trace_mode', 'retain-on-failure', VALID_TRACE_MODES);
  const axeStandard = parseEnum('axe_standard', 'wcag2aa', VALID_AXE_STANDARDS);
  const framework = parseEnum('framework', 'generic', VALID_FRAMEWORKS);

  return {
    llm: {
      provider,
      apiKey: core.getInput('llm_api_key', { required: true }),
      model: core.getInput('llm_model') || '',
      baseUrl: parseHttpUrl('llm_base_url'),
    },
    testDirectory: parseRepositoryDirectory('test_directory', 'e2e/generated'),
    testPatterns: parseCSV(core.getInput('test_pattern') || 'e2e/**/*.spec.ts,*-e2e/**/*.spec.ts'),
    baseUrl: parseHttpUrl('base_url', 'http://localhost:3000') as string,
    framework,
    diffMode,
    includePaths: parseCSV(core.getInput('include_paths')),
    excludePaths: parseCSV(core.getInput('exclude_paths') || 'test/,tests/,e2e/,__tests__/,.github/,docs/,README'),
    autoCommit: core.getBooleanInput('auto_commit'),
    autoPr: core.getBooleanInput('auto_pr'),
    maxTestFiles: parseIntegerInRange('max_test_files', '5', 1, 50),
    dryRun: core.getBooleanInput('dry_run'),
    overwriteExistingFiles: core.getBooleanInput('overwrite_existing_files'),
    customInstructions: core.getInput('custom_instructions') || '',

    pomPatterns: parseCSV(core.getInput('pom_patterns')),
    utilityPatterns: parseCSV(core.getInput('utility_patterns')),
    pomOutputDirectory: parseRepositoryDirectory('pom_output_directory'),
    projectContextBudget: parseIntegerInRange('project_context_budget', '8000', 100, 200_000),
    diffContextBudget: parseIntegerInRange('diff_context_budget', '24000', 100, 200_000),

    traceOnFailure: core.getBooleanInput('trace_on_failure'),
    traceMode,

    generateApiMocks: core.getBooleanInput('generate_api_mocks'),
    mockErrorStates: core.getBooleanInput('mock_error_states'),
    fixtureExtractionThreshold: parseIntegerInRange('fixture_extraction_threshold', '3', 1, 100),

    visualRegression: core.getBooleanInput('visual_regression'),
    visualThreshold: parseRatio('visual_threshold', '0.2'),
    visualMaxDiffRatio: parseRatio('visual_max_diff_ratio', '0.05'),
    visualFullPage: core.getBooleanInput('visual_full_page'),

    accessibilityAssertions: core.getBooleanInput('accessibility_assertions'),
    axeScan: core.getBooleanInput('axe_scan'),
    axeStandard,
  };
}
