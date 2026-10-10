import {useEffect,useRef,useState} from 'react';
import type {LocalKnowledgeSettings,LocalEndpoint,ProviderProbeResult,ProviderSummary} from '../lib/knowledgeTypes';
import {knowledgeJson} from '../lib/knowledgeApi';

export function localKnowledgeDefaults():LocalKnowledgeSettings {
  const endpoint=(protocol:LocalEndpoint['protocol']):LocalEndpoint=>({url:'',protocol,model:'',model_revision:'',allow_lan:false,source:'custom',provider_id:'',path:''});
  return {enabled:false,collect_api_chats:true,collect_web_chats:true,embedding_endpoint:endpoint('openai_embeddings'),rerank_endpoint:{...endpoint('llama_rerank'),score_transform:'identity'},
    qa_endpoint:{...endpoint('llama_chat'),context_tokens:4096,max_output_tokens:1024},vector_top_k:20,rerank_top_k:5,local_timeout_seconds:30,evaluation_profile_id:'',online_fallback:true,selected_source_ids:[],time_sensitive_ttl_seconds:3600};
}

const inputClass='w-full mt-1 p-2 rounded border border-gray-600 bg-gray-950 text-gray-200';
export default function KnowledgeSettings({value,onChange,onImportingChange,disabled=false}:{value:LocalKnowledgeSettings;onChange:(v:LocalKnowledgeSettings)=>void;onImportingChange?:(busy:boolean)=>void;disabled?:boolean}) {
  const [probe,setProbe]=useState<Record<string,{available:boolean;error?:string|null;model?:string;skipped?:boolean}>|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [providers,setProviders]=useState<ProviderSummary[]>([]),[providerProbe,setProviderProbe]=useState<Record<string,ProviderProbeResult>>({}),[providerBusy,setProviderBusy]=useState<Record<string,boolean>>({});
  const [importing,setImporting]=useState(false),[importNote,setImportNote]=useState('');
  const importRun=useRef(0);
  useEffect(()=>()=>{importRun.current++;onImportingChange?.(false);},[onImportingChange]);
  const loadProviders=async()=>{if(providers.length)return;try{const response=await fetch('/api/knowledge/providers');if(!response||!response.ok)return;const data=await response.json();setProviders(Array.isArray(data.providers)?data.providers:[]);}catch{/* Provider catalog is optional for existing custom endpoints. */}};
  useEffect(()=>{if(value.embedding_endpoint.source==='provider'||value.rerank_endpoint.source==='provider')void loadProviders();},[value.embedding_endpoint.source,value.rerank_endpoint.source]);
  const importFile=async(file:File)=>{
    const run=++importRun.current;setImporting(true);onImportingChange?.(true);setError('');setImportNote('');setProbe(null);
    try{
      if(file.size>1024*1024)throw new Error('配置 JSON 文件不能超过 1 MiB');
      const text=await new Promise<string>((resolve,reject)=>{
        const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(new Error('无法读取配置文件'));reader.readAsText(file);
      });
      if(importRun.current!==run)return;
      let config:unknown;try{config=JSON.parse(text.replace(/^\uFEFF/,''));}catch{throw new Error('配置文件不是有效的 JSON');}
      const result=await knowledgeJson<{settings:LocalKnowledgeSettings}>('/api/knowledge/config/validate',{config,current:value});
      if(importRun.current!==run)return;
      onChange(result.settings);setImportNote(`已导入 ${file.name}，点击“保存”应用配置。`);
    }catch(e){if(importRun.current===run)setError(e instanceof Error?e.message:'配置导入失败');}
    finally{if(importRun.current===run){setImporting(false);onImportingChange?.(false);}}
  };
  const check=async()=>{setBusy(true);setError('');try{const r=await fetch('/api/knowledge/probe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({roles:['embedding','rerank','qa']})});if(!r.ok)throw new Error('无法检查本地服务');setProbe((await r.json()).roles);}catch(e){setError(e instanceof Error?e.message:'检查失败');}finally{setBusy(false);}};
  const testProvider=async(role:'embedding'|'rerank',endpoint:LocalEndpoint)=>{
    const key=`${role}_endpoint`;setProviderBusy(prev=>({...prev,[role]:true}));setError('');
    try{
      const r=await fetch('/api/knowledge/probe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({role,source:'provider',provider_id:endpoint.provider_id,model:endpoint.model,path:endpoint.path||''})});
      const data=await r.json().catch(()=>({}));if(!r.ok||data.ok===false)throw new Error(data.error||`HTTP ${r.status}`);
      setProviderProbe(prev=>({...prev,[key]:data}));
    }catch(e){setProviderProbe(prev=>({...prev,[key]:{ok:false,role,model:endpoint.model,error:e instanceof Error?e.message:'接口测试失败'}}));}
    finally{setProviderBusy(prev=>({...prev,[role]:false}));}
  };
  const noQa=!value.qa_endpoint.url&&!value.qa_endpoint.model;
  return <fieldset disabled={importing||disabled} className="space-y-4 text-sm">
    <div className="space-y-2">
      <label className={`inline-block px-3 py-2 bg-gray-700 rounded cursor-pointer ${busy||importing||disabled?'opacity-50':''}`}>
        {importing?'导入中…':'导入配置 JSON'}<input aria-label="导入本地知识配置 JSON" type="file" accept=".json,application/json" className="hidden" disabled={busy||importing||disabled}
          onChange={e=>{const file=e.target.files?.[0];e.target.value='';if(file)void importFile(file);}}/>
      </label>
      <p className="text-xs text-gray-400">支持启动脚本生成的 configuration.json 或本地知识配置对象，只合并文件提供的字段。导入后点击“保存”。</p>
      {importNote&&<p role="status" className="text-xs text-emerald-300">{importNote}</p>}
    </div>
    <label className="flex gap-2"><input type="checkbox" checked={value.enabled} onChange={e=>onChange({...value,enabled:e.target.checked})}/>启用本地知识</label>
    <p className="text-xs text-gray-400">向量和重排用于资料索引及检索。本地问答模型可留空；生成并核验本地答案需要配置问答模型并通过独立评测。</p>
    {(['embedding','rerank','qa'] as const).map(role=>{
      const key=`${role}_endpoint` as const;const endpoint=value[key];const title={embedding:'向量模型',rerank:'重排模型',qa:'本地问答模型'}[role];
      const update=(patch:Partial<LocalEndpoint>)=>onChange({...value,[key]:{...endpoint,...patch}});
      return <fieldset key={role} className="border border-gray-700 rounded p-3 space-y-2"><legend className="px-1 text-emerald-300">{title}{role==='qa'?'（可选）':''}</legend>
        {role==='qa'&&<p className="text-xs text-gray-400">留空时可继续导入资料和预览检索结果，普通聊天按在线兜底设置处理。</p>}
        {role!=='qa'&&<>
          <label className="block text-xs">接口来源<select aria-label={`${title}接口来源`} className={inputClass} value={endpoint.source||'custom'} onChange={e=>{const source=e.target.value as 'custom'|'provider';if(source==='provider')void loadProviders();update(source==='provider'?{source,provider_id:'',model:'',url:'',path:role==='embedding'?'/v1/embeddings':'/v1/rerank'}:{source,provider_id:'',path:''});}}><option value="custom">自定义本地端点</option><option value="provider">已配置 Provider</option></select></label>
          {endpoint.source==='provider'?<>
            <label className="block text-xs">Provider<select aria-label={`${title} Provider`} className={inputClass} value={endpoint.provider_id||''} onChange={e=>{const selected=providers.find(p=>p.id===e.target.value);const models=role==='embedding'?selected?.embedding_models||[]:selected?.rerank_models||[];update({provider_id:e.target.value,model:models[0]||'',url:'',path:role==='embedding'?'/v1/embeddings':'/v1/rerank'});}}><option value="">请选择 Provider</option>{providers.map(p=><option key={p.id} value={p.id}>{p.name}{p.reason?`（${p.reason}）`:''}</option>)}</select></label>
            <label className="block text-xs">模型名称<select aria-label={`${title} Provider模型`} className={inputClass} value={endpoint.model} onChange={e=>update({model:e.target.value})}><option value="">请选择模型</option>{(role==='embedding'?providers.find(p=>p.id===endpoint.provider_id)?.embedding_models||[]:providers.find(p=>p.id===endpoint.provider_id)?.rerank_models||[]).map(model=><option key={model} value={model}>{model}</option>)}</select></label>
            <button type="button" className="px-3 py-1.5 bg-gray-700 rounded text-xs" disabled={providerBusy[role]||!endpoint.provider_id||!endpoint.model} onClick={()=>void testProvider(role,endpoint)}>{providerBusy[role]?'测试中…':'测试接口'}</button>
            {providerProbe[`${role}_endpoint`]&&<p className={providerProbe[`${role}_endpoint`].ok?'text-emerald-300 text-xs':'text-amber-300 text-xs'}>{providerProbe[`${role}_endpoint`].ok?(role==='embedding'?`成功：${providerProbe[`${role}_endpoint`].dimension} 维向量`:`成功：最高分 ${providerProbe[`${role}_endpoint`].top_score}`):providerProbe[`${role}_endpoint`].error}</p>}
          </>:<><label className="block text-xs">服务 URL<input aria-label={`${title} URL`} className={inputClass} placeholder="http://127.0.0.1:8011" value={endpoint.url} onChange={e=>update({url:e.target.value})}/></label><label className="block text-xs">模型名称<input aria-label={`${title}名称`} className={inputClass} value={endpoint.model} onChange={e=>update({model:e.target.value})}/></label></>}
        </>}
        {role==='qa'&&<label className="block text-xs">服务 URL<input aria-label={`${title} URL`} className={inputClass} placeholder="http://127.0.0.1:8011" value={endpoint.url} onChange={e=>update({url:e.target.value})}/></label>}
        {role==='qa'&&<label className="block text-xs">模型名称<input aria-label={`${title}名称`} className={inputClass} value={endpoint.model} onChange={e=>update({model:e.target.value})}/></label>}
        <label className="block text-xs">模型版本标识<input aria-label={`${title}版本标识`} className={inputClass} placeholder="权重 SHA256 或明确修订号" value={endpoint.model_revision} onChange={e=>update({model_revision:e.target.value})}/></label>
        <label className="flex gap-2 text-xs"><input type="checkbox" checked={endpoint.allow_lan} onChange={e=>update({allow_lan:e.target.checked})}/>允许已配置的局域网服务</label>
        {role==='rerank'&&<label className="block text-xs">评分变换<select className={inputClass} value={endpoint.score_transform||'identity'} onChange={e=>update({score_transform:e.target.value as 'identity'|'sigmoid'})}><option value="identity">保持原始分数</option><option value="sigmoid">Sigmoid</option></select></label>}
        {role==='qa'&&<label className="block text-xs">模型上下文 token 上限<input className={inputClass} type="number" min="1" value={endpoint.context_tokens||4096} onChange={e=>update({context_tokens:Number(e.target.value)})}/></label>}
        {probe?.[role]&&<p className={probe[role].skipped?'text-gray-400 text-xs':probe[role].available?'text-emerald-300 text-xs':'text-amber-300 text-xs'}>{probe[role].skipped?'未配置，已跳过（可选）':probe[role].available?'连接可用':probe[role].error||'连接不可用'}</p>}
      </fieldset>;
    })}
    <button className="px-3 py-2 bg-gray-700 rounded" disabled={busy||importing} onClick={()=>void check()}>{busy?'检查中…':'检查已保存的连接'}</button>
    <p className="text-xs text-gray-400">连接修改后先保存设置，再检查服务。问答可以使用现有本地模型 Hub；向量和重排各使用独立服务。</p>
    {error&&<p role="alert" className="text-amber-300">{error}</p>}
    <label className="flex gap-2"><input type="checkbox" checked={value.online_fallback} onChange={e=>onChange({...value,online_fallback:e.target.checked})}/>本地未命中时使用在线兜底</label>
    <label className="flex gap-2"><input type="checkbox" checked={value.collect_api_chats} onChange={e=>onChange({...value,collect_api_chats:e.target.checked})}/>收集未来完整 API 问答</label>
    <label className="flex gap-2"><input type="checkbox" checked={value.collect_web_chats} onChange={e=>onChange({...value,collect_web_chats:e.target.checked})}/>收集未来完整网页问答</label>
    <p className="text-xs text-gray-400">当前评测配置：{value.evaluation_profile_id||'尚未激活'}。在“资料管理”中运行评测，复核结果后激活。</p>
    {noQa&&<p className="text-xs text-gray-400">本地问答模型尚未配置。资料索引和检索预览可独立使用，自动本地回答暂未启用。</p>}
  </fieldset>;
}
