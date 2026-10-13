import {it,expect,vi} from 'vitest';
import {uploadKnowledgeFiles} from './knowledgeApi';

it('uploads valid files while preserving per-file oversize failures in the job',async()=>{
  const large=new File(['large'],'large.txt');Object.defineProperty(large,'size',{value:20*1024*1024+1});
  const good=new File(['text'],'good.txt');const calls:{url:string;body?:BodyInit|null}[]=[];
  vi.stubGlobal('fetch',vi.fn(async(input,init)=>{calls.push({url:String(input),body:init?.body});return Response.json({job_id:'upload-1'});}));
  await uploadKnowledgeFiles([large,good],()=>{});
  expect(JSON.parse(String(calls[0].body)).rejected_items).toEqual([{path:'large.txt',status:'failed',reason:'file_too_large'}]);
  const upload=calls[1].body as FormData;
  expect(upload.getAll('files')).toHaveLength(1);expect(upload.get('final')).toBe('true');
});
