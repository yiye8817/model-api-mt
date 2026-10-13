import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest


class CapabilityServer:
    def __init__(self):
        self.calls=[]
        parent=self
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                body=json.loads(self.rfile.read(int(self.headers.get('Content-Length','0'))))
                parent.calls.append((self.path, self.headers.get('Authorization'), body))
                model=body.get('model')
                if self.path.endswith('/api/v1/services/embeddings/text-embedding/text-embedding') and model=='text-embedding-v4':
                    texts=body.get('input',{}).get('texts',[])
                    if len(texts)>10:
                        payload={'code':'InvalidParameter','message':'batch size must not exceed 10'};status=400
                    elif 'reject' in texts:
                        payload={'code':'InvalidParameter','message':'invalid text'};status=400
                    else:
                        payload={'output':{'embeddings':[{'text_index':i,'embedding':[float(value),1.0]} for i,value in reversed(list(enumerate(texts))) ]}};status=200
                elif self.path.endswith('/api/v1/services/rerank/text-rerank/text-rerank') and model=='gte-rerank-v2' and isinstance(body.get('input'),dict):
                    payload={'output':{'results':[{'index':0,'relevance_score':0.9},{'index':1,'relevance_score':0.1}]}};status=200
                elif self.path.endswith('/embeddings') and model=='embed-good':
                    payload={'data':[{'index':0,'embedding':[1.0,0.0]}]};status=200
                elif self.path.endswith('/rerank') and model=='rerank-good':
                    payload={'results':[{'index':0,'relevance_score':0.9},{'index':1,'relevance_score':0.1}]};status=200
                else:
                    payload={'error':'unsupported model'};status=400
                data=json.dumps(payload).encode()
                self.send_response(status);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
            def log_message(self,*args): pass
        self.server=ThreadingHTTPServer(('127.0.0.1',0),Handler);self.server.daemon_threads=True
        self.url=f'http://127.0.0.1:{self.server.server_port}'
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True)
    def __enter__(self):
        self.thread.start();return self
    def __exit__(self,*args):
        self.server.shutdown();self.server.server_close();self.thread.join(2)


@pytest.fixture
def capability_server():
    with CapabilityServer() as server:
        yield server


def test_provider_capability_auto_detection_probes_models_and_redacts_key(capability_server):
    import server
    client=server.app.test_client()
    response=client.post('/api/providers/capabilities/test',json={
        'baseUrl':capability_server.url+'/v1','apiKey':'secret-provider-key','apiType':'openai',
        'models':['chat-model','embed-good','embed-bad','rerank-good','rerank-bad'],
    })
    assert response.status_code==200
    payload=response.get_json()
    assert payload['ok'] is True
    assert [item['model'] for item in payload['embedding']['models'] if item['ok']]==['embed-good']
    assert [item['model'] for item in payload['rerank']['models'] if item['ok']]==['rerank-good']
    assert 'secret-provider-key' not in response.get_data(as_text=True)
    assert all(auth=='Bearer secret-provider-key' for _,auth,_ in capability_server.calls)


def test_provider_capability_rejects_anthropic(capability_server):
    import server
    response=server.app.test_client().post('/api/providers/capabilities/test',json={
        'baseUrl':capability_server.url+'/v1','apiKey':'secret','apiType':'anthropic','models':['embed-good'],
    })
    assert response.status_code==400
    assert 'Anthropic' in response.get_json()['error']


def test_server_provider_catalog_reads_saved_providers(tmp_path, monkeypatch):
    import server
    providers_path=tmp_path/'providers.json'; providers_path.write_text(json.dumps([{
        'id':'p-qwen','name':'qwen','baseUrl':'https://dashscope.aliyuncs.com/compatible-mode/v1',
        'apiKey':'secret','models':['qwen3.7-text-embedding'],
    }]))
    conversations=tmp_path/'conversations'; conversations.mkdir()
    monkeypatch.setattr(server,'PROVIDERS_FILE',str(providers_path)); monkeypatch.setattr(server,'CONVERSATIONS_DIR',str(conversations))
    response=server.app.test_client().get('/api/knowledge/providers')
    assert response.status_code==200
    assert response.get_json()['providers'][0]['id']=='p-qwen'
    assert 'secret' not in response.get_data(as_text=True)


def test_dashscope_gte_rerank_uses_service_endpoint_and_nested_protocol(capability_server, monkeypatch):
    from local_knowledge import provider_clients
    from local_knowledge.model_clients import Budget
    import threading
    monkeypatch.setattr(provider_clients, '_is_dashscope_provider', lambda provider: True)
    client=provider_clients.ProviderModelClient({'baseUrl':capability_server.url+'/compatible-mode/v1','apiKey':'key'}, 'rerank', 'gte-rerank-v2')
    scores=client.rerank('query',['doc-a','doc-b'],Budget(10,threading.Event()))
    assert scores==[0.9,0.1]
    path,_,body=capability_server.calls[-1]
    assert path.endswith('/api/v1/services/rerank/text-rerank/text-rerank')
    assert body['input']=={'query':'query','documents':['doc-a','doc-b']}


def test_dashscope_embedding_large_batch_preserves_all_vectors_in_input_order(capability_server):
    from local_knowledge.provider_clients import ProviderModelClient
    from local_knowledge.model_clients import Budget
    client=ProviderModelClient({'baseUrl':capability_server.url+'/compatible-mode/v1','provider_kind':'dashscope'},'embedding','text-embedding-v4')
    vectors=client.embed([str(i) for i in range(23)],Budget(10,threading.Event()))
    assert vectors==[[float(i),1.0] for i in range(23)]
    assert client.dimension==2


def test_dashscope_embedding_rejects_partial_result_when_a_later_batch_fails(capability_server):
    from local_knowledge.provider_clients import ProviderModelClient,ProviderClientError
    from local_knowledge.model_clients import Budget
    client=ProviderModelClient({'baseUrl':capability_server.url+'/compatible-mode/v1','provider_kind':'dashscope'},'embedding','text-embedding-v4')
    with pytest.raises(ProviderClientError,match='HTTP 400'):
        client.embed([str(i) for i in range(10)]+['reject'],Budget(10,threading.Event()))
    assert client.dimension==2


@pytest.mark.parametrize('seconds,maximum',[(20,20),(520,120)])
def test_provider_call_timeout_is_bounded_within_total_index_budget(monkeypatch,seconds,maximum):
    import requests
    from local_knowledge.provider_clients import ProviderModelClient
    from local_knowledge.model_clients import Budget
    timeouts=[]
    def post(url,**kwargs):
        timeouts.append(kwargs['timeout'])
        response=requests.Response();response.status_code=200
        response._content=b'{"data":[{"index":0,"embedding":[1.0,0.0]}]}'
        return response
    monkeypatch.setattr(requests,'post',post)
    client=ProviderModelClient({'baseUrl':'https://provider.example/v1'},'embedding','embed')
    assert client.embed(['text'],Budget(seconds,threading.Event()))==[[1.0,0.0]]
    assert 0<timeouts[0]<=maximum
