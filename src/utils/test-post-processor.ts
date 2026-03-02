import { TraceMode } from '../types';

/**
 * Static utility class for post-processing generated test code.
 * All methods are pure string transforms — no I/O.
 */
export class TestPostProcessor {
  /**
   * Inject Playwright trace/screenshot/video config after imports.
   * Skips if `test.use(` already exists in the code.
   */
  static injectTraceConfig(code: string, traceMode: TraceMode): string {
    if (code.includes('test.use(')) {
      return code;
    }

    const traceValue = traceMode === 'on' ? "'on'" : `'${traceMode}'`;

    const configBlock = [
      '',
      `test.use({`,
      `  trace: ${traceValue},`,
      `  screenshot: 'only-on-failure',`,
      `  video: 'retain-on-failure',`,
      `});`,
      '',
    ].join('\n');

    // Find the end of the import block (last line starting with "import")
    const lines = code.split('\n');
    let lastImportIndex = -1;
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trimStart();
      if (trimmed.startsWith('import ') || trimmed.startsWith('import{')) {
        lastImportIndex = i;
      }
      // Also handle multi-line imports: find closing }
      if (lastImportIndex >= 0 && trimmed.startsWith('}') && lines[lastImportIndex]?.includes('{')) {
        lastImportIndex = i;
      }
    }

    if (lastImportIndex === -1) {
      // No imports found — prepend
      return configBlock + code;
    }

    // Insert after the last import line
    lines.splice(lastImportIndex + 1, 0, configBlock);
    return lines.join('\n');
  }

  /**
   * If code contains `AxeBuilder` but no `@axe-core/playwright` import, inject it.
   */
  static ensureAxeImport(code: string): string {
    if (!code.includes('AxeBuilder')) {
      return code;
    }
    if (code.includes('@axe-core/playwright')) {
      return code;
    }

    // Insert after the @playwright/test import
    const playwrightImportPattern = /^(import\s+.*from\s+['"]@playwright\/test['"];?\s*)$/m;
    const match = code.match(playwrightImportPattern);

    if (match) {
      const insertAfter = match[0];
      return code.replace(
        insertAfter,
        insertAfter + "\nimport AxeBuilder from '@axe-core/playwright';\n"
      );
    }

    // Fallback: prepend
    return "import AxeBuilder from '@axe-core/playwright';\n" + code;
  }

  /**
   * Find bare `toHaveScreenshot('name.png')` calls and add threshold/maxDiffRatio/fullPage options.
   * Transforms: `toHaveScreenshot('name.png')` → `toHaveScreenshot('name.png', { threshold, maxDiffPixelRatio, fullPage })`
   * Skips calls that already have a second options argument.
   */
  static normalizeScreenshotOptions(
    code: string,
    threshold: number,
    maxDiffRatio: number,
    fullPage: boolean
  ): string {
    // Match toHaveScreenshot('...') without a second argument
    // Captures: toHaveScreenshot('some-name.png')
    const pattern = /\.toHaveScreenshot\(\s*(['"][^'"]+['"])\s*\)/g;

    const options = [
      `threshold: ${threshold}`,
      `maxDiffPixelRatio: ${maxDiffRatio}`,
      `fullPage: ${fullPage}`,
    ].join(', ');

    return code.replace(pattern, `.toHaveScreenshot($1, { ${options} })`);
  }
}
