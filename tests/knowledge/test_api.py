import io
import sys

import pytest

from tests.knowledge.answer_harness import build_harness,request


@pytest.fixture
def api(tmp_path):
    from flask import Flask
    from local_knowledge.api import create_blueprint
    from local_knowledge.ingest import ImportManager
    from local_knowledge.evaluation import EvaluationRunner
    from local_knowledge.chat_sync import ChatSynchronizer
    store,models,service,config=build_harness(tmp_path)
    imports=ImportManager(store,lambda sid,rev,budget:store.activate_revision(sid,rev))
    app=Flask(__name__);app.register_blueprint(create_blueprint(service,imports,EvaluationRunner(service,store,imports.jobs),ChatSynchronizer(store,imports)))
    yield app.test_client(),store,config,imports
    imports.close()


def test_query_miss_never_contains_candidate_answer(api):
    client,store,c,imports=api
    result=client.post('/api/knowledge/query',json=request('B 型号保修期？'))
    assert result.status_code==200
    assert result.json['decision']=='miss' and result.json['answer'] is None and result.json['citations']==[]


@pytest.mark.parametrize('payload',[{}, {'request_id':'x','question':''},{'request_id':'x','question':'text','online_target':{'apiKey':'secret'}}, {'request_id':'x','question':'text','context':'broken'}])
def test_input_invalid_is_400(api,payload):
    client,*_=api
    assert client.post('/api/knowledge/query',json=payload).status_code==400


def test_all_spec_routes_registered(api):
    client,*_=api
    rules={r.rule for r in client.application.url_map.iter_rules()}
    suffixes=['status','probe','sources','import','upload','web-import','sources/<source_id>',
        'sources/<source_id>/refresh','jobs/<job_id>','jobs/<job_id>/cancel','query','query/<request_id>/cancel',
        'requests/<request_id>','evaluate','record','sources/<source_id>/content']
    assert all('/api/knowledge/'+path in rules for path in suffixes)


def test_status_and_trace_do_not_expose_secrets(api):
    client,store,c,imports=api
    assert client.post('/api/knowledge/query',json=request()).json['decision']=='hit'
    status=client.get('/api/knowledge/status')
    trace=client.get('/api/knowledge/requests/q1')
    assert status.status_code==trace.status_code==200
    assert 'apiKey' not in str(status.json)+str(trace.json)
    assert trace.json['online_model_requests']==0


def test_source_content_requires_current_revision(api):
    client,store,c,imports=api
    result=client.get('/api/knowledge/sources/manual/content?revision=1')
    assert result.status_code==200 and 'A 型号保修三年' in result.json['text']
    assert client.get('/api/knowledge/sources/manual/content?revision=2').status_code==409
    assert client.get('/api/knowledge/sources/manual/content').status_code==400


def test_citation_view_detects_changed_original_file(api,tmp_path):
    from local_knowledge.ingest import file_source
    from local_knowledge.contracts import Chunk
    client,store,c,imports=api
    path=tmp_path/'original.md';path.write_text('A 保修三年')
    source=file_source(path,tmp_path);store.upsert_pending(source,[Chunk('file',text='A 保修三年')]);store.activate_revision(source.id,1)
    path.write_text('A 保修两年')
    assert client.get(f'/api/knowledge/sources/{source.id}/content?revision=1').status_code==409


def test_uncalibrated_preview_never_generates_an_answer(api):
    client,store,c,imports=api;c['evaluation_profile_id']=''
    response=client.post('/api/knowledge/preview',json=request())
    assert response.status_code==200 and len(response.json['candidates'])==1
    assert 'answer' not in response.json


def test_knowledge_disabled_does_not_import_chroma(tmp_path,monkeypatch):
    import builtins
    from flask import Flask
    from local_knowledge.api import create_blueprint
    from local_knowledge.runtime import Runtime
    from local_knowledge.config import default_config
    original=builtins.__import__
    def guarded(name,*args,**kwargs):
        if name.startswith('chromadb'): raise AssertionError('Disabled feature must not load Chroma')
        return original(name,*args,**kwargs)
    monkeypatch.setattr(builtins,'__import__',guarded)
    runtime=Runtime(tmp_path,default_config,lambda:[])
    app=Flask(__name__);app.register_blueprint(create_blueprint(runtime=runtime))
    try:
        assert app.test_client().get('/api/knowledge/status').json['enabled'] is False
        assert app.test_client().post('/api/knowledge/query',json=request()).json['reason']=='disabled'
    finally: runtime.close()


