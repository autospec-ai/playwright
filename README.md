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
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0  # Required for diff analysis

      - uses: autospec-ai/action@v1
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
- uses: autospec-ai/action@v1
  with:
    llm_provider: anthropic
    llm_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
    llm_model: claude-sonnet-4-20250514  # optional, this is the default
```

### OpenAI
```yaml
- uses: autospec-ai/action@v1
  with:
    llm_provider: openai
    llm_api_key: ${{ secrets.OPENAI_API_KEY }}
    llm_model: gpt-4o  # optional, this is the default
```

### Custom / OpenAI-Compatible (Ollama, Together, Groq, etc.)
```yaml
- uses: autospec-ai/action@v1
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
Captures Playwright traces, screenshots, and video on test failures. Trace files are uploaded as GitHub Actions artifacts for one-click debugging.

```yaml
trace_on_failure: 'true'
trace_mode: 'retain-on-failure'  # on | off | retain-on-failure | on-first-retry
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
AutoSpec scans your project for existing page objects, utility functions, and test coverage before generating tests. This prevents the LLM from hallucinating locators, POM classes, or helpers that don't exist — and ensures generated tests reuse what's already there with correct import paths.

**What it discovers:**
- **Page Objects** — Classes with locators (`getByRole`, `getByTestId`, `locator`) and public methods
- **Utilities** — Exported helper functions and constants
- **Test Coverage** — Routes, flows, and page objects already under test

**Auto-detection** works out of the box for common conventions (`**/pages/**/*.ts`, `**/*.page.ts`, `**/helpers/**/*.ts`, etc.). If your project uses different naming, configure the patterns explicitly:

```yaml
- uses: autospec-ai/action@v1
  with:
    llm_api_key: ${{ secrets.OPENAI_API_KEY }}
    test_directory: 'e2e/tests'                        # where to write generated tests
    pom_patterns: '**/*.po.ts,**/pageobjects/**/*.ts'  # match your POM convention
    utility_patterns: '**/helpers/**/*.ts'              # match your utility convention
    project_context_budget: '10000'                     # increase if you have many POMs
```

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
| `test_pattern` | `e2e/**/*.spec.ts` | Glob to find existing tests for style matching |
| `base_url` | `http://localhost:3000` | App URL for Playwright config |
| `framework` | `generic` | `react`, `vue`, `svelte`, `angular`, `nextjs`, `generic` |
| `diff_mode` | `auto` | `auto`, `pr`, or `push` |
| `include_paths` | — | Comma-separated path prefixes to include |
| `exclude_paths` | `test/,tests/,...` | Comma-separated path prefixes to exclude |
| `auto_commit` | `false` | Commit tests directly to the branch |
| `auto_pr` | `true` | Create a separate PR with generated tests |
| `max_test_files` | `5` | Cap on tests generated per run |
| `dry_run` | `false` | Preview without writing files |
| `custom_instructions` | — | Additional context for the LLM |

### Trace Viewer

| Input | Default | Description |
|-------|---------|-------------|
| `trace_on_failure` | `true` | Enable Playwright trace collection for test failures |
| `trace_mode` | `retain-on-failure` | Trace mode: `on`, `off`, `retain-on-failure`, `on-first-retry` |

### API Mock Generation

| Input | Default | Description |
|-------|---------|-------------|
| `generate_api_mocks` | `false` | Detect API dependencies and generate `page.route()` mocks |
| `mock_error_states` | `false` | Generate additional test cases for API error responses |
| `fixture_extraction_threshold` | `3` | Number of `page.route()` calls before extracting into a shared fixture |

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
| `project_context_budget` | `8000` | Approximate token budget for project context injected into LLM prompts |

When left empty, the scanner uses built-in patterns:
- **Page Objects:** `**/*.page.ts`, `**/pages/**/*.ts`, `**/page-objects/**/*.ts`, `**/*.pom.ts`, `**/pom/**/*.ts`
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
| `pr_number` | PR number (if `auto_pr` is true) |
| `summary` | Human-readable summary |

## Advanced Examples

### All Features Enabled
```yaml
- uses: autospec-ai/action@v1
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
- uses: autospec-ai/action@v1
  with:
    llm_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
    include_paths: 'src/components/,src/pages/'
    exclude_paths: 'src/components/__tests__/'
```

### Dry Run in CI (Preview Only)
```yaml
- uses: autospec-ai/action@v1
  id: autospec
  with:
    llm_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
    dry_run: 'true'

- name: Comment preview
  if: github.event_name == 'pull_request' && steps.autospec.outputs.tests_generated != '0'
  uses: actions/github-script@v7
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
- uses: autospec-ai/action@v1
  with:
    llm_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
    auto_pr: 'false'
    auto_commit: 'false'

- name: Install Playwright
  run: npx playwright install --with-deps

- name: Run generated tests
  run: npx playwright test e2e/generated/
```

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
- uses: autospec-ai/action@v1
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
├── index.ts                    # Action entry point, config parsing
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

When `generate_api_mocks` is enabled and a test contains more `page.route()` calls than `fixture_extraction_threshold`, the mocks are extracted into a `fixtures/<name>.fixtures.ts` file with a `setupApiMocks(page)` function. The test is rewritten to import and call it.

## Development

```bash
npm install
npm run build       # Compile with ncc
npm run lint
npm test
```

## License

MIT
