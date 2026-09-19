import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';

const repositoryRoot = process.cwd();
const smokeWorkspace = mkdtempSync(join(tmpdir(), 'autospec-dist-smoke-'));

function git(...args) {
  return execFileSync('git', args, {
    cwd: smokeWorkspace,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function createSmokeRepository() {
  git('init');
  git('config', 'user.name', 'AutoSpec Dist Smoke');
  git('config', 'user.email', 'dist-smoke@autospec.ai');

  const sourceFile = join(smokeWorkspace, 'smoke-source.ts');
  writeFileSync(sourceFile, 'export const smokeVersion = 1;\n');
  git('add', 'smoke-source.ts');
  git('commit', '-m', 'initial smoke fixture');
  const before = git('rev-parse', 'HEAD');

  writeFileSync(sourceFile, 'export const smokeVersion = 2;\n');
  git('add', 'smoke-source.ts');
  git('commit', '-m', 'update smoke fixture');
  const after = git('rev-parse', 'HEAD');

  const eventPath = join(smokeWorkspace, 'push-event.json');
  writeFileSync(eventPath, JSON.stringify({ before, after }));
  return { after, eventPath };
}

function run(entrypoint, smokeContext, extraEnv) {
  const result = spawnSync(process.execPath, [resolve(repositoryRoot, entrypoint)], {
    cwd: smokeWorkspace,
    env: {
      ...process.env,
      GITHUB_EVENT_NAME: 'push',
      GITHUB_EVENT_PATH: smokeContext.eventPath,
      GITHUB_REPOSITORY: 'autospec-ai/dist-smoke',
      GITHUB_SHA: smokeContext.after,
      GITHUB_WORKSPACE: smokeWorkspace,
      INPUT_LLM_API_KEY: 'dist-smoke-test',
      INPUT_INCLUDE_PATHS: '__autospec_dist_smoke_no_matches__/',
      INPUT_AUTO_COMMIT: 'false',
      INPUT_AUTO_PR: 'false',
      INPUT_DRY_RUN: 'false',
      INPUT_OVERWRITE_EXISTING_FILES: 'false',
      INPUT_TRACE_ON_FAILURE: 'false',
      INPUT_GENERATE_API_MOCKS: 'false',
      INPUT_MOCK_ERROR_STATES: 'false',
      INPUT_VISUAL_REGRESSION: 'false',
      INPUT_VISUAL_FULL_PAGE: 'false',
      INPUT_ACCESSIBILITY_ASSERTIONS: 'false',
      INPUT_AXE_SCAN: 'false',
      ...extraEnv,
    },
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    process.stderr.write(result.stdout);
    process.stderr.write(result.stderr);
    throw new Error(`${entrypoint} exited with status ${result.status}`);
  }
}

try {
  const smokeContext = createSmokeRepository();
  run('dist/index.mjs', smokeContext, {});
  run('dist/post/index.mjs', smokeContext, {
    INPUT_TRACE_ON_FAILURE: 'true',
    INPUT_TEST_RESULTS_DIRECTORY: '__autospec_dist_smoke_no_results__',
  });
} finally {
  rmSync(smokeWorkspace, { recursive: true, force: true });
}
