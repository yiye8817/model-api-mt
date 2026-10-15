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

it('expands the ancestor branch when locating a knowledge point',()=>{
  const tree={id:'r',label:'文档主题',citations:[],children:[{id:'c',label:'深层概念',concept_id:'concept-a',children:[],citations:[]}]};
  const component=render(<MindMap tree={tree} onOpenCitation={()=>{}}/>);
  fireEvent.click(screen.getByRole('button',{name:'收起：文档主题'}));
  component.rerender(<MindMap tree={tree} onOpenCitation={()=>{}} selectedConceptId="concept-a"/>);
  expect(screen.getByRole('button',{name:'深层概念'})).toBeTruthy();
});
