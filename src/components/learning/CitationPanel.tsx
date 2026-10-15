import {useEffect,useState} from 'react';
import {X,ExternalLink} from 'lucide-react';
import {learningJson} from '../../lib/learningApi';
import type {LearningCitation,LearningChunk,LearningDocument,LearningPage} from '../../lib/learningTypes';
import {button,errorMessage,positionLabel} from './shared';

export default function CitationPanel({citation,onClose,onOpenUrl}:{citation:LearningCitation;onClose:()=>void;onOpenUrl?:(url:string,title?:string)=>void}){
  const [content,setContent]=useState(''),[url,setUrl]=useState(''),[error,setError]=useState('');
  useEffect(()=>{
    const c=new AbortController();setContent('');setError('');setUrl('');
    void Promise.all([learningJson<LearningPage<LearningChunk>>(`/documents/${citation.document_id}/content?revision=${citation.revision}&chunk_id=${citation.chunk_id}`,undefined,'GET',c.signal),
      learningJson<{document:LearningDocument}>(`/documents/${citation.document_id}`,undefined,'GET',c.signal)]).then(([chunks,doc])=>{
        if(c.signal.aborted)return;setContent(chunks.items[0]?.text||'');
        setUrl(String(doc.document.sources.find(s=>s.locator.url)?.locator.url||''));
      }).catch(e=>{if(!c.signal.aborted)setError(errorMessage(e));});return()=>c.abort();
  },[citation]);
  const index=content.indexOf(citation.quote);
  return <aside role="dialog" aria-label="原文引用" className="absolute bottom-0 right-0 top-0 z-20 flex w-full max-w-lg flex-col border-l border-slate-700 bg-slate-900 shadow-2xl">
    <div className="flex items-start justify-between border-b border-slate-800 p-5"><div><h3 className="text-sm font-medium">{citation.title||'原文引用'}</h3><p className="mt-1 text-xs text-slate-500">修订 {citation.revision} · {positionLabel(citation.position)}</p></div><button aria-label="关闭原文引用" className={button} onClick={onClose}><X size={14}/></button></div>
    {error&&<p role="alert" className="p-5 text-sm text-amber-300">{error}</p>}
    <pre className="flex-1 overflow-auto whitespace-pre-wrap break-words p-5 font-sans text-sm leading-8 text-slate-300">{index>=0?<>{content.slice(0,index)}<mark className="rounded bg-emerald-900 px-0.5 text-emerald-100">{citation.quote}</mark>{content.slice(index+citation.quote.length)}</>:content||'正在读取原文…'}</pre>
    {/^https?:\/\//i.test(url)&&<button className={`${button} m-4`} onClick={()=>onOpenUrl?onOpenUrl(url,citation.title):window.open(url,'_blank','noopener,noreferrer')}><ExternalLink size={13}/>打开来源网页</button>}
  </aside>;
}
