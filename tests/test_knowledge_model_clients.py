import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

from knowledge.model_clients import ModelClientError, embed_texts, provider_capabilities, rerank_texts


class StubHandler(BaseHTTPRequestHandler):
    requests = []
    response = {}
    status = 200

    def do_POST(self):
        length = int(self.headers.get('Content-Length', '0'))
        body = json.loads(self.rfile.read(length) or b'{}')
        self.__class__.requests.append((self.path, dict(self.headers), body))
        raw = json.dumps(self.__class__.response).encode()
        self.send_response(self.__class__.status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def log_message(self, *_args):
        return


class KnowledgeModelClientTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), StubHandler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base_url = f'http://127.0.0.1:{cls.server.server_port}/v1'

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.thread.join(timeout=2)

    def setUp(self):
        StubHandler.requests = []
        StubHandler.response = {}
        StubHandler.status = 200
        self.provider = {
            'id': 'p1', 'name': 'OpenAI兼容', 'baseUrl': self.base_url,
            'apiKey': 'secret-key', 'apiType': 'openai',
        }

    def test_embedding_orders_indexed_vectors_and_sends_bearer_header(self):
        StubHandler.response = {'data': [
            {'index': 1, 'embedding': [0.0, 1.0]},
            {'index': 0, 'embedding': [1.0, 0.0]},
        ]}
        vectors = embed_texts(self.provider, 'embed-model', ['a', 'b'])
        self.assertEqual(vectors, [[1.0, 0.0], [0.0, 1.0]])
        path, headers, body = StubHandler.requests[0]
        self.assertEqual(path, '/v1/embeddings')
        self.assertEqual(headers['Authorization'], 'Bearer secret-key')
        self.assertEqual(body, {'model': 'embed-model', 'input': ['a', 'b']})

    def test_embedding_rejects_mixed_dimensions(self):
        StubHandler.response = {'data': [
            {'index': 0, 'embedding': [1.0, 0.0]},
            {'index': 1, 'embedding': [0.0]},
        ]}
        with self.assertRaisesRegex(ModelClientError, '维度'):
            embed_texts(self.provider, 'embed-model', ['a', 'b'])

    def test_rerank_returns_scores_aligned_to_input_documents(self):
        StubHandler.response = {'results': [
            {'index': 1, 'relevance_score': 0.9},
            {'index': 0, 'score': 0.2},
        ]}
        scores = rerank_texts(self.provider, 'rerank-model', 'query', ['first', 'second'])
        self.assertEqual(scores, [0.2, 0.9])
        path, headers, body = StubHandler.requests[0]
        self.assertEqual(path, '/v1/rerank')
        self.assertEqual(headers['Authorization'], 'Bearer secret-key')
        self.assertEqual(body, {'model': 'rerank-model', 'query': 'query', 'documents': ['first', 'second']})

    def test_rejects_anthropic_for_embedding_and_rerank(self):
        provider = {**self.provider, 'apiType': 'anthropic'}
        with self.assertRaisesRegex(ModelClientError, 'Anthropic'):
            embed_texts(provider, 'model', ['text'])
        with self.assertRaisesRegex(ModelClientError, 'Anthropic'):
            rerank_texts(provider, 'model', 'query', ['text'])

    def test_rejects_malformed_response_and_http_error(self):
        StubHandler.response = {'data': [{'index': 0, 'embedding': 'bad'}]}
        with self.assertRaisesRegex(ModelClientError, 'embedding'):
            embed_texts(self.provider, 'model', ['text'])
        StubHandler.status = 500
        with self.assertRaisesRegex(ModelClientError, 'HTTP 500'):
            rerank_texts(self.provider, 'model', 'query', ['text'])

    def test_capabilities_use_explicit_metadata_then_model_hints(self):
        explicit = provider_capabilities([{**self.provider,
            'embeddingModels': ['e1'], 'rerankModels': ['r1'], 'models': ['chat']}])[0]
        self.assertEqual(explicit['embedding_models'], ['e1'])
        self.assertEqual(explicit['rerank_models'], ['r1'])
        hinted = provider_capabilities([{**self.provider, 'models': ['chat', 'text-embedding-3-small', 'bge-reranker-v2']}])[0]
        self.assertIn('text-embedding-3-small', hinted['embedding_models'])
        self.assertIn('bge-reranker-v2', hinted['rerank_models'])
        unavailable = provider_capabilities([{**self.provider, 'models': ['chat-only']}])[0]
        self.assertEqual(unavailable['embedding_models'], [])
        self.assertIn('无法推断', unavailable['reason'])


if __name__ == '__main__':
    unittest.main()