def test_delete_does_not_delete_original_document(api,tmp_path):
    from local_knowledge.contracts import Source,Chunk
    client,store,c,imports=api
    original=tmp_path/'original.txt';original.write_text('keep')
    copy=store.data_dir/'imports'/'copy.txt';copy.parent.mkdir(exist_ok=True);copy.write_text('keep')
    store.upsert_pending(Source('file',content_hash='x',locator={'kind':'file','path':str(original),'root':str(tmp_path),'copy_path':str(copy)}),[Chunk('file-c',text='keep')]);store.activate_revision('file',1)
    assert client.delete('/api/knowledge/sources/file').status_code==200
    assert original.read_text()=='keep' and not copy.exists()
    assert store.revision_chunks('file',1)==[]


@pytest.fixture
def server_client(tmp_path,monkeypatch):
    import server
    from local_knowledge.runtime import Runtime
    for key,name in [('SETTINGS_FILE','settings.json'),('PROVIDERS_FILE','providers.json'),('META_FILE','meta.json'),('STATE_FILE','legacy.json')]:
        monkeypatch.setattr(server,key,str(tmp_path/name))
    conv=tmp_path/'conversations';conv.mkdir();monkeypatch.setattr(server,'CONVERSATIONS_DIR',str(conv))
    runtime=Runtime(tmp_path/'knowledge',lambda:server._load_settings()['local_knowledge'],lambda:server.load_state()['conversations'])
    monkeypatch.setattr(server,'_knowledge_runtime',runtime,raising=False)
    client=server.app.test_client()
    client.post('/api/settings',json={'local_knowledge':{'enabled':True}})
    yield client,runtime
    runtime.close()


def test_server_registers_lazy_knowledge_routes(server_client):
    client,runtime=server_client
    assert client.get('/api/knowledge/status').status_code==200


def test_server_state_and_individual_delete_invalidate_sources(server_client):
    import time
    from local_knowledge.chat_sync import turn_hash
    client,runtime=server_client
    question='A 保修期？';answer='A 保修三年'
    completion={'status':'complete','kind':'api','request_id':'q','finished_at':time.time()*1000,'effective_constraints':'',
                'origin_hash':turn_hash(question,answer,[],'')}
    conv={'id':'c','title':'test','messages':[{'id':'u','role':'user','content':question},{'id':'a','role':'assistant','content':answer,'completion':completion}]}
    assert client.put('/api/state',json={'providers':[],'conversations':[conv]}).status_code==200
    sources=runtime.store.list_sources()
    assert len(sources)==1
    sid=sources[0].id
    assert client.delete('/api/conversations/c').status_code==200
    assert runtime.store.get_source(sid).status=='deleted'


def test_settings_failure_preserves_saved_chat(server_client):
    client,runtime=server_client
    client.put('/api/state',json={'providers':[],'conversations':[{'id':'c','title':'test','messages':[]}]})
    assert client.post('/api/settings',json={'local_knowledge':{'enabled':'bad'}}).status_code==400
    assert client.get('/api/state').json['conversations'][0]['id']=='c'


def test_actual_online_chat_and_auxiliary_sends_are_counted(server_client):
    import server
    from tests.knowledge.model_server import ModelServer
    client,runtime=server_client
    reply={'choices':[{'message':{'content':'answer'},'finish_reason':'stop'}]}
    with ModelServer({'/v1/chat/completions':reply}) as model:
        response=client.post('/api/chat',headers={'X-Request-ID':'online-q'},json={'baseUrl':model.url+'/v1','model':'fixture','messages':[{'role':'user','content':'q'}],'stream':False})
        assert response.status_code==200
        with server.app.test_request_context('/api/auto-route',headers={'X-Request-ID':'online-q'}):
            assert server._llm_chat_full(model.url+'/v1','','fixture','system','question')[0]=='answer'
    assert runtime.store.request('online-q')['online_model_requests']==2


def test_refresh_nested_file_preserves_original_source_identity(api,tmp_path):
    from local_knowledge.ingest import file_source
    from local_knowledge.contracts import Chunk
    client,store,c,imports=api
    root=tmp_path/'documents';(root/'nested').mkdir(parents=True);path=root/'nested'/'file.txt';path.write_text('old')
    source=file_source(path,root);store.upsert_pending(source,[Chunk('file',text='old')]);store.activate_revision(source.id,1)
    path.write_text('new')
    response=client.post(f'/api/knowledge/sources/{source.id}/refresh',json={});assert response.status_code==202
    imports.jobs.queue.join()
    assert store.get_source(source.id).revision==2
    assert len([s for s in store.list_sources() if s.locator.get('path')==str(path)])==1


