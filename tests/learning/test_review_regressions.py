"""User-visible lifecycle and evidence-scope failures from the final review."""
import io
import json
import threading

import pytest

from learning.contracts import LearningError
from learning.jobs import LearningJobs
from learning.retrieval import Retriever
from learning.sources import SourceSynchronizer
from local_knowledge.contracts import Source, Chunk
from local_knowledge.store import Store
from tests.learning.test_analysis import analysis_value
from tests.learning.test_end_to_end import make_api
from tests.learning.test_graph import save_analysis
from tests.learning.test_jobs import wait_terminal
from tests.learning.test_questions import build_service


@pytest.mark.parametrize('kind,state', [('analysis', 'analyzing'), ('ingest', 'importing')])
def test_queued_cancellation_restores_retry_and_releases_tracking(store, source, chunks, kind, state):
    doc = store.upsert_document(source, chunks)
    store.set_document_state(doc['id'], state)
    started, release = threading.Event(), threading.Event()
    jobs = LearningJobs(store, workers=1)
    def block(payload, context):
        started.set()
        release.wait(3)
    jobs.register('question', block)
    jobs.register(kind, lambda *args: pytest.fail('cancelled queued handler executed'))
    try:
        jobs.submit('question', {}, {})
        assert started.wait(1)
        job = jobs.submit(kind, {'document_ids': [doc['id']]}, {doc['id']: 1})
        jobs.cancel(job['id'])
        assert store.get_document(doc['id'])['status'] == 'pending'
        assert job['id'] not in jobs.events
        assert job['id'] not in jobs.futures
    finally:
        release.set()
        jobs.shutdown()


@pytest.mark.parametrize('replace_revision', [False, True])
def test_obsolete_job_cleanup_cannot_overwrite_success(store, source, chunks, replace_revision):
    doc = store.upsert_document(source, chunks)
    started, release = threading.Event(), threading.Event()
    jobs = LearningJobs(store)
    def handler(payload, context):
        started.set()
        release.wait(3)
        raise LearningError('old task failure')
    jobs.register('analysis', handler)
    try:
        old = jobs.submit('analysis', {'document_ids': [doc['id']]}, {doc['id']: 1})
        assert started.wait(1)
        if replace_revision:
            doc = store.upsert_document({**source, 'content_hash': 'updated'}, chunks)
        else:
            jobs.cancel(old['id'])
        # A later task completes before the obsolete worker returns (also on the same revision).
        current = store.create_job('analysis', {'document_ids': [doc['id']]}, {doc['id']: doc['revision']})
        store.update_job(current['id'], status='running')
        evidence = store.get_chunks(doc['id'], doc['revision'])
        from learning.analysis import validate_analysis
        store.commit_analysis(doc['id'], doc['revision'], validate_analysis(analysis_value(evidence[0]), evidence), current['id'])
        release.set()
        jobs.shutdown()
        assert store.get_document(doc['id'])['status'] == 'completed'
    finally:
        release.set()
        jobs.shutdown()


@pytest.mark.parametrize('web', [False, True])
def test_import_retry_runs_original_ingestion(tmp_path, monkeypatch, web):
    from learning import ingest
    calls = []
    def parse(*args):
        calls.append(args[0])
        if len(calls) == 1:
            raise LearningError('temporary parse/fetch failure')
        return {'title': 'Recovered', 'units': [{'text': '量子叠加是状态组合。', 'position': {'kind': 'lines'}}],
                'warnings': [], 'source': {'locator': {}}}
    monkeypatch.setattr(ingest, 'parse_link' if web else 'parse_upload', parse)
    runtime, client = make_api(tmp_path, None)
    try:
        service = runtime.components()
        if web:
            item = client.post('/api/learning/documents/link', json={'url': 'https://example.com/article'}).json
        else:
            item = client.post('/api/learning/documents/upload', data={'files': (io.BytesIO(b'content'), 'test.md')}).json['items'][0]
        assert wait_terminal(service.store, item['job_id'])['status'] == 'failed'
        retry = service.analyze({'mode': 'selected', 'document_ids': [item['document_id']]}, {})
        done = wait_terminal(service.store, retry['id'])
        assert len(calls) == 2
        assert done['status'] == 'completed', done['error']
        assert service.store.get_document(item['document_id'])['status'] == 'completed'
        assert service.store.get_chunks(item['document_id'], 2)[0]['text'] == '量子叠加是状态组合。'
    finally:
        runtime.close()


