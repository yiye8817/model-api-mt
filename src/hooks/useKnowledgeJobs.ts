import {useEffect,useState,useCallback,useRef} from 'react';
import type {JobSnapshot} from '../lib/knowledgeTypes';

export function useKnowledgeJobs(jobId:string|null, options:{notify?:boolean}={}) {
  const [job,setJob]=useState<JobSnapshot|null>(null),[jobs,setJobs]=useState<JobSnapshot[]>([]),[error,setError]=useState<string|null>(null);
  const notify=options.notify!==false;const notified=useRef<Set<string>>(new Set());
  useEffect(()=>{
    setJob(null);setJobs([]);setError(null);
    let stopped=false;let timer:ReturnType<typeof setTimeout>|undefined;const controller=new AbortController();
    const poll=async()=>{
      try{
        const response=await fetch(jobId?`/api/knowledge/jobs/${encodeURIComponent(jobId)}`:'/api/knowledge/jobs?limit=20',{signal:controller.signal});
        if(!response.ok)throw new Error('无法读取索引任务');
        const data=await response.json();if(stopped)return;
        const list:JobSnapshot[]=jobId?(data.job?[data.job]:[]):(Array.isArray(data.jobs)?data.jobs:[]);
        if(list.length){setJobs(list);setJob(jobId?list[0]:list.find(item=>!['done','failed','cancelled'].includes(item.status))||list[0]);}
        for(const item of list){
          if(!notify||!['done','failed','cancelled'].includes(item.status)||!item.notification_key)continue;
          const key=item.notification_key;if(notified.current.has(key))continue;
          let already=false;try{already=sessionStorage.getItem(`knowledge-job:${key}`)==='1';if(!already)sessionStorage.setItem(`knowledge-job:${key}`,'1');}catch{}
          notified.current.add(key);
          if(!already)window.dispatchEvent(new CustomEvent('knowledge-job-terminal',{detail:item}));
        }
        if(jobId&&list[0]&&!['done','failed','cancelled'].includes(list[0].status))timer=setTimeout(poll,500);
        else if(!jobId)timer=setTimeout(poll,1000);
      }catch(e){if(!stopped)setError(e instanceof Error?e.message:'任务查询失败');}
    };void poll();return()=>{stopped=true;controller.abort();if(timer)clearTimeout(timer);};
  },[jobId,notify]);
  const cancel=useCallback(async()=>{
    if(!jobId)return;const response=await fetch(`/api/knowledge/jobs/${encodeURIComponent(jobId)}/cancel`,{method:'POST'});
    if(!response.ok)setError('取消请求未被接受');
  },[jobId]);
  return {job,jobs,error,cancel};
}
