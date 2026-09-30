import { Children, cloneElement, isValidElement, useState, useCallback, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { Copy, Check, Download, Play, Eye, Loader2, Lock, MessageSquare, Sparkles } from 'lucide-react';
import { registerTerminalLinkProvider, terminalLinkHandler } from '../lib/terminalLinks';
import { getDesktop } from '../lib/desktopBridge';
import type { APIProvider } from '../types';

/**
 * 把大模型输出里的 LaTeX 定界符规整为 remark-math 能识别的 `$`/`$$`。
 *
 * 模型常用 `\( ... \)`（行内）和 `\[ ... \]`（块级），但 Markdown 会把
 * 反斜杠+标点当作转义：`\(` 渲染成 `(`、`\)` 渲染成 `)`，导致公式定界符丢失
 * （而 `\dfrac` 这类反斜杠+字母不会被转义，仍保留）。因此在交给 Markdown 解析前，
 * 先把 `\(...\)` → `$...$`、`\[...\]` → `$$...$$`。
 *
 * 注意：`\left(`、`\right)`、`\left[` 等不含「反斜杠紧跟括号」子串，不会被误转换。
 * 代码块（``` ``` 与行内 `code`）整段跳过，避免破坏代码内容。
 */
function normalizeMathDelimiters(src: string): string {
  if (!src || (src.indexOf('\\(') === -1 && src.indexOf('\\[') === -1)) return src;
  const segments = src.split(/(```[\s\S]*?```|`[^`\n]*`)/g);
  return segments
    .map((seg, i) => {
      if (i % 2 === 1) return seg; // 代码段原样保留
      return seg
        .replace(/\\\[\s*([\s\S]*?)\s*\\\]/g, (_m, body) => `\n$$\n${body}\n$$\n`)
        .replace(/\\\(\s*([\s\S]*?)\s*\\\)/g, (_m, body) => `$${body}$`);
    })
    .join('');
}

interface RunResult {
  status: 'idle' | 'running' | 'success' | 'error';
  output: string;
  /** 错误时后端返回的 error 原因，单独展示 */
  errorReason?: string;
}

const RUNNABLE_LANG_ALIASES: Record<string, string> = {
  python: 'python', py: 'python', python3: 'python',
  javascript: 'javascript', js: 'javascript', node: 'javascript',
  bash: 'bash', sh: 'bash', shell: 'bash', zsh: 'bash',
  c: 'c',
  cpp: 'cpp', 'c++': 'cpp', cxx: 'cpp', 'c-plus-plus': 'cpp',
  java: 'java',
  go: 'go', golang: 'go',
  rust: 'rust', rs: 'rust',
  ruby: 'ruby', rb: 'ruby',
  php: 'php',
  html: 'html', htm: 'html',
};
const RUNNABLE_LANGS = [...new Set(Object.values(RUNNABLE_LANG_ALIASES))];
const COMPILED_LANGS = new Set(['c', 'cpp', 'java', 'go', 'rust']);

function normalizeCodeLanguage(value: string): string {
  const normalized = String(value || '').trim().toLowerCase().replace(/^language-/, '');
  return RUNNABLE_LANG_ALIASES[normalized] || normalized;
}

function inferCodeLanguage(source: string): string {
  const code = String(source || '').trim();
  if (!code) return '';
  // Qwen sometimes emits a fenced block without a language token. Keep the
  // Python run action available when the source is recognisably Python.
  if (
    /^#!.*\bpython(?:3)?\b/m.test(code)
    || /^(?:from\s+[A-Za-z_][\w.]*\s+import|import\s+[A-Za-z_][\w.]*)/m.test(code)
    || /\bdef\s+[A-Za-z_]\w*\s*\([^)]*\)\s*:/m.test(code)
    || /\bif\s+__name__\s*==\s*['"]__main__['"]\s*:/m.test(code)
    || /\b(?:print|len|range|enumerate|asyncio\.run)\s*\(/.test(code) && /\b(?:for|while|try|except|with)\b/.test(code)
  ) return 'python';
  if (/^#!.*\b(?:ba)?sh\b/m.test(code) || /\b(?:echo|printf)\s+.+\n/.test(code) && /\$[A-Za-z_{]/.test(code)) return 'bash';
  if (/\b(?:console\.log|const|let|var)\s+/.test(code)) return 'javascript';
  if (/<(?:!doctype\s+html|html|head|body)\b/i.test(code)) return 'html';
  if (/^\s*#include\s*[<"](?:iostream|vector|string|cstdio|cstdlib)/m.test(code)) return 'cpp';
  if (/^\s*#include\s*[<"](?:stdio|stdlib|string)\.h[>"]/m.test(code)) return 'c';
  if (/\bpublic\s+(?:final\s+|abstract\s+)?class\s+[A-Z]\w*/.test(code) && /\bstatic\s+void\s+main\s*\(/.test(code)) return 'java';
  return '';
}

const SUDO_PASSWORD_CACHE_KEY = 'model-api-tool/sudo_password';

function getSudoPasswordFromCache(): string | null {
  try {
    const p = localStorage.getItem(SUDO_PASSWORD_CACHE_KEY);
    return p && p.length > 0 ? p : null;
  } catch {
    return null;
  }
}

function setSudoPasswordToCache(password: string): void {
  try {
    if (password.trim()) localStorage.setItem(SUDO_PASSWORD_CACHE_KEY, password.trim());
  } catch {}
}

function CodeBlock({ className, children, inline, __block, provider, onQuoteToInput, onQuoteToInputAndSend, onOpenUrl, ...props }: any) {
  const [copied, setCopied] = useState(false);
  const [runResult, setRunResult] = useState<RunResult>({ status: 'idle', output: '' });
  const [showPreview, setShowPreview] = useState(false);
  const [savedPath, setSavedPath] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveInfo, setSaveInfo] = useState<{ file: string; deps: string[]; runner?: string; requirements?: string } | null>(null);
  const [showSudoDialog, setShowSudoDialog] = useState(false);
  const [sudoPassword, setSudoPassword] = useState('');
  const [rememberSudo, setRememberSudo] = useState(true);
  const runOutputSelectionRef = useRef<string | null>(null);
  const runOutputPreRef = useRef<HTMLPreElement>(null);
  /** 超时后再次 Run 时每次延长 10s，成功或非超时错误时重置 */
  const nextTimeoutRef = useRef<number | undefined>(undefined);
  const [interactiveSessionId, setInteractiveSessionId] = useState<string | null>(null);
  const [interactiveInput, setInteractiveInput] = useState('');
  const eventSourceRef = useRef<EventSource | null>(null);
  /** Shell 以 WebSocket 终端方式执行时：内嵌 xterm 连接 /ws，执行脚本并支持交互 */
  const [showWsTerminal, setShowWsTerminal] = useState(false);
  const [wsTerminalScript, setWsTerminalScript] = useState('');
  /** 每次点击 Run 自增，强制重连 /ws-run（同一段代码再次运行也能重启终端） */
  const [wsRunNonce, setWsRunNonce] = useState(0);
  const wsTerminalContainerRef = useRef<HTMLDivElement>(null);
  const runResultContainerRef = useRef<HTMLDivElement>(null);
  const wsTerminalRef = useRef<{ term: any; fitAddon: any; ws: WebSocket } | null>(null);
  /** WS 终端执行结束状态：done=true 时拿到 exitCode；失败可点「让 AI 修复」 */
  const [wsExecStatus, setWsExecStatus] = useState<{ done: boolean; exitCode?: number; errorOutput?: string }>({ done: false });
  const [wsAiAsked, setWsAiAsked] = useState(false);
  /** 终端内 sudo 提示需要密码时弹出输入框 */
  const [showSudoInTerminal, setShowSudoInTerminal] = useState(false);
  const [sudoPasswordInTerminal, setSudoPasswordInTerminal] = useState('');
  const [rememberSudoInTerminal, setRememberSudoInTerminal] = useState(true);
  /** 创建终端前需先输入 sudo 密码（未命中缓存时） */
  const [showSudoDialogForTerminal, setShowSudoDialogForTerminal] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const [repairInfo, setRepairInfo] = useState('');

  const rawCode = String(children).replace(/\n$/, '');
  const rawLang = /language-([\w.+-]+)/i.exec(className || '')?.[1] || '';
  const isInline = inline === true || (!__block && !className && !rawCode.includes('\n'));
  const initialLang = normalizeCodeLanguage(rawLang) || (!isInline ? inferCodeLanguage(rawCode) : '');
  const [workingCode, setWorkingCode] = useState(rawCode);
  const [workingLang, setWorkingLang] = useState(initialLang);
  useEffect(() => {
    setWorkingCode(rawCode);
    setWorkingLang(initialLang);
    setRepairInfo('');
  }, [initialLang, rawCode]);
  const code = workingCode;
  const lang = workingLang;

  const handleCopy = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      // 智能保存：后端推断准确文件名 → 保存 → 检测依赖(写 requirements.txt) → 生成 run_*.sh
      const resp = await fetch('/api/save-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: code, language: lang }),
      });
      const data = await resp.json();
      if (resp.ok) {
        setSavedPath(data?.file?.name || data?.file?.path || '');
        setSaveInfo({
          file: data?.file?.name || '',
          deps: Array.isArray(data?.deps) ? data.deps : [],
          runner: data?.runner?.name,
          requirements: data?.requirements?.name,
        });
        setTimeout(() => { setSavedPath(''); setSaveInfo(null); }, 12000);
      } else {
        alert(`Save failed: ${data.error}`);
      }
    } catch (e: any) {
      alert(`Save failed: ${e.message}`);
    } finally {
      setSaving(false);
    }
  }, [code, lang]);

  const doRun = useCallback(async (sudoPasswordToSend?: string) => {
    setRunResult({ status: 'running', output: '' });
    setShowSudoDialog(false);
    setInteractiveSessionId(null);
    eventSourceRef.current?.close();
    eventSourceRef.current = null;

    const timeoutSec = nextTimeoutRef.current ?? 30;
    const body: { code: string; language: string; sudoPassword?: string; timeoutSeconds?: number; interactive?: boolean } = { code, language: lang, timeoutSeconds: timeoutSec };
    if (sudoPasswordToSend) body.sudoPassword = sudoPasswordToSend;

    try {
      const resp = await fetch('/api/run-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await resp.json();
      if (!resp.ok && data.needs_sudo) {
        setShowSudoDialog(true);
        setRunResult({ status: 'idle', output: '' });
        return;
      }
      if (data.interactive && data.session_id) {
        setInteractiveSessionId(data.session_id);
        const es = new EventSource(`/api/run-code-stream/${data.session_id}`);
        eventSourceRef.current = es;
        es.onmessage = (e) => {
          try {
            const msg = JSON.parse(e.data);
            if (msg.type === 'out') {
              setRunResult(prev => ({ ...prev, output: prev.output + (msg.text || '') }));
            } else if (msg.type === 'exit') {
              const code = msg.exit_code ?? 1;
              setRunResult(prev => ({ ...prev, status: code === 0 ? 'success' : 'error' }));
              setInteractiveSessionId(null);
              es.close();
              eventSourceRef.current = null;
            }
          } catch (_) {}
        };
        es.onerror = () => {
          setInteractiveSessionId(null);
          es.close();
          eventSourceRef.current = null;
        };
        return;
      }
      if (data.exit_code === 124) {
        nextTimeoutRef.current = timeoutSec + 10;
      } else {
        nextTimeoutRef.current = undefined;
      }
      const isError = data.exit_code !== 0;
      const output = data.output ?? '';
      const errorReason = data.error ?? (resp.ok ? undefined : data.error || data.message);
      setRunResult({
        status: isError ? 'error' : 'success',
        output: output || (isError && errorReason ? errorReason : '') || '(no output)',
        errorReason: isError ? (errorReason || undefined) : undefined,
      });
    } catch (e: any) {
      nextTimeoutRef.current = undefined;
      setRunResult({ status: 'error', output: e.message, errorReason: e.message });
    }
  }, [code, lang]);

  useEffect(() => {
    return () => {
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (runResult.status !== 'idle' && runResultContainerRef.current) {
      runResultContainerRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [runResult.status, showWsTerminal]);

  useEffect(() => {
    if (!showWsTerminal || !wsTerminalScript || !wsTerminalContainerRef.current) return;
    const el = wsTerminalContainerRef.current;
    const runLang = lang;
    const runCode = wsTerminalScript;
    let term: any = null;
    let fitAddon: any = null;
    let ws: WebSocket | null = null;
    let linkDisposable: { dispose: () => void } | null = null;
    let ro: ResizeObserver | null = null;
    let cancelled = false;
    let autoAnswerTimer: ReturnType<typeof setTimeout> | null = null;
    (async () => {
      await import('xterm/css/xterm.css');
      const [xtermMod, fitMod] = await Promise.all([import('xterm'), import('xterm-addon-fit')]);
      const Terminal = xtermMod.Terminal;
      const FitAddon = (fitMod as any).FitAddon ?? (fitMod as any).default;
      if (cancelled || !el) return;
      const openTerminalTarget = (target: string) => {
        const desktop = getDesktop();
        if (/^https?:\/\//i.test(target)) {
          if (onOpenUrl) onOpenUrl(target);
          else if (desktop) void desktop.openExternal(target);
          else window.open(target, '_blank', 'noopener,noreferrer');
        } else if (desktop) {
          void desktop.openTarget({ target });
        }
      };
      term = new Terminal({
        fontFamily: 'ui-monospace, "Cascadia Code", "JetBrains Mono", monospace',
        fontSize: 12,
        lineHeight: 1.3,
        cursorBlink: true,
        scrollback: 5000,
        theme: { background: '#0f172a', foreground: '#e2e8f0', cursor: '#4ade80', selectionBackground: 'rgba(74,222,128,0.2)' },
        linkHandler: terminalLinkHandler(openTerminalTarget),
      });
      fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.open(el);
      fitAddon.fit();
      linkDisposable = registerTerminalLinkProvider(term, link => openTerminalTarget(link.text));
      // 专用干净执行通道：后端起 bash --norc 跑「检测依赖→装依赖→执行→交互」包装流程，
      // 退出码经文本 JSON 帧回传，PTY 字节直接写入终端（无哨兵、无逐行注入）。
      const wsUrl = (window.location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + window.location.host + '/ws-run';
      ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';
      const doFit = () => { try { fitAddon?.fit(); } catch {} };

      let outputBuffer = '';
      let lastSudoSendTime = 0;
      const SUDO_COOLDOWN_MS = 1500;
      // reset exec status on each new run
      setWsExecStatus({ done: false });
      setWsAiAsked(false);
      function stripAnsi(s: string): string {
        return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\[\?[^a-zA-Z]*[a-zA-Z]/g, '').replace(/\x1b[PX^_]/g, '').replace(/\x1b.\]?[^\x1b]*\x1b\\\\/g, '');
      }
      const SUDO_PASSWORD_PROMPT = /\[sudo\][^\n]*密码|\[sudo\]\s*password\s+for/i;

      // 交互式 prompt 自动默认应答：3 秒内无用户键入则发送默认值
      const AUTO_ANSWER_DELAY_MS = 3000;
      const AUTO_ANSWER_RULES: Array<{ re: RegExp; def: string; desc: string }> = [
        { re: /\[Y\/n\][^\n]*$/i, def: 'Y\n', desc: '[Y/n] -> Y' },
        { re: /\[y\/N\][^\n]*$/i, def: 'N\n', desc: '[y/N] -> N' },
        { re: /\(Y\/n\)[^\n]*$/i, def: 'Y\n', desc: '(Y/n) -> Y' },
        { re: /\(y\/N\)[^\n]*$/i, def: 'N\n', desc: '(y/N) -> N' },
        { re: /\[默认\s*[YyEnter回车]+\][^\n]*$/i, def: '\n', desc: '[默认 Enter] -> Enter' },
        { re: /Press\s+(?:any\s+key|Enter|\[?Enter\]?|Return)\s+to\s+(?:continue|proceed)[^\n]*$/i, def: '\n', desc: 'Press Enter -> Enter' },
        { re: /按\s*(?:任意键|回车|Enter)\s*(?:继续|确认)?[^\n]*$/i, def: '\n', desc: '按回车 -> Enter' },
      ];
      let lastAutoAnswerSig = '';
      let execDone = false;
      function clearAutoAnswerTimer() {
        if (autoAnswerTimer != null) {
          clearTimeout(autoAnswerTimer);
          autoAnswerTimer = null;
        }
      }
      function maybeScheduleAutoAnswer(clean: string) {
        if (execDone) { clearAutoAnswerTimer(); return; }
        const tail = clean.slice(Math.max(0, clean.length - 240));
        const lastLine = tail.slice(tail.lastIndexOf('\n') + 1).replace(/\s+$/, '');
        if (!lastLine) return;
        for (const rule of AUTO_ANSWER_RULES) {
          if (rule.re.test(lastLine)) {
            const sig = `${rule.desc}|${lastLine.slice(-60)}`;
            if (sig === lastAutoAnswerSig) return;
            lastAutoAnswerSig = sig;
            clearAutoAnswerTimer();
            autoAnswerTimer = setTimeout(() => {
              autoAnswerTimer = null;
              if (cancelled || execDone) return;
              if (!ws || ws.readyState !== WebSocket.OPEN) return;
              const recentClean = stripAnsi(outputBuffer);
              const recentLast = recentClean.slice(recentClean.lastIndexOf('\n') + 1).replace(/\s+$/, '');
              if (!rule.re.test(recentLast)) return;
              ws.send(JSON.stringify({ type: 'input', data: rule.def }));
            }, AUTO_ANSWER_DELAY_MS);
            return;
          }
        }
      }
      ws.onopen = () => {
        if (!ws || cancelled) return;
        ws.send(JSON.stringify({
          type: 'start',
          language: runLang,
          code: runCode,
          needsSudo: /\bsudo\b/.test(runCode),
          cols: term.cols,
          rows: term.rows,
        }));
        term.onResize(({ cols, rows }: { cols: number; rows: number }) => {
          if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols, rows }));
        });
        term.onData((data: string) => {
          // 用户开始输入，取消挂起的自动应答，避免与用户输入冲突
          if (autoAnswerTimer != null) clearAutoAnswerTimer();
          lastAutoAnswerSig = '';
          if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data }));
        });
        setTimeout(doFit, 50);
      };
      ro = new ResizeObserver(doFit);
      ro.observe(el);
      ws.onmessage = (e: MessageEvent) => {
        if (cancelled) return;
        // 文本帧：控制消息（exec_done / pong）
        if (typeof e.data === 'string') {
          try {
            const obj = JSON.parse(e.data);
            if (obj.type === 'exec_done') {
              execDone = true;
              clearAutoAnswerTimer();
              const exit = typeof obj.exit_code === 'number' ? obj.exit_code : -1;
              let captured = stripAnsi(outputBuffer).replace(/\r/g, '').trimEnd();
              if (captured.length > 4000) captured = captured.slice(-4000);
              setWsExecStatus({ done: true, exitCode: exit, errorOutput: captured });
            }
          } catch {}
          return;
        }
        // 二进制帧：PTY 终端输出，直接写入
        const text = e.data instanceof ArrayBuffer ? new TextDecoder().decode(new Uint8Array(e.data)) : '';
        if (!text) return;
        outputBuffer = (outputBuffer + text).slice(-12000);
        const clean = stripAnsi(outputBuffer);
        if (SUDO_PASSWORD_PROMPT.test(clean) && (Date.now() - lastSudoSendTime >= SUDO_COOLDOWN_MS)) {
          const pwd = getSudoPasswordFromCache();
          if (pwd && ws?.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'input', data: pwd + '\n' }));
            lastSudoSendTime = Date.now();
            clearAutoAnswerTimer();
          }
        }
        maybeScheduleAutoAnswer(clean);
        term.write(text);
      };
      ws.onerror = () => {};
      ws.onclose = () => {};
      wsTerminalRef.current = { term, fitAddon, ws };
    })();
    return () => {
      cancelled = true;
      if (autoAnswerTimer != null) { clearTimeout(autoAnswerTimer); autoAnswerTimer = null; }
      ro?.disconnect();
      try { linkDisposable?.dispose(); } catch {}
      if (wsTerminalRef.current) {
        try { wsTerminalRef.current.ws?.close(); } catch {}
        try { wsTerminalRef.current.term?.dispose(); } catch {}
        wsTerminalRef.current = null;
      }
    };
  }, [showWsTerminal, wsTerminalScript, wsRunNonce]);

  const sendInteractiveInput = useCallback(() => {
    if (!interactiveSessionId || !interactiveInput.trim()) return;
    const input = interactiveInput.endsWith('\n') ? interactiveInput : interactiveInput + '\n';
    setInteractiveInput('');
    fetch('/api/run-code-input', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: interactiveSessionId, input }),
    }).catch(() => {});
  }, [interactiveSessionId, interactiveInput]);

  /**
   * 启动「专用干净终端」执行当前代码块：重置相关状态并自增 nonce 触发 /ws-run 连接。
   * 实际的「检测依赖 → 装依赖环境 → 执行 → 进入交互 shell」由后端包装脚本完成。
   */
  const startWsRun = useCallback(() => {
    setRunResult({ status: 'running', output: '' });
    setShowSudoDialog(false);
    setShowSudoDialogForTerminal(false);
    setInteractiveSessionId(null);
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    setWsExecStatus({ done: false });
    setWsAiAsked(false);
    setShowWsTerminal(true);
    setWsTerminalScript(code);
    setWsRunNonce(n => n + 1);
  }, [code]);

  const handleCompile = useCallback(async () => {
    setRunResult({ status: 'running', output: '' });
    try {
      await handleSave();
      const response = await fetch('/api/run-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, language: lang, compileOnly: true, timeoutSeconds: 120 }),
      });
      const data = await response.json().catch(() => ({}));
      const output = data.output || data.error || '(编译完成，无输出)';
      setRunResult({
        status: response.ok && data.exit_code === 0 ? 'success' : 'error',
        output,
        errorReason: response.ok && data.exit_code === 0 ? undefined : (data.error || '编译失败'),
      });
    } catch (error: any) {
      setRunResult({ status: 'error', output: error?.message || '编译失败', errorReason: error?.message || '编译失败' });
    }
  }, [code, handleSave, lang]);

  const handleAiRepair = useCallback(async (failureOutput?: string, failureExitCode?: number) => {
    const repairOutput = failureOutput || runResult.errorReason || runResult.output || '未捕获到错误输出';
    const repairExitCode = failureExitCode ?? (runResult.status === 'error' ? 1 : 0);
    if (!provider) {
      onQuoteToInputAndSend?.(
        `以下 ${lang || 'text'} 代码执行失败，请重写完整代码并给出依赖安装命令。\n\n` +
        `原始代码：\n\`\`\`${lang || ''}\n${code}\n\`\`\`\n\n错误输出：\n\`\`\`\n${repairOutput}\n\`\`\``
      );
      return;
    }
    setRepairing(true);
    setRepairInfo('正在让模型分析错误并重写代码…');
    try {
      const response = await fetch('/api/agent/fix-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code,
          language: lang,
          output: repairOutput,
          exitCode: repairExitCode,
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKey,
          model: provider.selectedModel,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error || `AI 修复失败 (${response.status})`);
      const fixed = String(data?.code || '').trim();
      if (!fixed) throw new Error('模型没有返回可替换代码');
      setWorkingCode(fixed);
      setWorkingLang(normalizeCodeLanguage(String(data?.language || lang)) || lang);
      setSavedPath('');
      setSaveInfo(null);
      const deps = Array.isArray(data?.dependencies) ? data.dependencies.filter(Boolean).join(', ') : '';
      const commands = Array.isArray(data?.install_commands) ? data.install_commands.filter(Boolean).join(' && ') : '';
      setRepairInfo(`${data?.summary || '模型已重写代码'}${deps ? `；依赖：${deps}` : ''}${commands ? `；安装：${commands}` : ''}`);
      setRunResult({ status: 'idle', output: '' });
    } catch (error: any) {
      setRepairInfo(error?.message || 'AI 修复失败');
    } finally {
      setRepairing(false);
    }
  }, [code, lang, onQuoteToInputAndSend, provider, runResult.errorReason, runResult.output, runResult.status]);

  const handleRun = useCallback(async () => {
    // Every first run persists the source and the generated runner in the
    // workspace so the result can be inspected or compiled manually later.
    if (!savedPath && !saveInfo) await handleSave();
    if (lang === 'html') {
      setShowPreview(true);
      setRunResult({ status: 'success', output: 'HTML 文件已保存，并已在下方预览中打开。' });
      return;
    }
    // 任何可运行脚本中含 `sudo` 调用，都尝试自动注入缓存密码（python/js 也可能 os.system('sudo ...')）
    const needsSudo = RUNNABLE_LANGS.includes(lang) && /\bsudo\b/.test(code);
    const cachedPwd = getSudoPasswordFromCache();

    if (RUNNABLE_LANGS.includes(lang)) {
      try {
        const r = await fetch('/api/terminal-ws-available');
        const d = await r.json();
        if (d?.available) {
          if (needsSudo && !cachedPwd) {
            setShowSudoDialogForTerminal(true);
            return;
          }
          startWsRun();
          return;
        }
      } catch {
        // fallback to doRun
      }
    }
    if (needsSudo) {
      if (cachedPwd) {
        await doRun(cachedPwd);
        return;
      }
      try {
        const r = await fetch('/api/sudo-password-saved');
        const { saved } = await r.json();
        if (saved) {
          await doRun();
          return;
        }
      } catch {
        // 接口失败则直接弹窗
      }
      setShowSudoDialog(true);
      return;
    }
    await doRun();
  }, [lang, code, doRun, handleSave, savedPath, saveInfo, startWsRun]);

  const isHtml = lang === 'html' || (!lang && code.trim().startsWith('<'));
  const isRunnable = RUNNABLE_LANGS.includes(lang);
  const isCompiled = COMPILED_LANGS.has(lang);

  // Inline code
  if (isInline) {
    return (
      <code className="bg-gray-700/60 text-pink-300 px-1.5 py-0.5 rounded text-sm font-mono" {...props}>
        {children}
      </code>
    );
  }

  return (
    <div className="relative group my-3 rounded-lg overflow-hidden border border-gray-700">
      <div className="flex items-center justify-between bg-gray-800 px-4 py-2 text-xs text-gray-400 flex-wrap gap-2">
        <span className="font-mono">{lang || 'code'}</span>
        <div className="flex items-center gap-1">
          {savedPath && !saveInfo && (
            <span className="text-green-400 mr-2 text-xs">✓ {savedPath}</span>
          )}
          <button onClick={handleCopy} className="flex items-center gap-1 hover:text-white transition-colors px-2 py-1 rounded hover:bg-gray-700" title="Copy">
            {copied ? <Check size={14} /> : <Copy size={14} />}
            {copied ? 'Copied' : 'Copy'}
          </button>
          <button onClick={handleSave} disabled={saving} className="flex items-center gap-1 hover:text-white transition-colors px-2 py-1 rounded hover:bg-gray-700 disabled:opacity-50" title="智能保存（自动推断文件名 + 依赖 + 运行脚本）">
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
            Save
          </button>
          {isRunnable && (
            <button
                onClick={handleRun}
                disabled={runResult.status === 'running'}
                className="flex items-center gap-1 hover:text-green-400 transition-colors px-2 py-1 rounded hover:bg-gray-700 disabled:opacity-50"
                title="Run code"
              >
                {runResult.status === 'running' && !interactiveSessionId ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                Run
              </button>
          )}
          {isCompiled && (
            <button
              onClick={handleCompile}
              disabled={runResult.status === 'running'}
              className="flex items-center gap-1 hover:text-cyan-300 transition-colors px-2 py-1 rounded hover:bg-gray-700 disabled:opacity-50"
              title="只编译，不运行"
            >
              {runResult.status === 'running' ? <Loader2 size={14} className="animate-spin" /> : <span className="font-mono text-[11px]">C</span>}
              编译
            </button>
          )}
          {isHtml && (
            <button
              onClick={() => setShowPreview(!showPreview)}
              className={`flex items-center gap-1 transition-colors px-2 py-1 rounded hover:bg-gray-700 ${showPreview ? 'text-blue-400' : 'hover:text-blue-400'}`}
              title="Preview HTML"
            >
              <Eye size={14} />
              Preview
            </button>
          )}
        </div>
      </div>
      {repairInfo && (
        <div className="border-t border-cyan-700/40 bg-cyan-950/20 px-4 py-2 text-xs text-cyan-200 whitespace-pre-wrap">
          {repairInfo}
        </div>
      )}
      {saveInfo && (
        <div className="border-t border-gray-700 bg-gray-850 px-4 py-2 text-xs space-y-1">
          <div className="text-green-400">✓ 已保存：<span className="font-mono text-gray-200">{saveInfo.file}</span></div>
          <div className="text-gray-400">
            依赖：{saveInfo.deps.length > 0
              ? <span className="font-mono text-amber-300">{saveInfo.deps.join(', ')}</span>
              : <span className="text-gray-500">无</span>}
          </div>
          {saveInfo.runner && (
            <div className="text-gray-400 flex items-center gap-2 flex-wrap">
              <span>运行脚本：<span className="font-mono text-sky-300">{saveInfo.runner}</span></span>
              <code className="px-1.5 py-0.5 rounded bg-gray-900 text-gray-300 font-mono">bash {saveInfo.runner}</code>
              <button
                onClick={() => { navigator.clipboard?.writeText(`bash ${saveInfo.runner}`); }}
                className="hover:text-white text-gray-500 transition-colors"
                title="复制运行命令"
              >
                <Copy size={12} />
              </button>
            </div>
          )}
          {saveInfo.requirements && (
            <div className="text-gray-500">依赖清单：<span className="font-mono">{saveInfo.requirements}</span></div>
          )}
        </div>
      )}
      <pre className="overflow-x-auto p-4 bg-gray-900 text-sm">
        <code className={`${className} text-gray-200`} {...props}>
          {code}
        </code>
      </pre>

      {/* Run output：WebSocket 终端（shell）或 SSE 输出 + 交互输入 */}
      {runResult.status !== 'idle' && (
        <div ref={runResultContainerRef}>
        {showWsTerminal ? (
        <div className="border-t border-gray-700 flex flex-col min-h-[200px] bg-gray-900/50">
          <div className={`px-4 py-1.5 text-xs font-medium flex items-center gap-2 shrink-0 flex-wrap ${
            !wsExecStatus.done ? 'text-yellow-400'
            : wsExecStatus.exitCode === 0 ? 'text-green-400'
            : 'text-red-400'
          }`}>
            {!wsExecStatus.done ? '⏳ WebSocket 终端（可在此输入交互）'
              : wsExecStatus.exitCode === 0 ? `✓ 执行成功 (exit ${wsExecStatus.exitCode})`
              : `✗ 执行失败 (exit ${wsExecStatus.exitCode})`}
            <div className="ml-auto flex items-center gap-1">
              {/* 失败时：让 AI 分析修复 */}
              {wsExecStatus.done && wsExecStatus.exitCode !== 0 && (onQuoteToInputAndSend || provider) && (
                <button
                  type="button"
                  disabled={wsAiAsked || repairing}
                  onClick={() => {
                    setWsAiAsked(true);
                    if (provider) {
                      void handleAiRepair(wsExecStatus.errorOutput, wsExecStatus.exitCode);
                      return;
                    }
                    const errBlock = (wsExecStatus.errorOutput || '').trim() || '(no output captured)';
                    const langTag = lang || 'bash';
                    const msg =
                      `以下 ${langTag} 代码在编译/执行时失败（exit code ${wsExecStatus.exitCode}），请直接重写为可运行的完整代码，分析错误原因，并列出需要安装的依赖及安装命令。\n\n` +
                      `**原始脚本：**\n\`\`\`${langTag}\n${code}\n\`\`\`\n\n` +
                      `**终端输出（含错误）：**\n\`\`\`\n${errBlock}\n\`\`\``;
                    onQuoteToInputAndSend(msg);
                  }}
                  className="flex items-center gap-1 px-2 py-0.5 rounded bg-red-600/20 text-red-200 hover:bg-red-600/40 border border-red-500/40 disabled:opacity-50 disabled:cursor-not-allowed"
                  title="把代码与错误交给大模型重写，并给出依赖安装命令"
                >
                  <Sparkles size={12} />
                  {repairing ? '修复中…' : wsAiAsked ? '已提交' : 'AI 修复并安装依赖'}
                </button>
              )}
              {/* 引用终端中选中的文本到输入框（不发送） */}
              {onQuoteToInput && (
                <button
                  type="button"
                  onClick={() => {
                    const term = wsTerminalRef.current?.term;
                    const sel = term?.getSelection?.() || '';
                    const text = sel.trim();
                    if (!text) {
                      term?.focus?.();
                      return;
                    }
                    onQuoteToInput(text);
                  }}
                  className="text-gray-400 hover:text-white flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-gray-700"
                  title="把当前选中的终端文本添加到聊天输入框（先在终端里拖选文本）"
                >
                  <MessageSquare size={12} />
                  引用选中
                </button>
              )}
              {/* 引用整段输出并直接发送 */}
              {onQuoteToInputAndSend && (
                <button
                  type="button"
                  onClick={() => {
                    const term = wsTerminalRef.current?.term;
                    if (!term?.buffer?.active) return;
                    const buf = term.buffer.active;
                    const lines: string[] = [];
                    for (let i = 0; i < buf.length; i++) {
                      const line = buf.getLine(i);
                      if (line) lines.push(line.translateToString(true));
                    }
                    const text = lines.join('\n').trim();
                    if (text) onQuoteToInputAndSend(text);
                  }}
                  className="text-gray-500 hover:text-white flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-gray-700"
                  title="把终端的全部输出发送给 AI"
                >
                  <MessageSquare size={12} />
                  全部发送
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  if (wsTerminalRef.current) {
                    try { wsTerminalRef.current.ws?.close(); } catch {}
                    try { wsTerminalRef.current.term?.dispose(); } catch {}
                    wsTerminalRef.current = null;
                  }
                  setShowWsTerminal(false);
                  setWsTerminalScript('');
                  setWsExecStatus({ done: false });
                  setWsAiAsked(false);
                  setRunResult({ status: 'idle', output: '', errorReason: undefined });
                }}
                className="text-gray-500 hover:text-white px-1 rounded hover:bg-gray-700"
              >
                关闭终端
              </button>
            </div>
          </div>
          <div ref={wsTerminalContainerRef} className="flex-1 min-h-[180px] w-full bg-[#0f172a] rounded overflow-hidden" />
        </div>
      ) : (
        <div className={`border-t border-gray-700 flex flex-col min-h-[120px] ${runResult.status === 'error' ? 'bg-red-950/30' : 'bg-gray-900/50'}`}>
          <div className={`px-4 py-1.5 text-xs font-medium flex items-center gap-2 shrink-0 ${
            runResult.status === 'running' ? 'text-yellow-400' :
            runResult.status === 'error' ? 'text-red-400' : 'text-green-400'
          }`}>
            {runResult.status === 'running' ? '⏳ Running...' :
             runResult.status === 'error' ? '✗ Error' : '✓ Success'}
            {runResult.status === 'running' && interactiveSessionId && (
              <span className="text-gray-500 font-normal">（在下方输入框输入密码或命令后点击发送）</span>
            )}
            {(runResult.output || runResult.errorReason) && onQuoteToInput && (
              <button
                type="button"
                onMouseDown={(e) => {
                  runOutputSelectionRef.current = window.getSelection()?.toString().trim() || null;
                  e.preventDefault();
                }}
                onClick={() => {
                  const sel = (runOutputSelectionRef.current ?? window.getSelection()?.toString().trim()) || '';
                  runOutputSelectionRef.current = null;
                  const s = sel.trim() || runResult.errorReason || runResult.output || '';
                  if (s) onQuoteToInput(s);
                }}
                className="ml-auto text-gray-500 hover:text-white flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-gray-700"
                title="将选中内容引用到对话输入（未选中则引用全部输出）"
              >
                <MessageSquare size={12} />
                引用到输入
              </button>
            )}
            {runResult.status === 'error' && (onQuoteToInputAndSend || provider) && (
              <button
                type="button"
                disabled={repairing}
                onClick={() => {
                  const langTag = lang || 'text';
                  const errBlock = (runResult.errorReason || runResult.output || '').trim() || '(无错误输出)';
                  if (provider) {
                    void handleAiRepair(errBlock, 1);
                    return;
                  }
                  onQuoteToInputAndSend(
                    `以下 ${langTag} 代码保存/编译/执行失败，请重写为可运行的完整代码，并给出需要安装的依赖和安装命令。\n\n` +
                    `原始代码：\n\`\`\`${langTag}\n${code}\n\`\`\`\n\n错误输出：\n\`\`\`\n${errBlock}\n\`\`\``
                  );
                }}
                className="text-red-300 hover:text-white flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-red-900/40"
                title="把代码和错误发送给大模型，要求重写并补充依赖安装命令"
              >
                <Sparkles size={12} />
                AI 修复并安装依赖
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                eventSourceRef.current?.close();
                eventSourceRef.current = null;
                setInteractiveSessionId(null);
                setRunResult({ status: 'idle', output: '', errorReason: undefined });
              }}
              className="text-gray-500 hover:text-white px-1 rounded hover:bg-gray-700"
            >
              ✕
            </button>
          </div>
          {runResult.status === 'error' && runResult.errorReason && (
            <div className="px-4 py-2 text-sm text-red-300 font-medium border-t border-gray-800 bg-red-950/20 shrink-0">
              错误原因：{runResult.errorReason}
            </div>
          )}
          {(runResult.output || (runResult.status === 'error' && !runResult.errorReason) || interactiveSessionId) && (
            <pre
              ref={runOutputPreRef}
              className="px-4 py-3 text-sm text-gray-300 overflow-x-auto overflow-y-auto whitespace-pre-wrap font-mono border-t border-gray-800 select-text flex-1 min-h-0 max-h-48"
            >
              {runResult.output || (interactiveSessionId ? '' : '(无输出)')}
            </pre>
          )}
          {interactiveSessionId && (
            <div className="shrink-0 border-t border-gray-700 bg-gray-800/80 px-4 py-3">
              {runResult.status === 'running' && /密码|password/i.test(runResult.output) && (
                <div className="text-amber-400/90 text-xs font-medium mb-2 flex items-center gap-1.5">
                  <Lock size={12} />
                  请在下方输入 sudo 密码后点击「发送」或按回车
                </div>
              )}
              {runResult.status === 'running' && !/密码|password/i.test(runResult.output) && (
                <div className="text-gray-500 text-xs mb-2">在下方输入命令或确认（如 y/n）后发送</div>
              )}
              <div className="flex items-center gap-2">
                <input
                  type={/密码|password/i.test(runResult.output) ? 'password' : 'text'}
                  value={interactiveInput}
                  onChange={e => setInteractiveInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); sendInteractiveInput(); } }}
                  placeholder={/密码|password/i.test(runResult.output) ? '输入 sudo 密码（不会显示）' : '输入命令或确认 (如 y/n)...'}
                  className="flex-1 px-3 py-2 rounded bg-gray-900 border border-gray-600 text-gray-200 text-sm font-mono placeholder-gray-500 focus:border-amber-500 focus:ring-1 focus:ring-amber-500/30 focus:outline-none"
                  autoFocus={runResult.status === 'running'}
                />
                <button
                  type="button"
                  onClick={sendInteractiveInput}
                  disabled={!interactiveInput.trim()}
                  className="px-4 py-2 rounded bg-amber-600 text-white text-sm font-medium hover:bg-amber-500 disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
                >
                  发送
                </button>
              </div>
            </div>
          )}
        </div>
      )}
        </div>
      )}

      {/* Sudo 密码弹窗（Run 前） */}
      {showSudoDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setShowSudoDialog(false)}>
          <div className="bg-gray-800 border border-gray-600 rounded-lg shadow-xl p-4 w-[320px] max-w-[90vw]" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-2 text-gray-200 font-medium mb-3">
              <Lock size={18} className="text-amber-400" />
              需要 sudo 密码
            </div>
            <p className="text-sm text-gray-400 mb-3">该命令需要管理员权限，请输入密码后执行（可选保存到本 workspace，下次自动执行）。</p>
            <input
              type="password"
              value={sudoPassword}
              onChange={e => setSudoPassword(e.target.value)}
              placeholder="sudo 密码"
              className="w-full px-3 py-2 rounded bg-gray-900 border border-gray-600 text-gray-200 placeholder-gray-500 focus:border-amber-500 focus:outline-none mb-3"
              autoFocus
              onKeyDown={e => { if (e.key === 'Enter' && sudoPassword.trim()) { setSudoPasswordToCache(sudoPassword); doRun(sudoPassword); } }}
            />
            <label className="flex items-center gap-2 text-sm text-gray-400 mb-4 cursor-pointer">
              <input type="checkbox" checked={rememberSudo} onChange={e => setRememberSudo(e.target.checked)} className="rounded" />
              记住密码并自动执行
            </label>
            <div className="flex justify-end gap-2">
              <button onClick={() => { setShowSudoDialog(false); setSudoPassword(''); setRunResult({ status: 'idle', output: '' }); }} className="px-3 py-1.5 rounded bg-gray-700 text-gray-300 hover:bg-gray-600">
                取消
              </button>
              <button
                onClick={() => {
                  const pwd = sudoPassword.trim();
                  if (pwd) {
                    setSudoPasswordToCache(pwd);
                    doRun(pwd);
                  }
                }}
                disabled={!sudoPassword.trim()}
                className="px-3 py-1.5 rounded bg-amber-600 text-white hover:bg-amber-500 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                确定并执行
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 创建终端前需输入 sudo 密码（保存到浏览器 cache，下次不再提醒） */}
      {showSudoDialogForTerminal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => { setShowSudoDialogForTerminal(false); setSudoPassword(''); }}>
          <div className="bg-gray-800 border border-gray-600 rounded-lg shadow-xl p-4 w-[320px] max-w-[90vw]" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-2 text-gray-200 font-medium mb-3">
              <Lock size={18} className="text-amber-400" />
              需要 sudo 密码
            </div>
            <p className="text-sm text-gray-400 mb-3">密码将保存到浏览器本地，之后执行含 sudo 的命令将不再提醒。输入后即创建终端并执行。</p>
            <input
              type="password"
              value={sudoPassword}
              onChange={e => setSudoPassword(e.target.value)}
              placeholder="sudo 密码"
              className="w-full px-3 py-2 rounded bg-gray-900 border border-gray-600 text-gray-200 placeholder-gray-500 focus:border-amber-500 focus:outline-none mb-3"
              autoFocus
              onKeyDown={async e => {
                if (e.key !== 'Enter') return;
                const pwd = sudoPassword.trim();
                if (!pwd) return;
                e.preventDefault();
                setSudoPasswordToCache(pwd);
                setSudoPassword('');
                startWsRun();
              }}
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => { setShowSudoDialogForTerminal(false); setSudoPassword(''); }}
                className="px-3 py-1.5 rounded bg-gray-700 text-gray-300 hover:bg-gray-600"
              >
                取消
              </button>
              <button
                type="button"
                disabled={!sudoPassword.trim()}
                onClick={() => {
                  const pwd = sudoPassword.trim();
                  if (!pwd) return;
                  setSudoPasswordToCache(pwd);
                  setSudoPassword('');
                  startWsRun();
                }}
                className="px-3 py-1.5 rounded bg-amber-600 text-white hover:bg-amber-500 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                确定并创建终端执行
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 终端内 sudo 需要密码弹窗（仅当浏览器未保存密码时） */}
      {showSudoInTerminal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => { setShowSudoInTerminal(false); setSudoPasswordInTerminal(''); }}>
          <div className="bg-gray-800 border border-gray-600 rounded-lg shadow-xl p-4 w-[320px] max-w-[90vw]" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-2 text-gray-200 font-medium mb-3">
              <Lock size={18} className="text-amber-400" />
              需要 sudo 密码
            </div>
            <p className="text-sm text-gray-400 mb-3">终端中的 sudo 需要密码，请输入后发送到终端继续执行。</p>
            <input
              type="password"
              value={sudoPasswordInTerminal}
              onChange={e => setSudoPasswordInTerminal(e.target.value)}
              placeholder="sudo 密码"
              className="w-full px-3 py-2 rounded bg-gray-900 border border-gray-600 text-gray-200 placeholder-gray-500 focus:border-amber-500 focus:outline-none mb-3"
              autoFocus
              onKeyDown={e => {
                if (e.key !== 'Enter') return;
                const pwd = sudoPasswordInTerminal.trim();
                if (!pwd) return;
                e.preventDefault();
                if (wsTerminalRef.current?.ws?.readyState === WebSocket.OPEN) {
                  wsTerminalRef.current.ws.send(JSON.stringify({ type: 'input', data: pwd + '\n' }));
                }
                setSudoPasswordToCache(pwd);
                if (rememberSudoInTerminal) {
                  fetch('/api/sudo-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pwd }) }).catch(() => {});
                }
                setShowSudoInTerminal(false);
                setSudoPasswordInTerminal('');
              }}
            />
            <label className="flex items-center gap-2 text-sm text-gray-400 mb-4 cursor-pointer">
              <input type="checkbox" checked={rememberSudoInTerminal} onChange={e => setRememberSudoInTerminal(e.target.checked)} className="rounded" />
              记住密码（下次 Run 前可自动使用）
            </label>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => { setShowSudoInTerminal(false); setSudoPasswordInTerminal(''); }}
                className="px-3 py-1.5 rounded bg-gray-700 text-gray-300 hover:bg-gray-600"
              >
                取消
              </button>
              <button
                type="button"
                disabled={!sudoPasswordInTerminal.trim()}
                onClick={() => {
                  const pwd = sudoPasswordInTerminal.trim();
                  if (!pwd) return;
                  if (wsTerminalRef.current?.ws?.readyState === WebSocket.OPEN) {
                    wsTerminalRef.current.ws.send(JSON.stringify({ type: 'input', data: pwd + '\n' }));
                  }
                  setSudoPasswordToCache(pwd);
                  if (rememberSudoInTerminal) {
                    fetch('/api/sudo-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pwd }) }).catch(() => {});
                  }
                  setShowSudoInTerminal(false);
                  setSudoPasswordInTerminal('');
                }}
                className="px-3 py-1.5 rounded bg-amber-600 text-white hover:bg-amber-500 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                确定并发送到终端
              </button>
            </div>
          </div>
        </div>
      )}

      {/* HTML Preview */}
      {showPreview && isHtml && (
        <div className="border-t border-gray-700">
          <div className="px-4 py-1.5 text-xs font-medium text-blue-400 bg-gray-800 flex items-center justify-between">
            <span>HTML Preview</span>
            <button onClick={() => setShowPreview(false)} className="text-gray-500 hover:text-white">✕</button>
          </div>
          <div className="bg-white">
            <iframe
              srcDoc={code}
              sandbox="allow-scripts allow-modals"
              className="w-full border-0"
              style={{ minHeight: '200px', height: '400px' }}
              title="HTML Preview"
            />
          </div>
        </div>
      )}
    </div>
  );
}

