import { useCallback, useEffect, useRef, useState } from 'react';
import { ClipboardPaste, Copy, Loader2, Terminal } from 'lucide-react';
import TerminalSession, { type TerminalSessionHandle } from './TerminalSession';
import { getDesktop } from '../lib/desktopBridge';
import type { APIProvider } from '../types';

/**
 * Desktop Agent lives in a normal center tab. The PTY is the same virtual
 * terminal used by the terminal dock; opening the tab starts Fusion in the
 * background and types the Agent command automatically, so there is no
 * second launcher window or task/options form to configure.
 */
interface Props {
  onOpenPath?: (path: string, cwd?: string) => void;
  onOpenUrl?: (url: string, title?: string) => void;
  defaultProvider?: APIProvider | null;
}

type OpenSuggestion = { label: string; kind: 'url' | 'path'; target: string; reason?: string };

function parseOpenSuggestionJson(raw: string): any {
  const cleaned = raw.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  try { return JSON.parse(cleaned); } catch { /* try the bounded object below */ }
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
  throw new Error('默认模型没有返回有效 JSON');
}

export default function DesktopAgentPanel({ onOpenPath, onOpenUrl, defaultProvider }: Props) {
  const [wsAvailable, setWsAvailable] = useState<boolean | null>(null);
  const [status, setStatus] = useState('正在准备虚拟终端…');
  const [fusionPort, setFusionPort] = useState('8876');
  const terminalRef = useRef<TerminalSessionHandle>(null);
  const selectionRef = useRef<string | null>(null);
  const [openBusy, setOpenBusy] = useState(false);
  const [openError, setOpenError] = useState('');
  const [openResult, setOpenResult] = useState<{ summary: string; suggestions: OpenSuggestion[]; selected: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const prepare = async () => {
      try {
        const desktop = getDesktop();
        if (desktop) {
          const result = await desktop.ensureFusion();
          if (!result.ok) throw new Error(result.error || 'Fusion 服务启动失败');
          if (result.port) setFusionPort(String(result.port));
        }
        const response = await fetch('/api/terminal-ws-available');
        const data = await response.json().catch(() => ({}));
        if (!cancelled) {
          setWsAvailable(data?.available === true);
          setStatus(data?.available === true ? 'Desktop Agent 已连接到虚拟终端' : '虚拟终端服务不可用，可使用下方命令行输入');
        }
      } catch (error) {
        if (!cancelled) {
          setWsAvailable(false);
          setStatus(error instanceof Error ? error.message : String(error));
        }
      }
    };
    void prepare();
    return () => { cancelled = true; };
  }, []);

  // PTY sessions start in server.py's workspace/ directory. The Agent path is
  // therefore one level up, while FUSION_DATA_DIR is intentionally kept
  // project-relative (the Agent resolves it against its parent project).
  const command = `FUSION_PORT=${fusionPort} FUSION_DATA_DIR=.multillm-fusion-data bash ../desktop-agent/run.sh chat --base-url http://127.0.0.1:${fusionPort}/v1`;

  const analyzeSelection = useCallback(async (selected: string) => {
    const text = selected.trim();
    if (!text) return;
    setOpenResult(null);
    setOpenError('');
    if (!defaultProvider?.baseUrl || !defaultProvider.selectedModel) {
      setOpenError('尚未设置默认大模型。请在 API Provider 编辑窗口中勾选“设为默认大模型”。');
      return;
    }
    setOpenBusy(true);
    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baseUrl: defaultProvider.baseUrl,
          apiKey: defaultProvider.apiKey,
          model: defaultProvider.selectedModel,
          apiType: defaultProvider.apiType,
          stream: false,
          temperature: 0,
          max_tokens: 500,
          messages: [{ role: 'system', content: '你是桌面终端打开方式识别器。只输出 JSON 对象，不要 Markdown。格式：{"summary":"简短说明","suggestions":[{"label":"按钮文字","kind":"url或path","target":"必须原样来自用户文本","reason":"原因"}]}。只能返回用户文本中原样出现的 http(s) URL、相对路径或绝对文件路径，禁止猜测、改写或编造目标；没有可打开目标时 suggestions 必须为空数组。' }, { role: 'user', content: `请分析下面终端选中的文本，给出可打开的 URL、相对路径或绝对文件路径：\n\n${text.slice(0, 12000)}` }],
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`);
      const raw = data?.choices?.[0]?.message?.content;
      const parsed = typeof raw === 'string' ? parseOpenSuggestionJson(raw) : null;
      const suggestions = Array.isArray(parsed?.suggestions) ? parsed.suggestions.filter((item: any) => (
        item && (item.kind === 'url' || item.kind === 'path') && typeof item.target === 'string' &&
        item.target.trim() && text.includes(item.target.trim())
      )).slice(0, 8).map((item: any) => ({
        label: typeof item.label === 'string' && item.label.trim() ? item.label.trim() : item.target.trim(),
        kind: item.kind,
        target: item.target.trim(),
        reason: typeof item.reason === 'string' ? item.reason.trim() : '',
      })) : [];
      setOpenResult({ summary: typeof parsed?.summary === 'string' ? parsed.summary : '已分析终端选中内容', suggestions, selected: text });
    } catch (error) {
      setOpenError(error instanceof Error ? `默认模型识别失败：${error.message}` : `默认模型识别失败：${String(error)}`);
    } finally {
      setOpenBusy(false);
    }
  }, [defaultProvider]);

  const openSuggestion = useCallback((suggestion: OpenSuggestion) => {
    if (suggestion.kind === 'url') {
      if (onOpenUrl) onOpenUrl(suggestion.target);
      else window.open(suggestion.target, '_blank', 'noopener,noreferrer');
      return;
    }
    if (onOpenPath) {
      void terminalRef.current?.getCwd().then(cwd => onOpenPath(suggestion.target, cwd || undefined));
      return;
    }
    const desktop = getDesktop();
    if (desktop) {
      void (async () => {
        const cwd = await terminalRef.current?.getCwd();
        const result = await desktop.openTarget({ target: suggestion.target, cwd: cwd || undefined });
        if (!result.ok) setOpenError(result.error || '默认应用打开失败');
      })();
    }
  }, [onOpenPath, onOpenUrl]);

  return (
    <div className="h-full min-h-0 flex flex-col bg-gray-950 text-gray-100">
      <div className="h-9 shrink-0 flex items-center gap-2 px-3 border-b border-gray-800 text-xs">
        <Terminal size={14} className="text-amber-300" />
        <span className="font-medium">Desktop Agent</span>
        <span className="text-gray-500">·</span>
        <span className="text-gray-500" role="status">{wsAvailable === null && <Loader2 size={12} className="inline mr-1 animate-spin" />}{status}</span>
        <span className="text-gray-600 hidden md:inline" title="浏览器支持的文件或网址打开为网页 Tab，其余路径使用系统默认应用">· 按住 Ctrl 点击路径/网址打开 · 右键选中文本让默认模型识别</span>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onMouseDown={e => { selectionRef.current = window.getSelection()?.toString().trim() || null; e.preventDefault(); }}
            onClick={() => { void terminalRef.current?.copySelection(selectionRef.current); selectionRef.current = null; }}
            className="p-1.5 rounded text-gray-500 hover:text-white hover:bg-gray-800"
            title="复制选中内容"
            aria-label="复制选中内容"
          ><Copy size={13} /></button>
          <button
            type="button"
            onClick={() => { void terminalRef.current?.pasteClipboard(); }}
            className="p-1.5 rounded text-gray-500 hover:text-white hover:bg-gray-800"
            title="粘贴剪贴板内容"
            aria-label="粘贴剪贴板内容"
          ><ClipboardPaste size={13} /></button>
        </div>
      </div>
      {(openBusy || openError || openResult) && (
        <div className="shrink-0 border-b border-gray-800 bg-gray-900/90 px-3 py-2 text-xs">
          {openBusy && <div className="text-cyan-300 flex items-center gap-1"><Loader2 size={12} className="animate-spin" /> 默认模型正在分析选中内容…</div>}
          {openError && <div className="text-red-300 whitespace-pre-wrap">{openError}</div>}
          {openResult && (
            <div className="space-y-1">
              <div className="text-gray-300">{openResult.summary}</div>
              {openResult.suggestions.length ? openResult.suggestions.map((suggestion, index) => (
                <button key={`${suggestion.target}-${index}`} type="button" onClick={() => openSuggestion(suggestion)} className="block max-w-full text-left text-sky-300 hover:text-sky-200 hover:underline truncate" title={suggestion.target}>
                  ↗ {suggestion.label} <span className="text-gray-500">· {suggestion.kind === 'url' ? '网页 Tab 打开' : '浏览器支持时网页 Tab，否则默认应用'} · {suggestion.target}{suggestion.reason ? ` · ${suggestion.reason}` : ''}</span>
                </button>
              )) : <div className="text-gray-500">没有识别到可打开的 URL 或文件路径。</div>}
            </div>
          )}
        </div>
      )}
      <div className="flex-1 min-h-0">
        {wsAvailable !== null ? (
          <TerminalSession ref={terminalRef} active wsAvailable={wsAvailable} initialCommand={command} onOpenPath={onOpenPath} onOpenUrl={onOpenUrl} onSelectedContextMenu={analyzeSelection} />
        ) : (
          <div className="h-full flex items-center justify-center text-gray-500 text-sm">正在连接虚拟终端…</div>
        )}
      </div>
    </div>
  );
}
