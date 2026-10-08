import { it,expect,vi } from 'vitest';
import { render,screen,waitFor,fireEvent,act } from '@testing-library/react';
import ChatArea from './ChatArea';
import App from '../App';
import type { AppState,AppSettings } from '../types';
import type { DesktopBridge } from '../lib/desktopBridge';

function config():AppSettings {
  const role={url:'http://127.0.0.1:8011',protocol:'llama_chat' as const,model:'local',model_revision:'1',allow_lan:false};
  return {model_params:{},web_search:{provider:'duckduckgo',keys:{}},model_roles:{} as AppSettings['model_roles'],model_endpoints:{} as AppSettings['model_endpoints'],
    local_knowledge:{enabled:true,collect_api_chats:true,collect_web_chats:true,embedding_endpoint:role,rerank_endpoint:role,qa_endpoint:role,
      vector_top_k:20,rerank_top_k:5,local_timeout_seconds:30,evaluation_profile_id:'profile',online_fallback:true,selected_source_ids:[],time_sensitive_ttl_seconds:3600}};
}

function installBackend(hasProvider=true,options:{enabled?:boolean;decision?:'hit'|'miss';terminal?:boolean}={}) {
  const settings=config();settings.local_knowledge!.enabled=options.enabled!==false;
  const state:AppState={providers:hasProvider?[{id:'p',name:'Provider',baseUrl:'http://fixture/v1',apiKey:'',models:['model'],selectedModel:'model',isDefault:true}]:[],
    conversations:[{id:'c',title:'本地问答',providerId:hasProvider?'p':'',model:hasProvider?'model':'',messages:[],createdAt:1,updatedAt:1}],activeConversationId:'c',activeProviderId:hasProvider?'p':null};
  const calls:{url:string;body?:Record<string,unknown>}[]=[];
  const fetcher=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
    const url=String(input);const body=typeof init?.body==='string'?JSON.parse(init.body):undefined;calls.push({url,body});
    if(url==='/api/state'&&init?.method==='PUT')return new Response('{}');
    if(url==='/api/state')return Response.json(state);
    if(url==='/api/settings')return Response.json(settings);
    if(url==='/api/knowledge/query'&&options.decision==='miss')return Response.json({request_id:body.request_id,decision:'miss',reason:'empty_index',answer:null,citations:[],trace:[],local_model:'local',duration_ms:1,answer_origin:null});
    if(url==='/api/knowledge/query')return Response.json({request_id:body.request_id,decision:'hit',reason:'',answer:'A 型号保修三年',citations:[{source_id:'manual',source_kind:'document',title:'手册',chunk_id:'chunk',revision:1,locator:{kind:'file',path:'/fixture/manual.md'},position:{kind:'lines',start_line:1,end_line:1},quote:'A 型号保修三年'}],trace:[],local_model:'local',duration_ms:1,answer_origin:'local_generated'});
    if(url==='/api/chat'&&(options.decision==='miss'||options.enabled===false)){
      const data='data: '+JSON.stringify({choices:[{delta:{content:'在线回答'},finish_reason:options.terminal===false?null:'stop'}]})+'\n\n'+(options.terminal===false?'':'data: [DONE]\n\n');
      return new Response(data,{headers:{'Content-Type':'text/event-stream'}});
    }
    if(['/api/auto-route','/api/chat','/api/research/plan'].includes(url))throw new Error('Online path must not run on a local hit');
    return Response.json({available:false,models:[],providers:[],skills:[],version:'',defaultCwd:'',repoDir:''});
  });vi.stubGlobal('fetch',fetcher);return {calls,state,fetcher,settings};
}

it('no provider can use the ordinary text composer',()=>{
  render(<ChatArea conversation={{id:'c',title:'local',messages:[],providerId:'',model:'',createdAt:0,updatedAt:0}} provider={null}
    onSendMessage={()=>{}} isLoading={false} streamingContent="" localKnowledgeEnabled />);
  const input=screen.getByLabelText('消息') as HTMLTextAreaElement;
  expect(input.disabled).toBe(false);
  fireEvent.change(input,{target:{value:'问题'}});
  expect((screen.getByRole('button',{name:'发送消息'}) as HTMLButtonElement).disabled).toBe(false);
});

it('real App sends only one local query before automatic model selection',async()=>{
  const backend=installBackend();localStorage.setItem('autoRouteEnabled','1');render(<App/>);
  await waitFor(()=>expect(screen.getByLabelText('消息')).toBeTruthy());
  await screen.findByText('本地优先');
  fireEvent.change(screen.getByLabelText('消息'),{target:{value:'A 型号保修期？'}});
  fireEvent.click(screen.getByRole('button',{name:'发送消息'}));
  await screen.findByText('A 型号保修三年');
  expect(backend.calls.filter(c=>c.url==='/api/knowledge/query')).toHaveLength(1);
  expect(backend.calls.filter(c=>['/api/auto-route','/api/chat'].includes(c.url))).toHaveLength(0);
  expect(document.querySelectorAll('[data-message-role="user"]')).toHaveLength(1);
  expect(document.querySelectorAll('[data-message-role="assistant"]')).toHaveLength(1);
});

