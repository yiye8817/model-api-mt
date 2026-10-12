import type { ApiType } from '../types';

export interface ProviderPreset {
  id: string;
  label: string;
  baseUrl: string;
  apiType: ApiType;
  embeddingModels: string[];
  rerankModels: string[];
  note: string;
}

const PRESETS: Array<{ id: string; label: string; aliases: string[]; baseUrl: string; apiType: ApiType; embeddingModels: string[]; rerankModels: string[]; note: string }> = [
  {
    id: 'anthropic', label: 'Anthropic / Claude', aliases: ['anthropic', 'claude'], baseUrl: 'https://api.anthropic.com/v1', apiType: 'anthropic', embeddingModels: [], rerankModels: [],
    note: 'Anthropic API 不提供兼容的 embedding/rerank 接口',
  },
  {
    id: 'qwen', label: 'Qwen / DashScope（通义）', aliases: ['qwen', 'dashscope', '百炼', '阿里云', '通义', 'qwencloud'], baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiType: 'openai',
    embeddingModels: ['text-embedding-v4', 'text-embedding-v3', 'qwen3.7-text-embedding'],
    rerankModels: ['qwen3-rerank', 'gte-rerank-v2'],
    note: '候选模型需通过真实接口验证',
  },
  {
    id: 'deepseek', label: 'DeepSeek', aliases: ['deepseek'], baseUrl: 'https://api.deepseek.com', apiType: 'openai', embeddingModels: [], rerankModels: [],
    note: 'DeepSeek 官方模型以生成/推理为主，未自动推荐 embedding/rerank',
  },
  {
    id: 'xiaomi', label: 'Xiaomi MiMo（小米）', aliases: ['xiaomi', 'mimo', '小米'], baseUrl: 'https://api.xiaomimimo.com/v1', apiType: 'openai', embeddingModels: [], rerankModels: [],
    note: '未检测到通用 embedding/rerank 候选，请使用实际模型列表验证',
  },
  {
    id: 'openai', label: 'OpenAI', aliases: ['openai'], baseUrl: 'https://api.openai.com/v1', apiType: 'openai',
    embeddingModels: ['text-embedding-3-small', 'text-embedding-3-large'], rerankModels: [],
    note: 'OpenAI 原生提供 embedding，rerank 需第三方兼容服务',
  },
  {
    id: 'siliconflow', label: 'SiliconFlow（硅基流动）', aliases: ['siliconflow', '硅基流动'], baseUrl: 'https://api.siliconflow.cn/v1', apiType: 'openai',
    embeddingModels: ['BAAI/bge-m3'], rerankModels: ['BAAI/bge-reranker-v2-m3'], note: '候选模型需通过真实接口验证',
  },
  {
    id: 'zhipu', label: '智谱 GLM', aliases: ['zhipu', '智谱', 'bigmodel'], baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiType: 'openai',
    embeddingModels: [], rerankModels: [], note: '当前仅自动设置兼容 API，能力模型需从 Models 验证',
  },
  {
    id: 'moonshot', label: 'Moonshot / Kimi', aliases: ['moonshot', 'kimi', '月之暗面'], baseUrl: 'https://api.moonshot.cn/v1', apiType: 'openai',
    embeddingModels: [], rerankModels: [], note: '当前仅自动设置兼容 API，能力模型需从 Models 验证',
  },
  {
    id: 'openrouter', label: 'OpenRouter', aliases: ['openrouter'], baseUrl: 'https://openrouter.ai/api/v1', apiType: 'openai',
    embeddingModels: [], rerankModels: [], note: '能力模型由实际路由模型决定，请执行验证',
  },
  {
    id: 'ollama', label: 'Ollama（本地）', aliases: ['ollama'], baseUrl: 'http://127.0.0.1:11434/v1', apiType: 'openai',
    embeddingModels: [], rerankModels: [], note: '请先在本地服务中安装对应模型',
  },
];

export const COMMON_PROVIDER_PRESETS = PRESETS.map(({ id, label, baseUrl, apiType }) => ({ id, label, baseUrl, apiType }));

export function providerPresetFor(name: string, baseUrl: string): ProviderPreset | null {
  const haystack = `${name} ${baseUrl}`.toLocaleLowerCase();
  const match = PRESETS.find(preset => preset.aliases.some(alias => haystack.includes(alias.toLocaleLowerCase())));
  if (!match) return null;
  const apiType = match.id === 'deepseek' && /\/anthropic(?:\/|$)/i.test(baseUrl) ? 'anthropic' : match.apiType;
  return { ...match, apiType, embeddingModels: [...match.embeddingModels], rerankModels: [...match.rerankModels] };
}
