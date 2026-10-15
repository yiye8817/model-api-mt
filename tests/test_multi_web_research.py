import json
import threading
import time
from contextlib import contextmanager
from unittest.mock import patch

import pytest
import server


def test_stream_endpoint_is_available_without_switching_the_selected_provider(monkeypatch):
    from web_research.service import ResearchPipeline
    monkeypatch.setattr(server, '_load_settings', lambda: {})
    monkeypatch.setattr(ResearchPipeline, 'events', lambda self, data, cancel: iter([{'type': 'start', 'model': data['model']}]))
    response = server.app.test_client().post('/api/research/stream', json={
        'query': 'Linux latest release', 'baseUrl': 'http://localhost:8080/v1',
        'apiKey': '', 'model': 'selected', 'apiType': 'openai'})
    assert response.status_code == 200
    assert response.mimetype == 'text/event-stream'
    assert 'selected' in response.get_data(as_text=True)
    response.close()


def test_ddgs_retry_relaxes_time_filter_and_preserves_real_page_evidence(monkeypatch):
    from web_research.service import ResearchPipeline
    calls = []
    def search(query, limit, timelimit=None, region=None):
        calls.append((query, timelimit, region))
        if timelimit:
            raise RuntimeError('No results found.')
        return [{'title':'Kernel','url':'https://www.kernel.org/','body':'搜索摘要'}]
    monkeypatch.setattr(server, '_ws_duckduckgo', search)
    text = '官方当前发布列表说明了当前稳定版内核的发布版本，并提供可用于核对实际更新内容的完整文档链接。'
    monkeypatch.setattr('web_research.pages.fetch_page', lambda *args: {'text':text})
    def events(self, data, cancel):
        rows=self.ddgs('Linux kernel latest stable release kernel.org',cancel,lambda *args:None)
        parsed=self.parse_source(rows[0],data,cancel)
        assert parsed['parse_status']=='success' and parsed['content']==text
        yield {'type':'complete','sources':rows}
    monkeypatch.setattr(ResearchPipeline,'events',events)
    with server.app.test_client().post('/api/research/stream', json={
        'query':'Linux 内核最新稳定版本','baseUrl':'https://gateway.example/v1','model':'selected','latest':True}) as response:
        response.get_data()
    assert calls[0][1] is not None
    assert len(calls)==2 and calls[1][1] is None
    assert calls[0][2]=='us-en' and calls[1][2]=='us-en'


def test_opencli_retry_corrects_query_and_normalizes_site_results():
    from web_research.opencli import OpenCliSearch, SearchFailure
    calls, events = [], []
    def run(argv, cancel):
        calls.append(argv)
        if len(calls) == 1:
            raise SearchFailure('NOT_FOUND', 'No results')
        return [{'title': '内核发布', 'url': 'https://www.youtube.com/watch?v=123', 'published': '1 day ago'}]
    results = OpenCliSearch(run=run).search('youtube', 'Linux最新版本有哪些？', threading.Event(), lambda kind, data: events.append((kind, data)))
    assert len(calls) == 2
    assert calls[0][:3] == ['opencli', 'youtube', 'search']
    assert calls[0][3] != calls[1][3]
    assert results[0]['channel'] == 'youtube'
    assert results[0]['published_at'] == '1 day ago'
    assert any(kind == 'status' and data['status'] == 'retrying' for kind, data in events)


@pytest.mark.parametrize('code', ['AUTH_REQUIRED', 'BROWSER_CONNECT', 'CAPTCHA', 'RATE_LIMIT'])
def test_opencli_environment_errors_do_not_patch_or_loop(code):
    from web_research.opencli import OpenCliSearch, SearchFailure
    calls = []
    def run(argv, cancel):
        calls.append(argv)
        raise SearchFailure(code, 'Needs user action')
    with pytest.raises(SearchFailure):
        OpenCliSearch(run=run).search('reddit', 'Linux', threading.Event(), lambda *args: None)
    assert len(calls) == 1


