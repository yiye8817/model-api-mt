import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  X, Cpu, Download, FileText, RefreshCw, Loader2, Play, Square,
  Trash2, FolderPlus, AlertCircle, CheckCircle2, ExternalLink,
  HardDrive, FolderOpen, ScrollText, Network, Wifi, WifiOff, Save,
  Terminal, Folder, File, ArrowUp, Check,
} from 'lucide-react';

const HUB_BASE_LS_KEY = 'model-api-mt:local-hub-base';

/** 把 'host:port' / 'http://host:port' / 完整 URL 都规范化为 'http(s)://host:port'（去掉末尾 /）。
 *  返回空串表示用同源（即当前后端）。 */
function normalizeHubBase(input: string): string {
  const s = (input || '').trim();
  if (!s) return '';
  let url = s;
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  return url.replace(/\/+$/, '');
}

/** 从 hubBase 中抽出 hostname（去掉端口和协议）。同源时返回空串，调用方应回退到 status.host 或 127.0.0.1。 */
function extractHubHost(hubBase: string): string {
  if (!hubBase) return '';
  try {
    return new URL(hubBase).hostname;
  } catch {
    return '';
  }
}

type Tab = 'models' | 'download' | 'docs';

interface ModelItem {
  path: string;
  filename: string;
  size: number;
  mtime: number;
  repo_id: string;
  source: string;
  mmproj: boolean;
}

interface ServerStatus {
  pid?: number;
  port?: number;
  model_path?: string;
  filename?: string;
  base_url?: string;
}

interface DownloadJob {
  id: string;
  job_id?: string;
  url: string;
  filename: string;
  dst: string;
  /** 兼容老字段 */
  total: number;
  downloaded: number;
  /** frontend 风格 */
  total_size?: number;
  downloaded_bytes?: number;
  status: string;
  error?: string | null;
  started_at: number;
  finished_at?: number;
  speed_bps?: number;
  eta_seconds?: number | null;
  current_file?: string;
  is_mmproj?: boolean;
  parent_job_id?: string | null;
  repo_id?: string | null;
  downloader?: string;
}

interface LlamaBinSourceProbe {
  path: string;
  exists: boolean;
  executable: boolean;
}

interface LlamaBinInfo {
  binary: string | null;
  available: boolean;
  binary_file: string;
  env_name: string;
  sources: {
    saved: LlamaBinSourceProbe;
    env: LlamaBinSourceProbe;
    which: LlamaBinSourceProbe;
  };
}

interface APIDocGroup {
  name: string;
  base_url: string;
  note?: string;
  endpoints: { method: string; path: string; desc: string }[];
}

interface Props {
  visible: boolean;
  onClose: () => void;
  /** 启动 llama-server 后被调用，用于自动添加一个指向它的 OpenAI 兼容 provider。
   *  host：远端 hub 模式下传远端主机名；同源（本机）时可省略，默认 127.0.0.1。 */
  onAddLocalProvider?: (port: string, host?: string) => Promise<void> | void;
}

function fmtSize(bytes: number): string {
  if (!bytes) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (bytes >= 1024 && i < u.length - 1) { bytes /= 1024; i++; }
  return `${bytes.toFixed(bytes >= 10 ? 0 : 1)} ${u[i]}`;
}

