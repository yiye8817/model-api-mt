import {expect,it,vi} from 'vitest';
import {render,screen,fireEvent,waitFor} from '@testing-library/react';
import ConceptExplorer from './ConceptExplorer';

it('searches knowledge points and locates their source document',async()=>{
  const open=vi.fn(),concept={id:'c',name:'量子叠加',domain:'物理',description:'状态的组合',aliases:[],document_ids:['doc-a'],citations:[],explorations:[]};
  vi.stubGlobal('fetch',vi.fn(async(url)=>String(url).includes('/concepts/c')?Response.json({concept}):Response.json({items:[concept],total:1,page:1,page_size:30})));
  render(<ConceptExplorer onOpenDocument={open} onOpenCitation={()=>{}} onSelectConcept={()=>{}} onWatchJob={()=>{}}/>);
  fireEvent.change(screen.getByRole('textbox',{name:'搜索全部知识点'}),{target:{value:'叠加'}});
  fireEvent.click(await screen.findByRole('button',{name:'量子叠加'}));
  fireEvent.click(await screen.findByRole('button',{name:'查看来源文档与导图'}));
  await waitFor(()=>expect(open).toHaveBeenCalledWith('doc-a','c'));
});
