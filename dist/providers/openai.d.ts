import { LLMClient, LLMConfig, LLMMessage, LLMResponse } from '../types';
export declare class OpenAIProvider implements LLMClient {
    private client;
    private model;
    constructor(config: LLMConfig);
    generate(messages: LLMMessage[], options?: {
        maxTokens?: number;
        temperature?: number;
    }): Promise<LLMResponse>;
}
//# sourceMappingURL=openai.d.ts.map