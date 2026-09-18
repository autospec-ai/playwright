import * as path from 'path';
import * as ts from 'typescript';
import { ExtractedFixture, GeneratedTest } from '../types';

interface RouteGroup {
  statements: ts.ExpressionStatement[];
  functionName: string;
}

interface TextReplacement {
  start: number;
  end: number;
  text: string;
}

const SAFE_GLOBAL_IDENTIFIERS = new Set([
  'page', 'JSON', 'Date', 'Math', 'Number', 'String', 'Boolean', 'Array',
  'Object', 'RegExp', 'URL', 'URLSearchParams', 'Buffer', 'Promise',
  'undefined', 'NaN', 'Infinity',
]);

/**
 * Extracts self-contained page.route() statements into fixture helpers.
 * TypeScript's parser is used so parentheses in strings, comments, and nested
 * expressions cannot corrupt the generated code.
 */
export class FixtureExtractor {
  static extractFixtures(
    tests: GeneratedTest[],
    threshold: number,
    testDirectory: string
  ): ExtractedFixture[] {
    const fixtures: ExtractedFixture[] = [];

    for (const test of tests) {
      const sourceFile = ts.createSourceFile(
        test.filename,
        test.content,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS
      );
      const groups = FixtureExtractor.findExtractableGroups(sourceFile, threshold);
      if (groups.length === 0) continue;

      const fixtureName = test.filename.replace(/\.spec\.ts$/, '.fixtures.ts');
      const fixturePath = path.join(testDirectory, 'fixtures', fixtureName);
      const fixtureFunctions = groups.map(group => {
        const statements = group.statements
          .map(statement => FixtureExtractor.indent(statement.getText(sourceFile), 2))
          .join('\n');
        return [
          `export async function ${group.functionName}(page: Page): Promise<void> {`,
          statements,
          '}',
        ].join('\n');
      });

      fixtures.push({
        filepath: fixturePath,
        content: [
          "import { Page } from '@playwright/test';",
          '',
          `/** Auto-extracted API mocks from ${test.filename}. */`,
          ...fixtureFunctions.flatMap((fn, index) => index === 0 ? [fn] : ['', fn]),
          '',
        ].join('\n'),
        sourceTestFile: test.filepath,
      });

      const importedNames = groups.map(group => group.functionName);
      const testDir = path.dirname(test.filepath);
      let relativePath = path.relative(testDir, fixturePath).replace(/\.ts$/, '');
      relativePath = relativePath.split(path.sep).join('/');
      if (!relativePath.startsWith('.')) relativePath = './' + relativePath;

      const replacements: TextReplacement[] = [];
      for (const group of groups) {
        group.statements.forEach((statement, index) => {
          replacements.push({
            start: statement.getStart(sourceFile),
            end: statement.getEnd(),
            text: index === 0 ? `await ${group.functionName}(page);` : '',
          });
        });
      }

      const imports = sourceFile.statements.filter(ts.isImportDeclaration);
      const importLine = `import { ${importedNames.join(', ')} } from '${relativePath}';`;
      if (imports.length > 0) {
        const lastImport = imports[imports.length - 1];
        replacements.push({ start: lastImport.getEnd(), end: lastImport.getEnd(), text: `\n${importLine}` });
      } else {
        replacements.push({ start: 0, end: 0, text: `${importLine}\n` });
      }

      test.content = FixtureExtractor.applyReplacements(test.content, replacements)
        .replace(/\n[ \t]*\n[ \t]*\n/g, '\n\n');
    }

    return fixtures;
  }

  static findRouteBlocks(code: string): string[] {
    const sourceFile = ts.createSourceFile(
      'generated.spec.ts', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS
    );
    const blocks: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isExpressionStatement(node) && FixtureExtractor.isPageRouteStatement(node)) {
        blocks.push(node.getText(sourceFile));
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return blocks;
  }

  private static findExtractableGroups(sourceFile: ts.SourceFile, threshold: number): RouteGroup[] {
    const routeGroups: ts.ExpressionStatement[][] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isBlock(node)) {
        const routes = node.statements
          .filter(ts.isExpressionStatement)
          .filter(statement => FixtureExtractor.isPageRouteStatement(statement));
        if (routes.length > threshold && routes.every(route => FixtureExtractor.isSelfContained(route))) {
          routeGroups.push(routes);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);

    return routeGroups.map((statements, index) => ({
      statements,
      functionName: index === 0 ? 'setupApiMocks' : `setupApiMocks${index + 1}`,
    }));
  }

  private static isPageRouteStatement(statement: ts.ExpressionStatement): boolean {
    if (!ts.isAwaitExpression(statement.expression)) return false;
    const call = statement.expression.expression;
    return ts.isCallExpression(call) &&
      ts.isPropertyAccessExpression(call.expression) &&
      ts.isIdentifier(call.expression.expression) &&
      call.expression.expression.text === 'page' &&
      call.expression.name.text === 'route';
  }

  private static isSelfContained(statement: ts.ExpressionStatement): boolean {
    const declared = new Set<string>(SAFE_GLOBAL_IDENTIFIERS);

    const collectBinding = (name: ts.BindingName): void => {
      if (ts.isIdentifier(name)) {
        declared.add(name.text);
      } else {
        for (const element of name.elements) {
          if (!ts.isOmittedExpression(element)) collectBinding(element.name);
        }
      }
    };
    const collectDeclarations = (node: ts.Node): void => {
      if (ts.isParameter(node) || ts.isVariableDeclaration(node)) collectBinding(node.name);
      if (ts.isFunctionDeclaration(node) && node.name) declared.add(node.name.text);
      if (ts.isClassDeclaration(node) && node.name) declared.add(node.name.text);
      ts.forEachChild(node, collectDeclarations);
    };
    collectDeclarations(statement);

    let safe = true;
    const checkReferences = (node: ts.Node): void => {
      if (!safe) return;
      if (ts.isIdentifier(node) && FixtureExtractor.isIdentifierReference(node) && !declared.has(node.text)) {
        safe = false;
      }
      ts.forEachChild(node, checkReferences);
    };
    checkReferences(statement);
    return safe;
  }

  private static isIdentifierReference(node: ts.Identifier): boolean {
    const parent = node.parent;
    if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
    if (ts.isPropertyAssignment(parent) && parent.name === node) return false;
    if (ts.isMethodDeclaration(parent) && parent.name === node) return false;
    if (ts.isParameter(parent) && parent.name === node) return false;
    if (ts.isVariableDeclaration(parent) && parent.name === node) return false;
    if ((ts.isFunctionDeclaration(parent) || ts.isClassDeclaration(parent)) && parent.name === node) return false;
    return true;
  }

  private static indent(value: string, spaces: number): string {
    const prefix = ' '.repeat(spaces);
    return value.split('\n').map(line => prefix + line).join('\n');
  }

  private static applyReplacements(code: string, replacements: TextReplacement[]): string {
    return [...replacements]
      .sort((a, b) => b.start - a.start || b.end - a.end)
      .reduce((result, replacement) => (
        result.slice(0, replacement.start) + replacement.text + result.slice(replacement.end)
      ), code);
  }
}
