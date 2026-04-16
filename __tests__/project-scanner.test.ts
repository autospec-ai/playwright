import { ProjectScanner } from '../src/discovery/project-scanner';
import { ActionConfig, DiffResult } from '../src/types';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Minimal config for testing
function makeConfig(overrides: Partial<ActionConfig> = {}): ActionConfig {
  return {
    llm: { provider: 'openai', apiKey: 'test', model: 'gpt-4o' },
    testDirectory: 'e2e/generated',
    testPatterns: [],
    baseUrl: 'http://localhost:3000',
    framework: 'generic',
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

function makeDiff(files: DiffResult['files'] = []): DiffResult {
  return {
    files,
    baseSha: 'abc123'.padEnd(40, '0'),
    headSha: 'def456'.padEnd(40, '0'),
    summary: 'Test diff',
  };
}

describe('ProjectScanner', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autospec-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeFile(relPath: string, content: string): void {
    const fullPath = path.join(tmpDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, 'utf-8');
  }

  describe('page object discovery', () => {
    it('discovers page objects matching *.page.ts pattern', async () => {
      writeFile('e2e/pages/login.page.ts', `
export class LoginPage {
  private page: Page;

  constructor(page: Page) {
    this.page = page;
    this.usernameInput = page.getByRole('textbox', { name: 'Username' });
    this.passwordInput = page.getByRole('textbox', { name: 'Password' });
    this.submitButton = page.getByRole('button', { name: 'Sign in' });
  }

  async login(username: string, password: string) {
    await this.usernameInput.fill(username);
    await this.passwordInput.fill(password);
    await this.submitButton.click();
  }

  async getErrorMessage() {
    return this.page.getByRole('alert').textContent();
  }
}
`);

      const config = makeConfig({ pomPatterns: [path.join(tmpDir, '**/*.page.ts')] });
      const scanner = new ProjectScanner(config);
      const ctx = await scanner.scan(makeDiff());

      expect(ctx.pageObjects).toHaveLength(1);
      expect(ctx.pageObjects[0].className).toBe('LoginPage');
      expect(ctx.pageObjects[0].exportedMethods).toContain('login(username: string, password: string)');
      expect(ctx.pageObjects[0].exportedMethods).toContain('getErrorMessage()');
      expect(ctx.pageObjects[0].locators.length).toBeGreaterThanOrEqual(3);
      expect(ctx.pageObjects[0].locators.map(l => l.name)).toContain('usernameInput');
      expect(ctx.pageObjects[0].locators.map(l => l.name)).toContain('submitButton');
    });

    it('extracts getter-style locators', async () => {
      writeFile('e2e/pages/dashboard.page.ts', `
export class DashboardPage {
  constructor(private page: Page) {}

  get widgetContainer() { return this.page.getByTestId('widget-container') }
  get addButton() { return this.page.getByRole('button', { name: 'Add' }) }
}
`);

      const config = makeConfig({ pomPatterns: [path.join(tmpDir, '**/*.page.ts')] });
      const scanner = new ProjectScanner(config);
      const ctx = await scanner.scan(makeDiff());

      expect(ctx.pageObjects).toHaveLength(1);
      expect(ctx.pageObjects[0].locators.map(l => l.name)).toContain('widgetContainer');
      expect(ctx.pageObjects[0].locators.map(l => l.name)).toContain('addButton');
    });

    it('extracts arrow-function locators in elements object', async () => {
      writeFile('e2e/pages/settings/settings.page.ts', `
import { Locator, Page } from '@playwright/test';

export class SettingsPage {
  constructor(private page: Page) {}

  elements = {
    getCards: (): Locator => this.page.locator('[data-testid="settings-card"]'),
    getSaveButton: (): Locator => this.page.getByTestId('save-btn'),
    getCardByName: (name: string): Locator => this.page.locator(\`[data-testid="card"]:has-text("\${name}")\`),
    advancedSection: {
      getToggle: (): Locator => this.page.locator('[data-testid="advanced-toggle"]'),
    },
  };

  async goto(path?: string): Promise<void> {
    await this.page.goto(path ?? '/settings');
    await this.waitForSpinner();
  }
}
`);

      const config = makeConfig({ pomPatterns: [path.join(tmpDir, '**/*.page.ts')] });
      const scanner = new ProjectScanner(config);
      const ctx = await scanner.scan(makeDiff());

      expect(ctx.pageObjects).toHaveLength(1);
      expect(ctx.pageObjects[0].className).toBe('SettingsPage');

      const locatorNames = ctx.pageObjects[0].locators.map(l => l.name);
      expect(locatorNames).toContain('getCards');
      expect(locatorNames).toContain('getSaveButton');
      expect(locatorNames).toContain('getCardByName');

      // Should extract routes from goto() method
      expect(ctx.pageObjects[0].routes).toContain('/settings');

      // Should extract nested object locators with qualified names
      expect(locatorNames).toContain('advancedSection.getToggle');
    });

    it('extracts factory-function element groups with returned locators', async () => {
      writeFile('e2e/pages/orders/orders.page.ts', `
import { Locator, Page } from '@playwright/test';

export class OrdersPage {
  constructor(private page: Page) {}

  elements = {
    getFilterGroup: () => {
      const getStatusFilter = (): Locator => this.page.getByTestId('status-filter');
      const getDatePicker = (): Locator => this.page.locator('[name="date-range"]');

      return { getStatusFilter, getDatePicker };
    },

    getSearchInput: (): Locator => this.page.locator('input[placeholder="Search orders"]'),
    getExportButton: (): Locator => this.page.locator('button').filter({ hasText: 'Export' }),
    getSelectAllCheckbox: (): Locator => this.page.locator('input[aria-label*="toggle all rows"]'),
  };

  async goto(): Promise<void> {
    await this.page.goto('/orders');
  }
}
`);

      const config = makeConfig({ pomPatterns: [path.join(tmpDir, '**/*.page.ts')] });
      const scanner = new ProjectScanner(config);
      const ctx = await scanner.scan(makeDiff());

      expect(ctx.pageObjects).toHaveLength(1);
      expect(ctx.pageObjects[0].className).toBe('OrdersPage');

      const locatorNames = ctx.pageObjects[0].locators.map(l => l.name);
      // Direct arrow-function locators
      expect(locatorNames).toContain('getSearchInput');
      expect(locatorNames).toContain('getExportButton');
      expect(locatorNames).toContain('getSelectAllCheckbox');

      // Factory-function locators with qualified names
      expect(locatorNames).toContain('getFilterGroup().getStatusFilter');
      expect(locatorNames).toContain('getFilterGroup().getDatePicker');

      // Routes
      expect(ctx.pageObjects[0].routes).toContain('/orders');
    });

    it('skips files without exported classes', async () => {
      writeFile('e2e/pages/constants.page.ts', `
export const LOGIN_URL = '/login';
export const TIMEOUT = 5000;
`);

      const config = makeConfig({ pomPatterns: [path.join(tmpDir, '**/*.page.ts')] });
      const scanner = new ProjectScanner(config);
      const ctx = await scanner.scan(makeDiff());

      expect(ctx.pageObjects).toHaveLength(0);
    });
  });

  describe('utility discovery', () => {
    it('discovers exported functions and constants', async () => {
      writeFile('e2e/helpers/auth.ts', `
export async function loginAsAdmin(page: Page) {
  await page.goto('/login');
  await page.fill('#email', 'admin@example.com');
  await page.fill('#password', 'password');
  await page.click('button[type="submit"]');
}

export const DEFAULT_TIMEOUT = 5000;

export const setupAuth = async (page: Page, role: string) => {
  await page.goto('/auth');
};
`);

      const config = makeConfig({ utilityPatterns: [path.join(tmpDir, '**/helpers/**/*.ts')] });
      const scanner = new ProjectScanner(config);
      const ctx = await scanner.scan(makeDiff());

      expect(ctx.utilities).toHaveLength(1);
      expect(ctx.utilities[0].exportedFunctions).toContain('loginAsAdmin(page: Page)');
      expect(ctx.utilities[0].exportedFunctions).toContain('setupAuth(page: Page, role: string)');
      expect(ctx.utilities[0].exportedConstants).toContain('DEFAULT_TIMEOUT');
    });

    it('skips files with no exports', async () => {
      writeFile('e2e/helpers/internal.ts', `
function privateHelper() { return 42; }
const localConst = 'hello';
`);

      const config = makeConfig({ utilityPatterns: [path.join(tmpDir, '**/helpers/**/*.ts')] });
      const scanner = new ProjectScanner(config);
      const ctx = await scanner.scan(makeDiff());

      expect(ctx.utilities).toHaveLength(0);
    });
  });

  describe('test coverage analysis', () => {
    it('extracts routes, describe blocks, and test names', async () => {
      writeFile('e2e/tests/login.spec.ts', `
import { test, expect } from '@playwright/test';
import { LoginPage } from '../pages/login.page';

test.describe('Login flow', () => {
  test('should login with valid credentials', async ({ page }) => {
    await page.goto('/login');
    // ...
  });

  test('should show error for invalid password', async ({ page }) => {
    await page.goto('/login');
    // ...
  });
});
`);

      const config = makeConfig({
        testPatterns: [path.join(tmpDir, '**/*.spec.ts')],
      });
      const scanner = new ProjectScanner(config);
      const ctx = await scanner.scan(makeDiff());

      expect(ctx.coverage).toHaveLength(1);
      expect(ctx.coverage[0].routes).toContain('/login');
      expect(ctx.coverage[0].describedFlows).toContain('Login flow');
      expect(ctx.coverage[0].testNames).toContain('should login with valid credentials');
      expect(ctx.coverage[0].testNames).toContain('should show error for invalid password');
      expect(ctx.coverage[0].importedPageObjects).toContain('LoginPage');
    });
  });

  describe('relevance scoring and token budget', () => {
    it('prioritizes page objects referenced by changed files', async () => {
      writeFile('e2e/pages/login.page.ts', `
export class LoginPage {
  async login(user: string, pass: string) {}
}
`);
      writeFile('e2e/pages/settings.page.ts', `
export class SettingsPage {
  async updateProfile(name: string) {}
}
`);

      const config = makeConfig({
        pomPatterns: [path.join(tmpDir, '**/*.page.ts')],
        projectContextBudget: 100, // very small budget — should only keep most relevant
      });

      const diff = makeDiff([{
        filename: 'src/components/Login.tsx',
        status: 'modified',
        patch: '',
        additions: 5,
        deletions: 2,
        fullContent: `import { LoginPage } from '../pages/login.page';`,
      }]);

      const scanner = new ProjectScanner(config);
      const ctx = await scanner.scan(diff);

      // LoginPage should be prioritized because the diff references it
      if (ctx.pageObjects.length > 0) {
        expect(ctx.pageObjects[0].className).toBe('LoginPage');
      }
    });

    it('returns empty context when no POM or utilities exist', async () => {
      const config = makeConfig({
        pomPatterns: [path.join(tmpDir, '**/*.page.ts')],
        utilityPatterns: [path.join(tmpDir, '**/helpers/**/*.ts')],
      });
      const scanner = new ProjectScanner(config);
      const ctx = await scanner.scan(makeDiff());

      expect(ctx.pageObjects).toHaveLength(0);
      expect(ctx.utilities).toHaveLength(0);
      expect(ctx.coverage).toHaveLength(0);
    });
  });
});
