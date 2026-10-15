import {expect,it,vi} from 'vitest';
import {render,screen,fireEvent} from '@testing-library/react';
import KnowledgeGraph from './KnowledgeGraph';

it('shows actual coverage and can reach later relationships',async()=>{
  vi.stubGlobal('fetch',vi.fn(async(url)=>Response.json({nodes:[{id:'c',label:'共享知识点',type:'concept',concept_id:'c',document_id:null}],
    edges:[{id:'e',source:'c',target:'c',type:String(url).includes('page=2')?'末页关系':'关联',citations:[]}],total_nodes:1,total_edges:31,page_size:30,page:1,coverage:{analyzed:2,total:3}})));
  render(<KnowledgeGraph onSelectConcept={()=>{}} onOpenDocument={()=>{}} onOpenCitation={()=>{}} onAnalyzePending={()=>{}}/>);
  expect(await screen.findByText('已分析 2 / 3 份资料')).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'下一页关系'}));
  expect(await screen.findByRole('button',{name:'共享知识点 → 末页关系 → 共享知识点'})).toBeTruthy();
});
