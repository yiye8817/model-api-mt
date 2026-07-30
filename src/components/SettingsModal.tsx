import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  X, Settings, Sliders, Globe2, RotateCcw, Loader2, Save, ExternalLink,
  Info, Plus, Trash2, AlertCircle, CheckCircle2, Cpu,
} from 'lucide-react';
import type {
  AppSettings, ModelParams, WebSearchSettings, WebSearchProviderId,
  WebSearchProviderInfo, APIProvider,
  ModelRolesSettings, ModelRoleId, ModelEndpointsSettings, ModelEndpointId,
  ModelRoleBinding, ModelEndpointBinding,
} from '../types';

interface Props {
  visible: boolean;
  onClose: () => void;
  onSaved?: (s: AppSettings) => void;
}

type Tab = 'model' | 'search' | 'roles';

const ROLE_META: { id: ModelRoleId; label: string; desc: string }[] = [
  { id: 'intent',         label: '基础意图分析模型', desc: '解析用户输入的意图（参考 yitu.txt），是「自动选模型」流程的入口。建议用快、便宜、稳定的模型。' },
  { id: 'chat_basic',     label: '基本对话模型',     desc: '日常问答、文字润色、工具调用、网页控制 等普通文本任务。' },
  { id: 'chat_advanced',  label: '复杂对话模型',     desc: '数据分析、复杂推理、长文本任务。' },
  { id: 'image_gen',      label: '图像生成模型',     desc: '"生成图片" 意图命中时使用，例如 dall-e-3 / sdxl 等图像生成模型。' },
  { id: 'vision',         label: '图片内容理解模型', desc: '"图文理解" 意图命中时使用，要求 provider 的 supportsVision = true。' },
  { id: 'code_simple',    label: '简单代码生成模型', desc: '小段脚本 / 单文件代码（complexity = 简单）。' },
  { id: 'code_advanced',  label: '复杂代码生成模型', desc: '工程化、含并发/网络/状态管理的代码（complexity = 复杂）。' },
  { id: 'web_search',     label: 'WebSearch 模型',   desc: '"讯息" 类意图：会自动开启联网搜索并调用此模型生成回答。' },
];

const ENDPOINT_META: { id: ModelEndpointId; label: string; desc: string; modelHint?: string }[] = [
  { id: 'tts',  label: 'TTS 接口', desc: '文本转语音（Text-to-Speech）。当前仅保存配置，后续接入会读取此处。',  modelHint: '例如 tts-1 / tts-1-hd' },
  { id: 'asr',  label: 'ASR 接口', desc: '语音转文本（Automatic Speech Recognition）。', modelHint: '例如 whisper-1' },
  { id: 'ocr',  label: 'OCR 接口', desc: '图片转文本。', modelHint: '例如 paddleocr / your-ocr-model' },
];

const PROVIDER_FIELDS: Record<WebSearchProviderId, { keys: { name: keyof NonNullable<WebSearchSettings['keys']>; label: string; placeholder?: string; password?: boolean }[] }> = {
  duckduckgo: { keys: [] },
  tavily: { keys: [{ name: 'tavily', label: 'Tavily API Key', placeholder: 'tvly-...', password: true }] },
  serper: { keys: [{ name: 'serper', label: 'Serper API Key', password: true }] },
  brave: { keys: [{ name: 'brave', label: 'Brave Subscription Token', password: true }] },
  bing: { keys: [{ name: 'bing', label: 'Bing v7 Subscription Key', password: true }] },
  google_cse: {
    keys: [
      { name: 'google_cse_key', label: 'Google API Key', password: true },
      { name: 'google_cse_cx', label: '搜索引擎 ID (cx)', placeholder: '0123456789abcdef:abc' },
    ],
  },
  searxng: { keys: [{ name: 'searxng_url', label: 'SearXNG 实例 URL', placeholder: 'https://your-searxng.example.com' }] },
};

