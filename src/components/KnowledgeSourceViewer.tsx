import {useEffect,useRef,useState} from 'react';
import type {SourcePosition} from '../lib/knowledgeTypes';
import {positionLabel} from './KnowledgeCitations';

interface Content {text:string;units:{text:string;position:SourcePosition}[]}
export default function KnowledgeSourceViewer({sourceId,revision,position}:{sourceId:string;revision:number;position:SourcePosition}) {
  const [content,setContent]=useState<Content|null>(null),[error,setError]=useState('');const mark=useRef<HTMLElement|null>(null);
  useEffect(()=>{const controller=new AbortController();setContent(null);setError('');
    fetch(`/api/knowledge/sources/${encodeURIComponent(sourceId)}/content?revision=${revision}`,{signal:controller.signal}).then(async r=>{
      if(!r.ok){
        const detail=await r.json().catch(()=>null);
        throw new Error(r.status===409?(detail?.error==='index_pending'?'文档尚未完成索引，请检查索引任务中的失败原因后重试':'来源已变更，请更新索引并重新提问'):r.status===404?'来源已删除或不可用':'无法读取来源');
      }return r.json();
    }).then(data=>{if(!controller.signal.aborted)setContent(data);}).catch(e=>{if(!controller.signal.aborted)setError(e.message);});return()=>controller.abort();
  },[sourceId,revision]);
  useEffect(()=>{mark.current?.scrollIntoView({block:'center'});},[content]);
  const selected=(p:SourcePosition)=>p.kind===position.kind&&(p.kind==='pdf_page'?p.page===position.page:p.kind==='docx'?p.table===position.table&&p.row===position.row&&(!position.column||p.column===position.column)&&p.paragraph===position.paragraph:p.kind==='message'?p.message_id===position.message_id:(p.start_line||1)<=(position.end_line||position.start_line||1)&&(p.end_line||p.start_line||1)>=(position.start_line||1));
  return <section className="text-sm text-gray-200"><p className="mb-3 text-xs text-gray-400">已导入修订 {revision} · {positionLabel(position)}</p>
    {error?<p role="alert" className="text-amber-300">{error}</p>:!content?<p>读取来源中…</p>:<div className="space-y-2">{content.units.map((unit,i)=><div key={i}>
      <div className="text-[11px] text-gray-500">{positionLabel(unit.position)}</div>
      {selected(unit.position)?<mark ref={el=>{if(el&&!mark.current)mark.current=el;}} className="block bg-emerald-950 text-emerald-100 p-2 whitespace-pre-wrap">{unit.text}</mark>:<pre className="whitespace-pre-wrap text-gray-300 p-2">{unit.text}</pre>}
    </div>)}</div>}
  </section>;
}
