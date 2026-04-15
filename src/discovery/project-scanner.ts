import * as core from '@actions/core';
import * as fs from 'fs';
import * as path from 'path';
import { glob } from 'glob';
import {
  ActionConfig,
  DiffResult,
  LocatorInfo,
  PageObjectInfo,
  ProjectContext,
  TestCoverageInfo,
  UtilityInfo,
} from '../types';

// Default patterns when user provides none
const DEFAULT_POM_PATTERNS = [
  '**/*.page.ts',
  '**/pages/**/*.ts',
  '**/page-objects/**/*.ts',
  '**/page-object/**/*.ts',
  '**/*.pom.ts',
  '**/pom/**/*.ts',
];

const DEFAULT_UTILITY_PATTERNS = [
  '**/helpers/**/*.ts',
  '**/utils/**/*.ts',
  '**/fixtures/**/*.ts',
  '**/support/**/*.ts',
  '**/*.helper.ts',
  '**/*.util.ts',
];

const GLOBAL_IGNORE = ['**/node_modules/**', '**/dist/**', '**/.git/**', '**/*.d.ts', '**/*.min.*'];

const MAX_FILE_SIZE = 30_000; // 30KB per file, matching existing convention

export class ProjectScanner {
  private config: ActionConfig;

  constructor(config: ActionConfig) {
    this.config = config;
  }

  async scan(diff: DiffResult): Promise<ProjectContext> {
    core.info('Scanning project structure for page objects, utilities, and test coverage...');

    const [pageObjects, utilities, coverage] = await Promise.all([
      this.discoverPageObjects(),
      this.discoverUtilities(),
      this.analyzeTestCoverage(),
    ]);

    core.info(`Discovered: ${pageObjects.length} page objects, ${utilities.length} utility files, ${coverage.length} tested files`);

    // Score by relevance to the current diff and trim to budget
    const scored = this.applyRelevanceAndBudget(pageObjects, utilities, coverage, diff);

    return scored;
  }

  // ─── Page Object Discovery ───

  private async discoverPageObjects(): Promise<PageObjectInfo[]> {
    const patterns = this.config.pomPatterns.length > 0
      ? this.config.pomPatterns
      : DEFAULT_POM_PATTERNS;

    const files = await this.globFiles(patterns);
    const results: PageObjectInfo[] = [];

    for (const filepath of files) {
      const content = this.readFileSafe(filepath);
      if (!content) continue;

      const info = this.extractPageObject(filepath, content);
      if (info) results.push(info);
    }

    return results;
  }

