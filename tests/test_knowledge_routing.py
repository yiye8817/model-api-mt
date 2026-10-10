import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import server
from knowledge.store import KnowledgeStore


class LocalRoutingTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = KnowledgeStore(Path(self.tmp.name) / 'knowledge.sqlite3')
        self.client = server.app.test_client()

    def tearDown(self):
        self.tmp.cleanup()

    def call(self, message, settings=None, providers=None):
        with patch.object(server, '_get_knowledge_store', return_value=self.store), \
             patch.object(server, '_load_settings', return_value=settings or {}), \
             patch.object(server, '_load_json', return_value=providers or []):
            return self.client.post('/api/auto-route', json={'message': message, 'recent_messages': [{'role': 'user', 'content': '旧话题'}]})

    def test_no_model_returns_unknown_without_losing_current_conversation(self):
        response = self.call('没有任何样例匹配的问题')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()['intent'], '未知')
        self.assertTrue(response.get_json()['same_topic'])

    def test_confident_local_sample_routes_without_model_call(self):
        self.store.add({'kind': 'intent', 'question': '编写Python代码', 'intent': '代码编写'})
        with patch.object(server, '_llm_chat', side_effect=AssertionError('must not call model')):
            response = self.call('编写Python代码')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()['role'], 'code_simple')

    def test_model_failure_falls_back_to_local_unknown(self):
        settings = {'model_roles': {'intent': {'providerId': 'p', 'model': 'intent-model'}}}
        providers = [{'id': 'p', 'baseUrl': 'http://localhost:8080', 'apiKey': ''}]
        with patch.object(server, '_llm_chat', side_effect=RuntimeError('offline')):
            response = self.call('未覆盖的输入', settings, providers)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()['intent'], '未知')

    def test_configured_model_is_used_for_uncovered_input(self):
        settings = {'model_roles': {'intent': {'providerId': 'p', 'model': 'intent-model'}}}
        providers = [{'id': 'p', 'baseUrl': 'http://localhost:8080', 'apiKey': ''}]
        with patch.object(server, '_llm_chat', return_value='{"intent":"文字润色","same_topic":true,"keywords":[],"complexity":null,"reason":"改写"}') as model:
            response = self.call('请帮我润色这一段文字', settings, providers)
        self.assertEqual(response.get_json()['intent'], '文字润色')
        model.assert_called_once()

    def test_long_message_reaches_configured_model_without_local_500(self):
        settings = {'model_roles': {'intent': {'providerId': 'p', 'model': 'intent-model'}}}
        providers = [{'id': 'p', 'baseUrl': 'http://localhost:8080', 'apiKey': ''}]
        with patch.object(server, '_llm_chat', return_value='{"intent":"文字润色","same_topic":true}') as model:
            response = self.call('请润色' + '正文' * 2000, settings, providers)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()['intent'], '文字润色')
        model.assert_called_once()

    def test_missing_remote_key_uses_local_fallback(self):
        settings = {'model_roles': {'intent': {'providerId': 'p', 'model': 'intent-model'}}}
        providers = [{'id': 'p', 'baseUrl': 'https://example.org/v1', 'apiKey': ''}]
        response = self.call('测试未覆盖输入', settings, providers)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()['intent'], '未知')
