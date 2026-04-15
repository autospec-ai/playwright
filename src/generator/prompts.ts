import * as path from 'path';
import { ActionConfig, DiffResult, ExistingTest, FileDiff, ProjectContext, TestPlan, TestPlanEntry } from '../types';

/**
 * Builds structured prompts for two-phase test generation:
 *   Phase 1: Analyze diff → produce a test plan (JSON)
 *   Phase 2: For each planned test → generate Playwright code
 */
export class PromptBuilder {
  private config: ActionConfig;
  private projectContext?: ProjectContext;

  constructor(config: ActionConfig) {
    this.config = config;
  }

  setProjectContext(ctx: ProjectContext): void {
    this.projectContext = ctx;
  }

  /** Returns true when the scanner discovered page objects or utilities. */
  private hasProjectArtifacts(): boolean {
    return !!this.projectContext && (
      this.projectContext.pageObjects.length > 0 ||
      this.projectContext.utilities.length > 0
    );
  }

  // ─── Phase 1: Test Planning ───

  buildPlanPrompt(diff: DiffResult, existingTests: ExistingTest[]): string {
    const existingTestList = existingTests
      .map(t => `  - ${t.filepath}`)
      .join('\n');

    const fileChangeSummary = diff.files
      .map(f => this.summarizeFile(f))
      .join('\n\n');

    const fullSourceContext = diff.files
      .filter(f => f.fullContent)
      .map(f => this.formatFullSource(f))
      .join('\n\n');

    return `You are an expert QA automation engineer. Analyze the following code changes and produce a test plan.

## Context
- Framework: ${this.config.framework}
- Base URL: ${this.config.baseUrl}
- Test directory: ${this.config.testDirectory}
- Test patterns: ${this.config.testPatterns.join(', ')}
- Max tests to generate: ${this.config.maxTestFiles}

## Existing Tests
${existingTestList || '(none found)'}

## Code Changes
${diff.summary}

${fileChangeSummary}

${fullSourceContext ? `## Full Source Files (for context)\nThe complete source of each changed file, so you can understand imports, component structure, routing, and how the changes fit into the broader codebase.\n\n${fullSourceContext}` : ''}
${this.buildProjectContextForPlan()}
## Instructions
1. Analyze what user-facing behavior changed or was added.
2. Identify the E2E test scenarios that would validate these changes.
3. Skip changes that are purely internal/backend with no UI impact, unless they affect API responses rendered in the UI.
4. Prioritize: new features > modified flows > edge cases.
5. Don't duplicate coverage already in existing tests unless the behavior changed.
${this.hasProjectArtifacts() ? `6. MUST reuse existing page objects and their locators listed above rather than inventing new ones.
7. MUST use existing utility functions where applicable.
8. Do NOT generate tests for user flows already covered in existing test coverage unless the behavior changed in this diff.
9.` : `6. Do NOT generate tests for user flows already covered in existing test coverage unless the behavior changed in this diff.
7.`} Assign a severity to each test based on the user impact of what it validates:
   - sev1 (Critical): Core user flows — authentication, checkout, data loss prevention, payment processing
   - sev2 (High): Important features, commonly used paths, key business logic
   - sev3 (Medium): Secondary features, less frequent user flows, settings pages
   - sev4 (Low): Edge cases, cosmetic issues, rarely used features
${this.config.customInstructions ? `\n## Additional Instructions\n${this.config.customInstructions}` : ''}
${this.config.generateApiMocks ? `
## API Dependency Detection
For each test, also detect external API dependencies in the changed code:
- Look for fetch(), axios, useSWR, useQuery, WebSocket, or similar HTTP/WS patterns
- Identify the URL patterns, HTTP methods, and what data shapes they return
- Include an "apiDependencies" array for each test entry (can be empty if none detected)
` : ''}
## Response Format
Respond with ONLY valid JSON (no markdown fences):
{
  "reasoning": "Brief explanation of your analysis",
  "tests": [
    {
      "targetFile": "src/components/Login.tsx",
      "testFilename": "login-flow.spec.ts",
      "description": "Validates the new OAuth login flow",
      "userFlows": [
        "User clicks 'Sign in with Google' button",
        "User sees loading state during OAuth redirect",
        "User lands on dashboard after successful auth"
      ],
      "priority": "high",
      "severity": "sev1"${this.config.generateApiMocks ? `,
      "apiDependencies": [
        {
          "url": "/api/auth/google",
          "method": "POST",
          "description": "Google OAuth callback",
          "responseShape": "{ token: string, user: { id, name, email } }",
          "isWebSocket": false
        }
      ]` : ''}
    }
  ]
}

If no tests are needed (e.g., only config/docs changed), return:
{
  "reasoning": "Explanation of why no tests are needed",
  "tests": []
}`;
  }

  // ─── Phase 2: Test Code Generation ───

  buildTestPrompt(
    plan: TestPlan['tests'][number],
    diff: DiffResult,
    existingTests: ExistingTest[],
    styleReference?: string
  ): string {
    // Find the specific diff for the target file
    const targetDiff = diff.files.find(f => f.filename === plan.targetFile);

    // Get related file diffs (same directory or imports)
    const relatedDiffs = diff.files
      .filter(f => f.filename !== plan.targetFile)
      .filter(f => this.isRelated(f.filename, plan.targetFile))
      .slice(0, 3);

    // Full source context for the target file and related files
    const targetFullSource = targetDiff?.fullContent
      ? `## Full Source: ${targetDiff.filename}\nThe complete file so you can see imports, component structure, routes, state, and how the diff fits in.\n\`\`\`typescript\n${targetDiff.fullContent}\n\`\`\``
      : '';

    const relatedFullSources = relatedDiffs
      .filter(d => d.fullContent)
      .map(d => this.formatFullSource(d))
      .join('\n\n');

    return `You are an expert Playwright test author. Generate a production-quality E2E test file.

## Test Specification
- Test file: ${this.config.testDirectory}/${plan.testFilename}
- Description: ${plan.description}
- Severity: ${plan.severity}
- Base URL: ${this.config.baseUrl}
- Framework: ${this.config.framework}

## User Flows to Test
${plan.userFlows.map((f, i) => `${i + 1}. ${f}`).join('\n')}

${targetFullSource}

## Source Code Changes (diff)
${targetDiff ? this.formatDiff(targetDiff) : '(target file diff not available)'}

${relatedDiffs.length > 0 ? '## Related Changes\n' + relatedDiffs.map(d => this.formatDiff(d)).join('\n\n') : ''}

${relatedFullSources ? `## Related Full Sources\n${relatedFullSources}` : ''}

${styleReference ? `## Style Reference (match this pattern)\n\`\`\`typescript\n${styleReference}\n\`\`\`` : ''}
${this.buildProjectContextForTest(plan.testFilename)}
## Requirements
1. Use Playwright test runner with TypeScript.
2. Import from '@playwright/test' (test, expect, Page).
3. Use test.describe() blocks to group related tests.
4. Use descriptive test names that explain the expected behavior.
${this.hasProjectArtifacts() ? `5. Use the page objects and utilities listed above. Do NOT create inline locators for elements that already have locators in page objects. Do NOT invent page objects or utility functions that are not listed.` : `5. Use accessible selectors (role, label, text) or data-testid attributes for locators.`}
6. Add meaningful assertions — not just "page loads".
7. Use data-testid selectors when inferrable, otherwise use accessible selectors (role, label, text).
8. Handle async operations with proper waitFor / expect patterns.
9. Include setup (test.beforeEach for navigation) and teardown if needed.
10. Add JSDoc comment at the top explaining what this test covers.
11. Tag the test.describe() block with the severity level using Playwright's tag syntax: test.describe('Description', { tag: ['@${plan.severity}'] }, () => { ... })
${this.buildApiMockSection(plan)}${this.buildVisualRegressionSection()}${this.buildAccessibilitySection()}${this.config.customInstructions ? `\n## Additional Instructions\n${this.config.customInstructions}` : ''}

## Response Format
Respond with ONLY the TypeScript test file content. No markdown fences, no explanation — just the code.`;
  }

  // ─── Feature Prompt Sections ───

  private buildApiMockSection(plan: TestPlanEntry): string {
    if (!this.config.generateApiMocks || !plan.apiDependencies?.length) {
      return '';
    }

    const endpoints = plan.apiDependencies
      .map(dep => `  - ${dep.method} ${dep.url} — ${dep.description}${dep.isWebSocket ? ' (WebSocket)' : ''}`)
      .join('\n');

    return `
## API Mocking Requirements
The following API endpoints were detected in the source code. Generate \`page.route()\` mocks for each:
${endpoints}

Guidelines:
- Use glob URL patterns (e.g., \`**/api/users*\`) for flexibility.
- Return realistic mock data matching the expected response shapes.
- Include proper Content-Type headers in route handlers.
${this.config.mockErrorStates ? `- Generate ADDITIONAL test cases that simulate error responses (4xx/5xx) for each endpoint.
- Test that the UI handles loading, error, and empty states gracefully.` : ''}
`;
  }

