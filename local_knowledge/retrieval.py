import re

from .contracts import Candidate
from .model_clients import ModelUnavailable
from .text import keyword_tokens


def effective_scope(store,requested,selected):
    enabled=[s.id for s in store.list_sources() if s.enabled and s.status=='indexed']
    allowed=set(selected) if selected else set(enabled)
    if requested: allowed &= set(requested)
    return sorted(set(enabled)&allowed)


def keyword_search(store,question,source_ids,limit=20):
    if not source_ids: return []
    tokens=keyword_tokens(question)[:512]
    if not tokens: return []
    query=' OR '.join('"'+t.replace('"','""')+'"' for t in tokens)
    placeholders=','.join('?' for _ in source_ids)
    sql=f"""SELECT chunks_fts.chunk_id,bm25(chunks_fts) AS score
      FROM chunks_fts JOIN chunks c ON c.id=chunks_fts.chunk_id JOIN sources s ON s.id=c.source_id
      WHERE chunks_fts MATCH ? AND s.enabled=1 AND s.status='indexed'
      AND c.status='indexed' AND c.revision=s.revision AND s.id IN ({placeholders})
      ORDER BY score,chunks_fts.chunk_id LIMIT ?"""
    return [r['chunk_id'] for r in store.connection.execute(sql,[query,*source_ids,limit])]


def keyword_phrase_search(store, question, source_ids, limit=20):
    """Find chunks containing the literal multi-token heading phrase."""
    if not source_ids:
        return []
    tokens = keyword_tokens(question)
    if len(tokens) < 2 or any(not re.fullmatch(r'[a-z0-9_.-]+', token) for token in tokens):
        return []
    phrase = '"' + ' '.join(token.replace('"', '""') for token in tokens) + '"'
    placeholders = ','.join('?' for _ in source_ids)
    sql = f"""SELECT chunks_fts.chunk_id FROM chunks_fts
      JOIN chunks c ON c.id=chunks_fts.chunk_id JOIN sources s ON s.id=c.source_id
      WHERE chunks_fts MATCH ? AND s.enabled=1 AND s.status='indexed'
      AND c.status='indexed' AND c.revision=s.revision AND s.id IN ({placeholders})
      LIMIT ?"""
    return [r['chunk_id'] for r in store.connection.execute(sql, [phrase, *source_ids, limit])]


def reciprocal_rank_fusion(first,second,limit=20):
    scores={}
    for items in (first,second):
        for rank,identifier in enumerate(dict.fromkeys(items),1): scores[identifier]=scores.get(identifier,0)+1/(60+rank)
    return sorted(scores,key=lambda key:(-scores[key],key))[:limit]


class Retriever:
    def __init__(self,store,vectors,models):
        self.store=store; self.vectors=vectors; self.models=models

    def index_revision(self,source_id,revision,budget):
        budget.check(); source=self.store.get_source(source_id)
        if not source or source.revision!=revision or source.status not in ('pending','indexed'): raise ModelUnavailable('Source revision changed')
        chunks=self.store.revision_chunks(source_id,revision)
        for start in range(0,len(chunks),16):
            part=chunks[start:start+16]; embeddings=self.models.embed([c.text for c in part],budget)
            self.vectors.upsert(part,embeddings); budget.check()
        source=self.store.get_source(source_id)
        if not source or source.revision!=revision or source.status not in ('pending','indexed'): raise ModelUnavailable('Source revision changed before publication')
        if source.status=='pending' and not self.store.activate_revision(source_id,revision): raise ModelUnavailable('Index publication failed')

    def retrieve(self,question,source_ids,budget,allow_degraded=False):
        if not source_ids: return []
        config=getattr(self.models,'config',{})
        limit=config.get('vector_top_k',20)
        second=keyword_search(self.store,question,source_ids,limit)
        try:
            vector=self.models.embed([question],budget)[0]
            budget.check()
            first=self.vectors.query(vector,source_ids,limit)
        except ModelUnavailable:
            if not allow_degraded:
                raise
            # A document remains useful when a configured embedding service is
            # temporarily down. FTS is the deterministic local fallback.
            first=[]
        merged=reciprocal_rank_fusion(first,second,limit)
        visible={c.id:c for c in self.store.visible_chunks(source_ids)}
        candidates=[Candidate(visible[key]) for key in merged if key in visible]
        budget.check()
        try:
            ranked=self.models.rerank(question,candidates,budget)
        except ModelUnavailable:
            if not allow_degraded:
                raise
            ranked=candidates
        return ranked[:config.get('rerank_top_k',5)]

    def evidence_units(self,candidates,token_budget,budget):
        result=[]; seen=set(); remaining=token_budget
        visible={c.id:c for c in self.store.visible_chunks()}
        for candidate in candidates:
            chunk=candidate.chunk
            if chunk.id not in visible or chunk.id in seen: continue
            if chunk.continuation_group:
                group=[c for c in visible.values() if c.source_id==chunk.source_id and c.revision==chunk.revision and c.continuation_group==chunk.continuation_group]
                group.sort(key=lambda c:c.ordinal)
            else: group=[visible[chunk.id]]
            cost=self.models.count_tokens('\n'.join(c.text for c in group),budget)
            if cost<=remaining:
                result.extend(c for c in group if c.id not in seen)
                seen.update(c.id for c in group); remaining-=cost
            budget.check()
        return result
