import json
import logging

from flask import Flask

from knowledge.api import register_knowledge_routes
from knowledge.store import KnowledgeStore
from tests.knowledge.answer_harness import build_harness, request


def log_records(caplog):
    return [json.loads(record.message) for record in caplog.records if record.name == 'local_knowledge']


def test_saved_reuse_logs_candidates_and_result_with_request_id(tmp_path, caplog):
    store = KnowledgeStore(tmp_path/'saved.sqlite3')
    store.add({'question': '多级页表是什么', 'answer': '多级页表按层级组织页表以减少未使用地址空间的内存占用。'})
    app = Flask(__name__)
    register_knowledge_routes(app, lambda: store, lambda: [], prefix='/api/content-library')
    caplog.set_level(logging.INFO, logger='local_knowledge')
    response = app.test_client().post('/api/content-library/reuse', json=request('多级页表是什么', 'saved-test', system_constraints=''))
    assert response.json['decision'] == 'hit'
    events = log_records(caplog)
    search = next(e for e in events if e['event'] == 'knowledge.saved_search')
    assert search['request_id'] == 'saved-test' and search['candidate_count'] == 1
    assert search['candidates'][0]['question'] == '多级页表是什么'
    assert '减少未使用地址空间' in search['candidates'][0]['quote']
    final = next(e for e in events if e['event'] == 'knowledge.saved_result')
    assert final['request_id'] == 'saved-test' and final['decision'] == 'hit'


def test_explicit_document_scope_logs_saved_reuse_skip(tmp_path, caplog):
    store = KnowledgeStore(tmp_path/'saved.sqlite3')
    app = Flask(__name__)
    register_knowledge_routes(app, lambda: store, lambda: [], prefix='/api/content-library')
    caplog.set_level(logging.INFO, logger='local_knowledge')
    response = app.test_client().post('/api/content-library/reuse', json=request('多级页表', 'scoped-test', source_ids=['manual']))
    assert response.json['decision'] == 'miss'
    final = next(e for e in log_records(caplog) if e['event'] == 'knowledge.saved_result')
    assert final['request_id'] == 'scoped-test' and final['reason'] == 'source_scope_or_regenerate'


def test_preview_logs_retrieved_scores_and_original_quotes(tmp_path, caplog):
    store, models, service, config = build_harness(tmp_path)
    caplog.set_level(logging.INFO, logger='local_knowledge')
    assert service.preview(request())
    event = next(e for e in log_records(caplog) if e['event'] == 'knowledge.retrieval')
    assert event['method'] == 'preview' and event['candidate_count'] == 1
    candidate = event['candidates'][0]
    assert candidate['source_id'] == 'manual' and candidate['title'] == '产品 A 手册'
    assert candidate['quote'] == 'A 型号保修三年。' and candidate['score'] == .95


def test_new_definition_reaches_documents_before_expensive_saved_matching(tmp_path):
    import threading
    from local_knowledge.api import create_blueprint
    from local_knowledge.contracts import Source,Chunk
    from local_knowledge.model_clients import Budget
    from local_knowledge.retrieval import effective_scope
    from local_knowledge.text import keyword_tokens
    saved = KnowledgeStore(tmp_path/'saved.sqlite3')
    saved.add({'question':'牛顿是谁','answer':'牛顿是英国物理学家。'})
    store, models, service, config = build_harness(tmp_path/'documents')
    text='<h3>多级页表</h3><p>多级页表按层级组织页表，未使用的地址空间无需建立下级页表，从而减少内存占用。</p>'
    store.upsert_pending(Source('pages',title='part3.html',content_hash='v1'),[Chunk('',text=text,keyword_text=' '.join(keyword_tokens(text)))])
    store.activate_revision('pages',1)
    models.overrides['select_excerpts']=lambda result,payload:{'qa':True,'hit':True,
        'ids':[row['id'] for row in payload['excerpts'] if '多级页表' in row['text']][:3]}
    class SlowSavedModels:
        def embed(self,*args):raise AssertionError('Saved semantic matching must not spend the document lookup budget')
    def available(data,budget):
        scope=effective_scope(store,data.get('source_ids',[]),config['selected_source_ids'])
        return service.probe_lookup(data,scope,budget)
    app=Flask(__name__)
    register_knowledge_routes(app,lambda:saved,lambda:[],prefix='/api/content-library',
        get_semantic=lambda rid:(SlowSavedModels(),Budget(30,threading.Event()),lambda stage:None,None),
        get_document_lookup=available)
    app.register_blueprint(create_blueprint(service=service))
    client=app.test_client();payload=request('请问多级页表是什么？','fresh-definition',system_constraints='')
    cache=client.post('/api/content-library/reuse',json=payload)
    assert cache.json['decision']=='miss' and cache.json['reason']=='document_answer_available'
    result=client.post('/api/knowledge/query',json=payload)
    assert result.json['decision']=='hit' and result.json['answer_origin']=='extractive_document'
    assert result.json['citations'][0]['source_id']=='pages'
    assert models.calls==['select_excerpts']
