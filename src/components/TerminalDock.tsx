import { useState, useRef, useEffect, useCallback } from 'react';
import { Terminal as TerminalIcon, X, Plus, Maximize2, Trash2, MessageCircle, ChevronUp, Minus, Copy, ClipboardPaste } from 'lucide-react';
import TerminalSession, { type TerminalSessionHandle } from './TerminalSession';

interface Props {
  visible: boolean;
  onClose: () => void;
  onSendToChat?: (text: string) => void;
  onOpenPath?: (path: string, cwd?: string) => void;
  onOpenUrl?: (url: string, title?: string) => void;
}

interface TermTab { id: string; title: string; initialCwd?: string | null }

const HEIGHT_KEY = 'terminalDock/height';
const MINIMIZED_KEY = 'terminalDock/minimized';
const DEFAULT_HEIGHT = 320;
const MIN_HEIGHT = 100;
const HEADER_HEIGHT = 36;

function readHeight(): number {
  try {
    const v = parseInt(localStorage.getItem(HEIGHT_KEY) || '', 10);
    return Number.isFinite(v) && v >= MIN_HEIGHT ? v : DEFAULT_HEIGHT;
  } catch { return DEFAULT_HEIGHT; }
}

function readMinimized(): boolean {
  try { return localStorage.getItem(MINIMIZED_KEY) === '1'; } catch { return false; }
}

