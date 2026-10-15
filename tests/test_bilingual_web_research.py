import json
import threading

import pytest
import server


def test_keyword_models_prefer_intent_and_fall_back_to_the_default_provider():
    providers = [
        {'id': 'intent', 'baseUrl': 'https://intent.example', 'apiKey': 'intent-key', 'apiType': 'anthropic', 'selectedModel': 'other'},
        {'id': 'default', 'baseUrl': 'https://default.example/v1', 'apiKey': 'default-key', 'selectedModel': 'default-model', 'isDefault': True},
    ]
    data = {'baseUrl': 'https://selected.example/v1', 'apiKey': 'selected-key', 'model': 'selected-model'}
    targets = server._resolve_keyword_models(data, {'model_roles': {'intent': {'providerId': 'intent', 'model': 'intent-model'}}}, providers)
    assert targets[0]['model'] == 'intent-model' and targets[0]['apiType'] == 'anthropic'
    assert targets[1]['model'] == 'default-model'
    assert server._resolve_keyword_models(data, {}, providers)[0]['model'] == 'default-model'
    assert server._resolve_keyword_models(data, {}, [])[0]['model'] == 'selected-model'
    assert data['model'] == 'selected-model'


def test_same_gateway_model_keeps_a_default_with_different_authentication():
    from web_research.keywords import KeywordPlanner
    providers = [
        {'id': 'intent', 'baseUrl': 'https://same.example/v1', 'apiKey': 'invalid', 'apiType': 'anthropic', 'selectedModel': 'shared'},
        {'id': 'default', 'baseUrl': 'https://same.example/v1', 'apiKey': 'working', 'selectedModel': 'shared', 'isDefault': True},
    ]
    targets = server._resolve_keyword_models({'baseUrl': 'https://selected.example/v1', 'model': 'selected'},
        {'model_roles': {'intent': {'providerId': 'intent', 'model': 'shared'}}}, providers)
    def generate(target, prompt, cancel):
        if target['apiType'] == 'anthropic' or target['apiKey'] != 'working':
            raise RuntimeError('HTTP 401')
        return '{"zh":["内存工具"],"en":["memory tools"]}'
    plan = KeywordPlanner(lambda data: targets, generate)({'query': '内存工具'}, threading.Event(), lambda *args: None)
    assert plan['keyword_source'] == 'default'
    assert plan['queries'][1]['query'] == 'memory tools'


@pytest.mark.parametrize('question', ['内存性能工具有哪些', 'Linux 内存 performance 工具有哪些'])
def test_chinese_and_mixed_queries_generate_two_language_searches(question):
    from web_research.keywords import KeywordPlanner
    def generate(target, prompt, cancel):
        assert target['model'] == 'intent-model'
        payload = json.loads(prompt)
        assert payload['question'] == question
        assert payload['context'] == [{'role': 'user', 'content': '讨论 Linux'}]
        return '```json\n{"zh":["Linux","内存性能工具"],"en":["Linux","memory performance tools"]}\n```'
    planner = KeywordPlanner(lambda data: [{'model': 'intent-model', 'source': 'intent'}], generate)
    plan = planner({'query': question, 'context': [{'role': 'user', 'content': '讨论 Linux'}]}, threading.Event(), lambda *args: None)
    assert plan['queries'] == [{'language': 'zh', 'query': 'Linux 内存性能工具'}, {'language': 'en', 'query': 'Linux memory performance tools'}]
    assert plan['keyword_model'] == 'intent-model'


def test_english_search_does_not_call_a_translation_model():
    from web_research.keywords import KeywordPlanner
    def unexpected(*args):
        raise AssertionError('English should search directly')
    plan = KeywordPlanner(unexpected, unexpected)({'query': 'Linux memory performance tools'}, threading.Event(), lambda *args: None)
    assert plan['queries'] == [{'language': 'original', 'query': 'Linux memory performance tools'}]


def test_invalid_bilingual_output_uses_the_default_model_without_inventing_a_translation():
    from web_research.keywords import KeywordPlanner
    events = []
    def generate(target, prompt, cancel):
        if target['source'] == 'intent':
            return '{"zh":["内存工具"],"en":["内存工具"]}'
        return '{"zh":["内存性能工具"],"en":["memory performance tools"]}'
    plan = KeywordPlanner(lambda data: [{'model': 'intent', 'source': 'intent'}, {'model': 'default', 'source': 'default'}], generate)(
        {'query': '内存性能工具'}, threading.Event(), lambda kind, data: events.append((kind, data)))
    assert plan['keyword_model'] == 'default'
    assert plan['queries'][1]['query'] == 'memory performance tools'
    assert any(kind == 'status' and data['status'] == 'retrying' for kind, data in events)


