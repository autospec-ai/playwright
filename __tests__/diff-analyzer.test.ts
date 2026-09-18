const mockContext: {
  eventName: string;
  payload: Record<string, unknown>;
  repo: { owner: string; repo: string };
} = {
  eventName: 'push',
  payload: {},
  repo: { owner: 'autospec-ai', repo: 'playwright' },
};
const mockPaginate = jest.fn();
const mockExec = jest.fn();

jest.mock('@actions/core', () => ({ info: jest.fn(), warning: jest.fn(), debug: jest.fn() }));
jest.mock('@actions/github', () => ({
  context: mockContext,
  getOctokit: jest.fn(() => ({
    paginate: mockPaginate,
    rest: { pulls: { listFiles: jest.fn() } },
  })),
}));
jest.mock('@actions/exec', () => ({ exec: mockExec }));

import { DiffAnalyzer } from '../src/diff/analyzer';
import { makeConfig } from './helpers';

function emit(output: string, options?: { listeners?: { stdout?: (data: Buffer) => void } }): void {
  options?.listeners?.stdout?.(Buffer.from(output));
}

describe('DiffAnalyzer', () => {
  beforeEach(() => {
    process.env.GITHUB_TOKEN = 'test-token';
    mockPaginate.mockReset();
    mockExec.mockReset();
    mockContext.eventName = 'push';
    mockContext.payload = {};
  });

  afterAll(() => {
    delete process.env.GITHUB_TOKEN;
  });

  it('paginates pull-request files', async () => {
    mockContext.eventName = 'pull_request';
    mockContext.payload = {
      pull_request: {
        number: 12,
        title: 'Add login',
        base: { sha: 'a'.repeat(40) },
        head: { sha: 'b'.repeat(40) },
      },
    };
    mockPaginate.mockResolvedValue([{
      filename: 'src/login.ts', status: 'modified', patch: '+login', additions: 1, deletions: 0,
    }]);
    mockExec.mockImplementation(async (_command: string, args: string[], options: unknown) => {
      if (args[0] === 'show') emit('export const login = true;', options as never);
      return 0;
    });

    const result = await new DiffAnalyzer(makeConfig({ diffMode: 'pr' })).analyze();

    expect(mockPaginate).toHaveBeenCalledTimes(1);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].fullContent).toContain('login');
  });

  it('uses a root diff for a new branch push with an all-zero before SHA', async () => {
    mockContext.payload = { before: '0'.repeat(40), after: 'c'.repeat(40) };
    mockExec.mockImplementation(async (_command: string, args: string[], options: unknown) => {
      if (args[0] === 'diff-tree') emit('A\tsrc/app.ts\n', options as never);
      if (args[0] === 'show' && args[1] === '--format=') emit('+export const app = true;\n', options as never);
      if (args[0] === 'show' && args[1]?.includes(':')) emit('export const app = true;', options as never);
      if (args[0] === 'log') emit('Initial commit\n', options as never);
      return 0;
    });

    const result = await new DiffAnalyzer(makeConfig({ diffMode: 'push' })).analyze();

    expect(mockExec).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['diff-tree', '--root']),
      expect.any(Object)
    );
    expect(result.files[0]).toEqual(expect.objectContaining({ filename: 'src/app.ts', status: 'added' }));
  });

  it('returns no files for a branch deletion push', async () => {
    mockContext.payload = { before: 'd'.repeat(40), after: '0'.repeat(40) };
    const result = await new DiffAnalyzer(makeConfig({ diffMode: 'push' })).analyze();
    expect(result.files).toEqual([]);
    expect(result.summary).toContain('deleted a branch');
  });
});
