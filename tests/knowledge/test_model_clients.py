import multiprocessing
import threading
import time

import pytest

from tests.knowledge.model_server import ModelServer


def budget(seconds=30):
    from local_knowledge.model_clients import Budget
    return Budget(seconds, threading.Event())


def test_embedding_dimension_and_order():
    from local_knowledge.model_clients import ModelClients
    with ModelServer({'/v1/embeddings': {'data': [{'index': 1, 'embedding': [0., 1.]}, {'index': 0, 'embedding': [1., 0.]}]}}) as s:
        c = ModelClients(s.config)
        assert c.embed(['a', 'b'], budget()) == [[1., 0.], [0., 1.]]
        assert c.dimension == 2


@pytest.mark.parametrize('data', [
    [{'index': 0, 'embedding': [float('nan')]}],
    [{'index': 0, 'embedding': []}],
    [{'index': 0, 'embedding': [True]}],
    [{'index': 4, 'embedding': [1.]}],
])
def test_embedding_rejects_nonfinite(data):
    from local_knowledge.model_clients import ModelClients, ModelUnavailable
    with ModelServer({'/v1/embeddings': {'data': data}}) as s:
        with pytest.raises(ModelUnavailable):
            ModelClients(s.config).embed(['question'], budget())


@pytest.mark.parametrize('results', [
    [{'index': 2, 'relevance_score': .8}],
    [{'index': 0, 'relevance_score': .8}, {'index': 0, 'relevance_score': .5}],
    [{'index': 0, 'relevance_score': float('inf')}],
])
def test_rerank_rejects_duplicate_or_out_of_range_index(results):
    from local_knowledge.contracts import Candidate, Chunk
    from local_knowledge.model_clients import ModelClients, ModelUnavailable
    with ModelServer({'/v1/rerank': {'results': results}}) as s:
        with pytest.raises(ModelUnavailable):
            ModelClients(s.config).rerank('q', [Candidate(Chunk('a',text='a')), Candidate(Chunk('b',text='b'))], budget())


@pytest.mark.parametrize('content,finish', [('', 'stop'), ('{"ok":', 'stop'), ('{"ok": true}', 'length')])
def test_json_chat_rejects_truncated_and_empty_output(content, finish):
    from local_knowledge.model_clients import ModelClients, ModelUnavailable
    with ModelServer({'/v1/chat/completions': {'choices': [{'message': {'content': content}, 'finish_reason': finish}]}}) as s:
        with pytest.raises(ModelUnavailable):
            ModelClients(s.config).json_chat([{'role': 'user', 'content': 'q'}], {'type': 'object'}, budget())


def test_structured_qa_disables_template_thinking_to_keep_the_json_budget():
    from local_knowledge.model_clients import ModelClients
    def respond(payload):
        if payload.get('chat_template_kwargs',{}).get('enable_thinking') is False:
            return {'choices':[{'message':{'content':'{"answerable":true}'},'finish_reason':'stop'}]}
        return {'choices':[{'message':{'content':''},'finish_reason':'length'}]}
    with ModelServer({'/v1/chat/completions':respond}) as s:
        result=ModelClients(s.config).json_chat([{'role':'user','content':'检查原文是否可答'}],
            {'type':'object','properties':{'answerable':{'type':'boolean'}},'required':['answerable']},budget())
        assert result=={'answerable':True}


def test_redirect_to_public_host_not_followed():
    from local_knowledge.model_clients import ModelClients, ModelUnavailable
    with ModelServer({'/v1/embeddings': (302, {'location': 'https://public.example'})}) as s:
        with pytest.raises(ModelUnavailable):
            ModelClients(s.config).embed(['q'], budget())
        assert len(s.calls) == 1


def test_lan_requires_explicit_allowance():
    from local_knowledge.model_clients import resolve_endpoint, ModelUnavailable
    for url in ('http://192.168.1.2:8011', 'http://localhost.example.com', 'http://8.8.8.8', 'http://0.0.0.0'):
        with pytest.raises(ModelUnavailable):
            resolve_endpoint({'url': url, 'allow_lan': False})
    assert resolve_endpoint({'url': 'http://[::1]:8011', 'allow_lan': False})[1] == '::1'
    assert resolve_endpoint({'url': 'http://192.168.1.2', 'allow_lan': True})[1] == '192.168.1.2'


def test_budget_not_restarted_between_calls():
    from local_knowledge.model_clients import LocalTimeout
    b = budget(.03)
    time.sleep(.04)
    with pytest.raises(LocalTimeout):
        b.check()


def test_cancel_closes_inflight_transport():
    from local_knowledge.model_clients import ModelClients, Cancelled
    before = {p.pid for p in multiprocessing.active_children()}
    with ModelServer() as s:
        s.delay = 2
        b = budget()
        timer = threading.Timer(.2, b.cancel_event.set)
        timer.start()
        start = time.monotonic()
        with pytest.raises(Cancelled):
            ModelClients(s.config).embed(['q'], b)
        assert time.monotonic() - start < 1
        timer.join()
    assert {p.pid for p in multiprocessing.active_children()} == before


def test_model_revision_changes_fingerprint():
    from local_knowledge.config import default_config, model_fingerprint
    c = default_config()
    first = model_fingerprint(c, 3)
    c['qa_endpoint']['model_revision'] = 'new-weights'
    assert model_fingerprint(c, 3) != first


def test_probe_skips_optional_unconfigured_qa_but_checks_both_retrieval_roles():
    from local_knowledge.model_clients import ModelClients
    with ModelServer({'/v1/embeddings':{'data':[{'index':0,'embedding':[1.,0.]}]},
        '/v1/rerank':{'results':[{'index':0,'relevance_score':.8}]}}) as s:
        config=s.config;config['qa_endpoint'].update(url='',model='')
        roles=ModelClients(config).probe(budget())
        assert roles['embedding']['available'] and roles['rerank']['available']
        assert roles['qa'].get('skipped') is True and roles['qa']['error'] is None
        assert len(s.calls)==2
