import {expect,it,vi} from 'vitest';
import {render,screen,fireEvent} from '@testing-library/react';
import KnowledgeCitations from './KnowledgeCitations';
import KnowledgeSourceViewer from './KnowledgeSourceViewer';
import type {Citation} from '../lib/knowledgeTypes';

const citation:Citation={source_id:'s',source_kind:'document',title:'手册',chunk_id:'c',revision:2,locator:{kind:'file',path:'/docs/manual.txt'},position:{kind:'lines',start_line:4,end_line:6},quote:'保修三年'};
it('citations navigate with the actual source and position',()=>{
  let selected:Citation|null=null;render(<KnowledgeCitations citations={[citation]} onOpen={c=>{selected=c;}}/>);
  fireEvent.click(screen.getByText('引用来源（1）'));fireEvent.click(screen.getByRole('button',{name:/手册/}));
  expect(selected).toEqual(citation);expect(screen.getByText(/行 4/)).toBeTruthy();
});
it('a changed revision displays an error and never old text',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>Response.json({error:'source_changed'},{status:409})));
  render(<KnowledgeSourceViewer sourceId="s" revision={2} position={citation.position}/>);
  expect(await screen.findByText(/来源已变更/)).toBeTruthy();
  expect(screen.queryByText('保修三年')).toBeNull();
});
it('PDF and DOCX citations show real page and table positions',()=>{
  render(<KnowledgeCitations citations={[{...citation,chunk_id:'pdf',position:{kind:'pdf_page',page:3}},{...citation,chunk_id:'docx',position:{kind:'docx',table:1,row:2,column:3}}]} onOpen={()=>{}}/>);
  fireEvent.click(screen.getByText('引用来源（2）'));
  expect(screen.getByText(/第 3 页/)).toBeTruthy();expect(screen.getByText(/表 1.*行 2/)).toBeTruthy();
});
