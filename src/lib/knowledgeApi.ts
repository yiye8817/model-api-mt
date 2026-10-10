import type { CompletedTurn, KnowledgeQueryRequest, KnowledgeQueryResult } from './knowledgeTypes';

export async function knowledgeJson<T>(url:string,body?:unknown,method=body===undefined?'GET':'POST'):Promise<T> {
  const response=await fetch(url,{method,headers:body===undefined?undefined:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  const data=await response.json();if(!response.ok)throw new KnowledgeHttpError(response.status,data.error||'本地知识操作失败');return data as T;
}

export async function uploadKnowledgeFiles(files:File[],onJobId:(id:string)=>void,purpose='knowledge',encoding=''):Promise<string> {
  const rejected_items:{path:string;status:string;reason:string}[]=[];
  const accepted=files.filter((file,index)=>{
    const reason=index>=2000?'file_count_limit':file.size>20*1024*1024?'file_too_large':null;
    if(reason){rejected_items.push({path:file.webkitRelativePath||file.name,status:'failed',reason});return false;}return true;
  });
  const {job_id}=await knowledgeJson<{job_id:string}>('/api/knowledge/import',{kind:'upload',purpose,rejected_items});onJobId(job_id);
  const batches:File[][]=[];let batch:File[]=[],size=0;
  for(const file of accepted){if(size+file.size>40*1024*1024&&batch.length){batches.push(batch);batch=[];size=0;}batch.push(file);size+=file.size;}if(batch.length)batches.push(batch);
  const send=async(group:File[],id:string,final:boolean)=>{
    const data=new FormData();data.set('job_id',job_id);data.set('batch_id',id);data.set('final',String(final));data.set('encoding',encoding);
    data.set('relative_paths',JSON.stringify(group.map(f=>f.webkitRelativePath||f.name)));for(const f of group)data.append('files',f,f.name);
    const r=await fetch('/api/knowledge/upload',{method:'POST',body:data});
    if(r.status===413&&group.length>1){for(let i=0;i<group.length;i++)await send([group[i]],`${id}-small-${i}`,final&&i===group.length-1);return;}
    if(!r.ok){const result=await r.json().catch(()=>({}));throw new KnowledgeHttpError(r.status,result.error||'上传失败，可选择较小批次重试');}
  };
  if(!batches.length)await send([],`${job_id}-empty`,true);
  for(let i=0;i<batches.length;i++)await send(batches[i],`${job_id}-${i}`,i===batches.length-1);
  return job_id;
}

export class KnowledgeHttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function queryKnowledge(request: KnowledgeQueryRequest, signal: AbortSignal): Promise<KnowledgeQueryResult> {
  const response=await fetch('/api/knowledge/query',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request),signal});
  if(!response.ok)throw new KnowledgeHttpError(response.status,'本地知识请求失败');
  const result=await response.json() as KnowledgeQueryResult;
  if(result.request_id!==request.request_id||!['hit','miss','cancelled'].includes(result.decision)||!Array.isArray(result.citations)||!Array.isArray(result.trace))
    throw new KnowledgeHttpError(502,'本地知识返回格式无效');
  if(result.decision==='hit'&&(!result.answer?.trim()||result.citations.length===0))throw new KnowledgeHttpError(502,'本地答案缺少证据');
  if(result.decision!=='hit'){result.answer=null;result.citations=[];}
  return result;
}

export async function querySavedAnswer(request: KnowledgeQueryRequest, signal: AbortSignal): Promise<KnowledgeQueryResult> {
  const response=await fetch('/api/content-library/reuse',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request),signal});
  if(!response.ok)throw new KnowledgeHttpError(response.status,'已保存问答检索失败');
  const result=await response.json() as KnowledgeQueryResult;
  if(result.request_id!==request.request_id||!['hit','miss','cancelled'].includes(result.decision)||!Array.isArray(result.trace)||!Array.isArray(result.citations))
    throw new KnowledgeHttpError(502,'已保存问答返回格式无效');
  if(result.decision==='hit'&&(!result.answer?.trim()||result.answer_origin!=='saved_answer'||!result.saved_entry?.id))
    throw new KnowledgeHttpError(502,'已保存回答缺少来源');
  return result;
}

export async function cancelKnowledge(requestId: string): Promise<void> {
  await fetch(`/api/knowledge/query/${encodeURIComponent(requestId)}/cancel`,{method:'POST'});
}

export async function recordKnowledge(turn: CompletedTurn, onlineCalls?: {call_id:string;kind:string;model:string}[]): Promise<void> {
  if(turn.completion.kind==='local'||turn.completion.kind==='workflow')return;
  const response=await fetch('/api/knowledge/record',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({turn,online_calls:onlineCalls||[]})});
  if(!response.ok)throw new KnowledgeHttpError(response.status,'问答资料记录失败');
}

export async function recordKnowledgeOnlineCall(requestId:string,callId:string,model='unknown'):Promise<void> {
  await knowledgeJson('/api/knowledge/record',{request_id:requestId,online_calls:[{call_id:callId,kind:'web',model}]});
}

function canonical(value:unknown):unknown {
  if(Array.isArray(value))return value.map(canonical);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>[k,canonical(v)]));
  return value;
}

export async function turnHash(question:string,answer:string,context:{role:string;content:string}[],system_constraints:string):Promise<string> {
  const bytes=new TextEncoder().encode(JSON.stringify(canonical({question,answer,context,system_constraints})));
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');
}
