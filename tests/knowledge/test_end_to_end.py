import json
from threading import Event

import pytest

from tests.knowledge.model_server import ModelServer
from tests.knowledge.answer_harness import request,build_harness


def test_synonym_hit_then_source_update_then_miss(tmp_path):
    from local_knowledge.config import stable_hash
    from local_knowledge.store import Store
    from local_knowledge.model_clients import ModelClients
    from local_knowledge.vectors import VectorIndex
    from local_knowledge.retrieval import Retriever
    from local_knowledge.service import KnowledgeService
    from local_knowledge.ingest import ImportManager
    def chat(payload):
        p=json.loads(payload['messages'][-1]['content']);kind=p['task']
        if kind=='prepare':data={'kind':'qa','retrieval_question':p['question'],'constraints':[],'context_basis':[]}
        elif kind=='select_excerpts':data={'qa':True,'hit':False,'ids':[]}
        elif kind=='match':data={'answerable':True,'matched_constraints':p['constraint_ids'],'unresolved_constraints':[],'conflicts':[]}
        elif kind=='generate':data={'answerable':True,'answer':'A 型号保修三年 [1]','matched_constraints':p['constraint_ids'],'unresolved_constraints':[],'conflicts':[],
            'claims':[{'text':'A 型号保修三年','citations':[{'chunk_id':p['chunks'][0]['id'],'quote':p['chunks'][0]['text']}]}]}
        else:data={'supported':True,'answer_covered':True,'constraints_covered':True,'unresolved_constraints':[],'conflicts':[],'uncovered_claims':[]}
        return {'choices':[{'message':{'content':json.dumps(data,ensure_ascii=False)},'finish_reason':'stop'}]}
    replies={'/v1/embeddings':lambda p:{'data':[{'index':i,'embedding':[1.,0.]} for i,_ in enumerate(p['input'])]},
             '/v1/rerank':lambda p:{'results':[{'index':i,'relevance_score':.95} for i,_ in enumerate(p['documents'])]},
             '/tokenize':lambda p:{'tokens':list(range(max(1,len(p['content'])//4)))},'/v1/chat/completions':chat}
    with ModelServer(replies) as server:
        config=server.config;config.update(enabled=True,evaluation_profile_id='deterministic-fixture')
        store=Store(tmp_path/'data');models=ModelClients(config)
        retriever=Retriever(store,VectorIndex(tmp_path/'data',stable_hash(config['embedding_endpoint']),0),models)
        imports=ImportManager(store,retriever.index_revision)
        path=tmp_path/'manual.txt';path.write_text('A 型号保修三年。')
        try:
            imports.enqueue({'kind':'paths','roots':[str(path)]});imports.jobs.queue.join()
            store.save_profile('deterministic-fixture',{'passed':True,'real_models':True,'reviewed':True,'fingerprint':models.fingerprint,'threshold':.5,'dimension':2})
            service=KnowledgeService(store,retriever,models,lambda:config)
            result=service.query(request('A 型号能保修多长时间？'))
            assert result.decision=='hit' and result.citations[0].position.start_line==1
            assert store.request('q1')['online_model_requests']==0
            path.write_text('A 型号保修两年。')
            assert service.query(request(request_id='q2')).reason=='stale_source'
            assert store.get_source(result.citations[0].source_id).enabled is True
        finally: imports.close()


@pytest.mark.parametrize('question,material',[('A v1 保修期？','A v12 保修三年。'),('A 保修 3 年？','A 保修 13 年。')])
def test_version_and_number_prefixes_do_not_match(tmp_path,question,material):
    from local_knowledge.contracts import Source,Chunk
    store,models,service,c=build_harness(tmp_path)
    store.upsert_pending(Source('manual',content_hash='changed'),[Chunk('c',text=material)]);store.activate_revision('manual',2)
    assert service.query(request(question)).decision=='miss'


def test_chinese_numeral_claim_must_match_support(tmp_path):
    from local_knowledge.contracts import Source,Chunk
    store,models,service,c=build_harness(tmp_path)
    store.upsert_pending(Source('manual',content_hash='changed'),[Chunk('c',text='A 型号保修两年。')]);store.activate_revision('manual',2)
    assert service.query(request()).reason=='invalid_answer'


def test_answer_constraints_travel_to_generation(tmp_path):
    store,models,service,c=build_harness(tmp_path)
    def generate(result,payload):
        if 'English' in payload.get('system_constraints',''):
            result['answer']='A warranty lasts three years [1]';result['claims'][0]['text']='A warranty lasts three years'
        return result
    models.overrides['generate']=generate
    result=service.query(request(system_constraints='Answer in English'))
    assert result.decision=='hit' and result.answer=='A warranty lasts three years [1]'