def test_visible_web_import_preserves_previous_context_and_revisions(api):
    client,store,c,imports=api
    messages=[{'id':'u1','role':'user','content':'这里只讨论 B 型号','complete':True},
        {'id':'a1','role':'assistant','content':'好的','complete':True},
        {'id':'u2','role':'user','content':'保修期多久？','complete':True},
        {'id':'a2','role':'assistant','content':'三年','complete':True}]
    snapshot={'url':'https://example.test/c/one','context_complete':True,'system_constraints':'中文简答','messages':messages}
    # The fixture's vector transport is intentionally absent; only publication is under test.
    from unittest.mock import patch
    from local_knowledge.retrieval import Retriever
    with patch.object(Retriever,'index_revision',lambda self,sid,rev,budget:store.activate_revision(sid,rev)):
        assert client.post('/api/knowledge/web-import',json={'snapshot':snapshot}).status_code==202
        imports.jobs.queue.join()
        source=next(s for s in store.list_sources() if s.title=='保修期多久？')
        assert source.metadata['context']==[{'role':m['role'],'content':m['content']} for m in messages[:2]]
        assert source.metadata['question']=='保修期多久？'
        assert source.metadata['system_constraints']=='中文简答'
        assert source.metadata['completion']['status']=='complete'
        messages[0]['content']='这里只讨论 A 型号'
        client.post('/api/knowledge/web-import',json={'snapshot':snapshot});imports.jobs.queue.join()
        assert store.get_source(source.id).revision==source.revision+1


def test_web_send_counts_do_not_require_a_completed_answer(api):
    client,store,c,imports=api
    payload={'request_id':'web-q','online_calls':[{'call_id':'web-q:tab-1','kind':'web','model':'unknown'}]}
    first=client.post('/api/knowledge/record',json=payload)
    second=client.post('/api/knowledge/record',json=payload)
    assert first.status_code==second.status_code==200
    assert client.get('/api/knowledge/requests/web-q').json['online_model_requests']==1
    assert not store.connection.execute('SELECT 1 FROM qa_records').fetchone()


def test_config_import_merges_partial_roles_without_saving_or_requiring_qa(server_client):
    from local_knowledge.config import default_config
    client,runtime=server_client
    client.post('/api/settings',json={'model_params':{'temperature':.4},'local_knowledge':{'online_fallback':False}})
    before=client.get('/api/settings').json
    current=before['local_knowledge'];current['selected_source_ids']=['chosen'];current['qa_endpoint']['model']=''
    payload={'local_knowledge':{'embedding_endpoint':{'url':'http://127.0.0.1:18011','model':'bge-m3','model_revision':'weights'},
        'rerank_endpoint':{'url':'http://127.0.0.1:18012','model':'bge-reranker-v2-m3'}},'model_params':{'temperature':1}}
    response=client.post('/api/knowledge/config/validate',json={'config':payload,'current':current})
    assert response.status_code==200
    imported=response.json['settings']
    assert imported['embedding_endpoint']['model']=='bge-m3'
    assert imported['rerank_endpoint']['model']=='bge-reranker-v2-m3'
    assert imported['qa_endpoint']==default_config()['qa_endpoint']
    assert imported['online_fallback'] is False and imported['selected_source_ids']==['chosen']
    assert client.get('/api/settings').json['model_params']['temperature']==.4
    assert client.get('/api/settings').json['local_knowledge']['embedding_endpoint']['model']==''
    assert client.post('/api/settings',json={'local_knowledge':imported}).status_code==200


@pytest.mark.parametrize('config',[[],{'local_knowledge':None},{'embedding_endpoint':None},{'enabled':'yes'},
    {'embedding_endpoint':{'url':'https://public.example'}},{'embedding_endpoint':{'apiKey':'secret'}},
    {'__proto__':{}},{}])
def test_config_import_rejects_invalid_content_atomically(api,config):
    client,store,c,imports=api
    response=client.post('/api/knowledge/config/validate',json={'config':config,'current':c})
    assert response.status_code==400
    assert c['qa_endpoint']['model']=='fixture'


def test_config_import_accepts_flat_settings_and_preserves_existing_qa(api):
    client,store,c,imports=api
    response=client.post('/api/knowledge/config/validate',json={'config':{'embedding_endpoint':{'model':'new'}},'current':c})
    assert response.status_code==200
    assert response.json['settings']['embedding_endpoint']['model']=='new'
    assert response.json['settings']['qa_endpoint']==c['qa_endpoint']


def test_config_import_preserves_existing_lan_permission_when_url_is_updated(api):
    client,store,c,imports=api
    c['embedding_endpoint']['allow_lan']=True
    response=client.post('/api/knowledge/config/validate',json={'config':{'embedding_endpoint':{'url':'http://192.168.1.10:18011'}},'current':c})
    assert response.status_code==200
    assert response.json['settings']['embedding_endpoint']['allow_lan'] is True


def test_config_import_can_repair_invalid_unsaved_fields(api):
    client,store,c,imports=api
    current={**c,'embedding_endpoint':{**c['embedding_endpoint'],'url':'http://'}}
    response=client.post('/api/knowledge/config/validate',json={'config':{'embedding_endpoint':{'url':'http://127.0.0.1:18011'}},'current':current})
    assert response.status_code==200
    assert response.json['settings']['embedding_endpoint']['url']=='http://127.0.0.1:18011'
