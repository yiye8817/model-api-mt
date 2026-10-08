import time

import pytest

from tests.knowledge.answer_harness import build_harness,request


def test_paraphrase_returns_supported_local_answer(tmp_path):
    store,models,service,config=build_harness(tmp_path)
    first=service.query(request('A 型号能保修多长时间？'))
    second=service.query(request('A 型号的保修期是多久？','q2'))
    assert first.decision==second.decision=='hit'
    assert first.citations[0].source_id=='manual'
    assert first.citations[0].quote=='A 型号保修三年。'
    assert store.request('q1')['online_model_requests']==0


@pytest.mark.parametrize('change,reason', [('disabled','disabled'),('empty','empty_index'),('uncalibrated','uncalibrated'),('unavailable','local_unavailable'),('timeout','local_timeout')])
def test_disabled_empty_uncalibrated_unavailable_and_timeout_reasons(tmp_path,change,reason):
    from local_knowledge.model_clients import ModelUnavailable
    store,models,service,c=build_harness(tmp_path)
    if change=='disabled': c['enabled']=False
    elif change=='empty': store.invalidate_source('manual')
    elif change=='uncalibrated': c['evaluation_profile_id']=''
    elif change=='unavailable':
        def unavailable(*args): raise ModelUnavailable('offline')
        models.embed=unavailable
    elif change=='timeout':
        c['local_timeout_seconds']=.001
        models.after_call=lambda task: time.sleep(.005)
    result=service.query(request())
    assert result.decision=='miss' and result.reason==reason
    assert result.answer is None and result.citations==[]


def test_cancelled_query_cannot_become_hit(tmp_path):
    store,models,service,c=build_harness(tmp_path)
    models.after_call=lambda task: service.cancel('q1') if task=='verify' else None
    result=service.query(request())
    assert result.decision=='cancelled' and result.answer is None and result.citations==[]
    assert store.connection.execute('SELECT count(*) FROM answer_cache').fetchone()[0]==0


def test_cancel_before_query_and_duplicate_request(tmp_path):
    store,models,service,c=build_harness(tmp_path)
    service.cancel('q1')
    assert service.query(request()).decision=='cancelled'
    assert models.calls==[]
    assert service.query(request(request_id='q2')).decision=='hit'
    calls=len(models.calls)
    assert service.query(request(request_id='q2')).decision=='hit'
    assert len(models.calls)==calls
    with pytest.raises(ValueError): service.query(request('Other question','q2'))


def test_source_changes_during_verification(tmp_path):
    store,models,service,c=build_harness(tmp_path)
    models.after_call=lambda task: store.invalidate_source('manual') if task=='verify' else None
    result=service.query(request())
    assert result.decision=='miss' and result.reason=='source_changed'


def test_cache_revalidates_current_question_and_dependencies(tmp_path):
    store,models,service,c=build_harness(tmp_path)
    assert service.query(request()).decision=='hit'
    result=service.query(request(request_id='q2'))
    assert result.decision=='hit' and result.answer_origin=='validated_cache'
    store.set_enabled('manual',False)
    assert service.query(request(request_id='q3')).decision=='miss'


def test_stale_latest_answer_misses(tmp_path):
    store,models,service,c=build_harness(tmp_path)
    result=service.query(request('A 型号现在的保修期？'))
    assert result.decision=='miss' and result.reason=='stale_source'


def test_historical_model_answer_is_not_promoted_to_fact(tmp_path):
    store,models,service,c=build_harness(tmp_path)
    from local_knowledge.store import dumps
    from dataclasses import asdict
    s=store.get_source('manual'); s.nature='historical_model_answer'
    with store.connection as conn: conn.execute('UPDATE sources SET body=? WHERE id=?',(dumps(asdict(s)),s.id))
    assert service.query(request()).reason=='insufficient_evidence'


def test_action_request_not_answered_from_cache(tmp_path):
    store,models,service,c=build_harness(tmp_path)
    models.overrides['prepare']=lambda result,payload:{**result,'kind':'action'}
    assert service.query(request('执行这个脚本')).reason=='constraint_mismatch'


def test_repeated_request_id_revalidates_disabled_evidence(tmp_path):
    store,models,service,c=build_harness(tmp_path)
    assert service.query(request()).decision=='hit'
    store.set_enabled('manual',False)
    assert service.query(request()).decision=='miss'


def test_settings_replacement_preserves_request_cancellation(tmp_path):
    from local_knowledge.runtime import Runtime
    from local_knowledge.retrieval import Retriever
    store,models,service,c=build_harness(tmp_path)
    runtime=Runtime(tmp_path,lambda:c,lambda:[])
    try:
        runtime._store=store;current=runtime.components()[0]
        current.models=models;current.matcher.models=models;current.retriever=service.retriever
        def callback(task):
            if task=='verify':
                c['online_fallback']=False
                assert runtime.components()[0].cancel('q1')
        models.after_call=callback
        result=current.query(request())
        assert result.decision=='cancelled'
    finally:runtime.close()


def test_eligible_historical_answer_is_checked_and_labeled(tmp_path):
    from dataclasses import asdict
    from local_knowledge.store import dumps
    store,models,service,c=build_harness(tmp_path)
    source=store.get_source('manual');source.kind='api_chat';source.nature='historical_model_answer'
    source.metadata={'question':'A 型号保修期？','context':[{'role':'user','content':'标准保修，不包含延保'}],'system_constraints':'根据手册回答','completion':{'status':'complete','kind':'api'}}
    with store.connection as conn:conn.execute('UPDATE sources SET body=? WHERE id=?',(dumps(asdict(source)),source.id))
    result=service.query(request())
    assert result.decision=='hit'
    assert result.citations[0].source_kind=='api_chat'
    assert 'match' in models.calls and 'verify' in models.calls


def test_matching_receives_original_source_context_and_constraints(tmp_path):
    from dataclasses import asdict
    from local_knowledge.store import dumps
    from local_knowledge.contracts import Source,Chunk
    store,models,service,c=build_harness(tmp_path)
    source=store.get_source('manual');source.kind='api_chat';source.nature='historical_model_answer'
    source.metadata={'question':'A 型号保修期？','context':[{'role':'user','content':'这一轮只讨论延保'}],'system_constraints':'这是延保的假设场景','completion':{'status':'complete','kind':'api'}}
    with store.connection as conn:conn.execute('UPDATE sources SET body=? WHERE id=?',(dumps(asdict(source)),source.id))
    store.upsert_pending(Source('extra',content_hash='v'),[Chunk('extra',text='A 型号相关说明。')]);store.activate_revision('extra',1)
    observed=[]
    models.overrides['match']=lambda result,payload:(observed.append(payload) or result)
    service.query(request())
    original=next(x for x in observed[0]['chunks'] if x['source_id']=='manual')
    assert original['source_context']['context'][0]['content']=='这一轮只讨论延保'
    assert original['source_context']['system_constraints']=='这是延保的假设场景'
    assert original['source_context']['nature']=='historical_model_answer'


def test_optional_qa_returns_clear_miss_without_model_calls_and_preview_still_works(tmp_path):
    store,models,service,c=build_harness(tmp_path)
    c['qa_endpoint'].update(url='',model='')
    result=service.query(request())
    assert result.decision=='miss' and result.reason=='qa_not_configured'
    assert result.answer is None and models.calls==[]
    assert len(service.preview(request(request_id='preview')))==1
