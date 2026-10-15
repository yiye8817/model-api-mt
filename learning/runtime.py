"""Lazy application wiring, independent of vector services and chat sockets."""
from pathlib import Path
import threading


class LearningRuntime:
    def __init__(self, data_dir, session_factory, get_providers, cli_available, get_local_store=None, get_content_store=None, semantic_lookup=None):
        self.data_dir, self.session_factory = Path(data_dir), session_factory
        self.get_providers, self.cli_available = get_providers, cli_available
        self.get_local_store, self.get_content_store, self.semantic_lookup = get_local_store, get_content_store, semantic_lookup
        self._service = None
        self.lock = threading.RLock()

    def components(self):
        with self.lock:
            if self._service is None:
                from .store import LearningStore
                from .hermes import HermesClient
                from .jobs import LearningJobs
                from .sources import SourceSynchronizer
                from .analysis import DocumentAnalyzer
                from .retrieval import Retriever
                from .graph import GraphService
                from .archives import ArchiveService
                from .service import LearningService
                store = LearningStore(self.data_dir)
                hermes = HermesClient(self.session_factory,self.get_providers,self.cli_available,self.data_dir/'runtime')
                jobs = LearningJobs(store)
                service = LearningService(store,jobs,hermes,Retriever(store,self.semantic_lookup),DocumentAnalyzer(store,hermes),
                    GraphService(store),SourceSynchronizer(store,self.get_local_store,self.get_content_store),ArchiveService(store,hermes))
                for kind, handler in [('ingest',service.ingest_job),('analysis',service.analyzer.run),('question',service.answer_job),
                                      ('exploration',service.explore_job),('archive',service.archives.run)]:
                    jobs.register(kind,handler)
                self._service = service
                jobs.recover()
            return self._service

    def close(self):
        with self.lock:
            if self._service:
                self._service.jobs.shutdown()
