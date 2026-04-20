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
    it('discovers page objects with className, filepath, and source', async () => {
      const sourceContent = `
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
`;
      writeFile('e2e/pages/login.page.ts', sourceContent);

      const config = makeConfig({ pomPatterns: [path.join(tmpDir, '**/*.page.ts')] });
      const scanner = new ProjectScanner(config);
      const ctx = await scanner.scan(makeDiff());

      expect(ctx.pageObjects).toHaveLength(1);
      expect(ctx.pageObjects[0].className).toBe('LoginPage');
      expect(ctx.pageObjects[0].filepath).toContain('e2e/pages/login.page.ts');
      // source field contains the raw file content
      expect(ctx.pageObjects[0].source).toContain('export class LoginPage');
      expect(ctx.pageObjects[0].source).toContain('async login(username: string, password: string)');
      expect(ctx.pageObjects[0].source).toContain('usernameInput');
      expect(ctx.pageObjects[0].source).toContain('submitButton');
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
    it('discovers utilities with filepath and source', async () => {
      const sourceContent = `
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
`;
      writeFile('e2e/helpers/auth.ts', sourceContent);

      const config = makeConfig({ utilityPatterns: [path.join(tmpDir, '**/helpers/**/*.ts')] });
      const scanner = new ProjectScanner(config);
      const ctx = await scanner.scan(makeDiff());

      expect(ctx.utilities).toHaveLength(1);
      expect(ctx.utilities[0].filepath).toContain('e2e/helpers/auth.ts');
      // source field contains the raw file content
      expect(ctx.utilities[0].source).toContain('export async function loginAsAdmin');
      expect(ctx.utilities[0].source).toContain('DEFAULT_TIMEOUT');
      expect(ctx.utilities[0].source).toContain('setupAuth');
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