def test_opencli_github_fallback_is_explicit_and_uses_a_single_literal_argument():
    from web_research.opencli import OpenCliSearch
    calls, events = [], []
    def run(argv, cancel):
        calls.append(argv)
        return [{'title': 'repo', 'url': 'https://github.com/org/repo', 'snippet': 'release'}]
    OpenCliSearch(run=run).search('github', 'Linux $(touch /tmp/bad); `id`', threading.Event(), lambda kind, data: events.append((kind, data)))
    assert calls[0][:4] == ['opencli', 'google', 'search', 'site:github.com Linux $(touch /tmp/bad); `id`']
    assert any('站内' in data.get('detail', '') for _, data in events)


def test_opencli_empty_or_wrong_site_results_are_retried_only_three_times():
    from web_research.opencli import OpenCliSearch, SearchFailure
    calls = []
    def run(argv, cancel):
        calls.append(argv)
        return [{'title': 'not youtube', 'url': 'https://example.org'}]
    with pytest.raises(SearchFailure):
        OpenCliSearch(run=run).search('youtube', 'Linux', threading.Event(), lambda *args: None)
    assert len(calls) == 3


def test_official_link_parser_follows_documentation_links_only():
    from web_research.sources import official_links
    html = '<a href="/docs/guide">Guide</a><a href="/releases/v2">Release</a><a href="/logout">Logout</a><a href="https://evil.org/docs">External</a><a href="javascript:alert(1)">JS</a>'
    assert official_links('https://project.org/', html) == ['https://project.org/docs/guide', 'https://project.org/releases/v2']


@pytest.mark.parametrize('url',['http://127.1/docs','http://2130706433/docs','http://0x7f000001/docs','http://[::1]/docs'])
def test_source_urls_reject_noncanonical_local_addresses(url):
    from web_research.sources import public_url
    assert public_url(url)==''


def test_cli_machine_error_code_takes_precedence_over_shared_exit_status():
    import sys
    from web_research.opencli import run_command,SearchFailure
    with pytest.raises(SearchFailure) as failure:
        run_command([sys.executable,'-c','import sys;sys.stderr.write("ok: false\\nerror:\\n  code: ADAPTER_LOAD\\n");sys.exit(69)'],threading.Event())
    assert failure.value.code=='ADAPTER_LOAD'


def test_provider_generated_text_is_not_repackaged_as_webpage_evidence(monkeypatch):
    from web_research.providers import ProviderSearch
    class Response:
        status_code=200
        def json(self):
            return {'output':[{'type':'message','content':[{'type':'output_text','text':'模型声称的新功能',
                'annotations':[{'type':'url_citation','url':'https://project.org/docs','title':'Official'}]}]}]}
    monkeypatch.setattr('web_research.providers.requests.post',lambda *args,**kwargs:Response())
    events=[]
    result=ProviderSearch(fetch=lambda *args,**kwargs:{'text':'独立网页原文','title':'Official'})({
        'baseUrl':'https://api.openai.com/v1','model':'chosen','apiKey':'secret','query':'最新功能'},
        threading.Event(),lambda kind,data:events.append((kind,data)),lambda *args:[])
    source=next(data['result'] for kind,data in events if kind=='result' and data['result']['kind']=='source')
    assert source['content']=='独立网页原文'
    assert '模型声称' not in source['snippet']
    assert result['answer']=='模型声称的新功能'


def test_webpage_parser_rejects_a_redirect_into_the_local_network(monkeypatch):
    from web_research.sources import fetch_page
    from web_research.opencli import SearchFailure
    class Response:
        status_code=302
        headers={'Location':'http://127.1/private'}
        def close(self):pass
    calls=[]
    @contextmanager
    def get(url,address,**kwargs):
        calls.append(url)
        assert kwargs['allow_redirects'] is False
        yield Response()
    monkeypatch.setattr('web_research.sources.socket.getaddrinfo',lambda *args,**kwargs:[(2,1,6,'',('8.8.8.8',443))])
    monkeypatch.setattr('web_research.sources._public_get',get)
    with pytest.raises(SearchFailure):fetch_page('https://project.org/docs',threading.Event())
    assert calls==['https://project.org/docs']


