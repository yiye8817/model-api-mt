"""Real HTTP/storage/worker flow; only the external Hermes inference is replaced."""
import io
import json
from flask import Flask
from learning.api import create_blueprint
from learning.runtime import LearningRuntime
from local_knowledge.store import Store
from local_knowledge.contracts import Source,Chunk
from tests.learning.test_jobs import wait_terminal
from tests.learning.test_analysis import analysis_value


class StructuredSession:
    def __init__(self,send_json,**kwargs): self.emit=send_json
    def start(self): return True
    def close(self,**kwargs): pass
    def send_user(self,prompt):
        data=json.loads(prompt.split('\nINPUT_JSON\n')[1]); operation=data['operation']
        if operation=='analysis': value=analysis_value(data['chunks'][0],'量子叠加','物理')
        else:
            c=data['evidence'][0]; citations=[{'chunk_id':c['id'],'quote':c['text']}]
            if operation=='question': value={'answer':'量子叠加是多个状态的组合。','citations':citations,'extension':'','insufficient_evidence':False}
            elif operation=='exploration': value={'principles':'状态组合','prerequisites':'向量','examples':'两个状态','pitfalls':'振幅与概率','related':'干涉','questions':['如何验证？'],'extension':'教学拓展','citations':citations}
            else: value={'markdown':'## 综合学习\n\n量子叠加与状态组合。','citations':citations}
        self.emit({'type':'response','text':json.dumps(value,ensure_ascii=False)});self.emit({'type':'done'})


def make_api(tmp_path,local):
    runtime=LearningRuntime(tmp_path/'learning',StructuredSession,lambda:[],lambda:True,lambda:local,None)
    app=Flask(__name__);app.register_blueprint(create_blueprint(runtime.components))
    return runtime,app.test_client()


def test_learning_flow_survives_restart_and_source_removal(tmp_path,monkeypatch):
    local=Store(tmp_path/'local')
    local.upsert_pending(Source('existing',title='已有资料',content_hash='old'),[Chunk('c',text='量子叠加是状态的线性组合。')]);local.activate_revision('existing',1)
    runtime,client=make_api(tmp_path,local)
    try:
        assert client.post('/api/learning/sync',json={}).json['added']==1
        service=runtime.components()
        existing=client.get('/api/learning/documents').json['items'][0]
        created=client.post('/api/learning/analyze',json={'scope':{'mode':'all'}}).json['job']
        assert wait_terminal(service.store,created['id'])['status']=='completed'
        response=client.post('/api/learning/documents/upload',data={'files':[
            (io.BytesIO('量子叠加可以表示多个状态。'.encode()),'笔记A.md'),
            (io.BytesIO('量子叠加与干涉有关。'.encode()),'笔记B.txt')]},content_type='multipart/form-data')
        assert response.json['accepted']==2
        for item in response.json['items']:
            assert wait_terminal(service.store,item['job_id'])['status']=='completed'
        docs=client.get('/api/learning/documents').json['items'];assert len(docs)==3
        doc=next(d for d in docs if d['title']=='笔记A.md')
        assert client.get(f'/api/learning/documents/{doc["id"]}/analysis').json['analysis']['tree']['children']
        scope={'mode':'selected','document_ids':[doc['id']]}
        asked=client.post('/api/learning/questions',json={'question':'什么是量子叠加？','scope':scope}).json['job']
        answer=wait_terminal(service.store,asked['id'])
        assert answer['status']=='completed'
        turn=answer['result']['turn'];assert {c['document_id'] for c in turn['citations']}=={doc['id']}
        conversation_id=answer['result']['conversation_id']
        follow=client.post('/api/learning/questions',json={'question':'继续解释叠加','scope':scope,'conversation_id':conversation_id}).json['job']
        assert wait_terminal(service.store,follow['id'])['status']=='completed'
        assert len(client.get('/api/learning/conversations/'+conversation_id).json['conversation']['turns'])==2
        concept=client.get('/api/learning/concepts').json['items'][0];assert len(concept['document_ids'])==3
        explore=client.post('/api/learning/concepts/'+concept['id']+'/explore',json={}).json['job']
        assert wait_terminal(service.store,explore['id'])['status']=='completed'
        assert client.post('/api/learning/archives/notes',json={'origin':{'kind':'turn','id':turn['id']}}).status_code==201
        archived=client.post('/api/learning/archives',json={'scope':{'mode':'all'},'title':'量子学习'}).json['job']
        result=wait_terminal(service.store,archived['id']);assert result['status']=='completed'
        archive=result['result']['archive'];archive_id=archive['id']
        exported=client.get(f'/api/learning/archives/{archive_id}/export?format=json').json
        assert len(exported['graph']['nodes'])==4
        # Complete-before-response scheduling must not overwrite the finished document state.
        submit=service.jobs.submit
        def immediate(*a,**kw):
            job=submit(*a,**kw);wait_terminal(service.store,job['id']);return service.store.get_job(job['id'])
        monkeypatch.setattr(service.jobs,'submit',immediate)
        reanalysis=client.post('/api/learning/analyze',json={'scope':scope})
        assert reanalysis.status_code==202
        assert service.store.get_document(doc['id'])['status']=='completed'
    finally:
        runtime.close()
    runtime,client=make_api(tmp_path,local)
    try:
        assert client.get('/api/learning/archives/'+archive_id).json['archive']['markdown']==archive['markdown']
        local.upsert_pending(Source('existing',title='已有资料',content_hash='new'),[Chunk('new',text='量子学习资料更新。')]);local.activate_revision('existing',2)
        assert client.post('/api/learning/sync',json={}).json['updated']==1
        assert client.get('/api/learning/archives/'+archive_id).json['archive']['needs_update'] is True
        assert client.delete('/api/learning/documents/'+doc['id']).status_code==200
        kept=client.get('/api/learning/concepts/'+concept['id']).json['concept']
        assert len(kept['document_ids'])==1
        assert client.get('/api/learning/graph').json['coverage']=={'analyzed':1,'total':2}
    finally:
        runtime.close()
