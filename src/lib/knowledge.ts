export type FactStatus = 'unverified' | 'correct' | 'uncertain' | 'incorrect';
export const FACT_LABELS: Record<FactStatus, string> = {
  unverified: '未核验', correct: '正确', uncertain: '存疑', incorrect: '错误',
};
export const APP_INTENTS = ['讯息', '问答', '工具调用', '网页控制', '图文理解', '音频理解', '代码编写', '文字润色', '数据分析', '生成图片', '生成音频', '未知'];

export interface KnowledgeEntry {
  id: string;
  kind: 'qa' | 'intent';
  origin: 'history' | 'public' | 'manual';
  question: string;
  answer: string;
  context: string;
  title?: string;
  intent?: string;
  native_label?: string;
  source_name: string;
  source_url: string;
  original_source_name: string;
  original_source_url: string;
  tags: string[];
  fact_status: FactStatus;
  note: string;
  annotated_at: string | null;
  match_score?: number;
}

export interface LocalIntent {
  intent: string;
  native_label: string | null;
  coverage: number;
  reason: string;
  sample: { id: string; question: string; source_name: string } | null;
}

export interface BenchmarkReport {
  created_at: string;
  method: string;
  scope: string;
  intent: { total: number; accuracy: number | null; macro_f1: number | null; native_accuracy: number | null; excluded_overlap: number; labels: string[] };
  qa: { total: number; hit_at_1: number | null; hit_at_5: number | null; mrr_at_5: number | null };
  datasets: string[];
}

export interface KnowledgeStatus {
  entries: number;
  evaluations: number;
  sources: string[];
  covered_intents: string[];
  uncovered_intents: string[];
  datasets: { id: string; name: string; entries: number; source_url: string }[];
  last_evaluation: BenchmarkReport | null;
}

export interface KnowledgeSearch {
  results: KnowledgeEntry[];
  total: number;
  intent: LocalIntent;
}

export async function knowledgeRequest<T>(path: string, method = 'GET', data?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/content-library${path}`, {
    method, signal,
    ...(data !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) } : {}),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `请求失败 (${response.status})`);
  return result as T;
}

export function safeSourceUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : undefined;
  } catch { return undefined; }
}
