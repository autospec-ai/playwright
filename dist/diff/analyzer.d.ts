import { DiffResult, ActionConfig } from '../types';
export declare class DiffAnalyzer {
    private config;
    private octokit;
    constructor(config: ActionConfig);
    analyze(): Promise<DiffResult>;
    private resolveMode;
    private analyzePR;
    private analyzePush;
    private filterFiles;
    private isSourceFile;
    private execGit;
    private mapStatus;
    private mapStatusChar;
}
//# sourceMappingURL=analyzer.d.ts.map