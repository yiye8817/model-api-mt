import {expect,it,vi} from 'vitest';
import {render,screen,fireEvent,waitFor,renderHook} from '@testing-library/react';
import KnowledgePanel from './KnowledgePanel';
import KnowledgeSettings from './KnowledgeSettings';
import {useKnowledgeJobs} from '../hooks/useKnowledgeJobs';
import type {LocalKnowledgeSettings} from '../lib/knowledgeTypes';

const endpoint={url:'',protocol:'llama_chat' as const,model:'',model_revision:'',allow_lan:false};
const value:LocalKnowledgeSettings={enabled:false,collect_api_chats:true,collect_web_chats:true,embedding_endpoint:{...endpoint,protocol:'openai_embeddings'},rerank_endpoint:{...endpoint,protocol:'llama_rerank'},qa_endpoint:endpoint,
  vector_top_k:20,rerank_top_k:5,local_timeout_seconds:30,evaluation_profile_id:'',online_fallback:true,selected_source_ids:[],time_sensitive_ttl_seconds:3600};

it('settings default off and report each role probe error',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>Response.json({roles:{embedding:{available:false,error:'未配置'},rerank:{available:true,model:'rerank'},qa:{available:false,error:'服务退出'}}})));
  render(<KnowledgeSettings value={value} onChange={()=>{}}/>);
  expect((screen.getByRole('checkbox',{name:'启用本地知识'}) as HTMLInputElement).checked).toBe(false);
  fireEvent.click(screen.getByRole('button',{name:'检查已保存的连接'}));
  expect(await screen.findByText(/服务退出/)).toBeTruthy();expect(screen.getByText(/未配置/)).toBeTruthy();
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