  private extractPageObject(filepath: string, content: string): PageObjectInfo | null {
    // Extract class name
    const classMatch = content.match(/export\s+(?:default\s+)?class\s+(\w+)/);
    if (!classMatch) return null;

    const className = classMatch[1];
    const rel = path.relative(process.cwd(), filepath);

    // Extract method signatures (public methods in the class)
    const methods: string[] = [];
    const seen = new Set<string>();

    // Standard methods: async methodName(params) { ... }
    const methodRegex = /(?:async\s+)?(\w+)\s*\(([^)]*)\)\s*(?::\s*[^{]+?)?\s*\{/g;
    let match;
    while ((match = methodRegex.exec(content)) !== null) {
      const name = match[1];
      const params = match[2].trim();
      // Skip constructor and private-looking methods
      if (name === 'constructor' || name.startsWith('_')) continue;
      if (seen.has(name)) continue;
      seen.add(name);
      methods.push(params ? `${name}(${params})` : `${name}()`);
    }

    // Static properties/methods: static propName = value or static methodName()
    const staticRegex = /static\s+(?:readonly\s+)?(\w+)\s*[=:]/g;
    while ((match = staticRegex.exec(content)) !== null) {
      const name = match[1];
      if (!seen.has(name)) {
        seen.add(name);
        methods.push(`static ${name}`);
      }
    }

    // Extract locator definitions
    const locators = this.extractLocators(rel, content);

    // Extract navigation routes from goto/navigate methods
    const routes = this.extractRoutes(content);

    return { filepath: rel, className, exportedMethods: methods, locators, routes };
  }

  private extractRoutes(content: string): string[] {
    const routes: string[] = [];
    const seen = new Set<string>();

    // Pattern: this.page.goto('...') or page.goto('...')
    const gotoRegex = /(?:this\.page|page)\.goto\s*\(\s*['"`]([^'"`$]+)['"`]/g;
    let match;
    while ((match = gotoRegex.exec(content)) !== null) {
      const route = match[1];
      if (!seen.has(route)) {
        seen.add(route);
        routes.push(route);
      }
    }

    // Pattern: this.page.goto(path ?? '/default') — extract the default
    const defaultGotoRegex = /(?:this\.page|page)\.goto\s*\(\s*\w+\s*\?\?\s*['"`]([^'"`]+)['"`]/g;
    while ((match = defaultGotoRegex.exec(content)) !== null) {
      const route = match[1];
      if (!seen.has(route)) {
        seen.add(route);
        routes.push(route);
      }
    }

    return routes;
  }

  private extractLocators(filepath: string, content: string): LocatorInfo[] {
    const locators: LocatorInfo[] = [];

    // Pattern: this.someLocator = page.getByRole/getByText/getByTestId/locator(...)
    const assignmentRegex = /(?:this\.)?(\w+)\s*=\s*((?:page|this\.page)\.(getBy\w+|locator)\s*\([^)]+\))/g;
    let match;
    while ((match = assignmentRegex.exec(content)) !== null) {
      locators.push({ name: match[1], selector: match[2], source: filepath });
    }

    // Pattern: get someLocator() { return this.page.getByRole(...) }
    const getterRegex = /get\s+(\w+)\s*\(\)\s*\{[^}]*return\s+((?:this\.page|page)\.(getBy\w+|locator)\s*\([^)]+\))/g;
    while ((match = getterRegex.exec(content)) !== null) {
      locators.push({ name: match[1], selector: match[2], source: filepath });
    }

    // Pattern: readonly someLocator = this.page.getByRole(...)
    const readonlyRegex = /(?:readonly\s+)(\w+)\s*=\s*((?:this\.page|page)\.(getBy\w+|locator)\s*\([^)]+\))/g;
    while ((match = readonlyRegex.exec(content)) !== null) {
      locators.push({ name: match[1], selector: match[2], source: filepath });
    }

    // Pattern: arrow function in object literal — getName: (): Locator => this.page.getByTestId(...)
    // Also matches with parameters: getByName: (name: string): Locator => this.page.locator(...)
    // This is a common POM pattern where elements are organized as object properties.
    const arrowRegex = /(\w+)\s*:\s*\([^)]*\)\s*(?::\s*\w+)?\s*=>\s*((?:this\.page|page)\.(getBy\w+|locator)\s*\([^)]+\))/g;
    while ((match = arrowRegex.exec(content)) !== null) {
      const name = match[1];
      // Skip duplicates — earlier patterns may have caught some of these
      if (!locators.some(l => l.name === name)) {
        locators.push({ name, selector: match[2], source: filepath });
      }
    }

