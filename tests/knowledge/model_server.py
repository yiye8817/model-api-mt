import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class ModelServer:
    def __init__(self, responses=None):
        self.responses = responses or {}
        self.calls = []
        self.delay = 0
        parent = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                payload = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))))
                parent.calls.append((self.path, payload))
                time.sleep(parent.delay)
                response = parent.responses.get(self.path)
                if callable(response):
                    response = response(payload)
                status, body = response if isinstance(response, tuple) else (200, response or {})
                data = json.dumps(body).encode()
                self.send_response(status)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                try:
                    self.wfile.write(data)
                except (BrokenPipeError, ConnectionResetError):
                    pass

            def log_message(self, *_args):
                pass
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.server.daemon_threads = True
        self.url = f'http://127.0.0.1:{self.server.server_port}'

    def __enter__(self):
        from local_knowledge.config import default_config
        self.config = default_config()
        for key in ('embedding_endpoint', 'rerank_endpoint', 'qa_endpoint'):
            self.config[key].update(url=self.url, model='test', model_revision='weights-1')
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        return self

    def __exit__(self, *_args):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(2)
