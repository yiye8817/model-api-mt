import {useEffect,useMemo,useState} from 'react';
import type {LearningCitation,MindMapNode} from '../../lib/learningTypes';
import GraphViewport from './GraphViewport';
import {Citations} from './shared';

export default function MindMap({tree,onOpenCitation,selectedConceptId}:{tree:MindMapNode;onOpenCitation:(c:LearningCitation)=>void;selectedConceptId?:string|null}){
  const [collapsed,setCollapsed]=useState<Set<string>>(new Set()),[selected,setSelected]=useState<MindMapNode|null>(null);
  useEffect(()=>{
    if(!selectedConceptId)return;
    const find=(node:MindMapNode,path:string[]):{node:MindMapNode;path:string[]}|null=>{
      if(node.concept_id===selectedConceptId)return {node,path};
      for(const child of node.children){const found=find(child,[...path,node.id]);if(found)return found;}return null;
    };
    const found=find(tree,[]);if(!found)return;
    setCollapsed(old=>new Set([...old].filter(id=>!found.path.includes(id))));setSelected(found.node);
  },[tree,selectedConceptId]);
  const layout=useMemo(()=>{
    const nodes:{node:MindMapNode;x:number;y:number;parent?:string}[]=[];
    const visit=(node:MindMapNode,depth:number,parent?:string)=>{
      nodes.push({node,x:35+depth*260,y:80+nodes.length*72,parent});
      if(!collapsed.has(node.id))node.children.forEach(child=>visit(child,depth+1,node.id));
    };visit(tree,0);return nodes;
  },[tree,collapsed]);
  const byId=new Map(layout.map(n=>[n.node.id,n]));
  const width=Math.max(800,...layout.map(n=>n.x+250)),height=Math.max(420,layout.length*72+110);
  return <div className="flex min-h-0 flex-1 flex-col gap-3">
    <GraphViewport width={width} height={height} label="文档思维导图">
      {layout.filter(n=>n.parent).map(n=>{const p=byId.get(n.parent!)!;return <path key={n.node.id} d={`M${p.x+210},${p.y+24} C${p.x+240},${p.y+24} ${n.x-20},${n.y+24} ${n.x},${n.y+24}`} fill="none" stroke="#334155" strokeWidth={1.5}/>;})}
      {layout.map(({node,x,y})=><g key={node.id} transform={`translate(${x},${y})`} onPointerDown={e=>e.stopPropagation()}>
        <g role="button" tabIndex={0} aria-label={node.label} onClick={()=>setSelected(node)} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();setSelected(node);}}} className="cursor-pointer">
          <title>{node.label}</title><rect width={210} height={48} rx={9} fill={selected?.id===node.id||node.concept_id===selectedConceptId?'#064e3b':'#172033'} stroke={node.concept_id?'#10b981':'#475569'}/>
          <text x={13} y={21} fill="#e2e8f0" fontSize={12}>{node.label.slice(0,14)}</text>{node.label.length>14&&<text x={13} y={37} fill="#94a3b8" fontSize={11}>{node.label.slice(14,30)}{node.label.length>30?'…':''}</text>}
        </g>
        {node.children.length>0&&<g role="button" tabIndex={0} aria-label={`${collapsed.has(node.id)?'展开':'收起'}：${node.label}`} className="cursor-pointer"
          onClick={()=>setCollapsed(old=>{const next=new Set(old);if(next.has(node.id))next.delete(node.id);else next.add(node.id);return next;})}
          onKeyDown={e=>{if(e.key==='Enter')setCollapsed(old=>{const next=new Set(old);if(next.has(node.id))next.delete(node.id);else next.add(node.id);return next;});}}>
          <circle cx={224} cy={24} r={10} fill="#1e293b" stroke="#64748b"/><text x={220} y={28} fill="#cbd5e1" fontSize={12}>{collapsed.has(node.id)?'+':'−'}</text>
        </g>}
      </g>)}
    </GraphViewport>
    {selected&&<div className="rounded-xl border border-slate-700 bg-slate-900 p-4"><p className="text-sm font-medium">{selected.label}</p><Citations items={selected.citations||[]} onOpen={onOpenCitation}/></div>}
  </div>;
}
