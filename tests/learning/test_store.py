import pytest

from learning.contracts import LearningError
from learning.store import LearningStore


def test_revision_and_old_content_survive_restart(store, source, chunks):
    first = store.upsert_document(source, chunks)
    scope = store.resolve_scope({'mode': 'selected', 'document_ids': [first['id']]})
    same = store.upsert_document(source, chunks)
    assert same['revision'] == 1
    second = store.upsert_document({**source, 'content_hash': 'changed'}, [{**chunks[0], 'text': '新正文'}])
    assert second['revision'] == 2
    assert not store.revisions_current(scope)
    reopened = LearningStore(store.data_dir)
    assert reopened.get_document(first['id'])['revision'] == 2
    assert reopened.get_chunks(first['id'], 1)[0]['text'] == '量子叠加是多个状态的线性组合。'


def test_manual_metadata_survives_reimport_and_search(store, source, chunks):
    doc = store.upsert_document(source, chunks)
    store.update_document(doc['id'], {'title': '我的量子笔记', 'category': '物理', 'tags': ['基础']})
    store.upsert_document({**source, 'title': '自动标题', 'content_hash': 'second'}, chunks)
    saved = store.list_documents({'q': '量子', 'category': '物理'})
    assert saved['total'] == 1
    assert saved['items'][0]['title'] == '我的量子笔记'
    assert saved['items'][0]['tags'] == ['基础']


@pytest.mark.parametrize('scope', [{}, {'mode': 'selected', 'document_ids': []}, {'mode': 'selected', 'document_ids': ['missing']}, {'mode': 'bogus'}, {'mode': 'selected', 'document_ids': 'bad'}])
def test_invalid_scope_never_becomes_all(store, source, chunks, scope):
    store.upsert_document(source, chunks)
    with pytest.raises(LearningError):
        store.resolve_scope(scope)


def test_removed_document_is_not_answer_scope(store, source, chunks):
    doc = store.upsert_document(source, chunks)
    store.remove_document(doc['id'])
    assert store.list_documents({})['total'] == 0
    with pytest.raises(LearningError):
        store.resolve_scope({'mode': 'selected', 'document_ids': [doc['id']]})


def test_all_scope_is_snapshot_and_pagination_is_validated(store, source, chunks):
    a = store.upsert_document(source, chunks)
    scope = store.resolve_scope({'mode': 'all'})
    store.upsert_document({**source, 'source_id': 'second', 'content_hash': 'different'}, chunks)
    assert scope == {a['id']: 1}
    assert store.list_documents({}, page_size=1)['total'] == 2
    with pytest.raises(LearningError):
        store.list_documents({}, page_size=0)