interface Props {
  content: string;
  provider?: APIProvider | null;
  /** 将选中内容（或全部 Run 输出）引用到对话输入框 */
  onQuoteToInput?: (text: string) => void;
  /** 引用到输入并立即发送（用于 WebSocket 终端等） */
  onQuoteToInputAndSend?: (text: string) => void;
  /** 在宿主应用内打开 HTTP(S) 链接，例如创建网页标签页。 */
  onOpenUrl?: (url: string, title?: string) => void;
}

export default function MarkdownRenderer({ content, provider, onQuoteToInput, onQuoteToInputAndSend, onOpenUrl }: Props) {
  return (
    <div className="prose prose-invert max-w-none
      [&_h1]:text-2xl [&_h1]:font-bold [&_h1]:mb-4 [&_h1]:mt-6 [&_h1]:text-white
      [&_h2]:text-xl [&_h2]:font-bold [&_h2]:mb-3 [&_h2]:mt-5 [&_h2]:text-white
      [&_h3]:text-lg [&_h3]:font-semibold [&_h3]:mb-2 [&_h3]:mt-4 [&_h3]:text-white
      [&_p]:mb-3 [&_p]:leading-relaxed [&_p]:text-gray-200
      [&_ul]:mb-3 [&_ul]:pl-6 [&_ul]:list-disc [&_ul]:text-gray-200
      [&_ol]:mb-3 [&_ol]:pl-6 [&_ol]:list-decimal [&_ol]:text-gray-200
      [&_li]:mb-1
      [&_blockquote]:border-l-4 [&_blockquote]:border-blue-500 [&_blockquote]:pl-4 [&_blockquote]:py-1 [&_blockquote]:my-3 [&_blockquote]:bg-blue-950/30 [&_blockquote]:rounded-r
      [&_table]:border-collapse [&_table]:w-full [&_table]:my-3
      [&_th]:border [&_th]:border-gray-600 [&_th]:px-3 [&_th]:py-2 [&_th]:bg-gray-800 [&_th]:text-left
      [&_td]:border [&_td]:border-gray-700 [&_td]:px-3 [&_td]:py-2
      [&_a]:text-blue-400 [&_a]:underline hover:[&_a]:text-blue-300
      [&_hr]:border-gray-700 [&_hr]:my-4
      [&_strong]:text-white [&_strong]:font-semibold
      [&_em]:italic
      [&_img]:rounded-lg [&_img]:max-w-full [&_img]:my-3
    ">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeKatex, { throwOnError: false, errorColor: '#f87171', strict: false }]]}
        components={{
          code: (codeProps) => <CodeBlock {...codeProps} provider={provider} onQuoteToInput={onQuoteToInput} onQuoteToInputAndSend={onQuoteToInputAndSend} onOpenUrl={onOpenUrl} />,
          // ReactMarkdown v10 no longer passes the old `inline` prop for every
          // code node. Mark children of <pre> explicitly so an unlabeled
          // fenced Python block is still rendered as a runnable block.
          pre: ({ children }) => (
            <>{Children.map(children, child => (
              isValidElement(child) ? cloneElement(child as any, { __block: true }) : child
            ))}</>
          ),
          a: ({ href, children, ...rest }) => {
            const safeHref = (() => {
              if (!href) return undefined;
              const trimmed = href.trim();
              if (/^(https?:|mailto:|tel:|ftp:|file:|\/|#)/i.test(trimmed)) return trimmed;
              if (/^[\w.-]+\.[a-z]{2,}([/?#].*)?$/i.test(trimmed)) return `https://${trimmed}`;
              return trimmed;
            })();
            return (
              <a
                {...rest}
                href={safeHref}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-400 hover:text-blue-300 underline underline-offset-2 break-all"
                onClick={e => {
                  if (!safeHref || safeHref.startsWith('#')) return;
                  e.preventDefault();
                  if (onOpenUrl && /^https?:/i.test(safeHref)) {
                    onOpenUrl(safeHref);
                    return;
                  }
                  try { window.open(safeHref, '_blank', 'noopener,noreferrer'); } catch {}
                }}
              >
                {children}
              </a>
            );
          },
        }}
      >
        {normalizeMathDelimiters(content)}
      </ReactMarkdown>
    </div>
  );
}