  private buildVisualRegressionSection(): string {
    if (!this.config.visualRegression) {
      return '';
    }

    return `
## Visual Regression Requirements
Add \`toHaveScreenshot()\` assertions at key visual checkpoints:
- After the page finishes loading (wait for network idle or key element).
- After significant UI state changes (e.g., modal open, form submission).
- Use descriptive screenshot names like \`'dashboard-loaded.png'\`.
- Mask dynamic content (timestamps, avatars, ads) using \`mask: [locator]\` option.
- Use threshold: ${this.config.visualThreshold}, maxDiffPixelRatio: ${this.config.visualMaxDiffRatio}, fullPage: ${this.config.visualFullPage}.
`;
  }

  private buildAccessibilitySection(): string {
    if (!this.config.accessibilityAssertions && !this.config.axeScan) {
      return '';
    }

    let section = '';

    if (this.config.accessibilityAssertions) {
      section += `
## Aria Snapshot Assertions
Add \`toMatchAriaSnapshot()\` assertions for the primary component being tested:
- Use scoped locators (e.g., \`page.getByRole('main')\` or specific component containers).
- Capture the aria snapshot after the component is fully rendered.
- This validates the accessibility tree structure hasn't regressed.
`;
    }

    if (this.config.axeScan) {
      section += `
## Axe Accessibility Scan
Generate a SEPARATE test case that runs an axe-core accessibility scan:
- Import AxeBuilder from '@axe-core/playwright'.
- Create a test named 'should have no accessibility violations'.
- Use: const results = await new AxeBuilder({ page }).withTags(['${this.config.axeStandard}']).analyze();
- Assert: expect(results.violations).toEqual([]);
- Scope the scan to the main content area when possible.
`;
    }

    return section;
  }