def test_stale_upstream_snapshot_is_historical_and_cannot_answer(store, tmp_path):
    local = Store(tmp_path/'local')
    local.upsert_pending(Source('a', title='资料', content_hash='first'), [Chunk('a', text='量子叠加的原理。')])
    local.activate_revision('a', 1)
    sync = SourceSynchronizer(store, local)
    sync.sync()
    doc = store.all_documents()[0]
    evidence = store.get_chunks(doc['id'], 1)
    from learning.analysis import validate_analysis
    store.commit_analysis(doc['id'], 1, validate_analysis(analysis_value(evidence[0]), evidence), None)
    local.invalidate_source('a', 'stale')
    sync.sync()
    assert store.get_analysis(doc['id'])['needs_update'] is True
    assert store.active_analyses() == []
    assert not store.revisions_current({doc['id']: 1})
    with pytest.raises(LearningError):
        store.resolve_scope({'mode': 'selected', 'document_ids': [doc['id']]})
    with pytest.raises(LearningError):
        Retriever(store).search('量子叠加', {doc['id']: 1})
    # Repeated sync does not invent revisions; refreshed upstream content becomes usable.
    revision = store.get_document(doc['id'])['revision']
    sync.sync()
    assert store.get_document(doc['id'])['revision'] == revision
    local.upsert_pending(Source('a', title='资料', content_hash='fresh'), [Chunk('b', text='更新后的量子叠加资料。')])
    local.activate_revision('a', 2)
    assert not sync.sync()['errors']
    assert store.resolve_scope({'mode': 'all'})[doc['id']] > 1


@pytest.mark.parametrize('changed', [False, True])
def test_removed_upstream_source_can_return_with_revision_history(store, tmp_path, changed):
    local = Store(tmp_path/'local')
    local.upsert_pending(Source('a', title='资料', content_hash='first'), [Chunk('a', text='原文')])
    local.activate_revision('a', 1)
    sync = SourceSynchronizer(store, local)
    sync.sync()
    doc = store.all_documents()[0]
    local.invalidate_source('a')
    sync.sync()
    local.upsert_pending(Source('a', title='资料', content_hash='second' if changed else 'first'), [Chunk('b', text='新版' if changed else '原文')])
    local.activate_revision('a', 2)
    assert not sync.sync()['errors']
    restored = store.get_document(doc['id'])
    assert restored['revision'] == (2 if changed else 1)
    assert store.get_chunks(doc['id'], 1)[0]['text'] == '原文'
    store.remove_document(doc['id'])
    sync.sync()
    assert store.all_documents() == []


def test_exploration_prompt_contains_only_scoped_definitions_and_evidence(store, source):
    a = save_analysis(store, source, [{'text': 'A 的量子叠加定义。', 'position': {}}], '叠加', '物理')
    b = save_analysis(store, {**source, 'source_id': 'b'}, [{'text': 'B 的独有秘密定义。', 'position': {}}], '叠加', '物理')
    prompts = []
    class Model:
        def available(self): return {'available': True}
        def request(self, prompt, *args, **kwargs):
            prompts.append(prompt)
            evidence = json.loads(prompt.split('\nINPUT_JSON\n')[1])['evidence']
            return json.dumps({'citations': [{'chunk_id': evidence[0]['id'], 'quote': evidence[0]['text']}]})
    service = build_service(store, Model())
    try:
        concept = service.graph.list_concepts({})['items'][0]
        job = service.explore(concept['id'], {'mode': 'selected', 'document_ids': [a['id']]})
        assert wait_terminal(store, job['id'])['status'] == 'completed'
        assert b['id'] not in prompts[0]
        assert 'B 的独有秘密定义' not in prompts[0]
        concept_payload = json.loads(prompts[0].split('\nINPUT_JSON\n')[1])['concept']
        assert concept_payload['document_ids'] == [a['id']]
    finally:
        service.jobs.shutdown()
