export type LLMProvider = 'anthropic' | 'openai' | 'custom';
export interface LLMConfig {
    provider: LLMProvider;
    apiKey: string;
    model: string;
    baseUrl?: string;
}
export interface LLMMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}
export interface LLMResponse {
    content: string;
    model: string;
    usage?: {
        inputTokens: number;
        outputTokens: number;
    };
}
export interface LLMClient {
    generate(messages: LLMMessage[], options?: {
        maxTokens?: number;
        temperature?: number;
    }): Promise<LLMResponse>;
}
export type DiffMode = 'auto' | 'pr' | 'push';
export interface FileDiff {
    filename: string;
    status: 'added' | 'modified' | 'deleted' | 'renamed';
    patch: string;
    additions: number;
    deletions: number;
    previousFilename?: string;
}
export interface DiffResult {
    files: FileDiff[];
    baseSha: string;
    headSha: string;
    summary: string;
}
export interface ExistingTest {
    filepath: string;
    content: string;
}
export interface GeneratedTest {
    filename: string;
    filepath: string;
    content: string;
    sourceFiles: string[];
    description: string;
    severity: string;
}
export interface TestPlan {
    tests: TestPlanEntry[];
    reasoning: string;
}
export interface ApiDependency {
    url: string;
    method: string;
    description: string;
    responseShape?: string;
    isWebSocket?: boolean;
}
export interface ExtractedFixture {
    filepath: string;
    content: string;
    sourceTestFile: string;
}
export interface TestPlanEntry {
    targetFile: string;
    testFilename: string;
    description: string;
    userFlows: string[];
    priority: 'high' | 'medium' | 'low';
    severity: 'sev1' | 'sev2' | 'sev3' | 'sev4';
    apiDependencies?: ApiDependency[];
}
export type TraceMode = 'on' | 'off' | 'retain-on-failure' | 'on-first-retry';
export interface ActionConfig {
    llm: LLMConfig;
    testDirectory: string;
    testPatterns: string[];
    baseUrl: string;
    framework: string;
    diffMode: DiffMode;
    includePaths: string[];
    excludePaths: string[];
    autoCommit: boolean;
    autoPr: boolean;
    maxTestFiles: number;
    dryRun: boolean;
    customInstructions: string;
    traceOnFailure: boolean;
    traceMode: TraceMode;
    generateApiMocks: boolean;
    mockErrorStates: boolean;
    fixtureExtractionThreshold: number;
    visualRegression: boolean;
    visualThreshold: number;
    visualMaxDiffRatio: number;
    visualFullPage: boolean;
    accessibilityAssertions: boolean;
    axeScan: boolean;
    axeStandard: string;
}
export interface ActionResult {
    testsGenerated: number;
    testFiles: string[];
    fixtureFiles?: string[];
    prNumber?: number;
    summary: string;
}
