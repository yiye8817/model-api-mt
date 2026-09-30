import { useCallback, useEffect, useRef, useState } from 'react';
import { Bot, FolderOpen, Plug, RefreshCw, Terminal as TerminalIcon, Wand2 } from 'lucide-react';
import DirPicker from './DirPicker';
import { bindTermClipboard } from '../lib/termClipboard';
import { registerTerminalLinkProvider, terminalLinkHandler } from '../lib/terminalLinks';
import { getDesktop } from '../lib/desktopBridge';

const AUTOPICK_KEY = 'hermesTerm/autoPick';
const AUTOPICK_STRATEGY_KEY = 'hermesTerm/autoPickStrategy';
type AutoPickStrategy = 'highlight' | 'affirmative';
/** 肯定项关键词（用于 affirmative 策略，优先选 Yes/继续/信任 等）。 */
const AFFIRMATIVE_RE = /\b(yes|proceed|continue|trust|confirm|accept|approve|allow|enable)\b/i;
/** 否定项关键词（避免把 No/取消 当成肯定项）。 */
const NEGATIVE_RE = /\b(no|don'?t|cancel|reject|deny|exit|quit|skip|abort)\b/i;
/** y/n 风格确认提示。 */
const YN_RE = /\(\s*y\s*\/\s*n\s*\)|\[\s*y\s*\/\s*n\s*\]/i;
/** ink select 菜单的强标志：方向键提示。 */
const ARROW_HINT_RE = /\(\s*use arrow keys\s*\)/i;
/** 常见确认/选择问题文案。 */
const PROMPT_RE = /(do you (trust|want)\b|press enter to (confirm|continue)|select an option|choose an option|是否(信任|继续|允许))/i;
const ARROW_UP = '\x1b[A';
const ARROW_DOWN = '\x1b[B';

type ParsedOpt = { label: string; hl: boolean; num?: number };

/** 解析单行是否为选项（支持 > / ❯ 高亮 + 编号，或无编号的是/否项）。 */
function parseOptionLine(ln: string): ParsedOpt | null {
  const t = ln.trim();
  if (!t) return null;
  // 编号选项：> 1. Yes / ❯ 2) No / 1. Yes
  let m = t.match(/^(?:([>❯])\s*)?(\d+)[.)]\s*(.+)$/);
  if (m) return { hl: !!m[1], num: parseInt(m[2], 10), label: m[3].trim() };
  // 无编号但高亮的短选项（如 ❯ Yes）
  m = t.match(/^([>❯])\s+(.+)$/);
  if (m) {
    const label = m[2].trim();
    if (label.length <= 40 && (AFFIRMATIVE_RE.test(label) || NEGATIVE_RE.test(label))) {
      return { hl: true, label };
    }
  }
  // 无高亮标记的短是/否行（与另一条选项组成菜单）
  if (t.length <= 40 && (AFFIRMATIVE_RE.test(t) || NEGATIVE_RE.test(t)) && !/\d+[.)]/.test(t)) {
    return { hl: false, label: t };
  }
  return null;
}

