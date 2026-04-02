import * as core from '@actions/core';
import * as github from '@actions/github';
import * as exec from '@actions/exec';
import { minimatch } from 'minimatch';
import { DiffMode, DiffResult, FileDiff, ActionConfig } from '../types';

// [FIX #2] SHA validation pattern
const SHA_PATTERN = /^[0-9a-f]{40}$/i;

function validateSha(sha: string, label: string): void {
  if (!SHA_PATTERN.test(sha)) {
    throw new Error(`Invalid ${label} SHA: "${sha}". Expected a 40-character hex string.`);
  }
}

export class DiffAnalyzer {
  private config: ActionConfig;
  private octokit: ReturnType<typeof github.getOctokit> | null = null;

  constructor(config: ActionConfig) {
    this.config = config;
    const token = process.env.GITHUB_TOKEN;
    if (token) {
      this.octokit = github.getOctokit(token);
    }
  }

  async analyze(): Promise<DiffResult> {
    const mode = this.resolveMode();
    core.info(`Diff mode resolved to: ${mode}`);

    let result: DiffResult;

    switch (mode) {
      case 'pr':
        result = await this.analyzePR();
        break;
      case 'push':
        result = await this.analyzePush();
        break;
      default:
        result = await this.analyzePush();
    }

    // Filter files based on include/exclude paths
    result.files = this.filterFiles(result.files);

    // Filter out non-source files (images, lockfiles, etc.)
    result.files = result.files.filter(f => this.isSourceFile(f.filename));

    // Read full file contents at HEAD for non-deleted files
    await this.loadFullContents(result);

    core.info(`Found ${result.files.length} relevant changed files after filtering`);
    return result;
  }

  // ─── Full File Content Loading ───

  private static MAX_FILE_CONTENT_BYTES = 30_000; // ~30KB per file to stay within token budgets

  private async loadFullContents(result: DiffResult): Promise<void> {
    for (const file of result.files) {
      if (file.status === 'deleted') continue;

      try {
        const content = await this.execGit('show', `${result.headSha}:${file.filename}`);
        if (content.length <= DiffAnalyzer.MAX_FILE_CONTENT_BYTES) {
          file.fullContent = content;
        } else {
          file.fullContent = content.slice(0, DiffAnalyzer.MAX_FILE_CONTENT_BYTES) + '\n// ... (truncated)';
        }
      } catch {
        // Binary file or other read failure — skip
        core.debug(`Could not read full content for ${file.filename}`);
      }
    }
  }

  private resolveMode(): DiffMode {
    if (this.config.diffMode !== 'auto') return this.config.diffMode;

    const context = github.context;
    if (context.eventName === 'pull_request' || context.eventName === 'pull_request_target') {
      return 'pr';
    }
    return 'push';
  }

  // ─── PR Diff ───

  private async analyzePR(): Promise<DiffResult> {
    const context = github.context;
    const pr = context.payload.pull_request;

    if (!pr) {
      core.warning('No pull request context found, falling back to push mode');
      return this.analyzePush();
    }

    if (!this.octokit) {
      throw new Error('GITHUB_TOKEN is required for PR diff analysis');
    }

    const { data: files } = await this.octokit.rest.pulls.listFiles({
      owner: context.repo.owner,
      repo: context.repo.repo,
      pull_number: pr.number,
      per_page: 300,
    });

    // [FIX #7] Warn when GitHub API may have truncated results
    if (files.length === 300) {
      core.warning('PR has 300+ changed files; results may be truncated by the GitHub API limit.');
    }

    const diffs: FileDiff[] = files.map(f => ({
      filename: f.filename,
      status: this.mapStatus(f.status),
      patch: f.patch ?? '',
      additions: f.additions,
      deletions: f.deletions,
      previousFilename: f.previous_filename,
    }));

    return {
      files: diffs,
      baseSha: pr.base.sha,
      headSha: pr.head.sha,
      summary: `PR #${pr.number}: ${pr.title}`,
    };
  }

