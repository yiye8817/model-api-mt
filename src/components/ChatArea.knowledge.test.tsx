import { it,expect,vi } from 'vitest';
import { render,screen,waitFor,fireEvent,act } from '@testing-library/react';
import ChatArea from './ChatArea';
import App from '../App';
import type { AppState,AppSettings } from '../types';
import type { DesktopBridge,WebChatProgressEvent } from '../lib/desktopBridge';

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
      const data='data: '+JSON.stringify({choices:[{delta:{content:'这是在线模型的回答'},finish_reason:options.terminal===false?null:'stop'}]})+'\n\n'+(options.terminal===false?'':'data: [DONE]\n\n');
      return new Response(data,{headers:{'Content-Type':'text/event-stream'}});
    }
    if(url==='/api/auto-route')return Response.json({intent:'问答',role:'chat_basic',same_topic:true,requires_web_search:false,target:{kind:'unbound'}});
    if(['/api/chat','/api/research/plan'].includes(url))throw new Error('Online generation must not run on a local hit');
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

it('current information turns on the composer web search option',()=>{
  const send=vi.fn();
  render(<ChatArea conversation={{id:'c',title:'chat',messages:[],providerId:'p',model:'model',createdAt:0,updatedAt:0}}
    provider={{id:'p',name:'provider',baseUrl:'http://fixture/v1',apiKey:'',models:['model'],selectedModel:'model'}}
    onSendMessage={send} isLoading={false} streamingContent="" />);
  fireEvent.change(screen.getByLabelText('消息'),{target:{value:'本周有什么科技新闻'}});
  expect(screen.getByTitle('已自动开启联网搜索：查询需要最新信息')).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'发送消息'}));
  expect(send.mock.calls[0]?.[2]).toEqual({webSearch:true});
});

it.each([false,true,'fallback','current-model','semantic','role-fallback'] as const)('latest queries use the currently selected provider for multi-source search (auto-route %s)',async(autoRoute)=>{
  const backend=installBackend();const original=backend.fetcher.getMockImplementation()!;
  backend.settings.web_search.provider='tavily';backend.settings.web_search.fetch_full_content=false;
  backend.settings.model_roles.web_search={providerId:'p',model:'web-model'};
  if(autoRoute==='current-model'||autoRoute==='role-fallback')delete (backend.settings.model_roles as Partial<AppSettings['model_roles']>).web_search;
  backend.fetcher.mockImplementation(async(input,init)=>{
    const url=String(input);const body=typeof init?.body==='string'?JSON.parse(init.body):undefined;
    if(url==='/api/auto-route'){
      backend.calls.push({url,body});
      if(autoRoute==='fallback')return Response.json({intent:'讯息',role:'chat_basic',requires_web_search:true,same_topic:true,keywords:[],reason:'新发布的版本',target:{kind:'unbound'}});
      if(autoRoute==='semantic')return Response.json({intent:'问答',role:'web_search',requires_web_search:true,same_topic:true,keywords:[],reason:'发布动态具有时效性',target:{kind:'unbound'}});
      if(autoRoute==='role-fallback')return Response.json({intent:'讯息',role:'chat_basic',requires_web_search:true,same_topic:true,target:{kind:'role',providerId:'p',model:'basic-fallback',fallback_from:'web_search'}});
      return Response.json({intent:'问答',role:'chat_basic',same_topic:true,keywords:[],reason:'误分类',target:{kind:'unbound'}});
    }
    if(url==='/api/research/stream'){
      backend.calls.push({url,body});
      const events=[{type:'result',channel:'provider',result:{id:'p-answer',channel:'provider',kind:'answer',title:'model',content:'Provider先行回答',url:''}},
        {type:'result',channel:'google',result:{id:'google',channel:'google',kind:'source',title:'Linux公告',url:'https://example.org/release',snippet:'摘要'}},
        {type:'complete',answer:'根据最新公告整理的回答',model:body.model,finish_reason:'stop',sources:[{title:'Linux公告',url:'https://example.org/release',snippet:'摘要'}]}];
      return new Response(events.map(event=>'data: '+JSON.stringify(event)+'\n\n').join(''),{headers:{'Content-Type':'text/event-stream'}});
    }
    if(url==='/api/research/plan'){
      backend.calls.push({url,body});return Response.json({queries:['Linux release'],keywords:['Linux'],sites:[]});
    }
    if(url==='/api/web-search'){
      backend.calls.push({url,body});return Response.json({provider:'duckduckgo',searched_at:'2026-10-14T10:00:00+08:00',results:[
        {title:'Linux公告',url:'https://example.org/release',snippet:'摘要',content:'网页原文中的新功能',published_at:'2026-10-14'}]});
    }
    if(url==='/api/research/synthesize'){
      backend.calls.push({url,body});return Response.json({answer:'根据最新公告整理的回答',model:body.model,finish_reason:'stop'});
    }
    return original(input,init);
  });
  if(autoRoute!==false&&autoRoute!=='current-model')localStorage.setItem('autoRouteEnabled','1');
  render(<App/>);await screen.findByText('本地优先');
  fireEvent.change(screen.getByLabelText('消息'),{target:{value:autoRoute==='semantic'?'Linux内核发布动态':autoRoute==='fallback'?'Linux新发布的版本有哪些':'最近Linux有什么新版本'}});
  fireEvent.click(screen.getByRole('button',{name:'发送消息'}));
  await screen.findByText('根据最新公告整理的回答');
  expect(backend.calls.filter(c=>['/api/content-library/reuse','/api/knowledge/query','/api/chat'].includes(c.url))).toHaveLength(0);
  const research=backend.calls.find(c=>c.url==='/api/research/stream')!.body!;
  expect(research.model).toBe('model');expect(research.baseUrl).toBe('http://fixture/v1');expect(research.web_search).toBe(true);
  expect(screen.getByText('Provider先行回答')).toBeTruthy();
});

