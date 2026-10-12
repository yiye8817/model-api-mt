import { describe, expect, it } from 'vitest';
import { providerPresetFor } from './providerPresets';

describe('provider presets', () => {
  it('recognizes Qwen/DashScope as OpenAI-compatible with retrieval candidates', () => {
    const preset = providerPresetFor('Qwen', 'https://dashscope.aliyuncs.com/compatible-mode/v1');
    expect(preset?.apiType).toBe('openai');
    expect(preset?.embeddingModels).toContain('text-embedding-v3');
    expect(preset?.rerankModels).toContain('gte-rerank-v2');
  });

  it('recognizes Anthropic and does not suggest unsupported retrieval models', () => {
    const preset = providerPresetFor('Claude', 'https://api.anthropic.com/v1');
    expect(preset?.apiType).toBe('anthropic');
    expect(preset?.embeddingModels).toEqual([]);
    expect(preset?.rerankModels).toEqual([]);
  });

  it('selects DeepSeek Anthropic compatibility when the configured path says so', () => {
    expect(providerPresetFor('DeepSeek', 'https://api.deepseek.com/anthropic')?.apiType).toBe('anthropic');
  });
});
