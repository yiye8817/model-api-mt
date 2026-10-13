import json
import tempfile
import unittest
from pathlib import Path

from flask import Flask
from knowledge.api import register_knowledge_routes
from knowledge.store import KnowledgeStore


class KnowledgeAPITests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = KnowledgeStore(Path(self.tmp.name) / 'knowledge.sqlite3')
        self.app = Flask(__name__)
        register_knowledge_routes(self.app, lambda: self.store, lambda: [])
        self.client = self.app.test_client()

    def tearDown(self):
        self.tmp.cleanup()

    def test_manual_entry_search_and_annotation_roundtrip(self):
        response = self.client.post('/api/knowledge/entries', json={'question': 'Python安装', 'answer': '官网下载'})
        self.assertEqual(response.status_code, 201)
        entry = response.get_json()
        response = self.client.patch('/api/knowledge/entries/' + entry['id'], json={
            'fact_status': 'correct', 'source_name': '官方', 'source_url': 'https://python.org/', 'tags': ['安装']})
        self.assertEqual(response.status_code, 200)
        response = self.client.post('/api/knowledge/search', json={'query': 'Python', 'tag': '安装'})
        self.assertEqual(response.get_json()['results'][0]['fact_status'], 'correct')
        self.assertEqual(response.get_json()['intent']['intent'], '未知')

    def test_bad_request_shapes_and_limits_return_json_400(self):
        for path, payload in [('/search', []), ('/search', {'query': 3}), ('/search', {'query': 'a', 'limit': '10'}),
                              ('/import', {'content': 'bad', 'format': 'records'}), ('/entries', {'question': '无答案'})]:
            response = self.client.post('/api/knowledge' + path, json=payload)
            self.assertEqual(response.status_code, 400, (path, response.data))
            self.assertIn('error', response.get_json())

    def test_missing_entry_returns_404(self):
        self.assertEqual(self.client.get('/api/knowledge/entries/missing').status_code, 404)
        self.assertEqual(self.client.patch('/api/knowledge/entries/missing', json={'note': 'a'}).status_code, 404)

    def test_empty_evaluation_is_explicit(self):
        report = self.client.post('/api/knowledge/evaluate', json={}).get_json()
        self.assertEqual(report['intent']['total'], 0)
        self.assertIsNone(report['intent']['accuracy'])

    def test_valid_import_and_invalid_late_row(self):
        rows = [{'kind': 'qa', 'question': '如何安装Python', 'answer': '下载安装包'}]
        response = self.client.post('/api/knowledge/import', json={'content': json.dumps(rows), 'format': 'records', 'name': '自有文档'})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()['imported'], 1)
        response = self.client.post('/api/knowledge/import', json={'content': '[{},{}]', 'format': 'records', 'name': '错误文件'})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(self.client.get('/api/knowledge/status').get_json()['entries'], 1)


if __name__ == '__main__':
    unittest.main()
