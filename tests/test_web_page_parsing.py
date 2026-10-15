import json
import threading
from unittest.mock import patch

import pytest
import server


def test_page_parse_success_extracts_main_content_and_its_summary():
    from web_research.pages import PageParser
    html = '<title>内存工具手册</title><nav>广告导航并非正文</nav><main><h1>内存性能</h1><p>内存性能工具可以记录内存访问和缓存命中率，并帮助定位程序的性能瓶颈。</p><p>使用工具前应记录基准数据，并对比优化前后的测量结果。</p></main><script>伪造的最新事实</script>'
    result = PageParser(fetch=lambda *args: {'html': html, 'text': '无关导航', 'url': 'https://example.org/docs', 'title': '旧标题'}).parse(
        {'id': 'g', 'channel': 'google', 'url': 'https://example.org/docs', 'title': '搜索标题', 'snippet': '搜索摘要'},
        {'query': '内存性能工具'}, threading.Event())
    assert result['parse_status'] == 'success'
    assert result['title'] == '内存工具手册'
    assert '缓存命中率' in result['summary']
    assert '广告导航' not in result['content'] and '伪造的最新事实' not in result['summary']
    assert result['parsed_chars'] >= len(result['summary'])


def test_failed_fetch_has_an_explicit_failure_and_no_summary_from_search_text():
    from web_research.pages import PageParser
    def fetch(*args): raise RuntimeError('HTTP 403')
    result = PageParser(fetch=fetch).parse({'id': 's', 'channel': 'google', 'url': 'https://example.org/',
        'title': '搜索标题', 'snippet': '未经网页解析的搜索摘要', 'content': '未经核对的正文'}, {'query': '内存工具'}, threading.Event())
    assert result['parse_status'] == 'error' and '403' in result['parse_error']
    assert result['summary'] == '' and result['content'] == ''


def test_a_login_or_script_shell_is_not_successful_page_content():
    from web_research.pages import PageParser
    result = PageParser(fetch=lambda *args: {'html': '<title>Sign in</title><main>Please sign in to continue. Enable JavaScript to view this page.</main>', 'text': '', 'url': 'https://example.org/'}).parse(
        {'id': 's', 'channel': 'google', 'url': 'https://example.org/'}, {'query': '内存'}, threading.Event())
    assert result['parse_status'] == 'error' and not result['summary']


@pytest.mark.parametrize('title,body', [
    ('请登录', '请先登录后继续访问。登录账号以查看完整内容。为了保护您的隐私，需要完成身份验证。'),
    ('Just a moment...', 'Verify you are human. ' + 'Checking your browser connection. ' * 60),
])
def test_localized_and_long_access_challenges_are_not_successful_articles(title, body):
    from web_research.pages import PageParser
    parser = PageParser(fetch=lambda *args: {'html': f'<title>{title}</title><main>{body}</main>', 'url': args[0]})
    result = parser.parse({'url': 'https://example.org/', 'channel': 'google'}, {'query': 'memory tools'}, threading.Event())
    assert result['parse_status'] == 'error' and not result['summary']


def test_javascript_configuration_documentation_is_not_mistaken_for_a_script_shell():
    from web_research.pages import PageParser
    parser = PageParser(fetch=lambda *args: {'html': '<title>Browser configuration guide</title><main>Enable JavaScript in browser settings. This guide explains configuration options and how scripts interact with browser permissions.</main>', 'url': args[0]})
    result = parser.parse({'url': 'https://example.org/docs', 'channel': 'google'}, {'query': 'JavaScript configuration'}, threading.Event())
    assert result['parse_status'] == 'success' and result['summary']


def test_generic_site_description_without_page_body_is_not_parsed_evidence():
    from web_research.pages import PageParser
    html = '<title>YouTube</title><meta name="description" content="Enjoy the videos and music you love, upload original content, and share it all with friends, family, and the world on YouTube."><div id="app"></div>'
    result = PageParser(fetch=lambda *args: {'html': html, 'url': args[0]}).parse(
        {'url': 'https://youtube.com/watch?v=example', 'channel': 'youtube'}, {'query': 'memory profiling'}, threading.Event())
    assert result['parse_status'] == 'error' and not result['summary']


def test_login_api_documentation_has_readable_content_despite_its_title():
    from web_research.pages import PageParser
    html = '<title>Login — Example API documentation</title><main>POST /api/login accepts a username and password and returns an access token. This endpoint supports session expiration and authenticated requests.</main>'
    result = PageParser(fetch=lambda *args: {'html': html, 'url': args[0]}).parse(
        {'url': 'https://example.org/docs/login', 'channel': 'google'}, {'query': 'login API'}, threading.Event())
    assert result['parse_status'] == 'success' and 'POST /api/login' in result['summary']


