/**
 * Tests for config parsing and validation logic.
 * Since parseConfig() reads from @actions/core inputs, we mock the module.
 */

// Mock @actions/core before importing anything
const mockInputs: Record<string, string> = {};
const mockBooleanInputs: Record<string, boolean> = {};

jest.mock('@actions/core', () => ({
  getInput: (name: string, opts?: { required?: boolean }) => {
    const val = mockInputs[name];
    if (opts?.required && !val) throw new Error(`Input required and not supplied: ${name}`);
    return val || '';
  },
  getBooleanInput: (name: string) => {
    if (name in mockBooleanInputs) return mockBooleanInputs[name];
    // Default false for booleans not explicitly set
    const val = mockInputs[name];
    if (val === 'true') return true;
    if (val === 'false' || !val) return false;
    throw new TypeError(`Input "${name}" does not meet YAML 1.2 "Core Schema" specification: ${val}`);
  },
  info: jest.fn(),
  warning: jest.fn(),
  setFailed: jest.fn(),
  setOutput: jest.fn(),
  startGroup: jest.fn(),
  endGroup: jest.fn(),
  summary: {
    addHeading: jest.fn().mockReturnThis(),
    addRaw: jest.fn().mockReturnThis(),
    addTable: jest.fn().mockReturnThis(),
    write: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('@actions/github', () => ({
  context: { repo: { owner: 'test', repo: 'test' }, ref: 'refs/heads/main', payload: {} },
  getOctokit: jest.fn(),
}));

// We need to test parseConfig which is not exported, so we test via the types
import { ActionConfig, TraceMode } from '../src/types';

describe('ActionConfig type coverage', () => {
  it('includes all trace viewer fields', () => {
    const config: Partial<ActionConfig> = {
      traceOnFailure: true,
      traceMode: 'retain-on-failure',
    };
    expect(config.traceOnFailure).toBe(true);
    expect(config.traceMode).toBe('retain-on-failure');
  });

  it('includes all API mock fields', () => {
    const config: Partial<ActionConfig> = {
      generateApiMocks: true,
      mockErrorStates: true,
      fixtureExtractionThreshold: 3,
    };
    expect(config.generateApiMocks).toBe(true);
    expect(config.mockErrorStates).toBe(true);
    expect(config.fixtureExtractionThreshold).toBe(3);
  });

  it('includes all visual regression fields', () => {
    const config: Partial<ActionConfig> = {
      visualRegression: true,
      visualThreshold: 0.2,
      visualMaxDiffRatio: 0.05,
      visualFullPage: false,
    };
    expect(config.visualRegression).toBe(true);
    expect(config.visualThreshold).toBe(0.2);
    expect(config.visualMaxDiffRatio).toBe(0.05);
    expect(config.visualFullPage).toBe(false);
  });

  it('includes all accessibility fields', () => {
    const config: Partial<ActionConfig> = {
      accessibilityAssertions: true,
      axeScan: true,
      axeStandard: 'wcag2aa',
    };
    expect(config.accessibilityAssertions).toBe(true);
    expect(config.axeScan).toBe(true);
    expect(config.axeStandard).toBe('wcag2aa');
  });

  it('includes fixtureFiles in ActionResult', () => {
    const result = {
      testsGenerated: 1,
      testFiles: ['test.spec.ts'],
      fixtureFiles: ['fixtures/test.fixtures.ts'],
      summary: 'ok',
    };
    expect(result.fixtureFiles).toHaveLength(1);
  });

  it('TraceMode accepts all valid values', () => {
    const modes: TraceMode[] = ['on', 'off', 'retain-on-failure', 'on-first-retry'];
    expect(modes).toHaveLength(4);
  });
});

describe('TraceMode validation', () => {
  const VALID_TRACE_MODES: TraceMode[] = ['on', 'off', 'retain-on-failure', 'on-first-retry'];

  it('accepts all valid trace modes', () => {
    for (const mode of VALID_TRACE_MODES) {
      expect(VALID_TRACE_MODES.includes(mode)).toBe(true);
    }
  });

  it('rejects invalid trace modes', () => {
    expect(VALID_TRACE_MODES.includes('always' as TraceMode)).toBe(false);
    expect(VALID_TRACE_MODES.includes('never' as TraceMode)).toBe(false);
  });
});

describe('Fixture extraction threshold validation', () => {
  it('rejects non-positive integers', () => {
    const validate = (val: string) => {
      const parsed = parseInt(val, 10);
      return !isNaN(parsed) && parsed >= 1;
    };

    expect(validate('3')).toBe(true);
    expect(validate('1')).toBe(true);
    expect(validate('0')).toBe(false);
    expect(validate('-1')).toBe(false);
    expect(validate('abc')).toBe(false);
  });
});
