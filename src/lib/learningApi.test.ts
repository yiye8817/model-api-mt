import {expect,it,vi} from 'vitest';
import {learningJson,uploadLearningFiles} from './learningApi';

it('preserves readable backend failures',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>Response.json({error:'资料已更新'},{status:409})));
  await expect(learningJson('/questions',{})).rejects.toThrow('资料已更新');
});

it('reports rejected files while uploading valid documents',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>Response.json({items:[{filename:'手册.md',document_id:'d',job_id:'j',error:null}],accepted:1,rejected:0})));
  const results:{filename:string;error?:string|null}[]=[];
  await uploadLearningFiles([new File(['text'],'手册.md'),new File(['fake'],'image.png')],r=>results.push(r));
  expect(results.map(r=>r.filename).sort()).toEqual(['image.png','手册.md']);
  expect(results.find(r=>r.filename==='image.png')?.error).toBeTruthy();
});
