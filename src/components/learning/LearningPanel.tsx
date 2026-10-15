import {useCallback,useEffect,useRef,useState} from 'react';
import {Library,RefreshCw,BookOpen,Network,Lightbulb,Archive,Square} from 'lucide-react';
import {learningJson} from '../../lib/learningApi';
import {useLearningJobs} from '../../hooks/useLearningJobs';
import type {LearningCitation,LearningDocument,LearningJob,LearningPage,LearningStatus,LearningScope} from '../../lib/learningTypes';
import ImportSources from './ImportSources';
import LearningSidebar from './LearningSidebar';
import DocumentStudy from './DocumentStudy';
import CitationPanel from './CitationPanel';
import ConceptExplorer from './ConceptExplorer';
import KnowledgeGraph from './KnowledgeGraph';
import ArchiveView from './ArchiveView';
import LearningChatDock from './LearningChatDock';
import {button,errorMessage} from './shared';

const empty:LearningPage<LearningDocument>={items:[],total:0,page:1,page_size:30};
export default function LearningPanel({active,onOpenUrl}:{active:boolean;onOpenUrl?:(url:string,title?:string)=>void}){
  const [documents,setDocuments]=useState(empty),[status,setStatus]=useState<LearningStatus|null>(null),[selected,setSelected]=useState<LearningDocument|null>(null),[selectedIds,setSelectedIds]=useState<string[]>([]);
  const [query,setQuery]=useState(''),[category,setCategory]=useState(''),[page,setPage]=useState(1),[view,setView]=useState('study'),[error,setError]=useState(''),[citation,setCitation]=useState<LearningCitation|null>(null);
  const {jobs,watch,cancel,error:jobError}=useLearningJobs(active);const requestId=useRef(0),synced=useRef(false);
  const [focusedConcept,setFocusedConcept]=useState<string|null>(null);
  const refresh=useCallback(async(sync=false)=>{
    const id=++requestId.current;setError('');
    try{
      if(sync){const r=await learningJson<{errors?:{error:string}[]}>('/sync',{});if(r.errors?.length)setError(r.errors.map(e=>e.error).join('；'));}
      const [list,nextStatus]=await Promise.all([learningJson<LearningPage<LearningDocument>>(`/documents?q=${encodeURIComponent(query)}&category=${encodeURIComponent(category)}&page=${page}`),learningJson<LearningStatus>('/status')]);
      if(id!==requestId.current)return;setDocuments(list);setStatus(nextStatus);
      setSelected(old=>old?list.items.find(d=>d.id===old.id)||old:list.items[0]||null);
    }catch(e){if(id===requestId.current)setError(errorMessage(e));}
  },[query,category,page]);
  useEffect(()=>{if(active){const shouldSync=!synced.current;synced.current=true;void refresh(shouldSync);}},[active,refresh]);
  const terminal=jobs.filter(j=>['completed','failed','cancelled'].includes(j.status)).map(j=>j.id+':'+j.status).sort().join('|');
  useEffect(()=>{if(active&&terminal)void refresh();},[terminal,active,refresh]);
  const onRefresh=()=>void refresh();
  const analyzeAll=async()=>{try{const r=await learningJson<{job:LearningJob}>('/analyze',{scope:{mode:'all'}});(r.job.job_ids||[r.job.id]).forEach(watch);void refresh();}catch(e){setError(errorMessage(e));}};
  const scope:LearningScope=selectedIds.length?{mode:'selected',document_ids:selectedIds}:selected?{mode:'selected',document_ids:[selected.id]}:{mode:'all'};
  const openDocument=async(id:string,conceptId?:string)=>{
    try{const r=await learningJson<{document:LearningDocument}>(`/documents/${id}`);setSelected(r.document);setFocusedConcept(conceptId||null);setView('study');}
    catch(e){setError(errorMessage(e));}
  };
  const openConcept=(id:string)=>{setFocusedConcept(id);setView('concepts');};
  const workspace=view==='concepts'?<ConceptExplorer selectedConceptId={focusedConcept} selectedIds={selectedIds} currentDocumentId={selected?.id} categories={status?.categories||[]} onSelectConcept={setFocusedConcept} onOpenDocument={(id,cid)=>void openDocument(id,cid)} onOpenCitation={setCitation} onWatchJob={watch} refreshKey={terminal}/>
    :view==='graph'?<KnowledgeGraph selectedConceptId={focusedConcept} selectedIds={selectedIds} currentDocumentId={selected?.id} categories={status?.categories||[]} onSelectConcept={openConcept} onOpenDocument={id=>void openDocument(id)} onOpenCitation={setCitation} onAnalyzePending={()=>void analyzeAll()} refreshKey={terminal}/>
    :view==='archives'?<ArchiveView scope={scope} onOpenDocument={id=>void openDocument(id)} onOpenCitation={setCitation} onWatchJob={watch} refreshKey={terminal}/>
    :selected?<DocumentStudy key={selected.id} document={selected} jobs={jobs} selectedIds={selectedIds} onWatchJob={watch} onRefresh={onRefresh} onRemoved={()=>{setSelected(null);setSelectedIds(ids=>ids.filter(id=>id!==selected.id));void refresh();}} onOpenCitation={setCitation} selectedConceptId={focusedConcept}/>
    :<div className="flex h-full flex-col items-center justify-center gap-4 text-sm text-slate-500"><Library size={44} className="text-slate-700"/><p>导入资料，开始建立你的知识库。</p></div>;
  const views=[{id:'study',name:'文档学习',icon:BookOpen},{id:'concepts',name:'全部知识点',icon:Lightbulb},{id:'graph',name:'知识图谱',icon:Network},{id:'archives',name:'整合归档',icon:Archive}];
  return <div className="relative flex h-full min-h-0 flex-col bg-[#0c1220] text-slate-200">
    <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-slate-800 px-5 py-4"><div className="flex items-center gap-3"><div className="rounded-xl border border-emerald-800 bg-emerald-950 p-2.5"><Library size={20} className="text-emerald-400"/></div><div><h2 className="text-base font-medium">知识学习</h2><p className="mt-0.5 text-[11px] text-slate-500">Hermes · 资料分析与知识整合</p></div></div>
      <div className="flex items-center gap-4 text-xs text-slate-400"><span>{status?.documents||0} 份资料</span><span>{status?.concepts||0} 个知识点</span><span className={status?.hermes.available?'text-emerald-400':'text-amber-400'}>{status?.hermes.available?'Hermes 已就绪':'Hermes 未配置'}</span><button aria-label="刷新学习资料" className={button} onClick={()=>void refresh(true)}><RefreshCw size={13}/></button></div>
    </header>
    <div className="flex min-h-0 flex-1"><aside className="flex w-64 shrink-0 flex-col border-r border-slate-800 bg-slate-900/30"><ImportSources onWatchJob={watch} onImported={onRefresh}/><LearningSidebar documents={documents} selectedId={selected?.id||null} selectedIds={selectedIds}
      onSelect={id=>{setSelected(documents.items.find(d=>d.id===id)||null);setFocusedConcept(null);setView('study');}} onToggle={id=>setSelectedIds(ids=>ids.includes(id)?ids.filter(i=>i!==id):[...ids,id])}
      query={query} onQuery={q=>{setQuery(q);setPage(1);}} category={category} onCategory={c=>{setCategory(c);setPage(1);}} categories={status?.categories||[]} page={page} onPage={setPage}/></aside>
      <main className="flex min-h-0 min-w-0 flex-1 flex-col"><nav className="flex shrink-0 gap-1 overflow-x-auto border-b border-slate-800 px-4 py-3">{views.map(v=><button key={v.id} className={`${button} whitespace-nowrap ${view===v.id?'border-emerald-800 bg-emerald-950/50 text-emerald-300':'border-transparent bg-transparent text-slate-400'}`} onClick={()=>setView(v.id)}><v.icon size={14}/>{v.name}</button>)}</nav>
        {(error||jobError)&&<p role="alert" className="border-b border-amber-900/40 bg-amber-950/20 px-5 py-3 text-xs text-amber-300">{error||jobError}</p>}
        <div className="min-h-0 flex-1 overflow-auto p-5">{workspace}</div>
        <LearningChatDock active={active} documentId={selected?.id} documentTitle={selected?.title} selectedIds={selectedIds} jobs={jobs} onWatchJob={watch} onOpenCitation={setCitation}/>
      </main>
    </div>
    {jobs.length>0&&<div className="max-h-32 shrink-0 overflow-auto border-t border-slate-800 bg-slate-900 px-4 py-2">{jobs.slice(0,4).map(j=><div key={j.id} className="flex items-center gap-3 py-1 text-[11px]"><span className={j.status==='failed'?'text-amber-400':j.status==='completed'?'text-emerald-400':'text-slate-400'}>{j.status==='completed'?'已完成':j.status==='failed'?'失败':j.status==='cancelled'?'已取消':j.message||'处理中'}</span>{j.total>0&&<span className="text-slate-500">{j.processed}/{j.total} 个片段</span>}<span className="min-w-0 flex-1 truncate text-amber-300">{j.error}</span>{['queued','running'].includes(j.status)&&<button aria-label="停止学习任务" className={button} onClick={()=>void cancel(j.id).catch(e=>setError(errorMessage(e)))}><Square size={11}/></button>}</div>)}</div>}
    {citation&&<CitationPanel citation={citation} onClose={()=>setCitation(null)} onOpenUrl={onOpenUrl}/>}
  </div>;
}
