import {useCallback,useEffect,useRef,useState} from 'react';
import type {Citation,KnowledgeSource,JobSnapshot} from '../lib/knowledgeTypes';
import {knowledgeJson,uploadKnowledgeFiles,cancelKnowledge} from '../lib/knowledgeApi';
import {useKnowledgeJobs} from '../hooks/useKnowledgeJobs';
import DirPicker from './DirPicker';

const button='rounded border border-gray-600 bg-gray-800 px-3 py-2 text-xs hover:bg-gray-700 disabled:opacity-40';
export default function KnowledgePanel({onOpenCitation}:{onOpenCitation:(c:Citation)=>void}) {
  const [sources,setSources]=useState<KnowledgeSource[]>([]),[query,setQuery]=useState(''),[path,setPath]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [jobId,setJobId]=useState<string|null>(null),[picker,setPicker]=useState<'file'|'directory'|null>(null),[encoding,setEncoding]=useState('');
  const [calibration,setCalibration]=useState(''),[validation,setValidation]=useState(''),[evaluationUpload,setEvaluationUpload]=useState(false),[reviewed,setReviewed]=useState(false);
  const [previewQuestion,setPreviewQuestion]=useState(''),[previewCandidates,setPreviewCandidates]=useState<(Citation&{score:number})[]>([]),[previewBusy,setPreviewBusy]=useState(false);
  const activePreview=useRef<{id:string;controller:AbortController}|null>(null);
  const folderInput=useRef<HTMLInputElement|null>(null);const {job,jobs,error:jobError,cancel}=useKnowledgeJobs(jobId);const visibleJob=job||jobs[0]||null;
  useEffect(()=>{folderInput.current?.setAttribute('webkitdirectory','');},[]);
  useEffect(()=>()=>{const run=activePreview.current;if(run){run.controller.abort();void cancelKnowledge(run.id).catch(()=>{});}},[]);
  const preview=async()=>{
    const id=crypto.randomUUID(),controller=new AbortController();activePreview.current={id,controller};setPreviewBusy(true);setError('');setPreviewCandidates([]);
    try{
      const r=await fetch('/api/knowledge/preview',{method:'POST',headers:{'Content-Type':'application/json'},signal:controller.signal,
        body:JSON.stringify({request_id:id,question:previewQuestion,context:[],system_constraints:'',source_ids:[],mode:'api',online_target:null,parameters:{}})});
      const data=await r.json();if(!r.ok)throw new Error(data.error||'无法预览检索结果');if(!controller.signal.aborted)setPreviewCandidates(data.candidates);
    }catch(e){if(!controller.signal.aborted)setError(e instanceof Error?e.message:'检索失败');}finally{if(activePreview.current?.id===id){activePreview.current=null;setPreviewBusy(false);}}
  };
  const refresh=useCallback(async()=>{try{const r=await knowledgeJson<{sources:KnowledgeSource[]}>(`/api/knowledge/sources?q=${encodeURIComponent(query)}`);setSources(r.sources);}catch(e){setError(e instanceof Error?e.message:'资料加载失败');}},[query]);
  useEffect(()=>{void refresh();},[refresh]);
  useEffect(()=>{if(job&&['done','failed','cancelled','waiting_index'].includes(job.status))void refresh();},[job?.status,refresh]);
  const action=async(callback:()=>Promise<unknown>)=>{setBusy(true);setError('');try{await callback();await refresh();}catch(e){setError(e instanceof Error?e.message:'操作失败');}finally{setBusy(false);}};
  const importPath=async(value:string)=>{if('Notification' in window&&Notification.permission==='default')void Notification.requestPermission();const r=await knowledgeJson<{job_id:string}>('/api/knowledge/import',{kind:'paths',roots:[value],encoding:encoding||undefined});setJobId(r.job_id);};
  const filesSelected=(files:FileList|null)=>{if(!files?.length)return;if('Notification' in window&&Notification.permission==='default')void Notification.requestPermission();void action(async()=>{await uploadKnowledgeFiles(Array.from(files),setJobId,evaluationUpload?'evaluation':'knowledge',encoding);});};
  const datasetSources=sources.filter(s=>s.status==='evaluation_dataset');
  const activate=async()=>{
    const result=await knowledgeJson<{evaluation_profile_id:string}>('/api/knowledge/evaluate',{operation:'activate',report_id:jobId,reviewed:true});
    await knowledgeJson('/api/settings',{local_knowledge:{evaluation_profile_id:result.evaluation_profile_id}});
    window.dispatchEvent(new Event('knowledge-settings-updated'));
  };
  const open=(source:KnowledgeSource)=>onOpenCitation({source_id:source.id,source_kind:source.kind,title:source.title,chunk_id:'',revision:source.revision,locator:source.locator,
    position:source.locator.kind==='web'||source.locator.kind==='chat'?{kind:'message',message_id:String(source.locator.assistant_message_id||'')}:{kind:'lines',start_line:1,end_line:1},quote:''});
  return <section className="space-y-4 text-sm text-gray-200">
    <p className="text-xs text-gray-400">管理已导入资料。删除操作清理索引和导入副本，原始文档保留。</p>
    {error&&<p role="alert" className="text-amber-300">{error}</p>}
    <div className="flex flex-wrap gap-2">
      <button className={button} disabled={busy} onClick={()=>setPicker('file')}>选择文档</button><button className={button} disabled={busy} onClick={()=>setPicker('directory')}>选择目录</button>
      <button className={button} disabled={busy} onClick={()=>void action(async()=>{const r=await knowledgeJson<{job_id:string}>('/api/knowledge/import',{kind:'api_chats',conversation_ids:[]});setJobId(r.job_id);})}>导入已有对话</button>
      <button className={button} onClick={()=>void refresh()}>刷新资料</button>
    </div>
    <div className="flex gap-2"><input aria-label="后端文档或目录路径" value={path} onChange={e=>setPath(e.target.value)} placeholder="后端本机文件或目录路径" className="flex-1 rounded bg-gray-950 border border-gray-700 p-2"/>
      <button className={button} disabled={busy||!path.trim()} onClick={()=>void action(()=>importPath(path.trim()))}>导入路径</button></div>
    <div className="flex flex-wrap gap-3 items-center text-xs">
      <label>文本编码<select className="ml-2 bg-gray-800 p-1 border border-gray-600 rounded" value={encoding} onChange={e=>setEncoding(e.target.value)}><option value="">自动识别</option><option value="utf-8">UTF-8</option><option value="gb18030">GB18030 / GBK</option><option value="utf-16">UTF-16</option></select></label>
      <label><input type="checkbox" checked={evaluationUpload} onChange={e=>setEvaluationUpload(e.target.checked)}/>上传评测数据（JSONL）</label>
      <label className={button}>上传文件<input aria-label="上传知识文件" type="file" multiple className="hidden" onChange={e=>{filesSelected(e.target.files);e.target.value='';}}/></label>
      <label className={button}>上传目录<input aria-label="上传知识目录" ref={folderInput} type="file" multiple className="hidden" onChange={e=>{filesSelected(e.target.files);e.target.value='';}}/></label>
    </div>
    {jobId||jobs.length>0 ? <JobView job={visibleJob} error={jobError} cancel={cancel}/> : null}
    <input aria-label="搜索资料来源" value={query} onChange={e=>setQuery(e.target.value)} placeholder="搜索资料来源" className="w-full bg-gray-950 border border-gray-700 p-2 rounded"/>
    <div className="space-y-2">{sources.map(source=><article key={source.id} className="border border-gray-700 rounded p-3">
      <div className="flex gap-2 items-start"><label><input type="checkbox" aria-label={`参与检索：${source.title}`} checked={source.enabled} onChange={e=>void action(()=>knowledgeJson(`/api/knowledge/sources/${source.id}`,{enabled:e.target.checked},'PATCH'))}/></label>
        <button className="text-emerald-300 text-left flex-1" onClick={()=>open(source)}>{source.title}</button><span className="text-xs text-gray-400">修订 {source.revision} · {source.status}</span></div>
      <div className="mt-2 text-xs text-gray-400">{source.kind}{source.nature==='historical_model_answer'?' · 历史模型回答':''}{!source.context_complete?' · 上下文或完成状态不完整，仅供参考':''}</div>
      <div className="mt-2 flex gap-2"><button className={button} aria-label={`更新索引：${source.title}`} disabled={busy} onClick={()=>void action(async()=>{const r=await knowledgeJson<{job_id:string}>(`/api/knowledge/sources/${source.id}/refresh`,{});setJobId(r.job_id);})}>更新索引</button>
        <button className={button} aria-label={`删除资料：${source.title}`} disabled={busy} onClick={()=>void action(()=>knowledgeJson(`/api/knowledge/sources/${source.id}`,undefined,'DELETE'))}>删除</button></div>
    </article>)}</div>
    {!sources.length&&<p className="text-gray-500">还没有导入资料。</p>}
    <fieldset className="border border-gray-700 rounded p-3 space-y-2"><legend className="text-emerald-300 px-1">检索预览</legend><p className="text-xs text-gray-400">可在模型校准前查看相关片段，片段仍需核对。</p>
      <div className="flex gap-2"><input aria-label="检索预览问题" value={previewQuestion} onChange={e=>setPreviewQuestion(e.target.value)} className="flex-1 bg-gray-950 p-2 rounded border border-gray-700" placeholder="输入检索问题"/>
        <button className={button} disabled={previewBusy||!previewQuestion.trim()} onClick={()=>void preview()}>预览相关片段</button>{previewBusy&&<button className={button} onClick={()=>{const run=activePreview.current;if(run){run.controller.abort();void cancelKnowledge(run.id).catch(()=>{});}}}>停止检索</button>}</div>
      {previewCandidates.map((candidate,i)=><article className="border-t border-gray-700 py-2" key={`${candidate.chunk_id}-${i}`}><button className="text-emerald-300" onClick={()=>onOpenCitation(candidate)}>{candidate.title}</button><pre className="text-xs whitespace-pre-wrap mt-1">{candidate.quote}</pre><details className="text-xs text-gray-500"><summary>诊断详情</summary>相关性分数：{candidate.score}</details></article>)}
    </fieldset>
    <fieldset className="border border-gray-700 p-3 rounded space-y-2"><legend className="px-1 text-emerald-300">本地模型精度评测</legend>
      <p className="text-xs text-gray-400">先导入评测资料，再以“评测数据”用途上传独立的校准集和验证集。每组至少 30 题，真实端点评测和人工复核通过后才可激活。</p>
      <label className="block text-xs">校准集<select aria-label="校准集" value={calibration} onChange={e=>setCalibration(e.target.value)} className="ml-2 bg-gray-900 border border-gray-600 p-1 rounded"><option value="">请选择</option>{datasetSources.map(s=><option value={s.id} key={s.id}>{s.title}</option>)}</select></label>
      <label className="block text-xs">验证集<select aria-label="验证集" value={validation} onChange={e=>setValidation(e.target.value)} className="ml-2 bg-gray-900 border border-gray-600 p-1 rounded"><option value="">请选择</option>{datasetSources.map(s=><option value={s.id} key={s.id}>{s.title}</option>)}</select></label>
      <button className={button} disabled={busy||!calibration||!validation||calibration===validation} onClick={()=>void action(async()=>{setReviewed(false);const r=await knowledgeJson<{job_id:string}>('/api/knowledge/evaluate',{operation:'run',calibration_source_id:calibration,validation_source_id:validation});setJobId(r.job_id);})}>运行本地评测</button>
      {job?.kind==='evaluation'&&job.result&&<><details><summary>逐题评测结果与引用</summary><pre className="text-xs whitespace-pre-wrap max-h-80 overflow-auto">{JSON.stringify(job.result,null,2)}</pre></details>
        <label className="block text-xs"><input type="checkbox" checked={reviewed} onChange={e=>setReviewed(e.target.checked)}/>已逐题核对标准答案和引用支持</label>
        <button className={button} disabled={!reviewed||job.result.passed!==true||job.result.real_models!==true} onClick={()=>void action(activate)}>激活通过的配置</button></>}
    </fieldset>
    {picker&&<DirPicker initialDir="" selectionMode={picker} title={picker==='file'?'选择后端文档':'选择后端目录'} onClose={()=>setPicker(null)} onSelect={value=>{setPicker(null);setPath(value);void action(()=>importPath(value));}}/>}
  </section>;
}