it.each(['empty','error','cancel'] as const)('latest search %s does not synthesize from missing pages',async(mode)=>{
  const backend=installBackend();const original=backend.fetcher.getMockImplementation()!;
  let searchStarted=false;
  backend.fetcher.mockImplementation(async(input,init)=>{
    const url=String(input);const body=typeof init?.body==='string'?JSON.parse(init.body):undefined;
    if(url==='/api/research/plan')return Response.json({queries:['Linux release'],sites:[]});
    if(url==='/api/web-search'){
      backend.calls.push({url,body});searchStarted=true;
      if(mode==='cancel')return new Promise((_resolve,reject)=>init?.signal?.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true}));
      return Response.json(mode==='error'?{error:'DDGS不可用',results:[]}:{results:[]},{status:mode==='error'?502:200});
    }
    if(url==='/api/research/stream'){
      backend.calls.push({url,body});searchStarted=true;
      if(mode==='cancel')return new Response(new ReadableStream({start(controller){init?.signal?.addEventListener('abort',()=>controller.error(new DOMException('Aborted','AbortError')),{once:true});}}));
      return new Response('data: '+JSON.stringify({type:'error',detail:'未获取到有效网页资料，无法确认最新信息'})+'\n\n');
    }
    return original(input,init);
  });
  render(<App/>);await screen.findByText('本地优先');
  fireEvent.change(screen.getByLabelText('消息'),{target:{value:'今天Linux的最新版本'}});
  fireEvent.click(screen.getByRole('button',{name:'发送消息'}));
  if(mode==='cancel'){
    await waitFor(()=>expect(searchStarted).toBe(true));
    fireEvent.click(screen.getByRole('button',{name:'停止'}));
    await screen.findByText('⏹️ 已停止');
  }else{
    await screen.findByText(/❌ 检索失败:.*无法确认最新信息/);
  }
  expect(backend.calls.filter(c=>['/api/research/synthesize','/api/chat'].includes(c.url))).toHaveLength(0);
});

