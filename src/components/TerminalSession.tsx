import { useState, useRef, useEffect, useCallback, forwardRef, useImperativeHandle } from 'react';
import type { TerminalLine } from '../types';
import { bindTermClipboard, copyTextToClipboard, readTextFromClipboard } from '../lib/termClipboard';
import { registerTerminalLinkProvider, terminalLinkHandler, type TerminalTextLink } from '../lib/terminalLinks';
import { getDesktop } from '../lib/desktopBridge';
import 'xterm/css/xterm.css';

const ANSI_FG: Record<number, string> = {
  30: 'text-gray-400', 31: 'text-red-400', 32: 'text-green-400', 33: 'text-yellow-400',
  34: 'text-blue-400', 35: 'text-purple-400', 36: 'text-cyan-400', 37: 'text-gray-200',
  90: 'text-gray-500', 91: 'text-red-500', 92: 'text-green-500', 93: 'text-yellow-500',
  94: 'text-blue-500', 95: 'text-purple-500', 96: 'text-cyan-500', 97: 'text-gray-300',
};
function parseAnsiToSpans(raw: string): { text: string; className: string }[] {
  const out: { text: string; className: string }[] = [];
  const re = /\x1b\[([0-9;]*)m/g;
  let lastIdx = 0;
  let currentClass = '';
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    if (m.index > lastIdx) out.push({ text: raw.slice(lastIdx, m.index), className: currentClass });
    lastIdx = m.index + m[0].length;
    const codes = m[1].split(';').map(Number).filter(Boolean);
    for (const c of codes) {
      if (c === 0) currentClass = '';
      else if (ANSI_FG[c]) currentClass = ANSI_FG[c];
    }
  }
  if (lastIdx < raw.length) out.push({ text: raw.slice(lastIdx), className: currentClass });
  return out.length ? out : [{ text: raw, className: '' }];
}

export interface TerminalSessionHandle {
  clear: () => void;
  sendSelectionToChat: (fallbackSelection?: string | null) => void;
  copySelection: (fallbackSelection?: string | null) => Promise<boolean>;
  pasteClipboard: () => Promise<boolean>;
  /** Query the shell process for its current working directory. */
  getCwd: () => Promise<string | null>;
  focus: () => void;
  fit: () => void;
}

interface Props {
  active: boolean;
  wsAvailable: boolean | null;
  onSendToChat?: (text: string) => void;
  /** Optional command sent once after the PTY is ready. */
  initialCommand?: string;
  /** Directory to enter once after the PTY is ready. Ignored when initialCommand is set. */
  initialCwd?: string;
  /** Open a terminal path using browser-tab/default-app routing. */
  onOpenPath?: (path: string, cwd?: string) => void;
  /** Open an HTTP(S) terminal link in the workbench browser tab. */
  onOpenUrl?: (url: string, title?: string) => void;
  /** Analyze selected terminal text with the configured default model. */
  onSelectedContextMenu?: (text: string) => void;
}

