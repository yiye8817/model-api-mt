import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, FolderOpen, Loader2, Play, ShieldAlert, Terminal as TerminalIcon } from 'lucide-react';
import DirPicker from './DirPicker';
import TerminalSession from './TerminalSession';

type CodexLaunchMode = 'default' | 'yolo';

interface Props {
  /** 后端报告的默认工作目录；目录仍需用户确认后才启动 Codex。 */
  defaultCwd?: string;
  /** 标签页 id 和工作目录回调，供文件管理器跟随当前 Codex 标签。 */
  tabId?: string;
  onCwdChange?: (tabId: string, cwd: string) => void;
  onOpenPath?: (path: string, cwd?: string) => void;
  onOpenUrl?: (url: string, title?: string) => void;
}

const LAST_CWD_KEY = 'codexTerm/lastCwd';

function readStored(key: string): string {
  try { return localStorage.getItem(key) || ''; } catch { return ''; }
}

/** Quote one argument for the login shell used by the shared PTY. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildCodexCommand(cwd: string, mode: CodexLaunchMode): string {
  const yolo = mode === 'yolo' ? ' --dangerously-bypass-approvals-and-sandbox' : '';
  return `codex --cd ${shellQuote(cwd)}${yolo}`;
}

/** A Codex CLI session in the shared PTY, with an explicit launch directory and mode. */
export default function CodexTerminalPanel({ defaultCwd = '', tabId, onCwdChange, onOpenPath, onOpenUrl }: Props) {
  const [wsAvailable, setWsAvailable] = useState<boolean | null>(null);
  const [serverDefaultCwd, setServerDefaultCwd] = useState(defaultCwd);
  const [cwdDraft, setCwdDraft] = useState(() => readStored(LAST_CWD_KEY) || defaultCwd);
  const [mode, setMode] = useState<CodexLaunchMode>('default');
  const [showPicker, setShowPicker] = useState(false);
  const [launched, setLaunched] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/terminal-ws-available')
      .then(response => response.json())
      .then(data => { if (!cancelled) setWsAvailable(data?.available === true); })
      .catch(() => { if (!cancelled) setWsAvailable(false); });
    return () => { cancelled = true; };
  }, []);

  // App usually supplies this value through its existing availability probe. The
  // fallback keeps this tab usable when it is opened before that probe completes.
  useEffect(() => {
    if (defaultCwd) {
      setServerDefaultCwd(defaultCwd);
      setCwdDraft(current => current || defaultCwd);
      return;
    }
    let cancelled = false;
    fetch('/api/claude/available')
      .then(response => response.ok ? response.json() : null)
      .then(data => {
        if (cancelled || !data?.default_cwd) return;
        setServerDefaultCwd(data.default_cwd);
        setCwdDraft(current => current || data.default_cwd);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [defaultCwd]);

  const initialCommand = useMemo(() => {
    const target = cwdDraft.trim() || serverDefaultCwd.trim();
    return target ? buildCodexCommand(target, mode) : '';
  }, [cwdDraft, mode, serverDefaultCwd]);

  const selectedCwd = cwdDraft.trim() || serverDefaultCwd.trim();
  useEffect(() => {
    if (launched && tabId && selectedCwd) onCwdChange?.(tabId, selectedCwd);
  }, [launched, onCwdChange, selectedCwd, tabId]);

  const launch = useCallback(() => {
    const target = selectedCwd;
    if (!target || wsAvailable !== true || !initialCommand) return;
    try {
      localStorage.setItem(LAST_CWD_KEY, target);
    } catch { /* localStorage is optional */ }
    setCwdDraft(target);
    setLaunched(true);
  }, [initialCommand, mode, selectedCwd, wsAvailable]);

  const handlePickDir = useCallback((path: string) => {
    setShowPicker(false);
    setCwdDraft(path);
  }, []);

  if (!launched) {
    return (
      <div className="h-full min-h-0 flex flex-col items-center justify-center bg-[#0b1120] text-gray-100 p-8">
        <div className="w-full max-w-xl rounded-xl border border-gray-700 bg-gray-900 p-5 space-y-4">
          <div className="flex items-center gap-2 text-cyan-300 font-medium">
            <TerminalIcon size={18} /> 新建 Codex 终端
          </div>
          <p className="text-xs text-gray-500">启动 Codex 前请选择工作目录和启动模式。</p>

          <div className="space-y-1.5">
            <label className="text-xs text-gray-400">工作目录</label>
            <div className="flex items-center gap-2">
              <FolderOpen size={15} className="text-amber-400 shrink-0" />
              <input
                value={cwdDraft}
                onChange={event => setCwdDraft(event.target.value)}
                onKeyDown={event => { if (event.key === 'Enter') launch(); }}
                className="flex-1 min-w-0 rounded border border-gray-700 bg-gray-800 px-2 py-1.5 font-mono text-xs outline-none focus:border-cyan-500"
                placeholder="项目根目录绝对路径"
                autoFocus
              />
              <button
                type="button"
                onClick={() => setShowPicker(true)}
                className="flex items-center gap-1 rounded border border-gray-700 bg-gray-800 px-2 py-1.5 text-xs text-gray-300 hover:bg-gray-700"
              >
                <FolderOpen size={13} /> 浏览
              </button>
            </div>
            {serverDefaultCwd && (
              <button type="button" onClick={() => setCwdDraft(serverDefaultCwd)} className="text-[11px] text-gray-500 hover:text-cyan-300" title={serverDefaultCwd}>
                使用默认工作区：<span className="font-mono">{serverDefaultCwd}</span>
              </button>
            )}
          </div>

          <div className="space-y-1.5">
            <div className="text-xs text-gray-400">启动模式</div>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setMode('default')}
                className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-left ${mode === 'default' ? 'border-cyan-500/70 bg-cyan-950/40 text-cyan-100' : 'border-gray-700 bg-gray-800/70 text-gray-300 hover:bg-gray-800'}`}
              >
                <span className={`mt-0.5 flex h-4 w-4 items-center justify-center rounded-full border ${mode === 'default' ? 'border-cyan-300 bg-cyan-400 text-gray-950' : 'border-gray-500'}`}>
                  {mode === 'default' && <Check size={11} />}
                </span>
                <span>
                  <span className="block text-sm font-medium">默认</span>
                  <span className="mt-0.5 block text-[11px] text-gray-500">按 Codex 的确认和沙箱策略运行</span>
                </span>
              </button>
              <button
                type="button"
                onClick={() => setMode('yolo')}
                className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-left ${mode === 'yolo' ? 'border-amber-500/70 bg-amber-950/40 text-amber-100' : 'border-gray-700 bg-gray-800/70 text-gray-300 hover:bg-gray-800'}`}
              >
                <span className={`mt-0.5 flex h-4 w-4 items-center justify-center rounded-full border ${mode === 'yolo' ? 'border-amber-300 bg-amber-400 text-gray-950' : 'border-gray-500'}`}>
                  {mode === 'yolo' && <Check size={11} />}
                </span>
                <span>
                  <span className="flex items-center gap-1 text-sm font-medium"><ShieldAlert size={13} className="text-amber-300" />YOLO</span>
                  <span className="mt-0.5 block text-[11px] text-gray-500">自动批准并跳过沙箱限制</span>
                </span>
              </button>
            </div>
          </div>

          <div className="flex items-center justify-between gap-3 border-t border-gray-800 pt-3">
            <span className="text-[11px] text-gray-500">
              {wsAvailable === null && <><Loader2 size={12} className="mr-1 inline animate-spin" />正在连接终端服务…</>}
              {wsAvailable === false && '虚拟终端服务不可用，请先启动后端。'}
              {wsAvailable === true && (initialCommand ? `将执行：${initialCommand}` : '请先填写工作目录。')}
            </span>
            <button
              type="button"
              onClick={launch}
              disabled={wsAvailable !== true || !initialCommand}
              className="flex shrink-0 items-center gap-1.5 rounded bg-cyan-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-cyan-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Play size={14} /> 启动 Codex
            </button>
          </div>
        </div>
        {showPicker && (
          <DirPicker
            initialDir={cwdDraft || serverDefaultCwd}
            onSelect={handlePickDir}
            onClose={() => setShowPicker(false)}
            title="选择工作目录（Codex）"
          />
        )}
      </div>
    );
  }

  return (
    <div className="h-full min-h-0 flex flex-col bg-gray-950 text-gray-100">
      <div className="h-9 shrink-0 flex items-center gap-2 px-3 border-b border-gray-800 text-xs">
        <TerminalIcon size={14} className="text-cyan-300" />
        <span className="font-medium">Codex 虚拟终端</span>
        <span className="text-gray-500">·</span>
        <span className="text-gray-400">{mode === 'yolo' ? 'YOLO' : '默认'}</span>
        <span className="text-gray-600">·</span>
        <span className="min-w-0 truncate font-mono text-gray-500" title={cwdDraft}>{cwdDraft}</span>
        <span className="ml-auto flex items-center gap-1 text-emerald-400"><Check size={12} />已启动</span>
      </div>
      <div className="flex-1 min-h-0">
        <TerminalSession active wsAvailable={wsAvailable} initialCommand={initialCommand} onOpenPath={onOpenPath} onOpenUrl={onOpenUrl} />
      </div>
    </div>
  );
}
