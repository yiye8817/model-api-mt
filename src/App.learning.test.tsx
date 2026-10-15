import {expect,it,vi} from 'vitest';
import {render,screen,fireEvent} from '@testing-library/react';
import App from './App';

it('provides one permanent learning tab',async()=>{
  vi.stubGlobal('fetch',vi.fn(async(url)=>{
    if(String(url).includes('/api/state'))return Response.json({providers:[],conversations:[],activeConversationId:null,activeProviderId:null});
    if(String(url).includes('/api/learning/status'))return Response.json({documents:0,analyzed:0,pending:0,concepts:0,categories:[],jobs:[],hermes:{available:false}});
    return Response.json({items:[],total:0,jobs:[],sources:[],available:false});
  }));
  render(<App/>);
  const tab=await screen.findByRole('tab',{name:'知识学习'});
  fireEvent.click(tab);
  expect(screen.getAllByRole('tab',{name:'知识学习'})).toHaveLength(1);
  expect(await screen.findByRole('heading',{name:'知识学习'})).toBeTruthy();
});
