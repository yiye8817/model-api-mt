import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import ConfigModal from './ConfigModal';

describe('ConfigModal provider capability detection', () => {
  it('offers common provider sources and fills provider details when selected', async () => {
    render(<ConfigModal provider={null} onSave={vi.fn()} onClose={vi.fn()} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Provider Name' }), { target: { value: 'qwen' } });
    await waitFor(() => expect((screen.getByPlaceholderText('e.g. https://api.openai.com/v1') as HTMLInputElement).value).toContain('dashscope.aliyuncs.com'));
    expect((screen.getByPlaceholderText('text-embedding-3-small') as HTMLInputElement).value).toContain('text-embedding-v3');
  });

  it('suggests Qwen retrieval models and OpenAI API mode from provider name', async () => {
    render(<ConfigModal provider={null} onSave={vi.fn()} onClose={vi.fn()} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Provider Name' }), { target: { value: 'qwen' } });
    await waitFor(() => expect((screen.getByPlaceholderText('text-embedding-3-small') as HTMLInputElement).value).toContain('text-embedding-v3'));
    expect((screen.getByPlaceholderText('bge-reranker-v2') as HTMLInputElement).value).toContain('gte-rerank-v2');
  });

  it('fills verified embedding and rerank models from the provider probe', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        embedding: { available_models: ['embed-good'], models: [{ model: 'embed-good', ok: true, dimension: 3 }] },
        rerank: { available_models: ['rerank-good'], models: [{ model: 'rerank-good', ok: true, top_score: 0.9 }] },
      }),
    });
    vi.stubGlobal('fetch', fetcher);
    render(<ConfigModal provider={{id:'p',name:'Fixture',baseUrl:'http://fixture/v1',apiKey:'key',models:['embed-good','rerank-good'],selectedModel:'chat'} as any} onSave={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '自动识别能力' }));
    await waitFor(() => expect((screen.getByPlaceholderText('text-embedding-3-small') as HTMLInputElement).value).toBe('embed-good'));
    expect((screen.getByPlaceholderText('bge-reranker-v2') as HTMLInputElement).value).toBe('rerank-good');
    expect(fetcher).toHaveBeenCalledWith('/api/providers/capabilities/test', expect.objectContaining({ method: 'POST' }));
  });
});
