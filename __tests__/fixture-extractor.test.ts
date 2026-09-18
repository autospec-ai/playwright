import { FixtureExtractor } from '../src/utils/fixture-extractor';
import { GeneratedTest } from '../src/types';

function makeTest(content: string, filename = 'example.spec.ts'): GeneratedTest {
  return {
    filename,
    filepath: `e2e/generated/${filename}`,
    content,
    sourceFiles: ['src/app.tsx'],
    description: 'Test description',
    severity: 'sev2',
  };
}

describe('FixtureExtractor', () => {
  describe('findRouteBlocks', () => {
    it('finds simple page.route() blocks', () => {
      const code = `
test('mocked', async ({ page }) => {
  await page.route('**/api/users', async (route) => {
    await route.fulfill({ json: [{ id: 1 }] });
  });
  await page.goto('/');
});`;

      const blocks = FixtureExtractor.findRouteBlocks(code);
      expect(blocks).toHaveLength(1);
      expect(blocks[0]).toContain('page.route');
      expect(blocks[0]).toContain('route.fulfill');
    });

    it('finds multiple route blocks', () => {
      const code = `
test('mocked', async ({ page }) => {
  await page.route('**/api/users', async (route) => {
    await route.fulfill({ json: [] });
  });
  await page.route('**/api/posts', async (route) => {
    await route.fulfill({ json: [] });
  });
  await page.route('**/api/comments', async (route) => {
    await route.fulfill({ json: [] });
  });
  await page.goto('/');
});`;

      const blocks = FixtureExtractor.findRouteBlocks(code);
      expect(blocks).toHaveLength(3);
    });

    it('returns empty array when no route blocks exist', () => {
      const code = `
test('basic', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle('App');
});`;

      const blocks = FixtureExtractor.findRouteBlocks(code);
      expect(blocks).toHaveLength(0);
    });

    it('handles nested parentheses in route handlers', () => {
      const code = `
await page.route('**/api/data', async (route) => {
  const data = JSON.stringify({ items: [{ id: 1, name: 'test' }] });
  await route.fulfill({ body: data, contentType: 'application/json' });
});`;

      const blocks = FixtureExtractor.findRouteBlocks(code);
      expect(blocks).toHaveLength(1);
      expect(blocks[0]).toContain('JSON.stringify');
    });

    it('does not terminate early on parentheses inside strings or comments', () => {
      const code = `
await page.route('**/api/(users)', async (route) => {
  // This closing parenthesis used to confuse the character counter: )
  await route.fulfill({ json: { label: ')' } });
});`;
      const blocks = FixtureExtractor.findRouteBlocks(code);
      expect(blocks).toHaveLength(1);
      expect(blocks[0]).toContain("label: ')' ".trim());
      expect(blocks[0]).toContain('route.fulfill');
    });
  });

  describe('extractFixtures', () => {
    it('does not extract when route count is at or below threshold', () => {
      const code = `import { test } from '@playwright/test';

test('few routes', async ({ page }) => {
  await page.route('**/api/a', async (route) => {
    await route.fulfill({ json: {} });
  });
  await page.route('**/api/b', async (route) => {
    await route.fulfill({ json: {} });
  });
});`;

      const tests = [makeTest(code)];
      const fixtures = FixtureExtractor.extractFixtures(tests, 3, 'e2e/generated');
      expect(fixtures).toHaveLength(0);
    });

    it('extracts fixtures when route count exceeds threshold', () => {
      const code = `import { test, expect } from '@playwright/test';

test('many routes', async ({ page }) => {
  await page.route('**/api/a', async (route) => {
    await route.fulfill({ json: {} });
  });
  await page.route('**/api/b', async (route) => {
    await route.fulfill({ json: {} });
  });
  await page.route('**/api/c', async (route) => {
    await route.fulfill({ json: {} });
  });
  await page.route('**/api/d', async (route) => {
    await route.fulfill({ json: {} });
  });
  await page.goto('/');
});`;

      const tests = [makeTest(code)];
      const fixtures = FixtureExtractor.extractFixtures(tests, 3, 'e2e/generated');
      expect(fixtures).toHaveLength(1);
      expect(fixtures[0].filepath).toContain('fixtures/');
      expect(fixtures[0].filepath).toContain('.fixtures.ts');
      expect(fixtures[0].content).toContain('setupApiMocks');
      expect(fixtures[0].content).toContain("import { Page } from '@playwright/test'");
    });

    it('rewrites test to import and call setupApiMocks', () => {
      const code = `import { test, expect } from '@playwright/test';

test('many routes', async ({ page }) => {
  await page.route('**/api/a', async (route) => {
    await route.fulfill({ json: {} });
  });
  await page.route('**/api/b', async (route) => {
    await route.fulfill({ json: {} });
  });
  await page.route('**/api/c', async (route) => {
    await route.fulfill({ json: {} });
  });
  await page.route('**/api/d', async (route) => {
    await route.fulfill({ json: {} });
  });
  await page.goto('/');
});`;

      const tests = [makeTest(code)];
      FixtureExtractor.extractFixtures(tests, 3, 'e2e/generated');

      // Test content should be rewritten
      expect(tests[0].content).toContain('setupApiMocks');
      expect(tests[0].content).toContain("import { setupApiMocks }");
    });

    it('records sourceTestFile in fixture', () => {
      const code = `import { test } from '@playwright/test';

test('x', async ({ page }) => {
  await page.route('**/a', async (r) => { await r.fulfill({ json: {} }); });
  await page.route('**/b', async (r) => { await r.fulfill({ json: {} }); });
  await page.route('**/c', async (r) => { await r.fulfill({ json: {} }); });
  await page.route('**/d', async (r) => { await r.fulfill({ json: {} }); });
});`;

      const tests = [makeTest(code, 'api-heavy.spec.ts')];
      const fixtures = FixtureExtractor.extractFixtures(tests, 3, 'e2e/generated');
      expect(fixtures[0].sourceTestFile).toBe('e2e/generated/api-heavy.spec.ts');
    });

    it('keeps setup calls in their original test block when another beforeEach lacks page', () => {
      const routes = ['a', 'b', 'c', 'd']
        .map(name => `  await page.route('**/${name}', async (route) => { await route.fulfill({ json: {} }); });`)
        .join('\n');
      const code = `import { test } from '@playwright/test';

test.beforeEach(async ({ context }) => {
  await context.clearCookies();
});

test('routes', async ({ page }) => {
${routes}
});`;
      const tests = [makeTest(code)];
      FixtureExtractor.extractFixtures(tests, 3, 'e2e/generated');

      expect(tests[0].content).toContain("test.beforeEach(async ({ context })");
      expect(tests[0].content).not.toContain('clearCookies();\n    await setupApiMocks(page)');
      expect(tests[0].content).toMatch(/test\('routes'[\s\S]*await setupApiMocks\(page\)/);
    });

    it('skips extraction when a route depends on surrounding local state', () => {
      const code = `import { test } from '@playwright/test';
const sharedResponse = { ok: true };
test('routes', async ({ page }) => {
  await page.route('**/a', async (route) => { await route.fulfill({ json: sharedResponse }); });
  await page.route('**/b', async (route) => { await route.fulfill({ json: sharedResponse }); });
  await page.route('**/c', async (route) => { await route.fulfill({ json: sharedResponse }); });
  await page.route('**/d', async (route) => { await route.fulfill({ json: sharedResponse }); });
});`;
      const tests = [makeTest(code)];
      expect(FixtureExtractor.extractFixtures(tests, 3, 'e2e/generated')).toEqual([]);
      expect(tests[0].content).toBe(code);
    });
  });
});
