import {useEffect,useMemo,useState} from 'react';
import {Send,Square,MessageSquarePlus,Bookmark} from 'lucide-react';
import {learningJson} from '../../lib/learningApi';
import type {LearningCitation,LearningConversation,LearningJob,LearningPage,LearningScope} from '../../lib/learningTypes';
import MarkdownRenderer from '../MarkdownRenderer';
import {button,input,Citations,errorMessage} from './shared';

export default function DocumentQuestions({documentId,documentTitle,selectedIds,jobs,onWatchJob,onOpenCitation}:{documentId:string;documentTitle:string;selectedIds:string[];jobs:LearningJob[];onWatchJob:(id:string)=>void;onOpenCitation:(c:LearningCitation)=>void}){
  const [question,setQuestion]=useState(''),[mode,setMode]=useState('current'),[conversation,setConversation]=useState<LearningConversation|null>(null);
  const [history,setHistory]=useState<LearningConversation[]>([]),[jobId,setJobId]=useState<string|null>(null),[sending,setSending]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const scope=useMemo<LearningScope>(()=>conversation?.scope||(mode==='all'?{mode:'all'}:{mode:'selected',document_ids:mode==='selected'?selectedIds:[documentId]}),[conversation,mode,selectedIds,documentId]);
  const currentJob=jobs.find(j=>j.id===jobId),running=sending||!!currentJob&&['queued','running'].includes(currentJob.status);
  useEffect(()=>{
    const c=new AbortController();
    void learningJson<LearningPage<LearningConversation>>(`/conversations?document_id=${documentId}`,undefined,'GET',c.signal).then(r=>{if(!c.signal.aborted)setHistory(r.items);}).catch(e=>{if(!c.signal.aborted)setError(errorMessage(e));});
    return()=>c.abort();
  },[documentId,currentJob?.status]);
  useEffect(()=>{
    if(!currentJob||!['completed','failed','cancelled'].includes(currentJob.status))return;
    const c=new AbortController();
    if(currentJob.result?.conversation_id)void learningJson<{conversation:LearningConversation}>(`/conversations/${currentJob.result.conversation_id}`,undefined,'GET',c.signal).then(r=>{if(!c.signal.aborted)setConversation(r.conversation);}).catch(e=>{if(!c.signal.aborted)setError(errorMessage(e));});
    if(currentJob.status==='failed')setError(currentJob.error||'问答失败');
    return()=>c.abort();
  },[currentJob?.id,currentJob?.status]);
  const send=async()=>{
    if(!question.trim()||running)return;setSending(true);setError('');setNotice('');
    try{const r=await learningJson<{job:LearningJob}>('/questions',{question,scope,conversation_id:conversation?.id});setJobId(r.job.id);onWatchJob(r.job.id);setQuestion('');}
    catch(e){setError(errorMessage(e));}finally{setSending(false);}
  };
  const loadHistory=async(id:string)=>{try{const r=await learningJson<{conversation:LearningConversation}>(`/conversations/${id}`);setConversation(r.conversation);setJobId(null);setError('');}catch(e){setError(errorMessage(e));}};
  const save=async(id:string,title:string)=>{try{await learningJson('/archives/notes',{title,origin:{kind:'turn',id}});setNotice('已保存到整合归档');}catch(e){setError(errorMessage(e));}};
  return <section className="flex min-h-0 flex-1 flex-col gap-4">
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-800 bg-slate-900/60 p-3">
      <span className="text-xs text-slate-400">提问范围</span><select aria-label="提问范围" className={input} value={conversation?conversation.scope.mode==='all'?'all':conversation.scope.document_ids.length===1?'current':'selected':mode} disabled={running} onChange={e=>{setMode(e.target.value);setConversation(null);setJobId(null);}}>
        <option value="current">当前文档：{documentTitle}</option><option value="selected">已勾选资料（{selectedIds.length} 份）</option><option value="all">全部资料</option></select>
      <button className={button} disabled={running} onClick={()=>{setConversation(null);setJobId(null);setError('');}}><MessageSquarePlus size={13}/>新建问答</button>
      {!!history.length&&<select aria-label="历史文档问答" className={`${input} max-w-52`} value={conversation?.id||''} onChange={e=>{if(e.target.value)void loadHistory(e.target.value);}}><option value="">查看历史问答</option>{history.map(h=><option key={h.id} value={h.id}>{h.title}</option>)}</select>}
    </div>
    {conversation?.needs_update&&<p className="text-xs text-amber-300">资料已更新，历史回答保留原修订。请新建问答继续学习。</p>}
    <div className="min-h-[150px] flex-1 space-y-5 overflow-y-auto">
      {!conversation?.turns.length&&<div className="py-12 text-center text-sm leading-7 text-slate-500">针对资料提出问题，或比较多份文档中的观点。<br/><span className="text-xs">回答中的来源可直接打开对应原文。</span></div>}
      {conversation?.turns.map(turn=><article key={turn.id} className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/40 p-5">
        <h4 className="text-sm font-medium text-emerald-200">{turn.question}</h4><MarkdownRenderer content={turn.answer}/>
        {turn.extension&&<div className="border-l-2 border-amber-700 pl-3 text-sm"><p className="mb-2 text-xs text-amber-300">拓展说明</p><MarkdownRenderer content={turn.extension}/></div>}
        <Citations items={turn.citations} onOpen={onOpenCitation}/><button className={button} onClick={()=>void save(turn.id,turn.question)}><Bookmark size={12}/>保存为学习笔记</button>
      </article>)}
    </div>
    {error&&<p role="alert" className="text-xs text-amber-300">{error}</p>}{notice&&<p role="status" className="text-xs text-emerald-300">{notice}</p>}
    <form className="flex items-end gap-2 rounded-xl border border-slate-700 bg-slate-900 p-3" onSubmit={e=>{e.preventDefault();void send();}}>
      <textarea aria-label="向资料提问" value={question} onChange={e=>setQuestion(e.target.value)} placeholder="向资料提问…" className="min-h-16 flex-1 resize-none bg-transparent p-2 text-sm outline-none" onKeyDown={e=>{if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){e.preventDefault();void send();}}}/>
      {running?<button type="button" className={button} onClick={()=>{if(jobId)void learningJson(`/jobs/${jobId}/cancel`,{}).then(()=>onWatchJob(jobId)).catch(e=>setError(errorMessage(e)));}}><Square size={13}/>停止</button>:<button aria-label="发送问题" className={`${button} border-emerald-700 bg-emerald-900/50`} disabled={!question.trim()||conversation?.needs_update||scope.mode==='selected'&&!scope.document_ids.length}><Send size={14}/>提问</button>}
    </form>
  </section>;
}
