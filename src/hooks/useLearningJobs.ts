import {useCallback,useEffect,useRef,useState} from 'react';
import {learningJson} from '../lib/learningApi';
import type {LearningJob,LearningStatus} from '../lib/learningTypes';

export function useLearningJobs(active:boolean){
  const [jobs,setJobs]=useState<LearningJob[]>([]),[version,setVersion]=useState(0),[error,setError]=useState('');
  const watched=useRef(new Set<string>());
  const watch=useCallback((id:string)=>{watched.current.add(id);setVersion(v=>v+1);},[]);
  const refresh=useCallback(async(signal?:AbortSignal)=>{
    try{
      const status=await learningJson<LearningStatus>('/status',undefined,'GET',signal);
      status.jobs?.forEach(j=>watched.current.add(j.id));
      const results=await Promise.allSettled([...watched.current].map(id=>learningJson<{job:LearningJob}>(`/jobs/${id}`,undefined,'GET',signal)));
      if(signal?.aborted)return;
      setJobs(previous=>{
        const map=new Map(previous.map(j=>[j.id,j]));
        results.forEach(r=>{if(r.status==='fulfilled')map.set(r.value.job.id,r.value.job);});
        return [...map.values()].slice(-30).reverse();
      });
      setError('');
    }catch(e){if(!signal?.aborted)setError(e instanceof Error?e.message:'任务查询失败');}
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
