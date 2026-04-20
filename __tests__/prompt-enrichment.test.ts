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
    pomOutputDirectory: '',
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
        source: `import { Page } from '@playwright/test';

export class LoginPage {
  private usernameInput = this.page.getByRole('textbox', { name: 'Username' });
  private submitButton = this.page.getByRole('button', { name: 'Sign in' });

  constructor(private page: Page) {}

  async login(username: string, password: string) {
    await this.usernameInput.fill(username);
    await this.page.getByRole('textbox', { name: 'Password' }).fill(password);
    await this.submitButton.click();
  }

  async getErrorMessage() {
    return this.page.getByRole('alert').textContent();
  }
}`,
      },
    ],
    utilities: [
      {
        filepath: 'e2e/helpers/auth.ts',
        source: `import { Page } from '@playwright/test';

export async function loginAsAdmin(page: Page) {
  await page.goto('/login');
  await page.fill('#email', 'admin@example.com');
  await page.fill('#password', 'password');
  await page.click('button[type="submit"]');
}

export async function createTestUser(page: Page) {
  await page.goto('/admin/users/new');
}

export const DEFAULT_TIMEOUT = 5000;`,
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
    it('includes page object source code when project context is set', () => {
      const builder = new PromptBuilder(makeConfig());
      builder.setProjectContext(makeProjectContext());
      const prompt = builder.buildPlanPrompt(makeDiff(), []);

      expect(prompt).toContain('Available Page Objects');
      expect(prompt).toContain('LoginPage');
      // Source code is embedded directly — verify key parts appear
      expect(prompt).toContain('export class LoginPage');
      expect(prompt).toContain('async login(username: string, password: string)');
      expect(prompt).toContain('usernameInput');
      expect(prompt).toContain('submitButton');
    });

    it('includes utility source code', () => {
      const builder = new PromptBuilder(makeConfig());
      builder.setProjectContext(makeProjectContext());
      const prompt = builder.buildPlanPrompt(makeDiff(), []);

      expect(prompt).toContain('Available Utilities');
      expect(prompt).toContain('export async function loginAsAdmin');
      expect(prompt).toContain('export async function createTestUser');
      expect(prompt).toContain('DEFAULT_TIMEOUT');
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

    it('includes page object source with correct relative import paths', () => {
      const builder = new PromptBuilder(makeConfig());
      builder.setProjectContext(makeProjectContext());
      const prompt = builder.buildTestPrompt(planEntry, makeDiff(), []);

      expect(prompt).toContain('Page Objects');
      expect(prompt).toContain('LoginPage');
      // Import path should be relative from e2e/generated/ to e2e/pages/login.page
      expect(prompt).toContain('../pages/login.page');
      // Source code is embedded
      expect(prompt).toContain('export class LoginPage');
    });

    it('includes utility source with correct relative import paths', () => {
      const builder = new PromptBuilder(makeConfig());
      builder.setProjectContext(makeProjectContext());
      const prompt = builder.buildTestPrompt(planEntry, makeDiff(), []);

      expect(prompt).toContain('Utility Functions');
      expect(prompt).toContain('../helpers/auth');
      // Source code is embedded
      expect(prompt).toContain('export async function loginAsAdmin');
    });

    it('includes anti-hallucination instructions', () => {
      const builder = new PromptBuilder(makeConfig());
      builder.setProjectContext(makeProjectContext());
      const prompt = builder.buildTestPrompt(planEntry, makeDiff(), []);

      expect(prompt).toContain('Do NOT invent');
      expect(prompt).toContain('Do NOT create page object classes inline');
    });

    it('omits project context sections when no context is set', () => {
      const builder = new PromptBuilder(makeConfig());
      const prompt = builder.buildTestPrompt(planEntry, makeDiff(), []);

      expect(prompt).not.toContain('Page Objects');
      expect(prompt).not.toContain('Utility Functions');
    });
  });
});