def test_webpage_parser_rejects_private_dns_before_fetching(monkeypatch):
    from web_research.sources import fetch_page
    from web_research.opencli import SearchFailure
    monkeypatch.setattr('web_research.sources.socket.getaddrinfo', lambda *args, **kwargs: [(2,1,6,'',('192.168.1.2',443))])
    with patch('web_research.sources._public_get') as get:
        with pytest.raises(SearchFailure):
            fetch_page('https://project.org/docs', threading.Event())
        get.assert_not_called()


def test_webpage_parser_reads_real_text_and_metadata(monkeypatch):
    from web_research.sources import fetch_page
    class Response:
        status_code = 200
        headers = {'Content-Type': 'text/html; charset=utf-8'}
        encoding = 'utf-8'
        def iter_content(self, size):
            yield '<title>项目发布</title><meta property="article:published_time" content="2026-10-14"><script>ignore me</script><article>实际网页内容</article>'.encode()
        def close(self): pass
    monkeypatch.setattr('web_research.sources.socket.getaddrinfo', lambda *args, **kwargs: [(2,1,6,'',('8.8.8.8',443))])
    @contextmanager
    def get(*args, **kwargs): yield Response()
    monkeypatch.setattr('web_research.sources._public_get', get)
    page = fetch_page('https://project.org/docs', threading.Event())
    assert page['text'] == '实际网页内容'
    assert page['title'] == '项目发布'
    assert page['published_at'] == '2026-10-14'


def test_page_connection_uses_verified_ip_and_retains_https_origin(monkeypatch):
    from web_research.sources import _public_get
    from unittest.mock import MagicMock
    session = MagicMock()
    session.__enter__.return_value = session
    monkeypatch.setattr('web_research.sources.requests.Session', lambda: session)
    with _public_get('https://project.org:8443/docs?q=new', '93.184.216.34', allow_redirects=False):
        pass
    assert session.get.call_args.args[0] == 'https://93.184.216.34:8443/docs?q=new'
    assert session.get.call_args.kwargs['headers']['Host'] == 'project.org:8443'
    assert session.get.call_args.kwargs['allow_redirects'] is False
    assert session.trust_env is False
    adapter = session.mount.call_args.args[1]
    assert adapter.poolmanager.connection_pool_kw['server_hostname'] == 'project.org'
    assert adapter.poolmanager.connection_pool_kw['assert_hostname'] == 'project.org'


@pytest.mark.parametrize('base,api_type,url,auth_header', [
    ('https://api.anthropic.com','anthropic','https://api.anthropic.com/v1/messages','x-api-key'),
    ('https://api.xiaomimimo.com','anthropic','https://api.xiaomimimo.com/v1/messages','api-key'),
    ('https://api.quickrouter.ai','openai','https://api.quickrouter.ai/v1/chat/completions','Authorization'),
    ('https://api.xiaomimimo.com/v1','openai','https://api.xiaomimimo.com/v1/chat/completions','api-key'),
])
def test_research_route_reuses_existing_provider_transport_contract(monkeypatch, base, api_type, url, auth_header):
    from web_research.service import ResearchPipeline
    def events(self, data, cancel):
        self.provider.count = lambda *args: None
        with patch('web_research.providers.requests.post') as post:
            post.return_value.status_code = 200
            post.return_value.json.return_value = {}
            self.provider._post(data, 'messages' if api_type == 'anthropic' else 'chat/completions', {}, cancel, anthropic=api_type == 'anthropic')
            assert post.call_args.args[0] == url
            headers = post.call_args.kwargs['headers']
            assert headers[auth_header] == ('Bearer secret' if auth_header == 'Authorization' else 'secret')
        yield {'type':'start'}
    monkeypatch.setattr(ResearchPipeline, 'events', events)
    with server.app.test_client().post('/api/research/stream', json={
        'query':'最新发布','baseUrl':base,'apiType':api_type,'model':'selected','apiKey':'secret'}) as response:
        assert response.status_code == 200
        response.get_data()