it('manual web search displays provider and individual sources before the final answer',async()=>{
  const backend=installBackend();const original=backend.fetcher.getMockImplementation()!;
  let finish:()=>void=()=>{};
  backend.fetcher.mockImplementation(async(input,init)=>{
    if(String(input)==='/api/research/stream'){
      const body=JSON.parse(String(init?.body));backend.calls.push({url:String(input),body});
      return new Response(new ReadableStream({start(controller){
        const emit=(event:unknown)=>controller.enqueue(new TextEncoder().encode('data: '+JSON.stringify(event)+'\n\n'));
        emit({type:'plan',keyword_model:'intent-model',keywords:{zh:['内存性能工具'],en:['memory performance tools']},
          queries:[{language:'zh',query:'内存性能工具'},{language:'en',query:'memory performance tools'}]});
        emit({type:'result',channel:'provider',result:{id:'p',channel:'provider',kind:'answer',title:'model',content:'当前模型搜索回答',url:''}});
        emit({type:'result',channel:'google',result:{id:'g',channel:'google',kind:'source',title:'Google逐项结果',url:'https://example.org/google',snippet:'搜索摘要'}});
        emit({type:'result',channel:'ddgs',result:{id:'d',channel:'ddgs',kind:'source',title:'DDGS逐项结果',url:'https://example.org/ddgs',content:'网页正文'}});
        emit({type:'result',channel:'google',result:{id:'g',channel:'google',kind:'source',title:'Google逐项结果',url:'https://example.org/google',
          parse_status:'success',parsed_chars:120,parse_method:'html_article',summary:'从正文提取的内容摘要',content:'实际网页正文'}});
        emit({type:'result',channel:'ddgs',result:{id:'d',channel:'ddgs',kind:'source',title:'DDGS逐项结果',url:'https://example.org/ddgs',
          parse_status:'error',parse_error:'HTTP 403',content:'',summary:'',snippet:'搜索摘要'}});
        finish=()=>{emit({type:'complete',answer:'全部来源综合答案',model:'model',finish_reason:'stop',sources:[]});controller.close();};
      }}));
    }
    return original(input,init);
  });
  render(<App/>);await screen.findByText('本地优先');
  fireEvent.click(screen.getByTitle('开启综合联网搜索'));
  fireEvent.change(screen.getByLabelText('消息'),{target:{value:'内存性能工具有哪些'}});
  fireEvent.click(screen.getByRole('button',{name:'发送消息'}));
  await screen.findByText('当前模型搜索回答');await screen.findByText('Google逐项结果');await screen.findByText('DDGS逐项结果');
  expect(screen.getByText('memory performance tools')).toBeTruthy();
  expect(screen.getByText('关键词模型：intent-model')).toBeTruthy();
  expect(screen.getByText(/解析成功/)).toBeTruthy();
  expect(screen.getByText('从正文提取的内容摘要')).toBeTruthy();
  expect(screen.getByText(/解析失败.*HTTP 403/)).toBeTruthy();
  expect(screen.queryByText('全部来源综合答案')).toBeNull();
  expect(backend.calls.filter(c=>['/api/content-library/reuse','/api/knowledge/query'].includes(c.url))).toHaveLength(0);
  await act(async()=>finish());await screen.findByText('全部来源综合答案');
});

