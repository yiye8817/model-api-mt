import {useEffect,useMemo,useState} from 'react';
import {Network,RotateCcw,ArrowUpRight} from 'lucide-react';
import {learningJson} from '../../lib/learningApi';
import type {LearningCitation,LearningGraph,LearningGraphNode,LearningRelation} from '../../lib/learningTypes';
import GraphViewport from './GraphViewport';
import {button,input,Citations,errorMessage} from './shared';
const emptyIds:string[]=[];

export default function KnowledgeGraph({selectedConceptId,onSelectConcept,onOpenDocument,onOpenCitation,onAnalyzePending,selectedIds=emptyIds,currentDocumentId,categories=[],refreshKey=''}:{selectedConceptId?:string|null;onSelectConcept:(id:string)=>void;onOpenDocument:(id:string)=>void;onOpenCitation:(c:LearningCitation)=>void;onAnalyzePending:()=>void;selectedIds?:string[];currentDocumentId?:string;categories?:string[];refreshKey?:string}){
  const [data,setData]=useState<LearningGraph|null>(null),[query,setQuery]=useState(''),[category,setCategory]=useState(''),[range,setRange]=useState('all'),[page,setPage]=useState(1),[focus,setFocus]=useState(selectedConceptId||'');
  const [edge,setEdge]=useState<LearningRelation|null>(null),[node,setNode]=useState<LearningGraphNode|null>(null),[error,setError]=useState('');
  useEffect(()=>{
    const c=new AbortController(),params=new URLSearchParams({q:query,category,page:String(page),page_size:'30'});
    if(focus)params.set('concept_id',focus);const ids=range==='selected'?selectedIds:range==='current'&&currentDocumentId?[currentDocumentId]:[];
    if(ids.length)params.set('document_ids',ids.join(','));
    void learningJson<LearningGraph>('/graph?'+params,undefined,'GET',c.signal).then(r=>{if(!c.signal.aborted){setData(r);setError('');}}).catch(e=>{if(!c.signal.aborted)setError(errorMessage(e));});return()=>c.abort();
  },[query,category,range,page,focus,selectedIds,currentDocumentId,refreshKey]);
  const positions=useMemo(()=>new Map((data?.nodes||[]).map((n,i)=>[n.id,{x:70+(i%4)*230,y:95+Math.floor(i/4)*95}])),[data]);
  const select=(n:LearningGraphNode)=>{setNode(n);if(n.type==='concept'){setFocus(n.id);setPage(1);}else if(n.document_id)onOpenDocument(n.document_id);};
  return <section className="flex h-full min-h-0 flex-col gap-4"><div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="text-lg font-medium">知识图谱</h3><p className="mt-1 text-xs text-slate-500">连接文档与概念，沿着来源探索知识关系。</p></div><button className={button} onClick={onAnalyzePending}>分析待处理资料</button></div>
    <div className="flex flex-wrap items-center gap-2"><input aria-label="搜索知识图谱" value={query} onChange={e=>{setQuery(e.target.value);setPage(1);}} className={`${input} flex-1`} placeholder="搜索文档或知识点"/><select aria-label="图谱分类" className={input} value={category} onChange={e=>{setCategory(e.target.value);setPage(1);}}><option value="">全部分类</option>{categories.map(c=><option key={c}>{c}</option>)}</select>
      <select aria-label="图谱资料范围" className={input} value={range} onChange={e=>{setRange(e.target.value);setPage(1);}}><option value="all">全部资料</option><option value="current" disabled={!currentDocumentId}>当前文档</option><option value="selected" disabled={!selectedIds.length}>已勾选资料</option></select><button className={button} onClick={()=>{setFocus('');setNode(null);setQuery('');setPage(1);}}><RotateCcw size={12}/>查看全图</button></div>
    {error&&<p role="alert" className="text-xs text-amber-300">{error}</p>}
    {data&&<div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-500"><span>已分析 {data.coverage.analyzed} / {data.coverage.total} 份资料</span><span><span className="text-sky-400">■ 文档</span>　<span className="text-emerald-400">● 知识点</span>　{data.total_nodes} 个节点 · {data.total_edges} 条关系</span></div>}
    {data?.nodes.length?<GraphViewport width={1030} height={Math.max(450,Math.ceil(data.nodes.length/4)*95+130)} label="全部文档知识图谱">
      {data.edges.map(e=>{const a=positions.get(e.source),b=positions.get(e.target);return a&&b?<path key={e.id} role="button" tabIndex={0} aria-label={`查看关系：${e.type}`} onClick={()=>setEdge(e)} onPointerDown={event=>event.stopPropagation()} onKeyDown={event=>{if(event.key==='Enter')setEdge(e);}} d={`M${a.x+85},${a.y+20} Q${(a.x+b.x)/2+85},${Math.min(a.y,b.y)-30} ${b.x+85},${b.y+20}`} stroke={edge?.id===e.id?'#34d399':'#334155'} strokeWidth={edge?.id===e.id?3:1.5} fill="none" className="cursor-pointer"><title>{e.type}</title></path>:null;})}
      {data.nodes.map(n=>{const p=positions.get(n.id)!;return <g key={n.id} role="button" tabIndex={0} aria-label={n.label} transform={`translate(${p.x},${p.y})`} onPointerDown={e=>e.stopPropagation()} onClick={()=>select(n)} onKeyDown={e=>{if(e.key==='Enter')select(n);}} className="cursor-pointer"><title>{n.label}</title><rect width={176} height={42} rx={n.type==='document'?6:21} fill={n.type==='document'?'#172b46':'#06392d'} stroke={node?.id===n.id?'#a7f3d0':n.type==='document'?'#38bdf8':'#10b981'}/><text x={88} y={26} fill="#e2e8f0" fontSize={12} textAnchor="middle">{n.label.slice(0,13)}{n.label.length>13?'…':''}</text></g>;})}
    </GraphViewport>:<div className="flex min-h-56 flex-1 flex-col items-center justify-center gap-3 rounded-xl border border-slate-800 text-sm text-slate-500"><Network size={40} className="text-slate-700"/><p>暂无匹配的知识关系，分析资料后可查看图谱。</p></div>}
    {node?.concept_id&&<div className="flex items-center justify-between rounded-lg border border-emerald-900 p-3 text-xs"><span>{node.label} · 已展开邻接关系</span><button className={button} onClick={()=>onSelectConcept(node.concept_id!)}><ArrowUpRight size={12}/>查看知识点详情</button></div>}
    {edge&&<div className="rounded-lg border border-slate-700 p-3"><p className="text-xs text-emerald-300">{edge.type}</p><Citations items={edge.citations} onOpen={onOpenCitation}/></div>}
    {!!data?.edges.length&&<details className="rounded-lg border border-slate-800 p-3" open><summary className="cursor-pointer text-xs text-slate-400">关系列表</summary><div className="mt-3 max-h-40 space-y-2 overflow-auto">{data.edges.map(e=><button key={e.id} className="block w-full rounded-md bg-slate-900 p-2 text-left text-xs text-slate-400 hover:text-emerald-300" onClick={()=>setEdge(e)}>{data.nodes.find(n=>n.id===e.source)?.label||e.source} → <span>{e.type}</span> → {data.nodes.find(n=>n.id===e.target)?.label||e.target}</button>)}</div></details>}
    {data&&Math.max(data.total_edges,data.total_nodes)>30&&<div className="flex justify-between"><button className={button} disabled={page<=1} onClick={()=>setPage(p=>p-1)}>上一页关系</button><span className="self-center text-xs text-slate-500">第 {page} 页</span><button className={button} disabled={page*30>=Math.max(data.total_edges,data.total_nodes)} onClick={()=>setPage(p=>p+1)}>下一页关系</button></div>}
  </section>;
}