export default function LocalHubModal({ visible, onClose, onAddLocalProvider }: Props) {
  const [tab, setTab] = useState<Tab>('models');
  const [error, setError] = useState<string | null>(null);

  // Hub Endpoint：远端 model-api-mt 的 base URL。空 = 同源（本机后端）
  const [hubInput, setHubInput] = useState<string>(() => localStorage.getItem(HUB_BASE_LS_KEY) || '');
  const [hubBase, setHubBase] = useState<string>(() => normalizeHubBase(localStorage.getItem(HUB_BASE_LS_KEY) || ''));
  const [hubProbe, setHubProbe] = useState<{
    ok: boolean;
    kind?: 'hub' | 'llama';
    msg: string;
    models?: string[];
    port?: number;
  } | null>(null);
  const [probing, setProbing] = useState(false);

  /** 把相对 API 路径拼接为绝对（如有 hubBase）或保持相对（同源）。 */
  const apiUrl = useCallback((p: string) => (hubBase ? `${hubBase}${p}` : p), [hubBase]);
  const hubHost = useMemo(() => extractHubHost(hubBase), [hubBase]);

  // 全局
  const [caps, setCaps] = useState<any>(null);

  // 模型 tab
  const [models, setModels] = useState<ModelItem[]>([]);
  const [serverStatus, setServerStatus] = useState<ServerStatus | null>(null);
  const [dirs, setDirs] = useState<{ path: string; exists: boolean }[]>([]);
  const [downloadDir, setDownloadDir] = useState<string>('');
  const [newDirInput, setNewDirInput] = useState('');
  const [loadingModels, setLoadingModels] = useState(false);
  const [actingPath, setActingPath] = useState<string | null>(null);

  // llama-server 二进制路径
  const [llamaBin, setLlamaBin] = useState<LlamaBinInfo | null>(null);
  const [llamaBinInput, setLlamaBinInput] = useState('');
  const [llamaBinSaving, setLlamaBinSaving] = useState(false);
  const [llamaBinMsg, setLlamaBinMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  // llama-server 启动参数
  const [paramsOpen, setParamsOpen] = useState(false);
  const [paramsModel, setParamsModel] = useState<ModelItem | null>(null);
  const [paramPort, setParamPort] = useState('8090');
  const [paramCtx, setParamCtx] = useState('4096');
  const [paramNgl, setParamNgl] = useState('0');
  const [paramMmproj, setParamMmproj] = useState('');

  // 本机文件/目录选择器（二进制路径、扫描目录、GGUF 模型、mmproj）
  const [fsPicker, setFsPicker] = useState<null | {
    mode: 'file' | 'dir';
    title: string;
    ext?: string;
    initial?: string;
    onPick: (p: string) => void;
  }>(null);

  // 日志
  const [logs, setLogs] = useState<string[]>([]);
  const logsRef = useRef<HTMLPreElement>(null);

  // 下载 tab
  // dlRepoId 兼容三种输入：完整 https URL / owner/repo / owner/repo/file.gguf
  const [dlRepoId, setDlRepoId] = useState('');
  const [dlFilename, setDlFilename] = useState('');
  const [dlToken, setDlToken] = useState('');
  const [dlMmprojAuto, setDlMmprojAuto] = useState(false); // 自动从同 repo 找 mmproj
  const [dlMmprojFn, setDlMmprojFn] = useState('');         // 手动指定 mmproj 文件名
  const [downloads, setDownloads] = useState<DownloadJob[]>([]);
  const [dlSubmitting, setDlSubmitting] = useState(false);

  // 已订阅的下载 SSE：jobId -> EventSource
  const dlSseRefs = useRef<Map<string, EventSource>>(new Map());
  // llama-server status SSE
  const statusSseRef = useRef<EventSource | null>(null);

  // 文档 tab
  const [docs, setDocs] = useState<APIDocGroup[]>([]);

  // hub 不可用标志：远端 hub 不是 model-api-mt（比如是原生 llama-server），管理功能不可用
  const [hubUnsupported, setHubUnsupported] = useState(false);

  // 安全 fetch：HTTP 非 2xx 也按失败处理（避免把 404 HTML body 当 JSON 报错）
  const safeJson = useCallback(async (url: string) => {
    try {
      const r = await fetch(url);
      if (!r.ok) return null;
      return await r.json();
    } catch {
      return null;
    }
  }, []);

  // 拉取数据
  const refreshAll = useCallback(async () => {
    setLoadingModels(true);
    try {
      const [capsR, modelsR, dirsR, statusR, binR] = await Promise.all([
        safeJson(apiUrl('/api/system/caps')),
        safeJson(apiUrl('/api/models')),
        safeJson(apiUrl('/api/settings/model-dirs')),
        safeJson(apiUrl('/api/status')),
        safeJson(apiUrl('/api/system/llama-server-binary')),
      ]);
      // hub 端点全部不可达 → 远端不是 model-api-mt
      const allMissing = !capsR && !modelsR && !dirsR && !statusR && !binR;
      setHubUnsupported(!!hubBase && allMissing);
      if (capsR) setCaps(capsR);
      setModels(modelsR?.items || []);
      setServerStatus(statusR?.status || null);
      setDirs(dirsR?.items || []);
      setDownloadDir(dirsR?.download_dir || '');
      if (capsR?.default_port) setParamPort(String(capsR.default_port));
      if (binR) {
        const info = binR as LlamaBinInfo;
        setLlamaBin(info);
        setLlamaBinInput(info.sources?.saved?.path || '');
      } else {
        setLlamaBin(null);
      }
    } finally {
      setLoadingModels(false);
    }
  }, [apiUrl, hubBase, safeJson]);

  const refreshDownloads = useCallback(async () => {
    try {
      const r = await fetch(apiUrl('/api/hf/downloads')).then(x => x.json());
      setDownloads(r.items || []);
    } catch {}
  }, [apiUrl]);

  // 把后端推送的 job 字段合并到本地 downloads 列表里
  const mergeDownloadJob = useCallback((job: any) => {
    if (!job || !(job.job_id || job.id)) return;
    const id = job.job_id || job.id;
    setDownloads(prev => {
      const idx = prev.findIndex(p => (p.job_id || p.id) === id);
      const merged: DownloadJob = {
        ...(idx >= 0 ? prev[idx] : ({} as DownloadJob)),
        ...job,
        id,
        // 兼容字段映射
        total: job.total ?? job.total_size ?? (idx >= 0 ? prev[idx].total : 0),
        downloaded: job.downloaded ?? job.downloaded_bytes ?? (idx >= 0 ? prev[idx].downloaded : 0),
      };
      if (idx === -1) return [merged, ...prev];
      const next = [...prev];
      next[idx] = merged;
      return next;
    });
  }, []);

  // SSE 订阅单个下载任务进度（前端协议: type=progress|done|error|cancelled|end, job:{...}）
  const subscribeDownloadStream = useCallback((jobId: string) => {
    if (!jobId || dlSseRefs.current.has(jobId)) return;
    const url = apiUrl(`/api/hf/downloads/${encodeURIComponent(jobId)}/stream`);
    let es: EventSource;
    try {
      es = new EventSource(url);
    } catch {
      return;
    }
    dlSseRefs.current.set(jobId, es);
    es.onmessage = (e) => {
      try {
        const ev = JSON.parse(e.data);
        if (ev.job) mergeDownloadJob(ev.job);
        if (ev.type === 'end' || ev.type === 'done' || ev.type === 'error' || ev.type === 'cancelled') {
          try { es.close(); } catch {}
          dlSseRefs.current.delete(jobId);
        }
      } catch {}
    };
    es.onerror = () => {
      // 出错就关闭，下次依赖 useEffect 再触发或用户手动操作
      try { es.close(); } catch {}
      dlSseRefs.current.delete(jobId);
    };
  }, [apiUrl, mergeDownloadJob]);

  const refreshLogs = useCallback(async () => {
    try {
      // 兼容两端：model-api-mt 提供 /api/local/server/logs；frontend 后端没有，会被 safeJson 忽略
      const r = await fetch(apiUrl('/api/local/server/logs?n=200')).then(x => x.json()).catch(() => null);
      if (r?.lines) setLogs(r.lines);
    } catch {}
  }, [apiUrl]);

  const refreshDocs = useCallback(async () => {
    try {
      const r = await fetch(apiUrl('/api/local/api-docs')).then(x => x.json()).catch(() => null);
      if (r?.groups) setDocs(r.groups);
    } catch {}
  }, [apiUrl]);

  // 测试 Hub 连接：先用 frontend 风格协议（/api/system/caps），失败后回退探测原生 llama-server (/v1/models)
  const handleProbeHub = useCallback(async () => {
    const base = normalizeHubBase(hubInput);
    setProbing(true);
    setHubProbe(null);
    let lastErr = '';

    // 1) 试 model-api-mt / frontend 兼容 hub
    try {
      const u = base ? `${base}/api/system/caps` : '/api/system/caps';
      const r = await fetch(u, { method: 'GET' });
      if (r.ok) {
        const j = await r.json();
        const bin = j?.llama_server?.binary;
        setHubProbe({
          ok: true,
          kind: 'hub',
          msg: `已连通本地模型 Hub${bin ? `（llama-server: ${bin}）` : ''}`,
        });
        setProbing(false);
        return;
      }
      lastErr = `hub /api/system/caps → HTTP ${r.status}`;
    } catch (e: any) {
      lastErr = e?.message || '无法连通';
    }

    // 2) 回退：原生 llama-server / OpenAI 兼容 API
    try {
      const u = base ? `${base}/v1/models` : '/v1/models';
      const r = await fetch(u, { method: 'GET' });
      if (r.ok) {
        const j = await r.json();
        const models: string[] = (j?.data || []).map((m: any) => m?.id).filter(Boolean);
        let port: number | undefined;
        try { port = parseInt(new URL(base).port, 10) || undefined; } catch {}
        setHubProbe({
          ok: true,
          kind: 'llama',
          msg: `检测到原生 llama-server / OpenAI 兼容 API。Hub 管理功能（模型扫描/启停/下载）不可用，但可直接作为聊天 provider 使用。`,
          models,
          port,
        });
        setProbing(false);
        return;
      }
      setHubProbe({ ok: false, msg: `${lastErr}\n/v1/models → HTTP ${r.status}` });
    } catch (e: any) {
      setHubProbe({ ok: false, msg: `${lastErr}\n/v1/models → ${e?.message || '失败'}` });
    } finally {
      setProbing(false);
    }
  }, [hubInput]);

  // 直接把当前 hubInput 作为聊天 provider 加入（原生 llama-server 模式）
  const handleAddAsProvider = useCallback(async () => {
    const base = normalizeHubBase(hubInput);
    if (!base) return;
    let host = '';
    let port = '';
    try {
      const u = new URL(base);
      host = u.hostname;
      port = u.port || (u.protocol === 'https:' ? '443' : '80');
    } catch {}
    if (!host || !port) return;
    if (onAddLocalProvider) {
      await onAddLocalProvider(port, host);
      onClose();
    }
  }, [hubInput, onAddLocalProvider, onClose]);

  const handleSaveHub = useCallback(() => {
    const base = normalizeHubBase(hubInput);
    setHubBase(base);
    if (base) localStorage.setItem(HUB_BASE_LS_KEY, base);
    else localStorage.removeItem(HUB_BASE_LS_KEY);
    setHubProbe(null);
    setError(null);
  }, [hubInput]);

  useEffect(() => {
    if (!visible) return;
    setError(null);
    refreshAll();
    refreshDocs();
    refreshDownloads();
  }, [visible, hubBase, refreshAll, refreshDocs, refreshDownloads]);

  // 模型 tab：用 SSE /api/status/stream 实时推送 status + llama-server 日志
  useEffect(() => {
    if (!visible || tab !== 'models') return;
    // 远端 hub 不是 model-api-mt 时（hubUnsupported），SSE 也不可用 → 退化为轮询
    if (hubUnsupported) {
      const t = setInterval(() => {
        fetch(apiUrl('/api/status'))
          .then(r => r.ok ? r.json() : null)
          .then(j => setServerStatus(j?.status || null))
          .catch(() => {});
      }, 2000);
      return () => clearInterval(t);
    }
    refreshLogs(); // 立即拉一次最近日志
    const url = apiUrl('/api/status/stream');
    let es: EventSource;
    try {
      es = new EventSource(url);
    } catch {
      return;
    }
    statusSseRef.current = es;
    es.onmessage = (e) => {
      try {
        const ev = JSON.parse(e.data);
        if (ev.type === 'status') {
          setServerStatus(ev.status || null);
        } else if (ev.type === 'log' && typeof ev.line === 'string') {
          setLogs(prev => {
            const next = [...prev, ev.line];
            return next.length > 600 ? next.slice(-500) : next;
          });
        }
      } catch {}
    };
    es.onerror = () => {
      // EventSource 默认会自动重连；这里不做强制操作
    };
    return () => {
      try { es.close(); } catch {}
      statusSseRef.current = null;
    };
  }, [visible, tab, hubBase, hubUnsupported, apiUrl, refreshLogs]);

  // 下载 tab：进入时取一次列表，对每个 running 的任务订阅 SSE 实时进度
  useEffect(() => {
    if (!visible || tab !== 'download') return;
    refreshDownloads();
  }, [visible, tab, hubBase, refreshDownloads]);

  useEffect(() => {
    if (!visible || tab !== 'download') return;
    downloads.forEach(j => {
      const id = j.job_id || j.id;
      if (id && j.status === 'running') subscribeDownloadStream(id);
    });
  }, [visible, tab, downloads, subscribeDownloadStream]);

  // modal 关闭/卸载时清理所有 SSE
  useEffect(() => {
    if (!visible) {
      dlSseRefs.current.forEach(es => { try { es.close(); } catch {} });
      dlSseRefs.current.clear();
      try { statusSseRef.current?.close(); } catch {}
      statusSseRef.current = null;
    }
    return () => {
      dlSseRefs.current.forEach(es => { try { es.close(); } catch {} });
      dlSseRefs.current.clear();
      try { statusSseRef.current?.close(); } catch {}
    };
  }, [visible]);

  // 自动滚日志到底
  useEffect(() => {
    if (logsRef.current) logsRef.current.scrollTop = logsRef.current.scrollHeight;
  }, [logs]);

  if (!visible) return null;

  // ===== 操作 =====
  const handleAddDir = async () => {
    const p = newDirInput.trim();
    if (!p) return;
    setError(null);
    try {
      const r = await fetch(apiUrl('/api/settings/model-dirs'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: p }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || '添加失败');
      setNewDirInput('');
      refreshAll();
    } catch (e: any) {
      setError(e?.message || '添加失败');
    }
  };

  const handleRemoveDir = async (path: string) => {
    if (!confirm(`移除扫描目录？（不会删除磁盘文件）\n${path}`)) return;
    await fetch(apiUrl('/api/settings/model-dirs'), {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    });
    refreshAll();
  };

  const openLoadParams = (m: ModelItem) => {
    setParamsModel(m);
    setParamMmproj(m.mmproj ? m.path : '');
    setParamsOpen(true);
  };

  // ---- 本机文件/目录选择 ----
  const openBrowseBinary = () => {
    setFsPicker({
      mode: 'file',
      title: '选择 llama-server 二进制文件',
      initial: llamaBinInput || undefined,
      onPick: (p) => { setLlamaBinInput(p); setFsPicker(null); },
    });
  };

  const openBrowseModelDir = () => {
    setFsPicker({
      mode: 'dir',
      title: '选择模型扫描目录',
      initial: newDirInput || undefined,
      onPick: (p) => { setNewDirInput(p); setFsPicker(null); },
    });
  };

  const openBrowseModelFile = () => {
    setFsPicker({
      mode: 'file',
      title: '选择 GGUF 模型文件',
      ext: '.gguf',
      onPick: (p) => {
        setFsPicker(null);
        const filename = p.split('/').pop() || p;
        const parts = p.split('/');
        const repo_id = parts.length >= 2 ? parts[parts.length - 2] : filename;
        openLoadParams({ path: p, filename, size: 0, mtime: 0, repo_id, source: 'manual', mmproj: /mmproj/i.test(filename) });
      },
    });
  };

  const openBrowseMmproj = () => {
    setFsPicker({
      mode: 'file',
      title: '选择 mmproj 文件',
      ext: '.gguf',
      initial: paramMmproj || undefined,
      onPick: (p) => { setParamMmproj(p); setFsPicker(null); },
    });
  };

  const handleStartServer = async () => {
    if (!paramsModel) return;
    setActingPath(paramsModel.path);
    setError(null);
    try {
      const port = parseInt(paramPort, 10) || 8090;
      // 远端 hub 模式下，让 llama-server 绑 0.0.0.0 才能让本地浏览器直连远端 IP；
      // 同源（本机）模式仍默认 127.0.0.1 更安全
      const bindHost = hubBase ? '0.0.0.0' : '127.0.0.1';
      const r = await fetch(apiUrl('/api/models/load'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: paramsModel.path,
          host: bindHost,
          port,
          ctx: parseInt(paramCtx, 10) || 4096,
          n_gpu_layers: parseInt(paramNgl, 10) || 0,
          mmproj: paramMmproj || undefined,
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || '启动失败');
      setServerStatus(j?.status || null);
      setParamsOpen(false);
      setParamsModel(null);
      // 等 1.2 秒让 llama-server 完成监听，然后自动添加 provider
      // 远端 hub：用 hubBase 的 hostname；本机：用 127.0.0.1
      const providerHost = hubHost || '127.0.0.1';
      setTimeout(async () => {
        try {
          if (onAddLocalProvider) await onAddLocalProvider(String(port), providerHost);
        } catch {}
      }, 1200);
    } catch (e: any) {
      setError(e?.message || '启动失败');
    } finally {
      setActingPath(null);
    }
  };

  const handleStopServer = async () => {
    setError(null);
    try {
      await fetch(apiUrl('/api/models/unload'), { method: 'POST' });
      setServerStatus(null);
      refreshAll();
    } catch (e: any) {
      setError(e?.message || '停止失败');
    }
  };

  const handleSaveLlamaBin = async () => {
    const p = llamaBinInput.trim();
    if (!p) return;
    setLlamaBinSaving(true);
    setLlamaBinMsg(null);
    try {
      const r = await fetch(apiUrl('/api/system/llama-server-binary'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: p }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || '保存失败');
      setLlamaBin(j as LlamaBinInfo);
      setLlamaBinInput((j as LlamaBinInfo).sources?.saved?.path || '');
      setLlamaBinMsg({ kind: 'ok', text: '已保存，新启动将使用此路径。' });
      // 也刷新 caps 状态条
      const capsR = await safeJson(apiUrl('/api/system/caps'));
      if (capsR) setCaps(capsR);
    } catch (e: any) {
      setLlamaBinMsg({ kind: 'err', text: e?.message || '保存失败' });
    } finally {
      setLlamaBinSaving(false);
    }
  };

  const handleClearLlamaBin = async () => {
    setLlamaBinSaving(true);
    setLlamaBinMsg(null);
    try {
      const r = await fetch(apiUrl('/api/system/llama-server-binary'), { method: 'DELETE' });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || '清除失败');
      setLlamaBin(j as LlamaBinInfo);
      setLlamaBinInput('');
      setLlamaBinMsg({ kind: 'ok', text: '已清除自定义路径，回退到环境变量 / PATH。' });
      const capsR = await safeJson(apiUrl('/api/system/caps'));
      if (capsR) setCaps(capsR);
    } catch (e: any) {
      setLlamaBinMsg({ kind: 'err', text: e?.message || '清除失败' });
    } finally {
      setLlamaBinSaving(false);
    }
  };

  const handleUseLlamaBinSource = (path: string) => {
    if (!path) return;
    setLlamaBinInput(path);
    setLlamaBinMsg(null);
  };

  const handleDeleteModel = async (m: ModelItem) => {
    if (!confirm(`删除模型文件？\n${m.path}\n（不可恢复）`)) return;
    await fetch(apiUrl('/api/models'), {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: m.path, repo_id: m.repo_id, filename: m.filename }),
    });
    refreshAll();
  };

  const handleStartDownload = async () => {
    const repoInput = dlRepoId.trim();
    if (!repoInput) return;
    setError(null);
    setDlSubmitting(true);
    try {
      // 解析输入：完整 URL / owner/repo / owner/repo/file.gguf
      const body: any = {};
      if (/^https?:\/\//i.test(repoInput)) {
        body.url = repoInput;
        if (dlFilename.trim()) body.filename = dlFilename.trim();
      } else {
        const parts = repoInput.split('/').filter(Boolean);
        if (parts.length === 2) {
          if (!dlFilename.trim()) {
            throw new Error('owner/repo 模式必须填写 filename');
          }
          body.repo_id = `${parts[0]}/${parts[1]}`;
          body.filename = dlFilename.trim();
        } else if (parts.length >= 3) {
          body.repo_id = `${parts[0]}/${parts[1]}`;
          body.filename = parts.slice(2).join('/');
        } else {
          throw new Error('请输入 owner/repo + filename，或完整 https URL');
        }
      }
      // mmproj：手动指定文件名优先，其次自动找
      if (dlMmprojFn.trim()) body.mmproj = dlMmprojFn.trim();
      else if (dlMmprojAuto) body.mmproj = true;
      if (dlToken.trim()) body.hf_token = dlToken.trim();

      const r = await fetch(apiUrl('/api/hf/download'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || '启动下载失败');
      // 立即把新任务并入列表 + 订阅 SSE
      const newJobId = j.job_id || j.id;
      if (j.job) mergeDownloadJob(j.job);
      else if (newJobId) {
        mergeDownloadJob({
          job_id: newJobId, id: newJobId, filename: body.filename || '(下载中)',
          repo_id: body.repo_id, status: 'running',
          downloaded_bytes: 0, total_size: 0,
          started_at: Date.now(),
        });
      }
      if (newJobId) subscribeDownloadStream(newJobId);
      // mmproj 子任务
      if (j.mmproj_job_id) {
        mergeDownloadJob({
          job_id: j.mmproj_job_id, id: j.mmproj_job_id,
          filename: '(mmproj 下载中)', is_mmproj: true,
          parent_job_id: newJobId, status: 'running',
          downloaded_bytes: 0, total_size: 0,
          started_at: Date.now(),
        });
        subscribeDownloadStream(j.mmproj_job_id);
      }
      setDlRepoId('');
      setDlFilename('');
      setDlMmprojFn('');
      // 后端列表刷一次（拿到 dst 等字段）
      refreshDownloads();
    } catch (e: any) {
      setError(e?.message || '启动下载失败');
    } finally {
      setDlSubmitting(false);
    }
  };

  const handleCancelDownload = async (id: string) => {
    await fetch(apiUrl(`/api/hf/downloads/${encodeURIComponent(id)}/cancel`), { method: 'POST' });
    refreshDownloads();
  };

  const handleClearDownloads = async () => {
    await fetch(apiUrl('/api/hf/downloads/clear'), { method: 'POST' });
    refreshDownloads();
  };

  // ============ Render ============
  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-5xl max-h-[90vh] flex flex-col shadow-2xl">
        {/* Header */}
        <div className="px-5 py-3.5 border-b border-gray-700 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            <Cpu size={18} className="text-emerald-400" />
            <h2 className="text-base font-semibold text-white">本地模型 Hub</h2>
            {caps && (
              <span
                className={`text-[11px] px-2 py-0.5 rounded ${caps.llama_server?.available ? 'bg-emerald-900/40 text-emerald-300' : 'bg-amber-900/40 text-amber-300 cursor-pointer hover:bg-amber-900/60'}`}
                title={caps.llama_server?.available
                  ? caps.llama_server.binary || ''
                  : '在「本地模型」Tab 顶部设置 llama-server 二进制路径'}
                onClick={() => { if (!caps.llama_server?.available) setTab('models'); }}
              >
                {caps.llama_server?.available ? `llama-server: ${caps.llama_server.binary}` : 'llama-server 未配置 · 点此设置'}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            <button onClick={refreshAll} className="p-1.5 rounded text-gray-400 hover:text-white hover:bg-gray-700" title="刷新">
              {loadingModels ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            </button>
            <button onClick={onClose} className="p-1.5 rounded text-gray-400 hover:text-white hover:bg-gray-700" title="关闭">
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Hub Endpoint 输入栏 */}
        <div className="px-5 py-2.5 border-b border-gray-700 bg-gray-900/40 shrink-0">
          <div className="flex items-center gap-2 text-xs">
            <Network size={13} className="text-cyan-400 shrink-0" />
            <span className="text-gray-400 shrink-0">Hub:</span>
            <input
              value={hubInput}
              onChange={e => setHubInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleSaveHub(); }}
              placeholder="留空 = 本机；填写 host:port 或 http://host:port 连接远端 model-api-mt"
              className="flex-1 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs font-mono text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-cyan-500"
            />
            {hubBase ? (
              <span className="flex items-center gap-1 text-emerald-300 text-[11px] shrink-0">
                <Wifi size={11} /> 远端模式
              </span>
            ) : (
              <span className="flex items-center gap-1 text-gray-500 text-[11px] shrink-0">
                <WifiOff size={11} /> 本机
              </span>
            )}
            <button
              onClick={handleProbeHub}
              disabled={probing}
              className="px-2 py-1 rounded bg-gray-700 hover:bg-gray-600 text-xs text-gray-200 disabled:opacity-60 shrink-0"
              title="测试连接到该 Hub"
            >
              {probing ? <Loader2 size={11} className="animate-spin inline" /> : '测试'}
            </button>
            <button
              onClick={handleSaveHub}
              className="flex items-center gap-1 px-2 py-1 rounded bg-cyan-600 hover:bg-cyan-500 text-xs text-white shrink-0"
              title="保存到 localStorage 并切换"
            >
              <Save size={11} /> 应用
            </button>
          </div>
          {hubProbe && (
            <div className={`text-[11px] mt-1.5 ml-5 ${hubProbe.ok ? 'text-emerald-300' : 'text-red-300'}`}>
              <div className="whitespace-pre-wrap">{hubProbe.ok ? '✓ ' : '✗ '}{hubProbe.msg}</div>
              {hubProbe.ok && hubProbe.kind === 'llama' && (
                <div className="mt-1.5 flex items-start gap-2 flex-wrap">
                  {hubProbe.models && hubProbe.models.length > 0 && (
                    <span className="text-gray-400">
                      可用模型: <code className="text-cyan-300">{hubProbe.models.slice(0, 4).join(', ')}{hubProbe.models.length > 4 ? ` 等 ${hubProbe.models.length} 个` : ''}</code>
                    </span>
                  )}
                  {onAddLocalProvider && (
                    <button
                      onClick={handleAddAsProvider}
                      className="px-2 py-0.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-[11px]"
                    >
                      直接添加为聊天 provider
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
          {hubBase && (
            <div className="text-[11px] mt-1 ml-5 text-gray-500">
              所有本地模型管理操作（扫描/启动/下载/日志）将走<span className="text-emerald-300">远端</span>：<code className="text-cyan-300">{hubBase}</code>
              <br />
              <span className="text-amber-300">⚠ 添加的扫描目录、模型路径都是远端机器上的绝对路径</span>，不是你本机的。
              {hubHost && <span> · provider 自动指向 <code className="text-cyan-300">http://{hubHost}:&lt;port&gt;/v1</code></span>}
            </div>
          )}
        </div>

        {/* Tabs */}
        <div className="border-b border-gray-700 px-3 py-1.5 flex gap-1 shrink-0">
          {([
            { id: 'models', label: '本地模型', icon: HardDrive },
            { id: 'download', label: '下载模型', icon: Download },
            { id: 'docs', label: 'API 文档', icon: FileText },
          ] as const).map(t => {
            const I = t.icon;
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-sm transition-colors ${
                  tab === t.id ? 'bg-gray-800 text-white' : 'text-gray-400 hover:text-white hover:bg-gray-800/50'
                }`}
              >
                <I size={14} />
                {t.label}
              </button>
            );
          })}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 text-sm text-gray-200">
          {error && (
            <div className="mb-3 bg-red-900/30 border border-red-500/40 text-red-200 rounded-lg px-3 py-2 text-xs flex items-start gap-2">
              <AlertCircle size={13} className="mt-0.5 shrink-0" />
              <span className="whitespace-pre-wrap break-all">{error}</span>
            </div>
          )}

          {hubUnsupported && (
            <div className="mb-3 bg-amber-900/30 border border-amber-500/40 text-amber-200 rounded-lg px-3 py-2 text-xs space-y-1.5">
              <div className="flex items-start gap-2">
                <AlertCircle size={13} className="mt-0.5 shrink-0" />
                <div>
                  当前 Hub <code className="text-cyan-300">{hubBase}</code> 不支持本地模型管理协议（<code>/api/system/caps</code> 等不可用）。
                  这通常意味着远端是一个原生 llama-server / OpenAI 兼容服务。
                  <strong className="text-amber-100">本地模型管理（扫描/启停/下载/日志）功能不可用</strong>，
                  但仍可作为聊天 provider 使用。
                </div>
              </div>
              {onAddLocalProvider && (
                <div className="ml-5 flex flex-wrap gap-2">
                  <button
                    onClick={handleAddAsProvider}
                    className="px-2 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-[11px]"
                  >
                    直接添加为聊天 provider
                  </button>
                  <button
                    onClick={() => { setHubInput(''); setHubBase(''); localStorage.removeItem(HUB_BASE_LS_KEY); setHubUnsupported(false); }}
                    className="px-2 py-1 rounded bg-gray-700 hover:bg-gray-600 text-gray-200 text-[11px]"
                  >
                    切回本机 Hub
                  </button>
                </div>
              )}
            </div>
          )}

          {tab === 'models' && (
            <ModelsTab
              models={models}
              dirs={dirs}
              downloadDir={downloadDir}
              serverStatus={serverStatus}
              actingPath={actingPath}
              newDirInput={newDirInput}
              setNewDirInput={setNewDirInput}
              onAddDir={handleAddDir}
              onRemoveDir={handleRemoveDir}
              onLoad={openLoadParams}
              onStop={handleStopServer}
              onDelete={handleDeleteModel}
              logs={logs}
              logsRef={logsRef}
              isRemote={!!hubBase}
              remoteHost={hubHost}
              llamaBin={llamaBin}
              llamaBinInput={llamaBinInput}
              setLlamaBinInput={setLlamaBinInput}
              llamaBinSaving={llamaBinSaving}
              llamaBinMsg={llamaBinMsg}
              onSaveLlamaBin={handleSaveLlamaBin}
              onClearLlamaBin={handleClearLlamaBin}
              onUseLlamaBinSource={handleUseLlamaBinSource}
              onBrowseBinary={openBrowseBinary}
              onBrowseDir={openBrowseModelDir}
              onBrowseModelFile={openBrowseModelFile}
            />
          )}

          {tab === 'download' && (
            <DownloadTab
              downloadDir={downloadDir}
              dlRepoId={dlRepoId}
              setDlRepoId={setDlRepoId}
              dlFilename={dlFilename}
              setDlFilename={setDlFilename}
              dlToken={dlToken}
              setDlToken={setDlToken}
              dlMmprojAuto={dlMmprojAuto}
              setDlMmprojAuto={setDlMmprojAuto}
              dlMmprojFn={dlMmprojFn}
              setDlMmprojFn={setDlMmprojFn}
              submitting={dlSubmitting}
              onStart={handleStartDownload}
              jobs={downloads}
              onCancel={handleCancelDownload}
              onClear={handleClearDownloads}
            />
          )}

          {tab === 'docs' && (
            <DocsTab groups={docs} />
          )}
        </div>
      </div>

      {/* 启动参数子对话框 */}
      {paramsOpen && paramsModel && (
        <div className="fixed inset-0 bg-black/70 z-[60] flex items-center justify-center p-4">
          <div className="bg-gray-900 border border-emerald-500/30 rounded-xl w-full max-w-md shadow-2xl">
            <div className="px-4 py-3 border-b border-gray-700 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-emerald-300">启动 llama-server</h3>
              <button onClick={() => setParamsOpen(false)} className="text-gray-400 hover:text-white"><X size={16} /></button>
            </div>
            <div className="p-4 space-y-3 text-sm">
              <div>
                <div className="text-xs text-gray-500 mb-1">模型</div>
                <div className="font-mono text-xs text-gray-300 bg-gray-800 rounded px-2 py-1 break-all">{paramsModel.filename}</div>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <ParamInput label="端口" value={paramPort} onChange={setParamPort} />
                <ParamInput label="ctx-size" value={paramCtx} onChange={setParamCtx} />
                <ParamInput label="n_gpu_layers" value={paramNgl} onChange={setParamNgl} hint="0=纯 CPU" />
              </div>
              <div>
                <div className="text-xs text-gray-500 mb-1">mmproj 文件路径（可选）</div>
                <div className="flex items-center gap-2">
                  <input
                    value={paramMmproj}
                    onChange={e => setParamMmproj(e.target.value)}
                    placeholder="多模态时填写 mmproj-*.gguf 路径"
                    className="flex-1 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs font-mono"
                  />
                  <button
                    onClick={openBrowseMmproj}
                    className="flex items-center gap-1 px-2 py-1 rounded bg-gray-700 hover:bg-gray-600 text-gray-200 text-xs shrink-0"
                    title="从本机选择 mmproj 文件"
                  >
                    <FolderOpen size={12} /> 浏览
                  </button>
                </div>
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button onClick={() => setParamsOpen(false)} className="px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-xs">取消</button>
                <button
                  onClick={handleStartServer}
                  disabled={actingPath === paramsModel.path}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-xs disabled:bg-gray-700"
                >
                  {actingPath === paramsModel.path ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
                  启动
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 本机文件 / 目录选择器 */}
      <FsPicker
        visible={!!fsPicker}
        mode={fsPicker?.mode || 'file'}
        title={fsPicker?.title || ''}
        ext={fsPicker?.ext}
        initialPath={fsPicker?.initial}
        apiUrl={apiUrl}
        onPick={(p) => fsPicker?.onPick(p)}
        onClose={() => setFsPicker(null)}
      />
    </div>
  );
}

function ParamInput({ label, value, onChange, hint }: { label: string; value: string; onChange: (v: string) => void; hint?: string }) {
  return (
    <div>
      <div className="text-xs text-gray-500 mb-1">{label}</div>
      <input value={value} onChange={e => onChange(e.target.value)} className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs font-mono" />
      {hint && <div className="text-[10px] text-gray-600 mt-0.5">{hint}</div>}
    </div>
  );
}

interface FsEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size?: number;
  mtime?: number;
  executable?: boolean;
}

/** 服务器端文件系统选择器：浏览「当前 hub 所在机器」上的目录/文件并选择绝对路径。
 *  mode='file' 时点击文件即选中；mode='dir' 时底部「选择此目录」选中当前目录。 */
function FsPicker({
  visible, mode, title, ext, apiUrl, initialPath, onPick, onClose,
}: {
  visible: boolean;
  mode: 'file' | 'dir';
  title: string;
  ext?: string;
  apiUrl: (p: string) => string;
  initialPath?: string;
  onPick: (path: string) => void;
  onClose: () => void;
}) {
  const [cwd, setCwd] = useState('');
  const [parent, setParent] = useState<string | null>(null);
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [shortcuts, setShortcuts] = useState<{ label: string; path: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState('');
  const [showHidden, setShowHidden] = useState(false);

  const load = useCallback(async (path?: string) => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams();
      if (path) qs.set('path', path);
      if (mode === 'dir') qs.set('only_dirs', '1');
      if (ext) qs.set('ext', ext);
      if (showHidden) qs.set('show_hidden', '1');
      const r = await fetch(apiUrl(`/api/system/fs/list?${qs.toString()}`));
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || '无法读取目录');
      setCwd(j.path || '');
      setManual(j.path || '');
      setParent(j.parent ?? null);
      setEntries(j.entries || []);
      setShortcuts(j.shortcuts || []);
    } catch (e: any) {
      setError(e?.message || '读取失败');
    } finally {
      setLoading(false);
    }
  }, [apiUrl, mode, ext, showHidden]);

  useEffect(() => {
    if (visible) load(initialPath || undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, showHidden]);

  if (!visible) return null;
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div className="bg-gray-900 border border-gray-600 rounded-xl w-full max-w-2xl shadow-2xl flex flex-col max-h-[80vh]" onClick={e => e.stopPropagation()}>
        <div className="px-4 py-3 border-b border-gray-700 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-100 flex items-center gap-2">
            <FolderOpen size={15} className="text-blue-400" />{title}
          </h3>
          <button onClick={onClose} className="text-gray-400 hover:text-white"><X size={16} /></button>
        </div>

        <div className="px-4 pt-2 flex flex-wrap items-center gap-1.5">
          {shortcuts.map(s => (
            <button
              key={s.path}
              onClick={() => load(s.path)}
              className="text-[11px] px-2 py-0.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700"
            >
              {s.label}
            </button>
          ))}
          <label className="text-[11px] px-2 py-0.5 rounded text-gray-400 flex items-center gap-1 ml-auto cursor-pointer select-none">
            <input type="checkbox" checked={showHidden} onChange={e => setShowHidden(e.target.checked)} /> 显示隐藏项
          </label>
        </div>

        <div className="px-4 py-2 flex items-center gap-2">
          <button
            onClick={() => parent && load(parent)}
            disabled={!parent}
            className="p-1.5 rounded bg-gray-800 hover:bg-gray-700 disabled:opacity-40 text-gray-300 shrink-0"
            title="上一级"
          >
            <ArrowUp size={14} />
          </button>
          <input
            value={manual}
            onChange={e => setManual(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && manual.trim()) load(manual.trim()); }}
            placeholder="输入绝对路径后回车"
            className="flex-1 bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs font-mono text-gray-200"
          />
          <button onClick={() => manual.trim() && load(manual.trim())} className="px-2 py-1.5 rounded bg-gray-700 hover:bg-gray-600 text-gray-200 text-xs shrink-0">前往</button>
        </div>

        <div className="flex-1 overflow-auto px-2 min-h-[200px]">
          {loading ? (
            <div className="flex items-center justify-center py-10 text-gray-400 text-xs gap-2"><Loader2 size={14} className="animate-spin" />读取中…</div>
          ) : error ? (
            <div className="flex items-center justify-center py-10 text-red-300 text-xs gap-2"><AlertCircle size={14} />{error}</div>
          ) : entries.length === 0 ? (
            <div className="text-center py-10 text-gray-500 text-xs">（此目录为空{mode === 'file' && ext ? `，或没有 ${ext} 文件` : ''}）</div>
          ) : (
            <div className="py-1">
              {entries.map(en => (
                <button
                  key={en.path}
                  onClick={() => { if (en.is_dir) load(en.path); else if (mode === 'file') onPick(en.path); }}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-left text-xs hover:bg-gray-800 text-gray-300"
                >
                  {en.is_dir
                    ? <Folder size={14} className="text-blue-400 shrink-0" />
                    : <File size={14} className="text-gray-500 shrink-0" />}
                  <span className="truncate flex-1 font-mono">{en.name}{en.is_dir ? '/' : ''}</span>
                  {!en.is_dir && en.executable && <span className="text-[10px] text-emerald-400 shrink-0">+x</span>}
                  {!en.is_dir && typeof en.size === 'number' && en.size > 0 && <span className="text-[10px] text-gray-500 shrink-0">{fmtSize(en.size)}</span>}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="px-4 py-3 border-t border-gray-700 flex items-center gap-2">
          <code className="text-[11px] text-gray-500 truncate flex-1">
            {mode === 'dir' ? cwd : '点击上方文件即选择'}
          </code>
          {mode === 'dir' && (
            <button
              onClick={() => cwd && onPick(cwd)}
              disabled={!cwd}
              className="flex items-center gap-1 px-3 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 disabled:bg-gray-700 text-white text-xs shrink-0"
            >
              <Check size={13} /> 选择此目录
            </button>
          )}
          <button onClick={onClose} className="px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-200 text-xs shrink-0">取消</button>
        </div>
      </div>
    </div>
  );
}

// ============ Tabs ============
function ModelsTab({
  models, dirs, downloadDir, serverStatus, actingPath, newDirInput, setNewDirInput,
  onAddDir, onRemoveDir, onLoad, onStop, onDelete, logs, logsRef, isRemote, remoteHost,
  llamaBin, llamaBinInput, setLlamaBinInput, llamaBinSaving, llamaBinMsg,
  onSaveLlamaBin, onClearLlamaBin, onUseLlamaBinSource,
  onBrowseBinary, onBrowseDir, onBrowseModelFile,
}: {
  models: ModelItem[];
  dirs: { path: string; exists: boolean }[];
  downloadDir: string;
  serverStatus: ServerStatus | null;
  actingPath: string | null;
  newDirInput: string;
  setNewDirInput: (v: string) => void;
  onAddDir: () => void;
  onRemoveDir: (path: string) => void;
  onLoad: (m: ModelItem) => void;
  onStop: () => void;
  onDelete: (m: ModelItem) => void;
  logs: string[];
  logsRef: React.RefObject<HTMLPreElement | null>;
  isRemote: boolean;
  remoteHost: string;
  llamaBin: LlamaBinInfo | null;
  llamaBinInput: string;
  setLlamaBinInput: (v: string) => void;
  llamaBinSaving: boolean;
  llamaBinMsg: { kind: 'ok' | 'err'; text: string } | null;
  onSaveLlamaBin: () => void;
  onClearLlamaBin: () => void;
  onUseLlamaBinSource: (path: string) => void;
  onBrowseBinary: () => void;
  onBrowseDir: () => void;
  onBrowseModelFile: () => void;
}) {
  return (
    <div className="space-y-4">
      {/* llama-server 二进制路径设置 */}
      <LlamaBinSection
        info={llamaBin}
        input={llamaBinInput}
        setInput={setLlamaBinInput}
        saving={llamaBinSaving}
        message={llamaBinMsg}
        onSave={onSaveLlamaBin}
        onClear={onClearLlamaBin}
        onUseSource={onUseLlamaBinSource}
        onBrowse={onBrowseBinary}
        isRemote={isRemote}
        remoteHost={remoteHost}
      />

      {/* 当前运行状态 */}
      <div className={`rounded-lg p-3 border ${serverStatus ? 'bg-emerald-900/20 border-emerald-500/30' : 'bg-gray-800/50 border-gray-700'}`}>
        {serverStatus ? (
          <div className="flex items-start justify-between gap-3">
            <div className="text-xs space-y-1">
              <div className="flex items-center gap-2 text-emerald-300">
                <CheckCircle2 size={13} />
                <span className="font-medium">运行中</span>
                <span className="text-gray-400 font-mono">PID {serverStatus.pid} · 端口 {serverStatus.port}</span>
              </div>
              <div className="text-gray-400 font-mono break-all">{serverStatus.filename}</div>
              <div className="text-gray-500 text-[11px]">OpenAI 兼容: <code className="text-cyan-300">{serverStatus.base_url}</code></div>
            </div>
            <button onClick={onStop} className="flex items-center gap-1 px-3 py-1.5 rounded bg-red-600 hover:bg-red-500 text-white text-xs shrink-0">
              <Square size={12} /> 停止
            </button>
          </div>
        ) : (
          <div className="text-xs text-gray-400">未在运行 llama-server。在下方选一个 GGUF 模型加载。</div>
        )}
      </div>

      {/* 扫描目录 */}
      <div className="space-y-2">
        <div className="flex items-center justify-between text-xs">
          <span className="uppercase tracking-wider text-gray-500">
            {isRemote ? <>模型扫描目录 <span className="text-emerald-300 normal-case tracking-normal">（远端 {remoteHost} 上的路径）</span></> : '模型扫描目录'}
          </span>
          <span className="text-gray-600">下载目录：<code className="text-gray-400">{downloadDir || '—'}</code></span>
        </div>
        <div className="space-y-1.5">
          {dirs.map(d => (
            <div key={d.path} className="flex items-center justify-between bg-gray-800/40 border border-gray-700 rounded px-3 py-1.5 text-xs">
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <FolderOpen size={12} className={d.exists ? 'text-blue-400' : 'text-gray-600'} />
                <code className={`truncate ${d.exists ? 'text-gray-300' : 'text-gray-500 line-through'}`}>{d.path}</code>
              </div>
              <button onClick={() => onRemoveDir(d.path)} className="p-1 text-gray-500 hover:text-red-400" title="移除">
                <Trash2 size={11} />
              </button>
            </div>
          ))}
          <div className="flex items-center gap-2">
            <input
              value={newDirInput}
              onChange={e => setNewDirInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && newDirInput.trim()) onAddDir(); }}
              placeholder={isRemote
                ? `远端机器（${remoteHost || 'hub'}）上的绝对路径，例如 /data/gguf-models`
                : '本机绝对路径，例如 /home/me/llama-models'}
              className="flex-1 bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs font-mono"
            />
            <button
              onClick={onBrowseDir}
              className="flex items-center gap-1 px-2 py-1.5 rounded bg-gray-700 hover:bg-gray-600 text-gray-200 text-xs shrink-0"
              title="从本机选择目录"
            >
              <FolderOpen size={12} /> 浏览
            </button>
            <button
              onClick={onAddDir}
              disabled={!newDirInput.trim()}
              className="flex items-center gap-1 px-2 py-1.5 rounded bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 text-white text-xs shrink-0"
            >
              <FolderPlus size={12} /> 添加
            </button>
          </div>
        </div>
      </div>

      {/* 模型卡片 */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="text-xs uppercase tracking-wider text-gray-500">本地 GGUF 模型 ({models.length})</div>
          <button
            onClick={onBrowseModelFile}
            className="flex items-center gap-1 px-2 py-1 rounded bg-gray-700 hover:bg-gray-600 text-gray-200 text-[11px]"
            title="从本机直接选择一个 .gguf 文件加载"
          >
            <FolderOpen size={12} /> 浏览选择 .gguf
          </button>
        </div>
        {models.length === 0 ? (
          <div className="text-xs text-gray-500 bg-gray-800/30 border border-dashed border-gray-700 rounded p-4 text-center">
            还没有本地模型。可在「下载模型」tab 下载 GGUF，或在上方添加包含 *.gguf 的目录。
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
            {models.map(m => {
              const active = serverStatus?.model_path === m.path;
              return (
                <div key={m.path} className={`rounded-lg border p-3 text-xs ${active ? 'bg-emerald-900/15 border-emerald-500/40' : 'bg-gray-800/40 border-gray-700'}`}>
                  <div className="flex items-start justify-between gap-2 mb-1.5">
                    <div className="min-w-0 flex-1">
                      <div className="font-medium text-white truncate flex items-center gap-1.5">
                        {m.repo_id}
                        {active && <span className="bg-emerald-500/30 text-emerald-200 px-1.5 py-0.5 rounded text-[10px]">当前</span>}
                        {m.mmproj && <span className="bg-purple-500/30 text-purple-200 px-1.5 py-0.5 rounded text-[10px]">多模态</span>}
                      </div>
                      <code className="text-gray-400 truncate block text-[11px]">{m.filename}</code>
                      <div className="text-gray-500 text-[11px] mt-0.5">{fmtSize(m.size)}</div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={() => onLoad(m)}
                        disabled={actingPath === m.path}
                        className={`flex items-center gap-1 px-2 py-1 rounded text-white text-[11px] ${active ? 'bg-amber-600 hover:bg-amber-500' : 'bg-emerald-600 hover:bg-emerald-500'} disabled:bg-gray-700`}
                        title={active ? '重新加载' : '加载'}
                      >
                        {actingPath === m.path ? <Loader2 size={10} className="animate-spin" /> : <Play size={10} />}
                        {active ? '重载' : '加载'}
                      </button>
                      <button onClick={() => onDelete(m)} className="p-1 text-gray-500 hover:text-red-400" title="删除文件">
                        <Trash2 size={11} />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 日志 */}
      <details className="text-xs">
        <summary className="cursor-pointer text-gray-400 hover:text-white flex items-center gap-1">
          <ScrollText size={12} /> llama-server 日志（最近 200 行）
        </summary>
        <pre ref={logsRef} className="mt-2 bg-[#0f172a] border border-gray-700 rounded p-2 text-[11px] font-mono text-gray-300 overflow-auto max-h-64 whitespace-pre-wrap break-all">
          {logs.length ? logs.join('\n') : '(尚无日志)'}
        </pre>
      </details>
    </div>
  );
}

function LlamaBinSection({
  info, input, setInput, saving, message, onSave, onClear, onUseSource, onBrowse, isRemote, remoteHost,
}: {
  info: LlamaBinInfo | null;
  input: string;
  setInput: (v: string) => void;
  saving: boolean;
  message: { kind: 'ok' | 'err'; text: string } | null;
  onSave: () => void;
  onClear: () => void;
  onUseSource: (path: string) => void;
  onBrowse: () => void;
  isRemote: boolean;
  remoteHost: string;
}) {
  const sources = info?.sources;
  const saved = sources?.saved;
  const env = sources?.env;
  const which = sources?.which;
  // 当前生效来源
  const activeKey: 'saved' | 'env' | 'which' | null =
    saved?.executable ? 'saved'
    : env?.executable ? 'env'
    : which?.executable ? 'which'
    : (saved?.path ? 'saved' : env?.path ? 'env' : which?.path ? 'which' : null);

  const envName = info?.env_name || 'LLAMA_SERVER_BIN';

  const SourceRow = ({
    label, probe, sourceKey,
  }: { label: string; probe?: LlamaBinSourceProbe; sourceKey: 'saved' | 'env' | 'which' }) => {
    const has = !!probe?.path;
    const ok = !!probe?.executable;
    const active = activeKey === sourceKey;
    return (
      <div className={`flex items-start gap-2 px-2 py-1.5 rounded text-[11px] border ${
        active ? 'bg-emerald-900/20 border-emerald-500/40' : 'bg-gray-900/40 border-gray-700/60'
      }`}>
        <span className={`shrink-0 w-24 ${active ? 'text-emerald-300 font-medium' : 'text-gray-400'}`}>
          {label}{active && ' ✓'}
        </span>
        <div className="min-w-0 flex-1">
          {has ? (
            <code className={`font-mono text-[11px] break-all ${ok ? 'text-gray-200' : 'text-amber-300'}`}>
              {probe!.path}
            </code>
          ) : (
            <span className="text-gray-600 italic">未设置</span>
          )}
          {has && !ok && (
            <div className="text-amber-400 text-[10px] mt-0.5">
              {probe!.exists ? '文件存在但不可执行（缺少 +x）' : '文件不存在'}
            </div>
          )}
        </div>
        {has && !active && (
          <button
            onClick={() => onUseSource(probe!.path)}
            className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-gray-700 hover:bg-gray-600 text-gray-200"
            title="把这个路径填到输入框"
          >
            使用
          </button>
        )}
      </div>
    );
  };

  return (
    <div className={`rounded-lg border p-3 ${info?.available ? 'bg-gray-800/40 border-gray-700' : 'bg-amber-900/15 border-amber-500/30'}`}>
      <div className="flex items-center gap-2 mb-2">
        <Terminal size={13} className={info?.available ? 'text-emerald-400' : 'text-amber-300'} />
        <span className="text-xs font-medium text-gray-200">llama-server 二进制路径</span>
        {info?.available ? (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-900/40 text-emerald-300">已就绪</span>
        ) : (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-900/40 text-amber-300">未配置 / 不可用</span>
        )}
        {isRemote && (
          <span className="text-[10px] text-gray-500 ml-auto">远端 {remoteHost} 上的路径</span>
        )}
      </div>

      <div className="space-y-1 mb-2">
        <SourceRow label="UI 设置" probe={saved} sourceKey="saved" />
        <SourceRow label={`环境变量 ${envName}`} probe={env} sourceKey="env" />
        <SourceRow label="PATH 自动发现" probe={which} sourceKey="which" />
      </div>

      <div className="flex items-center gap-2">
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && input.trim()) onSave(); }}
          placeholder={isRemote
            ? `远端机器（${remoteHost || 'hub'}）上的绝对路径，例如 /opt/llama.cpp/build/bin/llama-server`
            : '本机绝对路径，例如 /opt/llama.cpp/build/bin/llama-server'}
          className="flex-1 bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-xs font-mono"
        />
        <button
          onClick={onBrowse}
          className="flex items-center gap-1 px-2.5 py-1.5 rounded bg-gray-700 hover:bg-gray-600 text-gray-200 text-xs shrink-0"
          title="从本机选择 llama-server 二进制文件"
        >
          <FolderOpen size={11} /> 浏览
        </button>
        <button
          onClick={onSave}
          disabled={!input.trim() || saving}
          className="flex items-center gap-1 px-2.5 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 disabled:bg-gray-700 text-white text-xs shrink-0"
          title="保存并作为后续启动的 llama-server 路径"
        >
          {saving ? <Loader2 size={11} className="animate-spin" /> : <Save size={11} />}
          保存
        </button>
        {saved?.path && (
          <button
            onClick={onClear}
            disabled={saving}
            className="flex items-center gap-1 px-2.5 py-1.5 rounded bg-gray-700 hover:bg-gray-600 disabled:opacity-60 text-gray-200 text-xs shrink-0"
            title="清除自定义路径，回退到环境变量 / PATH 自动发现"
          >
            <Trash2 size={11} /> 清除
          </button>
        )}
      </div>

      {message && (
        <div className={`mt-1.5 text-[11px] ${message.kind === 'ok' ? 'text-emerald-300' : 'text-red-300'}`}>
          {message.kind === 'ok' ? '✓ ' : '✗ '}{message.text}
        </div>
      )}
      <div className="mt-1.5 text-[11px] text-gray-500">
        优先级：<span className="text-emerald-300">UI 设置</span> &gt; 环境变量 {envName} &gt; PATH 自动发现。
        指向 llama.cpp 编译产物中的 <code className="text-cyan-300">llama-server</code>（旧版可能叫 <code>server</code>）。
      </div>
    </div>
  );
}

function fmtSpeed(bps: number): string {
  if (!bps || bps <= 0) return '—';
  return `${fmtSize(bps)}/s`;
}

function fmtEta(sec: number | null | undefined): string {
  if (sec == null || sec < 0 || !isFinite(sec)) return '—';
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m${Math.round(sec % 60)}s`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h}h${m}m`;
}

function DownloadTab({
  downloadDir, dlRepoId, setDlRepoId, dlFilename, setDlFilename,
  dlToken, setDlToken, dlMmprojAuto, setDlMmprojAuto, dlMmprojFn, setDlMmprojFn,
  submitting, onStart, jobs, onCancel, onClear,
}: any) {
  return (
    <div className="space-y-4">
      <div className="bg-gray-800/40 border border-gray-700 rounded-lg p-3 space-y-2.5">
        <div className="text-xs text-gray-500">
          下载目录：<code className="text-gray-300">{downloadDir || '—'}</code>
          <span className="ml-2 text-[11px]">（环境变量 <code>HF_DOWNLOAD_DIR</code> 可改）</span>
        </div>
        <div>
          <div className="text-xs text-gray-500 mb-1">repo_id 或完整 URL *</div>
          <input
            value={dlRepoId}
            onChange={e => setDlRepoId(e.target.value)}
            placeholder="例: unsloth/Qwen2.5-7B-Instruct-GGUF  或 …/file.gguf  或  https://huggingface.co/.../*.gguf"
            className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-xs font-mono"
          />
          <div className="text-[10px] text-gray-600 mt-0.5">
            支持三种写法：<code>owner/repo</code>（需配文件名）·<code> owner/repo/file.gguf</code> ·<code> https://huggingface.co/.../resolve/main/file.gguf</code>
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          <div>
            <div className="text-xs text-gray-500 mb-1">filename *（owner/repo 模式必填）</div>
            <input
              value={dlFilename}
              onChange={e => setDlFilename(e.target.value)}
              placeholder="例: qwen2.5-7b-instruct-q4_k_m.gguf"
              className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-xs font-mono"
            />
          </div>
          <div>
            <div className="text-xs text-gray-500 mb-1">HF Token（私有模型可选）</div>
            <input
              type="password"
              value={dlToken}
              onChange={e => setDlToken(e.target.value)}
              placeholder="也可设环境变量 HF_TOKEN"
              className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-xs font-mono"
            />
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-[auto_1fr] gap-2 items-end">
          <label className="flex items-center gap-2 text-xs text-gray-300 select-none cursor-pointer">
            <input
              type="checkbox"
              checked={dlMmprojAuto}
              onChange={e => setDlMmprojAuto(e.target.checked)}
              className="accent-blue-500"
            />
            含多模态 (mmproj) — 自动从同 repo 找
          </label>
          <div>
            <div className="text-xs text-gray-500 mb-1">或手动指定 mmproj 文件名（可选）</div>
            <input
              value={dlMmprojFn}
              onChange={e => setDlMmprojFn(e.target.value)}
              placeholder="例: mmproj-Qwen2.5-7B-f16.gguf"
              className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-xs font-mono"
            />
          </div>
        </div>
        <div className="flex justify-end">
          <button
            onClick={onStart}
            disabled={!dlRepoId.trim() || submitting}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 text-white text-xs"
          >
            {submitting ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
            开始下载
          </button>
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="text-xs uppercase tracking-wider text-gray-500">下载任务（实时 SSE）</div>
          <button onClick={onClear} className="text-xs text-gray-500 hover:text-white">清理已完成</button>
        </div>
        {jobs.length === 0 ? (
          <div className="text-xs text-gray-500 bg-gray-800/30 border border-dashed border-gray-700 rounded p-4 text-center">尚无下载任务</div>
        ) : (
          <div className="space-y-1.5">
            {jobs.map((j: DownloadJob) => {
              const total = j.total_size ?? j.total ?? 0;
              const done = j.downloaded_bytes ?? j.downloaded ?? 0;
              const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
              const color = j.status === 'done' ? 'bg-emerald-500' : j.status === 'error' ? 'bg-red-500' : j.status === 'cancelled' ? 'bg-gray-500' : 'bg-blue-500';
              const id = j.job_id || j.id;
              const isRunning = j.status === 'running';
              return (
                <div key={id} className="bg-gray-800/40 border border-gray-700 rounded p-2.5 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <code className="text-gray-300 truncate">{j.filename || j.current_file}</code>
                        {j.is_mmproj && <span className="bg-purple-500/30 text-purple-200 px-1.5 py-0.5 rounded text-[10px]">mmproj</span>}
                        {j.repo_id && <span className="text-gray-500 text-[10px] truncate">[{j.repo_id}]</span>}
                      </div>
                      <div className="text-[11px] text-gray-500 flex items-center gap-2 flex-wrap mt-0.5">
                        <span>{fmtSize(done)} / {total > 0 ? fmtSize(total) : '?'} · {pct}%</span>
                        <span>{j.status}</span>
                        {isRunning && (j.speed_bps != null) && <span>· {fmtSpeed(j.speed_bps)}</span>}
                        {isRunning && (j.eta_seconds != null) && <span>· 剩余 {fmtEta(j.eta_seconds)}</span>}
                        {j.error && <span className="text-red-400">· {j.error}</span>}
                      </div>
                    </div>
                    {isRunning && (
                      <button onClick={() => onCancel(id)} className="px-2 py-1 rounded bg-amber-600 hover:bg-amber-500 text-white text-[10px]">取消</button>
                    )}
                  </div>
                  <div className="mt-1.5 h-1.5 bg-gray-900 rounded overflow-hidden">
                    <div
                      className={`h-full ${color} transition-all ${isRunning && total === 0 ? 'animate-pulse' : ''}`}
                      style={{ width: total > 0 ? `${pct}%` : '15%' }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function DocsTab({ groups }: { groups: APIDocGroup[] }) {
  if (!groups.length) {
    return <div className="text-xs text-gray-500">加载中…</div>;
  }
  const methodColor = (m: string) => ({
    GET: 'bg-emerald-700/40 text-emerald-200',
    POST: 'bg-blue-700/40 text-blue-200',
    PUT: 'bg-amber-700/40 text-amber-200',
    DELETE: 'bg-red-700/40 text-red-200',
    PATCH: 'bg-purple-700/40 text-purple-200',
  } as any)[m] || 'bg-gray-700 text-gray-200';
  return (
    <div className="space-y-5">
      {groups.map(g => (
        <div key={g.name}>
          <div className="text-sm font-medium text-white mb-1">{g.name}</div>
          <div className="text-[11px] text-gray-500 mb-2 flex items-center gap-1">
            base_url:&nbsp;
            <code className="text-cyan-300 break-all">{g.base_url}</code>
            {g.base_url?.startsWith('http') && (
              <button
                onClick={() => window.open(g.base_url, '_blank', 'noopener,noreferrer')}
                className="ml-1 text-gray-500 hover:text-white"
                title="新标签打开"
              >
                <ExternalLink size={10} />
              </button>
            )}
          </div>
          {g.note && <div className="text-[11px] text-gray-500 mb-2 italic">{g.note}</div>}
          <div className="space-y-1">
            {g.endpoints.map((e, i) => (
              <div key={i} className="bg-gray-800/40 border border-gray-700 rounded px-3 py-1.5 flex items-start gap-2 text-xs">
                <span className={`px-1.5 py-0.5 rounded text-[10px] font-mono shrink-0 ${methodColor(e.method)}`}>{e.method}</span>
                <code className="text-cyan-200 shrink-0">{e.path}</code>
                <span className="text-gray-400 ml-auto text-right text-[11px]">{e.desc}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
