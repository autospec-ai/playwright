import * as path from 'path';
import { ExtractedFixture, GeneratedTest } from '../types';

/**
 * Extracts inline page.route() mocks from tests into shared fixture files
 * when the number of route blocks exceeds a configurable threshold.
 */
export class FixtureExtractor {
  /**
   * For each test, count page.route() blocks. If count > threshold,
   * extract route mock bodies into a fixtures file with a setupApiMocks(page) function,
   * and rewrite the test to import and call it.
   */
  static extractFixtures(
    tests: GeneratedTest[],
    threshold: number,
    testDirectory: string
  ): ExtractedFixture[] {
    const fixtures: ExtractedFixture[] = [];

    for (const test of tests) {
      const routeBlocks = FixtureExtractor.findRouteBlocks(test.content);

      if (routeBlocks.length <= threshold) {
        continue;
      }

      // Build fixture file content
      const fixtureName = test.filename.replace(/\.spec\.ts$/, '.fixtures.ts');
      const fixtureDir = path.join(testDirectory, 'fixtures');
      const fixturePath = path.join(fixtureDir, fixtureName);

      const routeCode = routeBlocks
        .map(block => `  ${block.trim()}`)
        .join('\n\n');

      const fixtureContent = [
        "import { Page } from '@playwright/test';",
        '',
        `/**`,
        ` * Auto-extracted API mocks from ${test.filename}`,
        ` */`,
        `export async function setupApiMocks(page: Page): Promise<void> {`,
        routeCode,
        `}`,
        '',
      ].join('\n');

      fixtures.push({
        filepath: fixturePath,
        content: fixtureContent,
        sourceTestFile: test.filepath,
      });

      // Rewrite the test: remove inline route blocks and add import + call
      let rewrittenContent = test.content;

      // Remove the extracted route blocks from the test
      for (const block of routeBlocks) {
        rewrittenContent = rewrittenContent.replace(block, '');
      }

      // Clean up empty lines left behind
      rewrittenContent = rewrittenContent.replace(/\n{3,}/g, '\n\n');

      // Compute relative import path from test file to fixture
      const testDir = path.dirname(test.filepath);
      let relativePath = path.relative(testDir, fixturePath).replace(/\.ts$/, '');
      if (!relativePath.startsWith('.')) {
        relativePath = './' + relativePath;
      }

      // Add fixture import after existing imports
      const importLine = `import { setupApiMocks } from '${relativePath}';`;

      const lines = rewrittenContent.split('\n');
      let lastImportIndex = -1;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].trimStart().startsWith('import ')) {
          lastImportIndex = i;
        }
      }

      if (lastImportIndex >= 0) {
        lines.splice(lastImportIndex + 1, 0, importLine);
      } else {
        lines.unshift(importLine);
      }

      rewrittenContent = lines.join('\n');

      // Add setupApiMocks(page) call inside test.beforeEach if it exists,
      // otherwise add it before the first test() call
      if (rewrittenContent.includes('test.beforeEach')) {
        rewrittenContent = rewrittenContent.replace(
          /(test\.beforeEach\(\s*async\s*\(\s*\{[^}]*\}\s*\)\s*=>\s*\{)/,
          '$1\n    await setupApiMocks(page);'
        );
      } else {
        // Add before first test() block
        rewrittenContent = rewrittenContent.replace(
          /(^\s*test\()/m,
          '  test.beforeEach(async ({ page }) => {\n    await setupApiMocks(page);\n  });\n\n$1'
        );
      }

      // Update the test content in-place
      test.content = rewrittenContent;
    }

    return fixtures;
  }

  /**
   * Find `await page.route(...)` blocks using brace-depth counting.
   * Returns the full text of each route block.
   */
  static findRouteBlocks(code: string): string[] {
    const blocks: string[] = [];
    const routePattern = /await\s+page\.route\s*\(/g;
    let match: RegExpExecArray | null;

    while ((match = routePattern.exec(code)) !== null) {
      const startIndex = match.index;
      let depth = 0;
      let foundFirstParen = false;
      let endIndex = startIndex;

      for (let i = match.index + match[0].length - 1; i < code.length; i++) {
        const char = code[i];
        if (char === '(') {
          depth++;
          foundFirstParen = true;
        } else if (char === ')') {
          depth--;
          if (foundFirstParen && depth === 0) {
            // Include trailing semicolon if present
            endIndex = i + 1;
            if (code[endIndex] === ';') {
              endIndex++;
            }
            break;
          }
        }
      }

      if (endIndex > startIndex) {
        blocks.push(code.slice(startIndex, endIndex));
      }
    }

    return blocks;
  }
}
