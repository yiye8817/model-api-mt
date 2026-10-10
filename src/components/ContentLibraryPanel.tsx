import { useEffect, useRef, useState } from 'react';
import { BookOpen, Check, FileUp, FlaskConical, Loader2, Plus, Search, Tag, X } from 'lucide-react';
import MarkdownRenderer from './MarkdownRenderer';
import { APP_INTENTS, FACT_LABELS, knowledgeRequest, safeSourceUrl,
  type BenchmarkReport, type FactStatus, type KnowledgeEntry, type KnowledgeSearch, type KnowledgeStatus } from '../lib/knowledge';

const field = 'w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-gray-200 focus:border-cyan-500 outline-none';
const button = 'inline-flex items-center justify-center gap-2 rounded-lg border border-gray-700 px-3 py-2 text-sm text-gray-200 hover:bg-gray-800 disabled:opacity-40';

export default function ContentLibraryPanel({ initialQuery = '', initialEntryId, onClose }: {
  initialQuery?: string; initialEntryId?: string; onClose: () => void;
}) {
  const [tab, setTab] = useState<'search' | 'import' | 'benchmark'>('search');
  const [query, setQuery] = useState(initialQuery);
  const [scope, setScope] = useState('all');
  const [kind, setKind] = useState('qa');
  const [source, setSource] = useState('');
  const [tag, setTag] = useState('');
  const [factStatus, setFactStatus] = useState('');
  const [sort, setSort] = useState('relevance');
  const [status, setStatus] = useState<KnowledgeStatus | null>(null);
  const [result, setResult] = useState<KnowledgeSearch | null>(null);
  const [selected, setSelected] = useState<KnowledgeEntry | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [adding, setAdding] = useState(false);
  const [format, setFormat] = useState('records');
  const [partition, setPartition] = useState('dev');
  const [importName, setImportName] = useState('');
  const [importUrl, setImportUrl] = useState('');
  const [importContent, setImportContent] = useState('');
  const queryRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    knowledgeRequest<KnowledgeStatus>('/status', 'GET', undefined, controller.signal)
      .then(setStatus).catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [refresh]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setResult(null);
    const timer = window.setTimeout(() => {
      knowledgeRequest<KnowledgeSearch>('/search', 'POST', {
        query, scope, source, tag: tag.trim(), fact_status: factStatus, sort, kind,
      }, controller.signal).then(data => { setResult(data); setError(''); })
        .catch(e => { if (!controller.signal.aborted) setError(e.message); })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, 300);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, scope, source, tag, factStatus, sort, kind, refresh]);

  useEffect(() => {
    queryRef.current?.focus();
    const handleKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  useEffect(() => {
    if (!initialEntryId) return;
    const controller = new AbortController();
    knowledgeRequest<KnowledgeEntry>(`/entries/${encodeURIComponent(initialEntryId)}`, 'GET', undefined, controller.signal)
      .then(setSelected).catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [initialEntryId, refresh]);

  const changed = () => { setRefresh(v => v + 1); setNotice('已保存，后续检索会使用这些标注。'); };

  const importData = async () => {
    setBusy(true); setError(''); setNotice('');
    try {
      const data = await knowledgeRequest<{ imported: number; evaluations: number }>('/import', 'POST', {
        format, partition, name: importName, source_url: importUrl, content: importContent,
      });
      setNotice(`导入完成：${data.imported} 条内容、${data.evaluations} 条评测样例。`);
      setRefresh(v => v + 1);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const evaluate = async () => {
    setBusy(true); setError(''); setNotice('');
    try {
      const report = await knowledgeRequest<BenchmarkReport>('/evaluate', 'POST', {});
      setStatus(previous => previous ? { ...previous, last_evaluation: report } : previous);
      setRefresh(v => v + 1);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-[100] bg-black/70 flex items-center justify-center p-3 sm:p-6">
      <section role="dialog" aria-modal="true" aria-labelledby="knowledge-title" className="w-full max-w-5xl h-[90vh] rounded-2xl border border-gray-700 bg-gray-900 shadow-2xl flex flex-col overflow-hidden">
        <header className="px-5 py-4 border-b border-gray-800 flex items-center gap-3">
          <BookOpen size={23} className="text-cyan-400" />
          <div className="flex-1"><h2 id="knowledge-title" className="text-lg font-semibold text-white">内容库</h2>
            <p className="text-xs text-gray-400">{status ? `${status.entries} 条内容 · ${status.evaluations} 条基准样例` : '正在加载公开集与已保存内容…'}</p></div>
          <button onClick={onClose} className={button} aria-label="关闭内容库"><X size={18} /></button>
        </header>
        <nav className="flex flex-wrap gap-2 px-5 py-3 border-b border-gray-800" aria-label="内容库功能">
          {([['search', '查找与标注', Search], ['import', '导入公开集', FileUp], ['benchmark', '基准评测', FlaskConical]] as const).map(([id, label, Icon]) => (
            <button key={id} onClick={() => setTab(id)} className={`${button} ${tab === id ? 'border-cyan-700 bg-cyan-950 text-cyan-200' : ''}`} aria-pressed={tab === id}><Icon size={15} />{label}</button>
          ))}
          <button onClick={() => { setTab('search'); setAdding(true); }} className={`${button} sm:ml-auto`}><Plus size={15} />新建条目</button>
        </nav>
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {error && <p role="alert" className="rounded-lg border border-red-800 bg-red-950/30 p-3 text-sm text-red-200">{error}</p>}
          {notice && <p role="status" className="text-sm text-emerald-300">{notice}</p>}
          {adding && <NewEntry onCancel={() => setAdding(false)} onSaved={() => { setAdding(false); changed(); }} />}
          {tab === 'search' && <>
            <label className="block"><span className="sr-only">当前输入或查找关键词</span><input ref={queryRef} className={field} value={query} onChange={e => setQuery(e.target.value)} maxLength={2000} placeholder="输入问题、来源名称或标签；留空可浏览内容" /></label>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              <Select label="内容范围" value={scope} onChange={setScope} options={{ all: '全部内容', history: '已保存对话', public: '公开数据集', manual: '手动保存' }} />
              <Select label="内容类型" value={kind} onChange={setKind} options={{ qa: '问答与原文', intent: '意图样例' }} />
              <Select label="排序" value={sort} onChange={setSort} options={{ relevance: '匹配度优先', verified: '已确认正确优先' }} />
              <Select label="事实状态" value={factStatus} onChange={setFactStatus} options={{ '': '全部状态', ...FACT_LABELS }} />
              <label className="text-xs text-gray-400">来源筛选<input aria-label="来源筛选" className={`${field} mt-1`} list="knowledge-sources" value={source} onChange={e => setSource(e.target.value)} placeholder="来源名称" /></label>
              <datalist id="knowledge-sources">{status?.sources.map(item => <option key={item} value={item} />)}</datalist>
              <label className="text-xs text-gray-400">标签筛选<input aria-label="标签筛选" className={`${field} mt-1`} value={tag} onChange={e => setTag(e.target.value)} placeholder="完整标签" /></label>
            </div>
            {result && query.trim() && <div className="rounded-xl border border-cyan-900 bg-cyan-950/20 p-3 text-sm text-gray-300">
              <span className="text-cyan-300 font-medium">输入意图：{result.intent.intent}</span>
              {result.intent.native_label && <span className="ml-3 text-xs text-gray-400">原始标签：{result.intent.native_label} · 样例词项覆盖 {Math.round(result.intent.coverage * 100)}%</span>}
              <p className="text-xs text-gray-400 mt-1">{result.intent.sample ? `匹配样例：${result.intent.sample.question}` : result.intent.reason}</p>
            </div>}
            <p className="text-xs text-gray-500">匹配分用于结果排序。事实状态由人工标记；公开集内容默认未核验。</p>
            {selected && <div className="border-l-2 border-cyan-500 pl-3"><p className="text-xs text-cyan-300 mb-2">当前回答的来源与核验标注</p><EntryCard key={selected.id + selected.annotated_at} entry={selected} onSaved={changed} defaultEditing /></div>}
            {loading ? <p className="flex gap-2 text-gray-400 text-sm"><Loader2 size={16} className="animate-spin" />正在匹配…</p> : <p className="text-xs text-gray-400">共 {result?.total ?? 0} 条匹配，显示前 {result?.results.length ?? 0} 条</p>}
            {!loading && result?.total === 0 && <p className="py-8 text-center text-gray-500">没有匹配的内容，可调整关键词或筛选条件。</p>}
            {result?.results.filter(entry => entry.id !== selected?.id).map(entry => <EntryCard key={entry.id + entry.annotated_at} entry={entry} onSaved={changed} />)}
          </>}
          {tab === 'import' && <div className="space-y-4">
            <p className="text-sm text-gray-300">内置 MASSIVE 中文意图子集与 CMRC2018 原文检索子集已自动导入。可继续导入公开集或自有问答。</p>
            <div className="grid sm:grid-cols-2 gap-3">
              <Select label="导入格式" value={format} onChange={setFormat} options={{ records: '统一问答 / 意图 JSON 或 JSONL', massive: 'MASSIVE zh-CN JSONL', cmrc: 'CMRC2018 JSON' }} />
              <label className="text-xs text-gray-400">数据集名称<input className={`${field} mt-1`} aria-label="数据集名称" value={importName} onChange={e => setImportName(e.target.value)} maxLength={200} placeholder="用于来源追溯和重复导入识别" /></label>
            </div>
            {format === 'cmrc' && <Select label="CMRC 数据分区" value={partition} onChange={setPartition} options={{
              dev: '开发集：原文入库、问题用于评测', test: '测试集：原文入库、问题用于评测', train: '训练集：保存问题、答案与原文',
            }} />}
            <label className="block text-xs text-gray-400">来源链接<input className={`${field} mt-1`} aria-label="数据集来源链接" value={importUrl} onChange={e => setImportUrl(e.target.value)} placeholder="https://…" /></label>
            <input type="file" accept=".json,.jsonl,application/json" aria-label="选择导入文件" className="text-sm text-gray-400" onChange={async e => {
              const file = e.target.files?.[0];
              if (!file) return;
              if (file.size > 40 * 1024 * 1024) { setError('导入文件不能超过40 MB'); return; }
              try { setImportContent(await file.text()); if (!importName) setImportName(file.name.replace(/\.(json|jsonl)$/i, '')); }
              catch (error) { setError((error as Error).message); }
            }} />
            <textarea className={`${field} font-mono h-44`} aria-label="导入内容" value={importContent} onChange={e => setImportContent(e.target.value)} placeholder={'[{"id":"qa-1","kind":"qa","question":"如何安装Python？","answer":"下载安装包。","source_name":"官方文档","source_url":"https://python.org/"}]'} />
            <p className="text-xs text-gray-500">意图记录使用 kind="intent"、question、intent、split（train/dev/test）。评测分区不会成为匹配样例；重复导入保留人工标注。</p>
            <button className={`${button} bg-cyan-950 border-cyan-800`} onClick={() => void importData()} disabled={busy || !importName.trim() || !importContent.trim()}>{busy ? <Loader2 size={15} className="animate-spin" /> : <FileUp size={15} />}导入内容</button>
          </div>}
          {tab === 'benchmark' && <div className="space-y-4">
            <p className="text-sm text-gray-300">评测输入意图分类与原文匹配，使用公开保留样例。结果展示抽样基线效果。</p>
            <p className="text-xs text-gray-500">私人历史和人工正确性排序不参与评测；问答指标是原文检索命中率，区别于阅读理解答案评分。</p>
            <button className={button} onClick={() => void evaluate()} disabled={busy}>{busy ? <Loader2 size={15} className="animate-spin" /> : <FlaskConical size={15} />}{busy ? '评测中…' : '运行基准评测'}</button>
            {status?.last_evaluation ? <Report report={status.last_evaluation} /> : <p className="text-sm text-gray-500">尚未运行评测。</p>}
            <div className="text-xs text-gray-400 space-y-2"><p>本地样例覆盖：{status?.covered_intents.join('、') || '暂无'}</p><p>尚未覆盖：{status?.uncovered_intents.join('、') || '无'}</p>
              {status?.datasets.map(dataset => <p key={dataset.id}><a href={safeSourceUrl(dataset.source_url)} target="_blank" rel="noopener noreferrer" className="text-cyan-400 underline">{dataset.name}</a> · {dataset.entries} 条内容</p>)}</div>
          </div>}
        </div>
      </section>
    </div>
  );
}

function Select({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: Record<string, string> }) {
  return <label className="text-xs text-gray-400">{label}<select aria-label={label} className={`${field} mt-1`} value={value} onChange={e => onChange(e.target.value)}>{Object.entries(options).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>;
}

function EntryCard({ entry, onSaved, defaultEditing = false }: { entry: KnowledgeEntry; onSaved: () => void; defaultEditing?: boolean }) {
  const [editing, setEditing] = useState(defaultEditing);
  const [state, setState] = useState<FactStatus>(entry.fact_status);
  const [source, setSource] = useState(entry.source_name);
  const [url, setUrl] = useState(entry.source_url);
  const [tags, setTags] = useState(entry.tags.join('，'));
  const [note, setNote] = useState(entry.note);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const save = async () => {
    setBusy(true); setError('');
    try {
      await knowledgeRequest(`/entries/${encodeURIComponent(entry.id)}`, 'PATCH', {
        fact_status: state, source_name: source, source_url: url,
        tags: tags.split(/[,，\n]/).map(value => value.trim()).filter(Boolean), note,
      });
      setEditing(false); onSaved();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  return <article className="rounded-xl border border-gray-700 bg-gray-950/40 p-4 space-y-3">
    <div className="flex gap-3 items-start"><div className="flex-1 min-w-0"><h3 className="text-sm font-medium text-gray-100 break-words">{entry.question || entry.title || '公开集原文'}</h3>
      <p className="text-xs text-gray-500 mt-1">{{ history: '已保存对话', public: '公开集', manual: '手动保存' }[entry.origin]} · {entry.source_name || '未标注来源'}{entry.match_score !== undefined && ` · 匹配分 ${entry.match_score.toPrecision(3)}`}</p></div>
      <span className={`text-xs shrink-0 rounded-full px-2 py-1 ${entry.fact_status === 'correct' ? 'bg-emerald-950 text-emerald-300' : entry.fact_status === 'incorrect' ? 'bg-red-950 text-red-300' : 'bg-gray-800 text-gray-300'}`}>{FACT_LABELS[entry.fact_status]}</span></div>
    {entry.kind === 'intent' ? <p className="text-sm text-cyan-300">意图：{entry.intent} {entry.native_label && `(${entry.native_label})`}</p> : <>
      <p className="text-sm text-gray-400 whitespace-pre-wrap break-words line-clamp-3">{entry.answer.slice(0, 600)}</p>
      <details><summary className="text-xs text-cyan-400 cursor-pointer">查看完整内容</summary><div className="mt-3 text-sm max-h-96 overflow-y-auto"><MarkdownRenderer content={entry.answer} />{entry.context && <details className="mt-3"><summary>关联来源正文</summary><MarkdownRenderer content={entry.context} /></details>}</div></details>
    </>}
    <div className="flex gap-2 flex-wrap items-center text-xs">{safeSourceUrl(entry.source_url) && <a className="text-cyan-400 underline" href={safeSourceUrl(entry.source_url)} target="_blank" rel="noopener noreferrer">打开来源</a>}{entry.tags.map(tag => <span className="inline-flex gap-1 items-center bg-gray-800 rounded px-2 py-1 text-gray-300" key={tag}><Tag size={10} />{tag}</span>)}</div>
    {entry.note && <p className="text-xs text-gray-400">核验备注：{entry.note}</p>}
    {editing ? <div className="space-y-3 border-t border-gray-800 pt-3">
      <div className="grid sm:grid-cols-2 gap-3"><Select label="人工事实状态" value={state} onChange={v => setState(v as FactStatus)} options={FACT_LABELS} />
        <label className="text-xs text-gray-400">来源名称<input className={`${field} mt-1`} aria-label="来源名称" value={source} onChange={e => setSource(e.target.value)} maxLength={200} /></label></div>
      <label className="block text-xs text-gray-400">来源链接<input className={`${field} mt-1`} aria-label="来源链接" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://…" /></label>
      <label className="block text-xs text-gray-400">标签<input className={`${field} mt-1`} aria-label="标签" value={tags} onChange={e => setTags(e.target.value)} placeholder="用逗号分隔，供后续检索" /></label>
      <label className="block text-xs text-gray-400">核验备注<textarea className={`${field} mt-1`} aria-label="核验备注" value={note} onChange={e => setNote(e.target.value)} maxLength={4000} /></label>
      <p className="text-xs text-gray-500">原始来源：{entry.original_source_name || '未记录'}{safeSourceUrl(entry.original_source_url) && <a href={safeSourceUrl(entry.original_source_url)} target="_blank" rel="noopener noreferrer" className="ml-2 text-cyan-400 underline">原始链接</a>}{entry.annotated_at && ` · 上次标注 ${new Date(entry.annotated_at).toLocaleString()}`}</p>
      {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
      <button className={button} onClick={() => void save()} disabled={busy}>{busy ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}保存标注</button>
      <button className={`${button} ml-2`} onClick={() => setEditing(false)} disabled={busy}>取消</button>
    </div> : <button className={button} onClick={() => setEditing(true)}>标注来源与事实状态</button>}
  </article>;
}

function NewEntry({ onCancel, onSaved }: { onCancel: () => void; onSaved: () => void }) {
  const [kind, setKind] = useState('qa');
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [intent, setIntent] = useState('问答');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const save = async () => {
    setBusy(true); setError('');
    try { await knowledgeRequest('/entries', 'POST', { kind, question, answer, intent }); onSaved(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  return <div className="rounded-xl border border-cyan-900 p-4 space-y-3"><h3 className="text-sm text-cyan-200 font-medium">新建内容</h3>
    <Select label="新建类型" value={kind} onChange={setKind} options={{ qa: '保存问答', intent: '补充意图样例' }} />
    <input className={field} aria-label="新条目问题" value={question} onChange={e => setQuestion(e.target.value)} placeholder={kind === 'qa' ? '问题' : '示例输入'} />
    {kind === 'qa' ? <textarea className={field} aria-label="新条目回答" value={answer} onChange={e => setAnswer(e.target.value)} placeholder="保存的回答或正文" /> : <Select label="意图类别" value={intent} onChange={setIntent} options={Object.fromEntries(APP_INTENTS.map(value => [value, value]))} />}
    {error && <p role="alert" className="text-red-300 text-sm">{error}</p>}
    <button className={button} onClick={() => void save()} disabled={busy || !question.trim() || (kind === 'qa' && !answer.trim())}>保存条目</button><button className={`${button} ml-2`} onClick={onCancel} disabled={busy}>取消</button>
  </div>;
}

function Report({ report }: { report: BenchmarkReport }) {
  const percent = (value: number | null) => value === null ? '无样例' : `${(value * 100).toFixed(1)}%`;
  return <div className="rounded-xl border border-gray-700 p-4 space-y-3 text-sm text-gray-300">
    <p className="text-xs text-gray-500">评测时间：{new Date(report.created_at).toLocaleString()}</p>
    <div className="overflow-x-auto"><table className="w-full text-left"><thead className="text-xs text-gray-500"><tr><th className="py-2">任务</th><th>样本数</th><th>指标</th><th>结果</th></tr></thead><tbody>
      <tr><td className="py-2">映射意图分类</td><td>{report.intent.total}</td><td>Accuracy / Macro-F1</td><td>{percent(report.intent.accuracy)} / {percent(report.intent.macro_f1)}</td></tr>
      <tr><td className="py-2">原始意图分类</td><td>{report.intent.total}</td><td>Accuracy</td><td>{percent(report.intent.native_accuracy)}</td></tr>
      <tr><td className="py-2">问答原文匹配</td><td>{report.qa.total}</td><td>Hit@1 / Hit@5 / MRR@5</td><td>{percent(report.qa.hit_at_1)} / {percent(report.qa.hit_at_5)} / {percent(report.qa.mrr_at_5)}</td></tr>
    </tbody></table></div>
    <p className="text-xs text-gray-500">已排除与意图训练样例重复的评测输入：{report.intent.excluded_overlap} 条。</p>
    <p className="text-xs text-gray-500">{report.scope}</p>
  </div>;
}
