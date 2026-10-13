"""Local-only transport with killable calls and one deadline for a query."""
import http.client
import ipaddress
import json
import math
import multiprocessing
import socket
import ssl
import threading
import time
from dataclasses import replace
from urllib.parse import urlsplit

from .config import validate_config, model_fingerprint, qa_configured, stable_hash


class ModelUnavailable(RuntimeError):
    pass


class LocalTimeout(RuntimeError):
    pass


class Cancelled(RuntimeError):
    pass


class Budget:
    def __init__(self, seconds: float, cancel_event: threading.Event):
        self.deadline = time.monotonic() + seconds
        self.cancel_event = cancel_event

    def check(self):
        if self.cancel_event.is_set():
            raise Cancelled('Local request cancelled')
        if time.monotonic() >= self.deadline:
            raise LocalTimeout('Local request exceeded its total budget')

    def remaining(self):
        self.check()
        return self.deadline - time.monotonic()


def resolve_endpoint(endpoint):
    p = urlsplit(endpoint.get('url', ''))
    if p.scheme not in ('http', 'https') or not p.hostname or p.username or p.password or p.query or p.fragment:
        raise ModelUnavailable('A local HTTP(S) endpoint is required')
    try:
        addresses = [ipaddress.ip_address(p.hostname)]
    except ValueError:
        if p.hostname != 'localhost' and not endpoint.get('allow_lan'):
            raise ModelUnavailable('Loopback address required')
        try:
            addresses = [ipaddress.ip_address(a[4][0]) for a in socket.getaddrinfo(p.hostname, p.port or 80, type=socket.SOCK_STREAM)]
        except OSError as exc:
            raise ModelUnavailable('Local endpoint cannot be resolved') from exc
    if not addresses:
        raise ModelUnavailable('No local address available')
    for address in addresses:
        lan = address.is_private and not address.is_unspecified and not address.is_multicast and not address.is_link_local
        if not address.is_loopback and not (endpoint.get('allow_lan') and lan):
            raise ModelUnavailable('Public or special address cannot serve a local role')
    return p, str(addresses[0])


def _transport_worker(pipe, endpoint, path, payload, timeout):
    conn = None
    try:
        p, peer = resolve_endpoint(endpoint)
        port = p.port or (443 if p.scheme == 'https' else 80)
        conn = http.client.HTTPConnection(peer, port, timeout=max(.001, timeout))
        if p.scheme == 'https':
            conn.sock = ssl.create_default_context().wrap_socket(socket.create_connection((peer,port), timeout), server_hostname=p.hostname)
        prefix = p.path.rstrip('/')
        if prefix.endswith('/v1') and path.startswith('/v1/'):
            prefix = prefix[:-3]
        if prefix.endswith(path):
            full_path = prefix
        else:
            full_path = prefix + path
        body = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode()
        conn.request('POST', full_path, body=body, headers={'Content-Type':'application/json', 'Host':p.netloc, 'Connection':'close'})
        response = conn.getresponse()
        if response.status != 200:
            raise ModelUnavailable(f'Local endpoint returned HTTP {response.status}')
        data = response.read(8 * 1024 * 1024 + 1)
        if len(data) > 8 * 1024 * 1024:
            raise ModelUnavailable('Local response exceeds 8 MiB')
        pipe.send((True, json.loads(data.decode('utf-8'), parse_constant=lambda _: (_ for _ in ()).throw(ValueError('nonfinite JSON')))))
    except Exception as exc:
        pipe.send((False, str(exc)[:300]))
    finally:
        if conn:
            conn.close()
        pipe.close()


def validate_json(value, schema):
    kind = schema.get('type')
    types = {'object':dict, 'array':list, 'string':str, 'boolean':bool, 'integer':int, 'number':(int,float)}
    if kind in types and (not isinstance(value, types[kind]) or kind in ('integer','number') and isinstance(value,bool)):
        raise ModelUnavailable('Local JSON has an invalid field type')
    if isinstance(value, float) and not math.isfinite(value):
        raise ModelUnavailable('Nonfinite model output')
    if 'enum' in schema and value not in schema['enum']:
        raise ModelUnavailable('Local JSON has an invalid enum value')
    if isinstance(value, dict):
        if any(k not in value for k in schema.get('required', [])):
            raise ModelUnavailable('Local JSON is missing required fields')
        properties = schema.get('properties', {})
        if schema.get('additionalProperties') is False and set(value) - set(properties):
            raise ModelUnavailable('Unexpected JSON fields')
        for key,item in value.items():
            validate_json(item, properties.get(key, {}))
    elif isinstance(value, list):
        for item in value:
            validate_json(item, schema.get('items', {}))


