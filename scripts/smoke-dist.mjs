import { spawnSync } from 'node:child_process';
import process from 'node:process';

function run(entrypoint, extraEnv) {
  const result = spawnSync(process.execPath, [entrypoint], {
    cwd: process.cwd(),
    env: {
      ...process.env,
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

run('dist/index.mjs', {});
run('dist/post/index.mjs', {
  INPUT_TRACE_ON_FAILURE: 'true',
  INPUT_TEST_RESULTS_DIRECTORY: '__autospec_dist_smoke_no_results__',
});