def test_pipeline_exposes_each_source_before_final_synthesis():
    from web_research.service import ResearchPipeline
    gate = threading.Event()
    def provider(data, cancel, emit, search):
        emit('result', {'channel': 'provider', 'result': {'id': 'p-answer', 'channel': 'provider', 'kind': 'answer', 'content': 'Provider原始结果', 'url': ''}})
        return {'answer': 'Provider原始结果'}
    class Sites:
        def search(self, site, query, cancel, emit):
            if site == 'official':
                return [{'id': 'official', 'channel': site, 'title': 'Official', 'url': 'https://project.org/docs', 'snippet': '官方说明'}]
            if site == 'reddit':
                gate.wait(1)
            if site == 'x':
                raise RuntimeError('X不可用')
            return [{'id': site, 'channel': site, 'title': site, 'url': f'https://{site}.com/item', 'snippet': '搜索结果'}]
    def ddgs(query, cancel, emit):
        return [{'id': 'ddgs', 'channel': 'ddgs', 'title': 'DDGS结果', 'url': 'https://project.org/news', 'content': '网页原文'}]
    received = []
    def synthesize(data, sources, candidate):
        received.extend(sources)
        assert data['model'] == 'current-model'
        return {'answer': '最终综合', 'model': data['model'], 'finish_reason': 'stop'}
    pipeline = ResearchPipeline(provider=provider, sites=Sites(), ddgs=ddgs,
        parse_official=lambda source, cancel: [source], synthesize=synthesize)
    iterator = pipeline.events({'query': 'Linux', 'model': 'current-model'}, threading.Event())
    early = []
    for event in iterator:
        early.append(event)
        if event['type'] == 'result':
            gate.set()
        if event['type'] == 'complete':
            break
    assert any(e['type'] == 'result' and e['channel'] == 'provider' for e in early)
    assert any(e['type'] == 'status' and e['channel'] == 'x' and e['status'] == 'error' for e in early)
    assert early[-1]['answer'] == '最终综合'
    assert any(s['channel'] == 'official' for s in received)
    assert any(s['channel'] == 'ddgs' for s in received)
    assert next(i for i,e in enumerate(early) if e['type'] == 'result') < next(i for i,e in enumerate(early) if e['type'] == 'complete')


def test_pipeline_cancel_never_runs_synthesis_or_completes():
    from web_research.service import ResearchPipeline
    cancel = threading.Event()
    class Sites:
        def search(self, site, query, event, emit):
            return []
    def provider(data, event, emit, search):
        emit('result', {'channel': 'provider', 'result': {'id': 'p', 'channel': 'provider', 'kind': 'answer', 'content': 'draft', 'url': ''}})
        event.wait(1)
    def synthesis(*args):
        raise AssertionError('Cancelled request must not synthesize')
    pipeline = ResearchPipeline(provider=provider, sites=Sites(), ddgs=lambda *args: [], parse_official=lambda *args: [], synthesize=synthesis)
    iterator = pipeline.events({'query': 'Linux', 'model': 'selected'}, cancel)
    collected = []
    for event in iterator:
        collected.append(event)
        if event['type'] == 'result':
            cancel.set()
    assert not any(e['type'] == 'complete' for e in collected)


