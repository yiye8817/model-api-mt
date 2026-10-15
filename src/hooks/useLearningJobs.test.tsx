import {expect,it,vi} from 'vitest';
import {renderHook,waitFor} from '@testing-library/react';
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
