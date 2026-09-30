import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Send, Loader2, RefreshCw, FolderOpen, Plug, Zap, Bot,
  Search, Terminal, FileText, Wrench, CheckCircle2, CircleAlert, ExternalLink,
} from 'lucide-react';
import MarkdownRenderer from './MarkdownRenderer';
import DirPicker from './DirPicker';
import type { AutoInputRule } from '../types';

interface HermesProvider {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  apiType?: string;
}

type ChatItem =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string }
  | { kind: 'system'; id: string; text: string }
  | {
      kind: 'progress';
      id: string;
      phase: 'search' | 'command' | 'file' | 'tool';
      status: 'started' | 'completed' | 'error';
      title: string;
      tool: string;
      detail: string;
      urls: string[];
      duration?: number;
    };

interface Props {
  active: boolean;
  defaultCwd: string;
  repoDir?: string;
  provider?: HermesProvider | null;
  tabId?: string;
  onCwdChange?: (tabId: string, cwd: string) => void;
  onSessionInfo?: (tabId: string, info: { slashCommands: string[]; skills: string[] }) => void;
  injected?: { text: string; send: boolean; nonce: number } | null;
  onInjectedConsumed?: () => void;
  autoRules?: AutoInputRule[];
  autoRulesEnabled?: boolean;
  onRuleConsumed?: (ruleId: string) => void;
  onOpenUrl?: (url: string, title?: string) => void;
}

