import {expect,it,vi} from 'vitest';
import {render,screen,fireEvent,within} from '@testing-library/react';
import LearningPanel from './LearningPanel';

it('lists existing documents and opens their saved mind maps',async()=>{
  const doc={id:'doc-a',title:'手册 A',revision:1,status:'completed',category:'科学',tags:[],sources:[],content_hash:'a',analysis_id:'analysis'};
  vi.stubGlobal('fetch',vi.fn(async(url)=>{
    const path=String(url);
    if(path.includes('/status'))return Response.json({documents:1,analyzed:1,pending:0,concepts:1,categories:['科学'],jobs:[],hermes:{available:true}});
    if(path.endsWith('/analysis'))return Response.json({analysis:{id:'analysis',document_id:'doc-a',revision:1,summary:'摘要',concepts:[],relations:[],coverage:{processed:1,total:1},tree:{id:'root',label:'已保存的思维导图',children:[],citations:[]}}});
    if(path.includes('/documents?'))return Response.json({items:[doc],total:1,page:1,page_size:30});
    if(path.endsWith('/doc-a'))return Response.json({document:doc});
    return Response.json({added:0,updated:0,removed:0,errors:[],items:[],total:0,page:1,page_size:30});
  }));
  render(<LearningPanel active/>);
  fireEvent.click(await screen.findByRole('button',{name:'手册 A'}));
  expect(await screen.findByRole('button',{name:'已保存的思维导图'})).toBeTruthy();
  expect(screen.getByRole('button',{name:'文档问答'})).toBeTruthy();
});

it('ignores the previous document analysis after a rapid switch',async()=>{
  const docs=['a','b'].map(id=>({id,title:`资料 ${id}`,revision:1,status:'completed',category:'',tags:[],sources:[],analysis_id:id}));
  let finishA!:(r:Response)=>void;
  const analysis=(label:string)=>Response.json({analysis:{summary:'摘要',coverage:{processed:1,total:1},tree:{id:label,label,children:[],citations:[]}}});
  vi.stubGlobal('fetch',vi.fn(async(url)=>{
    const path=String(url);
    if(path.endsWith('/status'))return Response.json({documents:2,analyzed:2,concepts:2,categories:[],jobs:[],hermes:{available:true}});
    if(path.includes('/documents?'))return Response.json({items:docs,total:2,page:1,page_size:30});
    if(path.endsWith('/a/analysis'))return new Promise<Response>(r=>{finishA=r;});
    if(path.endsWith('/b/analysis'))return analysis('B 的结构');
    return Response.json({items:[],errors:[]});
  }));
  render(<LearningPanel active/>);
  fireEvent.click(await screen.findByRole('button',{name:'资料 b'}));
  expect(await screen.findByRole('button',{name:'B 的结构'})).toBeTruthy();
  finishA(analysis('过时的 A 结构'));
  await new Promise(r=>setTimeout(r,20));
  expect(screen.queryByRole('button',{name:'过时的 A 结构'})).toBeNull();
});

it('clears the reader after removing its selected document',async()=>{
  let removed=false;
  const doc={id:'a',title:'待移除资料',revision:1,status:'pending',category:'',tags:[],sources:[],analysis_id:null};
  vi.stubGlobal('fetch',vi.fn(async(url,init)=>{
    const path=String(url);
    if(init?.method==='DELETE'){removed=true;return Response.json({ok:true});}
    if(path.endsWith('/status'))return Response.json({documents:removed?0:1,analyzed:0,concepts:0,categories:[],jobs:[],hermes:{available:false}});
    if(path.includes('/documents?'))return Response.json({items:removed?[]:[doc],total:removed?0:1,page:1,page_size:30});
    if(path.endsWith('/analysis'))return Response.json({error:'待分析'},{status:404});
    return Response.json({items:[],errors:[]});
  }));
  render(<LearningPanel active/>);
  fireEvent.click(await screen.findByRole('button',{name:'待移除资料'}));
  fireEvent.click(screen.getByRole('button',{name:'移除学习资料'}));
  expect(await screen.findByText('导入资料，开始建立你的知识库。')).toBeTruthy();
});

it('keeps the bottom knowledge dialogue across views, collapse and tab hiding',async()=>{
  vi.stubGlobal('fetch',vi.fn(async(url)=>{
    if(String(url).endsWith('/status'))return Response.json({documents:0,analyzed:0,concepts:0,categories:[],jobs:[],hermes:{available:true}});
    if(String(url).includes('/graph'))return Response.json({nodes:[],edges:[],total_nodes:0,total_edges:0,coverage:{analyzed:0,total:0}});
    return Response.json({items:[],total:0,page:1,page_size:30,errors:[]});
  }));
  const page=render(<LearningPanel active/>);
  const dock=within(await screen.findByRole('region',{name:'知识对话'}));
  fireEvent.change(dock.getByRole('textbox',{name:'向知识库提问'}),{target:{value:'深入解释知识点之间的联系'}});
  for(const name of ['全部知识点','知识图谱','整合归档','文档学习']){
    fireEvent.click(screen.getByRole('button',{name}));
    expect((dock.getByRole('textbox',{name:'向知识库提问'}) as HTMLTextAreaElement).value).toBe('深入解释知识点之间的联系');
  }
  fireEvent.click(dock.getByRole('button',{name:'收起知识对话'}));
  expect(dock.queryByRole('textbox',{name:'向知识库提问'})).toBeNull();
  fireEvent.click(dock.getByRole('button',{name:'展开知识对话'}));
  page.rerender(<LearningPanel active={false}/>);
  page.rerender(<LearningPanel active/>);
  expect((dock.getByRole('textbox',{name:'向知识库提问'}) as HTMLTextAreaElement).value).toBe('深入解释知识点之间的联系');
});
