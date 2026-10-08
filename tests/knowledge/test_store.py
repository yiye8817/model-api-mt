import sqlite3

import pytest


def make_store(tmp_path):
    from local_knowledge.store import Store
    return Store(tmp_path)


def put_source(store, content='A 型号保修三年', digest='v1'):
    from local_knowledge.contracts import Chunk, Source
    source = Source(id='s1', title='手册', content_hash=digest)
    revision = store.upsert_pending(source, [Chunk(id='c1', source_id='s1', text=content)])
    return revision


def test_pending_revision_not_answerable(tmp_path):
    store = make_store(tmp_path)
    revision = put_source(store)
    assert revision == 1
    assert store.visible_chunks(['s1']) == []
    assert store.activate_revision('s1', revision)
    assert [c.text for c in store.visible_chunks(['s1'])] == ['A 型号保修三年']
    assert [c.status for c in store.visible_chunks(['s1'])] == ['indexed']


def test_repeated_hash_keeps_revision(tmp_path):
    store = make_store(tmp_path)
    first = put_source(store)
    store.activate_revision('s1', first)
    assert put_source(store) == 1
    assert store.get_source('s1').status == 'indexed'
    assert len(store.visible_chunks(['s1'])) == 1


def test_revision_change_invalidates_old_chunks_and_cache(tmp_path):
    store = make_store(tmp_path)
    store.activate_revision('s1', put_source(store))
    store.put_cache('key', {'answer': '三年'}, {'s1': 1}, 'model')
    assert store.get_cache('key', 'model')['answer'] == '三年'
    revision = put_source(store, '保修两年', 'v2')
    assert revision == 2
    assert store.visible_chunks(['s1']) == []
    assert store.get_cache('key', 'model') is None
    assert not store.activate_revision('s1', 1)
    assert store.activate_revision('s1', 2)
    assert [c.text for c in store.visible_chunks(['s1'])] == ['保修两年']


def test_disable_or_delete_source_invalidates_dependencies(tmp_path):
    store = make_store(tmp_path)
    store.activate_revision('s1', put_source(store))
    assert store.dependencies_current({'s1': 1})
    store.set_enabled('s1', False)
    assert not store.dependencies_current({'s1': 1})
    assert store.visible_chunks(['s1']) == []
    store.set_enabled('s1', True)
    assert store.dependencies_current({'s1': 1})
    store.invalidate_source('s1')
    assert not store.dependencies_current({'s1': 1})


def test_store_persists_across_restart_and_empty_scope(tmp_path):
    store = make_store(tmp_path)
    store.activate_revision('s1', put_source(store))
    assert make_store(tmp_path).get_source('s1').revision == 1
    assert store.visible_chunks([]) == []
    assert len(store.visible_chunks(None)) == 1


def test_missing_fts5_disables_knowledge_only(tmp_path, monkeypatch):
    from local_knowledge.store import Store, StoreUnavailable
    monkeypatch.setattr(Store, '_init_fts', lambda self, conn: (_ for _ in ()).throw(sqlite3.OperationalError('no such module: fts5')))
    with pytest.raises(StoreUnavailable, match='FTS5'):
        Store(tmp_path)
    import server
    assert server.app.test_client().get('/api/settings').status_code == 200
