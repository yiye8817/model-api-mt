import { describe, it, expect, vi } from 'vitest';
import type { KnowledgeQueryRequest } from './knowledgeTypes';
import { checkLocalFirst, createRequestGuard } from './knowledgeRouting';

const request:KnowledgeQueryRequest={request_id:'r',question:'A 保修期？',context:[],system_constraints:'中文',source_ids:[],mode:'api',online_target:null,parameters:{}};
const options=()=>({enabled:true,onlineFallback:true,signal:new AbortController().signal});
const response=(decision:string,status=200)=>new Response(JSON.stringify({request_id:'r',decision,reason:decision==='miss'?'empty_index':'',answer:decision==='hit'?'三年':null,citations:decision==='hit'?[{source_id:'manual',source_kind:'document',title:'手册',chunk_id:'chunk',revision:1,locator:{kind:'file',path:'/fixture/manual.md'},position:{kind:'lines',start_line:1,end_line:1},quote:'A 型号保修三年'}]:[],trace:[],local_model:'local',duration_ms:1,answer_origin:'local_generated'}),{status,headers:{'Content-Type':'application/json'}});

describe('local first gate',()=>{
  it('returns hit only after a complete local result',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>response('hit')));
    expect((await checkLocalFirst(request,options())).decision).toBe('hit');
  });
  it('500 falls back but invalid input and disabled fallback are blocked',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>response('miss',500)));
    expect((await checkLocalFirst(request,options())).decision).toBe('fallback');
    vi.stubGlobal('fetch',vi.fn(async()=>response('miss',400)));
    expect((await checkLocalFirst(request,options())).decision).toBe('blocked');
    vi.stubGlobal('fetch',vi.fn(async()=>response('miss')));
    expect((await checkLocalFirst(request,{...options(),onlineFallback:false})).decision).toBe('blocked');
  });
  it('cancellation and late results never fall back',async()=>{
    const controller=new AbortController();
    vi.stubGlobal('fetch',vi.fn(async()=>{controller.abort();return response('miss');}));
    expect((await checkLocalFirst(request,{...options(),signal:controller.signal})).decision).toBe('cancelled');
  });
  it('old completion cannot clear the current request',()=>{
    const guard=createRequestGuard();let value='new';guard.start('old');guard.start('new');
    expect(guard.finishRequest('old',()=>{value='wrong';})).toBe(false);
    expect(value).toBe('new');
    expect(guard.finishRequest('new',()=>{value='done';})).toBe(true);
    expect(value).toBe('done');
  });
});
