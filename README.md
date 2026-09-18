# 🤖 AutoSpec AI

> Replace your QE E2E automation backlog with AI-generated Playwright tests — triggered on every commit.

AutoSpec AI is a GitHub Action that analyzes your code changes (via diff), understands what user-facing behavior changed, and generates production-quality Playwright E2E tests that match your existing test style.

## How It Works

```
Commit / PR  →  Diff Analysis  →  LLM Test Planning  →  Playwright Code Gen  →  PR with Tests
```

1. **Diff Extraction** — Detects changed files from push events or pull requests (configurable).
2. **Smart Filtering** — Ignores lockfiles, images, docs, and existing tests. Focuses on source code.
3. **Test Planning (Phase 1)** — LLM analyzes the diff and produces a prioritized test plan in JSON.
4. **Code Generation (Phase 2)** — For each planned test, the LLM generates a Playwright spec file matching your existing test patterns.
5. **Delivery** — Opens a PR with the generated tests (or commits directly).

## Quick Start

```yaml
# .github/workflows/autospec.yml
name: AutoSpec AI

on:
  pull_request:
    types: [opened, synchronize]

permissions:
  contents: write
  pull-requests: write

jobs:
  generate-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5
        with:
          fetch-depth: 0  # Required for diff analysis

      - uses: autospec-ai/playwright@v2
        with:
          llm_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          base_url: 'http://localhost:3000'
          framework: 'react'
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

## Supported LLM Providers

### Anthropic (Default)
```yaml
- uses: autospec-ai/playwright@v2
  with:
    llm_provider: anthropic
    llm_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
    llm_model: claude-sonnet-4-20250514  # optional, this is the default
```

### OpenAI
```yaml
- uses: autospec-ai/playwright@v2
  with:
    llm_provider: openai
    llm_api_key: ${{ secrets.OPENAI_API_KEY }}
    llm_model: gpt-4o  # optional, this is the default
```

### Custom / OpenAI-Compatible (Ollama, Together, Groq, etc.)
```yaml
- uses: autospec-ai/playwright@v2
  with:
    llm_provider: custom
    llm_api_key: ${{ secrets.TOGETHER_API_KEY }}
    llm_model: meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo
    llm_base_url: https://api.together.xyz/v1
```

## Features

### Core Test Generation
AutoSpec analyzes diffs, plans tests, and generates Playwright specs — all automatically. Tests are severity-tagged (`@sev1` through `@sev4`) and match your existing test style.

### Trace Viewer Integration
Configures generated tests to capture Playwright traces, screenshots, and video on failures. A bundled post-action runs at the end of the job, after later Playwright steps, and uploads any diagnostics it finds.

```yaml
trace_on_failure: 'true'
trace_mode: 'retain-on-failure'  # on | off | retain-on-failure | on-first-retry
test_results_directory: 'test-results'
```

After a test run, view traces locally:
```bash
npx playwright show-trace test-results/<test-name>/trace.zip
```

### API Mock Generation
Detects `fetch`, `axios`, `useSWR`, `useQuery`, and WebSocket patterns in your source code. Generates `page.route()` mocks in each test. When the number of route mocks in a single test exceeds the threshold, they are extracted into shared fixture files.

```yaml
generate_api_mocks: 'true'
mock_error_states: 'true'            # Also generate 4xx/5xx error test cases
fixture_extraction_threshold: '3'    # Extract to fixtures when route count exceeds this
```

### Visual Regression Baselines
Adds `toHaveScreenshot()` assertions at visual checkpoints. On first run, Playwright generates baseline screenshots. Subsequent runs compare against them.

```yaml
visual_regression: 'true'
visual_threshold: '0.2'          # Pixel comparison threshold (0-1)
visual_max_diff_ratio: '0.05'    # Max diff pixel ratio before failure
visual_full_page: 'false'        # Viewport-only or full-page capture
```

Update baselines after intentional UI changes:
```bash
npx playwright test --update-snapshots
```

### Project Structure Discovery
AutoSpec scans your project for existing page objects, utility functions, and test coverage before generating tests. It injects the **actual source code** of discovered POM classes and utilities into the LLM prompt, so the model can see exactly what methods, elements, and locators exist — no regex extraction, no guessing.

**What it discovers:**
- **Page Objects** — Full source of classes matching POM patterns (methods, elements, locators, routes — everything)
- **Utilities** — Full source of exported helper functions and constants
- **Test Coverage** — Individual test names, flows, and routes already under test (so the LLM doesn't duplicate them)

**Auto-detection** works out of the box for common conventions (`**/pages/**/*.ts`, `**/*.page.ts`, `**/*.po.ts`, `**/helpers/**/*.ts`, etc.). If your project uses different naming, configure the patterns explicitly:

```yaml
- uses: autospec-ai/playwright@v2
  with:
    llm_api_key: ${{ secrets.OPENAI_API_KEY }}
    test_directory: 'e2e/tests'                        # where to write generated tests
    pom_patterns: '**/*.po.ts,**/pageobjects/**/*.ts'  # match your POM convention
    utility_patterns: '**/helpers/**/*.ts'              # match your utility convention
    pom_output_directory: 'e2e/pages'                   # where to write NEW POM files
    project_context_budget: '12000'                     # increase if you have many POMs
