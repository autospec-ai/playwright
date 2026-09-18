import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TestGenerator } from '../src/generator/test-generator';
import { DiffResult, LLMClient, LLMResponse } from '../src/types';
import { makeConfig } from './helpers';

jest.mock('@actions/core', () => ({
  info: jest.fn(),
  warning: jest.fn(),
  debug: jest.fn(),
}));

const diff: DiffResult = {
  files: [{
    filename: 'src/login.ts',
    status: 'modified',
    patch: '+export const login = true;',
    additions: 1,
    deletions: 0,
    fullContent: 'export const login = true;',
  }],
  baseSha: 'a'.repeat(40),
  headSha: 'b'.repeat(40),
  summary: 'test diff',
};

function mockLLM(contents: string[]): LLMClient {
  const responses = [...contents];
  return {
    generate: jest.fn(async (): Promise<LLMResponse> => ({
      content: responses.shift() ?? '',
      model: 'test-model',
    })),
  };
}

function validPlan(filename = 'login.spec.ts'): string {
  return JSON.stringify({
    reasoning: 'Login changed',
    tests: [{
      targetFile: 'src/login.ts',
      testFilename: filename,
      description: 'Login works',
      userFlows: ['Open login'],
      priority: 'high',
      severity: 'sev1',
    }],
  });
}

describe('TestGenerator', () => {
  it('validates a plan and generated TypeScript', async () => {
    const generator = new TestGenerator(
      makeConfig(),
      mockLLM([
        validPlan(),
        "import { test, expect } from '@playwright/test';\ntest('login', async ({ page }) => { await expect(page).toHaveTitle(/Login/); });",
      ])
    );

    const tests = await generator.generate(diff);
    expect(tests).toHaveLength(1);
    expect(tests[0].filepath).toBe('e2e/generated/login.spec.ts');
  });

  it('rejects plans that target files outside the analyzed diff', async () => {
    const plan = JSON.parse(validPlan());
    plan.tests[0].targetFile = 'src/unrelated.ts';
    const generator = new TestGenerator(makeConfig(), mockLLM([JSON.stringify(plan)]));

    await expect(generator.generate(diff)).rejects.toThrow('not in the analyzed diff');
  });

  it('rejects path traversal in generated POM filenames', async () => {
    const code = "import { test } from '@playwright/test';\ntest('login', async () => {});\n// POM_FILE: ../../owned.ts\nexport class Owned {}";
    const generator = new TestGenerator(
      makeConfig({ pomOutputDirectory: 'e2e/pages' }),
      mockLLM([validPlan(), code])
    );

    expect(await generator.generate(diff)).toEqual([]);
    expect(generator.getGeneratedPomFiles()).toEqual([]);
  });

  it('refuses to overwrite files unless explicitly enabled', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autospec-generator-'));
    const filepath = path.join(tmpDir, 'existing.spec.ts');
    fs.writeFileSync(filepath, 'existing');
    const test = {
      filename: 'existing.spec.ts', filepath, content: '', sourceFiles: [], description: '', severity: 'sev1',
    };

    const generator = new TestGenerator(makeConfig({ testDirectory: tmpDir }), mockLLM([]));
    expect(() => generator.preflightWrites([test])).toThrow('Refusing to overwrite');

    const overwriteGenerator = new TestGenerator(
      makeConfig({ testDirectory: tmpDir, overwriteExistingFiles: true }),
      mockLLM([])
    );
    expect(() => overwriteGenerator.preflightWrites([test])).not.toThrow();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