it('real App creates a local conversation when no online provider exists',async()=>{
  const backend=installBackend(false);backend.state.conversations=[];backend.state.activeConversationId=null;render(<App/>);
  await screen.findByText('New Chat');
  await screen.findByText('可使用本地资料创建对话');
  fireEvent.click(screen.getByText('New Chat'));
  await waitFor(()=>expect(screen.getByLabelText('消息')).toBeTruthy());
  fireEvent.change(screen.getByLabelText('消息'),{target:{value:'A 型号保修期？'}});fireEvent.click(screen.getByRole('button',{name:'发送消息'}));
  await screen.findByText('A 型号保修三年');
  expect(backend.calls.filter(c=>c.url==='/api/chat')).toHaveLength(0);
});

it('real App local hit bypasses selected web targets and synthesis',async()=>{
  const backend=installBackend();
  const webChat=vi.fn(async()=>({ok:true,content:'online response'}));
  const object:Record<string,unknown>={isDesktop:true,webChat};
  window.desktop=new Proxy(object,{get(target,key){if(key in target)return target[String(key)];const fn=String(key).startsWith('on')?()=>()=>{}:async()=>({ok:true});target[String(key)]=fn;return fn;}}) as unknown as DesktopBridge;
  render(<App/>);await waitFor(()=>expect(screen.getByLabelText('消息')).toBeTruthy());
  fireEvent.click(screen.getByTitle('配置网页 AI 群聊'));
  const deepseek=screen.getByText('DeepSeek');fireEvent.click(deepseek);
  if(!screen.queryAllByRole('checkbox').length)fireEvent.click(screen.getByTitle('配置网页 AI 群聊'));
  const enabled=screen.getAllByRole('checkbox').find(el=>(el.parentElement?.textContent||'').includes('启用'));
  if(!enabled)throw new Error('Web chat enable control missing');
  fireEvent.click(enabled);
  fireEvent.change(screen.getByLabelText('消息'),{target:{value:'A 型号保修期？'}});fireEvent.click(screen.getByRole('button',{name:'发送消息'}));
  await screen.findByText('A 型号保修三年');
  expect(backend.calls.find(c=>c.url==='/api/knowledge/query')?.body?.mode).toBe('web');
  expect(webChat).not.toHaveBeenCalled();
  expect(backend.calls.filter(c=>c.url==='/api/chat')).toHaveLength(0);
});

it('a local miss uses the original API target exactly once',async()=>{
  const b=installBackend(true,{decision:'miss'});render(<App/>);await screen.findByText('本地优先');
  fireEvent.change(screen.getByLabelText('消息'),{target:{value:'question'}});fireEvent.click(screen.getByRole('button',{name:'发送消息'}));
  await screen.findByText('在线回答');
  const online=b.calls.filter(c=>c.url==='/api/chat');expect(online).toHaveLength(1);
  expect(online[0].body?.baseUrl).toBe('http://fixture/v1');
  expect(document.querySelectorAll('[data-message-role="user"]')).toHaveLength(1);
  await waitFor(()=>expect(b.calls.filter(c=>c.url==='/api/knowledge/record')).toHaveLength(1));
});

it('disabled local knowledge preserves the existing online path',async()=>{
  const b=installBackend(true,{enabled:false});render(<App/>);await waitFor(()=>expect(screen.getByLabelText('消息')).toBeTruthy());
  fireEvent.change(screen.getByLabelText('消息'),{target:{value:'question'}});fireEvent.click(screen.getByRole('button',{name:'发送消息'}));
  await screen.findByText('在线回答');
  expect(b.calls.filter(c=>c.url==='/api/knowledge/query')).toHaveLength(0);
  expect(b.calls.filter(c=>c.url==='/api/chat')).toHaveLength(1);
});

it('a disconnected stream is recorded as partial rather than complete',async()=>{
  const b=installBackend(true,{decision:'miss',terminal:false});render(<App/>);await screen.findByText('本地优先');
  fireEvent.change(screen.getByLabelText('消息'),{target:{value:'question'}});fireEvent.click(screen.getByRole('button',{name:'发送消息'}));
  await screen.findByText('在线回答');
  await waitFor(()=>expect(b.calls.filter(c=>c.url==='/api/knowledge/record')).toHaveLength(1));
  const turn=b.calls.find(c=>c.url==='/api/knowledge/record')?.body?.turn as {completion:{status:string}};
  expect(turn.completion.status).toBe('partial');
});

it('stopping a local query discards a late hit without sending online',async()=>{
  const b=installBackend();const original=b.fetcher.getMockImplementation()!;
  let resolve!:(value:Response)=>void;let id='';
  b.fetcher.mockImplementation(async(input,init)=>{
    if(String(input)==='/api/knowledge/query'){
      id=JSON.parse(String(init?.body)).request_id;
      return new Promise<Response>(done=>{resolve=done;});
    }
    return original(input,init);
  });
  render(<App/>);await screen.findByText('本地优先');
  fireEvent.change(screen.getByLabelText('消息'),{target:{value:'question'}});fireEvent.click(screen.getByRole('button',{name:'发送消息'}));
  await waitFor(()=>expect(id).not.toBe(''));fireEvent.click(screen.getByRole('button',{name:'停止'}));
  await act(async()=>resolve(Response.json({request_id:id,decision:'hit',reason:'',answer:'迟到答案',citations:[{source_id:'s'}],trace:[],local_model:'local',duration_ms:1,answer_origin:'local_generated'})));
  await screen.findByText('⏹️ 已停止');expect(screen.queryByText('迟到答案')).toBeNull();
  expect(b.calls.filter(c=>c.url==='/api/chat')).toHaveLength(0);
});
