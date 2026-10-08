import {expect,it,vi} from 'vitest';
import {render,screen,fireEvent,waitFor,renderHook,within} from '@testing-library/react';
import KnowledgePanel from './KnowledgePanel';
import KnowledgeSettings from './KnowledgeSettings';
import SettingsModal from './SettingsModal';
import {useKnowledgeJobs} from '../hooks/useKnowledgeJobs';
import type {LocalKnowledgeSettings} from '../lib/knowledgeTypes';
import {useState} from 'react';

const endpoint={url:'',protocol:'llama_chat' as const,model:'',model_revision:'',allow_lan:false};
const value:LocalKnowledgeSettings={enabled:false,collect_api_chats:true,collect_web_chats:true,embedding_endpoint:{...endpoint,protocol:'openai_embeddings'},rerank_endpoint:{...endpoint,protocol:'llama_rerank'},qa_endpoint:endpoint,
  vector_top_k:20,rerank_top_k:5,local_timeout_seconds:30,evaluation_profile_id:'',online_fallback:true,selected_source_ids:[],time_sensitive_ttl_seconds:3600};

it('settings default off and report each role probe error',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>Response.json({roles:{embedding:{available:false,error:'未配置'},rerank:{available:true,model:'rerank'},qa:{available:false,error:'服务退出'}}})));
  render(<KnowledgeSettings value={value} onChange={()=>{}}/>);
  expect((screen.getByRole('checkbox',{name:'启用本地知识'}) as HTMLInputElement).checked).toBe(false);
  fireEvent.click(screen.getByRole('button',{name:'检查已保存的连接'}));
  expect(await screen.findByText(/服务退出/)).toBeTruthy();expect(within(screen.getByRole('group',{name:'向量模型'})).getByText('未配置')).toBeTruthy();
});

it('source management can disable and refresh a source',async()=>{
  const source={id:'s',title:'手册',kind:'document',status:'indexed',enabled:true,revision:1,nature:'document',context_complete:true,locator:{kind:'file'}};
  const calls:{url:string;method?:string;body?:string}[]=[];
  vi.stubGlobal('fetch',vi.fn(async(input,init)=>{const url=String(input);calls.push({url,method:init?.method,body:init?.body});
    if(url.startsWith('/api/knowledge/sources?'))return Response.json({sources:[source]});
    if(url.endsWith('/refresh'))return Response.json({job_id:'j'},{status:202});
    if(url.includes('/jobs/'))return Response.json({job:{id:'j',status:'done',phase:'done',total:1,completed:1,succeeded:1,failed:0,skipped:0,items:[],result:null}});
    return Response.json({ok:true});}));
  render(<KnowledgePanel onOpenCitation={()=>{}}/>);await screen.findByText('手册');
  fireEvent.click(screen.getByRole('checkbox',{name:'参与检索：手册'}));
  await waitFor(()=>expect(calls.some(c=>c.method==='PATCH'&&c.body==='{"enabled":false}')).toBe(true));
  fireEvent.click(screen.getByRole('button',{name:'更新索引：手册'}));
  expect(await screen.findByText(/成功 1/)).toBeTruthy();
});

it('unmount stops job polling',async()=>{
  const fetcher=vi.fn(async()=>Response.json({job:{id:'j',status:'running',phase:'indexing',items:[],result:null}}));vi.stubGlobal('fetch',fetcher);
  const hook=renderHook(()=>useKnowledgeJobs('j'));
  await waitFor(()=>expect(fetcher).toHaveBeenCalled());hook.unmount();
  const count=fetcher.mock.calls.length;await new Promise(resolve=>setTimeout(resolve,650));
  expect(fetcher.mock.calls.length).toBe(count);
});

it('imports launcher JSON into the form while preserving omitted optional QA and unsaved preferences',async()=>{
  const imported={local_knowledge:{embedding_endpoint:{url:'http://127.0.0.1:18011',model:'bge-m3'},rerank_endpoint:{url:'http://127.0.0.1:18012',model:'bge-reranker-v2-m3'}}};
  const posted:Record<string,unknown>[]=[];
  vi.stubGlobal('fetch',vi.fn(async(_url,init)=>{
    const body=JSON.parse(String(init?.body));posted.push(body);const current=body.current;
    return Response.json({settings:{...current,embedding_endpoint:{...current.embedding_endpoint,...imported.local_knowledge.embedding_endpoint},rerank_endpoint:{...current.rerank_endpoint,...imported.local_knowledge.rerank_endpoint}}});
  }));
  function Form(){const [settings,setSettings]=useState({...value,online_fallback:false});return <KnowledgeSettings value={settings} onChange={setSettings}/>;}
  render(<Form/>);
  const file=new File([JSON.stringify(imported)],'configuration.json',{type:'application/json'});
  fireEvent.change(screen.getByLabelText('导入本地知识配置 JSON'),{target:{files:[file]}});
  await waitFor(()=>expect((screen.getByLabelText('向量模型 URL') as HTMLInputElement).value).toBe('http://127.0.0.1:18011'));
  expect((screen.getByLabelText('重排模型名称') as HTMLInputElement).value).toBe('bge-reranker-v2-m3');
  expect((screen.getByLabelText('本地问答模型 URL') as HTMLInputElement).value).toBe('');
  expect((screen.getByRole('checkbox',{name:'本地未命中时使用在线兜底'}) as HTMLInputElement).checked).toBe(false);
  expect(posted[0].config).toEqual(imported);
  expect(await screen.findByText(/已导入 configuration.json.*保存/)).toBeTruthy();
});

