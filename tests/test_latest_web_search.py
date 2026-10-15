import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

import pytest
import server
from knowledge.reuse import requires_fresh_context


@pytest.mark.parametrize('question', ['近期有哪些内存性能工具', '最近Linux发布了什么版本',
    '现任英国首相是谁', '本周的科技新闻', 'What is the newest kernel release?',
    'What changed recently in Linux?', '美元兑人民币汇率是多少', 'Who is the prime minister now?',
    '这周有哪些科技新闻', '请翻译今天发布的 Linux 内核公告', '翻译并介绍最新版本的新功能'])
def test_current_information_cannot_replay_a_saved_answer(question):
    assert requires_fresh_context(question, []) is True


@pytest.mark.parametrize('question', ['什么是TLB', '内存性能工具有哪些', '多级页表是什么',
    '解释实时操作系统的原理', '解释汇率是什么', '解释最近最少使用算法', '当前函数的作用是什么',
    '编写脚本读取当前目录', '翻译这句话：“今天发布了最新版本”'])
def test_stable_explanations_keep_local_retrieval(question):
    assert requires_fresh_context(question, []) is False


def test_latest_route_uses_web_role_even_when_no_intent_model_is_bound():
    settings = {'model_roles': {'web_search': {'providerId': 'p', 'model': 'selected-web'}}}
    providers = [{'id': 'p', 'name': 'Selected', 'baseUrl': 'http://localhost:8080', 'apiKey': ''}]
    with patch.object(server, '_load_settings', return_value=settings), \
         patch.object(server, '_load_json', return_value=providers):
        response = server.app.test_client().post('/api/auto-route', json={
            'message': '最近Linux有什么新版本', 'recent_messages': []})
    assert response.status_code == 200
    body = response.get_json()
    assert body['intent'] == '讯息'
    assert body['role'] == 'web_search'
    assert body['target']['model'] == 'selected-web'
    assert body['requires_web_search'] is True


def test_model_can_recognize_latest_information_without_fixed_time_words(monkeypatch):
    settings = {'model_roles': {'intent': {'providerId': 'p', 'model': 'intent'},
                               'web_search': {'providerId': 'p', 'model': 'chosen-web'}}}
    providers = [{'id': 'p', 'baseUrl': 'http://localhost:8080'}]
    monkeypatch.setattr(server, '_load_settings', lambda: settings)
    monkeypatch.setattr(server, '_load_json', lambda *args: providers)
    monkeypatch.setattr(server, '_llm_chat', lambda *args, **kwargs: json.dumps({
        'intent': '问答', 'requires_web_search': True, 'reason': '需要核对发布信息', 'same_topic': True}))
    response = server.app.test_client().post('/api/auto-route', json={'message': 'Linux内核发布动态', 'recent_messages': []})
    body = response.get_json()
    assert body['requires_web_search'] is True
    assert body['role'] == 'web_search'
    assert body['target']['model'] == 'chosen-web'


def test_latest_search_forces_ddgs_and_fetches_full_pages(monkeypatch):
    calls = []
    class Search:
        def text(self, query, **kwargs):
            calls.append((query, kwargs))
            return [{'title': '新版本', 'href': 'https://example.org/release', 'body': '搜索摘要', 'date': '2026-10-14'}]
    monkeypatch.setattr(server, 'DDGS', Search)
    monkeypatch.setattr(server, '_DDGS_AVAILABLE', True)
    monkeypatch.setattr(server, '_load_settings', lambda: {'web_search': {'provider': 'tavily', 'fetch_full_content': False}})
    monkeypatch.setattr(server, '_fetch_page_text', lambda *args: {'title': '版本公告', 'text': '网页正文：新增内存分析功能。'})
    response = server.app.test_client().post('/api/web-search', json={
        'query': '今天Linux的最新版本', 'provider': 'tavily', 'fetch_full_content': False})
    assert response.status_code == 200
    body = response.get_json()
    assert body['provider'] == 'duckduckgo'
    assert calls[0][1]['timelimit'] == 'd'
    assert body['searched_at']
    assert body['results'][0]['content'] == '网页正文：新增内存分析功能。'
    assert body['results'][0]['published_at'] == '2026-10-14'


def test_latest_flag_survives_planner_query_without_time_words(monkeypatch):
    calls = []
    class Search:
        def text(self, query, **kwargs):
            calls.append(kwargs)
            return [{'title': '公告', 'href': 'https://example.org', 'body': '正文'}]
    monkeypatch.setattr(server, 'DDGS', Search)
    monkeypatch.setattr(server, '_DDGS_AVAILABLE', True)
    monkeypatch.setattr(server, '_load_settings', lambda: {})
    monkeypatch.setattr(server, '_fetch_page_text', lambda *args: {'text': '原文'})
    response = server.app.test_client().post('/api/web-search', json={'query': 'Linux kernel release', 'latest': True, 'timelimit': 'w'})
    assert response.status_code == 200
    assert calls[0]['timelimit'] == 'w'


@pytest.fixture
def model_server():
    calls = []
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            calls.append(json.loads(self.rfile.read(int(self.headers['Content-Length']))))
            payload = json.dumps({'choices': [{'message': {'content': '新版本增加了内存分析功能。[1]'}, 'finish_reason': 'stop'}]}).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(payload)
        def log_message(self, *args):
            pass
    httpd = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    yield f'http://127.0.0.1:{httpd.server_port}/v1', calls
    httpd.shutdown()
    httpd.server_close()
    thread.join(2)


def test_selected_model_receives_page_body_dates_and_context(model_server, monkeypatch):
    url, calls = model_server
    monkeypatch.setattr(server, '_load_settings', lambda: {})
    monkeypatch.setattr(server, '_load_json', lambda *args: [])
    monkeypatch.setattr(server, '_knowledge_count_online', lambda *args: None)
    response = server.app.test_client().post('/api/research/synthesize', json={
        'query': '最新版本有什么改进', 'latest': True,
        'baseUrl': url, 'model': 'user-selected', 'apiType': 'openai',
        'context': [{'role': 'user', 'content': '我要了解Linux内核'}], 'system_constraints': '使用中文',
        'sources': [{'title': '公告', 'url': 'https://example.org/release', 'content': '新版本增加内存分析功能。',
                     'snippet': '摘要不含新增功能', 'published_at': '2026-10-14'}]})
    assert response.status_code == 200
    assert calls[0]['model'] == 'user-selected'
    prompt = calls[0]['messages'][-1]['content']
    assert '新版本增加内存分析功能。' in prompt
    assert '2026-10-14' in prompt
    assert '我要了解Linux内核' in prompt
    assert '使用中文' in prompt
    assert response.get_json()['model'] == 'user-selected'
    assert response.get_json()['finish_reason'] == 'stop'


def test_no_sources_does_not_generate_a_claimed_latest_answer(monkeypatch):
    monkeypatch.setattr(server, '_load_settings', lambda: {})
    monkeypatch.setattr(server, '_load_json', lambda *args: [])
    with patch.object(server, '_llm_chat', side_effect=AssertionError('must not infer missing latest facts')):
        response = server.app.test_client().post('/api/research/synthesize', json={
            'query': '今天最新的新闻', 'baseUrl': 'http://localhost:8080', 'model': 'chosen', 'sources': []})
    assert response.status_code == 422
    assert '最新' in response.get_json()['error']
