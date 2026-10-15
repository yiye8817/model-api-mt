import { queryKnowledge, querySavedAnswer, KnowledgeHttpError } from './knowledgeApi';
import type { KnowledgeQueryRequest,KnowledgeQueryResult } from './knowledgeTypes';
import { isCurrentInformationQuery } from './webResearch';

export type LocalRouteResult={decision:'hit';result:KnowledgeQueryResult}|{decision:'fallback'|'blocked'|'cancelled';reason:string;result?:KnowledgeQueryResult};

export async function checkLocalFirst(request:KnowledgeQueryRequest,options:{enabled:boolean;onlineFallback:boolean;signal:AbortSignal;requiresWebSearch?:boolean}):Promise<LocalRouteResult> {
  if(options.signal.aborted)return {decision:'cancelled',reason:'cancelled'};
  if(!options.enabled)return {decision:'fallback',reason:'disabled'};
  if(options.requiresWebSearch||isCurrentInformationQuery(request.question))return {decision:options.onlineFallback?'fallback':'blocked',reason:'stale_source'};
  try {
    const saved=await querySavedAnswer(request,options.signal);
    if(options.signal.aborted||saved.decision==='cancelled')return {decision:'cancelled',reason:'cancelled'};
    if(saved.decision==='hit')return {decision:'hit',result:saved};
  }catch(error){
    if(options.signal.aborted||(error instanceof Error&&error.name==='AbortError'))return {decision:'cancelled',reason:'cancelled'};
  }
  try {
    const result=await queryKnowledge(request,options.signal);
    if(options.signal.aborted||result.decision==='cancelled')return {decision:'cancelled',reason:'cancelled'};
    if(result.decision==='hit')return {decision:'hit',result};
    return {decision:options.onlineFallback?'fallback':'blocked',reason:result.reason,result};
  } catch(error) {
    if(options.signal.aborted||(error instanceof Error&&error.name==='AbortError'))return {decision:'cancelled',reason:'cancelled'};
    if(error instanceof KnowledgeHttpError&&[400,401,403,409].includes(error.status))return {decision:'blocked',reason:error.message};
    return {decision:options.onlineFallback?'fallback':'blocked',reason:'local_unavailable'};
  }
}

export function createRequestGuard() {
  let activeId:string|null=null;
  return {
    start(id:string){activeId=id;},
    isCurrent(id:string){return activeId===id;},
    finishRequest(id:string,mutation:()=>void){if(activeId!==id)return false;mutation();activeId=null;return true;},
  };
}

export const knowledgeReasons:Record<string,string>={disabled:'功能未开启',empty_index:'没有可用的已索引资料',local_unavailable:'本地服务不可用',qa_not_configured:'未配置本地问答模型',uncalibrated:'模型尚未通过校准',
  low_relevance:'没有相关证据',constraint_mismatch:'关键条件不符',context_uncertain:'无法确定问题指代',insufficient_evidence:'证据不完整',evidence_conflict:'资料存在冲突',
  stale_source:'资料时效无法确认',source_changed:'来源已变更',invalid_answer:'答案未通过证据检查',local_timeout:'本地处理超时'};
