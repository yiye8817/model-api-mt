import {expect,it,vi} from 'vitest';
import {render,screen,fireEvent} from '@testing-library/react';
import MindMap from './MindMap';

it('shows real tree nodes and collapses a branch',()=>{
  render(<MindMap tree={{id:'root',label:'主题',children:[{id:'child',label:'量子叠加',children:[],citations:[]}],citations:[]}} onOpenCitation={vi.fn()}/>);
  expect(screen.getByRole('button',{name:'量子叠加'})).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'收起：主题'}));
  expect(screen.queryByRole('button',{name:'量子叠加'})).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'展开：主题'}));
  expect(screen.getByRole('button',{name:'量子叠加'})).toBeTruthy();
});
