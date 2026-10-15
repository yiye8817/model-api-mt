import threading
import time

from learning.jobs import LearningJobs


def wait_terminal(store, job_id):
    deadline = time.monotonic()+3
    while time.monotonic() < deadline:
        job = store.get_job(job_id)
        if job['status'] in ('completed','failed','cancelled'):
            return job
        time.sleep(.01)
    raise AssertionError('任务没有结束')


def test_cancel_does_not_publish_late_results(store):
    started, release = threading.Event(), threading.Event()
    def handler(payload, context):
        started.set(); release.wait(2)
        return {'answer':'迟到结果'}
    jobs = LearningJobs(store)
    jobs.register('question', handler)
    try:
        job = jobs.submit('question', {}, {})
        assert started.wait(1)
        jobs.cancel(job['id']); release.set()
        assert wait_terminal(store, job['id'])['status'] == 'cancelled'
        assert store.get_job(job['id'])['result'] is None
    finally:
        release.set(); jobs.shutdown()


def test_recovery_and_deduplication(store):
    started, release = threading.Event(), threading.Event()
    def handler(payload, context):
        started.set(); release.wait(2); context.ensure_active()
        return {'ok': True}
    queued = store.create_job('analysis', {}, {}, 'same')
    running = store.create_job('analysis', {}, {}, 'interrupted')
    store.update_job(running['id'], status='running')
    jobs = LearningJobs(store); jobs.register('analysis', handler)
    try:
        jobs.recover()
        assert started.wait(1)
        assert store.get_job(running['id'])['status'] == 'failed'
        assert '中断' in store.get_job(running['id'])['error']
        assert jobs.submit('analysis', {}, {}, 'same')['id'] == queued['id']
        release.set()
        assert wait_terminal(store, queued['id'])['status'] == 'completed'
    finally:
        release.set(); jobs.shutdown()


def test_updated_revision_fails_running_job(store, source, chunks):
    doc = store.upsert_document(source, chunks)
    started, release = threading.Event(), threading.Event()
    def handler(payload, context):
        started.set(); release.wait(2); context.ensure_active()
        return {'ok':True}
    jobs = LearningJobs(store); jobs.register('analysis', handler)
    try:
        job = jobs.submit('analysis', {}, {doc['id']:1})
        assert started.wait(1)
        store.upsert_document({**source,'content_hash':'new'}, chunks)
        release.set()
        assert wait_terminal(store, job['id'])['status'] == 'failed'
    finally:
        release.set(); jobs.shutdown()


def test_recovery_marks_interrupted_document_as_retryable(store,source,chunks):
    doc=store.upsert_document(source,chunks)
    store.set_document_state(doc['id'],'analyzing')
    job=store.create_job('analysis',{'document_ids':[doc['id']]},{doc['id']:1})
    store.update_job(job['id'],status='running')
    jobs=LearningJobs(store)
    try:
        jobs.recover()
        assert store.get_document(doc['id'])['status']=='failed'
        assert '中断' in store.get_document(doc['id'])['last_error']
    finally:
        jobs.shutdown()