export default function TerminalDock({ visible, onClose, onSendToChat, onOpenPath, onOpenUrl }: Props) {
  const [wsAvailable, setWsAvailable] = useState<boolean | null>(null);
  const [tabs, setTabs] = useState<TermTab[]>([{ id: 'term-1', title: '终端 1' }]);
  const [activeId, setActiveId] = useState('term-1');
  const [maximized, setMaximized] = useState(false);
  const [minimized, setMinimized] = useState(readMinimized);
  const [height, setHeight] = useState(readHeight);
  const [addingTab, setAddingTab] = useState(false);
  const seqRef = useRef(1);
  const handlesRef = useRef<Map<string, TerminalSessionHandle>>(new Map());
  const lastSelectionRef = useRef<string | null>(null);
  const heightBeforeMinimizeRef = useRef(height);

  useEffect(() => {
    if (!visible || wsAvailable !== null) return;
    fetch('/api/terminal-ws-available')
      .then(r => r.json())
      .then(d => setWsAvailable(!!d?.available))
      .catch(() => setWsAvailable(false));
  }, [visible, wsAvailable]);

  useEffect(() => {
    try { localStorage.setItem(HEIGHT_KEY, String(height)); } catch { /* noop */ }
  }, [height]);

  useEffect(() => {
    try { localStorage.setItem(MINIMIZED_KEY, minimized ? '1' : '0'); } catch { /* noop */ }
  }, [minimized]);

  const fitActive = useCallback(() => {
    requestAnimationFrame(() => {
      handlesRef.current.get(activeId)?.fit();
    });
  }, [activeId]);

  useEffect(() => {
    if (!visible || minimized || maximized) return;
    fitActive();
  }, [visible, minimized, maximized, height, fitActive]);

  const addTab = useCallback(async () => {
    if (addingTab) return;
    setAddingTab(true);
    const sourceId = activeId;
    let initialCwd: string | null = null;
    try {
      initialCwd = await handlesRef.current.get(sourceId)?.getCwd() || null;
    } catch {
      initialCwd = null;
    }
    seqRef.current += 1;
    const id = `term-${seqRef.current}`;
    setTabs(prev => [...prev, { id, title: `终端 ${seqRef.current}`, initialCwd }]);
    setActiveId(id);
    if (minimized) setMinimized(false);
    setAddingTab(false);
  }, [activeId, addingTab, minimized]);

  const closeTab = useCallback((id: string) => {
    setTabs(prev => {
      const next = prev.filter(t => t.id !== id);
      if (next.length === 0) {
        onClose();
        return prev;
      }
      setActiveId(cur => {
        if (cur !== id) return cur;
        const idx = prev.findIndex(t => t.id === id);
        return (next[idx] || next[idx - 1] || next[0]).id;
      });
      return next;
    });
    handlesRef.current.delete(id);
  }, [onClose]);

  const toggleMinimize = useCallback(() => {
    setMinimized((v) => {
      if (!v) heightBeforeMinimizeRef.current = height;
      else setHeight(heightBeforeMinimizeRef.current);
      return !v;
    });
    if (maximized) setMaximized(false);
  }, [height, maximized]);

  const toggleMaximize = useCallback(() => {
    setMaximized((v) => {
      if (!v && minimized) setMinimized(false);
      return !v;
    });
  }, [minimized]);

  const startResize = useCallback((e: React.MouseEvent) => {
    if (maximized) return;
    e.preventDefault();
    const startY = e.clientY;
    const startH = minimized ? heightBeforeMinimizeRef.current : height;

    const onMove = (ev: MouseEvent) => {
      const next = startH + (startY - ev.clientY);
      if (next < MIN_HEIGHT * 0.65) {
        heightBeforeMinimizeRef.current = Math.max(MIN_HEIGHT, startH);
        setMinimized(true);
        return;
      }
      setMinimized(false);
      setHeight(Math.min(window.innerHeight * 0.85, Math.max(MIN_HEIGHT, next)));
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      fitActive();
    };
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [height, maximized, minimized, fitActive]);

  if (!visible) return null;

  const dockStyle = maximized
    ? undefined
    : minimized
      ? { height: HEADER_HEIGHT }
      : { height };

  return (
    <div
      className={`flex flex-col bg-gray-950 border-t border-gray-700 shrink-0 relative ${maximized ? 'fixed inset-0 z-50' : ''}`}
      style={dockStyle}
    >
      {/* 顶部拖拽条：调整高度 */}
      {!maximized && (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="拖动调整终端高度"
          onMouseDown={startResize}
          className="absolute top-0 left-0 right-0 h-2 cursor-ns-resize z-20 flex items-center justify-center group -translate-y-1/2"
          title="拖动调整高度"
        >
          <div className="w-10 h-1 rounded-full bg-gray-600/80 group-hover:bg-purple-400/70 transition-colors" />
        </div>
      )}

      {/* 头部：标题 + 多标签 + 操作 */}
      <div className="flex items-center justify-between px-2 bg-gray-900 border-b border-gray-700 shrink-0 select-none" style={{ height: HEADER_HEIGHT }}>
        <div className="flex items-center gap-1 min-w-0 overflow-x-auto h-full">
          <TerminalIcon size={14} className="text-green-400 shrink-0 ml-1 mr-1" />
          {tabs.map(t => (
            <div
              key={t.id}
              onClick={() => { setActiveId(t.id); if (minimized) setMinimized(false); }}
              className={`group flex items-center gap-1 pl-2 pr-1 h-7 rounded-t cursor-pointer text-xs shrink-0 ${
                activeId === t.id ? 'bg-gray-950 text-white border border-b-0 border-gray-700' : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800'
              }`}
            >
              <TerminalIcon size={11} className="text-green-400/80" />
              <span className="whitespace-nowrap">{t.title}</span>
              <button
                onClick={(e) => { e.stopPropagation(); closeTab(t.id); }}
                className="p-0.5 rounded hover:bg-gray-700 text-gray-500 hover:text-red-400 opacity-60 group-hover:opacity-100"
                title="关闭终端"
              >
                <X size={11} />
              </button>
            </div>
          ))}
          <button onClick={() => void addTab()} disabled={addingTab} className="p-1 rounded hover:bg-gray-800 text-gray-400 hover:text-white shrink-0 disabled:opacity-50" title={addingTab ? '正在读取当前终端目录…' : '新建终端'}>
            <Plus size={14} />
          </button>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {!minimized && onSendToChat && (
            <button
              onMouseDown={e => { lastSelectionRef.current = window.getSelection()?.toString().trim() || null; e.preventDefault(); }}
              onClick={() => { handlesRef.current.get(activeId)?.sendSelectionToChat(lastSelectionRef.current); lastSelectionRef.current = null; }}
              className="p-1.5 hover:bg-gray-800 rounded text-gray-500 hover:text-white"
              title="将选中内容发送到对话"
            >
              <MessageCircle size={13} />
            </button>
          )}
          {!minimized && (
            <>
              <button
                onMouseDown={e => { lastSelectionRef.current = window.getSelection()?.toString().trim() || null; e.preventDefault(); }}
                onClick={() => { void handlesRef.current.get(activeId)?.copySelection(lastSelectionRef.current); lastSelectionRef.current = null; }}
                className="p-1.5 hover:bg-gray-800 rounded text-gray-500 hover:text-white"
                title="复制选中内容"
                aria-label="复制选中内容"
              >
                <Copy size={13} />
              </button>
              <button
                onClick={() => { void handlesRef.current.get(activeId)?.pasteClipboard(); }}
                className="p-1.5 hover:bg-gray-800 rounded text-gray-500 hover:text-white"
                title="粘贴剪贴板内容"
                aria-label="粘贴剪贴板内容"
              >
                <ClipboardPaste size={13} />
              </button>
            </>
          )}
          {!minimized && (
            <button onClick={() => handlesRef.current.get(activeId)?.clear()} className="p-1.5 hover:bg-gray-800 rounded text-gray-500 hover:text-white" title="清空当前终端">
              <Trash2 size={13} />
            </button>
          )}
          <button
            onClick={toggleMinimize}
            className="p-1.5 hover:bg-gray-800 rounded text-gray-500 hover:text-white"
            title={minimized ? '展开终端' : '最小化终端'}
          >
            {minimized ? <ChevronUp size={13} /> : <Minus size={13} />}
          </button>
          <button onClick={toggleMaximize} className="p-1.5 hover:bg-gray-800 rounded text-gray-500 hover:text-white" title={maximized ? '还原' : '最大化'}>
            <Maximize2 size={13} />
          </button>
          <button onClick={onClose} className="p-1.5 hover:bg-gray-800 rounded text-gray-500 hover:text-red-400" title="关闭面板">
            <X size={13} />
          </button>
        </div>
      </div>

      {/* 各终端会话：全部保持挂载以保留各自 shell / WS；最小化时仅隐藏 UI，不断开连接 */}
      <div className={`relative flex-1 min-h-0 ${minimized ? 'hidden' : ''}`}>
        {tabs.map(t => (
          <div key={t.id} className={`absolute inset-0 ${activeId === t.id ? '' : 'hidden'}`}>
            <TerminalSession
              ref={(h) => { if (h) handlesRef.current.set(t.id, h); else handlesRef.current.delete(t.id); }}
              active={activeId === t.id}
              wsAvailable={wsAvailable}
              initialCwd={t.initialCwd || undefined}
              onSendToChat={onSendToChat}
              onOpenPath={onOpenPath}
              onOpenUrl={onOpenUrl}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