// 模型参数说明（hover tooltip）
const PARAM_DOCS: Record<string, string> = {
  temperature: '采样温度（0–2）。越低越确定（接近贪婪），越高越发散。一般 0.2–0.7 适合分析、0.8–1.2 适合创意。',
  top_p: '核采样（0–1）。模型只从累计概率达到 top_p 的最高分 tokens 中采样。0.9 是常见默认。和 temperature 二选一调更直观。',
  max_tokens: '本次回复的最大 token 数。留空 = 由模型/服务端默认决定（避免被截断时设置）。',
  presence_penalty: '已出现 token 的惩罚（-2 到 2）。正值鼓励引入新话题；通常 0 或 0.2。',
  frequency_penalty: '高频 token 的惩罚（-2 到 2）。正值减少重复；通常 0 或 0.2。',
  seed: '固定随机种子（整数）。同样输入 + 同样种子能得到接近一致的输出，便于复现实验。留空 = 不固定。',
  stop: '停止序列（每行一个，最多 4 条）。一旦在生成中匹配到任意一个，立即截断。',
  system_prompt: '全局 system 提示，每次发送会自动注入到 messages 头部（前端如果已经有 system 消息则不会覆盖）。',
};

export default function SettingsModal({ visible, onClose, onSaved }: Props) {
  const [tab, setTab] = useState<Tab>('model');
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [providers, setProviders] = useState<WebSearchProviderInfo[]>([]);
  const [llmProviders, setLlmProviders] = useState<APIProvider[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string; sample?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [sR, pR, llmR] = await Promise.all([
        fetch('/api/settings').then(r => r.json()),
        fetch('/api/web-search/providers').then(r => r.json()).catch(() => ({ providers: [] })),
        fetch('/api/providers').then(r => r.ok ? r.json() : []).catch(() => []),
      ]);
      setSettings(sR);
      setProviders(pR.providers || []);
      setLlmProviders(Array.isArray(llmR) ? llmR : []);
    } catch (e: any) {
      setError(e?.message || '加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (visible) {
      setTab('model');
      setTestResult(null);
      void refresh();
    }
  }, [visible, refresh]);

  const handleSave = useCallback(async () => {
    if (!settings) return;
    setSaving(true);
    setError(null);
    try {
      const r = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || '保存失败');
      setSettings(j.settings || settings);
      onSaved?.(j.settings || settings);
    } catch (e: any) {
      setError(e?.message || '保存失败');
    } finally {
      setSaving(false);
    }
  }, [settings, onSaved]);

  const handleResetSection = useCallback(async (section: 'model_params' | 'web_search' | 'model_roles' | 'model_endpoints') => {
    const labelMap: Record<string, string> = {
      model_params: '模型参数',
      web_search: 'Web 搜索配置',
      model_roles: '默认模型角色配置',
      model_endpoints: 'TTS / ASR / OCR 端点配置',
    };
    if (!confirm(`确认重置${labelMap[section] || section}为默认值？`)) return;
    try {
      const r = await fetch('/api/settings/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ section }),
      });
      const j = await r.json();
      setSettings(j.settings);
      onSaved?.(j.settings);
    } catch (e: any) {
      setError(e?.message || '重置失败');
    }
  }, [onSaved]);

  const handleTestSearch = useCallback(async () => {
    if (!settings) return;
    setTesting(true);
    setTestResult(null);
    try {
      const r = await fetch('/api/web-search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: 'OpenAI 最新版本',
          provider: settings.web_search.provider,
          max_results: 3,
          fetch_full_content: false,
          // 用最新表单里的 key（即使尚未保存）
          keys: settings.web_search.keys,
          topic: settings.web_search.topic,
          preferred_sites: settings.web_search.preferred_sites,
        }),
      });
      const j = await r.json();
      if (!r.ok || j.error) {
        setTestResult({ ok: false, msg: j.error || `HTTP ${r.status}` });
      } else {
        const cnt = (j.results || []).length;
        const first = (j.results || [])[0];
        setTestResult({
          ok: true,
          msg: `成功，返回 ${cnt} 条结果（provider=${j.provider}）`,
          sample: first ? `${first.title}\n${first.url}` : undefined,
        });
      }
    } catch (e: any) {
      setTestResult({ ok: false, msg: e?.message || '测试失败' });
    } finally {
      setTesting(false);
    }
  }, [settings]);

  if (!visible) return null;

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-3xl max-h-[90vh] flex flex-col shadow-2xl">
        <div className="px-5 py-3.5 border-b border-gray-700 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            <Settings size={18} className="text-cyan-400" />
            <h2 className="text-base font-semibold text-white">通用设置</h2>
          </div>
          <button onClick={onClose} className="p-1.5 rounded text-gray-400 hover:text-white hover:bg-gray-700">
            <X size={16} />
          </button>
        </div>

        <div className="border-b border-gray-700 px-3 py-1.5 flex gap-1 shrink-0">
          {([
            { id: 'model', label: '模型参数', icon: Sliders },
            { id: 'roles', label: '默认模型', icon: Cpu },
            { id: 'search', label: 'Web 搜索', icon: Globe2 },
          ] as const).map(t => {
            const I = t.icon;
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-sm transition-colors ${
                  tab === t.id ? 'bg-gray-800 text-white' : 'text-gray-400 hover:text-white hover:bg-gray-800/50'
                }`}
              >
                <I size={14} /> {t.label}
              </button>
            );
          })}
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 text-sm text-gray-200">
          {error && (
            <div className="mb-3 bg-red-900/30 border border-red-500/40 text-red-200 rounded-lg px-3 py-2 text-xs flex items-start gap-2">
              <AlertCircle size={13} className="mt-0.5 shrink-0" /> <span className="whitespace-pre-wrap">{error}</span>
            </div>
          )}
          {loading || !settings ? (
            <div className="flex items-center gap-2 text-gray-500 text-xs"><Loader2 size={13} className="animate-spin" /> 加载中…</div>
          ) : tab === 'model' ? (
            <ModelParamsTab
              params={settings.model_params}
              onChange={(p) => setSettings({ ...settings, model_params: p })}
              onReset={() => handleResetSection('model_params')}
            />
          ) : tab === 'roles' ? (
            <ModelRolesTab
              roles={settings.model_roles}
              endpoints={settings.model_endpoints}
              llmProviders={llmProviders}
              onRolesChange={(r) => setSettings({ ...settings, model_roles: r })}
              onEndpointsChange={(e) => setSettings({ ...settings, model_endpoints: e })}
              onResetRoles={() => handleResetSection('model_roles')}
              onResetEndpoints={() => handleResetSection('model_endpoints')}
            />
          ) : (
            <WebSearchTab
              ws={settings.web_search}
              onChange={(w) => setSettings({ ...settings, web_search: w })}
              providers={providers}
              onReset={() => handleResetSection('web_search')}
              onTest={handleTestSearch}
              testing={testing}
              testResult={testResult}
            />
          )}
        </div>

        <div className="px-5 py-3 border-t border-gray-700 flex items-center justify-end gap-2 shrink-0">
          <button onClick={onClose} className="px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-sm">取消</button>
          <button
            onClick={handleSave}
            disabled={!settings || saving}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-cyan-600 hover:bg-cyan-500 disabled:bg-gray-700 text-white text-sm"
          >
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />} 保存
          </button>
        </div>
      </div>
    </div>
  );
}

// ============ 模型参数 Tab ============
function ModelParamsTab({
  params, onChange, onReset,
}: {
  params: ModelParams;
  onChange: (p: ModelParams) => void;
  onReset: () => void;
}) {
  const upd = (k: keyof ModelParams, v: any) => onChange({ ...params, [k]: v });
  const stopText = useMemo(() => (params.stop || []).join('\n'), [params.stop]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-xs text-gray-500">这些参数会在调用 LLM 时透传给 OpenAI 兼容接口；客户端不显式传则使用此处默认值。</div>
        <button onClick={onReset} className="flex items-center gap-1 text-xs text-gray-500 hover:text-amber-300">
          <RotateCcw size={11} /> 重置
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Slider
          label="temperature"
          tooltip={PARAM_DOCS.temperature}
          value={typeof params.temperature === 'number' ? params.temperature : 0.7}
          min={0} max={2} step={0.05}
          onChange={v => upd('temperature', v)}
        />
        <Slider
          label="top_p"
          tooltip={PARAM_DOCS.top_p}
          value={typeof params.top_p === 'number' ? params.top_p : 1}
          min={0} max={1} step={0.05}
          onChange={v => upd('top_p', v)}
        />
        <Slider
          label="presence_penalty"
          tooltip={PARAM_DOCS.presence_penalty}
          value={typeof params.presence_penalty === 'number' ? params.presence_penalty : 0}
          min={-2} max={2} step={0.1}
          onChange={v => upd('presence_penalty', v)}
        />
        <Slider
          label="frequency_penalty"
          tooltip={PARAM_DOCS.frequency_penalty}
          value={typeof params.frequency_penalty === 'number' ? params.frequency_penalty : 0}
          min={-2} max={2} step={0.1}
          onChange={v => upd('frequency_penalty', v)}
        />
        <NumInput
          label="max_tokens"
          tooltip={PARAM_DOCS.max_tokens}
          value={params.max_tokens ?? null}
          placeholder="留空=模型默认"
          onChange={v => upd('max_tokens', v)}
        />
        <NumInput
          label="seed"
          tooltip={PARAM_DOCS.seed}
          value={params.seed ?? null}
          placeholder="留空=不固定"
          onChange={v => upd('seed', v)}
        />
      </div>

      <div>
        <FieldLabel label="stop（每行一个，最多 4 条）" tooltip={PARAM_DOCS.stop} />
        <textarea
          value={stopText}
          onChange={e => upd('stop', e.target.value.split('\n').map(s => s.trim()).filter(Boolean).slice(0, 4))}
          rows={3}
          placeholder={'\\n\\n###\nUSER:\n[END]'}
          className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-xs font-mono"
        />
      </div>

      <div>
        <FieldLabel label="system_prompt（全局系统提示）" tooltip={PARAM_DOCS.system_prompt} />
        <textarea
          value={params.system_prompt || ''}
          onChange={e => upd('system_prompt', e.target.value)}
          rows={5}
          placeholder="例如：你是一个严谨的资深 Python 工程师，回答时请用中文，先给最佳实践再给完整代码。"
          className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-xs"
        />
      </div>
    </div>
  );
}

// ============ Web 搜索 Tab ============
function WebSearchTab({
  ws, onChange, providers, onReset, onTest, testing, testResult,
}: {
  ws: WebSearchSettings;
  onChange: (w: WebSearchSettings) => void;
  providers: WebSearchProviderInfo[];
  onReset: () => void;
  onTest: () => void;
  testing: boolean;
  testResult: { ok: boolean; msg: string; sample?: string } | null;
}) {
  const upd = (k: keyof WebSearchSettings, v: any) => onChange({ ...ws, [k]: v });
  const updKey = (k: keyof NonNullable<WebSearchSettings['keys']>, v: string) =>
    onChange({ ...ws, keys: { ...ws.keys, [k]: v } });
  const sitesText = useMemo(() => (ws.preferred_sites || []).join('\n'), [ws.preferred_sites]);

  const curProvider = providers.find(p => p.id === ws.provider);
  const fields = PROVIDER_FIELDS[ws.provider]?.keys || [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-xs text-gray-500">
          联网搜索时会按以下配置调用对应 provider，并把结果（含网页正文，可关闭）注入到 LLM 的 system 消息，回复底部展示引用。
        </div>
        <button onClick={onReset} className="flex items-center gap-1 text-xs text-gray-500 hover:text-amber-300">
          <RotateCcw size={11} /> 重置
        </button>
      </div>

      <div>
        <FieldLabel label="搜索 Provider" />
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {providers.map(p => (
            <button
              key={p.id}
              onClick={() => upd('provider', p.id)}
              disabled={!p.available}
              className={`text-left rounded border p-2 text-xs transition-colors ${
                ws.provider === p.id
                  ? 'border-cyan-500 bg-cyan-900/20 text-white'
                  : 'border-gray-700 bg-gray-800/40 hover:border-gray-500 text-gray-300 disabled:opacity-50'
              }`}
            >
              <div className="font-medium flex items-center gap-1.5">
                {p.name}
                {!p.available && <span className="text-amber-400 text-[10px]">(不可用)</span>}
              </div>
              {p.note && <div className="text-[10px] text-gray-500 mt-0.5 leading-relaxed">{p.note}</div>}
              {p.website && (
                <a
                  href={p.website} target="_blank" rel="noopener noreferrer"
                  onClick={e => e.stopPropagation()}
                  className="inline-flex items-center gap-1 mt-1 text-[10px] text-cyan-400 hover:text-cyan-300"
                >
                  申请 <ExternalLink size={9} />
                </a>
              )}
            </button>
          ))}
        </div>
        {curProvider?.note && (
          <div className="text-[11px] text-gray-500 mt-1.5 flex items-start gap-1">
            <Info size={11} className="mt-0.5 shrink-0" /> {curProvider.note}
          </div>
        )}
      </div>

      {fields.length > 0 && (
        <div className="space-y-2">
          <FieldLabel label="API 凭据" />
          <div className="grid grid-cols-1 gap-2 bg-gray-800/40 border border-gray-700 rounded-lg p-3">
            {fields.map(f => (
              <div key={f.name}>
                <div className="text-[11px] text-gray-500 mb-1">{f.label}</div>
                <input
                  type={f.password ? 'password' : 'text'}
                  value={(ws.keys?.[f.name] as string) || ''}
                  onChange={e => updKey(f.name, e.target.value)}
                  placeholder={f.placeholder}
                  className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-xs font-mono"
                />
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <FieldLabel
            label="主题/分类（topic）"
            tooltip="附加到搜索 query 的关键词。Tavily 支持 general/news/finance；其它 provider 会作为关键词追加。例如 'site research'、'news'。"
          />
          <input
            value={ws.topic || ''}
            onChange={e => upd('topic', e.target.value)}
            placeholder="例如 news / research / finance"
            className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-xs"
          />
        </div>
        <NumInput
          label="max_results"
          tooltip="单次搜索返回的最大结果数（1–15）。"
          value={ws.max_results ?? 6}
          min={1} max={15}
          onChange={v => upd('max_results', v ?? 6)}
        />
        <NumInput
          label="max_content_chars"
          tooltip="抓取每个网页时正文最多保留多少字符（控制送给 LLM 的上下文规模）。"
          value={ws.max_content_chars ?? 4000}
          min={500} max={20000}
          onChange={v => upd('max_content_chars', v ?? 4000)}
        />
        <Toggle
          label="抓取网页正文"
          tooltip="开启后会并发抓取每个搜索结果的网页正文（去广告/导航）注入给 LLM；关闭则只用搜索引擎给的 snippet。"
          value={!!ws.fetch_full_content}
          onChange={v => upd('fetch_full_content', v)}
        />
      </div>

      <div>
        <FieldLabel
          label="优先来源域名（每行一个，最多 5 条）"
          tooltip="会用 site:domain 过滤搜索；Tavily 走原生 include_domains。空 = 不限来源。"
        />
        <textarea
          value={sitesText}
          onChange={e => upd('preferred_sites', e.target.value.split('\n').map(s => s.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '')).filter(Boolean).slice(0, 5))}
          rows={3}
          placeholder={'arxiv.org\ngithub.com\nstackoverflow.com'}
          className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-xs font-mono"
        />
        {(ws.preferred_sites || []).length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1.5">
            {(ws.preferred_sites || []).map(s => (
              <span key={s} className="inline-flex items-center gap-1 bg-gray-800 border border-gray-700 rounded px-1.5 py-0.5 text-[10px] text-gray-300">
                {s}
                <button
                  onClick={() => upd('preferred_sites', (ws.preferred_sites || []).filter(x => x !== s))}
                  className="text-gray-500 hover:text-red-400"
                ><Trash2 size={9} /></button>
              </span>
            ))}
            <button
              onClick={() => {
                const v = prompt('添加优先来源域名（不带协议）：', '');
                if (v && v.trim()) {
                  const cleaned = v.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
                  if (!(ws.preferred_sites || []).includes(cleaned)) {
                    upd('preferred_sites', [...(ws.preferred_sites || []), cleaned].slice(0, 5));
                  }
                }
              }}
              className="inline-flex items-center gap-1 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded px-1.5 py-0.5 text-[10px] text-gray-400"
            ><Plus size={9} /> 添加</button>
          </div>
        )}
      </div>

      <div className="bg-gray-800/30 border border-gray-700 rounded-lg p-3 space-y-2">
        <div className="flex items-center justify-between">
          <div className="text-xs text-gray-400">连接测试 — 用当前 provider 和 key 试搜 "OpenAI 最新版本"</div>
          <button
            onClick={onTest}
            disabled={testing}
            className="flex items-center gap-1.5 px-3 py-1 rounded bg-cyan-600 hover:bg-cyan-500 disabled:bg-gray-700 text-white text-xs"
          >
            {testing ? <Loader2 size={11} className="animate-spin" /> : <Globe2 size={11} />} 测试
          </button>
        </div>
        {testResult && (
          <div className={`text-[11px] ${testResult.ok ? 'text-emerald-300' : 'text-red-300'}`}>
            {testResult.ok ? <CheckCircle2 size={11} className="inline mr-1" /> : <AlertCircle size={11} className="inline mr-1" />}
            {testResult.msg}
            {testResult.sample && (
              <div className="text-gray-500 mt-1 pl-4 whitespace-pre-wrap font-mono">{testResult.sample}</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ============ 小组件 ============
function FieldLabel({ label, tooltip }: { label: string; tooltip?: string }) {
  return (
    <div className="flex items-center gap-1 text-xs text-gray-400 mb-1">
      <span>{label}</span>
      {tooltip && (
        <span className="group relative">
          <Info size={11} className="text-gray-600 hover:text-gray-300 cursor-help" />
          <span className="hidden group-hover:block absolute left-0 top-full mt-1 z-10 bg-gray-950 border border-gray-700 rounded p-2 text-[11px] text-gray-300 max-w-xs w-max whitespace-pre-wrap shadow-lg">
            {tooltip}
          </span>
        </span>
      )}
    </div>
  );
}

function Slider({
  label, value, min, max, step, onChange, tooltip,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  tooltip?: string;
}) {
  return (
    <div>
      <div className="flex items-center justify-between">
        <FieldLabel label={label} tooltip={tooltip} />
        <span className="text-xs font-mono text-cyan-300">{value.toFixed(2)}</span>
      </div>
      <input
        type="range"
        min={min} max={max} step={step}
        value={value}
        onChange={e => onChange(parseFloat(e.target.value))}
        className="w-full accent-cyan-500"
      />
      <div className="flex justify-between text-[10px] text-gray-600 -mt-0.5">
        <span>{min}</span><span>{max}</span>
      </div>
    </div>
  );
}

function NumInput({
  label, value, onChange, min, max, placeholder, tooltip,
}: {
  label: string;
  value: number | null;
  onChange: (v: number | null) => void;
  min?: number; max?: number;
  placeholder?: string;
  tooltip?: string;
}) {
  return (
    <div>
      <FieldLabel label={label} tooltip={tooltip} />
      <input
        type="number"
        value={value ?? ''}
        min={min} max={max}
        onChange={e => {
          const s = e.target.value;
          if (s === '') onChange(null);
          else {
            const n = parseFloat(s);
            onChange(Number.isFinite(n) ? n : null);
          }
        }}
        placeholder={placeholder}
        className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-xs font-mono"
      />
    </div>
  );
}

function Toggle({
  label, value, onChange, tooltip,
}: { label: string; value: boolean; onChange: (v: boolean) => void; tooltip?: string }) {
  return (
    <div>
      <FieldLabel label={label} tooltip={tooltip} />
      <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer mt-1">
        <input type="checkbox" checked={value} onChange={e => onChange(e.target.checked)} className="accent-cyan-500" />
        {value ? '启用' : '关闭'}
      </label>
    </div>
  );
}

// ============ 默认模型 Tab ============
function ModelRolesTab({
  roles, endpoints, llmProviders,
  onRolesChange, onEndpointsChange,
  onResetRoles, onResetEndpoints,
}: {
  roles: ModelRolesSettings;
  endpoints: ModelEndpointsSettings;
  llmProviders: APIProvider[];
  onRolesChange: (r: ModelRolesSettings) => void;
  onEndpointsChange: (e: ModelEndpointsSettings) => void;
  onResetRoles: () => void;
  onResetEndpoints: () => void;
}) {
  const updRole = (id: ModelRoleId, patch: Partial<ModelRoleBinding>) =>
    onRolesChange({ ...roles, [id]: { ...roles[id], ...patch } });
  const updEndpoint = (id: ModelEndpointId, patch: Partial<ModelEndpointBinding>) =>
    onEndpointsChange({ ...endpoints, [id]: { ...endpoints[id], ...patch } });

  return (
    <div className="space-y-6">
      <div className="bg-gray-800/40 border border-gray-700 rounded-lg p-3">
        <div className="flex items-start gap-2 text-xs text-gray-400">
          <Info size={12} className="mt-0.5 shrink-0 text-cyan-400" />
          <div>
            「自动选模型」开启时，会先用 <span className="text-cyan-300 font-medium">基础意图分析模型</span> 解析用户输入（参考 <code className="text-amber-300">yitu.txt</code> 的提示词），
            然后按下表把对话路由到对应角色的模型。Provider 列表来自顶部「+ 添加模型」配置好的 LLM Provider。
          </div>
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <div className="text-xs text-gray-300 font-medium">角色 → Provider / 模型</div>
          <button onClick={onResetRoles} className="flex items-center gap-1 text-xs text-gray-500 hover:text-amber-300">
            <RotateCcw size={11} /> 重置
          </button>
        </div>

        {llmProviders.length === 0 && (
          <div className="bg-amber-900/20 border border-amber-700/40 text-amber-200 rounded-lg p-3 text-xs mb-2">
            还没有可用的 LLM Provider。请先在主界面侧边栏「+ 添加模型」中配置一个，再回到这里绑定。
          </div>
        )}

        <div className="bg-gray-900/40 border border-gray-700 rounded-lg divide-y divide-gray-800">
          {ROLE_META.map(meta => (
            <RoleRow
              key={meta.id}
              meta={meta}
              binding={roles[meta.id]}
              llmProviders={llmProviders}
              onChange={(patch) => updRole(meta.id, patch)}
            />
          ))}
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <div className="text-xs text-gray-300 font-medium">独立 OpenAI 兼容端点（TTS / ASR / OCR）</div>
          <button onClick={onResetEndpoints} className="flex items-center gap-1 text-xs text-gray-500 hover:text-amber-300">
            <RotateCcw size={11} /> 重置
          </button>
        </div>
        <div className="bg-gray-900/40 border border-gray-700 rounded-lg divide-y divide-gray-800">
          {ENDPOINT_META.map(meta => (
            <EndpointRow
              key={meta.id}
              meta={meta}
              binding={endpoints[meta.id]}
              onChange={(patch) => updEndpoint(meta.id, patch)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function RoleRow({
  meta, binding, llmProviders, onChange,
}: {
  meta: { id: ModelRoleId; label: string; desc: string };
  binding: ModelRoleBinding;
  llmProviders: APIProvider[];
  onChange: (patch: Partial<ModelRoleBinding>) => void;
}) {
  const cur = llmProviders.find(p => p.id === binding.providerId) || null;
  const models = cur?.models || [];
  const hasManualModel = !!binding.model && cur && !models.includes(binding.model);

  return (
    <div className="p-3 grid grid-cols-1 md:grid-cols-12 gap-2 items-start">
      <div className="md:col-span-4">
        <div className="text-xs text-gray-200 font-medium">{meta.label}</div>
        <div className="text-[11px] text-gray-500 mt-0.5 leading-relaxed">{meta.desc}</div>
      </div>
      <div className="md:col-span-4">
        <FieldLabel label="Provider" />
        <select
          value={binding.providerId}
          onChange={e => onChange({ providerId: e.target.value, model: '' })}
          className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-xs"
        >
          <option value="">— 未配置 —</option>
          {llmProviders.map(p => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </div>
      <div className="md:col-span-4">
        <FieldLabel label="Model" />
        {cur ? (
          <>
            <select
              value={hasManualModel ? '__manual__' : (binding.model || '')}
              onChange={e => {
                if (e.target.value === '__manual__') return;
                onChange({ model: e.target.value });
              }}
              className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-xs font-mono"
            >
              <option value="">— 选择模型 —</option>
              {models.map(m => <option key={m} value={m}>{m}</option>)}
              {hasManualModel && (
                <option value="__manual__">{binding.model}（自定义）</option>
              )}
            </select>
            <input
              type="text"
              value={binding.model}
              onChange={e => onChange({ model: e.target.value })}
              placeholder="也可手动输入模型名"
              className="w-full mt-1 bg-gray-900/60 border border-gray-700/60 rounded px-2 py-1 text-[11px] font-mono"
            />
          </>
        ) : (
          <input
            type="text"
            disabled
            placeholder="先选择 Provider"
            className="w-full bg-gray-900/40 border border-gray-700/60 rounded px-2 py-1.5 text-xs text-gray-600"
          />
        )}
      </div>
    </div>
  );
}

function EndpointRow({
  meta, binding, onChange,
}: {
  meta: { id: ModelEndpointId; label: string; desc: string; modelHint?: string };
  binding: ModelEndpointBinding;
  onChange: (patch: Partial<ModelEndpointBinding>) => void;
}) {
  return (
    <div className="p-3 grid grid-cols-1 md:grid-cols-12 gap-2 items-start">
      <div className="md:col-span-3">
        <div className="text-xs text-gray-200 font-medium">{meta.label}</div>
        <div className="text-[11px] text-gray-500 mt-0.5 leading-relaxed">{meta.desc}</div>
      </div>
      <div className="md:col-span-4">
        <FieldLabel label="Base URL" />
        <input
          type="text"
          value={binding.baseUrl}
          onChange={e => onChange({ baseUrl: e.target.value })}
          placeholder="https://api.openai.com/v1"
          className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-xs font-mono"
        />
      </div>
      <div className="md:col-span-3">
        <FieldLabel label="API Key" />
        <input
          type="password"
          value={binding.apiKey}
          onChange={e => onChange({ apiKey: e.target.value })}
          placeholder="sk-..."
          className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-xs font-mono"
        />
      </div>
      <div className="md:col-span-2">
        <FieldLabel label="Model" />
        <input
          type="text"
          value={binding.model}
          onChange={e => onChange({ model: e.target.value })}
          placeholder={meta.modelHint || ''}
          className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-xs font-mono"
        />
      </div>
    </div>
  );
}
