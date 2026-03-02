import { ExtractedFixture, GeneratedTest } from '../types';
/**
 * Extracts inline page.route() mocks from tests into shared fixture files
 * when the number of route blocks exceeds a configurable threshold.
 */
export declare class FixtureExtractor {
    /**
     * For each test, count page.route() blocks. If count > threshold,
     * extract route mock bodies into a fixtures file with a setupApiMocks(page) function,
     * and rewrite the test to import and call it.
     */
    static extractFixtures(tests: GeneratedTest[], threshold: number, testDirectory: string): ExtractedFixture[];
    /**
     * Find `await page.route(...)` blocks using brace-depth counting.
     * Returns the full text of each route block.
     */
    static findRouteBlocks(code: string): string[];
}
//# sourceMappingURL=fixture-extractor.d.ts.map