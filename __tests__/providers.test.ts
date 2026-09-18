const mockOpenAICreate = jest.fn();
const mockAnthropicCreate = jest.fn();

jest.mock('openai', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    chat: { completions: { create: mockOpenAICreate } },
  })),
}));
jest.mock('@anthropic-ai/sdk', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    messages: { create: mockAnthropicCreate },
  })),
}));

import { AnthropicProvider } from '../src/providers/anthropic';
import { createLLMClient } from '../src/providers';
import { OpenAIProvider } from '../src/providers/openai';

describe('LLM providers', () => {
  beforeEach(() => {
    mockOpenAICreate.mockReset();
    mockAnthropicCreate.mockReset();
  });

  it('uses max_completion_tokens and omits temperature for reasoning models', async () => {
    mockOpenAICreate.mockResolvedValue({
      model: 'gpt-5',
      choices: [{ message: { content: 'result' } }],
      usage: { prompt_tokens: 10, completion_tokens: 4 },
    });
    const provider = new OpenAIProvider({ provider: 'openai', apiKey: 'key', model: 'gpt-5' });
    await provider.generate([{ role: 'user', content: 'hello' }], { maxTokens: 100, temperature: 0 });

    expect(mockOpenAICreate).toHaveBeenCalledWith(expect.objectContaining({
      model: 'gpt-5',
      max_completion_tokens: 100,
    }));
    expect(mockOpenAICreate.mock.calls[0][0]).not.toHaveProperty('temperature');
  });

  it('passes system messages separately to Anthropic', async () => {
    mockAnthropicCreate.mockResolvedValue({
      model: 'claude-test',
      content: [{ type: 'text', text: 'result' }],
      usage: { input_tokens: 8, output_tokens: 3 },
    });
    const provider = new AnthropicProvider({ provider: 'anthropic', apiKey: 'key', model: 'claude-test' });
    await provider.generate([
      { role: 'system', content: 'system rules' },
      { role: 'user', content: 'hello' },
    ]);

    expect(mockAnthropicCreate).toHaveBeenCalledWith(expect.objectContaining({
      system: 'system rules',
      messages: [{ role: 'user', content: 'hello' }],
    }));
  });

  it('requires a base URL for custom providers', () => {
    expect(() => createLLMClient({ provider: 'custom', apiKey: 'key', model: '' }))
      .toThrow('requires llm_base_url');
  });
});
