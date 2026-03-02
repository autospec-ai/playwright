import * as core from '@actions/core';
import * as fs from 'fs';
import * as path from 'path';
import { glob } from 'glob';

/**
 * Handles uploading Playwright traces as GitHub Actions artifacts
 * and building failure diagnostics from test results.
 */
export class TraceUploader {
  /**
   * Upload trace/screenshot/video files from test-results as a GitHub Actions artifact.
   * Uses dynamic import of @actions/artifact for graceful degradation.
   */
  static async uploadTraces(testResultsDir: string): Promise<void> {
    try {
      // Dynamic import — graceful degradation if package not available
      // Use variable to prevent ncc from statically resolving the import
      const artifactPkg = '@actions/artifact';
      const { DefaultArtifactClient } = await import(/* webpackIgnore: true */ artifactPkg);
      const artifactClient = new DefaultArtifactClient();

      const patterns = [
        path.join(testResultsDir, '**', 'trace.zip'),
        path.join(testResultsDir, '**', '*.png'),
        path.join(testResultsDir, '**', '*.webm'),
      ];

      const files: string[] = [];
      for (const pattern of patterns) {
        const matches = await glob(pattern, { absolute: true });
        files.push(...matches);
      }

      if (files.length === 0) {
        core.info('No trace files found to upload.');
        return;
      }

      core.info(`Uploading ${files.length} trace file(s) as artifact...`);

      await artifactClient.uploadArtifact(
        'playwright-traces',
        files,
        testResultsDir,
        { retentionDays: 30 }
      );

      core.info(`Uploaded ${files.length} trace file(s) as 'playwright-traces' artifact.`);
    } catch (err) {
      // Graceful degradation — don't fail the action if artifact upload fails
      core.warning(`Trace upload failed (non-fatal): ${err}`);
    }
  }

  /**
   * Scan test-results directories and build a markdown table summarizing
   * which tests have traces, screenshots, and videos available.
   */
  static async buildFailureDiagnostics(testResultsDir: string): Promise<string> {
    if (!fs.existsSync(testResultsDir)) {
      return '';
    }

    const entries = fs.readdirSync(testResultsDir, { withFileTypes: true });
    const testDirs = entries.filter(e => e.isDirectory());

    if (testDirs.length === 0) {
      return '';
    }

    const rows: string[] = [];
    rows.push('| Test | Trace | Screenshot | Video |');
    rows.push('|------|-------|------------|-------|');

    for (const dir of testDirs) {
      const dirPath = path.join(testResultsDir, dir.name);
      const files = fs.readdirSync(dirPath);

      const hasTrace = files.some(f => f === 'trace.zip');
      const hasScreenshot = files.some(f => f.endsWith('.png'));
      const hasVideo = files.some(f => f.endsWith('.webm'));

      const testName = dir.name
        .replace(/-retry\d+$/, '')
        .replace(/-/g, ' ');

      rows.push(
        `| ${testName} | ${hasTrace ? '✅' : '❌'} | ${hasScreenshot ? '✅' : '❌'} | ${hasVideo ? '✅' : '❌'} |`
      );
    }

    return rows.join('\n');
  }
}