def test_cancelled_keyword_generation_does_not_start_a_fallback_model():
    from web_research.keywords import KeywordPlanner
    from web_research.opencli import SearchFailure
    cancel = threading.Event()
    def generate(target, prompt, event):
        assert target['model'] == 'intent'
        event.set()
        return '{"zh":["内存工具"],"en":["memory tools"]}'
    with pytest.raises(SearchFailure) as failure:
        KeywordPlanner(lambda data: [{'model': 'intent'}, {'model': 'default'}], generate)({'query': '内存工具'}, cancel, lambda *args: None)
    assert failure.value.code == 'CANCELLED'


def test_two_languages_search_in_parallel_and_share_ddgs_with_provider():
    from web_research.service import ResearchPipeline
    entered = {language: threading.Event() for language in ('中文检索词', 'English terms')}
    seen, ddgs_calls, final_sources = [], [], []
    def keywords(data, cancel, emit):
        return {'keywords': {'zh': ['中文检索词'], 'en': ['English terms']},
                'queries': [{'language': 'zh', 'query': '中文检索词'}, {'language': 'en', 'query': 'English terms'}],
                'keyword_model': 'intent-model'}
    class Sites:
        def search(self, site, query, cancel, emit):
            seen.append((site, query))
            if site == 'google':
                entered[query].set()
                other = 'English terms' if query == '中文检索词' else '中文检索词'
                assert entered[other].wait(2), 'Both language searches must run concurrently'
            if site == 'x' and query == '中文检索词':
                raise RuntimeError('中文 X 搜索失败')
            language = 'zh' if query == '中文检索词' else 'en'
            return [{'id': f'{site}-{language}', 'channel': site, 'url': f'https://example.org/{site}/{language}', 'title': site, 'content': f'{query}正文'}]
    def ddgs(query, cancel, emit):
        ddgs_calls.append(query)
        return [{'id': query, 'channel': 'ddgs', 'url': f'https://example.org/ddgs/{len(query)}', 'title': 'DDGS', 'content': query}]
    def provider(data, cancel, emit, search):
        assert data['query'] == '用户原问题' and data['model'] == 'selected-model'
        rows = search('Provider自主扩展词', cancel, emit)
        assert {row['query_language'] for row in rows} == {'zh', 'en'}
        return {'answer': '已获取双语证据'}
    def synthesize(data, sources, candidate):
        final_sources.extend(sources)
        return {'answer': '综合答案', 'model': data['model']}
    pipeline = ResearchPipeline(provider, Sites(), ddgs, lambda *args: [], synthesize, keyword_plan=keywords)
    events = list(pipeline.events({'query': '用户原问题', 'model': 'selected-model'}, threading.Event()))
    assert events[-1]['type'] == 'complete'
    assert {(site, query) for site in ('official', 'google', 'youtube', 'x', 'reddit', 'github') for query in entered} <= set(seen)
    assert sorted(ddgs_calls) == ['English terms', '中文检索词']
    assert {s['query_language'] for s in final_sources} == {'zh', 'en'}
    assert any(e['type'] == 'status' and e.get('channel') == 'x' and e.get('query_language') == 'zh' and e['status'] == 'error' for e in events)
    assert next(i for i, e in enumerate(events) if e['type'] == 'plan') < next(i for i, e in enumerate(events) if e['type'] == 'result')


def test_cancelling_during_keywords_never_launches_search():
    from web_research.service import ResearchPipeline
    cancel = threading.Event()
    def keywords(data, event, emit):
        event.wait(1)
        return {'queries': [{'language': 'zh', 'query': '中文'}]}
    class Sites:
        def search(self, *args):
            raise AssertionError('Search must not start after cancellation')
    pipeline = ResearchPipeline(lambda *args: None, Sites(), lambda *args: [], lambda *args: [], lambda *args: None, keyword_plan=keywords)
    events = []
    for event in pipeline.events({'query': '中文', 'model': 'selected'}, cancel):
        events.append(event)
        if event.get('channel') == 'keywords':
            cancel.set()
    assert not any(event['type'] in ('result', 'complete', 'plan') for event in events)


def test_stream_keyword_request_uses_the_intent_endpoint_and_authentication(monkeypatch):
    from web_research.service import ResearchPipeline
    settings = {'local_knowledge': {'enabled': False}, 'model_roles': {'intent': {'providerId': 'intent', 'model': 'intent-model'}}}
    providers = [{'id': 'intent', 'baseUrl': 'https://intent.example', 'apiKey': 'intent-key', 'apiType': 'anthropic'}]
    monkeypatch.setattr(server, '_load_settings', lambda: settings)
    monkeypatch.setattr(server, '_load_json', lambda path, default: providers if path == server.PROVIDERS_FILE else default)
    class Response:
        status_code = 200
        def raise_for_status(self): pass
        def json(self):
            return {'content': [{'type': 'text', 'text': '{"zh":["多级页表"],"en":["multilevel page table"]}'}], 'usage': {}}
    def post(url, **kwargs):
        assert url == 'https://intent.example/v1/messages'
        assert kwargs['headers']['x-api-key'] == 'intent-key'
        assert kwargs['json']['model'] == 'intent-model'
        return Response()
    monkeypatch.setattr(server.http_requests, 'post', post)
    def events(self, data, cancel):
        plan = self.keyword_plan(data, cancel, lambda *args: None)
        assert plan['keyword_model'] == 'intent-model'
        assert data['model'] == 'selected-model'
        yield {'type': 'plan', **plan}
    monkeypatch.setattr(ResearchPipeline, 'events', events)
    with server.app.test_client().post('/api/research/stream', json={
        'query': '什么是多级页表', 'model': 'selected-model', 'baseUrl': 'https://selected.example/v1'}) as response:
        assert 'multilevel page table' in response.get_data(as_text=True)


