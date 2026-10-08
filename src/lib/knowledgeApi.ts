import type { CompletedTurn, KnowledgeQueryRequest, KnowledgeQueryResult } from './knowledgeTypes';

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

export async function cancelKnowledge(requestId: string): Promise<void> {
  await fetch(`/api/knowledge/query/${encodeURIComponent(requestId)}/cancel`,{method:'POST'});
}

export async function recordKnowledge(turn: CompletedTurn, onlineCalls?: {call_id:string;kind:string;model:string}[]): Promise<void> {
  if(turn.completion.kind==='local'||turn.completion.kind==='workflow')return;
  const response=await fetch('/api/knowledge/record',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({turn,online_calls:onlineCalls||[]})});
  if(!response.ok)throw new KnowledgeHttpError(response.status,'问答资料记录失败');
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
