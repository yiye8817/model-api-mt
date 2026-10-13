import socket

import pytest


def test_no_default_embedding_download(tmp_path,monkeypatch):
    from local_knowledge.vectors import VectorIndex
    from local_knowledge.contracts import Chunk
    def reject_network(*args,**kwargs): raise AssertionError('No network during vector persistence')
    monkeypatch.setattr(socket,'create_connection',reject_network)
    index=VectorIndex(tmp_path,'embedding-model-1',2)
    index.upsert([Chunk('c1','s1',1,text='local')],[[1.,0.]])
    assert index.query([1.,0.],['s1'],20)==['c1']
    assert index.query([1.,0.],[],20)==[]


def test_vector_space_separated_by_fingerprint(tmp_path):
    from local_knowledge.vectors import VectorIndex
    from local_knowledge.contracts import Chunk
    a=VectorIndex(tmp_path,'first',2); a.upsert([Chunk('a','s1',1)],[[1.,0.]])
    b=VectorIndex(tmp_path,'second',2)
    assert b.query([1.,0.],['s1'],20)==[]
    a.delete('s1')
    assert a.query([1.,0.],['s1'],20)==[]


def test_chroma_failure_does_not_publish_revision(tmp_path):
    from local_knowledge.store import Store
    from local_knowledge.contracts import Source, Chunk
    from local_knowledge.retrieval import Retriever
    from local_knowledge.model_clients import Budget, ModelUnavailable
    from threading import Event
    store=Store(tmp_path); store.upsert_pending(Source('s1',content_hash='v1'),[Chunk('x',text='text')])
    class Models:
        def embed(self,texts,budget): return [[1.,0.] for _ in texts]
    class Vectors:
        def upsert(self,*args): raise ModelUnavailable('Chroma write failed')
    retriever=Retriever(store,Vectors(),Models())
    with pytest.raises(ModelUnavailable): retriever.index_revision('s1',1,Budget(30,Event()))
    assert store.visible_chunks()==[]


def test_restart_finishes_pending_cleanup(tmp_path):
    from local_knowledge.vectors import VectorIndex
    from local_knowledge.contracts import Chunk
    first=VectorIndex(tmp_path,'model',2)
    first.upsert([Chunk('c','source',1)],[[1.,0.]])
    restarted=VectorIndex(tmp_path,'model',2)
    restarted.delete('source')
    assert restarted.query([1.,0.],['source'],20)==[]
