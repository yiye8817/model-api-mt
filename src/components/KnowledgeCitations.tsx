import {useState} from 'react';
import type {Citation,SourcePosition} from '../lib/knowledgeTypes';

export function positionLabel(position:SourcePosition) {
  if(position.kind==='pdf_page')return `第 ${position.page} 页`;
  if(position.kind==='docx')return position.table?`表 ${position.table} · 行 ${position.row}${position.column?` · 列 ${position.column}`:''}`:`段落 ${position.paragraph}`;
  if(position.kind==='message')return '对话消息';
  return `行 ${position.start_line}${position.end_line&&position.end_line!==position.start_line?`–${position.end_line}`:''}`;
}

export default function KnowledgeCitations({citations,onOpen}:{citations:Citation[];onOpen:(c:Citation)=>void}) {
  const [open,setOpen]=useState(false);if(!citations.length)return null;
  return <div className="mt-3 text-xs text-gray-300"><button onClick={()=>setOpen(!open)} className="text-emerald-300">引用来源（{citations.length}）</button>
    {open&&<ul className="mt-2 space-y-2">{citations.map((c,i)=><li key={`${c.chunk_id}-${i}`} className="rounded border border-gray-700 p-2">
      <button onClick={()=>onOpen(c)} className="text-emerald-300 text-left">[{i+1}] {c.title} · {positionLabel(c.position)} · 修订 {c.revision}</button>
      <blockquote className="mt-1 whitespace-pre-wrap text-gray-400">{c.quote}</blockquote>
      {['api_chat','web_chat','web_synthesis'].includes(c.source_kind)&&<p className="text-amber-300">来源为历史模型回答</p>}
    </li>)}</ul>}
  </div>;
}
