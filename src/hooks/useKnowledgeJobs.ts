import {useEffect,useState,useCallback} from 'react';
import type {JobSnapshot} from '../lib/knowledgeTypes';

export function useKnowledgeJobs(jobId:string|null) {
  const [job,setJob]=useState<JobSnapshot|null>(null),[error,setError]=useState<string|null>(null);
  useEffect(()=>{
    setJob(null);setError(null);if(!jobId)return;
    let stopped=false;let timer:ReturnType<typeof setTimeout>|undefined;const controller=new AbortController();
    const poll=async()=>{
      try{
        const response=await fetch(`/api/knowledge/jobs/${encodeURIComponent(jobId)}`,{signal:controller.signal});
        if(!response.ok)throw new Error('无法读取索引任务');
        const data=await response.json();if(stopped)return;setJob(data.job);
        if(!['done','failed','cancelled'].includes(data.job.status))timer=setTimeout(poll,500);
      }catch(e){if(!stopped)setError(e instanceof Error?e.message:'任务查询失败');}
    };void poll();return()=>{stopped=true;controller.abort();if(timer)clearTimeout(timer);};
  },[jobId]);
  const cancel=useCallback(async()=>{
    if(!jobId)return;const response=await fetch(`/api/knowledge/jobs/${encodeURIComponent(jobId)}/cancel`,{method:'POST'});
    if(!response.ok)setError('取消请求未被接受');
  },[jobId]);
  return {job,error,cancel};
}
