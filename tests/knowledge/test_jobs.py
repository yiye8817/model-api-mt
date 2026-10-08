import time


def wait_job(manager,job_id):
    deadline=time.monotonic()+5
    while time.monotonic()<deadline:
        job=manager.snapshot(job_id)
        if job['status'] in ('done','failed','cancelled','waiting_index'): return job
        time.sleep(.02)
    raise AssertionError('job did not finish')


def test_partial_success_and_restart_recovery(tmp_path):
    from local_knowledge.ingest import ImportManager
    from local_knowledge.store import Store
    root=tmp_path/'documents'; root.mkdir()
    (root/'good.txt').write_text('保修三年')
    (root/'bad.txt').write_bytes(b'\xff\x00')
    store=Store(tmp_path/'data')
    manager=ImportManager(store)
    try:
        job=wait_job(manager,manager.enqueue({'kind':'paths','roots':[str(root)]}))
        assert job['succeeded']==1 and job['failed']==1
        assert store.visible_chunks() == []
    finally: manager.close()
    resumed=[]
    manager=ImportManager(store,lambda source_id,revision,budget: (resumed.append(source_id),store.activate_revision(source_id,revision)))
    try:
        manager.recover()
        recovered=wait_job(manager,job['id'])
        assert recovered['status']=='done'
        assert len(store.visible_chunks())==1
    finally: manager.close()


def test_cancel_keeps_revision_unpublished(tmp_path):
    from local_knowledge.ingest import ImportManager
    from local_knowledge.store import Store
    root=tmp_path/'documents'; root.mkdir(); (root/'x.txt').write_text('sample')
    store=Store(tmp_path/'data')
    def index(source_id,revision,budget):
        time.sleep(.15)
        budget.check()
        store.activate_revision(source_id,revision)
    manager=ImportManager(store,index)
    try:
        job_id=manager.enqueue({'kind':'paths','roots':[str(root)]})
        assert manager.cancel(job_id)
        assert wait_job(manager,job_id)['status']=='cancelled'
        assert store.visible_chunks()==[]
        assert (root/'x.txt').read_text()=='sample'
    finally: manager.close()