def test_source_budget_keeps_chinese_and_english_and_deduplicates_urls():
    from web_research.sources import select_sources
    sources = [{'channel': 'google', 'query_language': 'zh', 'url': f'https://example.org/zh/{n}', 'content': '中文'} for n in range(5)]
    sources.append({'channel': 'google', 'query_language': 'en', 'url': 'https://example.org/en', 'content': 'English'})
    selected = select_sources(sources, maximum=2)
    assert {row['query_language'] for row in selected} == {'zh', 'en'}
    assert len({row['url'] for row in select_sources([*sources, *sources])}) == len(select_sources([*sources, *sources]))


def test_provider_tool_evidence_contains_both_languages_even_when_chinese_has_more_results(monkeypatch):
    from web_research.providers import ProviderSearch
    bodies = []
    class Response:
        status_code = 200
        def json(self):
            if len(bodies) == 1:
                return {'choices': [{'message': {'role': 'assistant', 'content': '', 'tool_calls': [
                    {'id': 'c', 'type': 'function', 'function': {'name': 'web_search', 'arguments': '{"query":"memory tools"}'}}]}}]}
            evidence = json.loads(next(m['content'] for m in bodies[-1]['messages'] if m['role'] == 'tool'))
            assert {row['query_language'] for row in evidence} == {'zh', 'en'}
            return {'choices': [{'message': {'content': '双语综合结果'}}]}
    def post(url, **kwargs):
        bodies.append(kwargs['json'])
        return Response()
    monkeypatch.setattr('web_research.providers.requests.post', post)
    rows = [{'channel': 'ddgs', 'query_language': 'zh', 'url': f'https://example.org/zh/{n}', 'content': '中文正文'} for n in range(3)]
    rows.append({'channel': 'ddgs', 'query_language': 'en', 'url': 'https://example.org/en', 'content': 'English page'})
    result = ProviderSearch()({'query': '内存工具', 'model': 'selected', 'baseUrl': 'https://selected.example/v1',
        'search_queries': [{'language': 'zh', 'query': '内存工具'}, {'language': 'en', 'query': 'memory tools'}]},
        threading.Event(), lambda *args: None, lambda *args: rows)
    assert result['answer'] == '双语综合结果'


def test_late_keyword_timeout_cannot_replace_searches_or_corrupt_completion_count(monkeypatch):
    from types import SimpleNamespace
    import web_research.service as service
    clock = iter([0])
    monkeypatch.setattr(service, 'time', SimpleNamespace(monotonic=lambda: next(clock, 61)))
    seen = []
    def keywords(data, event, emit):
        event.wait(1)
        return {'queries': [{'language': 'en', 'query': 'late keywords'}]}
    class Sites:
        def search(self, site, query, cancel, emit):
            seen.append(query)
            return [{'id': site, 'channel': site, 'url': f'https://example.org/{site}', 'content': '网页原文'}]
    pipeline = service.ResearchPipeline(lambda *args: {}, Sites(), lambda *args: [], lambda *args: [],
        lambda data, sources, candidate: {'answer': '综合成功'}, keyword_plan=keywords)
    events = list(pipeline.events({'query': '原始中文问题', 'model': 'selected'}, threading.Event()))
    assert events[-1]['type'] == 'complete'
    assert set(seen) == {'原始中文问题'}
    assert any(e.get('code') == 'KEYWORDS_TIMEOUT' for e in events)


def test_an_unreadable_official_candidate_does_not_skip_the_next_link():
    from web_research.service import ResearchPipeline
    parsed = []
    class Sites:
        def search(self, site, *args):
            if site != 'official': return []
            return [{'id': name, 'channel': site, 'url': f'https://example.org/{name}', 'title': name, 'snippet': '搜索摘要'} for name in ('broken', 'valid')]
    def parse(source, cancel):
        parsed.append(source['title'])
        if source['title'] == 'broken': raise RuntimeError('HTTP 404')
        return [{**source, 'content': '实际官方网页正文'}]
    def synthesize(data, sources, candidate):
        assert any(row.get('content') == '实际官方网页正文' for row in sources)
        return {'answer': '已核对官方正文'}
    events = list(ResearchPipeline(lambda *args: {}, Sites(), lambda *args: [], parse, synthesize).events(
        {'query': 'memory tools', 'model': 'selected'}, threading.Event()))
    assert parsed == ['broken', 'valid']
    assert events[-1]['type'] == 'complete'
