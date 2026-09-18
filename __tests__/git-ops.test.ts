const gitCalls: string[][] = [];
const createPull = jest.fn().mockResolvedValue({ data: { number: 42, html_url: 'https://example.test/pr/42' } });

jest.mock('@actions/core', () => ({ info: jest.fn() }));
jest.mock('@actions/exec', () => ({
  exec: jest.fn(async (_command: string, args: string[]) => {
    gitCalls.push(args);
    return 0;
  }),
}));
jest.mock('@actions/github', () => ({
  context: { repo: { owner: 'autospec-ai', repo: 'playwright' } },
  getOctokit: jest.fn(() => ({
    rest: {
      pulls: {
        list: jest.fn().mockResolvedValue({ data: [] }),
        create: createPull,
      },
      issues: { addLabels: jest.fn().mockResolvedValue({}) },
    },
  })),
}));

import { GitOps } from '../src/utils/git-ops';
import { GeneratedTest } from '../src/types';

const generatedTest: GeneratedTest = {
  filename: 'login.spec.ts',
  filepath: 'e2e/generated/login.spec.ts',
  content: '',
  sourceFiles: ['src/login.ts'],
  description: 'Login works',
  severity: 'sev1',
};

describe('GitOps', () => {
  beforeEach(() => {
    process.env.GITHUB_TOKEN = 'test-token';
    gitCalls.length = 0;
    createPull.mockClear();
  });

  afterAll(() => {
    delete process.env.GITHUB_TOKEN;
  });

  it('stages every generated support file when committing', async () => {
    await new GitOps().commitTests(
      [generatedTest],
      'a'.repeat(40),
      ['e2e/generated/fixtures/login.fixtures.ts', 'e2e/pages/login.page.ts']
    );

    expect(gitCalls).toContainEqual(['add', '--', 'e2e/generated/login.spec.ts']);
    expect(gitCalls).toContainEqual(['add', '--', 'e2e/generated/fixtures/login.fixtures.ts']);
    expect(gitCalls).toContainEqual(['add', '--', 'e2e/pages/login.page.ts']);
  });

  it('stages POMs and describes them in generated PRs', async () => {
    await new GitOps().createPR(
      [generatedTest],
      'main',
      'b'.repeat(40),
      undefined,
      [],
      ['e2e/pages/login.page.ts']
    );

    expect(gitCalls).toContainEqual(['add', '--', 'e2e/pages/login.page.ts']);
    expect(createPull).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.stringContaining('e2e/pages/login.page.ts'),
    }));
  });
});
