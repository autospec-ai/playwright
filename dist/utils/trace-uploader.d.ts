/**
 * Handles uploading Playwright traces as GitHub Actions artifacts
 * and building failure diagnostics from test results.
 */
export declare class TraceUploader {
    /**
     * Upload trace/screenshot/video files from test-results as a GitHub Actions artifact.
     * Uses dynamic import of @actions/artifact for graceful degradation.
     */
    static uploadTraces(testResultsDir: string): Promise<void>;
    /**
     * Scan test-results directories and build a markdown table summarizing
     * which tests have traces, screenshots, and videos available.
     */
    static buildFailureDiagnostics(testResultsDir: string): Promise<string>;
}
//# sourceMappingURL=trace-uploader.d.ts.map