function JobView({job,error,cancel}:{job:JobSnapshot|null;error:string|null;cancel:()=>Promise<void>}) {
  const stages=['queued','scanning','parsing','chunking','embedding','committing','done'];const active=job?.stage||job?.phase||'queued';const percent=typeof job?.percent==='number'?job.percent:job&&job.total?job.completed/job.total*100:0;
  return <div className="border border-gray-700 rounded p-3 text-xs space-y-2"><div className="flex justify-between gap-3"><p>{job?`${job.current_item||'等待处理'} · ${job.completed}/${job.total} 项 · 成功 ${job.succeeded} · 跳过 ${job.skipped} · 失败 ${job.failed}`:'正在读取任务…'}</p><strong>{percent.toFixed(1)}%</strong></div>
    {job&&<><div className="h-2 rounded bg-gray-800 overflow-hidden"><div className={`h-full ${job.status==='failed'?'bg-red-500':job.status==='done'?'bg-emerald-500':'bg-cyan-500'} transition-all`} style={{width:`${Math.min(100,Math.max(0,percent))}%`}} /></div><div className="flex flex-wrap gap-1">{stages.map(stage=><span key={stage} className={`rounded px-1.5 py-0.5 ${stage===active?'bg-cyan-900 text-cyan-200':stages.indexOf(stage)<stages.indexOf(active)?'bg-gray-700 text-gray-300':'bg-gray-900 text-gray-600'}`}>{stage}</span>)}</div><p className="text-gray-400">{job.bytes_completed||0}/{job.bytes_total||0} bytes · {job.chunks_completed||0}/{job.chunks_total||0} chunks · {job.batches_completed||0}/{job.batches_total||0} batches{job.eta_seconds?` · 预计剩余 ${job.eta_seconds.toFixed(0)} 秒`:''}</p></>}
    {error&&<p className="text-amber-300">{error}</p>}{job&&!['done','failed','cancelled'].includes(job.status)&&<button className={`${button} mt-2`} onClick={()=>void cancel()}>停止索引任务</button>}
    {job&&job.items?.length>0&&<details className="mt-2"><summary>逐项结果（{job.items.length}）</summary><ul className="mt-2 space-y-1 max-h-48 overflow-auto">{job.items.map((item,i)=><li key={i}>{item.path||item.source_id} · {item.status}{item.chunks?` · ${item.chunks} chunks`:''} {item.reason}</li>)}</ul></details>}
    {(job?.last_error||job?.status==='failed'&&Boolean(job.result?.error))&&<p className="mt-2 text-amber-300">{job.last_error||String(job?.result?.error||'任务失败')}</p>}
  </div>;
}