@pytest.mark.parametrize('invalid', [
    {'baseUrl': '  ', 'selectedModel': 'default-model'},
    {'baseUrl': 'https://default.example/v1', 'selectedModel': '  ', 'models': []},
])
def test_invalid_default_target_falls_back_with_the_current_provider_and_model_together(invalid):
    current = {'providerId': 'current', 'baseUrl': 'https://current.example/v1', 'apiKey': 'current-key', 'model': 'current-model'}
    target = server._resolve_default_research_model(current, [{'id': 'invalid', 'isDefault': True, **invalid}])
    assert target['providerId'] == 'current' and target['model'] == 'current-model' and target['apiKey'] == 'current-key'


def test_duplicate_page_urls_are_fetched_once_with_independent_result_ids():
    from web_research.pages import PageParser
    calls = []
    def fetch(url, *args):
        calls.append(url)
        return {'url': url, 'html': '', 'title': 'Doc', 'text': 'Memory performance tools record memory allocation and identify expensive operations in a program.'}
    parser = PageParser(fetch=fetch)
    first = parser.parse({'id': 'zh', 'channel': 'google', 'url': 'https://example.org/docs', 'query_language': 'zh'}, {'query': '内存工具'}, threading.Event())
    second = parser.parse({'id': 'en', 'channel': 'ddgs', 'url': 'https://example.org/docs', 'query_language': 'en'}, {'query': '内存工具'}, threading.Event())
    assert calls == ['https://example.org/docs']
    assert first['id'] == 'zh' and second['id'] == 'en'
    assert first['summary'] == second['summary']


def test_opencli_post_body_is_parsed_as_post_content_without_treating_snippets_as_body():
    from web_research.pages import PageParser
    def unexpected(*args): raise AssertionError('The adapter already returned this post body')
    result = PageParser(fetch=unexpected).parse({'id': 'x', 'channel': 'x', 'url': 'https://x.com/user/status/123',
        'content': 'Memory profiling records program allocations. It can help identify retained objects and locate unexpected growth.'},
        {'query': 'memory profiling'}, threading.Event())
    assert result['parse_status'] == 'success' and result['parse_method'] == 'opencli_content'
    assert 'allocations' in result['summary']


def test_synthesis_waits_for_page_results_and_uses_only_successful_parsed_sources():
    from web_research.service import ResearchPipeline
    parsed = []
    class Sites:
        def search(self, site, *args):
            if site != 'google': return []
            return [{'id': name, 'channel': site, 'url': f'https://example.org/{name}', 'title': name, 'snippet': '仅有搜索摘要'} for name in ('good', 'bad')]
    def parse(source, data, cancel):
        parsed.append(source['title'])
        return {**source, 'parse_status': 'success' if source['title'] == 'good' else 'error',
                'content': '实际网页正文' if source['title'] == 'good' else '',
                'summary': '提取后的正文摘要' if source['title'] == 'good' else '', 'parse_error': 'HTTP 403' if source['title'] == 'bad' else ''}
    def synthesize(data, sources, candidate):
        assert set(parsed) == {'good', 'bad'}
        assert [s['title'] for s in sources] == ['good']
        assert sources[0]['summary'] == '提取后的正文摘要'
        return {'answer': '默认模型整合答案', 'model': 'default-model'}
    pipeline = ResearchPipeline(lambda *args: {}, Sites(), lambda *args: [], lambda *args: [], synthesize, parse_source=parse)
    events = list(pipeline.events({'query': 'memory tools', 'model': 'selected-model'}, threading.Event()))
    assert events[-1]['type'] == 'complete'
    assert any(e['type'] == 'result' and e['result'].get('parse_status') == 'error' for e in events)
    assert any(e['type'] == 'result' and e['result'].get('parse_status') == 'success' for e in events)


def test_all_failed_pages_never_call_the_synthesis_model():
    from web_research.service import ResearchPipeline
    class Sites:
        def search(self, site, *args):
            return [{'id': site, 'channel': site, 'url': f'https://example.org/{site}', 'title': site, 'snippet': '搜索摘要'}]
    def synthesize(*args): raise AssertionError('Unparsed snippets must not reach synthesis')
    events = list(ResearchPipeline(lambda *args: {}, Sites(), lambda *args: [], lambda *args: [], synthesize,
        parse_source=lambda source, data, cancel: {**source, 'parse_status': 'error', 'summary': '', 'content': '', 'parse_error': '正文不可用'}).events(
            {'query': 'memory tools', 'model': 'selected'}, threading.Event()))
    assert events[-1]['type'] == 'error' and not any(e['type'] == 'complete' for e in events)


