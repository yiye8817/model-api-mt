import {expect,it,vi} from 'vitest';
import {render,screen,fireEvent} from '@testing-library/react';
import ArchiveView from './ArchiveView';

it('reads saved notes, exposes revision status and exports the saved archive',async()=>{
  const archive={id:'a',title:'学习归档',markdown:'已经保存的综合笔记',needs_update:true,category:'科学',documents:[],concepts:[],citations:[],created_at:1};
  vi.stubGlobal('fetch',vi.fn(async(url)=>String(url).endsWith('/archives/a')?Response.json({archive}):Response.json({items:[archive],total:1,page:1,page_size:30})));
  render(<ArchiveView scope={{mode:'all'}} onOpenDocument={()=>{}} onOpenCitation={()=>{}} onWatchJob={()=>{}}/>);
  fireEvent.click(await screen.findByRole('button',{name:'学习归档'}));
  expect(await screen.findByText('已经保存的综合笔记')).toBeTruthy();
  expect(screen.getByText(/资料已更新/)).toBeTruthy();
  expect(screen.getByRole('link',{name:'导出 Markdown'}).getAttribute('href')).toBe('/api/learning/archives/a/export?format=markdown');
});
