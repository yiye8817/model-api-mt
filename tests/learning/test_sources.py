from dataclasses import asdict

from local_knowledge.store import Store
from local_knowledge.contracts import Source, Chunk
from knowledge.store import KnowledgeStore
from learning.sources import SourceSynchronizer


def test_sync_excludes_chats_keeps_sources_and_removal(store, tmp_path):
    local = Store(tmp_path/'local')
    local.upsert_pending(Source('file', title='现有手册', content_hash='x'), [Chunk('x', text='已有正文')])
    local.activate_revision('file', 1)
    local.upsert_pending(Source('chat', kind='api_chat', content_hash='y'), [Chunk('y', text='聊天')])
    syncer = SourceSynchronizer(store, lambda: local, None)
    assert syncer.sync()['added'] == 1
    assert syncer.sync()['added'] == 0
    doc = store.list_documents({})['items'][0]
    assert store.get_chunks(doc['id'], 1)[0]['text'] == '已有正文'
    store.remove_document(doc['id'])
    assert syncer.sync()['added'] == 0
    assert store.list_documents({})['total'] == 0


def test_source_failure_does_not_delete_existing_docs(store, tmp_path):
    local = Store(tmp_path/'local')
    local.upsert_pending(Source('file', title='保留', content_hash='x'), [Chunk('x', text='正文')])
    syncer = SourceSynchronizer(store, lambda: local, None)
    syncer.sync()
    def unavailable():
        raise RuntimeError('读取暂时失败')
    syncer.local_store = unavailable
    assert syncer.sync()['errors']
    assert store.list_documents({})['total'] == 1
    syncer.local_store = lambda: local
    local.invalidate_source('file')
    assert syncer.sync()['removed'] == 1
    assert store.list_documents({})['total'] == 0


def test_content_snapshot_orders_chunks_numerically_and_excludes_qa(tmp_path):
    content = KnowledgeStore(tmp_path/'content.sqlite3')
    with content.connection() as db:
        for i in [10, 2, 0]:
            content._upsert(db, {'id': f'document:abc:chunk:{i}', 'kind':'qa', 'origin':'manual', 'dataset':'document:abc', 'split':'train',
                'title':'手册', 'question':f'第{i}段', 'answer':f'片段{i}', 'source_name':'手册', 'tags':[]})
    content.add({'question':'普通问答', 'answer':'不导入'})
    snapshots = content.document_snapshots()
    assert len(snapshots) == 1
    assert [c['text'] for c in snapshots[0]['chunks']] == ['片段0','片段2','片段10']