def test_default_provider_receives_extracted_summaries_instead_of_search_snippets(monkeypatch):
    from web_research.service import ResearchPipeline
    providers = [{'id': 'd', 'isDefault': True, 'baseUrl': 'https://default.example/v1', 'apiKey': 'default-key', 'selectedModel': 'default-model', 'name': 'Default'}]
    monkeypatch.setattr(server, '_load_settings', lambda: {'local_knowledge': {'enabled': False}})
    monkeypatch.setattr(server, '_load_json', lambda path, default: providers if path == server.PROVIDERS_FILE else default)
    def llm(base, key, model, system, prompt, **kwargs):
        assert base == 'https://default.example/v1' and model == 'default-model' and key == 'default-key'
        assert '经解析提取的内容摘要' in prompt
        assert '不应当送入综合的搜索摘要' not in prompt and '未解析候选回答' not in prompt
        return '默认模型综合', 'stop'
    monkeypatch.setattr(server, '_llm_chat_full', llm)
    def events(self, data, cancel):
        result = self.synthesize(data, [{'title': 'Doc', 'url': 'https://example.org/', 'channel': 'google',
            'parse_status': 'success', 'summary': '经解析提取的内容摘要', 'content': '完整正文', 'snippet': '不应当送入综合的搜索摘要'}],
            {'answer': '未解析候选回答'})
        assert result['provider_id'] == 'd' and result['model'] == 'default-model'
        yield {'type': 'complete', **result}
    monkeypatch.setattr(ResearchPipeline, 'events', events)
    with server.app.test_client().post('/api/research/stream', json={'query': 'memory tools',
        'baseUrl': 'https://selected.example/v1', 'apiKey': 'selected-key', 'model': 'selected-model'}) as response:
        assert 'default-model' in response.get_data(as_text=True)


def test_reformatting_uses_persisted_default_and_only_successful_page_summaries(monkeypatch):
    providers = [{'id': 'd', 'isDefault': True, 'baseUrl': 'https://default.example/v1', 'apiKey': 'default-key', 'selectedModel': 'default-model'}]
    monkeypatch.setattr(server, '_load_json', lambda path, default: providers if path == server.PROVIDERS_FILE else default)
    def llm(base, key, model, system, prompt, **kwargs):
        assert base == 'https://default.example/v1' and key == 'default-key' and model == 'default-model'
        assert '正文提取的摘要' in prompt and '失败页搜索摘要' not in prompt and '未摘要完整正文' not in prompt
        return '重新综合', 'stop'
    monkeypatch.setattr(server, '_llm_chat_full', llm)
    response = server.app.test_client().post('/api/research/synthesize', json={'query': 'memory tools', 'instruction': '使用表格',
        'baseUrl': 'https://selected.example/v1', 'model': 'selected-model', 'sources': [
            {'url': 'https://example.org/good', 'title': 'Good', 'parse_status': 'success', 'summary': '正文提取的摘要', 'content': '未摘要完整正文'},
            {'url': 'https://example.org/bad', 'title': 'Bad', 'parse_status': 'error', 'snippet': '失败页搜索摘要'},
        ]})
    assert response.status_code == 200
    assert response.get_json()['model'] == 'default-model' and response.get_json()['provider_id'] == 'd'


def test_summary_budget_cannot_displace_a_relevant_sentence_with_a_large_background_paragraph():
    from web_research.pages import summarize
    relevant = 'Memory profiling records allocations and detects retained objects.'
    text = 'Unrelated background details ' * 90 + '.\n' + relevant
    summary = summarize(text, {'query': 'memory profiling'}, maximum=200)
    assert relevant in summary and len(summary) <= 200


def test_one_long_relevant_sentence_stays_within_summary_character_budget():
    from web_research.pages import summarize
    summary = summarize('Memory profiling ' + 'allocation ' * 100, {'query': 'memory profiling'}, maximum=100)
    assert len(summary) <= 100 and summary.startswith('Memory profiling')


def test_cancel_during_page_parsing_does_not_run_the_default_model():
    from web_research.service import ResearchPipeline
    cancel = threading.Event()
    class Sites:
        def search(self, site, *args):
            return [{'id': site, 'channel': site, 'url': f'https://example.org/{site}', 'title': site}]
    def parse(source, data, event):
        event.set()
        return {**source, 'parse_status': 'success', 'summary': '已解析摘要', 'content': '正文'}
    def synthesize(*args): raise AssertionError('Cancelled parsing must not synthesize')
    events = list(ResearchPipeline(lambda *args: {}, Sites(), lambda *args: [], lambda *args: [], synthesize,
        parse_source=parse).events({'query': 'memory tools', 'model': 'selected'}, cancel))
    assert not any(e['type'] == 'complete' for e in events)