```

**`pom_output_directory`** — When set, the LLM can create new page object classes as separate files instead of inlining them in test specs. If not set, the LLM is instructed to only use existing POMs or raw `page.locator()` calls.

**Tip:** Check the Action logs for `Discovered: X page objects, Y utility files, Z tested files` to verify the scanner is finding your project's artifacts. If the counts are 0, your file naming doesn't match the default patterns — set `pom_patterns` and `utility_patterns` explicitly.

### Aria Snapshot Assertions
Adds `toMatchAriaSnapshot()` assertions to validate accessibility tree structure. Optionally generates a dedicated axe-core scan test case.

```yaml
accessibility_assertions: 'true'
axe_scan: 'true'
axe_standard: 'wcag2aa'  # wcag2a | wcag2aa | wcag21a | wcag21aa | best-practice
```

## Configuration Reference

### Core Inputs

| Input | Default | Description |
|-------|---------|-------------|
| `llm_provider` | `anthropic` | `anthropic`, `openai`, or `custom` |
| `llm_api_key` | **(required)** | API key (use GitHub secrets) |
| `llm_model` | auto | Model name (provider-specific defaults) |
| `llm_base_url` | — | Custom endpoint for OpenAI-compatible APIs |
| `test_directory` | `e2e/generated` | Where to write generated test files |
| `test_pattern` | `e2e/**/*.spec.ts,*-e2e/**/*.spec.ts` | Comma-separated globs for existing tests used as style references |
| `base_url` | `http://localhost:3000` | App URL for Playwright config |
| `framework` | `generic` | `react`, `vue`, `svelte`, `angular`, `nextjs`, `generic` |
| `diff_mode` | `auto` | `auto`, `pr`, or `push` |
| `include_paths` | — | Comma-separated path prefixes to include |
| `exclude_paths` | `test/,tests/,...` | Comma-separated path prefixes to exclude |
| `auto_commit` | `false` | Commit tests directly to the branch |
| `auto_pr` | `true` | Create a separate PR with generated tests |
| `max_test_files` | `5` | Cap on tests generated per run (1-50) |
| `dry_run` | `false` | Preview without writing files |
| `overwrite_existing_files` | `false` | Allow generated artifacts to replace existing files; otherwise collisions fail safely |
| `custom_instructions` | — | Additional context for the LLM |

### Trace Viewer

| Input | Default | Description |
|-------|---------|-------------|
| `trace_on_failure` | `true` | Enable Playwright trace collection for test failures |
| `trace_mode` | `retain-on-failure` | Trace mode: `on`, `off`, `retain-on-failure`, `on-first-retry` |
| `test_results_directory` | `test-results` | Directory scanned by the post-action for traces, screenshots, and videos |

### API Mock Generation

| Input | Default | Description |
|-------|---------|-------------|
| `generate_api_mocks` | `false` | Detect API dependencies and generate `page.route()` mocks |
| `mock_error_states` | `false` | Generate additional test cases for API error responses |
| `fixture_extraction_threshold` | `3` | Number of `page.route()` calls before extracting into a shared fixture (1-100) |

### Visual Regression

