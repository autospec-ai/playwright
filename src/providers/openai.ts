import OpenAI from 'openai';
import { LLMClient, LLMConfig, LLMMessage, LLMResponse } from '../types';

export class OpenAIProvider implements LLMClient {
  private client: OpenAI;
  private model: string;

  constructor(config: LLMConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
    });
    this.model = config.model || 'gpt-4o';
  }

  async generate(
    messages: LLMMessage[],
    options?: { maxTokens?: number; temperature?: number }
  ): Promise<LLMResponse> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: options?.maxTokens ?? 8192,
      temperature: options?.temperature ?? 0.2,
      messages: messages.map(m => ({
        role: m.role,
        content: m.content,
      })),
    });

    const choice = response.choices[0];

    return {
      content: choice?.message?.content ?? '',
      model: response.model,
      usage: response.usage
        ? {
            inputTokens: response.usage.prompt_tokens,
            outputTokens: response.usage.completion_tokens ?? 0,
          }
        : undefined,
    };
  }
}
