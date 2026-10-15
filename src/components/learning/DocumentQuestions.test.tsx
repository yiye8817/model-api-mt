import {expect,it,vi} from 'vitest';
import {render,screen,fireEvent,waitFor} from '@testing-library/react';
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