/** 从最近输出行中提取选项列表（去重保序）。 */
function collectOptions(recent: string[]): ParsedOpt[] {
  const opts: ParsedOpt[] = [];
  const seen = new Set<string>();
  for (const ln of recent) {
    const o = parseOptionLine(ln);
    if (!o) continue;
    const key = `${o.num ?? ''}:${o.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    opts.push(o);
  }
  return opts;
}

/** 去除 ANSI / 终端控制序列，便于文本匹配。 */
function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\x1b[\]P][\s\S]*?(\x07|\x1b\\)/g, '')
    .replace(/\x1b[=>]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
}

/**
 * 从 PTY 输出提取「逻辑行」。
 * ink 菜单常用 \r 原地刷新而不换行，仅 split('\n') 会把多行选项合并成一行导致匹配失败。
 */
function extractRecentLines(raw: string): string[] {
  const text = stripAnsi(raw);
  const lines: string[] = [];
  for (const row of text.split(/\r?\n/)) {
    const parts = row.split('\r').map((p) => p.trim()).filter(Boolean);
    if (!parts.length) continue;
    // 保留 \r 覆写前的片段（可能是尚未被覆盖的选项行）
    if (parts.length > 1) lines.push(...parts.slice(0, -1));
    lines.push(parts[parts.length - 1]);
  }
  return lines.slice(-40);
}

/**
 * 根据当前屏幕文本和策略，决定要向 PTY 发送的输入。
 * 返回 { data, sig }；sig 基于选项文本（不含动画/光标），用于去重但不漏触发。
 *
 * 关键：输入提示符本身就是 `❯`。若把对话里的编号列表/问句误判成菜单，
 * 在输入态仍发回车或方向键，会提交当前行或调出上一条指令并执行。因此：
 *   - 处于输入提示（裸 ❯ / 正在输入）时一律不动作；
 *   - 仅在 ink 选择菜单（方向键提示或带高亮的选项行）或 (y/n) 时才应答。
 */
function decideAutoInput(raw: string, strategy: AutoPickStrategy): { data: string; sig: string } | null {
  const recent = extractRecentLines(raw);
  if (!recent.length) return null;
  const joined = recent.join('\n');
  const last = recent[recent.length - 1]?.trim() || '';

  // 菜单高亮行：`❯ 1. Yes` / `❯ Allow`；其余以 ❯ 开头的视为输入提示或用户正在输入
  const isMenuOptionLine = /^[❯>]\s*\d+[.)]\s+\S/.test(last)
    || (/^[❯>]\s+\S/.test(last) && (AFFIRMATIVE_RE.test(last) || NEGATIVE_RE.test(last)));
  const atInputPrompt = !isMenuOptionLine && (/^❯/.test(last) || last === '>');
  if (atInputPrompt) return null;

  const opts = collectOptions(recent);
  const isYN = YN_RE.test(joined);
  const isYesNoPair = opts.length >= 2 && opts.every((o) => AFFIRMATIVE_RE.test(o.label) || NEGATIVE_RE.test(o.label));
  const hasHighlight = opts.some((o) => o.hl);
  const hasArrowHint = ARROW_HINT_RE.test(joined);
  // 必须有方向键提示，或带高亮光标的真实选项；避免把对话中的编号列表当菜单
  const isSelectMenu = hasArrowHint
    || (hasHighlight && opts.length >= 2)
    || (hasHighlight && isYesNoPair)
    || (hasHighlight && PROMPT_RE.test(joined) && opts.length >= 1);

  if (!isSelectMenu && !isYN) return null;

  const sigBase = opts.length ? opts.map((o) => o.label).join('|') : (isYN ? 'yn' : joined.slice(-120));
  const sig = sigBase.replace(/\s+/g, ' ').trim().slice(-200);

  if (strategy === 'highlight') {
    if (isSelectMenu) return { data: '\r', sig };
    if (isYN) return { data: 'y\r', sig };
    return null;
  }

  // affirmative：仅在选择菜单上用方向键导航；y/n 则回 y
  if (isSelectMenu && opts.length) {
    let target = opts.findIndex((o) => AFFIRMATIVE_RE.test(o.label) && !NEGATIVE_RE.test(o.label));
    if (target < 0) target = 0;
    const cur = opts.findIndex((o) => o.hl);
    const effectiveCur = cur >= 0 ? cur : 0;
    const delta = target - effectiveCur;
    if (delta === 0) return { data: '\r', sig };
    // 无方向键提示且无高亮时不要发方向键（输入框里 Up 会调出历史指令）
    if (!hasArrowHint && !hasHighlight) return null;
    const key = delta > 0 ? ARROW_DOWN : ARROW_UP;
    return { data: key.repeat(Math.abs(delta)) + '\r', sig };
  }
  if (isSelectMenu) return { data: '\r', sig };
  if (isYN) return { data: 'y\r', sig };
  return null;
}

interface HermesProvider {
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
  /** Route a terminal path to a browser tab or the OS default app. */
  onOpenPath?: (path: string, cwd?: string) => void;
  onOpenUrl?: (url: string, title?: string) => void;
  provider?: HermesProvider | null;
  /** 标签页 id，用于上报工作目录等状态。 */
  tabId?: string;
  /** 工作目录变更时上报，供左侧文件管理器跟随。 */
  onCwdChange?: (tabId: string, cwd: string) => void;
  /** 右侧命令/Skill 面板注入到 PTY 的内容（send=true 时附带回车立即执行）。 */
  injected?: { text: string; send: boolean; nonce: number } | null;
  onInjectedConsumed?: () => void;
}

const WS_URL = (window.location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + window.location.host + '/ws-hermes-term';

export default function HermesTerminal({ active, defaultCwd, repoDir, onOpenPath, onOpenUrl, provider, tabId, onCwdChange, injected, onInjectedConsumed }: Props) {
  const [cwd, setCwd] = useState(defaultCwd);
  const [cwdDraft, setCwdDraft] = useState(defaultCwd);
  const [connected, setConnected] = useState(false);
  const [info, setInfo] = useState<{ provider?: string; model?: string; viaProxy?: boolean } | null>(null);
  const [reconnectNonce, setReconnectNonce] = useState(0);
  /** 是否已启动：未启动时先展示「选择工作目录」引导，点启动后才连接 PTY。 */
  const [launched, setLaunched] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  /** 自动选择推荐项：检测到 claude 弹出选择菜单时自动回车选当前高亮（推荐）项。 */
  const [autoPick, setAutoPick] = useState(() => {
    try { return localStorage.getItem(AUTOPICK_KEY) === '1'; } catch { return false; }
  });
  const autoPickRef = useRef(autoPick);
  autoPickRef.current = autoPick;
  /** 自动应答策略：highlight=回车选高亮；affirmative=优先选 Yes/1 等肯定项。 */
  const [autoStrategy, setAutoStrategy] = useState<AutoPickStrategy>(() => {
    try { return localStorage.getItem(AUTOPICK_STRATEGY_KEY) === 'affirmative' ? 'affirmative' : 'highlight'; } catch { return 'highlight'; }
  });
  const autoStrategyRef = useRef(autoStrategy);
  autoStrategyRef.current = autoStrategy;

  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<any>(null);
  const fitRef = useRef<any>(null);
  const wsRef = useRef<WebSocket | null>(null);
  // 当前/下一次连接要使用的工作目录。仅由 launch/reconnect 显式更新，
  // 不在每次渲染时同步 cwd 状态——否则异步（xterm 动态导入 + WebSocket onopen）
  // 期间发生的重渲染会把它重置成旧的 cwd，导致后端回退到默认 workspace。
  const cwdRef = useRef(cwd);
  const providerRef = useRef<HermesProvider | null>(provider ?? null);
  providerRef.current = provider ?? null;
  const providerKeyRef = useRef('');
  // 切换模型时，下一次连接复用最近一次会话（--continue），保留当前对话上下文。
  const continueRef = useRef(false);

  // 自动应答：滚动输出缓冲 + 防抖 + 持续输出兜底 + 防循环
  const outBufRef = useRef('');
  const pickTimerRef = useRef<number | null>(null);
  const pendingSinceRef = useRef(0);
  const lastSigRef = useRef('');
  const lastPickAtRef = useRef(0);
  const autoCountRef = useRef(0);

  /** 检查是否处于「等待选择」，是则按策略发送应答。 */
  const runAutoPick = useCallback(() => {
    pendingSinceRef.current = 0;
    if (pickTimerRef.current) { window.clearTimeout(pickTimerRef.current); pickTimerRef.current = null; }
    if (!autoPickRef.current) return;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const res = decideAutoInput(outBufRef.current, autoStrategyRef.current);
    if (!res) {
      lastSigRef.current = '';
      return;
    }
    const now = Date.now();
    if (res.sig === lastSigRef.current && now - lastPickAtRef.current < 2500) return;
    if (autoCountRef.current >= 8) return;
    lastSigRef.current = res.sig;
    lastPickAtRef.current = now;
    autoCountRef.current += 1;
    ws.send(JSON.stringify({ type: 'input', data: res.data }));
  }, []);

  /**
   * 喂入一段 PTY 输出文本，始终累积缓冲；开启时调度检查。
   * 短防抖（280ms 静默即评估）保证响应；同时设最长等待兜底（持续快速输出时
   * 也会在 ~900ms 后强制评估一次），避免菜单出现时被连续重绘“饿死”而漏触发。
   */
  const feedAutoPick = useCallback((text: string) => {
    outBufRef.current = (outBufRef.current + text).slice(-6000);
    if (!autoPickRef.current) return;
    const now = Date.now();
    if (pendingSinceRef.current === 0) pendingSinceRef.current = now;
    if (now - pendingSinceRef.current >= 900) {
      runAutoPick();
      return;
    }
    if (pickTimerRef.current) window.clearTimeout(pickTimerRef.current);
    pickTimerRef.current = window.setTimeout(runAutoPick, 280);
  }, [runAutoPick]);
  const feedRef = useRef(feedAutoPick);
  feedRef.current = feedAutoPick;

  useEffect(() => {
    if (tabId && cwd) onCwdChange?.(tabId, cwd);
  }, [tabId, cwd, onCwdChange]);

  // 连接 / 重连：每次 nonce 变化重建 xterm + WebSocket
  useEffect(() => {
    if (reconnectNonce === 0) return;
    let cancelled = false;
    let ro: ResizeObserver | null = null;

    let unbindClipboard: (() => void) | null = null;
    let linkDisposable: { dispose: () => void } | null = null;
    (async () => {
      await import('xterm/css/xterm.css');
      const [xtermMod, fitMod] = await Promise.all([import('xterm'), import('xterm-addon-fit')]);
      const Term = xtermMod.Terminal;
      const FitAddon = (fitMod as any).FitAddon ?? (fitMod as any).default;
      const el = containerRef.current;
      if (cancelled || !el) return;

      const openTerminalTarget = (target: string) => {
        const desktop = getDesktop();
        if (/^https?:\/\//i.test(target)) {
          if (onOpenUrl) onOpenUrl(target);
          else if (desktop) void desktop.openExternal(target);
          else window.open(target, '_blank', 'noopener,noreferrer');
          return;
        }
        onOpenPath?.(target, cwdRef.current || defaultCwd);
      };

      // 清理旧实例
      try { wsRef.current?.close(); } catch { /* noop */ }
      try { termRef.current?.dispose(); } catch { /* noop */ }

      const term = new Term({
        fontFamily: 'ui-monospace, "Cascadia Code", "JetBrains Mono", monospace',
        fontSize: 13,
        lineHeight: 1.25,
        cursorBlink: true,
        scrollback: 8000,
        rightClickSelectsWord: false,
        theme: { background: '#1a1408', foreground: '#e2e8f0', cursor: '#f59e0b', selectionBackground: 'rgba(245,158,11,0.25)' },
        linkHandler: terminalLinkHandler(openTerminalTarget),
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(el);
      try { fit.fit(); } catch { /* noop */ }
      termRef.current = term;
      fitRef.current = fit;

      linkDisposable = registerTerminalLinkProvider(term, link => openTerminalTarget(link.text));

      const ws = new WebSocket(WS_URL);
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      const sendInput = (data: string) => {
        autoCountRef.current = 0;
        lastSigRef.current = '';
        lastPickAtRef.current = 0;
        pendingSinceRef.current = 0;
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data }));
      };
      unbindClipboard = bindTermClipboard(term, sendInput);

      ws.onopen = () => {
        if (cancelled) return;
        setConnected(true);
        ws.send(JSON.stringify({
          type: 'start',
          cwd: cwdRef.current || defaultCwd,
          provider: providerRef.current || undefined,
          continue: continueRef.current,
          cols: term.cols,
          rows: term.rows,
        }));
        continueRef.current = false;
        term.onData((data: string) => {
          sendInput(data);
        });
        term.onResize(({ cols, rows }: { cols: number; rows: number }) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols, rows }));
        });
      };
      ws.onmessage = (e: MessageEvent) => {
        if (cancelled) return;
        if (typeof e.data === 'string') {
          try {
            const obj = JSON.parse(e.data);
            if (obj.type === 'started') setInfo({ provider: obj.provider, model: obj.model, viaProxy: obj.viaProxy });
            else if (obj.type === 'exit') { setConnected(false); term.write('\r\n\x1b[33m[hermes 进程已退出，点右上角重连]\x1b[0m\r\n'); }
            else if (obj.type === 'error') term.write(`\r\n\x1b[31m${obj.error}\x1b[0m\r\n`);
          } catch { /* noop */ }
          return;
        }
        const bytes = e.data instanceof ArrayBuffer ? new Uint8Array(e.data) : null;
        if (bytes) {
          term.write(bytes);
          try { feedRef.current(new TextDecoder().decode(bytes)); } catch { /* noop */ }
        }
      };
      ws.onclose = () => { if (!cancelled) setConnected(false); };
      ws.onerror = () => { if (!cancelled) setConnected(false); };

      ro = new ResizeObserver(() => { try { fit.fit(); } catch { /* noop */ } });
      ro.observe(el);
    })();

    // 新连接：清空自动应答的状态
    outBufRef.current = '';
    lastSigRef.current = '';
    autoCountRef.current = 0;
    lastPickAtRef.current = 0;
    pendingSinceRef.current = 0;

    return () => {
      cancelled = true;
      ro?.disconnect();
      try { unbindClipboard?.(); } catch { /* noop */ }
      try { linkDisposable?.dispose(); } catch { /* noop */ }
      if (pickTimerRef.current) { window.clearTimeout(pickTimerRef.current); pickTimerRef.current = null; }
      try { wsRef.current?.close(); } catch { /* noop */ }
      try { termRef.current?.dispose(); } catch { /* noop */ }
      termRef.current = null;
      wsRef.current = null;
    };
  }, [reconnectNonce, onOpenPath, onOpenUrl]);

  // 标签从隐藏切到可见时重新适配尺寸并聚焦
  useEffect(() => {
    if (active && termRef.current) {
      requestAnimationFrame(() => {
        try { fitRef.current?.fit(); } catch { /* noop */ }
        try { termRef.current?.focus(); } catch { /* noop */ }
      });
    }
  }, [active]);

  // 右侧命令 / Skill 面板注入：把文本写进 PTY，send=true 时附带回车立即执行。
  const onConsumedRef = useRef(onInjectedConsumed);
  onConsumedRef.current = onInjectedConsumed;
  useEffect(() => {
    if (!injected) return;
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      const data = injected.send ? injected.text + '\r' : injected.text;
      ws.send(JSON.stringify({ type: 'input', data }));
      try { termRef.current?.focus(); } catch { /* noop */ }
    }
    onConsumedRef.current?.();
  }, [injected]);

  // 左侧切换 provider/模型时自动重连并续接会话
  useEffect(() => {
    const key = `${provider?.name ?? ''}:${provider?.model ?? ''}`;
    if (!launched || !provider || reconnectNonce === 0) return;
    if (providerKeyRef.current && providerKeyRef.current !== key) {
      providerRef.current = provider;
      continueRef.current = true;
      try { termRef.current?.write(`\r\n\x1b[33m[切换模型 → ${provider.name} · ${provider.model}，续接当前会话…]\x1b[0m\r\n`); } catch { /* noop */ }
      setReconnectNonce((n) => n + 1);
    }
    providerKeyRef.current = key;
  }, [provider?.name, provider?.model, launched, reconnectNonce, provider]);

  const reconnect = useCallback((nextCwd?: string) => {
    if (nextCwd !== undefined) { setCwd(nextCwd); setCwdDraft(nextCwd); cwdRef.current = nextCwd; }
    setReconnectNonce((n) => n + 1);
  }, []);

  const launch = useCallback((dir?: string) => {
    const target = ((dir ?? cwdDraft) || '').trim() || defaultCwd;
    setCwd(target); setCwdDraft(target); cwdRef.current = target;
    setLaunched(true);
    setReconnectNonce((n) => n + 1);
  }, [cwdDraft, defaultCwd]);

  // 在选择器里选定目录后「直接进入」：未启动则直接以该目录启动，已启动则切换并重连。
  const handlePickDir = useCallback((p: string) => {
    setShowPicker(false);
    if (launched) reconnect(p);
    else launch(p);
  }, [launched, reconnect, launch]);

  const applyCwd = useCallback(() => {
    const next = cwdDraft.trim();
    if (!next) return;
    reconnect(next);
  }, [cwdDraft, reconnect]);

  const toggleAutoPick = useCallback(() => {
    setAutoPick((v) => {
      const next = !v;
      try { localStorage.setItem(AUTOPICK_KEY, next ? '1' : '0'); } catch { /* noop */ }
      if (next) {
        // 开启后只对后续新输出应答；清空旧缓冲，避免用历史对话误触发回车/方向键
        outBufRef.current = '';
        lastSigRef.current = '';
        autoCountRef.current = 0;
        lastPickAtRef.current = 0;
        pendingSinceRef.current = 0;
        if (pickTimerRef.current) {
          window.clearTimeout(pickTimerRef.current);
          pickTimerRef.current = null;
        }
      }
      return next;
    });
  }, [runAutoPick]);

  const pickStrategy = useCallback((s: AutoPickStrategy) => {
    setAutoStrategy(s);
    try { localStorage.setItem(AUTOPICK_STRATEGY_KEY, s); } catch { /* noop */ }
    // 切换策略后立即对当前屏重新评估一次
    lastSigRef.current = '';
    autoCountRef.current = 0;
    lastPickAtRef.current = 0;
    if (autoPickRef.current) {
      if (pickTimerRef.current) window.clearTimeout(pickTimerRef.current);
      pickTimerRef.current = window.setTimeout(runAutoPick, 300);
    }
  }, [runAutoPick]);

  if (!launched) {
    return (
      <div className="flex flex-col h-full items-center justify-center bg-[#1a1408] text-gray-100 p-8">
        <div className="w-full max-w-lg bg-gray-900 border border-gray-700 rounded-xl p-5 space-y-3">
          <div className="flex items-center gap-2 text-amber-300 font-medium">
            <Bot size={18} /> 新建 Hermes（交互式终端）
          </div>
          <p className="text-xs text-gray-500">请先选择工作目录（项目根目录），确认后再启动 Hermes 交互式终端。</p>
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
            disabled={!cwdDraft.trim()}
            className="w-full flex items-center justify-center gap-1.5 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 disabled:opacity-40 text-white text-sm font-medium"
          >
            <TerminalIcon size={14} />
            启动 Hermes 终端
          </button>
        </div>
        {showPicker && (
          <DirPicker initialDir={cwdDraft || defaultCwd} onSelect={handlePickDir} onClose={() => setShowPicker(false)} title="选择工作目录（Hermes 终端）" />
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-[#1a1408] text-gray-100">
      {/* 顶部：工作目录 + 状态 */}
      <div className="shrink-0 border-b border-gray-700 px-3 py-2 flex items-center gap-2 text-xs bg-gray-900">
        <Bot size={14} className="text-amber-400 shrink-0" />
        <FolderOpen size={14} className="text-amber-400 shrink-0" />
        <input
          value={cwdDraft}
          onChange={(e) => setCwdDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') applyCwd(); }}
          className="flex-1 min-w-0 bg-gray-800 border border-gray-700 rounded px-2 py-1 font-mono text-[11px] focus:outline-none focus:border-amber-500"
          placeholder="项目根目录"
        />
        <button onClick={() => setShowPicker(true)} className="px-2 py-1 rounded bg-gray-800 hover:bg-gray-700 border border-gray-700 flex items-center gap-1" title="浏览选择目录"><FolderOpen size={12} />浏览</button>
        <button onClick={applyCwd} className="px-2 py-1 rounded bg-gray-800 hover:bg-gray-700 border border-gray-700">应用</button>
        <button onClick={() => reconnect(defaultCwd)} className="px-2 py-1 rounded bg-gray-800 hover:bg-gray-700 border border-gray-700" title="workspace">workspace</button>
        {repoDir && (
          <button onClick={() => reconnect(repoDir)} className="px-2 py-1 rounded bg-gray-800 hover:bg-gray-700 border border-gray-700" title={repoDir}>仓库</button>
        )}
        {info?.viaProxy ? (
          <span className="flex items-center gap-1 text-amber-300 px-1.5 py-0.5 rounded bg-amber-900/30 border border-amber-700/40" title={`经本地代理使用 provider：${info.provider || ''}`}>
            <Bot size={11} /> {info.provider || 'provider'} · {info.model || ''}
          </span>
        ) : info ? (
          <span className="text-gray-500" title="Hermes 默认模型">{info.model || 'hermes'}</span>
        ) : null}
        <button
          onClick={toggleAutoPick}
          className={`px-2 py-1 rounded border flex items-center gap-1 ${
            autoPick
              ? 'bg-amber-600/30 border-amber-500/60 text-amber-200'
              : 'bg-gray-800 hover:bg-gray-700 border-gray-700 text-gray-300'
          }`}
          title="自动应答：检测到 Hermes 弹出选择/确认菜单时自动应答"
        >
          <Wand2 size={12} /> 自动应答{autoPick ? '·开' : ''}
        </button>
        {autoPick && (
          <div className="flex rounded border border-gray-700 overflow-hidden shrink-0">
            <button
              onClick={() => pickStrategy('highlight')}
              className={`px-2 py-1 ${autoStrategy === 'highlight' ? 'bg-amber-600/40 text-amber-100' : 'bg-gray-800 hover:bg-gray-700 text-gray-300'}`}
              title="回车选当前高亮（推荐）项"
            >
              选高亮
            </button>
            <button
              onClick={() => pickStrategy('affirmative')}
              className={`px-2 py-1 border-l border-gray-700 ${autoStrategy === 'affirmative' ? 'bg-amber-600/40 text-amber-100' : 'bg-gray-800 hover:bg-gray-700 text-gray-300'}`}
              title="出现选项交互时默认选 Yes / 1 等肯定项"
            >
              选 Yes/1
            </button>
          </div>
        )}
        <span className={`flex items-center gap-1 ${connected ? 'text-emerald-400' : 'text-gray-500'}`}>
          <Plug size={12} /> {connected ? '已连接' : '未连接'}
        </span>
        <button onClick={() => reconnect()} className="p-1 rounded hover:bg-gray-700" title="重连（应用当前 provider/目录）">
          <RefreshCw size={13} />
        </button>
      </div>

      {/* 当前工作目录 */}
      <div className="shrink-0 border-b border-gray-800 px-3 py-1 text-[11px] flex items-center gap-1.5 bg-gray-900/60">
        <FolderOpen size={11} className="text-amber-400/80 shrink-0" />
        <span className="text-gray-500 shrink-0">工作目录：</span>
        <span className="font-mono text-gray-300 truncate" title={cwd}>{cwd || '(未设置)'}</span>
      </div>

      {/* 终端 */}
      <div
        ref={containerRef}
        className="flex-1 min-h-0 w-full overflow-hidden p-1"
        title="复制：选中后 Ctrl+C / 右键；粘贴：Ctrl+V / Shift+Insert / 右键"
      />

      {showPicker && (
        <DirPicker initialDir={cwdDraft || cwd || defaultCwd} onSelect={handlePickDir} onClose={() => setShowPicker(false)} title="选择工作目录（Hermes 终端）" />
      )}
    </div>
  );
}