it.each([false,true] as const)('research saves the synthesis provider/model with invalid default=%s',async(invalidDefault)=>{
  const backend=installBackend();const original=backend.fetcher.getMockImplementation()!;
  backend.state.providers[0].isDefault=false;
  backend.state.providers.push({id:'default-p',name:'Default provider',baseUrl:invalidDefault?'':'http://default/v1',apiKey:'',models:['default-model'],selectedModel:'default-model',isDefault:true});
  backend.fetcher.mockImplementation(async(input,init)=>{
    if(String(input)==='/api/research/stream')return new Response('data: '+JSON.stringify({type:'complete',answer:'默认模型已整合摘要',
      model:invalidDefault?'model':'default-model',provider_id:invalidDefault?undefined:'default-p',finish_reason:'stop',sources:[]})+'\n\n');
    return original(input,init);
  });
  render(<App/>);await screen.findByText('本地优先');
  fireEvent.click(screen.getByTitle('开启综合联网搜索'));
  fireEvent.change(screen.getByLabelText('消息'),{target:{value:'内存工具有哪些'}});
  fireEvent.click(screen.getByRole('button',{name:'发送消息'}));
  await screen.findByText('默认模型已整合摘要');
  await waitFor(()=>expect(backend.calls.some(call=>{
    const turn=call.body?.turn as {model?:string;provider_id?:string}|undefined;
    return turn?.model===(invalidDefault?'model':'default-model')&&turn?.provider_id===(invalidDefault?'p':'default-p');
  })).toBe(true));
});

it('local-only settings block a latest query without any online intent or search request',async()=>{
  const backend=installBackend();backend.settings.local_knowledge!.online_fallback=false;
  localStorage.setItem('autoRouteEnabled','1');render(<App/>);await screen.findByText('本地优先');
  fireEvent.change(screen.getByLabelText('消息'),{target:{value:'今天Linux的最新版本'}});
  fireEvent.click(screen.getByRole('button',{name:'发送消息'}));
  await screen.findByText(/资料时效无法确认/);
  expect(backend.calls.filter(c=>['/api/auto-route','/api/web-search','/api/research/plan','/api/chat'].includes(c.url))).toHaveLength(0);
});

it('real App local hit skips online generation after intent preflight',async()=>{
  const backend=installBackend();localStorage.setItem('autoRouteEnabled','1');render(<App/>);
  await waitFor(()=>expect(screen.getByLabelText('消息')).toBeTruthy());
  await screen.findByText('本地优先');
  fireEvent.change(screen.getByLabelText('消息'),{target:{value:'A 型号保修期？'}});
  fireEvent.click(screen.getByRole('button',{name:'发送消息'}));
  await screen.findByText('A 型号保修三年');
  expect(backend.calls.filter(c=>c.url==='/api/knowledge/query')).toHaveLength(1);
  expect(backend.calls.filter(c=>c.url==='/api/auto-route')).toHaveLength(1);
  expect(backend.calls.filter(c=>c.url==='/api/chat')).toHaveLength(0);
  expect(document.querySelectorAll('[data-message-role="user"]')).toHaveLength(1);
  expect(document.querySelectorAll('[data-message-role="assistant"]')).toHaveLength(1);
});

it.each(['什么是多级页表','多级页表','什么是多极页表'])('real App keeps a document excerpt for %s local before online routing',async(question)=>{
  const backend=installBackend();const original=backend.fetcher.getMockImplementation()!;
  backend.settings.local_knowledge!.evaluation_profile_id='';
  backend.fetcher.mockImplementation(async(input,init)=>{
    if(String(input)==='/api/content-library/reuse'){
      const body=JSON.parse(String(init?.body));backend.calls.push({url:String(input),body});
      return Response.json({request_id:body.request_id,decision:'miss',reason:'no_saved_answer',answer:null,citations:[],trace:[],local_model:'',duration_ms:1,answer_origin:null});
    }
    if(String(input)==='/api/knowledge/query'){
      const body=JSON.parse(String(init?.body));backend.calls.push({url:String(input),body});
      return Response.json({request_id:body.request_id,decision:'hit',reason:'',answer:'多级页表按层级组织页表，减少未使用地址空间的内存占用。',
        citations:[{source_id:'manual',source_kind:'document',title:'part3.html',chunk_id:'chunk',revision:1,locator:{kind:'file',path:'/fixture/part3.html'},position:{kind:'lines',start_line:30,end_line:34},quote:'解决方案是使用多级页表。'}],
        trace:[{stage:'extractive_retrieval',status:'done',method:'document_definition'}],local_model:'',duration_ms:1,answer_origin:'extractive_document'});
    }
    return original(input,init);
  });
  localStorage.setItem('autoRouteEnabled','1');render(<App/>);await screen.findByText('本地优先');
  fireEvent.change(screen.getByLabelText('消息'),{target:{value:question}});fireEvent.click(screen.getByRole('button',{name:'发送消息'}));
  await screen.findByText('多级页表按层级组织页表，减少未使用地址空间的内存占用。');
  expect(screen.getByText('本地资料回答')).toBeTruthy();
  expect(backend.calls.filter(c=>c.url==='/api/auto-route')).toHaveLength(1);
  expect(backend.calls.filter(c=>['/api/chat','/api/research/plan'].includes(c.url))).toHaveLength(0);
});

