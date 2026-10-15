import {expect,it,vi} from 'vitest';
import {act,renderHook,waitFor} from '@testing-library/react';
import {useLearningJobs} from './useLearningJobs';

it('stops observing when hidden and never cancels the backend task',async()=>{
  const fetcher=vi.fn(async(_url:RequestInfo|URL)=>Response.json({jobs:[],hermes:{available:true}}));
  vi.stubGlobal('fetch',fetcher);
  const hook=renderHook(({active})=>useLearningJobs(active),{initialProps:{active:true}});
  await waitFor(()=>expect(fetcher).toHaveBeenCalled());
  hook.rerender({active:false});
  const count=fetcher.mock.calls.length;
  await new Promise(r=>setTimeout(r,750));
  expect(fetcher.mock.calls.length).toBe(count);
  expect(fetcher.mock.calls.every(call=>!String(call[0]).includes('/cancel'))).toBe(true);
});

it('stops fetching terminal jobs and keeps a stable bounded history with every active job',async()=>{
  const job=(id:string,status='completed')=>({id,status,kind:'analysis',created_at:Number(id),updated_at:id==='1'?100:Number(id),document_revisions:{},phase:status,processed:0,total:0,message:''});
  let activeJobs=[job('1','running')];
  const fetcher=vi.fn(async(url:RequestInfo|URL)=>String(url).endsWith('/status')?Response.json({jobs:activeJobs}):Response.json({job:job(String(url).split('/').pop()!)}));
  vi.stubGlobal('fetch',fetcher);
  const hook=renderHook(()=>useLearningJobs(false));
  act(()=>{for(let i=2;i<=36;i++)hook.result.current.watch(String(i));});
  await act(async()=>{await hook.result.current.refresh();});
  expect(hook.result.current.jobs).toHaveLength(31);
  expect(hook.result.current.jobs[0].id).toBe('1');
  expect(hook.result.current.jobs.some(j=>j.id==='36')).toBe(true);
  const order=hook.result.current.jobs.map(j=>j.id);
  fetcher.mockClear();
  await act(async()=>{await hook.result.current.refresh();});
  expect(hook.result.current.jobs.map(j=>j.id)).toEqual(order);
  expect(fetcher.mock.calls.map(c=>String(c[0]))).toEqual(['/api/learning/status']);
  activeJobs=[];
  await act(async()=>{await hook.result.current.refresh();});
  expect(hook.result.current.jobs.find(j=>j.id==='1')?.status).toBe('completed');
  fetcher.mockClear();
  await act(async()=>{await hook.result.current.refresh();});
  expect(fetcher.mock.calls.map(c=>String(c[0]))).toEqual(['/api/learning/status']);
  hook.unmount();
});
