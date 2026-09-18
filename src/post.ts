import * as core from '@actions/core';
import { TraceUploader } from './utils/trace-uploader';

export async function runPost(): Promise<void> {
  try {
    if (!core.getBooleanInput('trace_on_failure')) return;

    const testResultsDirectory = core.getInput('test_results_directory') || 'test-results';
    core.startGroup('📤 Uploading Playwright diagnostics');
    let upload: Awaited<ReturnType<typeof TraceUploader.uploadTraces>>;
    try {
      upload = await TraceUploader.uploadTraces(testResultsDirectory);
    } finally {
      core.endGroup();
    }

    if (upload.fileCount > 0) {
      const diagnostics = await TraceUploader.buildFailureDiagnostics(testResultsDirectory);
      await core.summary
        .addHeading('Playwright failure diagnostics', 2)
        .addRaw(`\nUploaded ${upload.fileCount} diagnostic file(s) to artifact \`${upload.artifactName}\`.\n\n`)
        .addRaw(diagnostics ? `${diagnostics}\n` : '')
        .write();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    core.warning(`Trace upload failed (non-fatal): ${message}`);
  }
}
