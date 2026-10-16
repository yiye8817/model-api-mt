import json
import threading

import pytest

from learning.contracts import LearningError
from learning.hermes import request_json
from learning.analysis import DocumentAnalyzer
from tests.learning.test_analysis import analysis_value, context_for


class Context:
    cancel_event=threading.Event()
    def ensure_active(self): pass
    def progress(self,*args,**kwargs): pass


def test_large_complete_json_missing_comma_recovers_without_changing_values():
    value={'answer':'长文内容'*5200,'citations':[],'extension':'','insufficient_evidence':True}
    raw=json.dumps(value,ensure_ascii=False).replace(', "citations"',' "citations"',1)
    with pytest.raises(json.JSONDecodeError) as malformed:
        json.loads(raw)
    assert malformed.value.pos>20000
    calls=[]
    class Model:
        def request(self,*args,**kwargs):
            calls.append(True)
            return raw
    result=request_json(Model(),'instructions',{},Context(),lambda v:v)
    assert result==value
    assert len(calls)==1


def test_trailing_commas_are_removed_but_truncated_values_are_not_invented():
    class Model:
        raw='{"answer":"中文原文", "citations":[],}'
        def request(self,*args,**kwargs): return self.raw
    model=Model()
    assert request_json(model,'instructions',{},Context(),lambda v:v)['answer']=='中文原文'
    model.raw='{"answer":"中文原文", "citations":['
    with pytest.raises(LearningError,match='校验失败'):
        request_json(model,'instructions',{},Context(),lambda v:v)


def test_repaired_output_still_requires_valid_evidence(store,source,chunks):
    from learning.evidence import validate_citations
    doc=store.upsert_document(source,chunks)
    evidence=store.get_chunks(doc['id'],doc['revision'])
    class Model:
        def request(self,*args,**kwargs):
            return '{"answer":"虚构答案" "citations":[{"chunk_id":"'+evidence[0]['id']+'","quote":"不存在的原文"}]}'
    with pytest.raises(LearningError,match='引用不属于提供的原文片段'):
        request_json(Model(),'instructions',{},Context(),lambda value:validate_citations(value['citations'],evidence))


def test_invalid_long_batch_is_split_and_every_source_chunk_is_covered(store,source):
    chunks=[{'text':f'第{i}段量子资料，包含知识点。','position':{'kind':'pdf_page','page':i+1}} for i in range(7)]
    doc=store.upsert_document(source,chunks)
    calls=[]
    class Model:
        def request(self,prompt,*args,**kwargs):
            data=json.loads(prompt.split('\nINPUT_JSON\n')[1])
            batch=data['chunks'];calls.append([c['id'] for c in batch])
            if len(batch)>1:
                return '{"summary":"模型输出被截断'
            return json.dumps(analysis_value(batch[0],name='知识点'+str(batch[0]['ordinal'])),ensure_ascii=False)
    jobs,context=context_for(store,doc)
    try:
        DocumentAnalyzer(store,Model()).run({'document_ids':[doc['id']]},context)
        result=store.get_analysis(doc['id'])
        assert result['coverage']=={'processed':7,'total':7}
        assert len(result['concepts'])==7
        assert {c['citations'][0]['chunk_id'] for c in result['concepts']}=={c['id'] for c in store.get_chunks(doc['id'],1)}
        assert any(len(batch)>1 for batch in calls)
    finally:
        jobs.shutdown()


def test_model_retry_receives_the_failed_response_and_preserves_input():
    prompts=[]
    class Model:
        def request(self,prompt,*args,**kwargs):
            prompts.append(prompt)
            return 'not-json-output-unique' if len(prompts)==1 else '{"answer":"recovered"}'
    data={'question':'原始问题','evidence':[{'text':'待引用原文'}]}
    assert request_json(Model(),'instructions',data,Context(),lambda v:v)=={'answer':'recovered'}
    assert 'not-json-output-unique' in prompts[1]
    assert json.loads(prompts[1].split('\nINPUT_JSON\n')[1])==data
