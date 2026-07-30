import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X, Eye, EyeOff, Loader2, Wifi } from 'lucide-react';
import type { APIProvider, ApiType } from '../types';
import { newUuid } from '../lib/id';

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
  const [showKey, setShowKey] = useState(false);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [selectedModel, setSelectedModel] = useState('');
  const [customModel, setCustomModel] = useState('');
  const [supportsVision, setSupportsVision] = useState(false);
  const [error, setError] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<'ok' | 'fail' | null>(null);

  useEffect(() => {
    if (provider) {
      setName(provider.name);
      setBaseUrl(provider.baseUrl);
      setApiKey(provider.apiKey);
      setSource(provider.source ?? '');
      setApiType(provider.apiType ?? 'openai');
      setSupportsVision(!!provider.supportsVision);
      setModels(provider.models);
      setSelectedModel(provider.selectedModel);
    }
  }, [provider]);

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

  const fetchModels = async () => {
    if (!baseUrl || !apiKey) {
      setError('Please enter Base URL and API Key first');
      return;
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
        throw new Error(errData.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      const modelList = (data.models || []).sort();
      setModels(modelList);
      if (modelList.length > 0 && !selectedModel) {
        setSelectedModel(modelList[0]);
      }
    } catch (err: any) {
      setError(`Failed to fetch models: ${err.message}. Make sure Python backend (server.py) is running.`);
    } finally {
      setFetchingModels(false);
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
        models: finalModels,
        selectedModel: finalModel,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`保存失败: ${msg}`);
    }
  };

  const modal = (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[80] p-4 overflow-y-auto"
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
            <label className="block text-sm font-medium text-gray-300 mb-1.5">Base URL</label>
            <input
              type="text"
              value={baseUrl}
              onChange={e => setBaseUrl(e.target.value)}
              placeholder={apiType === 'anthropic' ? 'e.g. https://api.anthropic.com' : 'e.g. https://api.openai.com/v1'}
              className="w-full bg-gray-900 border border-gray-600 rounded-lg px-4 py-2.5 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent font-mono text-sm"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1.5">API Key</label>
            <div className="relative">
              <input
                type={showKey ? 'text' : 'password'}
                value={apiKey}
                onChange={e => setApiKey(e.target.value)}
                placeholder="sk-..."
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