const TerminalSession = forwardRef<TerminalSessionHandle, Props>(function TerminalSession(
  { active, wsAvailable, onSendToChat, initialCommand, initialCwd, onOpenPath, onOpenUrl, onSelectedContextMenu }, ref,
) {
  const [lines, setLines] = useState<TerminalLine[]>([
    { id: 'welcome', type: 'system', content: '🖥️  Terminal ready. Type commands and press Enter to execute.\n   Type "help" for available commands. Type "clear" to clear screen.', timestamp: Date.now() },
  ]);
  const [input, setInput] = useState('');
  const [isRunning, setIsRunning] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const [cwd, setCwd] = useState('~');
  const [wsConnected, setWsConnected] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const outputRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<{ term: any; fitAddon: any } | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const selectedTextRef = useRef('');
  const cwdRequestsRef = useRef(new Map<string, (cwd: string | null) => void>());

  const shellQuote = useCallback((value: string) => `'${value.replace(/'/g, `'\\''`)}'`, []);
  const getCwd = useCallback((): Promise<string | null> => new Promise(resolve => {
    const request = () => {
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) {
        const requestId = crypto.randomUUID();
        cwdRequestsRef.current.set(requestId, resolve);
        ws.send(JSON.stringify({ type: 'cwd', requestId }));
        window.setTimeout(() => {
          const pending = cwdRequestsRef.current.get(requestId);
          if (!pending) return;
          cwdRequestsRef.current.delete(requestId);
          pending(null);
        }, 2500);
        return;
      }
      // The PTY can still be opening when the dock's + button is clicked.
      if (Date.now() < deadline) {
        window.setTimeout(request, 100);
        return;
      }
      resolve(null);
    };
    const deadline = Date.now() + 2500;
    request();
  }), []);

  // 建立 PTY WebSocket（每个会话独立，后端按连接 fork 各自的 shell）
  useEffect(() => {
    if (wsAvailable !== true || !containerRef.current) return;
    let ws: WebSocket | null = null;
    let ro: ResizeObserver | null = null;
    let clipboardCleanup: (() => void) | null = null;
    let selectionDisposable: { dispose: () => void } | null = null;
    let linkDisposable: { dispose: () => void } | null = null;
    const init = async () => {
      const [xtermMod, fitMod] = await Promise.all([import('xterm'), import('xterm-addon-fit')]);
      const Terminal = xtermMod.Terminal;
      const FitAddon = (fitMod as any).FitAddon ?? (fitMod as any).default;
      const openTerminalTarget = (target: string) => {
        if (/^https?:\/\//i.test(target)) {
          const desktop = getDesktop();
          if (onOpenUrl) onOpenUrl(target);
          else if (desktop) void desktop.openExternal(target);
          else window.open(target, '_blank', 'noopener,noreferrer');
          return;
        }
        const openPath = async () => {
          const currentCwd = await getCwd();
          onOpenPath?.(target, currentCwd || undefined);
        };
        void openPath();
      };
      const term = new Terminal({
        fontFamily: 'ui-monospace, "Cascadia Code", "JetBrains Mono", monospace',
        fontSize: 13,
        lineHeight: 1.35,
        cursorBlink: true,
        cursorStyle: 'block',
        scrollback: 10000,
        theme: {
          background: '#0f172a', foreground: '#e2e8f0', cursor: '#4ade80', cursorAccent: '#0f172a',
          selectionBackground: 'rgba(74, 222, 128, 0.2)',
          black: '#1e293b', red: '#f87171', green: '#4ade80', yellow: '#facc15',
          blue: '#60a5fa', magenta: '#c084fc', cyan: '#22d3ee', white: '#e2e8f0',
          brightBlack: '#64748b', brightRed: '#fca5a5', brightGreen: '#86efac', brightYellow: '#fde047',
          brightBlue: '#93c5fd', brightMagenta: '#d8b4fe', brightCyan: '#67e8f9', brightWhite: '#f8fafc',
        },
        linkHandler: terminalLinkHandler(openTerminalTarget),
      });
      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.open(containerRef.current!);
      try { fitAddon.fit(); } catch { /* noop */ }
      termRef.current = { term, fitAddon };
      // xterm's built-in OSC-8 support only handles hyperlinks explicitly
      // emitted by the PTY. Agent logs are plain JSON/text, so use the shared
      // provider for URLs and relative/absolute paths as well.
      linkDisposable = registerTerminalLinkProvider(term, (link: TerminalTextLink) => openTerminalTarget(link.text));
      clipboardCleanup = bindTermClipboard(term, (data: string) => {
        if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data }));
      }, onSelectedContextMenu);
      selectionDisposable = term.onSelectionChange(() => {
        if (term.hasSelection()) {
          const text = term.getSelection();
          selectedTextRef.current = text;
          void copyTextToClipboard(text);
        }
      });

      const wsUrl = (window.location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + window.location.host + '/ws';
      ws = new WebSocket(wsUrl);
      wsRef.current = ws;
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => {
        setWsConnected(true);
        const { cols, rows } = term;
        ws!.send(JSON.stringify({ type: 'resize', cols, rows }));
        const command = initialCommand?.trim()
          || (initialCwd?.trim() ? `cd -- ${shellQuote(initialCwd.trim())}` : '');
        if (command) {
          // Give the shell one tick to finish its prompt setup before typing
          // the command, otherwise the first characters can be swallowed by
          // shells that emit a startup banner.
          window.setTimeout(() => {
            if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data: `${command}\n` }));
          }, 80);
        }
      };
      ws.onmessage = (e: MessageEvent) => {
        if (e.data instanceof ArrayBuffer) {
          term.write(new TextDecoder().decode(new Uint8Array(e.data)));
        } else if (typeof e.data === 'string') {
          try {
            const message = JSON.parse(e.data);
            if (message?.type === 'pong') return;
            if (message?.type === 'cwd') {
              const pending = cwdRequestsRef.current.get(String(message.requestId || ''));
              if (pending) {
                cwdRequestsRef.current.delete(String(message.requestId || ''));
                pending(typeof message.cwd === 'string' && message.cwd ? message.cwd : null);
              }
              return;
            }
          } catch { /* PTY output is plain text */ }
          term.write(e.data);
        }
      };
      ws.onclose = () => setWsConnected(false);
      ws.onerror = () => setWsConnected(false);
      term.onData((data: string) => {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data }));
      });
      term.onResize(({ cols, rows }: { cols: number; rows: number }) => {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols, rows }));
      });
      ro = new ResizeObserver(() => { try { fitAddon.fit(); } catch { /* noop */ } });
      ro.observe(containerRef.current!);
    };
    init();
    return () => {
      ro?.disconnect();
      clipboardCleanup?.();
      selectionDisposable?.dispose();
      try { linkDisposable?.dispose(); } catch { /* noop */ }
      try { ws?.close(); } catch { /* noop */ }
      cwdRequestsRef.current.forEach(resolve => resolve(null));
      cwdRequestsRef.current.clear();
      wsRef.current = null;
      try { termRef.current?.term.dispose(); } catch { /* noop */ }
      termRef.current = null;
    };
  }, [wsAvailable, initialCommand, initialCwd, onOpenPath, onOpenUrl, onSelectedContextMenu, shellQuote, getCwd]);

  // 标签从隐藏切到可见：适配尺寸并聚焦
  useEffect(() => {
    if (!active) return;
    requestAnimationFrame(() => {
      try { termRef.current?.fitAddon.fit(); } catch { /* noop */ }
      try { termRef.current?.term.focus(); } catch { /* noop */ }
      if (wsAvailable !== true) inputRef.current?.focus();
    });
  }, [active, wsAvailable]);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [lines]);

  const addLine = useCallback((type: TerminalLine['type'], content: string) => {
    setLines(prev => [...prev, { id: crypto.randomUUID(), type, content, timestamp: Date.now() }]);
  }, []);

  const handleSubmit = useCallback(async () => {
    const cmd = input.trim();
    if (!cmd) return;
    setHistory(prev => [...prev.filter(h => h !== cmd), cmd]);
    setHistoryIdx(-1);
    setInput('');
    addLine('input', `$ ${cmd}`);
    if (cmd === 'clear') { setLines([]); return; }
    if (cmd === 'help') {
      addLine('system', 'Available features:\n  • Type any shell command to execute it\n  • "clear" - clear terminal\n  • "cd <dir>" - change directory\n  • Up/Down arrows - command history');
      return;
    }
    setIsRunning(true);
    abortRef.current = new AbortController();
    try {
      const resp = await fetch('/api/terminal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: cmd, cwd }),
        signal: abortRef.current.signal,
      });
      const contentType = resp.headers.get('content-type') || '';
      if (contentType.includes('text/event-stream')) {
        const reader = resp.body?.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let streamDone = false;
        if (reader) {
          while (!streamDone) {
            const { done, value } = await reader.read();
            if (value) buffer += decoder.decode(value, { stream: true });
            let lineEnd: number;
            while ((lineEnd = buffer.indexOf('\n')) !== -1) {
              const line = buffer.slice(0, lineEnd).trim();
              buffer = buffer.slice(lineEnd + 1);
              if (!line.startsWith('data: ')) continue;
              try {
                const data = JSON.parse(line.slice(6));
                if (data.out != null) addLine('output', data.out.replace(/\n$/, ''));
                if (data.error) addLine('error', data.error);
                if (data.exit != null) {
                  if (data.cwd) setCwd(data.cwd);
                  streamDone = true;
                  break;
                }
              } catch { /* skip */ }
            }
            if (done) break;
          }
        }
      } else {
        const data = await resp.json();
        if (data.cwd) setCwd(data.cwd);
        if (data.stdout) addLine('output', data.stdout);
        if (data.stderr) addLine('error', data.stderr);
        if (data.error) addLine('error', data.error);
        if (!data.stdout && !data.stderr && !data.error && data.exit_code === 0) {
          addLine('output', '(completed successfully, no output)');
        }
      }
    } catch (e: any) {
      if (e?.name !== 'AbortError') {
        addLine('error', `Connection error: ${e.message}\nMake sure the Python backend is running.`);
      }
    } finally {
      setIsRunning(false);
      abortRef.current = null;
    }
  }, [input, cwd, addLine]);

  const handleStop = useCallback(() => {
    if (abortRef.current) abortRef.current.abort();
    fetch('/api/terminal-cancel', { method: 'POST' }).catch(() => {});
  }, []);

  const handleTabComplete = useCallback(async () => {
    if (!input.trim()) return;
    try {
      const res = await fetch('/api/terminal-complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ line: input, cwd }),
      });
      const data = await res.json().catch(() => ({}));
      const comps = data.completions || [];
      if (comps.length === 0) return;
      const words = input.split(/\s+/);
      const last = words[words.length - 1] || '';
      const base = last.replace(/[^/]*$/, '');
      const commonPrefixLen = (arr: string[]): number => {
        if (arr.length <= 1) return arr[0]?.length ?? 0;
        let i = 0;
        while (i < arr[0].length && arr.every(s => s[i] === arr[0][i])) i++;
        return i;
      };
      const repl = comps.length === 1 ? comps[0] : comps[0].slice(0, commonPrefixLen(comps));
      setInput(input.slice(0, -last.length) + base + repl);
    } catch { /* ignore */ }
  }, [input, cwd]);

  const useWsTerminal = wsAvailable === true;

  const copySelection = useCallback(async (fallbackSelection?: string | null) => {
    const text = termRef.current?.term?.hasSelection?.()
      ? termRef.current.term.getSelection()
      : (fallbackSelection || selectedTextRef.current || window.getSelection()?.toString() || '');
    const copied = await copyTextToClipboard(text);
    if (copied) selectedTextRef.current = text;
    return copied;
  }, []);

  const pasteClipboard = useCallback(async () => {
    const text = await readTextFromClipboard();
    if (!text) return false;
    if (useWsTerminal) {
      if (wsRef.current?.readyState !== WebSocket.OPEN) return false;
      wsRef.current.send(JSON.stringify({ type: 'input', data: text }));
      termRef.current?.term.focus();
    } else {
      setInput(prev => prev + text);
      inputRef.current?.focus();
    }
    return true;
  }, [useWsTerminal]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); handleSubmit(); }
    else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (history.length === 0) return;
      const newIdx = historyIdx < history.length - 1 ? historyIdx + 1 : historyIdx;
      setHistoryIdx(newIdx);
      setInput(history[history.length - 1 - newIdx] || '');
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (historyIdx <= 0) { setHistoryIdx(-1); setInput(''); }
      else { const newIdx = historyIdx - 1; setHistoryIdx(newIdx); setInput(history[history.length - 1 - newIdx] || ''); }
    } else if (e.key === 'c' && e.ctrlKey) {
      if (isRunning) { addLine('system', '^C'); handleStop(); }
    } else if (e.key === 'Tab') { e.preventDefault(); handleTabComplete(); }
  };

  useImperativeHandle(ref, () => ({
    clear: () => {
      if (termRef.current) {
        termRef.current.term.clear();
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: 'input', data: '\x0c' }));
        }
      } else {
        setLines([]);
      }
    },
    sendSelectionToChat: (fallbackSelection?: string | null) => {
      if (!onSendToChat) return;
      if (termRef.current?.term.hasSelection()) {
        const text = termRef.current.term.getSelection();
        if (text) onSendToChat(text);
        return;
      }
      const s = fallbackSelection ?? window.getSelection()?.toString().trim();
      if (s) onSendToChat(s);
    },
    copySelection,
    pasteClipboard,
    getCwd,
    focus: () => {
      if (wsAvailable === true) termRef.current?.term.focus();
      else inputRef.current?.focus();
    },
    fit: () => {
      try { termRef.current?.fitAddon.fit(); } catch { /* noop */ }
    },
  }), [copySelection, getCwd, onSendToChat, pasteClipboard, wsAvailable]);

  return (
    <div
      className="flex flex-col h-full w-full"
      onClick={e => {
        if (outputRef.current?.contains(e.target as Node)) return;
        if (!useWsTerminal) inputRef.current?.focus();
        else termRef.current?.term.focus();
      }}
    >
      <div className="px-3 py-1 text-[11px] font-mono border-b border-gray-800 shrink-0 flex items-center gap-2">
        {useWsTerminal ? (
          <span className={wsConnected ? 'text-green-400' : 'text-yellow-400'}>
            {wsConnected ? '● 已连接' : '○ 连接中…'}
          </span>
        ) : (
          <span className="text-gray-500">{cwd}</span>
        )}
      </div>
      {useWsTerminal ? (
        <div ref={containerRef} className="flex-1 min-h-0 w-full p-2" style={{ minHeight: 120 }} />
      ) : (
        <>
          <div
            ref={outputRef}
            onMouseUp={() => {
              const text = window.getSelection()?.toString() || '';
              if (text) { selectedTextRef.current = text; void copyTextToClipboard(text); }
            }}
            className="flex-1 overflow-y-auto px-4 py-2 font-mono text-sm select-text"
          >
            {lines.map(line => (
              <div key={line.id} className="mb-0.5">
                {line.type === 'input' && <span className="text-green-400 whitespace-pre-wrap">{line.content}</span>}
                {line.type === 'output' && (
                  <span className="whitespace-pre-wrap">
                    {parseAnsiToSpans(line.content).map((seg, i) => (
                      <span key={i} className={seg.className || 'text-gray-300'}>{seg.text}</span>
                    ))}
                  </span>
                )}
                {line.type === 'error' && (
                  <span className="whitespace-pre-wrap">
                    {parseAnsiToSpans(line.content).map((seg, i) => (
                      <span key={i} className={seg.className || 'text-red-400'}>{seg.text}</span>
                    ))}
                  </span>
                )}
                {line.type === 'system' && <span className="text-blue-400 whitespace-pre-wrap">{line.content}</span>}
              </div>
            ))}
            {isRunning && <div className="text-yellow-400 animate-pulse">Running...</div>}
            <div ref={bottomRef} />
          </div>
          <div className="flex items-center gap-2 px-4 py-2 border-t border-gray-800 shrink-0 bg-gray-900/50">
            <span className="text-green-400 font-mono text-sm shrink-0">$</span>
            <input
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={isRunning}
              placeholder="Enter command..."
              className="flex-1 bg-transparent text-white font-mono text-sm outline-none placeholder-gray-600 disabled:opacity-50"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
        </>
      )}
    </div>
  );
});

export default TerminalSession;
