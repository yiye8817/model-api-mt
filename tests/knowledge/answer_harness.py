import json
from dataclasses import replace


class ScriptedModels:
    def __init__(self,config):
        self.config=config; self.dimension=2; self.overrides={}; self.after_call=None; self.calls=[]
    @property
    def fingerprint(self):
        from local_knowledge.config import model_fingerprint
        return model_fingerprint(self.config,2)
    def count_tokens(self,text,budget): budget.check(); return max(1,len(text)//4)
    def embed(self,texts,budget): budget.check(); return [[1.,0.] for _ in texts]
    def rerank(self,q,candidates,budget): return [replace(c,score=.95,raw_score=.95) for c in candidates]
    def json_chat(self,messages,schema,budget):
        budget.check()
        payload=json.loads(messages[-1]['content']); task=payload['task']; self.calls.append(task)
        if task=='prepare':
            result={'kind':'qa','retrieval_question':payload['question'],'constraints':[],'context_basis':[]}
        elif task=='match': result={'answerable':True,'matched_constraints':payload['constraint_ids'],'unresolved_constraints':[],'conflicts':[]}
        elif task=='generate':
            chunk=payload['chunks'][0]
            result={'answerable':True,'answer':'A 型号保修三年 [1]','matched_constraints':payload['constraint_ids'],'unresolved_constraints':[],'conflicts':[],
                'claims':[{'text':'A 型号保修三年','citations':[{'chunk_id':chunk['id'],'quote':chunk['text']}]}]}
        elif task=='verify': result={'supported':True,'answer_covered':True,'constraints_covered':True,'unresolved_constraints':[],'conflicts':[],'uncovered_claims':[]}
        else: raise AssertionError(task)
        override=self.overrides.get(task)
        if callable(override): result=override(result,payload)
        elif override is not None: result=override
        if self.after_call: self.after_call(task)
        budget.check(); return result


def build_harness(tmp_path):
    from local_knowledge.config import default_config
    from local_knowledge.contracts import Source,Chunk
    from local_knowledge.store import Store
    from local_knowledge.service import KnowledgeService
    from local_knowledge.retrieval import Retriever
    config=default_config(); config.update(enabled=True,evaluation_profile_id='test-profile')
    for key in ('embedding_endpoint','rerank_endpoint','qa_endpoint'):
        config[key].update(url='http://127.0.0.1:8011',model='fixture',model_revision='fixture-1')
    store=Store(tmp_path)
    store.upsert_pending(Source('manual',title='产品 A 手册',content_hash='v1'),[Chunk('manual-chunk',text='A 型号保修三年。')]);store.activate_revision('manual',1)
    models=ScriptedModels(config)
    store.save_profile('test-profile',{'passed':True,'real_models':True,'reviewed':True,'fingerprint':models.fingerprint,'threshold':.5})
    class Vectors:
        def query(self,vector,ids,limit): return [c.id for c in store.visible_chunks(ids)][:limit]
    service=KnowledgeService(store,Retriever(store,Vectors(),models),models,lambda:config)
    return store,models,service,config


def request(question='A 型号的保修期多久？',request_id='q1',**kwargs):
    return {'request_id':request_id,'question':question,'context':[],'system_constraints':'中文回答',
            'source_ids':[],'mode':'api','online_target':None,'parameters':{},**kwargs}