    return locators;
  }

  // ─── Utility Discovery ───

  private async discoverUtilities(): Promise<UtilityInfo[]> {
    const patterns = this.config.utilityPatterns.length > 0
      ? this.config.utilityPatterns
      : DEFAULT_UTILITY_PATTERNS;

    const files = await this.globFiles(patterns);
    const results: UtilityInfo[] = [];

    for (const filepath of files) {
      const content = this.readFileSafe(filepath);
      if (!content) continue;

      const info = this.extractUtility(filepath, content);
      if (info) results.push(info);
    }

    return results;
  }

  private extractUtility(filepath: string, content: string): UtilityInfo | null {
    const rel = path.relative(process.cwd(), filepath);
    const functions: string[] = [];
    const constants: string[] = [];

    // Exported functions
    const fnRegex = /export\s+(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/g;
    let match;
    while ((match = fnRegex.exec(content)) !== null) {
      const name = match[1];
      const params = match[2].trim();
      functions.push(params ? `${name}(${params})` : `${name}()`);
    }

    // Exported arrow functions: export const foo = async (params) => ...
    const arrowRegex = /export\s+const\s+(\w+)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*(?::\s*[^=]+?)?\s*=>/g;
    while ((match = arrowRegex.exec(content)) !== null) {
      const name = match[1];
      const params = match[2].trim();
      functions.push(params ? `${name}(${params})` : `${name}()`);
    }

    // Exported constants (non-function)
    const constRegex = /export\s+const\s+(\w+)\s*(?::\s*[^=]+?)?\s*=\s*(?!(?:async\s*)?\()/g;
    while ((match = constRegex.exec(content)) !== null) {
      constants.push(match[1]);
    }

    if (functions.length === 0 && constants.length === 0) return null;

    return { filepath: rel, exportedFunctions: functions, exportedConstants: constants };
  }

  // ─── Test Coverage Analysis ───

  private async analyzeTestCoverage(): Promise<TestCoverageInfo[]> {
    const results: TestCoverageInfo[] = [];
    const seen = new Set<string>();

    for (const pattern of this.config.testPatterns) {
      const matches = await glob(pattern, { absolute: true, ignore: GLOBAL_IGNORE });
      for (const filepath of matches) {
        if (results.length >= 50) break;
        const rel = path.relative(process.cwd(), filepath);
        if (seen.has(rel)) continue;
        seen.add(rel);

        const content = this.readFileSafe(filepath);
        if (!content) continue;

        const info = this.extractCoverage(rel, content);
        if (info) results.push(info);
      }
      if (results.length >= 50) break;
    }

    return results;
  }

  private extractCoverage(filepath: string, content: string): TestCoverageInfo | null {
    const routes: string[] = [];
    const importedPageObjects: string[] = [];
    const describedFlows: string[] = [];
    const testNames: string[] = [];

    // Routes: page.goto('...') or page.navigate('...')
    const routeRegex = /(?:page\.goto|page\.navigate)\s*\(\s*['"`]([^'"`]+)/g;
    let match;
    while ((match = routeRegex.exec(content)) !== null) {
      routes.push(match[1]);
    }

    // Imported page objects: import { LoginPage } from '...'
    const importRegex = /import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g;
    while ((match = importRegex.exec(content)) !== null) {
      const importPath = match[2];
      // Heuristic: if the import path contains 'page', 'pom', or 'object', it's likely a POM import
      if (/page|pom|object/i.test(importPath)) {
        const names = match[1].split(',').map(s => s.trim()).filter(Boolean);
        importedPageObjects.push(...names);
      }
    }

    // test.describe names
    const describeRegex = /test\.describe\s*\(\s*['"`]([^'"`]+)/g;
    while ((match = describeRegex.exec(content)) !== null) {
      describedFlows.push(match[1]);
    }

    // test() names
    const testRegex = /\btest\s*\(\s*['"`]([^'"`]+)/g;
    while ((match = testRegex.exec(content)) !== null) {
      testNames.push(match[1]);
    }

    if (routes.length === 0 && testNames.length === 0) return null;

    return { filepath, routes, importedPageObjects, describedFlows, testNames };
  }

  // ─── Relevance Scoring & Token Budget ───

  private applyRelevanceAndBudget(
    pageObjects: PageObjectInfo[],
    utilities: UtilityInfo[],
    coverage: TestCoverageInfo[],
    diff: DiffResult
  ): ProjectContext {
    const budget = this.config.projectContextBudget;
    const pomBudget = Math.floor(budget * 0.5);
    const utilBudget = Math.floor(budget * 0.2);
    const coverageBudget = Math.floor(budget * 0.3);

    // Score and sort page objects
    const scoredPom = pageObjects
      .map(po => ({ item: po, score: this.scoreRelevance(po.filepath, po.className, diff) }))
      .sort((a, b) => b.score - a.score);

    // Score and sort utilities
    const scoredUtil = utilities
      .map(u => ({ item: u, score: this.scoreRelevance(u.filepath, null, diff) }))
      .sort((a, b) => b.score - a.score);

    // Trim to budget
    const trimmedPom = this.trimToTokenBudget(
      scoredPom.map(s => s.item),
      pomBudget,
      (po) => this.estimatePageObjectTokens(po)
    );

    const trimmedUtil = this.trimToTokenBudget(
      scoredUtil.map(s => s.item),
      utilBudget,
      (u) => this.estimateUtilityTokens(u)
    );

    const trimmedCoverage = this.trimToTokenBudget(
      coverage,
      coverageBudget,
      (c) => this.estimateCoverageTokens(c)
    );

    return {
      pageObjects: trimmedPom,
      utilities: trimmedUtil,
      coverage: trimmedCoverage,
    };
  }

  private scoreRelevance(filepath: string, className: string | null, diff: DiffResult): number {
    let score = 1; // base score

    const changedFiles = diff.files;
    const fileDir = path.dirname(filepath);

    for (const changed of changedFiles) {
      // Check if any changed file imports this file
      if (changed.fullContent && this.contentReferencesFile(changed.fullContent, filepath)) {
        score += 10;
      }

      // Same directory
      if (path.dirname(changed.filename) === fileDir) {
        score += 5;
      }

      // Class/function name appears in changed file content
      if (className && changed.fullContent && changed.fullContent.includes(className)) {
        score += 3;
      }
    }

    return score;
  }

  private contentReferencesFile(content: string, filepath: string): boolean {
    // Check if the content imports from this filepath (with or without extension)
    const withoutExt = filepath.replace(/\.\w+$/, '');
    const basename = path.basename(withoutExt);
    return content.includes(basename);
  }

  private trimToTokenBudget<T>(items: T[], budgetTokens: number, estimator: (item: T) => number): T[] {
    const result: T[] = [];
    let usedTokens = 0;

    for (const item of items) {
      const cost = estimator(item);
      if (usedTokens + cost > budgetTokens) break;
      result.push(item);
      usedTokens += cost;
    }

    return result;
  }

  private estimatePageObjectTokens(po: PageObjectInfo): number {
    let chars = po.filepath.length + po.className.length;
    chars += po.exportedMethods.join(', ').length;
    chars += po.locators.map(l => `${l.name}: ${l.selector}`).join(', ').length;
    chars += po.routes.join(', ').length;
    return Math.ceil(chars / 4);
  }

  private estimateUtilityTokens(u: UtilityInfo): number {
    let chars = u.filepath.length;
    chars += u.exportedFunctions.join(', ').length;
    chars += u.exportedConstants.join(', ').length;
    return Math.ceil(chars / 4);
  }

  private estimateCoverageTokens(c: TestCoverageInfo): number {
    let chars = c.filepath.length;
    chars += c.routes.join(', ').length;
    chars += c.describedFlows.join(', ').length;
    chars += c.testNames.join(', ').length;
    return Math.ceil(chars / 4);
  }

  // ─── File Helpers ───

  private async globFiles(patterns: string[]): Promise<string[]> {
    const seen = new Set<string>();
    const results: string[] = [];

    for (const pattern of patterns) {
      const matches = await glob(pattern, { absolute: true, ignore: GLOBAL_IGNORE });
      for (const filepath of matches) {
        if (!seen.has(filepath)) {
          seen.add(filepath);
          results.push(filepath);
        }
      }
    }

    return results;
  }

  private readFileSafe(filepath: string): string | null {
    try {
      const stat = fs.statSync(filepath);
      if (stat.size > MAX_FILE_SIZE) return null;
      return fs.readFileSync(filepath, 'utf-8');
    } catch {
      return null;
    }
  }
}
