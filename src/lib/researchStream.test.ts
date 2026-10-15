import { expect, it } from 'vitest';
import { consumeResearchStream } from './researchStream';

it('handles UTF-8 and SSE frames split across network chunks',async()=>{
  const bytes=new TextEncoder().encode('data: {"type":"result","channel":"google","result":{"id":"1","kind":"source","channel":"google","title":"中文来源","url":"https://example.org"}}\r\n\r\ndata: {"type":"complete","answer":"综合回答"}\r\n\r\n');
  const received:unknown[]=[];
  const response=new Response(new ReadableStream({start(controller){for(let i=0;i<bytes.length;i+=7)controller.enqueue(bytes.slice(i,i+7));controller.close();}}));
  const result=await consumeResearchStream(response,new AbortController().signal,event=>received.push(event));
  expect(result.answer).toBe('综合回答');expect(received).toHaveLength(2);
  expect((received[0] as {result:{title:string}}).result.title).toBe('中文来源');
});

it('an interrupted stream retains prior results and cannot be treated as a completed answer',async()=>{
  const received:unknown[]=[];
  const response=new Response('data: {"type":"status","channel":"provider","status":"error","detail":"provider不可用"}\n\ndata: {"type":"result","channel":"ddgs","result":{"id":"d","channel":"ddgs","kind":"source","title":"部分结果","url":"https://example.org"}}\n\n');
  await expect(consumeResearchStream(response,new AbortController().signal,event=>received.push(event))).rejects.toThrow('未返回完成结果');
  expect(received).toHaveLength(2);
});