  // ─── Push Diff ───

  private async analyzePush(): Promise<DiffResult> {
    const context = github.context;
    let baseSha = '';
    let headSha = '';

    if (context.payload.before && context.payload.after) {
      baseSha = context.payload.before;
      headSha = context.payload.after;
    } else {
      // Fallback: diff against HEAD~1
      headSha = await this.execGit('rev-parse', 'HEAD');
      baseSha = await this.execGit('rev-parse', 'HEAD~1');
    }

    // [FIX #2] Validate SHA values before using them in git commands
    validateSha(baseSha, 'base');
    validateSha(headSha, 'head');

    // [FIX #6] Use two-dot range for push diffs (direct A..B, not merge-base A...B)
    const diffOutput = await this.execGit(
      'diff',
      '--name-status',
      '--no-renames',
      `${baseSha}..${headSha}`
    );

    const files: FileDiff[] = [];

    for (const line of diffOutput.split('\n').filter(Boolean)) {
      const [statusChar, ...pathParts] = line.split('\t');
      const filename = pathParts.join('\t');
      if (!filename) continue;

      // Get the patch for this specific file
      let patch = '';
      try {
        patch = await this.execGit('diff', `${baseSha}..${headSha}`, '--', filename);
      } catch {
        // File might be binary or deleted
      }

      const additions = (patch.match(/^\+[^+]/gm) || []).length;
      const deletions = (patch.match(/^-[^-]/gm) || []).length;

      files.push({
        filename,
        status: this.mapStatusChar(statusChar ?? ''),
        patch,
        additions,
        deletions,
      });
    }

    const commitMsg = await this.execGit('log', '--format=%s', '-1', headSha);

    return {
      files,
      baseSha,
      headSha,
      summary: `Push: ${commitMsg.trim()}`,
    };
  }

  // ─── Filtering ───

  private filterFiles(files: FileDiff[]): FileDiff[] {
    let filtered = files;

    // Apply include filter
    if (this.config.includePaths.length > 0) {
      filtered = filtered.filter(f =>
        this.config.includePaths.some(
          pattern => f.filename.startsWith(pattern) || minimatch(f.filename, pattern + '**')
        )
      );
    }

    // Apply exclude filter
    if (this.config.excludePaths.length > 0) {
      filtered = filtered.filter(
        f =>
          !this.config.excludePaths.some(
            pattern => f.filename.startsWith(pattern) || minimatch(f.filename, pattern + '**')
          )
      );
    }

    return filtered;
  }

  private isSourceFile(filename: string): boolean {
    const nonSourceExtensions = [
      '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp',
      '.woff', '.woff2', '.ttf', '.eot',
      '.lock', '.sum',
      '.map',
      '.min.js', '.min.css',
    ];

    const nonSourceFiles = [
      'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
      '.gitignore', '.gitattributes', '.editorconfig',
      'LICENSE', 'CHANGELOG.md',
    ];

    const lower = filename.toLowerCase();
    if (nonSourceFiles.some(f => lower.endsWith(f.toLowerCase()))) return false;
    if (nonSourceExtensions.some(ext => lower.endsWith(ext))) return false;

    return true;
  }

  // ─── Helpers ───
  // Note: Uses @actions/exec which passes args as an array (safe from shell injection)

  private async execGit(...args: string[]): Promise<string> {
    let output = '';
    await exec.exec('git', args, {
      listeners: {
        stdout: (data: Buffer) => {
          output += data.toString();
        },
      },
      silent: true,
    });
    return output.trim();
  }

  private mapStatus(status: string): FileDiff['status'] {
    switch (status) {
      case 'added': return 'added';
      case 'removed': return 'deleted';
      case 'renamed': return 'renamed';
      default: return 'modified';
    }
  }

  private mapStatusChar(char: string): FileDiff['status'] {
    switch (char.charAt(0)) {
      case 'A': return 'added';
      case 'D': return 'deleted';
      case 'R': return 'renamed';
      default: return 'modified';
    }
  }
}
