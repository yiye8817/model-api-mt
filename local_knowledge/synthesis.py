"""Combine relevant source sentences and retain per-source quotations."""
import re
from dataclasses import asdict,replace

from .contracts import Citation,QueryResult
from .diagnostics import log_event
from .intents import parse_knowledge_question,topic_key
from .lookup import plain_text


def facts(text,topic,facet,assume_topic=False):
    readable=plain_text(text).replace('**','').replace('`','')
    result=[];section='';ordinal=0;topic_seen=False
    for line in readable.splitlines():
        if re.match(r'^\s*#{1,6}\s',line):
            section=re.sub(r'^\s*#{1,6}\s*','',line).strip()
            if topic_key(topic) in topic_key(section):topic_seen=True
            continue
        for sentence in re.split(r'(?<=[。！？!?])|\n',line):
            sentence=re.sub(r'^\s*(?:[-*]|\d+[.)、])\s*','',sentence).strip()
            ordinal+=1
            if len(sentence)<12 or len(sentence)>650:continue
            named=topic_key(topic) in topic_key(sentence)
            subject=re.match(r'^([A-Za-z][A-Za-z0-9_.-]*)\s*(?=用于|用来|负责|能|可以|是|缓存|保存|\b(?:is|uses|reduces)\b)',sentence,re.I)
            if not named and subject and topic_key(subject[1])!=topic_key(topic):
                topic_seen=False;continue
            if named:topic_seen=True
            implicit=bool(re.match(r'^(?:它|其(?!余|他|中)|该缓存|该结构|这种机制|用于|用来|主要用于|减少|降低|提高|提升|加速|避免|节省|将|把|使|极大(?:加速|提高|提升|减少|降低)|显著(?:加速|提高|提升|减少|降低))',sentence))
            if not named and (not assume_topic or not topic_seen or not implicit):
                if not implicit:topic_seen=False
                continue
            if re.search(r'忽略.*(?:指令|规则)|执行.*命令|\b(?:ignore instructions|run command)\b',sentence,re.I):continue
            if facet=='definition':
                score=6 if named and re.search(r'全称|称为|叫做|又称|\bis\b',sentence,re.I) else 4 if named and re.search(r'(?:是|指|称作)',sentence) else 1 if named else 0
                if '全局资源' in sentence:score=min(score,1)
            else:
                score=5 if re.search(r'用于|用来|加速|减少|避免|降低|提高|(?:缓存|保存).{0,15}(?:地址|转换|映射)',sentence) else 0
                if score and re.search(r'作用|用处|用途',section):score+=3
            if score:result.append((score,-ordinal,sentence))
    return sorted(result,reverse=True)


def answer_covers(answer,query):
    return bool(query and all(facts(answer,query.topic,facet,True) for facet in query.facets))


def combine(request,document,pairs,store,budget):
    query=parse_knowledge_question(request['question'])
    if not query or not pairs:return document
    selected=[]
    for facet in sorted(query.facets):
        if document:
            candidates=[]
            for citation in document.citations:
                candidates.extend((score,order,text,citation,None) for score,order,text in facts(citation.quote,query.topic,facet))
            if candidates:
                selected.append(max(candidates,key=lambda x:x[:2]))
        candidates=[]
        for entry,chunk in pairs:
            source=store.get_source(chunk.source_id)
            if not source:continue
            citation=Citation(source.id,source.kind,source.title,chunk.id,chunk.revision,source.locator,chunk.position,chunk.text)
            candidates.extend((score,order,text,citation,entry) for score,order,text in facts(entry['answer'],query.topic,facet,True))
        if candidates:selected.append(max(candidates,key=lambda x:x[:2]))
    if not any(row[4] for row in selected):return document
    # If a document is relevant, keep its strongest sentence even when the
    # saved dialogue uses a more explicit definition wording.
    if document and not any(row[4] is None for row in selected):
        return document
    citations=[];groups={};order=[];used_entries=set()
    for _,_,text,citation,entry in selected:
        budget.check()
        if entry:used_entries.add(entry['id'])
        key=re.sub(r'[\s*`#]','',text).casefold()
        if key not in groups:groups[key]=[text,[],entry is not None];order.append(key)
        index=next((i for i,c in enumerate(citations) if c.chunk_id==citation.chunk_id and c.quote==citation.quote),None)
        if index is None:index=len(citations);citations.append(citation)
        if index+1 not in groups[key][1]:groups[key][1].append(index+1)
        if entry is None:groups[key][2]=False
    sentences=[]
    for key in order:
        text,indices,historical=groups[key]
        # Historical model text keeps attribution instead of becoming a new
        # independent factual authority through synthesis.
        prefix='已保存对话补充说明：' if historical else ''
        sentences.append(prefix+text+' '+''.join(f'[{i}]' for i in indices))
    log_event('knowledge.synthesis',request_id=request['request_id'],question=request['question'],
        document_sources=sorted({c.source_id for c in citations if c.source_kind=='document'}),
        history_sources=sorted({c.source_id for c in citations if c.source_kind!='document'}),
        saved_entry_ids=sorted(used_entries),method='quoted_evidence',answer='\n\n'.join(sentences))
    return QueryResult(request['request_id'],'hit',answer='\n\n'.join(sentences),citations=citations,
        trace=[*(document.trace if document else []),{'stage':'local_synthesis','status':'done','method':'quoted_evidence',
            'document_count':len({c.source_id for c in citations if c.source_kind=='document'}),
            'history_count':len({c.source_id for c in citations if c.source_kind!='document'}),'saved_entry_ids':sorted(used_entries)}],
        answer_origin='local_synthesis')
