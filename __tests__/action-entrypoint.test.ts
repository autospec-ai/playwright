const mockSetOutput = jest.fn();
const mockSetFailed = jest.fn();
const mockAnalyze = jest.fn();
const mockParseConfig = jest.fn();
const mockGenerate = jest.fn();
const mockPreflightWrites = jest.fn();
const mockWriteTests = jest.fn();
const mockWriteFixtures = jest.fn();
const mockWritePomFiles = jest.fn();
const mockGetGeneratedPomFiles = jest.fn();
const mockCreatePR = jest.fn();

jest.mock('@actions/core', () => ({
  info: jest.fn(),
  warning: jest.fn(),
  debug: jest.fn(),
  startGroup: jest.fn(),
  endGroup: jest.fn(),
  setOutput: mockSetOutput,
  setFailed: mockSetFailed,
  summary: {
    addHeading: jest.fn().mockReturnThis(),
    addRaw: jest.fn().mockReturnThis(),
    addTable: jest.fn().mockReturnThis(),
    write: jest.fn().mockResolvedValue(undefined),
  },
}));
jest.mock('@actions/github', () => ({
  context: { payload: {}, ref: 'refs/heads/main', eventName: 'push' },
}));
jest.mock('../src/config', () => ({ parseConfig: mockParseConfig }));
jest.mock('../src/providers', () => ({ createLLMClient: jest.fn(() => ({ generate: jest.fn() })) }));
jest.mock('../src/diff/analyzer', () => ({
  DiffAnalyzer: jest.fn().mockImplementation(() => ({ analyze: mockAnalyze })),
}));
jest.mock('../src/generator/test-generator', () => ({
  TestGenerator: jest.fn().mockImplementation(() => ({
    generate: mockGenerate,
    preflightWrites: mockPreflightWrites,
    writeTests: mockWriteTests,
    writeFixtures: mockWriteFixtures,
    writePomFiles: mockWritePomFiles,
    getGeneratedPomFiles: mockGetGeneratedPomFiles,
  })),
}));
jest.mock('../src/utils/git-ops', () => ({
  GitOps: jest.fn().mockImplementation(() => ({ createPR: mockCreatePR, commitTests: jest.fn() })),
}));

import { run } from '../src/index';
import { makeConfig } from './helpers';

describe('action entrypoint', () => {
  beforeEach(() => {
    mockSetOutput.mockClear();
    mockSetFailed.mockClear();
    mockAnalyze.mockReset();
    mockGenerate.mockReset();
    mockPreflightWrites.mockReset();
    mockWriteTests.mockReset();
    mockWriteFixtures.mockReset();
    mockWritePomFiles.mockReset();
    mockGetGeneratedPomFiles.mockReset();
    mockCreatePR.mockReset();
    mockParseConfig.mockReturnValue(makeConfig());
  });

  it('sets stable empty outputs when there are no testable changes', async () => {
    mockAnalyze.mockResolvedValue({
      files: [], baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), summary: 'none',
    });

    await run();

    expect(mockSetOutput).toHaveBeenCalledWith('tests_generated', '0');
    expect(mockSetOutput).toHaveBeenCalledWith('test_files', '[]');
    expect(mockSetFailed).not.toHaveBeenCalled();
  });

  it('reports unexpected failures through the Action API', async () => {
    mockAnalyze.mockRejectedValue(new Error('diff failed'));
    await run();
    expect(mockSetFailed).toHaveBeenCalledWith('AutoSpec AI failed: diff failed');
  });

  it('writes, stages, and reports every generated artifact type', async () => {
    const config = makeConfig({
      dryRun: false,
      autoPr: true,
      generateApiMocks: true,
      pomOutputDirectory: 'e2e/pages',
    });
    const test = {
      filename: 'login.spec.ts',
      filepath: 'e2e/generated/login.spec.ts',
      content: "import { test } from '@playwright/test'; test('x', async () => {});",
      sourceFiles: ['src/login.ts'],
      description: 'Login works',
      severity: 'sev1',
    };
    mockParseConfig.mockReturnValue(config);
    mockAnalyze.mockResolvedValue({
      files: [{ filename: 'src/login.ts', status: 'modified', patch: '+x', additions: 1, deletions: 0 }],
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
      summary: 'login changed',
    });
    mockGenerate.mockResolvedValue([test]);
    mockWriteTests.mockResolvedValue([test.filepath]);
    mockGetGeneratedPomFiles.mockReturnValue([{ filepath: 'e2e/pages/login.page.ts' }]);
    mockWritePomFiles.mockResolvedValue(['e2e/pages/login.page.ts']);
    mockWriteFixtures.mockResolvedValue(['e2e/generated/fixtures/login.fixtures.ts']);
    mockCreatePR.mockResolvedValue(17);

    await run();

    expect(mockPreflightWrites).toHaveBeenCalledWith([test]);
    expect(mockCreatePR).toHaveBeenCalledWith(
      [test],
      'main',
      'b'.repeat(40),
      config,
      ['e2e/generated/fixtures/login.fixtures.ts'],
      ['e2e/pages/login.page.ts']
    );
    expect(mockSetOutput).toHaveBeenCalledWith('pom_files', '["e2e/pages/login.page.ts"]');
    expect(mockSetOutput).toHaveBeenCalledWith('fixture_files', '["e2e/generated/fixtures/login.fixtures.ts"]');
  });
});
