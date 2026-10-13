import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import KnowledgeSettings, { localKnowledgeDefaults } from './KnowledgeSettings';

describe('KnowledgeSettings provider selectors', () => {
  it('loads configured providers after switching to provider source', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ providers: [{ id: 'qwen-id', name: 'qwen', embedding_models: ['text-embedding-v3'], rerank_models: ['gte-rerank-v2'] }] }),
    }));
    function Harness() {
      const [value, setValue] = useState(localKnowledgeDefaults());
      return <KnowledgeSettings value={value} onChange={setValue} />;
    }
    render(<Harness />);
    fireEvent.change(screen.getByLabelText('向量模型接口来源'), { target: { value: 'provider' } });
    await waitFor(() => expect(screen.getByRole('option', { name: 'qwen' })).toBeTruthy());
    fireEvent.change(screen.getByLabelText('向量模型 Provider'), { target: { value: 'qwen-id' } });
    expect(screen.getByRole('option', { name: 'text-embedding-v3' })).toBeTruthy();
  });
});
