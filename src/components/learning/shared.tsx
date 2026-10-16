import type {LearningCitation} from '../../lib/learningTypes';
export const button='inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-slate-200 hover:border-emerald-600 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed';
export const input='min-w-0 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-200 outline-none focus:border-emerald-500';
export function errorMessage(e:unknown){return e instanceof Error?e.message:'操作失败，请重试';}
export function documentWarningMessage(message:string){
  return message==='pdf_tables_require_verified_structure'?'PDF 已按页提取文字；如含表格，行列对应关系请对照原页核对。':message;
}
export function positionLabel(p:Record<string,unknown>){
  if(p.page&&p.kind==='pdf_ocr')return `第 ${p.page} 页 · OCR 行 ${p.start_line||1}–${p.end_line||p.start_line||1}`;
  if(p.page)return `第 ${p.page} 页`;
  if(p.paragraph)return `第 ${p.paragraph} 段`;
  if(p.table)return `表格 ${p.table} · 行 ${p.row||1}`;
  if(p.chunk_index)return `已存片段 ${p.chunk_index}`;
  return `行 ${p.start_line||1}–${p.end_line||p.start_line||1}`;
}
export function Citations({items,onOpen}:{items:LearningCitation[];onOpen:(c:LearningCitation)=>void}){
  return <div className="mt-3 flex flex-wrap gap-2">{items.map((c,i)=><button key={`${c.chunk_id}-${i}`} onClick={()=>onOpen(c)} className="rounded-md border border-emerald-900 bg-emerald-950/40 px-2 py-1 text-left text-xs text-emerald-300" title={c.quote}>[{i+1}] {c.title||'原文'} · {positionLabel(c.position)}</button>)}</div>;
}
export function Pager({page,total,size=30,onChange}:{page:number;total:number;size?:number;onChange:(page:number)=>void}){
  return total>size?<div className="flex items-center justify-between gap-2 py-3 text-xs text-slate-400"><button className={button} disabled={page<=1} onClick={()=>onChange(page-1)}>上一页</button><span>{page} / {Math.ceil(total/size)} · {total} 项</span><button className={button} disabled={page*size>=total} onClick={()=>onChange(page+1)}>下一页</button></div>:null;
}
