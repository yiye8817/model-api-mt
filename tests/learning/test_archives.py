import json
import pytest
from learning.archives import ArchiveService
from learning.contracts import LearningError
from tests.learning.test_graph import save_analysis
from tests.learning.test_analysis import context_for


def test_archive_snapshot_survives_update_and_exports_same_body(store, source, chunks):
    doc = save_analysis(store,source,chunks,'叠加','物理')
    class Model:
        def request(self,prompt,*a,**kw):
            c = json.loads(prompt.split('\nINPUT_JSON\n')[1])['evidence'][0]
            return json.dumps({'markdown':'# 量子学习\n\n状态的线性组合。','citations':[{'chunk_id':c['id'],'quote':c['text']}]},ensure_ascii=False)
    archives = ArchiveService(store,Model())
    jobs, context = context_for(store,doc)
    try:
        result = archives.run({'title':'量子学习','revisions':{doc['id']:1}},context)
    finally:
        jobs.shutdown()
    store.upsert_document({**source,'content_hash':'second'},[{'text':'新解释','position':{'kind':'lines'}}])
    saved = archives.get_archive(result['archive']['id'])
    assert saved['needs_update'] is True
    body,mime,name = archives.export(saved['id'],'markdown')
    assert saved['markdown'] in body.decode()
    assert mime.startswith('text/markdown') and name.endswith('.md')
    data = json.loads(archives.export(saved['id'],'json')[0])
    assert data['document_revisions'] == {doc['id']:1}
    assert data['graph']['nodes']


def test_saving_existing_note_requires_no_model_call(store, source, chunks):
    doc = store.upsert_document(source,chunks)
    archives = ArchiveService(store,None)
    note = archives.save_note('笔记','已经生成的学习记录',[],{doc['id']:1},{'kind':'turn','id':'existing'})
    assert archives.get_archive(note['id'])['markdown'] == '已经生成的学习记录'
    with pytest.raises(LearningError):
        archives.export(note['id'],'html')
