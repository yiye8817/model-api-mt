import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Send, Square, Loader2, RefreshCw, FolderOpen, Wrench,
  ChevronRight, AlertTriangle, CheckCircle2, Plug, Hammer, XCircle, Sparkles, Zap,
} from 'lucide-react';
import MarkdownRenderer from './MarkdownRenderer';
import DirPicker from './DirPicker';
import { ensureClaudeLatest } from '../lib/claudeVersion';
import { buildAllCommands, CMD_TO_NL, CLAUDE_COMMAND_ORDER, getCommandDesc, sortClaudeCommands } from '../lib/claudeCommands';
import type { AutoInputRule } from '../types';

interface ToolCall {
  id: string;
  name: string;
  input: any;
  result?: string;
  isError?: boolean;
}

type ChatItem =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string }
  | { kind: 'tool'; id: string; call: ToolCall }
  | { kind: 'result'; id: string; ok: boolean; text: string; costUsd?: number; durationMs?: number; numTurns?: number }
  | { kind: 'system'; id: string; text: string };

interface SessionInfo {
  sessionId?: string;
  model?: string;
  tools?: string[];
  slashCommands?: string[];
  skills?: string[];
  cwd?: string;
}

interface ClaudeProvider {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  apiType?: string;
}

interface Props {
  active: boolean;
  defaultCwd: string;
  repoDir?: string;
  provider?: ClaudeProvider | null;
  /** 标签页 id，用于把会话命令上报给右侧面板。 */
  tabId?: string;
  /** 上报当前会话的 slash 命令 / skills（来自 system/init）。 */
  onSessionInfo?: (tabId: string, info: { slashCommands: string[]; skills: string[] }) => void;
  /** 工作目录变更时上报，供左侧文件管理器跟随。 */
  onCwdChange?: (tabId: string, cwd: string) => void;
  /** 右侧面板注入的命令/文本（send=true 时直接发送）。 */
  injected?: { text: string; send: boolean; nonce: number } | null;
  onInjectedConsumed?: () => void;
  /** SP6：输出自动应答规则与总开关。 */
  autoRules?: AutoInputRule[];
  autoRulesEnabled?: boolean;
  /** once 规则命中后回调（用于父级关闭该规则）。 */
  onRuleConsumed?: (ruleId: string) => void;
}

const WS_URL = (window.location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + window.location.host + '/ws-claude';

let _idSeq = 0;
const nextId = () => `c${Date.now()}_${_idSeq++}`;

function normalizeResultContent(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (typeof b === 'string' ? b : b?.text ?? (b?.type === 'image' ? '[image]' : JSON.stringify(b))))
      .join('\n');
  }
  if (content == null) return '';
  return typeof content === 'object' ? JSON.stringify(content, null, 2) : String(content);
}

