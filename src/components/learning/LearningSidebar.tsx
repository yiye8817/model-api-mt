import {FileText,Search} from 'lucide-react';
import type {LearningDocument,LearningPage} from '../../lib/learningTypes';
import {input,Pager} from './shared';

export const documentStates:Record<string,string>={pending:'待分析',importing:'导入中',analyzing:'分析中',completed:'已完成',needs_update:'需要更新',failed:'失败'};
export default function LearningSidebar({documents,selectedId,selectedIds,onSelect,onToggle,query,onQuery,category,onCategory,categories,page,onPage}:{
  documents:LearningPage<LearningDocument>;selectedId:string|null;selectedIds:string[];onSelect:(id:string)=>void;onToggle:(id:string)=>void;query:string;onQuery:(q:string)=>void;category:string;onCategory:(c:string)=>void;categories:string[];page:number;onPage:(p:number)=>void;
}){
  return <div className="flex min-h-0 flex-1 flex-col">
    <div className="space-y-2 px-4 py-3"><div className="flex items-center gap-2"><Search size={13} className="text-slate-500"/><input aria-label="搜索学习资料" value={query} onChange={e=>onQuery(e.target.value)} placeholder="搜索资料或标签" className={`${input} w-full`}/></div>
      <select aria-label="资料分类" className={`${input} w-full`} value={category} onChange={e=>onCategory(e.target.value)}><option value="">全部分类</option>{categories.map(c=><option key={c}>{c}</option>)}</select>
      <div className="flex justify-between text-[11px] text-slate-500"><span>{documents.total} 份资料</span><span>已选 {selectedIds.length} 份</span></div>
    </div>
    <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2">
      {documents.items.map(doc=><article key={doc.id} className={`flex gap-2 rounded-xl border p-3 ${selectedId===doc.id?'border-emerald-800 bg-emerald-950/40':'border-transparent hover:bg-slate-800/60'}`}>
        <input type="checkbox" aria-label={`选择资料：${doc.title}`} className="mt-1 accent-emerald-500" checked={selectedIds.includes(doc.id)} onChange={()=>onToggle(doc.id)}/>
        <div className="min-w-0 flex-1"><button aria-label={doc.title} className="flex w-full items-start gap-2 text-left text-sm" onClick={()=>onSelect(doc.id)}><FileText size={14} className="mt-0.5 shrink-0 text-emerald-400"/><span className="break-words">{doc.title}</span></button>
          <div className="mt-2 flex flex-wrap gap-2 text-[10px] text-slate-500"><span>{doc.category||'未分类'}</span><span className={doc.status==='failed'?'text-amber-400':doc.status==='completed'?'text-emerald-400':''}>{documentStates[doc.status]||doc.status}</span></div>
        </div>
      </article>)}
      {!documents.items.length&&<p className="px-3 py-8 text-center text-xs leading-6 text-slate-500">还没有匹配的资料。<br/>上传文件或导入网页开始学习。</p>}
    </div>
    <div className="px-3"><Pager page={page} total={documents.total} onChange={onPage}/></div>
  </div>;
}
