const mockInputs: Record<string, string> = {};

jest.mock('@actions/core', () => ({
  getInput: (name: string, opts?: { required?: boolean }) => {
    const value = mockInputs[name] || '';
    if (opts?.required && !value) throw new Error(`Input required and not supplied: ${name}`);
    return value;
  },
  getBooleanInput: (name: string) => {
    const value = mockInputs[name] || '';
    if (value === 'true') return true;
    if (value === 'false' || !value) return false;
    throw new TypeError(`Invalid boolean input: ${name}`);
  },
}));

import { parseConfig, parseCSV } from '../src/config';

describe('parseConfig', () => {
  beforeEach(() => {
    for (const key of Object.keys(mockInputs)) delete mockInputs[key];
    Object.assign(mockInputs, {
      llm_api_key: 'test-key',
      auto_pr: 'true',
      trace_on_failure: 'true',
    });
  });

  it('parses documented defaults', () => {
    const config = parseConfig();

    expect(config.llm.provider).toBe('anthropic');
    expect(config.testDirectory).toBe('e2e/generated');
    expect(config.maxTestFiles).toBe(5);
    expect(config.projectContextBudget).toBe(8000);
    expect(config.diffContextBudget).toBe(24000);
    expect(config.visualThreshold).toBe(0.2);
    expect(config.axeStandard).toBe('wcag2aa');
    expect(config.autoPr).toBe(true);
    expect(config.traceOnFailure).toBe(true);
    expect(config.overwriteExistingFiles).toBe(false);
  });

  it.each([
    ['llm_provider', 'invalid'],
    ['diff_mode', 'merge-base'],
    ['trace_mode', 'always'],
    ['axe_standard', 'wcag3'],
    ['framework', 'ember'],
  ])('rejects invalid %s values', (name, value) => {
    mockInputs[name] = value;
    expect(() => parseConfig()).toThrow(`Invalid ${name}`);
  });

  it.each([
    ['max_test_files', '0'],
    ['max_test_files', '5junk'],
    ['max_test_files', '51'],
    ['fixture_extraction_threshold', '1.5'],
    ['project_context_budget', '-1'],
    ['project_context_budget', '99'],
    ['diff_context_budget', 'abc'],
  ])('strictly validates positive integer %s', (name, value) => {
    mockInputs[name] = value;
    expect(() => parseConfig()).toThrow(`Invalid ${name} value`);
  });

  it.each([
    ['visual_threshold', '-0.1'],
    ['visual_threshold', '1.1'],
    ['visual_max_diff_ratio', 'NaN'],
  ])('validates ratio input %s', (name, value) => {
    mockInputs[name] = value;
    expect(() => parseConfig()).toThrow(`Invalid ${name} value`);
  });

  it('rejects output directories outside the repository', () => {
    mockInputs.test_directory = '../outside';
    expect(() => parseConfig()).toThrow('resolves outside the repository root');

    mockInputs.test_directory = '/tmp/generated';
    expect(() => parseConfig()).toThrow('relative to the repository root');
  });

  it.each([
    ['base_url', 'not a url'],
    ['base_url', 'file:///tmp/app'],
    ['llm_base_url', 'localhost:11434'],
  ])('validates URL input %s', (name, value) => {
    mockInputs[name] = value;
    expect(() => parseConfig()).toThrow(`Invalid ${name}`);
  });

  it('requires an API key and custom endpoint for custom providers is checked by the factory', () => {
    delete mockInputs.llm_api_key;
    expect(() => parseConfig()).toThrow('Input required and not supplied');
  });
});

describe('parseCSV', () => {
  it('trims values and removes empty entries', () => {
    expect(parseCSV(' src/, ,components/** ')).toEqual(['src/', 'components/**']);
  });
});