export default function ClaudeChat({
  active, defaultCwd, repoDir, provider,
  tabId, onSessionInfo, onCwdChange, injected, onInjectedConsumed,
  autoRules, autoRulesEnabled, onRuleConsumed,
}: Props) {
  const [cwd, setCwd] = useState(defaultCwd);
  const [cwdDraft, setCwdDraft] = useState(defaultCwd);
  const [items, setItems] = useState<ChatItem[]>([]);
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const [connected, setConnected] = useState(false);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [stderrLog, setStderrLog] = useState<string[]>([]);
  const [showStderr, setShowStderr] = useState(false);
  /** 是否已启动会话：未启动时先展示「选择工作目录」引导，点启动后才连接。 */
  const [launched, setLaunched] = useState(false);
  /** GUI 目录选择器开关。 */
  const [showPicker, setShowPicker] = useState(false);
  /** 启动前版本检测/更新的状态文案；非空时表示正在检测/更新。 */
  const [verMsg, setVerMsg] = useState('');
  const [preparing, setPreparing] = useState(false);
  const [activeProvider, setActiveProvider] = useState<{ name?: string; model?: string; viaProxy?: boolean } | null>(null);

  // 斜杠命令补全（终端式）
  const [showCmdMenu, setShowCmdMenu] = useState(false);
  const [cmdIndex, setCmdIndex] = useState(0);

  const wsRef = useRef<WebSocket | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const providerRef = useRef<ClaudeProvider | null>(provider ?? null);
  providerRef.current = provider ?? null;

  // SP6：自动应答用的 refs（避免回调里读到过期闭包）
  const autoRulesRef = useRef<AutoInputRule[]>(autoRules ?? []);
  autoRulesRef.current = autoRules ?? [];
  const autoEnabledRef = useRef<boolean>(!!autoRulesEnabled);
  autoEnabledRef.current = !!autoRulesEnabled;
  const onRuleConsumedRef = useRef(onRuleConsumed);
  onRuleConsumedRef.current = onRuleConsumed;

  useEffect(() => {
    if (tabId && cwd) onCwdChange?.(tabId, cwd);
  }, [tabId, cwd, onCwdChange]);
  /** 当前这一轮 Claude 输出累计的 assistant 文本（用于规则匹配）。 */
  const turnTextRef = useRef('');
  /** 连续自动应答计数（无人工输入时），防止规则相互触发造成死循环。 */
  const autoFireCountRef = useRef(0);
  /** 已触发过的 once 规则 id。 */
  const firedOnceRef = useRef<Set<string>>(new Set());
  const sendTextRef = useRef<(text: string, isAuto?: boolean) => void>(() => {});

  // 可用命令：完整内置列表（常用优先）+ init 下发的 slash_commands 与 skills
  const allCommands = buildAllCommands(session?.slashCommands, session?.skills);

  const slashQuery = (() => {
    if (!input.startsWith('/')) return null;
    const rest = input.slice(1);
    if (/\s/.test(rest)) return null;   // 已经在输入参数
    return rest;
  })();

  const filteredCmds = (() => {
    if (slashQuery === null) return [];
    const q = slashQuery.toLowerCase();
    const matched = allCommands.filter((c) => c.toLowerCase().includes(q));
    matched.sort((a, b) => {
      const as = a.toLowerCase().startsWith(q) ? 0 : 1;
      const bs = b.toLowerCase().startsWith(q) ? 0 : 1;
      if (as !== bs) return as - bs;
      return sortClaudeCommands([a, b])[0] === a ? -1 : 1;
    });
    return matched;
  })();

  const acceptCommand = useCallback((cmd: string) => {
    setInput('/' + cmd + ' ');
    setShowCmdMenu(false);
    setCmdIndex(0);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, []);

  const pushItem = useCallback((item: ChatItem) => {
    setItems((prev) => [...prev, item]);
  }, []);

  const attachToolResult = useCallback((toolUseId: string, text: string, isError: boolean) => {
    setItems((prev) =>
      prev.map((it) =>
        it.kind === 'tool' && it.call.id === toolUseId
          ? { ...it, call: { ...it.call, result: text, isError } }
          : it
      )
    );
  }, []);

  const handleEvent = useCallback((evt: any) => {
    const t = evt?.type;
    if (t === 'system' && evt.subtype === 'init') {
      const slashCommands = evt.slash_commands || [];
      const skills = evt.skills || [];
      setSession({
        sessionId: evt.session_id,
        model: evt.model,
        tools: evt.tools,
        slashCommands,
        skills,
        cwd: evt.cwd,
      });
      if (tabId && onSessionInfo) onSessionInfo(tabId, { slashCommands, skills });
      pushItem({ kind: 'system', id: nextId(), text: `已连接 · ${evt.model || 'model'} · ${evt.cwd || ''}` });
      return;
    }
    if (t === 'assistant') {
      const blocks = evt?.message?.content;
      if (Array.isArray(blocks)) {
        for (const b of blocks) {
          if (b?.type === 'text' && (b.text ?? '').trim()) {
            turnTextRef.current += '\n' + b.text;
            pushItem({ kind: 'assistant', id: nextId(), text: b.text });
          } else if (b?.type === 'tool_use') {
            pushItem({ kind: 'tool', id: nextId(), call: { id: b.id, name: b.name, input: b.input } });
          }
        }
      }
      if (evt?.error) {
        const msg = normalizeResultContent(evt?.message?.content) || String(evt.error);
        if (/login|logged in|authentication/i.test(msg)) setAuthError(msg);
      }
      return;
    }
    if (t === 'user') {
      const blocks = evt?.message?.content;
      if (Array.isArray(blocks)) {
        for (const b of blocks) {
          if (b?.type === 'tool_result') {
            attachToolResult(b.tool_use_id, normalizeResultContent(b.content), !!b.is_error);
          }
        }
      }
      return;
    }
    if (t === 'result') {
      const text = evt.result || '';
      if (evt.is_error && /login|logged in|authentication/i.test(text)) setAuthError(text);
      pushItem({
        kind: 'result',
        id: nextId(),
        ok: !evt.is_error,
        text: evt.is_error ? text : '',
        costUsd: evt.total_cost_usd,
        durationMs: evt.duration_ms,
        numTurns: evt.num_turns,
      });
      setRunning(false);
      // SP6：本轮结束 → 评估自动应答规则
      const turnText = (turnTextRef.current || '') + '\n' + (evt.is_error ? '' : text);
      turnTextRef.current = '';
      if (!evt.is_error && autoEnabledRef.current && autoFireCountRef.current < 10) {
        for (const rule of autoRulesRef.current) {
          if (!rule.enabled || !rule.keyword.trim() || !rule.reply.trim()) continue;
          if (rule.once && firedOnceRef.current.has(rule.id)) continue;
          let hit = false;
          try {
            hit = rule.useRegex
              ? new RegExp(rule.keyword, 'i').test(turnText)
              : turnText.toLowerCase().includes(rule.keyword.toLowerCase());
          } catch { hit = false; }
          if (hit) {
            if (rule.once) {
              firedOnceRef.current.add(rule.id);
              onRuleConsumedRef.current?.(rule.id);
            }
            autoFireCountRef.current += 1;
            pushItem({ kind: 'system', id: nextId(), text: `⚡ 自动应答（命中「${rule.keyword}」）` });
            setTimeout(() => sendTextRef.current(rule.reply, true), 300);
            break;
          }
        }
      }
      return;
    }
  }, [pushItem, attachToolResult, tabId, onSessionInfo]);

  const connect = useCallback((targetCwd: string, clear: boolean) => {
    try { wsRef.current?.close(); } catch { /* noop */ }
    if (clear) {
      setItems([]);
      setSession(null);
      setAuthError(null);
      setStderrLog([]);
    }
    setConnected(false);
    setRunning(false);
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;
    ws.onopen = () => {
      setConnected(true);
      ws.send(JSON.stringify({ type: 'start', cwd: targetCwd, provider: providerRef.current || undefined }));
    };
    ws.onmessage = (e) => {
      let obj: any;
      try { obj = JSON.parse(e.data); } catch { return; }
      switch (obj.type) {
        case 'started':
          setConnected(true);
          setActiveProvider({ name: obj.provider, model: obj.model, viaProxy: obj.viaProxy });
          break;
        case 'event': handleEvent(obj.event); break;
        case 'stderr': setStderrLog((p) => [...p.slice(-200), obj.data]); break;
        case 'exit': setConnected(false); setRunning(false); break;
        case 'error':
          pushItem({ kind: 'system', id: nextId(), text: `⚠ ${obj.error}` });
          setRunning(false);
          break;
        case 'pong': break;
        default: break;
      }
    };
    ws.onclose = () => { setConnected(false); setRunning(false); };
    ws.onerror = () => { setConnected(false); };
  }, [handleEvent, pushItem]);

  useEffect(() => {
    return () => { try { wsRef.current?.close(); } catch { /* noop */ } };
  }, []);

  const launch = useCallback(async (dir?: string) => {
    const target = ((dir ?? cwdDraft) || '').trim() || defaultCwd;
    setPreparing(true);
    await ensureClaudeLatest(setVerMsg);
    setPreparing(false);
    setCwd(target);
    setCwdDraft(target);
    setLaunched(true);
    connect(target, true);
  }, [cwdDraft, defaultCwd, connect]);

  /** 目录选择器选定回调：选定即「直接进入」——未启动则直接以该目录启动，已启动则切换并重连。 */
  const handlePickDir = useCallback((p: string) => {
    setShowPicker(false);
    if (launched) { setCwd(p); setCwdDraft(p); connect(p, true); }
    else { launch(p); }
  }, [launched, connect, launch]);

  useEffect(() => {
    if (active && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [items, active]);

  const sendText = useCallback((rawText: string, isAuto = false) => {
    const text = (rawText || '').trim();
    if (!text) return;

    // 本地命令拦截：headless（stream-json）后端不支持 Claude 的交互式 slash 命令
    //（/help、/model、/memory…），直接发会得到 "isn't available in this environment."。
    // 仅当命令不在「本会话真实下发的命令/skills」里时才本地处理；真实命令照常发给 Claude。
    const slash = text.match(/^\/([\w-]+)\s*$/);
    if (slash) {
      const cmd = slash[1];
      const sessionCmds = new Set([...(session?.slashCommands || []), ...(session?.skills || [])]);
      if (!sessionCmds.has(cmd)) {
        // ① 纯本地命令（无需发给 Claude）
        if (cmd === 'help' || cmd === 'model' || cmd === 'clear') {
          if (!isAuto) autoFireCountRef.current = 0;
          pushItem({ kind: 'user', id: nextId(), text });
          if (cmd === 'help') {
            const sess = sortClaudeCommands([...(session?.slashCommands || [])]);
            const sk = sortClaudeCommands([...(session?.skills || [])]);
            const interactive = CLAUDE_COMMAND_ORDER.filter((c) => !sessionCmds.has(c));
            const md =
              `**本会话可用命令**（直接发给 Claude）\n\n` +
              (sess.length ? sess.map((c) => `\`/${c}\``).join(' ') : '（无）') +
              (sk.length ? `\n\n**Skills**\n\n` + sk.map((c) => `\`/${c}\``).join(' ') : '') +
              `\n\n**内置命令**（常用优先，headless 下部分会转为自然语言）\n\n` +
              interactive.slice(0, 40).map((c) => `\`/${c}\``).join(' ') +
              (interactive.length > 40 ? `\n… 共 ${interactive.length} 个，输入 \`/\` 查看完整列表` : '') +
              `\n\n> 提示：headless 模式下也可直接用自然语言下达指令。`;
            pushItem({ kind: 'assistant', id: nextId(), text: md });
          } else if (cmd === 'model') {
            const m = activeProvider?.model || session?.model || '(未知)';
            const via = activeProvider?.viaProxy ? ` · 经代理使用 provider「${activeProvider?.name || ''}」` : '';
            pushItem({ kind: 'system', id: nextId(), text: `当前模型：${m}${via}（如需切换，请在左侧选择 provider/模型后点「重连」）` });
          } else {
            setItems([]);
            pushItem({ kind: 'system', id: nextId(), text: '已清空本地消息（如需重置 Claude 会话上下文，请点右上角「重连」）。' });
          }
          return;
        }

        // ② 交互式命令 → 转等价自然语言后正常发给 Claude
        const nl = CMD_TO_NL[cmd] || `请执行与 Claude 命令 /${cmd} 等价的操作。`;
        const ws = wsRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          pushItem({ kind: 'system', id: nextId(), text: '⚠ 未连接，请先点重连' });
          return;
        }
        if (!isAuto) autoFireCountRef.current = 0;
        turnTextRef.current = '';
        pushItem({ kind: 'user', id: nextId(), text });
        pushItem({ kind: 'system', id: nextId(), text: `↪ /${cmd} 在 headless 模式不可用，已转为自然语言发送：${nl}` });
        ws.send(JSON.stringify({ type: 'send', text: nl, cwd, provider: providerRef.current || undefined }));
        setRunning(true);
        return;
      }
    }

    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      pushItem({ kind: 'system', id: nextId(), text: '⚠ 未连接，请先点重连' });
      return;
    }
    // 人工发送会重置连续自动应答计数；自动发送则保留计数（防死循环）
    if (!isAuto) autoFireCountRef.current = 0;
    turnTextRef.current = '';
    pushItem({ kind: 'user', id: nextId(), text });
    ws.send(JSON.stringify({ type: 'send', text, cwd, provider: providerRef.current || undefined }));
    setRunning(true);
  }, [cwd, pushItem, session, activeProvider]);
  sendTextRef.current = sendText;

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text) return;
    sendText(text);
    setInput('');
  }, [input, sendText]);

  // 右侧面板注入命令/文本
  const lastInjectedNonce = useRef<number>(0);
  useEffect(() => {
    if (!injected || injected.nonce === lastInjectedNonce.current) return;
    lastInjectedNonce.current = injected.nonce;
    if (injected.send) {
      sendText(injected.text);
    } else {
      setInput((prev) => (prev ? prev + injected.text : injected.text));
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
    onInjectedConsumed?.();
  }, [injected, sendText, onInjectedConsumed]);

  const handleStop = useCallback(() => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'interrupt' }));
    setRunning(false);
  }, []);

  const applyCwd = useCallback(() => {
    const next = cwdDraft.trim();
    if (!next || next === cwd) return;
    setCwd(next);
    connect(next, true);
  }, [cwdDraft, cwd, connect]);

  if (!launched) {
    return (
      <div className="flex flex-col h-full items-center justify-center bg-gray-900 text-gray-100 p-8">
        <div className="w-full max-w-lg bg-gray-850 border border-gray-700 rounded-xl p-5 space-y-3">
          <div className="flex items-center gap-2 text-purple-300 font-medium">
            <Sparkles size={18} /> 新建 Claude Code（结构化对话）
          </div>
          <p className="text-xs text-gray-500">请先选择工作目录（项目根目录），确认后再启动 Claude Code。</p>
          <div className="flex items-center gap-2">
            <FolderOpen size={15} className="text-amber-400 shrink-0" />
            <input
              value={cwdDraft}
              onChange={(e) => setCwdDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') launch(); }}
              autoFocus
              className="flex-1 min-w-0 bg-gray-800 border border-gray-700 rounded px-2 py-1.5 font-mono text-xs focus:outline-none focus:border-purple-500"
              placeholder="项目根目录绝对路径"
            />
            <button onClick={() => setShowPicker(true)} className="flex items-center gap-1 px-2 py-1.5 rounded bg-gray-800 hover:bg-gray-700 border border-gray-700 text-xs shrink-0" title="浏览选择目录">
              <FolderOpen size={13} /> 浏览
            </button>
          </div>
          <div className="flex flex-wrap gap-2 text-xs">
            <button onClick={() => setCwdDraft(defaultCwd)} className="px-2 py-1 rounded bg-gray-800 hover:bg-gray-700 border border-gray-700" title={defaultCwd}>workspace</button>
            {repoDir && <button onClick={() => setCwdDraft(repoDir)} className="px-2 py-1 rounded bg-gray-800 hover:bg-gray-700 border border-gray-700" title={repoDir}>仓库</button>}
          </div>
          {provider && (
            <div className="text-[11px] text-gray-500">将使用 provider：<span className="text-gray-300">{provider.name}</span> · {provider.model}</div>
          )}
          <button
            onClick={() => launch()}
            disabled={!cwdDraft.trim() || preparing}
            className="w-full flex items-center justify-center gap-1.5 py-2 rounded-lg bg-purple-600 hover:bg-purple-500 disabled:opacity-40 text-white text-sm font-medium"
          >
            {preparing ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
            {preparing ? '准备中…' : '启动 Claude Code'}
          </button>
          {verMsg && <div className="text-[11px] text-gray-400 text-center">{verMsg}</div>}
        </div>
        {showPicker && (
          <DirPicker initialDir={cwdDraft || defaultCwd} onSelect={handlePickDir} onClose={() => setShowPicker(false)} />
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-gray-900 text-gray-100">
      {/* 顶部工具条：工作目录 + 连接状态 */}
      <div className="shrink-0 border-b border-gray-700 px-3 py-2 flex items-center gap-2 text-xs">
        <FolderOpen size={14} className="text-amber-400 shrink-0" />
        <input
          value={cwdDraft}
          onChange={(e) => setCwdDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') applyCwd(); }}
          className="flex-1 min-w-0 bg-gray-800 border border-gray-700 rounded px-2 py-1 font-mono text-[11px] focus:outline-none focus:border-purple-500"
          placeholder="项目根目录"
        />
        <button onClick={() => setShowPicker(true)} className="px-2 py-1 rounded bg-gray-800 hover:bg-gray-700 border border-gray-700 flex items-center gap-1" title="浏览选择目录"><FolderOpen size={12} />浏览</button>
        <button onClick={applyCwd} className="px-2 py-1 rounded bg-gray-800 hover:bg-gray-700 border border-gray-700">应用</button>
        <button
          onClick={() => { setCwdDraft(defaultCwd); setCwd(defaultCwd); connect(defaultCwd, true); }}
          className="px-2 py-1 rounded bg-gray-800 hover:bg-gray-700 border border-gray-700"
          title="workspace"
        >workspace</button>
        {repoDir && (
          <button
            onClick={() => { setCwdDraft(repoDir); setCwd(repoDir); connect(repoDir, true); }}
            className="px-2 py-1 rounded bg-gray-800 hover:bg-gray-700 border border-gray-700"
            title={repoDir}
          >仓库</button>
        )}
        {activeProvider?.viaProxy ? (
          <span className="flex items-center gap-1 text-purple-300 px-1.5 py-0.5 rounded bg-purple-900/30 border border-purple-700/40" title={`经本地代理使用 provider：${activeProvider.name || ''}`}>
            <Sparkles size={11} /> {activeProvider.name || 'provider'} · {activeProvider.model || ''}
          </span>
        ) : activeProvider ? (
          <span className="text-gray-500" title="使用 Claude Code 自身登录">{activeProvider.model || 'claude 登录态'}</span>
        ) : null}
        {autoRulesEnabled && (autoRules?.some((r) => r.enabled)) && (
          <span className="flex items-center gap-1 text-amber-300 px-1.5 py-0.5 rounded bg-amber-900/30 border border-amber-700/40" title="已开启输出自动应答">
            <Zap size={11} /> 自动
          </span>
        )}
        <span className={`flex items-center gap-1 ${connected ? 'text-emerald-400' : 'text-gray-500'}`}>
          <Plug size={12} /> {connected ? '已连接' : '未连接'}
        </span>
        <button onClick={() => connect(cwd, true)} className="p-1 rounded hover:bg-gray-700" title="重连/重置会话（应用当前 provider）">
          <RefreshCw size={13} />
        </button>
      </div>

      {/* 当前生效的工作目录（切换后实时显示完整路径） */}
      <div className="shrink-0 border-b border-gray-800 px-3 py-1 text-[11px] flex items-center gap-1.5 bg-gray-850/40">
        <FolderOpen size={11} className="text-amber-400/80 shrink-0" />
        <span className="text-gray-500 shrink-0">工作目录：</span>
        <span className="font-mono text-gray-300 truncate" title={session?.cwd || cwd}>{session?.cwd || cwd || '(未设置)'}</span>
        {connected && session?.cwd && (
          <CheckCircle2 size={11} className="text-emerald-500/80 shrink-0 ml-auto" />
        )}
      </div>

      {authError && (
        <div className="shrink-0 bg-amber-900/40 border-b border-amber-700/50 text-amber-200 px-3 py-2 text-xs flex items-start gap-2">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>Claude Code 未登录或鉴权失败：请在终端运行 <code className="bg-black/30 px-1 rounded">claude /login</code> 或设置 <code className="bg-black/30 px-1 rounded">ANTHROPIC_API_KEY</code> 后点重连。</span>
        </div>
      )}

      {/* 消息区 */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
        {items.length === 0 && (
          <div className="text-gray-500 text-sm text-center mt-10">
            在下方输入消息，与 Claude Code 交互。工具调用会自动放行（bypass）。
          </div>
        )}
        {items.map((it) => {
          if (it.kind === 'user') {
            return (
              <div key={it.id} className="flex justify-end">
                <div className="max-w-[85%] bg-purple-600/90 text-white rounded-lg px-3 py-2 text-sm whitespace-pre-wrap">{it.text}</div>
              </div>
            );
          }
          if (it.kind === 'assistant') {
            return (
              <div key={it.id} className="flex justify-start">
                <div className="max-w-[92%] bg-gray-800 rounded-lg px-3 py-2 text-sm overflow-hidden">
                  <MarkdownRenderer content={it.text} />
                </div>
              </div>
            );
          }
          if (it.kind === 'tool') return <ToolCard key={it.id} call={it.call} />;
          if (it.kind === 'result') {
            return (
              <div key={it.id} className="flex items-center gap-2 text-[11px] text-gray-500 justify-center">
                {it.ok ? <CheckCircle2 size={12} className="text-emerald-500" /> : <XCircle size={12} className="text-red-500" />}
                <span>
                  {it.ok ? '回合完成' : '出错'}
                  {typeof it.numTurns === 'number' ? ` · ${it.numTurns} turns` : ''}
                  {typeof it.durationMs === 'number' ? ` · ${(it.durationMs / 1000).toFixed(1)}s` : ''}
                  {typeof it.costUsd === 'number' && it.costUsd > 0 ? ` · $${it.costUsd.toFixed(4)}` : ''}
                </span>
                {!it.ok && it.text && <span className="text-red-400">— {it.text.slice(0, 200)}</span>}
              </div>
            );
          }
          return (
            <div key={it.id} className="text-[11px] text-gray-500 text-center">{it.text}</div>
          );
        })}
        {running && (
          <div className="flex items-center gap-2 text-xs text-amber-300">
            <Loader2 size={13} className="animate-spin" /> Claude 处理中…
          </div>
        )}
      </div>

      {/* stderr 折叠 */}
      {stderrLog.length > 0 && (
        <div className="shrink-0 border-t border-gray-800 px-3 py-1 text-[11px] text-gray-500">
          <button onClick={() => setShowStderr((v) => !v)} className="flex items-center gap-1 hover:text-gray-300">
            <ChevronRight size={11} className={`transition-transform ${showStderr ? 'rotate-90' : ''}`} />
            stderr ({stderrLog.length})
          </button>
          {showStderr && (
            <pre className="mt-1 max-h-32 overflow-auto bg-black/40 rounded p-2 whitespace-pre-wrap">{stderrLog.join('\n')}</pre>
          )}
        </div>
      )}

      {/* 输入区 */}
      <div className="shrink-0 border-t border-gray-700 p-2">
        <div className="flex items-end gap-2">
          <div className="flex-1 relative">
            {/* 斜杠命令补全菜单 */}
            {showCmdMenu && filteredCmds.length > 0 && (
              <div className="absolute bottom-full mb-1 left-0 right-0 max-h-80 overflow-y-auto bg-gray-800 border border-gray-600 rounded-lg shadow-xl z-20 py-1">
                <div className="px-3 py-1 text-[10px] text-gray-500 border-b border-gray-700/60 sticky top-0 bg-gray-800">
                  Claude Code 命令 · 共 {filteredCmds.length} 个（↑↓ 选择，Enter/Tab 选用，Esc 关闭）
                </div>
                {filteredCmds.map((cmd, i) => {
                  const isSkill = (session?.skills || []).includes(cmd);
                  const desc = getCommandDesc(cmd);
                  return (
                    <button
                      key={cmd}
                      onMouseDown={(e) => { e.preventDefault(); acceptCommand(cmd); }}
                      onMouseEnter={() => setCmdIndex(i)}
                      className={`w-full text-left px-3 py-1.5 text-sm flex items-center gap-2 min-w-0 ${i === cmdIndex ? 'bg-purple-600/40 text-white' : 'text-gray-200 hover:bg-gray-700/60'}`}
                    >
                      <span className="text-purple-300 font-mono shrink-0">/{cmd}</span>
                      {desc && <span className="text-gray-500 text-xs truncate">{desc}</span>}
                      {isSkill && <span className="ml-auto shrink-0 text-[9px] px-1 rounded bg-sky-900/50 text-sky-300 border border-sky-700/40">skill</span>}
                    </button>
                  );
                })}
              </div>
            )}
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => {
                const v = e.target.value;
                setInput(v);
                if (v.startsWith('/') && !/\s/.test(v.slice(1))) { setShowCmdMenu(true); setCmdIndex(0); }
                else setShowCmdMenu(false);
              }}
              onKeyDown={(e) => {
                const menuOpen = showCmdMenu && filteredCmds.length > 0;
                if (menuOpen) {
                  if (e.key === 'ArrowDown') { e.preventDefault(); setCmdIndex((i) => (i + 1) % filteredCmds.length); return; }
                  if (e.key === 'ArrowUp') { e.preventDefault(); setCmdIndex((i) => (i - 1 + filteredCmds.length) % filteredCmds.length); return; }
                  if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); const c = filteredCmds[cmdIndex] ?? filteredCmds[0]; if (c) acceptCommand(c); return; }
                  if (e.key === 'Escape') { e.preventDefault(); setShowCmdMenu(false); return; }
                }
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); setShowCmdMenu(false); handleSend(); }
              }}
              rows={2}
              placeholder="给 Claude Code 发消息…（Enter 发送，Shift+Enter 换行；输入 / 查看命令）"
              className="w-full resize-none bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-purple-500"
            />
          </div>
          {running ? (
            <button onClick={handleStop} className="flex items-center gap-1 px-3 py-2 rounded-lg bg-red-600 hover:bg-red-500 text-white text-sm font-medium">
              <Square size={13} className="fill-current" /> 停止
            </button>
          ) : (
            <button onClick={handleSend} disabled={!input.trim()} className="flex items-center gap-1 px-3 py-2 rounded-lg bg-purple-600 hover:bg-purple-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium">
              <Send size={13} /> 发送
            </button>
          )}
        </div>
      </div>

      {showPicker && (
        <DirPicker initialDir={cwdDraft || cwd || defaultCwd} onSelect={handlePickDir} onClose={() => setShowPicker(false)} />
      )}
    </div>
  );
}

function ToolCard({ call }: { call: ToolCall }) {
  const [open, setOpen] = useState(false);
  const inputStr = (() => {
    try { return typeof call.input === 'string' ? call.input : JSON.stringify(call.input, null, 2); }
    catch { return String(call.input); }
  })();
  const pending = call.result === undefined;
  return (
    <div className="flex justify-start">
      <div className="max-w-[92%] w-full border border-gray-700 bg-gray-800/60 rounded-lg overflow-hidden">
        <button onClick={() => setOpen((v) => !v)} className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left hover:bg-gray-700/50">
          <ChevronRight size={12} className={`transition-transform ${open ? 'rotate-90' : ''}`} />
          {pending ? <Hammer size={12} className="text-amber-400 animate-pulse" /> : (call.isError ? <XCircle size={12} className="text-red-400" /> : <Wrench size={12} className="text-emerald-400" />)}
          <span className="font-mono font-medium text-gray-200">{call.name}</span>
          <span className="text-gray-500 truncate flex-1">{firstLine(inputStr)}</span>
          {pending && <span className="text-amber-400">运行中…</span>}
        </button>
        {open && (
          <div className="px-3 pb-2 space-y-2">
            <div>
              <div className="text-[10px] uppercase text-gray-500 mb-1">输入</div>
              <pre className="text-[11px] bg-black/40 rounded p-2 overflow-auto max-h-48 whitespace-pre-wrap">{inputStr}</pre>
            </div>
            {call.result !== undefined && (
              <div>
                <div className="text-[10px] uppercase text-gray-500 mb-1">{call.isError ? '错误结果' : '结果'}</div>
                <pre className={`text-[11px] rounded p-2 overflow-auto max-h-64 whitespace-pre-wrap ${call.isError ? 'bg-red-950/40 text-red-200' : 'bg-black/40'}`}>{call.result || '(空)'}</pre>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function firstLine(s: string): string {
  const line = (s || '').split('\n')[0] || '';
  return line.length > 80 ? line.slice(0, 80) + '…' : line;
}
