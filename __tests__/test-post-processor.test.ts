import { TestPostProcessor } from '../src/utils/test-post-processor';

describe('TestPostProcessor', () => {
  describe('injectTraceConfig', () => {
    const baseCode = `import { test, expect } from '@playwright/test';

test.describe('Login', () => {
  test('should login', async ({ page }) => {
    await page.goto('/login');
  });
});`;

    it('injects trace config after imports', () => {
      const result = TestPostProcessor.injectTraceConfig(baseCode, 'retain-on-failure');
      expect(result).toContain("trace: 'retain-on-failure'");
      expect(result).toContain("screenshot: 'only-on-failure'");
      expect(result).toContain("video: 'retain-on-failure'");
    });

    it('uses correct trace value for "on" mode', () => {
      const result = TestPostProcessor.injectTraceConfig(baseCode, 'on');
      expect(result).toContain("trace: 'on'");
    });

    it('uses correct trace value for "on-first-retry" mode', () => {
      const result = TestPostProcessor.injectTraceConfig(baseCode, 'on-first-retry');
      expect(result).toContain("trace: 'on-first-retry'");
    });

    it('skips injection if test.use() already exists', () => {
      const codeWithUse = `import { test, expect } from '@playwright/test';

test.use({ storageState: 'auth.json' });

test('example', async ({ page }) => {});`;

      const result = TestPostProcessor.injectTraceConfig(codeWithUse, 'retain-on-failure');
      expect(result).toBe(codeWithUse);
    });

    it('preserves existing code structure', () => {
      const result = TestPostProcessor.injectTraceConfig(baseCode, 'retain-on-failure');
      expect(result).toContain("test.describe('Login'");
      expect(result).toContain("await page.goto('/login')");
    });

    it('does not inject inside class bodies when stray imports appear mid-file', () => {
      const codeWithInlineClass = `import { expect, test } from '../../fixtures/base';
import { SettingsPage } from '../../pages/settings.page';

let settingsPage: SettingsPage;

test.describe('Settings', () => {
  test('form is visible', async () => {});
});
import { Locator } from '@playwright/test';
import { BasePage } from '../../pages/base.page';

export class SettingsPage extends BasePage {
  elements = {
    getSaveButton: (): Locator => this.page.getByTestId('save-btn'),
  };
}`;

      const result = TestPostProcessor.injectTraceConfig(codeWithInlineClass, 'retain-on-failure');
      // The test.use block should appear AFTER the first two imports, not after the mid-file imports
      const testUseIndex = result.indexOf('test.use({');
      const classIndex = result.indexOf('export class');
      expect(testUseIndex).toBeGreaterThan(-1);
      expect(classIndex).toBeGreaterThan(-1);
      expect(testUseIndex).toBeLessThan(classIndex);
    });
  });

  describe('ensureAxeImport', () => {
    it('injects axe import when AxeBuilder is used without import', () => {
      const code = `import { test, expect } from '@playwright/test';

test('a11y', async ({ page }) => {
  const results = await new AxeBuilder({ page }).analyze();
});`;

      const result = TestPostProcessor.ensureAxeImport(code);
      expect(result).toContain("import AxeBuilder from '@axe-core/playwright'");
    });

    it('does not inject if @axe-core/playwright is already imported', () => {
      const code = `import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('a11y', async ({ page }) => {
  const results = await new AxeBuilder({ page }).analyze();
});`;

      const result = TestPostProcessor.ensureAxeImport(code);
      // Should not have duplicate imports
      const importCount = (result.match(/@axe-core\/playwright/g) || []).length;
      expect(importCount).toBe(1);
    });

    it('returns code unchanged if AxeBuilder is not used', () => {
      const code = `import { test, expect } from '@playwright/test';

test('basic', async ({ page }) => {
  await page.goto('/');
});`;

      const result = TestPostProcessor.ensureAxeImport(code);
      expect(result).toBe(code);
    });
  });

  describe('normalizeScreenshotOptions', () => {
    it('adds options to bare toHaveScreenshot calls', () => {
      const code = `await expect(page).toHaveScreenshot('dashboard.png');`;

      const result = TestPostProcessor.normalizeScreenshotOptions(code, 0.2, 0.05, false);
      expect(result).toContain('threshold: 0.2');
      expect(result).toContain('maxDiffPixelRatio: 0.05');
      expect(result).toContain('fullPage: false');
    });

    it('handles multiple screenshot calls', () => {
      const code = `await expect(page).toHaveScreenshot('before.png');
await expect(page).toHaveScreenshot('after.png');`;

      const result = TestPostProcessor.normalizeScreenshotOptions(code, 0.3, 0.1, true);
      const matches = result.match(/threshold: 0\.3/g);
      expect(matches).toHaveLength(2);
    });

    it('does not modify calls that already have options', () => {
      const code = `await expect(page).toHaveScreenshot('custom.png', { maxDiffPixels: 100 });`;

      const result = TestPostProcessor.normalizeScreenshotOptions(code, 0.2, 0.05, false);
      // The pattern only matches bare calls (no second argument), so this should be unchanged
      expect(result).toBe(code);
    });

    it('handles double-quoted screenshot names', () => {
      const code = `await expect(page).toHaveScreenshot("page.png");`;

      const result = TestPostProcessor.normalizeScreenshotOptions(code, 0.2, 0.05, true);
      expect(result).toContain('fullPage: true');
    });
  });
});
