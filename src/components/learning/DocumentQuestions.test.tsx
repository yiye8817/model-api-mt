import {expect,it,vi} from 'vitest';
import {act,render,screen,fireEvent,waitFor} from '@testing-library/react';
import type {LearningJob} from '../../lib/learningTypes';
import DocumentQuestions from './DocumentQuestions';

it('sends a question within the explicit document scope',async()=>{
  let sent:unknown;
  vi.stubGlobal('fetch',vi.fn(async(url,init)=>{
    if(String(url).endsWith('/questions')){sent=JSON.parse(String(init?.body));return Response.json({job:{id:'j',status:'queued'}});}
    return Response.json({items:[],total:0,page:1,page_size:30});
  }));
  render(<DocumentQuestions documentId="doc-a" documentTitle="手册 A" selectedIds={['doc-a']} jobs={[]} onWatchJob={()=>{}} onOpenCitation={()=>{}}/>);
  fireEvent.change(screen.getByRole('textbox',{name:'向资料提问'}),{target:{value:'保修期多久？'}});
  fireEvent.click(screen.getByRole('button',{name:'发送问题'}));
  await waitFor(()=>expect(sent).toMatchObject({question:'保修期多久？',scope:{mode:'selected',document_ids:['doc-a']}}));
});

it('starts deep exploration of all knowledge and remains busy before the first poll',async()=>{
  const sent:unknown[]=[],watch=vi.fn();
  vi.stubGlobal('fetch',vi.fn(async(url,init)=>{
    if(String(url).endsWith('/questions')){sent.push(JSON.parse(String(init?.body)));return Response.json({job:{id:'deep-job',status:'queued'}});}
    if(String(url).endsWith('/cancel'))return Response.json({job:{id:'deep-job',status:'cancelled'}});
    return Response.json({items:[],total:0,page:1,page_size:30});
  }));
  render(<DocumentQuestions workspace selectedIds={[]} jobs={[]} onWatchJob={watch} onOpenCitation={()=>{}}/>);
  fireEvent.click(screen.getByRole('button',{name:'深度探索'}));
  fireEvent.change(screen.getByRole('textbox',{name:'向知识库提问'}),{target:{value:'解释量子叠加的原理和误区'}});
  fireEvent.click(screen.getByRole('button',{name:'发送问题'}));
  await waitFor(()=>expect(watch).toHaveBeenCalledWith('deep-job'));
  expect(sent[0]).toMatchObject({scope:{mode:'all'},mode:'explore'});
  expect(screen.getByRole('button',{name:'停止'})).toBeTruthy();
  fireEvent.change(screen.getByRole('textbox',{name:'向知识库提问'}),{target:{value:'另一个问题'}});
  fireEvent.keyDown(screen.getByRole('textbox',{name:'向知识库提问'}),{key:'Enter',ctrlKey:true});
  expect(sent).toHaveLength(1);
  fireEvent.click(screen.getByRole('button',{name:'停止'}));
  await waitFor(()=>expect(screen.getByRole('button',{name:'发送问题'})).toBeTruthy());
  expect((screen.getByRole('textbox',{name:'向知识库提问'}) as HTMLTextAreaElement).value).toBe('另一个问题');
});

it('preserves conversation scope through source changes, waits for answers and opens evidence',async()=>{
  const sent:Record<string,unknown>[]=[],open=vi.fn();
  const citation={document_id:'a',revision:1,chunk_id:'chunk-a',quote:'量子叠加是状态组合。',title:'资料 A',position:{start_line:1}};
  const conversation={id:'conversation-a',title:'量子叠加',scope:{mode:'selected',document_ids:['a']},document_revisions:{a:1},turns:[{id:'turn-a',question:'量子叠加是什么',answer:'来自 A 的回答',mode:'query',extension:'',citations:[citation]}]};
  let finishAnswer!:(r:Response)=>void;
  const fetcher=vi.fn(async(url,init)=>{
    if(String(url).endsWith('/questions')){sent.push(JSON.parse(String(init?.body)));return Response.json({job:{id:`j${sent.length}`,status:'queued'}});}
    if(String(url).endsWith('/conversations/conversation-a'))return new Promise<Response>(r=>{finishAnswer=r;});
    return Response.json({items:[],total:0,page:1,page_size:30});
  });
  vi.stubGlobal('fetch',fetcher);
  const props={workspace:true,selectedIds:['a'],onWatchJob:vi.fn(),onOpenCitation:open};
  const view=render(<DocumentQuestions {...props} documentId="a" documentTitle="资料 A" jobs={[]}/>);
  fireEvent.change(screen.getByRole('combobox',{name:'知识对话资料范围'}),{target:{value:'current'}});
  fireEvent.change(screen.getByRole('textbox',{name:'向知识库提问'}),{target:{value:'量子叠加是什么'}});
  fireEvent.click(screen.getByRole('button',{name:'发送问题'}));
  await waitFor(()=>expect(props.onWatchJob).toHaveBeenCalledWith('j1'));
  const completed:LearningJob={id:'j1',kind:'question',status:'completed',phase:'completed',processed:0,total:0,message:'',document_revisions:{a:1},result:{conversation_id:'conversation-a'}};
  view.rerender(<DocumentQuestions {...props} selectedIds={['b']} documentId="b" documentTitle="资料 B" jobs={[completed]}/>);
  await waitFor(()=>expect(finishAnswer).toBeTypeOf('function'));
  fireEvent.change(screen.getByRole('textbox',{name:'向知识库提问'}),{target:{value:'继续解释'}});
  fireEvent.keyDown(screen.getByRole('textbox',{name:'向知识库提问'}),{key:'Enter',ctrlKey:true});
  expect(sent).toHaveLength(1);
  await act(async()=>{finishAnswer(Response.json({conversation}));});
  expect(await screen.findByText('来自 A 的回答')).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:/资料 A · 行/}));
  expect(open).toHaveBeenCalledWith(citation);
  fireEvent.click(screen.getByRole('button',{name:'保存为学习笔记'}));
  await waitFor(()=>expect(fetcher.mock.calls.some(c=>String(c[0]).endsWith('/archives/notes'))).toBe(true));
  expect(screen.getByRole('option',{name:'本次对话固定资料（1 份）'})).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'深度探索'}));
  fireEvent.click(screen.getByRole('button',{name:'发送问题'}));
  await waitFor(()=>expect(sent).toHaveLength(2));
  expect(sent[1]).toMatchObject({scope:{mode:'selected',document_ids:['a']},conversation_id:'conversation-a',mode:'explore'});
});

