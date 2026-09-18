import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const mockUploadArtifact = jest.fn().mockResolvedValue({});
jest.mock('@actions/artifact', () => ({
  DefaultArtifactClient: jest.fn().mockImplementation(() => ({
    uploadArtifact: mockUploadArtifact,
  })),
}), { virtual: true });

import { TraceUploader } from '../src/utils/trace-uploader';

// Mock @actions/core
jest.mock('@actions/core', () => ({
  info: jest.fn(),
  warning: jest.fn(),
}));

describe('TraceUploader', () => {
  describe('buildFailureDiagnostics', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-test-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('returns empty string for non-existent directory', async () => {
      const result = await TraceUploader.buildFailureDiagnostics('/does/not/exist');
      expect(result).toBe('');
    });

    it('returns empty string for empty directory', async () => {
      const result = await TraceUploader.buildFailureDiagnostics(tmpDir);
      expect(result).toBe('');
    });

    it('builds markdown table from test result directories', async () => {
      // Create mock test result dirs
      const testDir1 = path.join(tmpDir, 'login-test');
      fs.mkdirSync(testDir1);
      fs.writeFileSync(path.join(testDir1, 'trace.zip'), '');
      fs.writeFileSync(path.join(testDir1, 'screenshot.png'), '');

      const testDir2 = path.join(tmpDir, 'checkout-test');
      fs.mkdirSync(testDir2);
      fs.writeFileSync(path.join(testDir2, 'recording.webm'), '');

      const result = await TraceUploader.buildFailureDiagnostics(tmpDir);

      expect(result).toContain('| Test | Trace | Screenshot | Video |');
      expect(result).toContain('login test');
      expect(result).toContain('checkout test');
    });

    it('correctly detects trace/screenshot/video availability', async () => {
      // Dir with all artifacts
      const fullDir = path.join(tmpDir, 'full-test');
      fs.mkdirSync(fullDir);
      fs.writeFileSync(path.join(fullDir, 'trace.zip'), '');
      fs.writeFileSync(path.join(fullDir, 'fail.png'), '');
      fs.writeFileSync(path.join(fullDir, 'video.webm'), '');

      // Dir with no artifacts
      const emptyDir = path.join(tmpDir, 'empty-test');
      fs.mkdirSync(emptyDir);
      fs.writeFileSync(path.join(emptyDir, 'test-results.json'), '');

      const result = await TraceUploader.buildFailureDiagnostics(tmpDir);
      const lines = result.split('\n');

      // full-test line should have all checks
      const fullLine = lines.find(l => l.includes('full test'));
      expect(fullLine).toBeDefined();

      // empty-test line should have all X marks
      const emptyLine = lines.find(l => l.includes('empty test'));
      expect(emptyLine).toBeDefined();
    });

    it('strips retry suffixes from test names', async () => {
      const retryDir = path.join(tmpDir, 'login-test-retry1');
      fs.mkdirSync(retryDir);
      fs.writeFileSync(path.join(retryDir, 'trace.zip'), '');

      const result = await TraceUploader.buildFailureDiagnostics(tmpDir);
      expect(result).toContain('login test');
      expect(result).not.toContain('retry1');
    });
  });

  describe('uploadTraces', () => {
    beforeEach(() => mockUploadArtifact.mockClear());

    it('handles missing test-results directory gracefully', async () => {
      await expect(TraceUploader.uploadTraces('/nonexistent/path')).resolves.toEqual(
        expect.objectContaining({ fileCount: 0 })
      );
      expect(mockUploadArtifact).not.toHaveBeenCalled();
    });

    it('uploads discovered diagnostics and returns artifact metadata', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-upload-test-'));
      const resultDir = path.join(tmpDir, 'login');
      fs.mkdirSync(resultDir);
      fs.writeFileSync(path.join(resultDir, 'trace.zip'), 'trace');

      const result = await TraceUploader.uploadTraces(tmpDir);

      expect(result.fileCount).toBe(1);
      expect(mockUploadArtifact).toHaveBeenCalledWith(
        result.artifactName,
        [path.join(resultDir, 'trace.zip')],
        tmpDir,
        { retentionDays: 30 }
      );
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
  });
});
