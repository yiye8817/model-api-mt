import {useRef,useState,type ReactNode} from 'react';
import {Minus,Plus,Maximize2} from 'lucide-react';
import {button} from './shared';

export default function GraphViewport({width,height,label,children}:{width:number;height:number;label:string;children:ReactNode}){
  const [scale,setScale]=useState(1),[offset,setOffset]=useState({x:0,y:0});
  const drag=useRef<{x:number;y:number}|null>(null);
  return <div className="relative min-h-[380px] flex-1 overflow-hidden rounded-xl border border-slate-800 bg-slate-950/60">
    <div className="absolute right-3 top-3 z-10 flex gap-1 rounded-lg bg-slate-900/90 p-1">
      <button aria-label="缩小" className={button} onClick={()=>setScale(s=>Math.max(.25,s/1.25))}><Minus size={13}/></button>
      <span className="w-12 self-center text-center text-xs text-slate-400">{Math.round(scale*100)}%</span>
      <button aria-label="放大" className={button} onClick={()=>setScale(s=>Math.min(4,s*1.25))}><Plus size={13}/></button>
      <button aria-label="适配视图" className={button} onClick={()=>{setScale(1);setOffset({x:0,y:0});}}><Maximize2 size={13}/></button>
    </div>
    <svg role="img" aria-label={label} viewBox={`0 0 ${width} ${height}`} className="h-full min-h-[380px] w-full touch-none select-none"
      onPointerDown={e=>{drag.current={x:e.clientX,y:e.clientY};e.currentTarget.setPointerCapture?.(e.pointerId);}}
      onPointerMove={e=>{if(!drag.current)return;const rect=e.currentTarget.getBoundingClientRect();const ratio=width/(rect.width||width);
        setOffset(o=>({x:o.x+(e.clientX-drag.current!.x)*ratio,y:o.y+(e.clientY-drag.current!.y)*ratio}));drag.current={x:e.clientX,y:e.clientY};}}
      onPointerUp={()=>{drag.current=null;}} onPointerCancel={()=>{drag.current=null;}}>
      <g transform={`translate(${offset.x} ${offset.y}) translate(${width/2} ${height/2}) scale(${scale}) translate(${-width/2} ${-height/2})`}>{children}</g>
    </svg>
  </div>;
}