it('a combined local answer displays both source types and opens its original dialogue',async()=>{
  const backend=installBackend();const original=backend.fetcher.getMockImplementation()!;
  backend.state.conversations.push({id:'original',title:'TLB旧对话',providerId:'p',model:'model',createdAt:1,updatedAt:2,
    messages:[{id:'u-old',role:'user',content:'TLB是什么，有什么用',timestamp:1},{id:'a-old',role:'assistant',content:'旧对话解释：TLB缓存地址转换结果。',timestamp:2}]});
  backend.fetcher.mockImplementation(async(input,init)=>{
    const url=String(input);
    if(url==='/api/content-library/reuse'){
      const body=JSON.parse(String(init?.body));backend.calls.push({url,body});
      return Response.json({request_id:body.request_id,decision:'miss',reason:'document_answer_available',answer:null,citations:[],trace:[],local_model:'',duration_ms:1,answer_origin:null});
    }
    if(url==='/api/knowledge/query'){
      const body=JSON.parse(String(init?.body));backend.calls.push({url,body});
      return Response.json({request_id:body.request_id,decision:'hit',reason:'',answer:'文档和旧对话共同解释了地址翻译缓存。',
        citations:[{source_id:'doc',source_kind:'document',title:'memory.html',chunk_id:'doc-c',revision:1,locator:{kind:'file',path:'/memory.html'},position:{kind:'lines',start_line:1},quote:'TLB缓存物理页地址。'},
          {source_id:'history',source_kind:'api_chat',title:'TLB是什么，有什么用',chunk_id:'chat-c',revision:1,locator:{kind:'chat',conversation_id:'original',assistant_message_id:'a-old'},position:{kind:'message',message_id:'a-old'},quote:'旧对话解释：TLB缓存地址转换结果。'}],
        trace:[],local_model:'',duration_ms:1,answer_origin:'local_synthesis'});
    }
    return original(input,init);
  });
  render(<App/>);await screen.findByText('本地优先');
  fireEvent.change(screen.getByLabelText('消息'),{target:{value:'什么是TLB'}});fireEvent.click(screen.getByRole('button',{name:'发送消息'}));
  await screen.findByText('本地资料综合回答');fireEvent.click(screen.getByText('引用来源（2）'));
  expect(screen.getByText('来源为历史模型回答')).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:/\[2\].*TLB是什么/}));
  await screen.findByText('旧对话解释：TLB缓存地址转换结果。');
  expect(backend.calls.filter(c=>c.url==='/api/chat')).toHaveLength(0);
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
  await screen.findByText('这是在线模型的回答');
  const online=b.calls.filter(c=>c.url==='/api/chat');expect(online).toHaveLength(1);
  expect(online[0].body?.baseUrl).toBe('http://fixture/v1');
  expect(document.querySelectorAll('[data-message-role="user"]')).toHaveLength(1);
  await waitFor(()=>expect(b.calls.filter(c=>c.url==='/api/knowledge/record')).toHaveLength(1));
});

