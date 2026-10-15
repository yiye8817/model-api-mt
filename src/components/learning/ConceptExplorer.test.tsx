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

it('sends the displayed source range when starting exploration',async()=>{
  const concept={id:'scoped',name:'范围知识点',domain:'物理',description:'状态',aliases:[],document_ids:['a','b'],citations:[]};
  const fetcher=vi.fn(async(url,_options)=>{
    if(String(url).endsWith('/explore'))return Response.json({job:{id:'explore-job'}});
    return String(url).includes('/concepts/scoped')?Response.json({concept}):Response.json({items:[concept],total:1,page:1,page_size:30});
  });
  vi.stubGlobal('fetch',fetcher);
  render(<ConceptExplorer onOpenDocument={()=>{}} onOpenCitation={()=>{}} onSelectConcept={()=>{}} onWatchJob={()=>{}} currentDocumentId="a" selectedIds={['b']}/>);
  fireEvent.click(await screen.findByRole('button',{name:'范围知识点'}));
  fireEvent.change(screen.getByRole('combobox',{name:'知识点来源范围'}),{target:{value:'current'}});
  fireEvent.click(await screen.findByRole('button',{name:'深入探索'}));
  await waitFor(()=>expect(fetcher.mock.calls.filter(c=>String(c[0]).endsWith('/explore'))).toHaveLength(1));
  expect(JSON.parse(fetcher.mock.calls.find(c=>String(c[0]).endsWith('/explore'))![1].body)).toEqual({scope:{mode:'selected',document_ids:['a']}});
  fireEvent.change(screen.getByRole('combobox',{name:'知识点来源范围'}),{target:{value:'selected'}});
  await waitFor(()=>expect((screen.getByRole('button',{name:'深入探索'}) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button',{name:'深入探索'}));
  await waitFor(()=>expect(fetcher.mock.calls.filter(c=>String(c[0]).endsWith('/explore'))).toHaveLength(2));
  expect(JSON.parse(fetcher.mock.calls.filter(c=>String(c[0]).endsWith('/explore'))[1][1].body)).toEqual({scope:{mode:'selected',document_ids:['b']}});
});
