// ─── LLM Provider Types ───

export type LLMProvider = 'anthropic' | 'openai' | 'custom';

export interface LLMConfig {
  provider: LLMProvider;
  apiKey: string;
  model: string;
  baseUrl?: string;
}

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMResponse {
  content: string;
  model: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
}

export interface LLMClient {
  generate(messages: LLMMessage[], options?: { maxTokens?: number; temperature?: number }): Promise<LLMResponse>;
}

// ─── Diff Types ───

export type DiffMode = 'auto' | 'pr' | 'push';

export interface FileDiff {
  filename: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  patch: string;           // unified diff
  additions: number;
  deletions: number;
  previousFilename?: string;
  fullContent?: string;    // full file content at HEAD (omitted for deleted files)
}

export interface DiffResult {
  files: FileDiff[];
  baseSha: string;
  headSha: string;
  summary: string;
}

// ─── Test Generation Types ───

export interface ExistingTest {
  filepath: string;
  content: string;
}

export interface GeneratedTest {
  filename: string;
  filepath: string;
  content: string;
  sourceFiles: string[];     // which changed files prompted this test
  description: string;       // human-readable description
  severity: string;          // sev1 | sev2 | sev3 | sev4
}

export interface TestPlan {
  tests: TestPlanEntry[];
  reasoning: string;
}

export interface ApiDependency {
  url: string;
  method: string;
  description: string;
  responseShape?: string;
  isWebSocket?: boolean;
}

export interface ExtractedFixture {
  filepath: string;
  content: string;
  sourceTestFile: string;
}

export interface TestPlanEntry {
  targetFile: string;
  testFilename: string;
  description: string;
  userFlows: string[];
  priority: 'high' | 'medium' | 'low';
  severity: 'sev1' | 'sev2' | 'sev3' | 'sev4';
  apiDependencies?: ApiDependency[];
}

// ─── Project Structure Discovery Types ───

export interface LocatorInfo {
  name: string;               // e.g. "submitButton"
  selector: string;           // e.g. "page.getByRole('button', { name: 'Submit' })"
  source: string;             // filepath where defined
}

export interface PageObjectInfo {
  filepath: string;           // relative path
  className: string;          // e.g. "LoginPage"
  exportedMethods: string[];  // e.g. ["login(username, password)", "getErrorMessage()"]
  locators: LocatorInfo[];    // extracted locator definitions
}

export interface UtilityInfo {
  filepath: string;
  exportedFunctions: string[];  // e.g. ["loginAsAdmin(page)", "clearDatabase()"]
  exportedConstants: string[];  // e.g. ["BASE_URL", "DEFAULT_TIMEOUT"]
}

export interface TestCoverageInfo {
  filepath: string;
  routes: string[];              // URL paths tested (from goto/navigate)
  importedPageObjects: string[]; // POM classes used
  describedFlows: string[];      // test.describe names
  testNames: string[];           // individual test() names
}

export interface ProjectContext {
  pageObjects: PageObjectInfo[];
  utilities: UtilityInfo[];
  coverage: TestCoverageInfo[];
}

// ─── Action Configuration ───

export type TraceMode = 'on' | 'off' | 'retain-on-failure' | 'on-first-retry';

export interface ActionConfig {
  llm: LLMConfig;
  testDirectory: string;
  testPatterns: string[];
  baseUrl: string;
  framework: string;
  diffMode: DiffMode;
  includePaths: string[];
  excludePaths: string[];
  autoCommit: boolean;
  autoPr: boolean;
  maxTestFiles: number;
  dryRun: boolean;
  customInstructions: string;

  // Feature: Project Structure Discovery
  pomPatterns: string[];
  utilityPatterns: string[];
  projectContextBudget: number;

  // Feature: Trace Viewer Integration
  traceOnFailure: boolean;
  traceMode: TraceMode;

  // Feature: API Mock Generation
  generateApiMocks: boolean;
  mockErrorStates: boolean;
  fixtureExtractionThreshold: number;

  // Feature: Visual Regression Baselines
  visualRegression: boolean;
  visualThreshold: number;
  visualMaxDiffRatio: number;
  visualFullPage: boolean;

  // Feature: Accessibility / Aria Snapshot Assertions
  accessibilityAssertions: boolean;
  axeScan: boolean;
  axeStandard: string;
}

export interface ActionResult {
  testsGenerated: number;
  testFiles: string[];
  fixtureFiles?: string[];
  prNumber?: number;
  summary: string;
}
