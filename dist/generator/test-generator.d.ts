import { ActionConfig, DiffResult, ExtractedFixture, GeneratedTest, LLMClient } from '../types';
export declare class TestGenerator {
    private config;
    private llm;
    private prompts;
    private extractedFixtures;
    constructor(config: ActionConfig, llm: LLMClient);
    generate(diff: DiffResult): Promise<GeneratedTest[]>;
    writeFixtures(): Promise<string[]>;
    getExtractedFixtures(): ExtractedFixture[];
    private generatePlan;
    private generateTest;
    private discoverExistingTests;
    private pickStyleReference;
    writeTests(tests: GeneratedTest[]): Promise<string[]>;
}
//# sourceMappingURL=test-generator.d.ts.map