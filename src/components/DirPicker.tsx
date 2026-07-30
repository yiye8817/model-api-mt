import { useCallback, useEffect, useState } from 'react';
import {
  Folder, ChevronUp, RefreshCw, Loader2, Check, X, Home, Box, HardDrive, FolderOpen, FolderPlus,
} from 'lucide-react';

interface Entry { name: string; path: string; is_dir: boolean }
interface Shortcut { label: string; path: string }
interface ListResp {
  path: string;
  parent: string | null;
  sep: string;
  shortcuts: Shortcut[];
  entries: Entry[];
  error?: string;
}

interface Props {
  initialDir: string;
  onSelect: (path: string) => void;
  onClose: () => void;
  title?: string;
}

const shortcutIcon = (label: string) => {
  if (label.includes('主目录')) return <Home size={12} />;
  if (label.includes('工作区')) return <Box size={12} />;
  return <HardDrive size={12} />;
};

export default function DirPicker({ initialDir, onSelect, onClose, title = '选择工作目录' }: Props) {
  const [resp, setResp] = useState<ListResp | null>(null);
  const [cwd, setCwd] = useState(initialDir);
  const [draft, setDraft] = useState(initialDir);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);

  const list = useCallback((dir: string) => {
    setLoading(true);
    setErr(null);
    fetch(`/api/local/fs/list?only_dirs=1&path=${encodeURIComponent(dir)}`)
      .then(async (r) => {
        const j = (await r.json().catch(() => ({}))) as ListResp;
        if (!r.ok) throw new Error(j?.error || `加载失败 (${r.status})`);
        setResp(j);
        setCwd(j.path);
        setDraft(j.path);
      })
      .catch((e) => setErr(e?.message || String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { list(initialDir || ''); }, [initialDir, list]);

  const createDir = useCallback(() => {
    const name = newName.trim();
    if (!name || !cwd) return;
    setBusy(true);
    setErr(null);
    fetch('/api/local/fs/mkdir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parent: cwd, name }),
    })
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.ok) throw new Error(j?.error || `创建失败 (${r.status})`);
        setCreating(false);
        setNewName('');
        list(j.path);   // 进入新建的目录
      })
      .catch((e) => setErr(e?.message || String(e)))
      .finally(() => setBusy(false));
  }, [newName, cwd, list]);

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="w-[560px] max-w-[92vw] max-h-[78vh] flex flex-col bg-gray-850 border border-gray-600 rounded-xl shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* header */}
        <div className="shrink-0 flex items-center gap-2 px-4 py-2.5 border-b border-gray-700">
          <FolderOpen size={16} className="text-amber-400" />
          <span className="text-sm font-medium text-gray-100 flex-1">{title}</span>
          <button onClick={onClose} className="p-1 rounded hover:bg-gray-700 text-gray-400 hover:text-white"><X size={16} /></button>
        </div>

        {/* shortcuts */}
        <div className="shrink-0 px-3 pt-2 flex flex-wrap gap-1">
          {(resp?.shortcuts || []).map((s) => (
            <button
              key={s.path}
              onClick={() => list(s.path)}
              className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700"
              title={s.path}
            >
              {shortcutIcon(s.label)} {s.label}
            </button>
          ))}
        </div>

        {/* path bar */}
        <div className="shrink-0 px-3 py-2 flex items-center gap-1">
          <button
            onClick={() => resp?.parent && list(resp.parent)}
            disabled={!resp?.parent}
            className="p-1.5 rounded hover:bg-gray-700 disabled:opacity-30 text-gray-400"
            title="上一级"
          >
            <ChevronUp size={15} />
          </button>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') list(draft.trim()); }}
            className="flex-1 min-w-0 bg-gray-800 border border-gray-700 rounded px-2 py-1 font-mono text-[11px] focus:outline-none focus:border-purple-500"
            placeholder="目录绝对路径（回车跳转）"
          />
          <button onClick={() => list(draft.trim())} className="p-1.5 rounded hover:bg-gray-700 text-gray-400" title="跳转/刷新">
            {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          </button>
          <button
            onClick={() => { setCreating((v) => !v); setErr(null); }}
            className={`p-1.5 rounded hover:bg-gray-700 ${creating ? 'text-purple-300' : 'text-gray-400'}`}
            title="在当前目录新建文件夹"
          >
            <FolderPlus size={14} />
          </button>
        </div>

        {/* 新建文件夹 */}
        {creating && (
          <div className="shrink-0 px-3 pb-2 flex items-center gap-1">
            <FolderPlus size={14} className="text-purple-300 shrink-0" />
            <input
              value={newName}
              autoFocus
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') createDir(); else if (e.key === 'Escape') { setCreating(false); setNewName(''); } }}
              className="flex-1 min-w-0 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-[11px] focus:outline-none focus:border-purple-500"
              placeholder="新文件夹名称（回车创建，Esc 取消）"
            />
            <button
              onClick={createDir}
              disabled={busy || !newName.trim()}
              className="px-2 py-1 rounded bg-purple-600 hover:bg-purple-500 text-white text-[11px] disabled:opacity-40"
            >
              {busy ? <Loader2 size={12} className="animate-spin" /> : '创建'}
            </button>
          </div>
        )}

        {/* dir list */}
        <div className="flex-1 min-h-[180px] overflow-y-auto border-t border-gray-800">
          {err && <div className="p-3 text-xs text-amber-300">{err}</div>}
          {!err && resp?.entries.map((e) => (
            <button
              key={e.path}
              onClick={() => list(e.path)}
              className="w-full flex items-center gap-2 px-4 py-1.5 text-left hover:bg-gray-700/60 text-gray-200 text-sm"
              title={e.path}
            >
              <Folder size={14} className="text-amber-400 shrink-0" />
              <span className="truncate">{e.name}</span>
            </button>
          ))}
          {!err && resp && resp.entries.length === 0 && (
            <div className="p-3 text-xs text-gray-500">（该目录下没有子目录）</div>
          )}
        </div>

        {/* footer */}
        <div className="shrink-0 flex items-center gap-2 px-4 py-2.5 border-t border-gray-700">
          <span className="text-[11px] text-gray-500 truncate flex-1" title={cwd}>当前：<span className="font-mono text-gray-300">{cwd}</span></span>
          <button onClick={onClose} className="px-3 py-1.5 rounded bg-gray-700 hover:bg-gray-600 text-gray-200 text-sm">取消</button>
          <button
            onClick={() => onSelect(cwd)}
            disabled={!cwd}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-purple-600 hover:bg-purple-500 text-white text-sm font-medium disabled:opacity-40"
          >
            <Check size={14} /> 选择此目录
          </button>
        </div>
      </div>
    </div>
  );
}
