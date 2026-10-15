import {useEffect,useState} from 'react';
import {Lightbulb,Compass,Bookmark,ArrowUpRight} from 'lucide-react';
import {learningJson} from '../../lib/learningApi';
import type {LearningCitation,LearningConcept,LearningJob,LearningPage} from '../../lib/learningTypes';
import MarkdownRenderer from '../MarkdownRenderer';
import {button,input,Citations,Pager,errorMessage} from './shared';
const emptyIds:string[]=[];

export default function ConceptExplorer({onOpenDocument,onOpenCitation,onSelectConcept,onWatchJob,selectedConceptId,selectedIds=emptyIds,currentDocumentId,categories=[],refreshKey=''}:{
  onOpenDocument:(id:string,conceptId?:string)=>void;onOpenCitation:(c:LearningCitation)=>void;onSelectConcept:(id:string)=>void;onWatchJob:(id:string)=>void;selectedConceptId?:string|null;selectedIds?:string[];currentDocumentId?:string;categories?:string[];refreshKey?:string;
}){
  const [query,setQuery]=useState(''),[category,setCategory]=useState(''),[range,setRange]=useState('all'),[page,setPage]=useState(1),[data,setData]=useState<LearningPage<LearningConcept>>({items:[],total:0,page:1,page_size:30});
  const [chosen,setChosen]=useState<string|null>(selectedConceptId||null),[concept,setConcept]=useState<LearningConcept|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
  useEffect(()=>{if(selectedConceptId)setChosen(selectedConceptId);},[selectedConceptId]);
  useEffect(()=>{
    const c=new AbortController();const ids=range==='selected'?selectedIds:range==='current'&&currentDocumentId?[currentDocumentId]:[];
    const params=new URLSearchParams({q:query,category,page:String(page)});if(ids.length)params.set('document_ids',ids.join(','));
    void learningJson<LearningPage<LearningConcept>>('/concepts?'+params,undefined,'GET',c.signal).then(r=>{if(!c.signal.aborted)setData(r);}).catch(e=>{if(!c.signal.aborted)setError(errorMessage(e));});return()=>c.abort();
  },[query,category,range,page,selectedIds,currentDocumentId,refreshKey]);
  useEffect(()=>{
    if(!chosen)return;const c=new AbortController();setConcept(null);setError('');
    void learningJson<{concept:LearningConcept}>(`/concepts/${chosen}`,undefined,'GET',c.signal).then(r=>{if(!c.signal.aborted)setConcept(r.concept);}).catch(e=>{if(!c.signal.aborted)setError(errorMessage(e));});return()=>c.abort();
  },[chosen,refreshKey]);
  const explore=async()=>{if(!concept)return;setBusy(true);setError('');try{
    const ids=range==='selected'?selectedIds:range==='current'&&currentDocumentId?[currentDocumentId]:concept.document_ids;
    if(!ids.length)throw new Error('请选择探索所用的资料');
    const r=await learningJson<{job:LearningJob}>(`/concepts/${concept.id}/explore`,{scope:{mode:'selected',document_ids:ids}});onWatchJob(r.job.id);setNotice('深入探索已开始，完成后会保存在此知识点下。');
  }catch(e){setError(errorMessage(e));}finally{setBusy(false);}};
  const save=async(id:string)=>{try{await learningJson('/archives/notes',{title:`${concept?.name} · 深入探索`,origin:{kind:'exploration',id}});setNotice('已保存到整合归档');}catch(e){setError(errorMessage(e));}};
  return <section className="flex h-full min-h-0 flex-col gap-4">
    <div><h3 className="text-lg font-medium">全部知识点</h3><p className="mt-1 text-xs text-slate-500">查看知识点在不同资料中的定义、出处与关联。</p></div>
    <div className="flex flex-wrap gap-2"><input aria-label="搜索全部知识点" className={`${input} flex-1`} placeholder="搜索知识点、说明或别名" value={query} onChange={e=>{setQuery(e.target.value);setPage(1);}}/>
      <select aria-label="知识点分类" className={input} value={category} onChange={e=>{setCategory(e.target.value);setPage(1);}}><option value="">全部分类</option>{categories.map(c=><option key={c}>{c}</option>)}</select>
      <select aria-label="知识点来源范围" className={input} value={range} onChange={e=>{setRange(e.target.value);setPage(1);}}><option value="all">全部资料</option><option value="current" disabled={!currentDocumentId}>当前文档</option><option value="selected" disabled={!selectedIds.length}>已勾选资料</option></select></div>
    {error&&<p role="alert" className="text-xs text-amber-300">{error}</p>}{notice&&<p role="status" className="text-xs text-emerald-300">{notice}</p>}
    <div className="flex min-h-0 flex-1 gap-4"><div className="w-64 shrink-0 overflow-auto border-r border-slate-800 pr-3"><p className="mb-3 text-[11px] text-slate-500">{data.total} 个知识点</p>
      {data.items.map(c=><button key={c.id} aria-label={c.name} onClick={()=>{setChosen(c.id);onSelectConcept(c.id);}} className={`mb-2 w-full rounded-xl border p-3 text-left ${chosen===c.id?'border-emerald-800 bg-emerald-950/40':'border-slate-800 hover:bg-slate-900'}`}><div className="flex gap-2 text-sm"><Lightbulb size={14} className="mt-0.5 shrink-0 text-amber-400"/>{c.name}</div><p className="mt-2 text-[10px] text-slate-500">{c.domain||'未分类'} · {c.document_ids.length} 份资料</p></button>)}
      {!data.total&&<p className="py-8 text-xs leading-6 text-slate-500">尚无匹配的知识点。文档分析完成后会在此汇总。</p>}<Pager page={page} total={data.total} onChange={setPage}/>
    </div><div className="min-w-0 flex-1 overflow-auto">{concept?<div className="space-y-5"><div><p className="text-[10px] uppercase tracking-wider text-emerald-500">{concept.domain}</p><h4 className="mt-1 text-xl font-medium">{concept.name}</h4><div className="mt-3 text-sm leading-7 text-slate-300"><MarkdownRenderer content={concept.description}/></div>{concept.aliases.length>0&&<p className="mt-2 text-xs text-slate-500">别名：{concept.aliases.join('、')}</p>}<Citations items={concept.citations} onOpen={onOpenCitation}/></div>
      <div className="flex flex-wrap gap-2"><button className={`${button} border-emerald-800 bg-emerald-950/40`} disabled={busy} onClick={()=>void explore()}><Compass size={13}/>深入探索</button>{concept.document_ids.map((id,i)=><button key={id} aria-label={i===0?'查看来源文档与导图':`查看来源文档与导图 ${i+1}`} className={button} onClick={()=>onOpenDocument(id,concept.id)}><ArrowUpRight size={13}/>来源文档 {i+1}</button>)}</div>
      {(concept.definitions||[]).length>1&&<div className="space-y-2"><h5 className="text-xs text-slate-500">各来源中的解释</h5>{concept.definitions!.map((d,i)=><article key={i} className="rounded-lg border border-slate-800 p-3 text-sm leading-7"><p>{d.description}</p><Citations items={d.citations} onOpen={onOpenCitation}/></article>)}</div>}
      {(concept.explorations||[]).map(record=><article key={record.id} className="space-y-3 rounded-xl border border-slate-700 bg-slate-900/50 p-4"><h5 className="text-sm text-emerald-300">知识点深入探索</h5>{([['principles','原理'],['prerequisites','前置知识'],['examples','例子'],['pitfalls','常见误区'],['related','关联概念']] as const).map(([key,label])=>record[key]&&<div key={key}><p className="mb-1 text-xs text-slate-500">{label}</p><MarkdownRenderer content={record[key]}/></div>)}
        {record.extension&&<div className="border-l-2 border-amber-700 pl-3"><p className="mb-1 text-xs text-amber-300">拓展说明</p><MarkdownRenderer content={record.extension}/></div>}{record.questions?.length>0&&<div className="text-xs leading-7 text-slate-400">{record.questions.map(q=><p key={q}>· {q}</p>)}</div>}
        <Citations items={record.citations} onOpen={onOpenCitation}/><button className={button} onClick={()=>void save(record.id)}><Bookmark size={13}/>保存为学习笔记</button></article>)}
    </div>:<div className="flex h-full items-center justify-center text-sm text-slate-500">选择一个知识点，查看解释与来源。</div>}</div></div>
  </section>;
}
