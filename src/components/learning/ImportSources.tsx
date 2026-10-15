import {useState} from 'react';
import {Upload,Link as LinkIcon,Loader2} from 'lucide-react';
import {learningJson,uploadLearningFiles} from '../../lib/learningApi';
import {button,input,errorMessage} from './shared';

export default function ImportSources({onWatchJob,onImported}:{onWatchJob:(id:string)=>void;onImported:()=>void}){
  const [url,setUrl]=useState(''),[busy,setBusy]=useState(false),[errors,setErrors]=useState<string[]>([]);
  const upload=async(files:File[])=>{
    setBusy(true);setErrors([]);
    try{await uploadLearningFiles(files,r=>{if(r.error)setErrors(old=>[...old,`${r.filename}：${r.error}`]);if(r.job_id)onWatchJob(r.job_id);});onImported();}
    finally{setBusy(false);}
  };
  const link=async()=>{
    setBusy(true);setErrors([]);
    try{const result=await learningJson<{job_id:string}>('/documents/link',{url});onWatchJob(result.job_id);setUrl('');onImported();}
    catch(e){setErrors([errorMessage(e)]);}finally{setBusy(false);}
  };
  return <div className="space-y-3 border-b border-slate-800 p-4">
    <label className={`${button} w-full cursor-pointer border-dashed py-4`}><Upload size={15}/>{busy?'正在导入…':'上传学习资料'}
      <input aria-label="上传学习资料" type="file" accept=".txt,.md,.markdown,.pdf,.docx" multiple disabled={busy} className="hidden" onChange={e=>{const files=Array.from(e.target.files||[]);e.target.value='';if(files.length)void upload(files);}}/>
    </label>
    <p className="text-[10px] leading-relaxed text-slate-500">PDF · DOCX · Markdown · TXT，单文件最多 20 MiB</p>
    <form className="flex gap-1" onSubmit={e=>{e.preventDefault();void link();}}><input aria-label="学习资料网页链接" className={`${input} w-full`} value={url} onChange={e=>setUrl(e.target.value)} placeholder="粘贴网页链接" type="url"/>
      <button aria-label="导入网页链接" title="导入网页链接" className={button} disabled={busy||!url.trim()}>{busy?<Loader2 size={13} className="animate-spin"/>:<LinkIcon size={13}/>}</button></form>
    {errors.length>0&&<div role="alert" className="max-h-32 overflow-auto text-xs leading-relaxed text-amber-300">{errors.map((e,i)=><p key={i}>{e}</p>)}</div>}
  </div>;
}
