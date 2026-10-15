import json
import pytest

from learning.service import LearningService
from learning.retrieval import Retriever, validate_citations
from learning.jobs import LearningJobs
from learning.graph import GraphService
from learning.contracts import LearningError
from tests.learning.test_jobs import wait_terminal


class AnswerModel:
    def available(self): return {'available':True}
    def request(self, prompt, *args, **kwargs):
        data = json.loads(prompt.split('\nINPUT_JSON\n')[1])
        chunk = data['evidence'][0]
        return json.dumps({'answer':'依据资料：'+chunk['text'], 'extension':'', 'citations':[{'chunk_id':chunk['id'],'quote':chunk['text']}]}, ensure_ascii=False)


def build_service(store, model=None):
    jobs = LearningJobs(store)
    service = LearningService(store,jobs,model or AnswerModel(),Retriever(store),None,GraphService(store),None)
    jobs.register('question', service.answer_job)
    jobs.register('exploration', service.explore_job)
    return service


def test_selected_question_and_followup_cannot_expand_scope(store, source):
    a = store.upsert_document(source, [{'text':'A 型号保修三年。','position':{'kind':'lines'}}])
    b = store.upsert_document({**source,'source_id':'b'}, [{'text':'B 型号保修一年。','position':{'kind':'lines'}}])
    service = build_service(store)
    try:
        scope = {'mode':'selected','document_ids':[a['id']]}
        job = service.ask('保修期多久？',scope)
        done = wait_terminal(store,job['id'])
        assert done['status'] == 'completed'
        turn = done['result']['turn']
        assert {c['document_id'] for c in turn['citations']} == {a['id']}
        with pytest.raises(LearningError):
            service.ask('继续解释',{'mode':'all'},conversation_id=done['result']['conversation_id'])
        follow = service.ask('继续解释',scope,conversation_id=done['result']['conversation_id'])
        assert wait_terminal(store,follow['id'])['status'] == 'completed'
        assert len(store.get_conversation(done['result']['conversation_id'])['turns']) == 2
    finally:
        service.jobs.shutdown()


def test_no_evidence_and_forged_quote_are_explicit(store, source, chunks):
    doc = store.upsert_document(source,chunks)
    service = build_service(store)
    try:
        job = service.ask('汽车维修费是多少',{'mode':'selected','document_ids':[doc['id']]})
        done = wait_terminal(store,job['id'])
        assert done['result']['turn']['insufficient_evidence'] is True
        assert done['result']['turn']['citations'] == []
    finally:
        service.jobs.shutdown()
    evidence = store.get_chunks(doc['id'],1)
    with pytest.raises(LearningError):
        validate_citations([{'chunk_id':evidence[0]['id'],'quote':'伪造引句'}], evidence)


def test_text_retrieval_survives_semantic_failure(store, source):
    doc = store.upsert_document(source,[{'text':'量子叠加的原理是线性组合。','position':{'kind':'lines'}}])
    def broken(*a): raise RuntimeError('语义模型离线')
    hits = Retriever(store,broken).search('量子叠加原理',{doc['id']:1})
    assert hits[0]['document_id'] == doc['id']


def test_document_overview_retrieves_each_selected_source(store,source):
    a=store.upsert_document(source,[{'text':'第一份材料介绍量子态。','position':{'kind':'lines'}}])
    b=store.upsert_document({**source,'source_id':'b'},[{'text':'第二份材料介绍概率振幅。','position':{'kind':'lines'}}])
    hits=Retriever(store).search('概括这两份文档的主要内容',{a['id']:1,b['id']:1})
    assert {c['document_id'] for c in hits}=={a['id'],b['id']}


def test_malformed_followup_scope_is_rejected_as_input(store,source,chunks):
    doc=store.upsert_document(source,chunks);service=build_service(store)
    try:
        job=service.ask('什么是量子叠加',{'mode':'selected','document_ids':[doc['id']]})
        conversation_id=wait_terminal(store,job['id'])['result']['conversation_id']
        with pytest.raises(LearningError):
            service.ask('继续',{'mode':'selected','document_ids':None},conversation_id=conversation_id)
    finally:service.jobs.shutdown()


def test_deep_conversation_uses_scoped_evidence_and_preserves_followups(store,source,chunks):
    prompts=[]
    class Model(AnswerModel):
        def request(self,prompt,*args,**kwargs):
            prompts.append(prompt)
            return super().request(prompt,*args,**kwargs)
    doc=store.upsert_document(source,chunks)
    other=store.upsert_document({**source,'source_id':'other'},[{'text':'其他资料的独有叠加观点。','position':{}}])
    service=build_service(store,Model())
    try:
        scope={'mode':'selected','document_ids':[doc['id']]}
        first=service.ask('量子叠加是什么？',scope)
        done=wait_terminal(store,first['id'])
        conversation_id=done['result']['conversation_id']
        deep=service.ask('深入解释原理和误区',scope,conversation_id=conversation_id,mode='explore')
        result=wait_terminal(store,deep['id'])
        assert result['status']=='completed',result['error']
        assert result['result']['conversation_id']==conversation_id
        assert result['result']['turn']['mode']=='explore'
        data=json.loads(prompts[-1].split('\nINPUT_JSON\n')[1])
        assert data['mode']=='explore'
        assert data['history'][0]['question']=='量子叠加是什么？'
        assert {c['document_id'] for c in data['evidence']}=={doc['id']}
        assert other['id'] not in prompts[-1]
        assert all(part in prompts[-1].split('\nINPUT_JSON\n')[0] for part in ('前置知识','常见误区','后续问题'))
        assert [t['mode'] for t in store.get_conversation(conversation_id)['turns']]==['query','explore']
    finally:
        service.jobs.shutdown()


@pytest.mark.parametrize('mode',['unknown',None,{},True])
def test_invalid_conversation_mode_is_rejected(store,source,chunks,mode):
    doc=store.upsert_document(source,chunks)
    service=build_service(store)
    try:
        with pytest.raises(LearningError,match='模式'):
            service.ask('量子叠加',{'mode':'selected','document_ids':[doc['id']]},mode=mode)
        assert store.active_jobs()==[]
    finally:
        service.jobs.shutdown()


def test_deep_conversation_without_evidence_reports_insufficiency(store,source,chunks):
    class NoModel(AnswerModel):
        def request(self,*args,**kwargs):
            raise AssertionError('No evidence must not trigger generation')
    doc=store.upsert_document(source,chunks)
    service=build_service(store,NoModel())
    try:
        job=service.ask('汽车维修费是多少',{'mode':'all'},mode='explore')
        result=wait_terminal(store,job['id'])
        assert result['status']=='completed'
        assert result['result']['turn']['mode']=='explore'
        assert result['result']['turn']['insufficient_evidence'] is True
        assert result['result']['turn']['citations']==[]
        assert result['result']['turn']['document_revisions']=={doc['id']:1}
    finally:
        service.jobs.shutdown()