def test_synthesis_failure_is_an_explicit_stream_error():
    from web_research.service import ResearchPipeline
    class Sites:
        def search(self, *args):
            return []
    def synthesize(*args):
        raise RuntimeError('模型整理失败')
    pipeline=ResearchPipeline(provider=lambda *args: {}, sites=Sites(),
        ddgs=lambda *args: [{'id':'d','channel':'ddgs','url':'https://example.org/docs','content':'正文','title':'Doc'}],
        parse_official=lambda *args: [],synthesize=synthesize)
    events=list(pipeline.events({'query':'Linux','model':'selected'},threading.Event()))
    assert any(e['type']=='error' and '模型整理失败' in e['detail'] for e in events)


def test_provider_web_search_tool_is_executed_before_answering(monkeypatch):
    from web_research.providers import ProviderSearch
    bodies = []
    class Response:
        status_code = 200
        def raise_for_status(self):
            pass
        def json(self):
            if len(bodies) == 1:
                return {'choices': [{'message': {'role': 'assistant', 'content': '', 'tool_calls': [{'id': 'call1', 'type': 'function', 'function': {'name': 'web_search', 'arguments': '{"query":"Linux kernel release"}'}}]}, 'finish_reason': 'tool_calls'}]}
            return {'choices': [{'message': {'content': '带来源的联网回答'}, 'finish_reason': 'stop'}]}
    def post(url, **kwargs):
        bodies.append(kwargs['json'])
        return Response()
    monkeypatch.setattr('web_research.providers.requests.post', post)
    searches = []
    def search(query, cancel, emit):
        searches.append(query)
        return [{'url': 'https://project.org/release', 'content': '官方新版本', 'title': 'Release'}]
    result = ProviderSearch()({'baseUrl': 'https://gateway.example/v1', 'apiKey': 'secret', 'model': 'selected', 'query': '最新版本'}, threading.Event(), lambda *args: None, search)
    assert bodies[0]['model'] == 'selected'
    assert bodies[0]['tools'][0]['function']['name'] == 'web_search'
    assert searches == ['Linux kernel release']
    assert any(m['role'] == 'tool' and '官方新版本' in m['content'] for m in bodies[1]['messages'])
    assert result['answer'] == '带来源的联网回答'
    assert result['mode'] == 'function_tool'


def test_gateway_ignoring_tool_choice_answers_after_tools_are_removed(monkeypatch):
    from web_research.providers import ProviderSearch
    bodies=[]
    class Response:
        status_code=200
        def json(self):
            if bodies[-1].get('tools'):
                return {'choices':[{'message':{'role':'assistant','content':'','tool_calls':[
                    {'id':'call1','type':'function','function':{'name':'web_search','arguments':'{"query":"Linux kernel release"}'}}]}}]}
            return {'choices':[{'message':{'content':'已根据网页资料回答'}}]}
    def post(url,**kwargs):
        bodies.append(kwargs['json'])
        return Response()
    monkeypatch.setattr('web_research.providers.requests.post',post)
    result=ProviderSearch()({'baseUrl':'https://gateway.example/v1','model':'selected','query':'Linux'},
        threading.Event(),lambda *args:None,lambda *args:[{'url':'https://kernel.org/','title':'Kernel','content':'独立网页资料'}])
    assert result['answer']=='已根据网页资料回答'
    assert len(bodies)==2


def test_provider_ignoring_search_tool_still_displays_an_unverified_candidate(monkeypatch):
    from web_research.providers import ProviderSearch
    class Response:
        status_code=200
        def json(self):return {'choices':[{'message':{'content':'Provider原始回答'}}]}
    monkeypatch.setattr('web_research.providers.requests.post',lambda *args,**kwargs:Response())
    events=[]
    result=ProviderSearch()({'baseUrl':'https://gateway.example/v1','model':'selected','query':'Linux'},
        threading.Event(),lambda kind,data:events.append((kind,data)),lambda *args:[])
    candidate=next(data['result'] for kind,data in events if kind=='result')
    assert candidate['kind']=='answer' and candidate['content']=='Provider原始回答'
    assert candidate['grounded'] is False and candidate['url']==''
    assert result['sources']==[]
    assert not any(kind=='result' and data['result']['kind']=='source' for kind,data in events)
