import {expect,it,vi} from 'vitest';
import {render,screen} from '@testing-library/react';
import DocumentStudy from './DocumentStudy';
import {Citations} from './shared';

it('explains legacy PDF table notices without exposing internal error codes',async()=>{
  vi.stubGlobal('fetch',vi.fn(async(url)=>String(url).endsWith('/analysis')?Response.json({error:'尚未分析'},{status:404}):Response.json({items:[],total:0})));
  const document={id:'pdf',title:'资料.pdf',revision:2,status:'failed',category:'',tags:[],sources:[],content_hash:'x',analysis_id:null,warnings:['pdf_tables_require_verified_structure']};
  render(<DocumentStudy document={document} jobs={[]} selectedIds={[]} onWatchJob={()=>{}} onRefresh={()=>{}} onRemoved={()=>{}} onOpenCitation={()=>{}}/>);
  expect(screen.queryByText('pdf_tables_require_verified_structure')).toBeNull();
  expect(await screen.findByText(/PDF.*表格.*行列/)).toBeTruthy();
});

it('shows the PDF page and OCR line range on source citations',()=>{
  render(<Citations items={[{document_id:'scan',revision:1,chunk_id:'ocr',title:'扫描资料',quote:'识别原文',position:{kind:'pdf_ocr',page:2,start_line:3,end_line:5,bbox:[.1,.2,.9,.5]}}]} onOpen={()=>{}}/>);
  expect(screen.getByRole('button',{name:/第 2 页.*OCR.*3–5/})).toBeTruthy();
});