const WS_URL = (window.location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + window.location.host + '/ws-hermes';

let _idSeq = 0;
const nextId = () => `h${Date.now()}_${_idSeq++}`;

const urlTitle = (url: string) => {
  try { return new URL(url).hostname || url; } catch { return url; }
};

const progressIcon = (phase: 'search' | 'command' | 'file' | 'tool', size = 14) => {
  if (phase === 'search') return <Search size={size} />;
  if (phase === 'command') return <Terminal size={size} />;
  if (phase === 'file') return <FileText size={size} />;
  return <Wrench size={size} />;
};

export default function HermesChat({
  active, defaultCwd, repoDir, provider,
  tabId, onCwdChange, onSessionInfo, injected, onInjectedConsumed,
  onOpenUrl,
}: Props) {
  const [cwd, setCwd] = useState(defaultCwd);
  const [cwdDraft, setCwdDraft] = useState(defaultCwd);
  const [items, setItems] = useState<ChatItem[]>([]);
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const [connected, setConnected] = useState(false);
  const [launched, setLaunched] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [activeProvider, setActiveProvider] = useState<{ name?: string; model?: string; viaProxy?: boolean } | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const providerRef = useRef<HermesProvider | null>(provider ?? null);
  providerRef.current = provider ?? null;
  const providerKeyRef = useRef('');
  const onSessionInfoRef = useRef(onSessionInfo);
  onSessionInfoRef.current = onSessionInfo;

  useEffect(() => {
    if (tabId && cwd) onCwdChange?.(tabId, cwd);
  }, [tabId, cwd, onCwdChange]);

  const pushItem = useCallback((item: ChatItem) => {
    setItems((prev) => [...prev, item]);
  }, []);

  const connect = useCallback((targetCwd?: string, restart = false) => {
    const target = ((targetCwd ?? cwd) || '').trim() || defaultCwd;
    setCwd(target);
    setCwdDraft(target);
    try { wsRef.current?.close(); } catch { /* noop */ }
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;
    setConnected(false);
    ws.onopen = () => {
      setConnected(true);
      ws.send(JSON.stringify({
        type: 'start',
        cwd: target,
        provider: providerRef.current || undefined,
      }));
    };
    ws.onmessage = (e) => {
      try {
        const obj = JSON.parse(e.data);
        if (obj.type === 'started') {
          setActiveProvider({ name: obj.provider, model: obj.model, viaProxy: obj.viaProxy });
          if (restart) {
            pushItem({ kind: 'system', id: nextId(), text: `已重连 · ${obj.model || 'model'} · ${target}` });
          }
        } else if (obj.type === 'progress') {
          pushItem({
            kind: 'progress',
            id: nextId(),
            phase: ['search', 'command', 'file'].includes(obj.phase) ? obj.phase : 'tool',
            status: obj.status === 'error' ? 'error' : (obj.status === 'completed' ? 'completed' : 'started'),
            title: obj.title || '执行步骤',
            tool: obj.tool || '',
            detail: obj.detail || '',
            urls: Array.isArray(obj.urls) ? obj.urls.filter((url: unknown) => typeof url === 'string') : [],
            duration: typeof obj.duration === 'number' ? obj.duration : undefined,
          });
        } else if (obj.type === 'response') {
          pushItem({ kind: 'assistant', id: nextId(), text: obj.text || '' });
        } else if (obj.type === 'stderr') {
          pushItem({ kind: 'system', id: nextId(), text: obj.data || '' });
        } else if (obj.type === 'error') {
          pushItem({ kind: 'system', id: nextId(), text: `⚠ ${obj.error}` });
        } else if (obj.type === 'done') {
          setRunning(false);
        } else if (obj.type === 'exit') {
          setConnected(false);
          setRunning(false);
        }
      } catch { /* noop */ }
    };
    ws.onclose = () => { setConnected(false); setRunning(false); };
    ws.onerror = () => { setConnected(false); setRunning(false); };
  }, [cwd, defaultCwd, pushItem]);

  // 左侧切换 provider/模型时自动重连并应用新模型
  useEffect(() => {
    const key = `${provider?.name ?? ''}:${provider?.model ?? ''}`;
    if (!launched || !provider) return;
    if (providerKeyRef.current && providerKeyRef.current !== key) {
      connect(cwd, true);
    }
    providerKeyRef.current = key;
  }, [provider?.name, provider?.model, launched, cwd, connect]);

  useEffect(() => {
    if (!tabId) return;
    fetch('/api/hermes/skills')
      .then((r) => r.ok ? r.json() : { skills: [] })
      .then((d) => onSessionInfoRef.current?.(tabId, { slashCommands: [], skills: d.skills || [] }))
      .catch(() => onSessionInfoRef.current?.(tabId, { slashCommands: [], skills: [] }));
  }, [tabId, launched]);

  const launch = useCallback((dir?: string) => {
    const target = ((dir ?? cwdDraft) || '').trim() || defaultCwd;
    setLaunched(true);
    setCwd(target); setCwdDraft(target);
    connect(target, false);
  }, [cwdDraft, defaultCwd, connect]);

  const handlePickDir = useCallback((p: string) => {
    setShowPicker(false);
    if (launched) connect(p, true);
    else launch(p);
  }, [launched, connect, launch]);

  const sendText = useCallback((text: string) => {
    const t = (text || '').trim();
    if (!t) return;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      pushItem({ kind: 'system', id: nextId(), text: '⚠ 未连接，请先重连' });
      return;
    }
    pushItem({ kind: 'user', id: nextId(), text: t });
    setRunning(true);
    ws.send(JSON.stringify({ type: 'send', text: t, cwd, provider: providerRef.current || undefined }));
  }, [cwd, pushItem]);

  useEffect(() => {
    if (!injected) return;
    if (injected.send) sendText(injected.text);
    else setInput((v) => (v ? v + ' ' : '') + injected.text);
    onInjectedConsumed?.();
  }, [injected, sendText, onInjectedConsumed]);

  useEffect(() => {
    if (active && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [items, active]);

  useEffect(() => () => { try { wsRef.current?.close(); } catch { /* noop */ } }, []);

  const openUrl = useCallback((url: string) => {
    if (!/^https?:\/\//i.test(url)) return;
    if (onOpenUrl) {
      onOpenUrl(url, urlTitle(url));
      return;
    }
    try { window.open(url, '_blank', 'noopener,noreferrer'); } catch { /* noop */ }
  }, [onOpenUrl]);

  if (!launched) {
    return (
      <div className="flex flex-col h-full items-center justify-center bg-gray-900 text-gray-100 p-8">
        <div className="w-full max-w-lg bg-gray-850 border border-gray-700 rounded-xl p-5 space-y-3">
          <div className="flex items-center gap-2 text-amber-300 font-medium">
            <Bot size={18} /> 新建 Hermes（结构化对话）
          </div>
          <p className="text-xs text-gray-500">选择工作目录后启动 Hermes Agent 结构化对话。</p>
          <div className="flex items-center gap-2">
            <FolderOpen size={15} className="text-amber-400 shrink-0" />
            <input
              value={cwdDraft}
              onChange={(e) => setCwdDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') launch(); }}
              autoFocus
              className="flex-1 min-w-0 bg-gray-800 border border-gray-700 rounded px-2 py-1.5 font-mono text-xs focus:outline-none focus:border-amber-500"
              placeholder="项目根目录绝对路径"
            />
            <button onClick={() => setShowPicker(true)} className="flex items-center gap-1 px-2 py-1.5 rounded bg-gray-800 hover:bg-gray-700 border border-gray-700 text-xs shrink-0">
              <FolderOpen size={13} /> 浏览
            </button>
          </div>
          <div className="flex flex-wrap gap-2 text-xs">
            <button onClick={() => setCwdDraft(defaultCwd)} className="px-2 py-1 rounded bg-gray-800 hover:bg-gray-700 border border-gray-700">workspace</button>
            {repoDir && <button onClick={() => setCwdDraft(repoDir)} className="px-2 py-1 rounded bg-gray-800 hover:bg-gray-700 border border-gray-700">仓库</button>}
          </div>
          {provider && (
            <div className="text-[11px] text-gray-500">将使用：<span className="text-gray-300">{provider.name}</span> · {provider.model}</div>
          )}
          <button
            onClick={() => launch()}
            disabled={!cwdDraft.trim()}
            className="w-full flex items-center justify-center gap-1.5 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 disabled:opacity-40 text-white text-sm font-medium"
          >
            <Send size={14} /> 启动 Hermes
          </button>
        </div>
        {showPicker && <DirPicker initialDir={cwdDraft || defaultCwd} onSelect={handlePickDir} onClose={() => setShowPicker(false)} title="选择工作目录（Hermes）" />}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden bg-gray-900 text-gray-100">
      <div className="shrink-0 border-b border-gray-700 px-3 py-2 flex items-center gap-2 text-xs flex-wrap">
        <Bot size={14} className="text-amber-400 shrink-0" />
        <FolderOpen size={14} className="text-amber-400 shrink-0" />
        <input
          value={cwdDraft}
          onChange={(e) => setCwdDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') connect(cwdDraft.trim() || cwd, true); }}
          className="flex-1 min-w-0 bg-gray-800 border border-gray-700 rounded px-2 py-1 font-mono text-[11px] focus:outline-none focus:border-amber-500"
        />
        <button onClick={() => setShowPicker(true)} className="px-2 py-1 rounded bg-gray-800 hover:bg-gray-700 border border-gray-700">浏览</button>
        <button onClick={() => connect(cwdDraft.trim() || cwd, true)} className="px-2 py-1 rounded bg-gray-800 hover:bg-gray-700 border border-gray-700">应用</button>
        {activeProvider?.viaProxy ? (
          <span className="flex items-center gap-1 text-amber-300 px-1.5 py-0.5 rounded bg-amber-900/30 border border-amber-700/40">
            <Zap size={11} /> {activeProvider.name} · {activeProvider.model}
          </span>
        ) : activeProvider ? (
          <span className="text-gray-500">{activeProvider.model || 'hermes'}</span>
        ) : null}
        <span className={`flex items-center gap-1 ${connected ? 'text-emerald-400' : 'text-gray-500'}`}>
          <Plug size={12} /> {connected ? '已连接' : '未连接'}
        </span>
        <button onClick={() => connect(cwd, true)} className="p-1 rounded hover:bg-gray-700" title="重连（应用当前模型）">
          <RefreshCw size={13} />
        </button>
      </div>
      <div className="shrink-0 border-b border-gray-800 px-3 py-1 text-[11px] flex items-center gap-1.5 bg-gray-850/40">
        <span className="text-gray-500">工作目录：</span>
        <span className="font-mono text-gray-300 truncate" title={cwd}>{cwd}</span>
      </div>
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto overscroll-contain p-4 space-y-4">
        {items.map((it) => (
          <div key={it.id} className={it.kind === 'user' ? 'text-right' : ''}>
            {it.kind === 'user' && <div className="inline-block text-left bg-amber-900/30 border border-amber-700/40 rounded-lg px-3 py-2 text-sm max-w-[85%]">{it.text}</div>}
            {it.kind === 'assistant' && (
              <div className="min-w-0 overflow-hidden prose prose-invert prose-sm max-w-none">
                <MarkdownRenderer content={it.text} onOpenUrl={openUrl} />
              </div>
            )}
            {it.kind === 'system' && <div className="text-xs text-gray-500 font-mono whitespace-pre-wrap">{it.text}</div>}
            {it.kind === 'progress' && (
              <div className={'max-w-[92%] rounded-lg border px-3 py-2 text-xs ' + (
                it.status === 'error'
                  ? 'border-red-800/60 bg-red-950/20'
                  : it.status === 'completed'
                    ? 'border-emerald-800/50 bg-emerald-950/15'
                    : 'border-amber-800/50 bg-amber-950/15'
              )}>
                <div className="flex items-center gap-2">
                  <span className={it.status === 'error' ? 'text-red-400' : it.status === 'completed' ? 'text-emerald-400' : 'text-amber-400'}>
                    {it.status === 'completed' ? <CheckCircle2 size={14} /> : it.status === 'error' ? <CircleAlert size={14} /> : progressIcon(it.phase)}
                  </span>
                  <span className="font-medium text-gray-200">{it.title}</span>
                  {it.tool && <code className="text-[10px] text-gray-500">{it.tool}</code>}
                  {it.duration !== undefined && it.duration > 0 && <span className="ml-auto text-[10px] text-gray-600">{it.duration.toFixed(1)}s</span>}
                </div>
                {it.detail && (
                  <div className="mt-1.5 max-h-32 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-gray-400">
                    {it.detail}
                  </div>
                )}
                {it.urls.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {it.urls.map((url) => (
                      <button
                        key={url}
                        type="button"
                        onClick={() => openUrl(url)}
                        title={url}
                        className="flex max-w-full items-center gap-1 rounded border border-blue-800/60 bg-blue-950/30 px-2 py-1 text-blue-300 hover:bg-blue-900/40"
                      >
                        <ExternalLink size={11} className="shrink-0" />
                        <span className="truncate">{urlTitle(url)}</span>
                        <span className="shrink-0 text-[10px] text-blue-500">新标签打开</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
        {running && <div className="flex items-center gap-2 text-amber-300 text-sm"><Loader2 size={14} className="animate-spin" /> Hermes 正在处理…</div>}
      </div>
      <div className="shrink-0 border-t border-gray-700 p-2 flex gap-2">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); const t = input.trim(); if (t) { sendText(t); setInput(''); } } }}
          rows={2}
          placeholder="输入消息…（右侧可插入命令/Skill）"
          className="flex-1 bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm resize-none focus:outline-none focus:border-amber-500"
        />
        <button
          onClick={() => { const t = input.trim(); if (t) { sendText(t); setInput(''); } }}
          disabled={running || !input.trim()}
          className="px-3 rounded-lg bg-amber-600 hover:bg-amber-500 disabled:opacity-40 text-white"
        >
          <Send size={16} />
        </button>
      </div>
      {showPicker && <DirPicker initialDir={cwdDraft || cwd} onSelect={handlePickDir} onClose={() => setShowPicker(false)} title="选择工作目录（Hermes）" />}
    </div>
  );
}
