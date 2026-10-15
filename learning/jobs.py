"""Bounded jobs whose cancellation and final result live in SQLite."""
from concurrent.futures import ThreadPoolExecutor
import threading

from .contracts import LearningError


class JobContext:
    def __init__(self, jobs, job_id, cancel_event):
        self.jobs, self.store, self.job_id, self.cancel_event = jobs, jobs.store, job_id, cancel_event

    def ensure_active(self):
        job = self.store.get_job(self.job_id)
        if self.cancel_event.is_set() or job['status'] not in ('queued', 'running'):
            raise LearningError('任务已取消')
        if not self.store.revisions_current(job['document_revisions']):
            raise LearningError('资料已更新或移除，请重新发起任务', 409)

    def progress(self, phase, processed=0, total=0, message=''):
        self.ensure_active()
        self.store.transition_job(self.job_id, ['running'], {'phase': phase, 'processed': processed, 'total': total, 'message': message})


class LearningJobs:
    def __init__(self, store, workers=2):
        self.store, self.handlers = store, {}
        self.executor = ThreadPoolExecutor(max_workers=workers, thread_name_prefix='learning')
        self.events, self.futures = {}, {}
        self.lock = threading.RLock()

    def register(self, kind, handler):
        self.handlers[kind] = handler

    def submit(self, kind, payload, revisions, dedupe_key=None):
        if kind not in self.handlers:
            raise LearningError('未知学习任务类型')
        with self.lock, self.store.lock:
            if dedupe_key:
                for job in self.store.active_jobs():
                    if job.get('dedupe_key') == dedupe_key:
                        return job
            job = self.store.create_job(kind, payload, revisions, dedupe_key)
            self._schedule(job)
            return job

    def _schedule(self, job):
        event = self.events[job['id']] = threading.Event()
        self.futures[job['id']] = self.executor.submit(self._run, job['id'], event)

    def _run(self, job_id, event):
        context = JobContext(self, job_id, event)
        try:
            if not self.store.transition_job(job_id, ['queued'], {'status': 'running'}):
                return
            job = self.store.get_job(job_id)
            context.ensure_active()
            result = self.handlers[job['kind']](job['payload'], context)
            with self.store.lock:
                context.ensure_active()
                self.store.transition_job(job_id, ['running'], {'status':'completed', 'phase':'completed', 'result':result})
        except Exception as exc:
            self.store.transition_job(job_id, ['queued','running'], {'status':'cancelled' if context.cancel_event.is_set() else 'failed', 'error':str(exc)[:800]})
            self.store.finish_job_documents(job_id, context.cancel_event.is_set(), str(exc)[:800])
        finally:
            with self.lock:
                self.events.pop(job_id, None)
                self.futures.pop(job_id, None)

    def cancel(self, job_id):
        with self.lock:
            event = self.events.get(job_id)
            if event:
                event.set()
            if self.store.transition_job(job_id, ['queued','running'], {'status':'cancelled', 'phase':'cancelled', 'message':'任务已取消'}):
                self.store.finish_job_documents(job_id, True, '任务已取消，可重新发起')
                future = self.futures.get(job_id)
                if future and future.cancel():
                    self.events.pop(job_id, None)
                    self.futures.pop(job_id, None)
        return self.store.get_job(job_id)

    def recover(self):
        with self.lock:
            for job in self.store.active_jobs():
                if job['status'] == 'running':
                    self.store.update_job(job['id'], status='failed', error='服务重启，中断了后台任务')
                    self.store.finish_job_documents(job['id'], False, '服务重启，中断了后台任务，请重试')
                elif job['kind'] in self.handlers:
                    self._schedule(job)

    def shutdown(self):
        with self.lock:
            for event in self.events.values():
                event.set()
        self.executor.shutdown(wait=True, cancel_futures=True)
