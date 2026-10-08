import queue
import threading


class JobQueue:
    def __init__(self,store):
        self.store=store; self.queue=queue.Queue(); self.closed=False
        self.events={}
        self.thread=threading.Thread(target=self._run,name='local-knowledge-index',daemon=True)
        self.thread.start()

    def submit(self,job_id,callback):
        if self.closed: raise RuntimeError('Job queue is closed')
        self.queue.put((job_id,callback))

    def event(self,job_id):
        return self.events.setdefault(job_id,threading.Event())

    def _run(self):
        while True:
            task=self.queue.get()
            if task is None: self.queue.task_done(); return
            job_id,callback=task
            try: callback(job_id)
            except Exception as exc:
                self.store.update_job(job_id,status='failed',phase='failed',result={'error':str(exc)[:300]})
            finally: self.queue.task_done()

    def close(self):
        self.closed=True; self.queue.put(None); self.thread.join(2)
