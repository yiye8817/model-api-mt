import type { ApiType } from '../types';

export interface ProviderPreset {
  id: string;
  apiType: ApiType;
  embeddingModels: string[];
  rerankModels: string[];
  note: string;
}

const PRESETS: Array<{ id: string; aliases: string[]; apiType: ApiType; embeddingModels: string[]; rerankModels: string[]; note: string }> = [
  {
    id: 'anthropic', aliases: ['anthropic', 'claude'], apiType: 'anthropic', embeddingModels: [], rerankModels: [],
    note: 'Anthropic API 不提供兼容的 embedding/rerank 接口',
  },
  {
    id: 'qwen', aliases: ['qwen', 'dashscope', '百炼', '阿里云', 'qwencloud'], apiType: 'openai',
    embeddingModels: ['text-embedding-v4', 'text-embedding-v3', 'qwen3.7-text-embedding'],
    rerankModels: ['qwen3-rerank', 'gte-rerank-v2'],
    note: '候选模型需通过真实接口验证',
  },
  {
    id: 'deepseek', aliases: ['deepseek'], apiType: 'openai', embeddingModels: [], rerankModels: [],
    note: 'DeepSeek 官方模型以生成/推理为主，未自动推荐 embedding/rerank',
  },
  {
    id: 'xiaomi', aliases: ['xiaomi', 'mimo', '小米'], apiType: 'openai', embeddingModels: [], rerankModels: [],
    note: '未检测到通用 embedding/rerank 候选，请使用实际模型列表验证',
  },
  {
    id: 'openai', aliases: ['openai'], apiType: 'openai',
    embeddingModels: ['text-embedding-3-small', 'text-embedding-3-large'], rerankModels: [],
    note: 'OpenAI 原生提供 embedding，rerank 需第三方兼容服务',
  },
];

export function providerPresetFor(name: string, baseUrl: string): ProviderPreset | null {
  const haystack = `${name} ${baseUrl}`.toLocaleLowerCase();
  const match = PRESETS.find(preset => preset.aliases.some(alias => haystack.includes(alias.toLocaleLowerCase())));
  if (!match) return null;
  const apiType = match.id === 'deepseek' && /\/anthropic(?:\/|$)/i.test(baseUrl) ? 'anthropic' : match.apiType;
  return { ...match, apiType, embeddingModels: [...match.embeddingModels], rerankModels: [...match.rerankModels] };
}