  // ─── Project Context Sections ───

  private buildProjectContextForPlan(): string {
    if (!this.projectContext) return '';

    const sections: string[] = [];

    // Page objects catalog
    if (this.projectContext.pageObjects.length > 0) {
      const items = this.projectContext.pageObjects.map(po => {
        const methods = po.exportedMethods.length > 0
          ? `: ${po.exportedMethods.join(', ')}`
          : '';
        const locatorNames = po.locators.map(l => l.name);
        const locators = locatorNames.length > 0
          ? ` | Locators: ${locatorNames.join(', ')}`
          : '';
        const routes = po.routes.length > 0
          ? ` | Routes: ${po.routes.join(', ')}`
          : '';
        return `- ${po.className} (${po.filepath})${methods}${locators}${routes}`;
      }).join('\n');

      sections.push(`## Available Page Objects
The project already has these page object classes. REUSE them — do not invent new ones.
${items}`);
    }

    // Utilities catalog
    if (this.projectContext.utilities.length > 0) {
      const items = this.projectContext.utilities.map(u => {
        const fns = u.exportedFunctions.length > 0
          ? u.exportedFunctions.join(', ')
          : '';
        return `- ${u.filepath}: ${fns}`;
      }).join('\n');

      sections.push(`## Available Utilities
These helper functions exist in the project. Use them instead of writing inline equivalents.
${items}`);
    }

    // Coverage summary
    if (this.projectContext.coverage.length > 0) {
      const allRoutes = [...new Set(this.projectContext.coverage.flatMap(c => c.routes))];
      const allFlows = [...new Set(this.projectContext.coverage.flatMap(c => c.describedFlows))];

      const parts: string[] = [];
      if (allRoutes.length > 0) {
        parts.push(`Already tested routes: ${allRoutes.join(', ')}`);
      }
      if (allFlows.length > 0) {
        parts.push(`Already tested flows: ${allFlows.join(', ')}`);
      }

      if (parts.length > 0) {
        sections.push(`## Existing Test Coverage
${parts.join('\n')}`);
      }
    }

    return sections.length > 0 ? '\n' + sections.join('\n\n') + '\n' : '';
  }

