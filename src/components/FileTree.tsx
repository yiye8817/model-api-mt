import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Folder, FileText, FileCode, FileJson, Image as ImageIcon, File as FileIcon,
  ChevronUp, RefreshCw, Loader2, Home, Box, HardDrive, Music, Film,
} from 'lucide-react';

interface Entry {
  name: string;
  path: string;
  is_dir: boolean;
  size?: number;
}
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
  /** 首次打开时的起始目录 */
  initialDir: string;
  /** 用户点击「跟随工作区」时传入目标路径 */
  navigateTo?: string | null;
  /** 每次主动跳转时递增，确保同路径也能重新加载 */
  navigateNonce?: number;
  onOpenFile: (path: string, name: string) => void;
  onCwdChange?: (dir: string) => void;
}

const CODE_EXT = new Set(['py', 'js', 'jsx', 'ts', 'tsx', 'css', 'scss', 'sh', 'bash', 'go', 'rs', 'java', 'c', 'h', 'cpp', 'rb', 'php', 'vue', 'svelte', 'sql', 'yml', 'yaml', 'toml']);
const IMG_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif']);
const AUDIO_EXT = new Set(['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac']);
const VIDEO_EXT = new Set(['mp4', 'webm', 'mov', 'mkv', 'm4v', 'avi']);

function entryIcon(e: Entry) {
  if (e.is_dir) return <Folder size={14} className="text-amber-400 shrink-0" />;
  const ext = e.name.split('.').pop()?.toLowerCase() || '';
  if (ext === 'json') return <FileJson size={14} className="text-yellow-300 shrink-0" />;
  if (ext === 'md' || ext === 'markdown') return <FileText size={14} className="text-sky-300 shrink-0" />;
  if (CODE_EXT.has(ext)) return <FileCode size={14} className="text-emerald-300 shrink-0" />;
  if (IMG_EXT.has(ext)) return <ImageIcon size={14} className="text-pink-300 shrink-0" />;
  if (AUDIO_EXT.has(ext)) return <Music size={14} className="text-violet-300 shrink-0" />;
  if (VIDEO_EXT.has(ext)) return <Film size={14} className="text-orange-300 shrink-0" />;
  return <FileIcon size={14} className="text-gray-400 shrink-0" />;
}

const shortcutIcon = (label: string) => {
  if (label.includes('主目录')) return <Home size={12} />;
  if (label.includes('工作区')) return <Box size={12} />;
  return <HardDrive size={12} />;
};

export default function FileTree({ initialDir, navigateTo, navigateNonce, onOpenFile, onCwdChange }: Props) {
  const [cwd, setCwd] = useState(initialDir);
  const [resp, setResp] = useState<ListResp | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const initedRef = useRef(false);
  const onCwdChangeRef = useRef(onCwdChange);
  onCwdChangeRef.current = onCwdChange;

  const list = useCallback((dir: string) => {
    setLoading(true);
    setErr(null);
    fetch(`/api/local/fs/list?path=${encodeURIComponent(dir)}&show_hidden=1`)
      .then(async (r) => {
        const j = (await r.json().catch(() => ({}))) as ListResp;
        if (!r.ok) throw new Error(j?.error || `加载失败 (${r.status})`);
        setResp(j);
        setCwd(j.path);
        onCwdChangeRef.current?.(j.path);
      })
      .catch((e) => setErr(e?.message || String(e)))
      .finally(() => setLoading(false));
  }, []);

  // 仅首次挂载时根据 initialDir 加载，避免打开文件标签后跳回默认路径
  useEffect(() => {
    if (!initedRef.current) {
      initedRef.current = true;
      if (initialDir) list(initialDir);
    }
  }, [initialDir, list]);

  // 用户主动「跟随工作区」时跳转
  const lastNavNonce = useRef(0);
  useEffect(() => {
    if (navigateTo && navigateNonce && navigateNonce !== lastNavNonce.current) {
      lastNavNonce.current = navigateNonce;
      list(navigateTo);
    }
  }, [navigateTo, navigateNonce, list]);

  return (
    <div className="flex flex-col h-full text-sm">
      <div className="shrink-0 px-2 pt-2 pb-1 flex flex-wrap gap-1">
        {(resp?.shortcuts || []).map((s) => (
          <button
            key={s.path}
            onClick={() => list(s.path)}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700"
            title={s.path}
          >
            {shortcutIcon(s.label)} {s.label}
          </button>
        ))}
      </div>

      <div className="shrink-0 px-2 py-1 flex items-center gap-1 border-b border-gray-800">
        <button
          onClick={() => resp?.parent && list(resp.parent)}
          disabled={!resp?.parent}
          className="p-1 rounded hover:bg-gray-700 disabled:opacity-30 text-gray-400"
          title="上一级"
        >
          <ChevronUp size={14} />
        </button>
        <span className="flex-1 min-w-0 truncate text-[11px] font-mono text-gray-400" title={cwd} dir="rtl">{cwd}</span>
        <button onClick={() => list(cwd)} className="p-1 rounded hover:bg-gray-700 text-gray-400" title="刷新">
          {loading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {err && (
          <div className="p-3 text-xs text-amber-300">{err}</div>
        )}
        {!err && resp?.entries.map((e) => (
          <button
            key={e.path}
            onClick={() => (e.is_dir ? list(e.path) : onOpenFile(e.path, e.name))}
            onDoubleClick={() => { if (!e.is_dir) onOpenFile(e.path, e.name); }}
            className="w-full flex items-center gap-2 px-3 py-1 text-left hover:bg-gray-700/60 text-gray-200"
            title={e.path}
          >
            {entryIcon(e)}
            <span className="truncate flex-1 text-[13px]">{e.name}</span>
          </button>
        ))}
        {!err && resp && resp.entries.length === 0 && (
          <div className="p-3 text-xs text-gray-500">（空目录）</div>
        )}
      </div>
    </div>
  );
}
