import { LLMClient, LLMConfig } from '../types';
import { AnthropicProvider } from './anthropic';
import { OpenAIProvider } from './openai';

export function createLLMClient(config: LLMConfig): LLMClient {
  switch (config.provider) {
    case 'anthropic':
      return new AnthropicProvider(config);

    case 'openai':
      return new OpenAIProvider(config);

    case 'custom':
      // Custom providers use the OpenAI-compatible API with a custom base URL
      if (!config.baseUrl) {
        throw new Error(
          'Custom LLM provider requires llm_base_url to be set (OpenAI-compatible endpoint)'
        );
      }
      return new OpenAIProvider(config);

    default:
      throw new Error(`Unsupported LLM provider: ${config.provider}`);
  }
}

export { AnthropicProvider } from './anthropic';
export { OpenAIProvider } from './openai';