| Input | Default | Description |
|-------|---------|-------------|
| `visual_regression` | `false` | Add `toHaveScreenshot()` assertions at visual checkpoints |
| `visual_threshold` | `0.2` | Pixel comparison threshold (0-1) |
| `visual_max_diff_ratio` | `0.05` | Maximum allowed diff pixel ratio (0-1) |
| `visual_full_page` | `false` | Capture full-page screenshots instead of viewport only |

### Project Structure Discovery

| Input | Default | Description |
|-------|---------|-------------|
| `pom_patterns` | *(auto-detected)* | Comma-separated globs for page object files (e.g., `**/*.po.ts,**/pages/**/*.ts`) |
| `utility_patterns` | *(auto-detected)* | Comma-separated globs for helper/utility files (e.g., `**/helpers/**/*.ts`) |
| `pom_output_directory` | — | Directory for generated POM files. When set, the LLM creates new POMs as separate files instead of inlining them in test specs |
| `project_context_budget` | `8000` | Approximate project-context token budget (100-200,000) |
| `diff_context_budget` | `24000` | Approximate aggregate diff/source token budget (100-200,000) |

When left empty, the scanner uses built-in patterns:
- **Page Objects:** `**/*.page.ts`, `**/pages/**/*.ts`, `**/page-objects/**/*.ts`, `**/*.pom.ts`, `**/*.po.ts`, `**/pom/**/*.ts`
- **Utilities:** `**/helpers/**/*.ts`, `**/utils/**/*.ts`, `**/fixtures/**/*.ts`, `**/support/**/*.ts`, `**/*.helper.ts`, `**/*.util.ts`

### Accessibility

| Input | Default | Description |
|-------|---------|-------------|
| `accessibility_assertions` | `false` | Add `toMatchAriaSnapshot()` assertions for changed components |
| `axe_scan` | `false` | Generate a dedicated axe-core accessibility scan test case |
| `axe_standard` | `wcag2aa` | axe-core standard: `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `best-practice` |

## Outputs

| Output | Description |
|--------|-------------|
| `tests_generated` | Number of test files created |
| `test_files` | JSON array of generated test file paths |
| `fixture_files` | JSON array of generated fixture file paths (when API mock generation is enabled) |
| `pom_files` | JSON array of generated page-object file paths |
| `pr_number` | PR number (if `auto_pr` is true) |
| `summary` | Human-readable summary |

## Advanced Examples

### All Features Enabled
```yaml
- uses: autospec-ai/playwright@v2
  with:
    llm_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
    base_url: 'http://localhost:3000'
    framework: 'react'

    # Trace
    trace_on_failure: 'true'
    trace_mode: 'retain-on-failure'

    # API Mocks
    generate_api_mocks: 'true'
    mock_error_states: 'true'
    fixture_extraction_threshold: '3'

    # Visual Regression
    visual_regression: 'true'
    visual_threshold: '0.2'
    visual_max_diff_ratio: '0.05'
    visual_full_page: 'false'

    # Accessibility
    accessibility_assertions: 'true'
    axe_scan: 'true'
    axe_standard: 'wcag2aa'
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

### Run Only on Specific Paths
```yaml
- uses: autospec-ai/playwright@v2
  with:
    llm_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
    include_paths: 'src/components/,src/pages/'
    exclude_paths: 'src/components/__tests__/'
```

### Dry Run in CI (Preview Only)
```yaml
- uses: autospec-ai/playwright@v2
  id: autospec
  with:
    llm_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
    dry_run: 'true'

- name: Comment preview
  if: github.event_name == 'pull_request' && steps.autospec.outputs.tests_generated != '0'
  uses: actions/github-script@ed597411d8f924073f98dfc5c65a23a2325f34cd # v8.0.0
  env:
    TESTS_GENERATED: ${{ steps.autospec.outputs.tests_generated }}
    SUMMARY: ${{ steps.autospec.outputs.summary }}
  with:
    script: |
      const testsGenerated = process.env.TESTS_GENERATED;
      const summary = process.env.SUMMARY;
      github.rest.issues.createComment({
        owner: context.repo.owner,
        repo: context.repo.repo,
        issue_number: context.issue.number,
        body: `### 🤖 AutoSpec Preview\nGenerated **${testsGenerated}** test(s).\n\n${summary}`
      });
```

### Chain with Playwright Execution
```yaml
- uses: autospec-ai/playwright@v2
  with:
    llm_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
    auto_pr: 'false'
    auto_commit: 'false'