it('disabled local knowledge preserves the existing online path',async()=>{
  const b=installBackend(true,{enabled:false});render(<App/>);await waitFor(()=>expect(screen.getByLabelText('消息')).toBeTruthy());
  fireEvent.change(screen.getByLabelText('消息'),{target:{value:'question'}});fireEvent.click(screen.getByRole('button',{name:'发送消息'}));
  await screen.findByText('这是在线模型的回答');
  expect(b.calls.filter(c=>c.url==='/api/knowledge/query')).toHaveLength(0);
  expect(b.calls.filter(c=>c.url==='/api/chat')).toHaveLength(1);
});

it('a disconnected stream is recorded as partial rather than complete',async()=>{
  const b=installBackend(true,{decision:'miss',terminal:false});render(<App/>);await screen.findByText('本地优先');
  fireEvent.change(screen.getByLabelText('消息'),{target:{value:'question'}});fireEvent.click(screen.getByRole('button',{name:'发送消息'}));
  await screen.findByText('这是在线模型的回答');
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

it('a complete web candidate is recorded when synthesis fails and each web send is counted',async()=>{
  const backend=installBackend(true,{decision:'miss'});const original=backend.fetcher.getMockImplementation()!;
  backend.fetcher.mockImplementation(async(input,init)=>{
    if(String(input)==='/api/chat'){
      backend.calls.push({url:'/api/chat',body:JSON.parse(String(init?.body))});
      return new Response('synthesis unavailable',{status:503});
    }
    return original(input,init);
  });
  let report:((event:WebChatProgressEvent)=>void)|undefined;
  const object:Record<string,unknown>={isDesktop:true,
    onWebChatProgress:(listener:typeof report)=>{report=listener;return ()=>{report=undefined;};},
    webChat:vi.fn(async(id:string,_question:string,_timeout:number,requestId:string)=>{
      const event={id,requestId,event:'prompt-sent',message:'sent',timestamp:Date.now()};report?.(event);
      return {ok:true,content:'B 型号保修三年',model:'web-fixture',site:'deepseek',progressEvents:[event],
        contextSnapshot:{context_complete:true,messages:[{role:'user',content:'这里讨论 B 型号'},{role:'assistant',content:'好的'}]},
        validation:{complete:true}};
    })};
  window.desktop=new Proxy(object,{get(target,key){if(key in target)return target[String(key)];const fn=String(key).startsWith('on')?()=>()=>{}:async()=>({ok:true});target[String(key)]=fn;return fn;}}) as unknown as DesktopBridge;
  render(<App/>);await screen.findByText('本地优先');
  fireEvent.click(screen.getByTitle('配置网页 AI 群聊'));fireEvent.click(screen.getByText('DeepSeek'));
  if(!screen.queryAllByRole('checkbox').length)fireEvent.click(screen.getByTitle('配置网页 AI 群聊'));
  const enabled=screen.getAllByRole('checkbox').find(el=>(el.parentElement?.textContent||'').includes('启用'))!;
  fireEvent.click(enabled);fireEvent.change(screen.getByLabelText('消息'),{target:{value:'保修期多久？'}});
  fireEvent.click(screen.getByRole('button',{name:'发送消息'}));
  await screen.findByText(/网页回答已返回，但综合失败/);
  await waitFor(()=>expect(backend.calls.some(c=>c.url==='/api/knowledge/record'&&(c.body?.turn as {source_kind?:string})?.source_kind==='web_chat')).toBe(true));
  const raw=backend.calls.find(c=>c.url==='/api/knowledge/record'&&(c.body?.turn as {source_kind?:string})?.source_kind==='web_chat')?.body?.turn as {context:{content:string}[];completion:{status:string}};
  expect(raw.context[0].content).toBe('这里讨论 B 型号');expect(raw.completion.status).toBe('complete');
  expect(backend.calls.some(c=>c.url==='/api/knowledge/record'&&Array.isArray(c.body?.online_calls)&&c.body!.online_calls.length>0)).toBe(true);
});
