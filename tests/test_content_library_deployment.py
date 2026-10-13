import tempfile
import unittest
from pathlib import Path
from flask import Flask
from knowledge.api import register_knowledge_routes
from knowledge.store import KnowledgeStore


class ContentLibraryDeploymentTests(unittest.TestCase):
    def test_library_and_existing_semantic_routes_coexist(self):
        with tempfile.TemporaryDirectory() as directory:
            app = Flask(__name__)
            app.add_url_rule('/api/knowledge/status', 'semantic_status', lambda: {'semantic': True})
            store = KnowledgeStore(Path(directory) / 'library.sqlite3')
            register_knowledge_routes(app, lambda: store, lambda: [], prefix='/api/content-library')
            client = app.test_client()
            self.assertEqual(client.get('/api/knowledge/status').get_json(), {'semantic': True})
            self.assertEqual(client.get('/api/content-library/status').get_json()['entries'], 0)
            created = client.post('/api/content-library/entries', json={'question': 'Python安装', 'answer': '官网下载'}).get_json()
            saved = client.patch('/api/content-library/entries/' + created['id'], json={'fact_status': 'correct', 'tags': ['安装']})
            self.assertEqual(saved.status_code, 200)
            result = client.post('/api/content-library/search', json={'query': 'Python', 'tag': '安装'}).get_json()
            self.assertEqual(result['results'][0]['fact_status'], 'correct')
