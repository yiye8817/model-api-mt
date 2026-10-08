"""Lazy wiring: importing Flask never requires Chroma or document packages."""
import threading
from pathlib import Path

from .config import default_config, stable_hash, validate_config


class Runtime:
    def __init__(self,data_dir,settings,conversations):
        self.data_dir=Path(data_dir);self.settings=settings;self.conversations=conversations
        self._store=None;self._components=None;self._fingerprint=None;self._lock=threading.RLock();self._recovered=False

    @property
    def store(self):
        with self._lock:
            if self._store is None:
                from .store import Store
                self._store=Store(self.data_dir)
            return self._store

    def components(self):
        config=validate_config(self.settings());fingerprint=stable_hash(config)
        with self._lock:
            if self._components and fingerprint==self._fingerprint: return self._components
            from .model_clients import ModelClients
            from .vectors import VectorIndex
            from .retrieval import Retriever
            from .service import KnowledgeService
            from .ingest import ImportManager
            from .chat_sync import ChatSynchronizer
            from .evaluation import EvaluationRunner
            models=ModelClients(config);vectors=VectorIndex(self.data_dir,stable_hash(config['embedding_endpoint']),0)
            retriever=Retriever(self.store,vectors,models)
            service=KnowledgeService(self.store,retriever,models,self.settings)
            if self._components:
                imports=self._components[1];sync=self._components[3]
            else:
                imports=ImportManager(self.store,self._index_current);sync=ChatSynchronizer(self.store,imports)
            evaluations=EvaluationRunner(service,self.store,imports.jobs)
            self._components=(service,imports,evaluations,sync);self._fingerprint=fingerprint
            if config['enabled'] and not self._recovered:
                sync.sync_snapshot(self.conversations(),collect=config['collect_api_chats'])
                imports.recover();self._recovered=True
            return self._components

    def _index_current(self,source_id,revision,budget):
        return self.components()[0].retriever.index_revision(source_id,revision,budget)

    def sync_after_save(self,conversations):
        config=self.settings()
        if not config.get('enabled') and self._store is None: return
        marker=self.data_dir/'sync-pending'
        try:
            service,imports,evaluations,sync=self.components()
            sync.sync_snapshot(conversations,collect=bool(config.get('enabled') and config.get('collect_api_chats')))
            marker.unlink(missing_ok=True)
        except Exception:
            self.data_dir.mkdir(parents=True,exist_ok=True);marker.write_text('reconcile persisted conversations before answering')
            if self._store:
                for source in self.store.list_sources():
                    if source.kind in ('api_chat','web_chat','web_synthesis'): self.store.invalidate_source(source.id,status='stale')
            raise

    def close(self):
        if self._components: self._components[1].close()
