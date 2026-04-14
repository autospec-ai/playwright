import { PromptBuilder } from '../src/generator/prompts';
import { ActionConfig, DiffResult, ProjectContext } from '../src/types';

function makeConfig(overrides: Partial<ActionConfig> = {}): ActionConfig {
  return {
    llm: { provider: 'openai', apiKey: 'test', model: 'gpt-4o' },
    testDirectory: 'e2e/generated',
    testPatterns: ['e2e/**/*.spec.ts'],
    baseUrl: 'http://localhost:3000',
    framework: 'react',
    diffMode: 'auto',
    includePaths: [],
    excludePaths: [],
    autoCommit: false,
    autoPr: false,
    maxTestFiles: 5,
    dryRun: true,
    customInstructions: '',
    pomPatterns: [],
    utilityPatterns: [],
    projectContextBudget: 8000,
    traceOnFailure: false,
    traceMode: 'retain-on-failure',
    generateApiMocks: false,
    mockErrorStates: false,
    fixtureExtractionThreshold: 3,
    visualRegression: false,
    visualThreshold: 0.2,
    visualMaxDiffRatio: 0.05,
    visualFullPage: false,
    accessibilityAssertions: false,
    axeScan: false,
    axeStandard: 'wcag2aa',
    ...overrides,
  };
}

function makeDiff(): DiffResult {
  return {
    files: [{
      filename: 'src/components/Login.tsx',
      status: 'modified',
      patch: '+ const x = 1;',
      additions: 1,
      deletions: 0,
      fullContent: 'const x = 1;',
    }],
    baseSha: 'abc123'.padEnd(40, '0'),
    headSha: 'def456'.padEnd(40, '0'),
    summary: '1 file changed',
  };
}

function makeProjectContext(): ProjectContext {
  return {
    pageObjects: [
      {
        filepath: 'e2e/pages/login.page.ts',
        className: 'LoginPage',
        exportedMethods: ['login(username: string, password: string)', 'getErrorMessage()'],
        locators: [
          { name: 'usernameInput', selector: "page.getByRole('textbox', { name: 'Username' })", source: 'e2e/pages/login.page.ts' },
          { name: 'submitButton', selector: "page.getByRole('button', { name: 'Sign in' })", source: 'e2e/pages/login.page.ts' },
        ],
      },
    ],
    utilities: [
      {
        filepath: 'e2e/helpers/auth.ts',
        exportedFunctions: ['loginAsAdmin(page: Page)', 'createTestUser(page: Page)'],
        exportedConstants: ['DEFAULT_TIMEOUT'],
      },
    ],
    coverage: [
      {
        filepath: 'e2e/tests/login.spec.ts',
        routes: ['/login'],
        importedPageObjects: ['LoginPage'],
        describedFlows: ['Login flow'],
        testNames: ['should login with valid credentials'],
      },
    ],
  };
}

describe('PromptBuilder with ProjectContext', () => {
  describe('buildPlanPrompt', () => {
    it('includes page object catalog when project context is set', () => {
      const builder = new PromptBuilder(makeConfig());
      builder.setProjectContext(makeProjectContext());
      const prompt = builder.buildPlanPrompt(makeDiff(), []);

      expect(prompt).toContain('Available Page Objects');
      expect(prompt).toContain('LoginPage');
      expect(prompt).toContain('login(username: string, password: string)');
      expect(prompt).toContain('usernameInput');
      expect(prompt).toContain('submitButton');
    });

    it('includes utility catalog', () => {
      const builder = new PromptBuilder(makeConfig());
      builder.setProjectContext(makeProjectContext());
      const prompt = builder.buildPlanPrompt(makeDiff(), []);

      expect(prompt).toContain('Available Utilities');
      expect(prompt).toContain('loginAsAdmin');
      expect(prompt).toContain('createTestUser');
    });

    it('includes existing test coverage summary', () => {
      const builder = new PromptBuilder(makeConfig());
      builder.setProjectContext(makeProjectContext());
      const prompt = builder.buildPlanPrompt(makeDiff(), []);

      expect(prompt).toContain('Existing Test Coverage');
      expect(prompt).toContain('/login');
      expect(prompt).toContain('Login flow');
    });

    it('includes instructions to reuse existing objects', () => {
      const builder = new PromptBuilder(makeConfig());
      builder.setProjectContext(makeProjectContext());
      const prompt = builder.buildPlanPrompt(makeDiff(), []);

      expect(prompt).toContain('MUST reuse existing page objects');
      expect(prompt).toContain('MUST use existing utility functions');
    });

    it('omits project context sections when no context is set', () => {
      const builder = new PromptBuilder(makeConfig());
      const prompt = builder.buildPlanPrompt(makeDiff(), []);

      expect(prompt).not.toContain('Available Page Objects');
      expect(prompt).not.toContain('Available Utilities');
      expect(prompt).not.toContain('Existing Test Coverage');
    });
  });

  describe('buildTestPrompt', () => {
    const planEntry = {
      targetFile: 'src/components/Login.tsx',
      testFilename: 'login-flow.spec.ts',
      description: 'Tests the login flow',
      userFlows: ['User enters credentials', 'User clicks sign in'],
      priority: 'high' as const,
      severity: 'sev1' as const,
    };

    it('includes page objects with correct relative import paths', () => {
      const builder = new PromptBuilder(makeConfig());
      builder.setProjectContext(makeProjectContext());
      const prompt = builder.buildTestPrompt(planEntry, makeDiff(), []);

      expect(prompt).toContain('Page Objects Available for Import');
      expect(prompt).toContain('LoginPage');
      // Import path should be relative from e2e/generated/ to e2e/pages/login.page
      expect(prompt).toContain('../pages/login.page');
    });

    it('includes utilities with correct relative import paths', () => {
      const builder = new PromptBuilder(makeConfig());
      builder.setProjectContext(makeProjectContext());
      const prompt = builder.buildTestPrompt(planEntry, makeDiff(), []);

      expect(prompt).toContain('Utility Functions Available');
      expect(prompt).toContain('../helpers/auth');
    });

    it('includes anti-hallucination instructions', () => {
      const builder = new PromptBuilder(makeConfig());
      builder.setProjectContext(makeProjectContext());
      const prompt = builder.buildTestPrompt(planEntry, makeDiff(), []);

      expect(prompt).toContain('Do NOT invent page objects');
      expect(prompt).toContain('Do NOT create inline locators');
    });

    it('omits project context sections when no context is set', () => {
      const builder = new PromptBuilder(makeConfig());
      const prompt = builder.buildTestPrompt(planEntry, makeDiff(), []);

      expect(prompt).not.toContain('Page Objects Available for Import');
      expect(prompt).not.toContain('Utility Functions Available');
    });
  });
});
