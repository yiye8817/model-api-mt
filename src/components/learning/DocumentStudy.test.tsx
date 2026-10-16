import {expect,it,vi} from 'vitest';
import {render,screen} from '@testing-library/react';
import DocumentStudy from './DocumentStudy';

it('explains legacy PDF table notices without exposing internal error codes',async()=>{
  vi.stubGlobal('fetch',vi.fn(async(url)=>String(url).endsWith('/analysis')?Response.json({error:'尚未分析'},{status:404}):Response.json({items:[],total:0})));
  const document={id:'pdf',title:'资料.pdf',revision:2,status:'failed',category:'',tags:[],sources:[],content_hash:'x',analysis_id:null,warnings:['pdf_tables_require_verified_structure']};
  render(<DocumentStudy document={document} jobs={[]} selectedIds={[]} onWatchJob={()=>{}} onRefresh={()=>{}} onRemoved={()=>{}} onOpenCitation={()=>{}}/>);
  expect(screen.queryByText('pdf_tables_require_verified_structure')).toBeNull();
  expect(await screen.findByText(/PDF.*表格.*行列/)).toBeTruthy();
});
