import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkLocalFirst } from './knowledgeRouting';
import type { KnowledgeQueryRequest } from './knowledgeTypes';

const request: KnowledgeQueryRequest = { request_id: 'repeat', question: '牛顿是谁？', context: [], system_constraints: '', source_ids: [], mode: 'api', online_target: null, parameters: {} };
const result = (decision: 'hit' | 'miss', answer_origin: string | null = null) => new Response(JSON.stringify({
  request_id: 'repeat', decision, reason: decision === 'miss' ? 'no_saved_answer' : '', answer: decision === 'hit' ? '牛顿是英国物理学家。' : null,
  citations: answer_origin === 'local_generated' ? [{ source_id: 's', chunk_id: 'c', quote: '引用' }] : [], trace: [], local_model: '', duration_ms: 0, answer_origin,
  saved_entry: answer_origin === 'saved_answer' ? { id: 'history:conv:a', fact_status: 'unverified', source_name: '历史回答' } : null,
}), { headers: { 'Content-Type': 'application/json' } });
const options = () => ({ enabled: true, onlineFallback: true, signal: new AbortController().signal });
afterEach(() => vi.unstubAllGlobals());

describe('saved answer before semantic generation', () => {
  it('a repeat uses the saved answer without a semantic or online model request', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL) => result('hit', 'saved_answer'));
    vi.stubGlobal('fetch', fetch);
    const route = await checkLocalFirst(request, options());
    expect(route.decision).toBe('hit');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/content-library/reuse');
    if (route.decision === 'hit') expect(route.result.answer_origin).toBe('saved_answer');
  });
  it('a saved-answer miss continues to the existing semantic route', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(result('miss')).mockResolvedValueOnce(result('hit', 'local_generated'));
    vi.stubGlobal('fetch', fetch);
    expect((await checkLocalFirst(request, options())).decision).toBe('hit');
    expect(fetch.mock.calls.map(call => call[0])).toEqual(['/api/content-library/reuse', '/api/knowledge/query']);
  });
  it('cancellation during saved reuse never falls back to a model', async () => {
    const controller = new AbortController();
    const fetch = vi.fn(async () => { controller.abort(); return result('hit', 'saved_answer'); });
    vi.stubGlobal('fetch', fetch);
    expect((await checkLocalFirst(request, { ...options(), signal: controller.signal })).decision).toBe('cancelled');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('unavailable saved library leaves existing semantic fallback usable', async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(result('hit', 'local_generated'));
    vi.stubGlobal('fetch', fetch);
    expect((await checkLocalFirst(request, options())).decision).toBe('hit');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