  private buildProjectContextForTest(testFilename: string): string {
    if (!this.projectContext) return '';

    const sections: string[] = [];
    const testOutputPath = path.join(this.config.testDirectory, testFilename);
    const testDir = path.dirname(testOutputPath);

    // Page objects with import paths
    if (this.projectContext.pageObjects.length > 0) {
      const items = this.projectContext.pageObjects.map(po => {
        const relativePath = this.computeImportPath(testDir, po.filepath);
        const methodList = po.exportedMethods.length > 0
          ? `Methods: ${po.exportedMethods.join(', ')}`
          : '';
        const locatorList = po.locators.length > 0
          ? `Locators: ${po.locators.map(l => `${l.name} = ${l.selector}`).join(', ')}`
          : '';
        const routeList = po.routes.length > 0
          ? `Navigation routes: ${po.routes.join(', ')}`
          : '';
        const details = [methodList, locatorList, routeList].filter(Boolean).join('\n');
        return `### ${po.className} (from '${relativePath}')
${details}`;
      }).join('\n\n');

      sections.push(`## Page Objects Available for Import
${items}`);
    }

    // Utilities with import paths
    if (this.projectContext.utilities.length > 0) {
      const items = this.projectContext.utilities.map(u => {
        const relativePath = this.computeImportPath(testDir, u.filepath);
        const fns = u.exportedFunctions.join(', ');
        return `- import { ${fns} } from '${relativePath}'`;
      }).join('\n');

      sections.push(`## Utility Functions Available
${items}`);
    }

    if (sections.length > 0) {
      sections.push(`## IMPORTANT
- Use the page objects and utilities listed above. Do NOT create inline locators for elements that already have locators in page objects.
- Do NOT invent page objects, locators, or utility functions that are not listed above.
- Import paths above are relative from the test file location.`);
    }

    return sections.length > 0 ? '\n' + sections.join('\n\n') + '\n' : '';
  }

  private computeImportPath(fromDir: string, toFilepath: string): string {
    const withoutExt = toFilepath.replace(/\.\w+$/, '');
    let rel = path.relative(fromDir, withoutExt);
    if (!rel.startsWith('.')) {
      rel = './' + rel;
    }
    return rel;
  }

  // ─── Helpers ───

  private formatFullSource(file: FileDiff): string {
    return `### ${file.filename} (full source)
\`\`\`typescript
${file.fullContent}
\`\`\``;
  }

  private summarizeFile(file: FileDiff): string {
    const maxPatchLines = 80;
    const patchLines = file.patch.split('\n');
    const truncated = patchLines.length > maxPatchLines;
    const patch = truncated
      ? patchLines.slice(0, maxPatchLines).join('\n') + '\n... (truncated)'
      : file.patch;

    return `### ${file.status.toUpperCase()}: ${file.filename} (+${file.additions}/-${file.deletions})
\`\`\`diff
${patch}
\`\`\``;
  }

  private formatDiff(file: FileDiff): string {
    const maxLines = 60;
    const lines = file.patch.split('\n');
    const patch = lines.length > maxLines
      ? lines.slice(0, maxLines).join('\n') + '\n... (truncated)'
      : file.patch;

    return `### ${file.filename} (${file.status})
\`\`\`diff
${patch}
\`\`\``;
  }

  private isRelated(filename: string, targetFile: string): boolean {
    // Same directory
    const dirA = filename.split('/').slice(0, -1).join('/');
    const dirB = targetFile.split('/').slice(0, -1).join('/');
    if (dirA === dirB) return true;

    // Shared path prefix (at least 2 segments)
    const partsA = filename.split('/');
    const partsB = targetFile.split('/');
    let shared = 0;
    for (let i = 0; i < Math.min(partsA.length, partsB.length); i++) {
      if (partsA[i] === partsB[i]) shared++;
      else break;
    }
    return shared >= 2;
  }
}
