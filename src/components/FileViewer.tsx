import { useEffect, useRef, useState } from 'react';
import hljs from 'highlight.js';
import 'highlight.js/styles/github-dark.css';
import { Loader2, FileWarning, RefreshCw, Copy, Check } from 'lucide-react';
import MarkdownRenderer from './MarkdownRenderer';

interface FileData {
  path: string;
  name: string;
  ext: string;
  lang: string;
  is_markdown: boolean;
  size: number;
  binary?: boolean;
  too_large?: boolean;
  media_kind?: 'image' | 'audio' | 'video' | '';
  content: string;
  error?: string;
}

interface Props {
  path: string;
  active: boolean;
}

const HLJS_ALIAS: Record<string, string> = {
  tsx: 'typescript', vue: 'xml', svelte: 'xml', text: 'plaintext', dockerfile: 'dockerfile',
};

function mediaServeUrl(path: string) {
  return `/api/local/fs/serve?path=${encodeURIComponent(path)}`;
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function CodeView({ content, lang }: { content: string; lang: string }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const language = HLJS_ALIAS[lang] || lang;
    try {
      if (language && hljs.getLanguage(language)) {
        el.innerHTML = hljs.highlight(content, { language }).value;
      } else {
        el.innerHTML = hljs.highlightAuto(content).value;
      }
    } catch {
      el.textContent = content;
    }
  }, [content, lang]);

  const lines = content.split('\n');
  return (
    <div className="flex text-[12.5px] font-mono leading-[1.55]">
      <div className="select-none text-right text-gray-600 bg-gray-900/60 px-3 py-3 border-r border-gray-800 shrink-0">
        {lines.map((_, i) => (
          <div key={i}>{i + 1}</div>
        ))}
      </div>
      <pre className="flex-1 overflow-x-auto py-3 px-4 bg-transparent">
        <code ref={ref} className={`hljs language-${lang} bg-transparent p-0`}>{content}</code>
      </pre>
    </div>
  );
}

function MediaPreview({ kind, path, name, size }: { kind: 'image' | 'audio' | 'video'; path: string; name: string; size: number }) {
  const url = mediaServeUrl(path);
  return (
    <div className="h-full flex flex-col items-center justify-center p-4 gap-3 bg-gray-950/50">
      <div className="text-xs text-gray-500">{name} · {formatSize(size)}</div>
      {kind === 'image' && (
        <img
          src={url}
          alt={name}
          className="max-w-full max-h-[calc(100vh-12rem)] object-contain rounded-lg border border-gray-700 shadow-lg"
        />
      )}
      {kind === 'audio' && (
        <audio src={url} controls className="w-full max-w-lg" preload="metadata">
          您的浏览器不支持音频播放
        </audio>
      )}
      {kind === 'video' && (
        <video
          src={url}
          controls
          className="max-w-full max-h-[calc(100vh-12rem)] rounded-lg border border-gray-700 shadow-lg bg-black"
          preload="metadata"
        >
          您的浏览器不支持视频播放
        </video>
      )}
    </div>
  );
}

export default function FileViewer({ path, active }: Props) {
  const [data, setData] = useState<FileData | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = () => {
    setLoading(true);
    setErr(null);
    fetch(`/api/local/fs/read?path=${encodeURIComponent(path)}`)
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j?.error || `读取失败 (${r.status})`);
        setData(j as FileData);
      })
      .catch((e) => setErr(e?.message || String(e)))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [path]);

  const copyAll = () => {
    if (!data?.content) return;
    navigator.clipboard?.writeText(data.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const mediaKind = data?.media_kind as 'image' | 'audio' | 'video' | undefined;

  return (
    <div className={`flex flex-col h-full bg-gray-900 text-gray-100 ${active ? '' : ''}`}>
      <div className="shrink-0 border-b border-gray-700 px-3 py-1.5 flex items-center gap-2 text-xs">
        <span className="font-mono text-gray-300 truncate flex-1" title={path}>{data?.name || path}</span>
        {data && mediaKind && (
          <span className="text-gray-500">{mediaKind} · {formatSize(data.size)}</span>
        )}
        {data && !data.binary && !data.too_large && !mediaKind && (
          <span className="text-gray-500">{data.is_markdown ? 'Markdown' : (data.lang || 'text')} · {formatSize(data.size)}</span>
        )}
        {data?.content ? (
          <button onClick={copyAll} className="flex items-center gap-1 px-2 py-1 rounded hover:bg-gray-700 text-gray-400 hover:text-white" title="复制全部">
            {copied ? <Check size={13} /> : <Copy size={13} />}
          </button>
        ) : null}
        <button onClick={load} className="p-1 rounded hover:bg-gray-700 text-gray-400 hover:text-white" title="重新加载">
          <RefreshCw size={13} />
        </button>
      </div>

      <div className="flex-1 overflow-auto">
        {loading && (
          <div className="h-full flex items-center justify-center text-gray-500 gap-2 text-sm">
            <Loader2 size={16} className="animate-spin" /> 加载中…
          </div>
        )}
        {!loading && err && (
          <div className="h-full flex flex-col items-center justify-center text-gray-400 gap-2 text-sm p-8 text-center">
            <FileWarning size={26} className="text-amber-400" />
            <div>{err}</div>
            <button onClick={load} className="mt-2 px-3 py-1 rounded bg-gray-800 hover:bg-gray-700 border border-gray-700">重试</button>
          </div>
        )}
        {!loading && !err && data && mediaKind && (
          <MediaPreview kind={mediaKind} path={data.path} name={data.name} size={data.size} />
        )}
        {!loading && !err && data && !mediaKind && (
          data.binary ? (
            <div className="h-full flex flex-col items-center justify-center text-gray-400 gap-2 text-sm p-8 text-center">
              <FileWarning size={26} className="text-amber-400" />
              <div>二进制文件，无法以文本预览</div>
            </div>
          ) : data.too_large ? (
            <div className="h-full flex flex-col items-center justify-center text-gray-400 gap-2 text-sm p-8 text-center">
              <FileWarning size={26} className="text-amber-400" />
              <div>{data.error || '文件过大，无法预览'}</div>
            </div>
          ) : data.is_markdown ? (
            <div className="px-4 py-3">
              <MarkdownRenderer content={data.content} />
            </div>
          ) : (
            <CodeView content={data.content} lang={data.lang} />
          )
        )}
      </div>
    </div>
  );
}
