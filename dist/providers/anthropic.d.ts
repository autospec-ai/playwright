import { LLMClient, LLMConfig, LLMMessage, LLMResponse } from '../types';
export declare class AnthropicProvider implements LLMClient {
    private client;
    private model;
    constructor(config: LLMConfig);
    generate(messages: LLMMessage[], options?: {
        maxTokens?: number;
        temperature?: number;
    }): Promise<LLMResponse>;
}
//# sourceMappingURL=anthropic.d.ts.map