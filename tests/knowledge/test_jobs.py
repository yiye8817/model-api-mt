import time

import pytest


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


def test_missing_selected_file_does_not_scan_its_parent(tmp_path):
    from local_knowledge.ingest import ImportManager
    from local_knowledge.store import Store
    root=tmp_path/'selected';root.mkdir();(root/'unselected.txt').write_text('private adjacent data')
    store=Store(tmp_path/'data');manager=ImportManager(store)
    try:
        job=wait_job(manager,manager.enqueue({'kind':'paths','roots':[str(root/'missing.txt')]}))
        assert job['failed']==1 and job['succeeded']==0
        assert store.list_sources()==[]
    finally:manager.close()


@pytest.mark.parametrize('recover',[False,True])
def test_large_document_index_can_run_beyond_small_document_timeout(tmp_path,recover):
    from local_knowledge.ingest import ImportManager
    from local_knowledge.store import Store
    root=tmp_path/'documents';root.mkdir()
    (root/'large.txt').write_text('资料样本\n\n'*500)
    store=Store(tmp_path/'data')
    def index(source_id,revision,budget):
        # Advance elapsed indexing time without a wall-clock sleep.
        budget.deadline-=150
        budget.check()
        store.activate_revision(source_id,revision)
    manager=ImportManager(store,None if recover else index)
    try:
        job_id=manager.enqueue({'kind':'paths','roots':[str(root)]})
        if recover:
            assert wait_job(manager,job_id)['status']=='waiting_index'
            manager.index_revision=index
            manager.recover()
        job=wait_job(manager,job_id)
        assert job['succeeded']==1 and job['failed']==0
        assert store.list_sources()[0].status=='indexed'
    finally:manager.close()


def test_small_document_index_still_has_a_timeout(tmp_path):
    from local_knowledge.ingest import ImportManager
    from local_knowledge.store import Store
    root=tmp_path/'documents';root.mkdir()
    (root/'small.txt').write_text('资料样本')
    store=Store(tmp_path/'data')
    def index(source_id,revision,budget):
        budget.deadline-=150
        budget.check()
        store.activate_revision(source_id,revision)
    manager=ImportManager(store,index)
    try:
        job=wait_job(manager,manager.enqueue({'kind':'paths','roots':[str(root)]}))
        assert job['failed']==1 and job['succeeded']==0
        assert store.list_sources()[0].status=='pending'
        assert store.visible_chunks()==[]
    finally:manager.close()
