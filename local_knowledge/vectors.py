import math
import threading
from pathlib import Path

from .config import stable_hash
from .model_clients import ModelUnavailable


class VectorIndex:
    def __init__(self,data_dir,embedding_fingerprint,dimension):
        self.data_dir=Path(data_dir); self.fingerprint=embedding_fingerprint
        self.dimension=dimension; self._client=None; self._collections={}; self._lock=threading.RLock()

    def _collection(self,dimension):
        if self.dimension and dimension!=self.dimension: raise ModelUnavailable('Vector dimension mismatch')
        self.dimension=dimension
        with self._lock:
            if dimension in self._collections: return self._collections[dimension]
            try:
                import chromadb
                from chromadb.config import Settings
                if self._client is None:
                    self._client=chromadb.PersistentClient(path=str(self.data_dir/'vectors'),settings=Settings(anonymized_telemetry=False))
                name='lk-'+stable_hash([self.fingerprint,dimension])[:40]
                collection=self._client.get_or_create_collection(name=name,embedding_function=None,metadata={'hnsw:space':'cosine'})
                self._collections[dimension]=collection
                return collection
            except Exception as exc: raise ModelUnavailable('Chroma local persistence is unavailable') from exc

    def upsert(self,chunks,embeddings):
        if not chunks: return
        if len(chunks)!=len(embeddings) or not embeddings[0]: raise ModelUnavailable('Vector count mismatch')
        dimension=len(embeddings[0])
        if any(len(v)!=dimension or any(type(x) not in (int,float) or not math.isfinite(x) for x in v) for v in embeddings): raise ModelUnavailable('Invalid local vectors')
        try:
            self._collection(dimension).upsert(ids=[c.id for c in chunks],embeddings=[list(v) for v in embeddings],
                metadatas=[{'source_id':c.source_id,'revision':c.revision,'ordinal':c.ordinal} for c in chunks])
        except ModelUnavailable: raise
        except Exception as exc: raise ModelUnavailable('Chroma vector write failed') from exc

    def query(self,vector,source_ids,limit):
        if not source_ids: return []
        try:
            collection=self._collection(len(vector))
            count=collection.count()
            if not count: return []
            result=collection.query(query_embeddings=[list(vector)],n_results=min(limit,count),where={'source_id':{'$in':list(source_ids)}},include=['distances'])
            return result['ids'][0]
        except ModelUnavailable: raise
        except Exception as exc: raise ModelUnavailable('Chroma vector query failed') from exc

    def delete(self,source_id):
        with self._lock:
            try:
                if self._client is None:
                    import chromadb
                    from chromadb.config import Settings
                    self._client=chromadb.PersistentClient(path=str(self.data_dir/'vectors'),settings=Settings(anonymized_telemetry=False))
                for entry in self._client.list_collections():
                    name=entry if isinstance(entry,str) else entry.name
                    if name.startswith('lk-'):
                        self._client.get_collection(name,embedding_function=None).delete(where={'source_id':source_id})
            except Exception as exc: raise ModelUnavailable('Chroma vector cleanup failed') from exc
