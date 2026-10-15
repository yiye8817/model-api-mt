import type { WebResearchResult, ChatSource, ResearchSearchQuery } from '../types';

export type ResearchEvent = {
  type: 'start' | 'heartbeat' | 'status' | 'plan' | 'result' | 'complete' | 'error';
  channel?: string;
  status?: 'running' | 'retrying' | 'done' | 'error';
  detail?: string;
  result?: WebResearchResult;
  answer?: string;
  model?: string;
  provider_id?: string;
  provider_name?: string;
  finish_reason?: string;
  sources?: ChatSource[];
  keywords?: Record<string, string[]>;
  queries?: ResearchSearchQuery[];
  keyword_model?: string;
  query_language?: ResearchSearchQuery['language'];
  search_query?: string;
};

export const researchChannels: Record<string, string> = {
  keywords: '关键词提取', provider: '当前 Provider', official: '官方资源候选', google: 'Google', youtube: 'YouTube',
  x: 'X', reddit: 'Reddit', github: 'GitHub', ddgs: 'DDGS', parsing: '网页解析', synthesis: '默认模型综合',
};

export async function consumeResearchStream(response: Response, signal: AbortSignal,
  onEvent: (event: ResearchEvent) => void): Promise<ResearchEvent> {
  if (!response.ok) throw new Error(`综合搜索请求失败 (${response.status})`);
  if (!response.body) throw new Error('综合搜索没有返回数据流');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let final: ResearchEvent | undefined;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  const frame = (raw: string) => {
    const text = raw.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!text) return;
    const event = JSON.parse(text) as ResearchEvent;
    onEvent(event);
    if (event.type === 'error') throw new Error(event.detail || '综合搜索失败');
    if (event.type === 'complete') final = event;
  };
  try {
    while (true) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const { done, value } = await reader.read();
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      buffer += decoder.decode(value, { stream: !done });
      buffer = buffer.replace(/\r\n/g, '\n');
      if (buffer.length > 256000) throw new Error('综合搜索返回内容过长');
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        frame(buffer.slice(0, boundary));buffer = buffer.slice(boundary + 2);
      }
      if (final) return final;
      if (done) {
        if (buffer.trim()) frame(buffer);
        break;
      }
    }
    if (!final) throw new Error('综合搜索未返回完成结果，已保留搜索过程');
    return final;
  } finally {
    signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
  }
}
