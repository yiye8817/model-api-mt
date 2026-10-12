import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X, Eye, EyeOff, Loader2, Wifi } from 'lucide-react';
import type { APIProvider, ApiType } from '../types';
import { newUuid } from '../lib/id';
import { providerPresetFor, type ProviderPreset } from '../lib/providerPresets';

interface Props {
  provider: APIProvider | null;
  onSave: (provider: APIProvider) => void;
  onClose: () => void;
}

export default function ConfigModal({ provider, onSave, onClose }: Props) {
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [source, setSource] = useState('');
  const [apiType, setApiType] = useState<ApiType>('openai');
  const [isDefault, setIsDefault] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [selectedModel, setSelectedModel] = useState('');
  const [customModel, setCustomModel] = useState('');
  const [embeddingModels, setEmbeddingModels] = useState('');
  const [rerankModels, setRerankModels] = useState('');
  const [supportsVision, setSupportsVision] = useState(false);
  const [error, setError] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<'ok' | 'fail' | null>(null);
  const [capabilityTesting, setCapabilityTesting] = useState(false);
  const [capabilityResult, setCapabilityResult] = useState<{ ok: boolean; embedding?: { available_models: string[]; models: { model: string; ok: boolean; error?: string }[] }; rerank?: { available_models: string[]; models: { model: string; ok: boolean; error?: string }[] }; error?: string } | null>(null);
  const [providerPreset, setProviderPreset] = useState<ProviderPreset | null>(null);
  const lastPresetRef = useRef('');

  useEffect(() => {
    if (provider) {
      setName(provider.name);
      setBaseUrl(provider.baseUrl);
      setApiKey(provider.apiKey);
      setSource(provider.source ?? '');
      setApiType(provider.apiType ?? 'openai');
      setIsDefault(!!provider.isDefault);
      setSupportsVision(!!provider.supportsVision);
      setModels(provider.models);
      setSelectedModel(provider.selectedModel);
      setEmbeddingModels((provider.embeddingModels || []).join(', '));
      setRerankModels((provider.rerankModels || []).join(', '));
      setCapabilityResult(null);
    } else {
      setName(''); setBaseUrl(''); setApiKey(''); setSource(''); setApiType('openai');
      setIsDefault(false); setSupportsVision(false); setModels([]); setSelectedModel(''); setCustomModel(''); setEmbeddingModels(''); setRerankModels('');
      setCapabilityResult(null);
    }
  }, [provider]);

  useEffect(() => {
    const preset = providerPresetFor(name, baseUrl);
    setProviderPreset(preset);
    if (!preset || lastPresetRef.current === preset.id) return;
    lastPresetRef.current = preset.id;
    setApiType(preset.apiType);
    if (!embeddingModels.trim() && preset.embeddingModels.length) setEmbeddingModels(preset.embeddingModels.join(', '));
    if (!rerankModels.trim() && preset.rerankModels.length) setRerankModels(preset.rerankModels.join(', '));
  }, [name, baseUrl, embeddingModels, rerankModels]);

  const applyProviderPreset = () => {
    if (!providerPreset) return;
    setApiType(providerPreset.apiType);
    setEmbeddingModels(providerPreset.embeddingModels.join(', '));
    setRerankModels(providerPreset.rerankModels.join(', '));
  };

  const testConnection = async () => {
    if (!baseUrl.trim() || !apiKey.trim()) {
      setError('请先填写 Base URL 和 API Key');
      return;
    }
    const model = customModel.trim() || selectedModel || (models[0] ?? '');
    if (!model) {
      setError('请先拉取模型列表或填写自定义模型名后再测试');
      return;
    }
    setTesting(true);
    setError('');
    setTestResult(null);
    try {
      const res = await fetch('/api/test-connection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baseUrl: baseUrl.replace(/\/+$/, ''),
          apiKey: apiKey,
          model,
          apiType,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (data.ok) {
        setTestResult('ok');
      } else {
        setTestResult('fail');
        setError(data.error || `HTTP ${res.status}`);
      }
    } catch (err: any) {
      setTestResult('fail');
      setError(err.message || '请求失败');
    } finally {
      setTesting(false);
    }
  };

  const fetchModels = async (): Promise<string[]> => {
    if (!baseUrl || !apiKey) {
      setError('Please enter Base URL and API Key first');
      return [];
    }
    setFetchingModels(true);
    setError('');
    try {
      // Use backend proxy to fetch models (avoids CORS)
      const res = await fetch('/api/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baseUrl: baseUrl.replace(/\/+$/, ''),
          apiKey: apiKey,
          apiType,
        }),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({ error: res.statusText }));
        // HTTP errors came from the Python proxy/provider.  Do not append the
        // generic "backend is not running" hint to a provider auth failure.
        setError(errData.error || `HTTP ${res.status}`);
        return [];
      }
      const data = await res.json();
      const modelList = (data.models || []).sort();
      setModels(modelList);
      if (modelList.length > 0 && !selectedModel) {
        setSelectedModel(modelList[0]);
      }
      return modelList;
    } catch (err: any) {
      setError(`Failed to fetch models: ${err.message}. Make sure Python backend (server.py) is running.`);
      return [];
    } finally {
      setFetchingModels(false);
    }
  };

  const detectCapabilities = async () => {
    if (!baseUrl.trim()) { setError('请先填写 Base URL'); return; }
    if (!apiKey.trim() && !/^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0|\[?::1\]?)(:|\/|$)/i.test(baseUrl.trim())) {
      setError('请先填写 API Key'); return;
    }
    setCapabilityTesting(true); setCapabilityResult(null); setError('');
    try {
      const availableModels = models.length ? models : await fetchModels();
      if (!availableModels.length) { setError('没有可检测的模型，请先获取 Models'); return; }
      const response = await fetch('/api/providers/capabilities/test', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baseUrl: baseUrl.replace(/\/+$/, ''), apiKey, apiType, models: availableModels,
          embeddingModels: embeddingModels.split(/[,，]/).map(value => value.trim()).filter(Boolean),
          rerankModels: rerankModels.split(/[,，]/).map(value => value.trim()).filter(Boolean),
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      setCapabilityResult(data);
      setEmbeddingModels((data.embedding?.available_models || []).join(', '));
      setRerankModels((data.rerank?.available_models || []).join(', '));
    } catch (err: any) {
      setCapabilityResult({ ok: false, error: err.message || '能力检测失败' });
    } finally {
      setCapabilityTesting(false);
    }
  };

  const handleSave = () => {
    try {
      if (!name.trim()) { setError('Name is required'); return; }
      if (!baseUrl.trim()) { setError('Base URL is required'); return; }
      if (!apiKey.trim()) { setError('API Key is required'); return; }

      const finalModel = customModel.trim() || selectedModel;
      const finalModels = customModel.trim() && !models.includes(customModel.trim())
        ? [...models, customModel.trim()]
        : models;

      onSave({
        id: provider?.id || newUuid(),
        name: name.trim(),
        baseUrl: baseUrl.trim().replace(/\/+$/, ''),
        apiKey: apiKey.trim(),
        source: source.trim() || undefined,
        supportsVision: supportsVision,
        apiType: apiType,
        isDefault,
        models: finalModels,
        selectedModel: finalModel,
        embeddingModels: embeddingModels.split(/[,，]/).map(value => value.trim()).filter(Boolean),
        rerankModels: rerankModels.split(/[,，]/).map(value => value.trim()).filter(Boolean),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`保存失败: ${msg}`);
    }
  };

  const modal = (
    <div
      className="fixed inset-0 bg-black/70 z-[200] p-4 overflow-y-auto"
      onClick={onClose}
    >
      <div
        className="min-h-full flex items-center justify-center py-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="bg-gray-800 rounded-2xl shadow-2xl w-full max-w-lg border border-gray-700 max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between p-6 border-b border-gray-700 shrink-0">
          <h2 className="text-xl font-bold text-white">
            {provider ? 'Edit API Provider' : 'Add API Provider'}
          </h2>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-white transition-colors">
            <X size={20} />
          </button>
        </div>

        <div className="p-6 space-y-4 overflow-y-auto flex-1 min-h-0">
          {error && (
            <div className="bg-red-900/40 border border-red-700 text-red-300 px-4 py-2 rounded-lg text-sm">
              {error}
            </div>
          )}
          {testResult === 'ok' && (
            <div className="bg-green-900/40 border border-green-700 text-green-300 px-4 py-2 rounded-lg text-sm">
              连接成功
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1.5">Provider Name</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. OpenAI, Claude, DeepSeek..."
              className="w-full bg-gray-900 border border-gray-600 rounded-lg px-4 py-2.5 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block text-sm text-gray-300">Embedding 模型（逗号分隔）
              <input value={embeddingModels} onChange={e=>setEmbeddingModels(e.target.value)} placeholder="text-embedding-3-small" className="mt-1 w-full bg-gray-900 border border-gray-600 rounded-lg px-3 py-2 text-white placeholder-gray-500 font-mono text-xs" />
            </label>
            <label className="block text-sm text-gray-300">Rerank 模型（逗号分隔）
              <input value={rerankModels} onChange={e=>setRerankModels(e.target.value)} placeholder="bge-reranker-v2" className="mt-1 w-full bg-gray-900 border border-gray-600 rounded-lg px-3 py-2 text-white placeholder-gray-500 font-mono text-xs" />
            </label>
          </div>
          {providerPreset && <div className="flex flex-wrap items-center gap-2 rounded-lg border border-cyan-900/70 bg-cyan-950/20 px-3 py-2">
            <span className="text-xs text-cyan-200">识别为 {providerPreset.id}：{providerPreset.note}</span>
            <button type="button" onClick={applyProviderPreset} className="ml-auto text-xs text-cyan-300 underline">应用推荐配置</button>
          </div>}
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => void detectCapabilities()} disabled={capabilityTesting || fetchingModels || !baseUrl.trim()} className="text-xs bg-cyan-700 hover:bg-cyan-600 disabled:opacity-50 text-white px-3 py-1.5 rounded-md flex items-center gap-1">
              {capabilityTesting && <Loader2 size={12} className="animate-spin" />}自动识别能力
            </button>
            {capabilityResult?.ok && <span className="text-xs text-emerald-300">已验证：embedding {capabilityResult.embedding?.available_models.length || 0} 个，rerank {capabilityResult.rerank?.available_models.length || 0} 个</span>}
            {capabilityResult && !capabilityResult.ok && <span className="text-xs text-amber-300">{capabilityResult.error || '没有模型通过能力验证'}</span>}
          </div>
          <p className="text-xs text-gray-500">自动检测会对候选模型实际调用 /v1/embeddings 和 /v1/rerank；Key 只在服务端请求中使用。检测成功后会自动填入能力列表。</p>

          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1.5">Provider 来源</label>
            <input
              type="text"
              value={source}
              onChange={e => setSource(e.target.value)}
              placeholder="e.g. 官方 / 自建 / 第三方"
              className="w-full bg-gray-900 border border-gray-600 rounded-lg px-4 py-2.5 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1.5">接口对接方式</label>
            <div className="grid grid-cols-2 gap-2">
              {([
                { v: 'openai', label: 'OpenAI 兼容', desc: '/chat/completions' },
                { v: 'anthropic', label: 'Anthropic', desc: '/v1/messages' },
              ] as { v: ApiType; label: string; desc: string }[]).map(opt => (
                <button
                  key={opt.v}
                  type="button"
                  onClick={() => setApiType(opt.v)}
                  className={`flex flex-col items-start rounded-lg border px-3 py-2 text-left transition-colors ${
                    apiType === opt.v
                      ? 'border-blue-500 bg-blue-500/10 text-white'
                      : 'border-gray-600 bg-gray-900 text-gray-300 hover:border-gray-500'
                  }`}
                >
                  <span className="text-sm font-medium">{opt.label}</span>
                  <span className="text-xs text-gray-500 font-mono">{opt.desc}</span>
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1.5">{apiType === 'anthropic' ? 'Anthropic Base URL' : 'Base URL'}</label>
            <input
              type="text"
              value={baseUrl}
              onChange={e => setBaseUrl(e.target.value)}
              placeholder={apiType === 'anthropic' ? 'e.g. https://api.anthropic.com' : 'e.g. https://api.openai.com/v1'}
              className="w-full bg-gray-900 border border-gray-600 rounded-lg px-4 py-2.5 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent font-mono text-sm"
            />
            {apiType === 'anthropic' && <p className="mt-1 text-xs text-gray-500">可填写官方地址或第三方 Anthropic 兼容网关；支持带或不带 <code className="text-cyan-300">/v1</code>，发送时自动使用 <code className="text-cyan-300">/v1/messages</code>。</p>}
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1.5">API Key</label>
            <div className="relative">
              <input
                type={showKey ? 'text' : 'password'}
                value={apiKey}
                onChange={e => setApiKey(e.target.value)}
                placeholder="输入 API Key（格式不限）"
                className="w-full bg-gray-900 border border-gray-600 rounded-lg px-4 py-2.5 pr-12 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent font-mono text-sm"
              />
              <button
                onClick={() => setShowKey(!showKey)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-white"
              >
                {showKey ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
          </div>

          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={isDefault} onChange={e => setIsDefault(e.target.checked)} className="rounded border-gray-600 bg-gray-900 text-blue-500 focus:ring-blue-500" />
            <span className="text-sm text-gray-300">设为默认大模型（新对话、虚拟终端右键识别使用）</span>
          </label>

          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={supportsVision} onChange={e => setSupportsVision(e.target.checked)} className="rounded border-gray-600 bg-gray-900 text-blue-500 focus:ring-blue-500" />
            <span className="text-sm text-gray-300">支持图像输入 (Vision，发送图片时使用 image_url)</span>
          </label>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="block text-sm font-medium text-gray-300">Models</label>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={testConnection}
                  disabled={testing || !baseUrl.trim() || !apiKey.trim()}
                  className="text-xs bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white px-3 py-1 rounded-md flex items-center gap-1 transition-colors"
                >
                  {testing && <Loader2 size={12} className="animate-spin" />}
                  <Wifi size={12} />
                  测试连接
                </button>
                <button
                  type="button"
                  onClick={fetchModels}
                  disabled={fetchingModels}
                  className="text-xs bg-blue-600 hover:bg-blue-700 disabled:bg-blue-800 disabled:opacity-50 text-white px-3 py-1 rounded-md flex items-center gap-1 transition-colors"
                >
                  {fetchingModels && <Loader2 size={12} className="animate-spin" />}
                  Fetch Models
                </button>
              </div>
            </div>
            {models.length > 0 ? (
              <select
                value={selectedModel}
                onChange={e => setSelectedModel(e.target.value)}
                className="w-full bg-gray-900 border border-gray-600 rounded-lg px-4 py-2.5 text-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
              >
                {models.map(m => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            ) : (
              <p className="text-gray-500 text-sm">No models fetched. Click "Fetch Models" or enter manually below.</p>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1.5">Custom Model Name (optional)</label>
            <input
              type="text"
              value={customModel}
              onChange={e => setCustomModel(e.target.value)}
              placeholder="e.g. gpt-4o, claude-3.5-sonnet..."
              className="w-full bg-gray-900 border border-gray-600 rounded-lg px-4 py-2.5 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent font-mono text-sm"
            />
          </div>
        </div>

        <div className="flex justify-end gap-3 p-6 border-t border-gray-700 shrink-0 bg-gray-800 rounded-b-2xl">
          <button
            type="button"
            onClick={onClose}
            className="px-5 py-2.5 rounded-lg text-gray-300 hover:text-white hover:bg-gray-700 transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            className="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium transition-colors"
          >
            Save Provider
          </button>
        </div>
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