- name: Install Playwright
  run: npx playwright install --with-deps

- name: Run generated tests
  run: npx playwright test e2e/generated/
```

The AutoSpec post-action runs after the remaining job steps, even when Playwright fails, and uploads diagnostics from `test_results_directory`.

### Run Tests by Severity
```yaml
# Run only critical tests for hotfix branches
- name: Run critical tests
  if: startsWith(github.head_ref, 'hotfix/')
  run: npx playwright test --grep "@sev1"

# Run sev1 + sev2 for staging
- name: Run high-priority tests
  run: npx playwright test --grep "@sev1|@sev2"
```

### Custom Instructions for Your Codebase
```yaml
- uses: autospec-ai/playwright@v2
  with:
    llm_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
    custom_instructions: |
      - Our app uses Clerk for auth. Mock auth with: await clerk.signIn(page)
      - All API calls go through /api/v2/ prefix
      - Use data-cy attributes for selectors (our convention)
      - We use MSW for API mocking in tests
```

## How Tests Are Styled

AutoSpec reads your existing test files (matched by `test_pattern`) and uses the best example as a style reference. The generated tests will match:

- Import patterns and test structure
- Naming conventions
- Selector strategies (data-testid, role, etc.)
- Setup/teardown patterns
- Assertion style

If no existing tests are found, it generates clean Playwright tests following official best practices.

## Architecture

```
src/
├── main.ts                     # Main Action executable
├── index.ts                    # Generation workflow orchestration
├── post-main.ts                # End-of-job post-action executable
├── post.ts                     # Trace upload orchestration
├── config.ts                   # Strict Action input parsing and validation
├── types.ts                    # Shared TypeScript types
├── providers/
│   ├── index.ts                # Provider factory
│   ├── anthropic.ts            # Anthropic Claude client
│   └── openai.ts               # OpenAI / compatible client
├── diff/
│   └── analyzer.ts             # Git diff extraction & filtering
├── discovery/
│   └── project-scanner.ts      # Scans for existing POMs, utilities, and test coverage
├── generator/
│   ├── prompts.ts              # Two-phase prompt construction with feature-conditional sections
│   └── test-generator.ts       # Orchestrates planning + generation + post-processing
└── utils/
    ├── git-ops.ts              # Commit & PR creation
    ├── test-post-processor.ts  # Trace injection, axe imports, screenshot normalization
    ├── fixture-extractor.ts    # Extracts page.route() mocks into shared fixture files
    └── trace-uploader.ts       # Uploads traces as GitHub Actions artifacts
```

### Post-Processing Pipeline

Generated test code passes through a post-processing pipeline in this order:

1. **Strip markdown fences** — Remove any `\`\`\`typescript` wrappers from LLM output
2. **Inject trace config** — Add `test.use({ trace, screenshot, video })` block
3. **Ensure axe import** — Add `@axe-core/playwright` import if `AxeBuilder` is used
4. **Normalize screenshots** — Add threshold/maxDiffRatio/fullPage options to `toHaveScreenshot()` calls

### Fixture Extraction

When `generate_api_mocks` is enabled and one test or hook contains more `page.route()` calls than `fixture_extraction_threshold`, self-contained mocks are extracted into a `fixtures/<name>.fixtures.ts` file. The TypeScript AST is used to preserve statement boundaries and keep each setup call in its original test or hook. Mocks that depend on surrounding local state remain inline.

## Security and Data Handling

AutoSpec sends selected diffs, changed source files, and discovered test utilities to the configured LLM provider. Exclude sensitive paths, review the provider's data-retention policy, and avoid placing credentials in source files or `custom_instructions`.

Generated plans are schema-validated, generated TypeScript is syntax-checked, output paths are constrained to configured repository directories, and existing files are not overwritten by default. Generated code should still be reviewed before it is merged or executed. Keep workflow permissions minimal and do not use `pull_request_target` to check out untrusted pull-request code alongside repository secrets.

## Development

Node.js 24 or newer is required.

```bash
npm install
npm run setup-hooks # optional: enable the repository's dist-refresh pre-commit hook
npm run build       # Produce bundled Node 24 Action entry points with esbuild
npm run lint
npm run typecheck
npm test
npm run test:coverage
npm audit --omit=dev
```

## License

MIT
