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
