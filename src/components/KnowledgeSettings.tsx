import {useState} from 'react';
import type {LocalKnowledgeSettings,LocalEndpoint} from '../lib/knowledgeTypes';

export function localKnowledgeDefaults():LocalKnowledgeSettings {
  const endpoint=(protocol:LocalEndpoint['protocol']):LocalEndpoint=>({url:'',protocol,model:'',model_revision:'',allow_lan:false});
  return {enabled:false,collect_api_chats:true,collect_web_chats:true,embedding_endpoint:endpoint('openai_embeddings'),rerank_endpoint:{...endpoint('llama_rerank'),score_transform:'identity'},
    qa_endpoint:{...endpoint('llama_chat'),context_tokens:4096,max_output_tokens:1024},vector_top_k:20,rerank_top_k:5,local_timeout_seconds:30,evaluation_profile_id:'',online_fallback:true,selected_source_ids:[],time_sensitive_ttl_seconds:3600};
}

const inputClass='w-full mt-1 p-2 rounded border border-gray-600 bg-gray-950 text-gray-200';
export default function KnowledgeSettings({value,onChange}:{value:LocalKnowledgeSettings;onChange:(v:LocalKnowledgeSettings)=>void}) {
  const [probe,setProbe]=useState<Record<string,{available:boolean;error?:string;model?:string}>|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const check=async()=>{setBusy(true);setError('');try{const r=await fetch('/api/knowledge/probe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({roles:['embedding','rerank','qa']})});if(!r.ok)throw new Error('无法检查本地服务');setProbe((await r.json()).roles);}catch(e){setError(e instanceof Error?e.message:'检查失败');}finally{setBusy(false);}};
  return <div className="space-y-4 text-sm">
    <label className="flex gap-2"><input type="checkbox" checked={value.enabled} onChange={e=>onChange({...value,enabled:e.target.checked})}/>启用本地知识</label>
    <p className="text-xs text-gray-400">先检索本地资料，证据通过检查后回答。模型需要通过独立评测才能自动回答。</p>
    {(['embedding','rerank','qa'] as const).map(role=>{
      const key=`${role}_endpoint` as const;const endpoint=value[key];const title={embedding:'向量模型',rerank:'重排模型',qa:'本地问答模型'}[role];
      const update=(patch:Partial<LocalEndpoint>)=>onChange({...value,[key]:{...endpoint,...patch}});
      return <fieldset key={role} className="border border-gray-700 rounded p-3 space-y-2"><legend className="px-1 text-emerald-300">{title}</legend>
        <label className="block text-xs">服务 URL<input aria-label={`${title} URL`} className={inputClass} placeholder="http://127.0.0.1:8011" value={endpoint.url} onChange={e=>update({url:e.target.value})}/></label>
        <label className="block text-xs">模型名称<input aria-label={`${title}名称`} className={inputClass} value={endpoint.model} onChange={e=>update({model:e.target.value})}/></label>
        <label className="block text-xs">模型版本标识<input aria-label={`${title}版本标识`} className={inputClass} placeholder="权重 SHA256 或明确修订号" value={endpoint.model_revision} onChange={e=>update({model_revision:e.target.value})}/></label>
        <label className="flex gap-2 text-xs"><input type="checkbox" checked={endpoint.allow_lan} onChange={e=>update({allow_lan:e.target.checked})}/>允许已配置的局域网服务</label>
        {role==='rerank'&&<label className="block text-xs">评分变换<select className={inputClass} value={endpoint.score_transform||'identity'} onChange={e=>update({score_transform:e.target.value as 'identity'|'sigmoid'})}><option value="identity">保持原始分数</option><option value="sigmoid">Sigmoid</option></select></label>}
        {role==='qa'&&<label className="block text-xs">模型上下文 token 上限<input className={inputClass} type="number" min="1" value={endpoint.context_tokens||4096} onChange={e=>update({context_tokens:Number(e.target.value)})}/></label>}
        {probe?.[role]&&<p className={probe[role].available?'text-emerald-300 text-xs':'text-amber-300 text-xs'}>{probe[role].available?'连接可用':probe[role].error||'连接不可用'}</p>}
      </fieldset>;
    })}
    <button className="px-3 py-2 bg-gray-700 rounded" disabled={busy} onClick={()=>void check()}>{busy?'检查中…':'检查已保存的连接'}</button>
    <p className="text-xs text-gray-400">连接修改后先保存设置，再检查服务。问答可以使用现有本地模型 Hub；向量和重排各使用独立服务。</p>
    {error&&<p role="alert" className="text-amber-300">{error}</p>}
    <label className="flex gap-2"><input type="checkbox" checked={value.online_fallback} onChange={e=>onChange({...value,online_fallback:e.target.checked})}/>本地未命中时使用在线兜底</label>
    <label className="flex gap-2"><input type="checkbox" checked={value.collect_api_chats} onChange={e=>onChange({...value,collect_api_chats:e.target.checked})}/>收集未来完整 API 问答</label>
    <label className="flex gap-2"><input type="checkbox" checked={value.collect_web_chats} onChange={e=>onChange({...value,collect_web_chats:e.target.checked})}/>收集未来完整网页问答</label>
    <p className="text-xs text-gray-400">当前评测配置：{value.evaluation_profile_id||'尚未激活'}。在“资料管理”中运行评测，复核结果后激活。</p>
  </div>;
}
