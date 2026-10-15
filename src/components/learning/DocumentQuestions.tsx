import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {Send,Square,MessageSquarePlus,Bookmark,Compass,Search,LoaderCircle} from 'lucide-react';
import {learningJson} from '../../lib/learningApi';
import type {LearningCitation,LearningConversation,LearningJob,LearningPage,LearningQuestionMode,LearningScope} from '../../lib/learningTypes';
import MarkdownRenderer from '../MarkdownRenderer';
import {button,input,Citations,errorMessage} from './shared';

interface Props {
  documentId?:string;documentTitle?:string;selectedIds:string[];jobs:LearningJob[];
  onWatchJob:(id:string)=>void;onOpenCitation:(c:LearningCitation)=>void;
  workspace?:boolean;active?:boolean;
}

function sameIds(a:string[],b:string[]){const sorted=[...b].sort();return a.length===b.length&&[...a].sort().every((id,i)=>id===sorted[i]);}

export default function DocumentQuestions({documentId,documentTitle,selectedIds,jobs,onWatchJob,onOpenCitation,workspace=false,active=true}:Props){
  const [question,setQuestion]=useState(''),[range,setRange]=useState(workspace?'all':'current');
  const [answerMode,setAnswerMode]=useState<LearningQuestionMode>('query');
  const [conversation,setConversation]=useState<LearningConversation|null>(null),[history,setHistory]=useState<LearningConversation[]>([]);
  const [submittedJob,setSubmittedJob]=useState<LearningJob|null>(null),[lockedScope,setLockedScope]=useState<LearningScope|null>(null);
  const [phase,setPhase]=useState<'idle'|'submitting'|'generating'|'loading'>('idle');
  const [pendingQuestion,setPendingQuestion]=useState(''),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [unreadConversation,setUnreadConversation]=useState<string|null>(null);
  const loading=useRef<AbortController|null>(null),lastReadJob=useRef<string|null>(null),log=useRef<HTMLDivElement|null>(null);
  const busy=phase!=='idle';
  const scope=useMemo<LearningScope>(()=>conversation?.scope||lockedScope||(range==='all'?{mode:'all'}:{mode:'selected',document_ids:range==='selected'?[...selectedIds]:documentId?[documentId]:[]}),[conversation,lockedScope,range,selectedIds,documentId]);
  const currentJob=submittedJob?(jobs.find(j=>j.id===submittedJob.id)||submittedJob):undefined;
  const historyPath='/conversations'+(!workspace&&documentId?'?document_id='+encodeURIComponent(documentId):'');
  const scopeValue=!(conversation||lockedScope)?range:scope.mode==='all'?'all':documentId&&sameIds(scope.document_ids,[documentId])?'current':sameIds(scope.document_ids,selectedIds)?'selected':'conversation';
  const inputLabel=workspace?'向知识库提问':'向资料提问';

  useEffect(()=>{
    if(!active)return;
    const controller=new AbortController();
    void learningJson<LearningPage<LearningConversation>>(historyPath,undefined,'GET',controller.signal)
      .then(r=>{if(!controller.signal.aborted)setHistory(Array.isArray(r.items)?r.items:[]);})
      .catch(e=>{if(!controller.signal.aborted)setError(errorMessage(e));});
    return()=>controller.abort();
  },[active,historyPath,currentJob?.status]);
  useEffect(()=>()=>loading.current?.abort(),[]);

  const loadConversation=useCallback(async(id:string,restoreMode=false,jobId?:string)=>{
    loading.current?.abort();
    const controller=new AbortController();loading.current=controller;
    setPhase('loading');setError('');
    try{
      const result=await learningJson<{conversation:LearningConversation}>(`/conversations/${id}`,undefined,'GET',controller.signal);
      if(controller.signal.aborted)return;
      setConversation(result.conversation);setLockedScope(null);setPendingQuestion('');setUnreadConversation(null);
      if(restoreMode)setAnswerMode(result.conversation.turns.at(-1)?.mode||'query');
      if(jobId)lastReadJob.current=jobId;
    }catch(e){
      if(!controller.signal.aborted){setError(errorMessage(e));setUnreadConversation(id);}
    }finally{if(!controller.signal.aborted)setPhase('idle');}
  },[]);

  useEffect(()=>{
    if(!active||!currentJob||!['completed','failed','cancelled'].includes(currentJob.status))return;
    if(currentJob.status==='completed'&&currentJob.result?.conversation_id){
      if(lastReadJob.current!==currentJob.id){
        void loadConversation(currentJob.result.conversation_id,false,currentJob.id);
        const controller=loading.current;
        return()=>controller?.abort();
      }
    }else{
      setPhase('idle');
      if(currentJob.status==='failed')setError(currentJob.error||'问答失败，请重试');
      if(currentJob.status==='cancelled')setNotice('已停止生成，可继续提问。');
    }
  },[active,currentJob?.id,currentJob?.status,currentJob?.result?.conversation_id,loadConversation]);

  useEffect(()=>{log.current?.scrollTo?.({top:log.current.scrollHeight,behavior:'smooth'});},[conversation?.id,conversation?.turns.length,phase]);

  const resetConversation=()=>{
    loading.current?.abort();setConversation(null);setLockedScope(null);setSubmittedJob(null);
    setPendingQuestion('');setUnreadConversation(null);setError('');setNotice('');setPhase('idle');
  };
  const send=async()=>{
    if(!question.trim()||busy||unreadConversation||conversation?.needs_update||scope.mode==='selected'&&!scope.document_ids.length)return;
    const prompt=question.trim(),snapshot:LearningScope=scope.mode==='all'?{mode:'all'}:{mode:'selected',document_ids:[...scope.document_ids]};
    setPhase('submitting');setError('');setNotice('');setLockedScope(snapshot);
    try{
      const result=await learningJson<{job:LearningJob}>('/questions',{question:prompt,scope:snapshot,mode:answerMode,conversation_id:conversation?.id});
      setSubmittedJob({...result.job,status:result.job.status||'queued'});setPendingQuestion(prompt);setQuestion('');setPhase('generating');onWatchJob(result.job.id);
    }catch(e){setError(errorMessage(e));setPhase('idle');if(!conversation)setLockedScope(null);}
  };
  const stop=async()=>{
    if(!submittedJob)return;
    try{const result=await learningJson<{job:LearningJob}>(`/jobs/${submittedJob.id}/cancel`,{});setSubmittedJob(result.job);onWatchJob(submittedJob.id);}
    catch(e){setError(errorMessage(e));}
  };
  const save=async(id:string,title:string)=>{
    try{await learningJson('/archives/notes',{title,origin:{kind:'turn',id}});setNotice('已保存到整合归档');}
    catch(e){setError(errorMessage(e));}
  };

  return <section className={`flex min-h-0 flex-1 flex-col ${workspace?'gap-2':'gap-4'}`}>
    <div className={`flex shrink-0 flex-wrap items-center gap-2 rounded-xl border border-slate-800 bg-slate-900/60 ${workspace?'p-2':'p-3'}`}>
      {workspace&&<div role="group" aria-label="知识对话模式" className="flex rounded-lg bg-slate-950 p-0.5">
        {([{id:'query',label:'知识查询',icon:Search},{id:'explore',label:'深度探索',icon:Compass}] as const).map(item=><button key={item.id} type="button" aria-pressed={answerMode===item.id} disabled={busy} className={`${button} border-transparent ${answerMode===item.id?'bg-emerald-950 text-emerald-300':'bg-transparent text-slate-400'}`} onClick={()=>setAnswerMode(item.id)}><item.icon size={13}/>{item.label}</button>)}
      </div>}
      <select aria-label={workspace?'知识对话资料范围':'提问范围'} className={`${input} max-w-64`} value={scopeValue} disabled={busy} onChange={e=>{if(!busy){resetConversation();setRange(e.target.value);}}}>
        <option value="all">全部资料</option><option value="current" disabled={!documentId}>当前文档{documentTitle?'：'+documentTitle:''}</option>
        <option value="selected" disabled={!selectedIds.length}>已勾选资料（{selectedIds.length} 份）</option>
        {scopeValue==='conversation'&&scope.mode==='selected'&&<option value="conversation">本次对话固定资料（{scope.document_ids.length} 份）</option>}
      </select>
      <button className={button} disabled={busy} onClick={()=>{resetConversation();setQuestion('');}}><MessageSquarePlus size={13}/>{workspace?'新建知识对话':'新建问答'}</button>
      {history.length>0&&<select aria-label={workspace?'历史知识对话':'历史文档问答'} className={`${input} max-w-52`} value={conversation?.id||''} disabled={busy} onChange={e=>{if(e.target.value&&!busy){setSubmittedJob(null);void loadConversation(e.target.value,true);}}}>
        <option value="">查看历史对话</option>{history.map(item=><option key={item.id} value={item.id}>{item.title}</option>)}
      </select>}
    </div>
    {conversation?.needs_update&&<p className="text-xs text-amber-300">资料已更新，历史回答保留原修订。请新建问答继续学习。</p>}
    <div ref={log} role="log" aria-label={workspace?'知识对话记录':'文档问答记录'} className={`flex-1 space-y-3 overflow-y-auto ${workspace?'min-h-0':'min-h-[150px]'}`}>
      {!conversation?.turns.length&&!pendingQuestion&&<div className={`${workspace?'py-3':'py-12'} text-center text-sm leading-7 text-slate-500`}>{workspace?'查询资料、比较观点，或深度探索知识原理。':'针对资料提出问题，或比较多份文档中的观点。'}<br/><span className="text-xs">支持连续追问，点击引用可查看原文。</span></div>}
      {conversation?.turns.map(turn=><article key={turn.id} className={`space-y-3 rounded-xl border border-slate-800 bg-slate-900/40 ${workspace?'p-3':'p-5'}`}>
        <div className="flex items-start justify-between gap-3"><h4 className="text-sm font-medium text-emerald-200">{turn.question}</h4>{workspace&&<span className="shrink-0 text-[10px] text-slate-500">{turn.mode==='explore'?'深度探索':'知识查询'}</span>}</div>
        <MarkdownRenderer content={turn.answer}/>
        {turn.extension&&<div className="border-l-2 border-amber-700 pl-3 text-sm"><p className="mb-2 text-xs text-amber-300">拓展说明</p><MarkdownRenderer content={turn.extension}/></div>}
        <Citations items={turn.citations} onOpen={onOpenCitation}/><button className={button} onClick={()=>void save(turn.id,turn.question)}><Bookmark size={12}/>保存为学习笔记</button>
      </article>)}
      {pendingQuestion&&<div className="rounded-lg border border-emerald-900/50 bg-emerald-950/20 px-3 py-2 text-sm text-emerald-200">{pendingQuestion}</div>}
      {busy&&<p role="status" className="flex items-center gap-2 px-1 text-xs text-slate-400"><LoaderCircle size={13} className="animate-spin"/>{phase==='loading'?'正在载入回答…':phase==='submitting'?'正在提交问题…':currentJob?.message||(answerMode==='explore'?'正在深度探索所选资料…':'正在查询所选资料…')}</p>}
    </div>
    {error&&<p role="alert" className="text-xs text-amber-300">{error}</p>}
    {unreadConversation&&<button className={`${button} self-start`} disabled={busy} onClick={()=>void loadConversation(unreadConversation,false,submittedJob?.id)}>重新加载回答</button>}
    {notice&&<p role="status" className="text-xs text-emerald-300">{notice}</p>}
    <form className={`flex shrink-0 items-end gap-2 rounded-xl border border-slate-700 bg-slate-900 ${workspace?'p-2':'p-3'}`} onSubmit={e=>{e.preventDefault();void send();}}>
      <textarea aria-label={inputLabel} value={question} onChange={e=>setQuestion(e.target.value)} placeholder={workspace?'输入知识问题，Ctrl / ⌘ + Enter 发送…':'向资料提问…'} className={`${workspace?'min-h-12':'min-h-16'} max-h-28 flex-1 resize-none bg-transparent p-2 text-sm outline-none`} onKeyDown={e=>{if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)&&!e.nativeEvent.isComposing){e.preventDefault();void send();}}}/>
      {phase==='generating'?<button type="button" className={button} onClick={()=>void stop()}><Square size={13}/>停止</button>:<button aria-label="发送问题" className={`${button} border-emerald-700 bg-emerald-900/50`} disabled={busy||!question.trim()||Boolean(unreadConversation)||conversation?.needs_update||scope.mode==='selected'&&!scope.document_ids.length}><Send size={14}/>{answerMode==='explore'?'探索':'提问'}</button>}
    </form>
  </section>;
}
