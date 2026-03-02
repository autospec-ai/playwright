import { ActionConfig, GeneratedTest } from '../types';
export declare class GitOps {
    private octokit;
    constructor();
    commitTests(tests: GeneratedTest[], headSha: string, fixtureFiles?: string[]): Promise<void>;
    createPR(tests: GeneratedTest[], baseBranch: string, headSha: string, config?: ActionConfig, fixtureFiles?: string[]): Promise<number>;
    private buildPRBody;
    private execGit;
}
//# sourceMappingURL=git-ops.d.ts.map