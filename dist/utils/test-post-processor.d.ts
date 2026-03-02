import { TraceMode } from '../types';
/**
 * Static utility class for post-processing generated test code.
 * All methods are pure string transforms — no I/O.
 */
export declare class TestPostProcessor {
    /**
     * Inject Playwright trace/screenshot/video config after imports.
     * Skips if `test.use(` already exists in the code.
     */
    static injectTraceConfig(code: string, traceMode: TraceMode): string;
    /**
     * If code contains `AxeBuilder` but no `@axe-core/playwright` import, inject it.
     */
    static ensureAxeImport(code: string): string;
    /**
     * Find bare `toHaveScreenshot('name.png')` calls and add threshold/maxDiffRatio/fullPage options.
     * Transforms: `toHaveScreenshot('name.png')` → `toHaveScreenshot('name.png', { threshold, maxDiffPixelRatio, fullPage })`
     * Skips calls that already have a second options argument.
     */
    static normalizeScreenshotOptions(code: string, threshold: number, maxDiffRatio: number, fullPage: boolean): string;
}
//# sourceMappingURL=test-post-processor.d.ts.map