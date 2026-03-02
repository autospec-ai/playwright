import { ActionConfig, DiffResult, ExistingTest, TestPlan } from '../types';
/**
 * Builds structured prompts for two-phase test generation:
 *   Phase 1: Analyze diff → produce a test plan (JSON)
 *   Phase 2: For each planned test → generate Playwright code
 */
export declare class PromptBuilder {
    private config;
    constructor(config: ActionConfig);
    buildPlanPrompt(diff: DiffResult, existingTests: ExistingTest[]): string;
    buildTestPrompt(plan: TestPlan['tests'][number], diff: DiffResult, existingTests: ExistingTest[], styleReference?: string): string;
    private buildApiMockSection;
    private buildVisualRegressionSection;
    private buildAccessibilitySection;
    private summarizeFile;
    private formatDiff;
    private isRelated;
}
//# sourceMappingURL=prompts.d.ts.map