it('invalid JSON leaves the settings form intact and reports an error',async()=>{
  const change=vi.fn();const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
  render(<KnowledgeSettings value={value} onChange={change}/>);
  fireEvent.change(screen.getByLabelText('导入本地知识配置 JSON'),{target:{files:[new File(['{broken'],'bad.json')]}});
  expect(await screen.findByRole('alert')).toHaveProperty('textContent',expect.stringMatching(/JSON/));
  expect(change).not.toHaveBeenCalled();expect(fetcher).not.toHaveBeenCalled();
});

it('an optional unconfigured QA is shown as skipped during a successful retrieval probe',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>Response.json({roles:{embedding:{available:true},rerank:{available:true},qa:{available:false,skipped:true,error:null}}})));
  render(<KnowledgeSettings value={value} onChange={()=>{}}/>);
  expect(screen.getByText('本地问答模型（可选）')).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'检查已保存的连接'}));
  expect(await screen.findByText('未配置，已跳过（可选）')).toBeTruthy();
  expect(screen.queryByText('连接不可用')).toBeNull();
});

it('the settings modal saves imported retrieval roles with QA blank and other settings preserved',async()=>{
  const settings={local_knowledge:value,model_params:{temperature:.4},web_search:{provider:'duckduckgo',keys:{}},model_roles:{},model_endpoints:{}};
  const patch={local_knowledge:{embedding_endpoint:{url:'http://127.0.0.1:18011',model:'bge-m3'}}};
  let saved:typeof settings|undefined;
  vi.stubGlobal('fetch',vi.fn(async(input,init)=>{
    const url=String(input);
    if(url==='/api/settings'&&init?.method==='POST'){saved=JSON.parse(String(init.body));return Response.json({settings:saved});}
    if(url==='/api/settings')return Response.json(settings);
    if(url==='/api/knowledge/config/validate'){
      const current=JSON.parse(String(init?.body)).current;return Response.json({settings:{...current,embedding_endpoint:{...current.embedding_endpoint,...patch.local_knowledge.embedding_endpoint}}});
    }
    return Response.json([]);
  }));
  render(<SettingsModal visible onClose={()=>{}} initialTab="knowledge"/>);
  await screen.findByLabelText('导入本地知识配置 JSON');
  fireEvent.change(screen.getByLabelText('导入本地知识配置 JSON'),{target:{files:[new File([JSON.stringify(patch)],'config.json')]}});
  await screen.findByText(/已导入 config.json/);
  fireEvent.click(screen.getByRole('button',{name:'保存'}));
  await waitFor(()=>expect(saved?.local_knowledge.embedding_endpoint.model).toBe('bge-m3'));
  expect(saved?.local_knowledge.qa_endpoint.url).toBe('');expect(saved?.model_params.temperature).toBe(.4);
});

it('server validation errors leave imported fields unapplied',async()=>{
  const change=vi.fn();vi.stubGlobal('fetch',vi.fn(async()=>Response.json({error:'Invalid embedding_endpoint'},{status:400})));
  render(<KnowledgeSettings value={value} onChange={change}/>);
  fireEvent.change(screen.getByLabelText('导入本地知识配置 JSON'),{target:{files:[new File(['{"embedding_endpoint":null}'],'bad.json')]}});
  expect(await screen.findByRole('alert')).toHaveProperty('textContent','Invalid embedding_endpoint');
  expect(change).not.toHaveBeenCalled();
});

it('save waits for config import to finish and import is disabled while a save is pending',async()=>{
  const settings={local_knowledge:value,model_params:{temperature:.4},web_search:{provider:'duckduckgo',keys:{}},model_roles:{},model_endpoints:{}};
  let completeImport!:(value:Response)=>void;let completeSave!:(value:Response)=>void;
  const saved:typeof settings[]=[];
  vi.stubGlobal('fetch',vi.fn(async(input,init)=>{
    const url=String(input);
    if(url==='/api/knowledge/config/validate')return new Promise<Response>(resolve=>{completeImport=resolve;});
    if(url==='/api/settings'&&init?.method==='POST'){
      saved.push(JSON.parse(String(init.body)));return new Promise<Response>(resolve=>{completeSave=resolve;});
    }
    if(url==='/api/settings')return Response.json(settings);
    return Response.json([]);
  }));
  render(<SettingsModal visible onClose={()=>{}} initialTab="knowledge"/>);
  await screen.findByLabelText('导入本地知识配置 JSON');
  fireEvent.change(screen.getByLabelText('导入本地知识配置 JSON'),{target:{files:[new File(['{"embedding_endpoint":{"model":"imported"}}'],'config.json')]}});
  await waitFor(()=>expect(completeImport).toBeTypeOf('function'));
  expect((screen.getByRole('button',{name:'保存'}) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button',{name:'保存'}));expect(saved).toHaveLength(0);
  completeImport(Response.json({settings:{...value,embedding_endpoint:{...value.embedding_endpoint,model:'imported'}}}));
  await screen.findByText(/已导入 config.json/);fireEvent.click(screen.getByRole('button',{name:'保存'}));
  await waitFor(()=>expect(saved).toHaveLength(1));expect(saved[0].local_knowledge.embedding_endpoint.model).toBe('imported');
  expect((screen.getByLabelText('导入本地知识配置 JSON') as HTMLInputElement).disabled).toBe(true);
  completeSave(Response.json({settings:saved[0]}));
  await waitFor(()=>expect((screen.getByRole('button',{name:'保存'}) as HTMLButtonElement).disabled).toBe(false));
});
