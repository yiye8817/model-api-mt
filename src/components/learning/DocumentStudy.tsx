import {useEffect,useState} from 'react';
import {BookOpen,GitBranch,MessagesSquare,RefreshCw,Trash2,Pencil} from 'lucide-react';
import {learningJson} from '../../lib/learningApi';
import type {LearningAnalysis,LearningCitation,LearningChunk,LearningDocument,LearningJob,LearningPage} from '../../lib/learningTypes';
import MindMap from './MindMap';
import DocumentQuestions from './DocumentQuestions';
import MarkdownRenderer from '../MarkdownRenderer';
import {button,input,Pager,errorMessage,positionLabel} from './shared';
import {documentStates} from './LearningSidebar';

export default function DocumentStudy({document,jobs,selectedIds,onWatchJob,onRefresh,onRemoved,onOpenCitation,selectedConceptId}:{document:LearningDocument;jobs:LearningJob[];selectedIds:string[];onWatchJob:(id:string)=>void;onRefresh:()=>void;onRemoved:()=>void;onOpenCitation:(c:LearningCitation)=>void;selectedConceptId?:string|null}){
  const [tab,setTab]=useState('map'),[analysis,setAnalysis]=useState<LearningAnalysis|null>(null),[content,setContent]=useState<LearningPage<LearningChunk>|null>(null),[page,setPage]=useState(1),[error,setError]=useState(''),[editing,setEditing]=useState(false);
  const [title,setTitle]=useState(document.title),[category,setCategory]=useState(document.category),[tags,setTags]=useState(document.tags.join('，'));
  useEffect(()=>{
    const c=new AbortController();setAnalysis(null);setError('');
    void learningJson<{analysis:LearningAnalysis}>(`/documents/${document.id}/analysis`,undefined,'GET',c.signal).then(r=>{if(!c.signal.aborted)setAnalysis(r.analysis);}).catch(e=>{if(!c.signal.aborted&&!(e instanceof Error&&'status' in e&&e.status===404))setError(errorMessage(e));});
    return()=>c.abort();
  },[document.id,document.analysis_id]);
  useEffect(()=>{
    if(tab!=='text')return;const c=new AbortController();setContent(null);
    void learningJson<LearningPage<LearningChunk>>(`/documents/${document.id}/content?page=${page}`,undefined,'GET',c.signal).then(r=>{if(!c.signal.aborted)setContent(r);}).catch(e=>{if(!c.signal.aborted)setError(errorMessage(e));});return()=>c.abort();
  },[document.id,document.revision,tab,page]);
  useEffect(()=>{if(selectedConceptId)setTab('map');},[selectedConceptId]);
  const analyze=async()=>{setError('');try{const r=await learningJson<{job:LearningJob}>('/analyze',{scope:{mode:'selected',document_ids:[document.id]}});(r.job.job_ids||[r.job.id]).forEach(onWatchJob);onRefresh();}catch(e){setError(errorMessage(e));}};
  const save=async()=>{try{await learningJson(`/documents/${document.id}`,{title,category,tags:tags.split(/[,，]/).map(t=>t.trim()).filter(Boolean)},'PATCH');setEditing(false);onRefresh();}catch(e){setError(errorMessage(e));}};
  const remove=async()=>{try{await learningJson(`/documents/${document.id}`,undefined,'DELETE');onRemoved();}catch(e){setError(errorMessage(e));}};
  return <section className="flex h-full min-h-0 flex-col gap-4">
    <header className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><p className="mb-1 text-[10px] uppercase tracking-widest text-emerald-500">DOCUMENT STUDY</p><h3 className="break-words text-xl font-medium">{document.title}</h3>
      <p className="mt-2 text-xs text-slate-500">{document.category||'未分类'} · 修订 {document.revision} · {documentStates[document.status]||document.status}</p></div>
      <div className="flex gap-1"><button className={button} onClick={()=>setEditing(!editing)} aria-label="编辑资料分类"><Pencil size={13}/></button><button className={button} onClick={()=>void analyze()} disabled={['importing','analyzing'].includes(document.status)}><RefreshCw size={13}/>生成分析与思维导图</button><button className={button} aria-label="移除学习资料" onClick={()=>void remove()}><Trash2 size={13}/></button></div>
    </header>
    {editing&&<div className="flex flex-wrap gap-2 rounded-lg border border-slate-700 p-3"><input aria-label="资料标题" className={input} value={title} onChange={e=>setTitle(e.target.value)}/><input aria-label="修改资料分类" className={input} value={category} onChange={e=>setCategory(e.target.value)} placeholder="分类"/><input aria-label="资料标签" className={input} value={tags} onChange={e=>setTags(e.target.value)} placeholder="标签，以逗号分隔"/><button className={button} onClick={()=>void save()}>保存分类</button></div>}
    {document.tags.length>0&&<div className="flex gap-2">{document.tags.map(t=><span key={t} className="rounded-md bg-slate-800 px-2 py-1 text-[11px] text-slate-400">{t}</span>)}</div>}
    {(document.warnings||[]).map(w=><p key={w} className="text-xs text-amber-300">{w}</p>)}
    {(error||document.last_error)&&<p role="alert" className="text-xs text-amber-300">{error||document.last_error}</p>}
    <nav className="flex gap-2 border-b border-slate-800 pb-3">{[{id:'map',name:'思维导图',icon:GitBranch},{id:'text',name:'原文',icon:BookOpen},{id:'questions',name:'文档问答',icon:MessagesSquare}].map(t=><button key={t.id} className={`${button} ${tab===t.id?'border-emerald-700 text-emerald-300':''}`} onClick={()=>setTab(t.id)}><t.icon size={13}/>{t.name}</button>)}</nav>
    {tab==='map'&&(analysis?<><details className="rounded-lg bg-slate-900/70 p-3 text-xs text-slate-400"><summary className="cursor-pointer">文档摘要 · 已分析 {analysis.coverage.processed}/{analysis.coverage.total} 个片段{analysis.needs_update?' · 资料已更新':''}</summary><div className="pt-3"><MarkdownRenderer content={analysis.summary}/></div></details><MindMap tree={analysis.tree} onOpenCitation={onOpenCitation} selectedConceptId={selectedConceptId}/></>:<div className="flex flex-1 flex-col items-center justify-center gap-3 text-center text-sm text-slate-500"><GitBranch size={40} className="text-slate-700"/><p>{['importing','analyzing'].includes(document.status)?'正在处理资料，完成后会显示思维导图。':'这份资料还没有思维导图。'}</p><button className={button} disabled={['importing','analyzing'].includes(document.status)} onClick={()=>void analyze()}>生成分析与思维导图</button></div>)}
    {tab==='text'&&<div className="min-h-0 flex-1 overflow-y-auto">{content?.items.map(c=><article key={c.id} className="mb-3 rounded-lg border border-slate-800 p-4"><p className="mb-2 text-[10px] text-slate-500">{positionLabel(c.position)}</p><pre className="whitespace-pre-wrap break-words font-sans text-sm leading-8 text-slate-300">{c.text}</pre></article>)}{content&&<Pager page={page} total={content.total} onChange={setPage}/>}</div>}
    <div className={`min-h-0 flex-1 flex-col ${tab==='questions'?'flex':'hidden'}`}><DocumentQuestions documentId={document.id} documentTitle={document.title} selectedIds={selectedIds} jobs={jobs} onWatchJob={onWatchJob} onOpenCitation={onOpenCitation}/></div>
  </section>;
}
