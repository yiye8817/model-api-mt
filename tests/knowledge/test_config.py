import copy

import pytest


def test_defaults_off_and_exact_budgets():
    from local_knowledge.config import default_config
    c = default_config()
    assert c['enabled'] is False
    assert (c['vector_top_k'], c['rerank_top_k']) == (20, 5)
    assert (c['local_timeout_seconds'], c['time_sensitive_ttl_seconds']) == (30, 3600)
    assert c['embedding_endpoint']['url'] == ''
    c['qa_endpoint']['model'] = 'changed'
    assert default_config()['qa_endpoint']['model'] == ''


@pytest.mark.parametrize('patch', [
    {'enabled': 'yes'}, {'local_timeout_seconds': -1},
    {'vector_top_k': True}, {'rerank_top_k': 0},
    {'qa_endpoint': {'protocol': 'cloud'}},
    {'embedding_endpoint': {'url': 'https://public.example/v1'}},
])
def test_invalid_config_rejected(patch):
    from local_knowledge.config import validate_config
    with pytest.raises(ValueError):
        validate_config(patch)


def test_changed_context_changes_fingerprint():
    from local_knowledge.config import request_fingerprint
    request = {'question': '保修期多久', 'context': [{'role': 'user', 'content': 'A 型号'}],
               'system_constraints': '中文', 'mode': 'api', 'parameters': {},
               'online_target': {'kind': 'api', 'provider_id': 'p', 'model': 'm'}}
    original = request_fingerprint(request, ['s1'])
    for key, value in [('question', '型号 B 的保修期'), ('context', []),
                       ('system_constraints', 'English'), ('mode', 'web'),
                       ('parameters', {'temperature': 0.1}),
                       ('online_target', {'kind': 'api', 'provider_id': 'p', 'model': 'm2'})]:
        other = copy.deepcopy(request)
        other[key] = value
        assert request_fingerprint(other, ['s1']) != original
    assert request_fingerprint(request, ['s2']) != original
    assert request_fingerprint({**request, 'request_id': 'other'}, ['s1']) == original
    with pytest.raises(ValueError):
        request_fingerprint({**request, 'online_target': {'apiKey': 'secret'}}, ['s1'])


def test_reset_knowledge_preserves_other_settings(tmp_path, monkeypatch):
    import server
    monkeypatch.setattr(server, 'SETTINGS_FILE', str(tmp_path / 'settings.json'))
    client = server.app.test_client()
    assert client.post('/api/settings', json={'model_params': {'temperature': 0.3},
                                           'local_knowledge': {'enabled': True}}).status_code == 200
    result = client.post('/api/settings/reset', json={'section': 'local_knowledge'})
    assert result.json['settings']['local_knowledge']['enabled'] is False
    assert result.json['settings']['model_params']['temperature'] == 0.3
    bad = client.post('/api/settings', json={'local_knowledge': {'enabled': 'yes'}})
    assert bad.status_code == 400
    assert client.get('/api/settings').json['model_params']['temperature'] == 0.3
