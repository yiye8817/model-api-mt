import type {UploadResult} from './learningTypes';

export class LearningHttpError extends Error {
  constructor(public status:number,message:string){super(message);}
}

export async function learningJson<T>(path:string,body?:unknown,method=body===undefined?'GET':'POST',signal?:AbortSignal):Promise<T>{
  const response=await fetch(path.startsWith('/api/')?path:'/api/learning'+path,{method,signal,
    headers:body===undefined?undefined:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  const data=await response.json().catch(()=>({error:'无法读取服务响应'}));
  if(!response.ok)throw new LearningHttpError(response.status,data.error||'知识学习操作失败');
  return data as T;
}

export async function uploadLearningFiles(files:File[],onResult:(result:UploadResult)=>void):Promise<void>{
  const accepted=files.filter(file=>{
    const error=file.size>20*1024*1024?'单文件不能超过 20 MiB':!/\.(txt|md|markdown|pdf|docx)$/i.test(file.name)?'文件格式不支持':file.size===0?'文件内容不能为空':null;
    if(error)onResult({filename:file.name,error});
    return !error;
  });
  const batches:File[][]=[];let group:File[]=[],size=0;
  for(const file of accepted){if(size+file.size>40*1024*1024&&group.length){batches.push(group);group=[];size=0;}group.push(file);size+=file.size;}
  if(group.length)batches.push(group);
  for(const batch of batches){
    const data=new FormData();batch.forEach(f=>data.append('files',f,f.name));
    try{
      const response=await fetch('/api/learning/documents/upload',{method:'POST',body:data});
      const result=await response.json();if(!response.ok)throw new Error(result.error||'上传失败');
      (result.items as UploadResult[]).forEach(onResult);
    }catch(error){batch.forEach(file=>onResult({filename:file.name,error:error instanceof Error?error.message:'上传失败'}));}
  }
}
