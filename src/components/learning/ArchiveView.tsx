import {useEffect,useState} from 'react';
import {Archive,Download,FolderPlus} from 'lucide-react';
import {learningJson} from '../../lib/learningApi';
import type {LearningArchive,LearningCitation,LearningJob,LearningPage,LearningScope} from '../../lib/learningTypes';
import MarkdownRenderer from '../MarkdownRenderer';
import {button,input,Pager,Citations,errorMessage} from './shared';

export default function ArchiveView({scope,onOpenDocument,onOpenCitation,onWatchJob,refreshKey=''}:{scope:LearningScope;onOpenDocument:(id:string)=>void;onOpenCitation:(c:LearningCitation)=>void;onWatchJob:(id:string)=>void;refreshKey?:string}){
  const [data,setData]=useState<LearningPage<LearningArchive>>({items:[],total:0,page:1,page_size:30}),[selected,setSelected]=useState<LearningArchive|null>(null),[query,setQuery]=useState(''),[page,setPage]=useState(1);
  const [title,setTitle]=useState(''),[range,setRange]=useState('all'),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  useEffect(()=>{
    const c=new AbortController();void learningJson<LearningPage<LearningArchive>>(`/archives?q=${encodeURIComponent(query)}&page=${page}`,undefined,'GET',c.signal).then(r=>{if(!c.signal.aborted)setData(r);}).catch(e=>{if(!c.signal.aborted)setError(errorMessage(e));});return()=>c.abort();
  },[query,page,refreshKey]);
  const open=async(id:string)=>{setError('');try{const r=await learningJson<{archive:LearningArchive}>(`/archives/${id}`);setSelected(r.archive);}catch(e){setError(errorMessage(e));}};
  const create=async()=>{setBusy(true);setError('');try{const r=await learningJson<{job:LearningJob}>('/archives',{title,scope:range==='all'?{mode:'all'}:scope});onWatchJob(r.job.id);setNotice('整合归档任务已创建，完成后会保存到下方列表。');}catch(e){setError(errorMessage(e));}finally{setBusy(false);}};
  return <section className="flex h-full min-h-0 flex-col gap-4"><div><h3 className="text-lg font-medium">整合归档</h3><p className="mt-1 text-xs text-slate-500">按主题整理资料，保留知识点、综合笔记和来源。</p></div>
    <form className="flex flex-wrap gap-2 rounded-xl border border-slate-800 bg-slate-900/50 p-3" onSubmit={e=>{e.preventDefault();void create();}}><input aria-label="整合归档主题" className={`${input} flex-1`} value={title} onChange={e=>setTitle(e.target.value)} placeholder="为整合笔记设置主题"/><select aria-label="整合资料范围" className={input} value={range} onChange={e=>setRange(e.target.value)}><option value="all">全部资料</option><option value="selected" disabled={scope.mode==='selected'&&!scope.document_ids.length}>当前或已勾选资料</option></select><button className={button} disabled={busy}><FolderPlus size={13}/>生成整合归档</button></form>
    {error&&<p role="alert" className="text-xs text-amber-300">{error}</p>}{notice&&<p role="status" className="text-xs text-emerald-300">{notice}</p>}
    <div className="flex min-h-0 flex-1 gap-4"><div className="w-60 shrink-0 overflow-auto border-r border-slate-800 pr-3"><input aria-label="搜索整合归档" className={`${input} mb-3 w-full`} value={query} onChange={e=>{setQuery(e.target.value);setPage(1);}} placeholder="搜索归档笔记"/>
      {data.items.map(a=><button key={a.id} aria-label={a.title} className={`mb-2 w-full rounded-xl border p-3 text-left ${selected?.id===a.id?'border-emerald-800 bg-emerald-950/40':'border-slate-800'}`} onClick={()=>void open(a.id)}><span className="flex gap-2 text-sm"><Archive size={14} className="mt-0.5 shrink-0 text-emerald-400"/>{a.title}</span><span className="mt-2 block text-[10px] text-slate-500">{a.category||'综合笔记'} · {new Date(a.created_at*1000).toLocaleDateString()}</span></button>)}
      {!data.total&&<p className="py-8 text-xs text-slate-500">还没有归档。可整合资料，或保存问答与探索笔记。</p>}<Pager page={page} total={data.total} onChange={setPage}/>
    </div><div className="min-w-0 flex-1 overflow-auto">{selected?<article className="space-y-4"><div><h4 className="text-xl font-medium">{selected.title}</h4>{selected.needs_update&&<p className="mt-2 text-xs text-amber-300">资料已更新或移除，这份归档保留生成时的版本，可重新整理。</p>}</div>
      <div className="flex gap-2"><a className={button} href={`/api/learning/archives/${selected.id}/export?format=markdown`} download><Download size={13}/>导出 Markdown</a><a className={button} href={`/api/learning/archives/${selected.id}/export?format=json`} download><Download size={13}/>导出 JSON 图谱</a></div>
      {!!selected.documents.length&&<div className="rounded-lg border border-slate-800 p-3"><p className="mb-2 text-xs text-slate-500">来源目录</p>{selected.documents.map(d=><button key={d.id} className="mr-2 text-xs leading-7 text-emerald-300" onClick={()=>onOpenDocument(d.id)}>{d.title} ↗</button>)}</div>}
      <MarkdownRenderer content={selected.markdown}/><Citations items={selected.citations} onOpen={onOpenCitation}/>{!!selected.concepts.length&&<details className="text-xs text-slate-400"><summary className="cursor-pointer">归档知识点（{selected.concepts.length}）</summary><div className="mt-2 flex flex-wrap gap-2">{selected.concepts.map((c,i)=><span key={`${c.id}-${i}`} className="rounded bg-slate-800 px-2 py-1">{c.name}</span>)}</div></details>}
    </article>:<div className="flex h-full items-center justify-center text-sm text-slate-500">选择一份归档，查看综合笔记与原文引用。</div>}</div></div>
  </section>;
}
