import {useCallback,useEffect,useRef,useState} from 'react';
import {LearningHttpError,learningJson} from '../lib/learningApi';
import type {LearningJob,LearningStatus} from '../lib/learningTypes';

export function useLearningJobs(active:boolean){
  const [jobs,setJobs]=useState<LearningJob[]>([]),[version,setVersion]=useState(0),[error,setError]=useState('');
  const watched=useRef(new Set<string>());
  const generation=useRef(0);
  const watch=useCallback((id:string)=>{watched.current.add(id);setVersion(v=>v+1);},[]);
  const refresh=useCallback(async(signal?:AbortSignal)=>{
    const request=++generation.current;
    try{
      const status=await learningJson<LearningStatus>('/status',undefined,'GET',signal);
      const observed=new Map((status.jobs||[]).map(j=>[j.id,j]));
      // The status response already contains all active jobs. Fetch only newly watched
      // jobs or jobs that disappeared from that response, once to observe completion.
      const missing=[...watched.current].filter(id=>!observed.has(id)),gone=new Set<string>();
      let failure='';
      for(let offset=0;offset<missing.length;offset+=8){
        if(signal?.aborted||request!==generation.current)return;
        const ids=missing.slice(offset,offset+8);
        const results=await Promise.allSettled(ids.map(id=>learningJson<{job:LearningJob}>(`/jobs/${id}`,undefined,'GET',signal)));
        results.forEach((r,i)=>{
          if(r.status==='fulfilled')observed.set(r.value.job.id,r.value.job);
          else if(r.reason instanceof LearningHttpError&&r.reason.status===404)gone.add(ids[i]);
          else failure=r.reason instanceof Error?r.reason.message:'任务查询失败';
        });
      }
      if(signal?.aborted||request!==generation.current)return;
      gone.forEach(id=>watched.current.delete(id));
      observed.forEach(j=>{if(j.status==='queued'||j.status==='running')watched.current.add(j.id);else watched.current.delete(j.id);});
      setJobs(previous=>{
        const map=new Map(previous.map(j=>[j.id,j]));
        gone.forEach(id=>map.delete(id));
        observed.forEach(j=>map.set(j.id,j));
        const active=(j:LearningJob)=>j.status==='queued'||j.status==='running';
        const sorted=[...map.values()].sort((a,b)=>(b.updated_at||b.created_at||0)-(a.updated_at||a.created_at||0)||b.id.localeCompare(a.id));
        return [...sorted.filter(active),...sorted.filter(j=>!active(j)).slice(0,30)];
      });
      setError(failure);
    }catch(e){if(!signal?.aborted&&request===generation.current)setError(e instanceof Error?e.message:'任务查询失败');}
  },[]);
  useEffect(()=>{
    if(!active)return;
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>;
    const tick=async()=>{await refresh(controller.signal);if(!controller.signal.aborted)timer=setTimeout(()=>void tick(),700);};
    void tick();return()=>{controller.abort();clearTimeout(timer);};
  },[active,version,refresh]);
  const cancel=useCallback(async(id:string)=>{await learningJson(`/jobs/${id}/cancel`,{});await refresh();},[refresh]);
  return {jobs,watch,cancel,refresh:()=>refresh(),error};
}