it('loads saved global conversations and changes scope by starting a new thread',async()=>{
  let sent:unknown;
  const old={id:'old',title:'保存的知识对话',scope:{mode:'selected',document_ids:['a']},turns:[{id:'turn',question:'旧问题',answer:'保存的探索结果',mode:'explore',citations:[],extension:''}]};
  vi.stubGlobal('fetch',vi.fn(async(url,init)=>{
    if(String(url).endsWith('/conversations/old'))return Response.json({conversation:old});
    if(String(url).endsWith('/questions')){sent=JSON.parse(String(init?.body));return Response.json({job:{id:'new',status:'queued'}});}
    return Response.json({items:[old],total:1,page:1,page_size:30});
  }));
  render(<DocumentQuestions workspace documentId="a" documentTitle="A" selectedIds={['a','b']} jobs={[]} onWatchJob={()=>{}} onOpenCitation={()=>{}}/>);
  fireEvent.change(await screen.findByRole('combobox',{name:'历史知识对话'}),{target:{value:'old'}});
  expect(await screen.findByText('保存的探索结果')).toBeTruthy();
  expect(screen.getByRole('button',{name:'深度探索'}).getAttribute('aria-pressed')).toBe('true');
  fireEvent.change(screen.getByRole('combobox',{name:'知识对话资料范围'}),{target:{value:'selected'}});
  fireEvent.change(screen.getByRole('textbox',{name:'向知识库提问'}),{target:{value:'比较所选资料'}});
  fireEvent.click(screen.getByRole('button',{name:'发送问题'}));
  await waitFor(()=>expect(sent).toMatchObject({scope:{mode:'selected',document_ids:['a','b']},mode:'explore'}));
  expect((sent as Record<string,unknown>).conversation_id).toBeUndefined();
});

it('can open a different history after receiving a generated answer',async()=>{
  const record=(id:string,answer:string)=>({id,title:id,scope:{mode:'all'},turns:[{id:'turn-'+id,question:'问题',answer,citations:[],extension:''}]});
  let finishHistory!:(r:Response)=>void;
  vi.stubGlobal('fetch',vi.fn(async(url)=>{
    if(String(url).endsWith('/questions'))return Response.json({job:{id:'job',status:'queued'}});
    if(String(url).endsWith('/conversations/new'))return Response.json({conversation:record('new','本次回答')});
    if(String(url).endsWith('/conversations/old'))return new Promise<Response>(r=>{finishHistory=r;});
    return Response.json({items:[record('old','历史回答')],total:1,page:1,page_size:30});
  }));
  const props={workspace:true,selectedIds:[],onWatchJob:vi.fn(),onOpenCitation:()=>{}};
  const view=render(<DocumentQuestions {...props} jobs={[]}/>);
  fireEvent.change(screen.getByRole('textbox',{name:'向知识库提问'}),{target:{value:'问题'}});
  fireEvent.click(screen.getByRole('button',{name:'发送问题'}));
  await waitFor(()=>expect(props.onWatchJob).toHaveBeenCalled());
  const job:LearningJob={id:'job',kind:'question',status:'completed',phase:'completed',processed:0,total:0,message:'',document_revisions:{},result:{conversation_id:'new'}};
  view.rerender(<DocumentQuestions {...props} jobs={[job]}/>);
  expect(await screen.findByText('本次回答')).toBeTruthy();
  fireEvent.change(screen.getByRole('combobox',{name:'历史知识对话'}),{target:{value:'old'}});
  await waitFor(()=>expect(finishHistory).toBeTypeOf('function'));
  await act(async()=>{finishHistory(Response.json({conversation:record('old','历史回答')}));});
  expect(await screen.findByText('历史回答')).toBeTruthy();
});
