from threading import Event


def setup_sources(tmp_path):
    from local_knowledge.store import Store
    from local_knowledge.contracts import Source, Chunk
    from local_knowledge.text import keyword_tokens
    store=Store(tmp_path)
    for i,text in enumerate(['X-2 v1.2 的保修期为三年。','型号 B 的保修期为两年。']):
        sid=f's{i}'
        revision=store.upsert_pending(Source(sid,content_hash=str(i)),[Chunk(str(i),text=text,keyword_text=' '.join(keyword_tokens(text)))])
        store.activate_revision(sid,revision)
    return store


def test_chinese_and_version_keyword_search(tmp_path):
    from local_knowledge.retrieval import keyword_search
    store=setup_sources(tmp_path)
    results=keyword_search(store,'X-2 v1.2 保修',['s0','s1'],20)
    assert results[0] in [c.id for c in store.visible_chunks(['s0'])]


def test_fts_punctuation_is_escaped(tmp_path):
    from local_knowledge.retrieval import keyword_search
    store=setup_sources(tmp_path)
    for question in ['"', 'OR (x) NOT', 'a/b\\c v1.2', '', '保修期']:
        assert isinstance(keyword_search(store,question,['s0','s1'],20),list)
    assert keyword_search(store,'保修',[],20)==[]


def test_deleted_vector_rechecked_in_sqlite(tmp_path):
    from local_knowledge.retrieval import Retriever
    from local_knowledge.model_clients import Budget
    store=setup_sources(tmp_path); old=[c.id for c in store.visible_chunks()]
    store.invalidate_source('s0')
    class Models:
        config={'vector_top_k':20,'rerank_top_k':5}
        def embed(self,*args): return [[1.,0.]]
        def rerank(self,q,candidates,budget): return candidates
    class Vectors:
        def query(self,*args): return old
    results=Retriever(store,Vectors(),Models()).retrieve('保修',['s0','s1'],Budget(30,Event()))
    assert [c.chunk.source_id for c in results]==['s1']


def test_rrf_limits_and_dedup(tmp_path):
    from local_knowledge.retrieval import reciprocal_rank_fusion
    first=[str(i) for i in range(20)]; second=list(reversed(first))
    merged=reciprocal_rank_fusion(first,second,20)
    assert len(merged)==20 and len(set(merged))==20
    assert reciprocal_rank_fusion(['a','b'],['a','c'],20)[0]=='a'


def test_disabled_explicit_scope_cannot_expand(tmp_path):
    from local_knowledge.retrieval import effective_scope
    store=setup_sources(tmp_path); store.set_enabled('s0',False)
    assert effective_scope(store,['s0'],[])==[]
    assert effective_scope(store,[],[])==['s1']


def test_adjacent_code_units_respect_budget(tmp_path):
    from local_knowledge.retrieval import Retriever
    from local_knowledge.model_clients import Budget
    from local_knowledge.contracts import Source,Chunk,Candidate
    from local_knowledge.store import Store
    store=Store(tmp_path)
    store.upsert_pending(Source('s',content_hash='v'),[Chunk('a',text='abc',continuation_group='g'),Chunk('b',text='def',continuation_group='g')]);store.activate_revision('s',1)
    class Models:
        def count_tokens(self,text,budget): return len(text)
    r=Retriever(store,None,Models())
    candidates=[Candidate(store.visible_chunks()[0])]
    assert r.evidence_units(candidates,2,Budget(30,Event()))==[]
    assert len(r.evidence_units(candidates,10,Budget(30,Event())))==2