class ModelClients:
    def __init__(self, config, providers=None):
        self.config = validate_config(config)
        self.dimension = None
        self.provider_clients = {}
        provider_rows = providers() if callable(providers) else (providers or [])
        if not isinstance(provider_rows, list):
            provider_rows = []
        from .provider_clients import ProviderModelClient
        for role in ('embedding', 'rerank'):
            endpoint = self.config[role + '_endpoint']
            if endpoint.get('source', 'custom') != 'provider':
                continue
            provider = next((item for item in provider_rows if isinstance(item, dict)
                             and item.get('id') == endpoint.get('provider_id')), None)
            if provider is None:
                raise ModelUnavailable(f'{role} Provider 不存在')
            self.provider_clients[role] = ProviderModelClient(
                provider, role, endpoint['model'], endpoint.get('path', ''))

    @property
    def fingerprint(self):
        base = model_fingerprint(self.config, self.dimension)
        if not self.provider_clients:
            return base
        providers = {role: {'id': client.provider.get('id'),
                            'baseUrl': client.provider.get('baseUrl') or client.provider.get('base_url'),
                            'apiType': client.provider.get('apiType') or client.provider.get('api_type'),
                            'model': client.model, 'path': client.path}
                    for role, client in self.provider_clients.items()}
        return stable_hash({'base': base, 'providers': providers})

    @property
    def vector_fingerprint(self):
        """Fingerprint used for persistent vectors, excluding Provider keys."""
        endpoint = self.config['embedding_endpoint']
        provider = self.provider_clients.get('embedding')
        details = None if provider is None else {
            'id': provider.provider.get('id'),
            'baseUrl': provider.provider.get('baseUrl') or provider.provider.get('base_url'),
            'apiType': provider.provider.get('apiType') or provider.provider.get('api_type'),
            'model': provider.model, 'path': provider.path,
        }
        return stable_hash({'endpoint': endpoint, 'provider': details})

    def _call(self, role, path, payload, budget):
        budget.check()
        endpoint = self.config[role + '_endpoint']
        if not endpoint['url'] or not endpoint['model']:
            raise ModelUnavailable(f'{role} local model is not configured')
        context = multiprocessing.get_context('spawn')
        receiver, sender = context.Pipe(duplex=False)
        worker = context.Process(target=_transport_worker, args=(sender,endpoint,path,payload,budget.remaining()), daemon=True)
        worker.start()
        sender.close()
        try:
            while not receiver.poll(min(.05, budget.remaining())):
                budget.check()
                if not worker.is_alive():
                    raise ModelUnavailable('Local transport exited without a response')
            try:
                ok, data = receiver.recv()
            except EOFError as exc:
                raise ModelUnavailable('Local transport closed without a response') from exc
            budget.check()
            if not ok:
                raise ModelUnavailable(data)
            if not isinstance(data, dict):
                raise ModelUnavailable('Local endpoint response must be an object')
            return data
        finally:
            receiver.close()
            worker.join(.05)
            if worker.is_alive():
                worker.terminate()
                worker.join(.5)
            if worker.is_alive():
                worker.kill()
                worker.join(.5)
            worker.close()

    def embed(self, texts, budget):
        if not texts:
            return []
        provider = self.provider_clients.get('embedding')
        if provider is not None:
            vectors = provider.embed(texts, budget)
            if vectors:
                self.dimension = provider.dimension
            return vectors
        data = self._call('embedding','/v1/embeddings', {'model':self.config['embedding_endpoint']['model'], 'input':list(texts)}, budget)
        rows = data.get('data')
        if not isinstance(rows, list) or len(rows) != len(texts):
            raise ModelUnavailable('Embedding count mismatch')
        by_index = {}
        for row in rows:
            index, vector = row.get('index'), row.get('embedding')
            if type(index) is not int or index in by_index or index not in range(len(texts)) or not isinstance(vector,list) or not vector:
                raise ModelUnavailable('Invalid embedding index or vector')
            if any(type(v) not in (int,float) or not math.isfinite(v) for v in vector):
                raise ModelUnavailable('Embedding contains nonfinite values')
            if self.dimension is None:
                self.dimension = len(vector)
            if len(vector) != self.dimension:
                raise ModelUnavailable('Embedding dimension changed')
            by_index[index] = vector
        return [by_index[i] for i in range(len(texts))]

    def rerank(self, question, candidates, budget):
        if not candidates:
            return []
        provider = self.provider_clients.get('rerank')
        if provider is not None:
            scores = provider.rerank(question, [c.chunk.text for c in candidates], budget)
            ranked = [replace(candidate, raw_score=score, score=score,
                              score_transform='identity')
                      for candidate, score in zip(candidates, scores)]
            ranked.sort(key=lambda c: (-c.score, c.chunk.id))
            return [replace(candidate, rank=index + 1) for index, candidate in enumerate(ranked)]
        e = self.config['rerank_endpoint']
        data = self._call('rerank', '/v1/rerank', {'model':e['model'], 'query':question, 'documents':[c.chunk.text for c in candidates], 'top_n':len(candidates)}, budget)
        if 'results' in data and 'data' not in data:
            rows, score_field = data['results'], 'relevance_score'
        elif 'data' in data and 'results' not in data:
            rows, score_field = data['data'], 'score'
        else:
            raise ModelUnavailable('Unknown rerank response shape')
        if not isinstance(rows,list) or len(rows) != len(candidates):
            raise ModelUnavailable('Rerank count mismatch')
        seen, ranked = set(), []
        for row in rows:
            index, raw = row.get('index'), row.get(score_field)
            if type(index) is not int or index not in range(len(candidates)) or index in seen or type(raw) not in (int,float) or not math.isfinite(raw):
                raise ModelUnavailable('Invalid rerank index or score')
            seen.add(index)
            score = raw if e['score_transform'] == 'identity' else 1 / (1 + math.exp(-max(-700,min(700,raw))))
            ranked.append(replace(candidates[index],raw_score=raw,score=score,score_transform=e['score_transform']))
        ranked.sort(key=lambda c:(-c.score,c.chunk.id))
        return [replace(c,rank=i+1) for i,c in enumerate(ranked)]

    def json_chat(self, messages, schema, budget):
        started=time.monotonic()
        data = self._call('qa','/v1/chat/completions', {'model':self.config['qa_endpoint']['model'], 'messages':list(messages), 'stream':False,
            'temperature':0, 'max_tokens':self.config['qa_endpoint']['max_output_tokens'],
            'chat_template_kwargs':{'enable_thinking':False}, 'response_format':{'type':'json_object','schema':schema}}, budget)
        from .diagnostics import log_event
        log_event('knowledge.model_call',role='qa',duration_ms=round((time.monotonic()-started)*1000,2),
            usage=data.get('usage',{}),timings=data.get('timings',{}))
        try:
            choice = data['choices'][0]
            if choice.get('finish_reason') not in ('stop', None):
                raise ValueError('Incomplete output')
            raw = choice['message']['content']
            if not isinstance(raw,str) or not raw.strip():
                raise ValueError('Empty output')
            parsed = json.loads(raw, parse_constant=lambda _: (_ for _ in ()).throw(ValueError('nonfinite JSON')))
            validate_json(parsed,schema)
            if not isinstance(parsed,dict):
                raise ValueError('Expected JSON object')
            return parsed
        except (ValueError,KeyError,TypeError,IndexError) as exc:
            raise ModelUnavailable('Invalid or incomplete structured local answer') from exc

    def count_tokens(self, text, budget):
        try:
            data = self._call('qa','/tokenize', {'content':text}, budget)
            tokens = data.get('tokens')
            if isinstance(tokens,list) and all(type(x) is int for x in tokens):
                return len(tokens)
        except ModelUnavailable:
            budget.check()
        return len(text.encode('utf-8'))

    def probe(self, budget):
        from .contracts import Chunk, Candidate
        out = {}
        for role in ('embedding','rerank','qa'):
            if role == 'qa' and not qa_configured(self.config):
                out[role] = dict(available=False, skipped=True, configured=False, model='', fingerprint=None, error=None)
                continue
            try:
                if role == 'embedding':
                    self.embed(['local capability probe'],budget)
                elif role == 'rerank':
                    self.rerank('probe',[Candidate(Chunk('probe',text='probe'))],budget)
                else:
                    self.json_chat([{'role':'user','content':'Return {"ok":true}.'}], {'type':'object','properties':{'ok':{'type':'boolean'}},'required':['ok']}, budget)
                out[role] = dict(available=True, model=self.config[role+'_endpoint']['model'], fingerprint=self.fingerprint, error=None)
            except (ModelUnavailable,LocalTimeout) as exc:
                out[role] = dict(available=False,model=self.config[role+'_endpoint']['model'],fingerprint=None,error=str(exc))
        return out
