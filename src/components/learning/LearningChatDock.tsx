import {useId,useState} from 'react';
import {MessagesSquare,ChevronDown,ChevronUp} from 'lucide-react';
import type {LearningCitation,LearningJob} from '../../lib/learningTypes';
import DocumentQuestions from './DocumentQuestions';

export default function LearningChatDock({active,documentId,documentTitle,selectedIds,jobs,onWatchJob,onOpenCitation}:{
  active:boolean;documentId?:string;documentTitle?:string;selectedIds:string[];jobs:LearningJob[];
  onWatchJob:(id:string)=>void;onOpenCitation:(citation:LearningCitation)=>void;
}){
  const [collapsed,setCollapsed]=useState(false),bodyId=useId();
  return <section aria-label="知识对话" className="shrink-0 border-t border-emerald-900/50 bg-[#0d1727]">
    <button type="button" aria-label={collapsed?'展开知识对话':'收起知识对话'} aria-expanded={!collapsed} aria-controls={bodyId} onClick={()=>setCollapsed(value=>!value)} className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-xs text-slate-300 hover:bg-slate-900/60">
      <MessagesSquare size={15} className="text-emerald-400"/><span className="font-medium text-emerald-200">知识对话</span><span className="text-[10px] text-slate-500">知识查询 · 深度探索</span><span className="ml-auto text-[10px] text-slate-500">Hermes</span>{collapsed?<ChevronUp size={14}/>:<ChevronDown size={14}/>}
    </button>
    <div id={bodyId} hidden={collapsed}>
      <div className="flex min-h-0 flex-col px-3 pb-3" style={{height:'clamp(260px, 38vh, 400px)'}}>
        <DocumentQuestions workspace active={active} documentId={documentId} documentTitle={documentTitle} selectedIds={selectedIds} jobs={jobs} onWatchJob={onWatchJob} onOpenCitation={onOpenCitation}/>
      </div>
    </div>
  </section>;
}
