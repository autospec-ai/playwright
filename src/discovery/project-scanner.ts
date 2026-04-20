import * as core from '@actions/core';
import * as fs from 'fs';
import * as path from 'path';
import { glob } from 'glob';
import {
  ActionConfig,
  DiffResult,
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
  '**/*.po.ts',
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

const MAX_FILE_SIZE = 50_000; // 50KB per file

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
    return this.applyRelevanceAndBudget(pageObjects, utilities, coverage, diff);
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

      // Must export a class to be considered a page object
      const classMatch = content.match(/export\s+(?:default\s+)?class\s+(\w+)/);
      if (!classMatch) continue;

      const rel = path.relative(process.cwd(), filepath);
      results.push({ filepath: rel, className: classMatch[1], source: content });
    }

    return results;
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

      // Must have at least one export
      if (!/export\s/.test(content)) continue;

      const rel = path.relative(process.cwd(), filepath);
      results.push({ filepath: rel, source: content });
    }

    return results;
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

    let match;

    // Routes: page.goto('...') or page.navigate('...')
    const routeRegex = /(?:page\.goto|page\.navigate)\s*\(\s*['"`]([^'"`]+)/g;
    while ((match = routeRegex.exec(content)) !== null) {
      routes.push(match[1]);
    }

    // Imported page objects
    const importRegex = /import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g;
    while ((match = importRegex.exec(content)) !== null) {
      const importPath = match[2];
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

    // test() names — captures what's actually being tested
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

    // Score and sort page objects by relevance to the diff
    const scoredPom = pageObjects
      .map(po => ({ item: po, score: this.scoreRelevance(po.filepath, po.className, diff) }))
      .sort((a, b) => b.score - a.score);

    const scoredUtil = utilities
      .map(u => ({ item: u, score: this.scoreRelevance(u.filepath, null, diff) }))
      .sort((a, b) => b.score - a.score);

    // Trim source to fit budget (truncate individual files if needed)
    const trimmedPom = this.trimSourcesToBudget(
      scoredPom.map(s => s.item),
      pomBudget,
    );

    const trimmedUtil = this.trimSourcesToBudget(
      scoredUtil.map(s => s.item),
      utilBudget,
    );

    const trimmedCoverage = this.trimToTokenBudget(
      coverage,
      coverageBudget,
      (c) => this.estimateCoverageTokens(c)
    );

    return { pageObjects: trimmedPom, utilities: trimmedUtil, coverage: trimmedCoverage };
  }

  private scoreRelevance(filepath: string, className: string | null, diff: DiffResult): number {
    let score = 1;
    const fileDir = path.dirname(filepath);

    for (const changed of diff.files) {
      if (changed.fullContent && this.contentReferencesFile(changed.fullContent, filepath)) {
        score += 10;
      }
      if (path.dirname(changed.filename) === fileDir) {
        score += 5;
      }
      if (className && changed.fullContent && changed.fullContent.includes(className)) {
        score += 3;
      }
    }

    return score;
  }

  private contentReferencesFile(content: string, filepath: string): boolean {
    const withoutExt = filepath.replace(/\.\w+$/, '');
    const basename = path.basename(withoutExt);
    return content.includes(basename);
  }

  /**
   * Trim source-carrying items to a token budget.
   * High-relevance items get more space; low-relevance items may be truncated or dropped.
   */
  private trimSourcesToBudget<T extends { source: string }>(items: T[], budgetTokens: number): T[] {
    const result: T[] = [];
    let usedTokens = 0;
    // Per-file cap: no single file takes more than 40% of the category budget
    const perFileCap = Math.floor(budgetTokens * 0.4);

    for (const item of items) {
      let tokens = Math.ceil(item.source.length / 4);

      if (tokens > perFileCap) {
        // Truncate the source to fit the per-file cap
        const maxChars = perFileCap * 4;
        item.source = item.source.slice(0, maxChars) + '\n// ... (truncated)';
        tokens = perFileCap;
      }

      if (usedTokens + tokens > budgetTokens) break;
      result.push(item);
      usedTokens += tokens;
    }

    return result;
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
