"""OpenAI-compatible embedding/rerank clients for configured providers.

Provider credentials stay on the server.  This module deliberately returns
short, stable errors so a remote gateway cannot echo an API key or a large
response body into a task snapshot or browser response.
"""
import math
import time
from typing import Any
from urllib.parse import urlsplit

import requests

from .model_clients import Budget, Cancelled, LocalTimeout, ModelUnavailable


class ProviderClientError(ModelUnavailable):
    """A configured online provider cannot satisfy a capability request."""


def _api_type(provider: dict[str, Any]) -> str:
    return str(provider.get('apiType') or provider.get('api_type') or 'openai').lower()


def _base_url(provider: dict[str, Any]) -> str:
    value = str(provider.get('baseUrl') or provider.get('base_url') or '').strip().rstrip('/')
    if not value:
        raise ProviderClientError('Provider 缺少 Base URL')
    parsed = urlsplit(value)
    if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ProviderClientError('Provider Base URL 无效')
    return value


def _url(provider: dict[str, Any], path: str) -> str:
    base = _base_url(provider)
    path = '/' + str(path or '').strip('/')
    if base.endswith('/v1') and path.startswith('/v1/'):
        path = path[3:]
    if base.endswith(path):
        return base
    return base + path


def _headers(provider: dict[str, Any]) -> dict[str, str]:
    if _api_type(provider) == 'anthropic':
        raise ProviderClientError('Anthropic Provider 不支持 embedding/rerank 兼容接口')
    key = str(provider.get('apiKey') or provider.get('api_key') or '').strip()
    headers = {'Content-Type': 'application/json', 'Accept': 'application/json'}
    if key:
        headers['Authorization'] = f'Bearer {key}'
    return headers


class ProviderModelClient:
    def __init__(self, provider: dict[str, Any], role: str, model: str, path: str = ''):
        if role not in ('embedding', 'rerank'):
            raise ValueError('Provider 能力必须是 embedding 或 rerank')
        if not isinstance(model, str) or not model.strip():
            raise ProviderClientError('Provider 模型不能为空')
        self.provider = dict(provider)
        self.role = role
        self.model = model.strip()
        default_path = '/v1/embeddings' if role == 'embedding' else '/v1/rerank'
        self.path = '/' + str(path or default_path).strip('/')
        if not self.path.startswith('/v1/'):
            self.path = '/v1' + self.path if self.path.startswith('/') else '/v1/' + self.path
        self.dimension: int | None = None

    def _post(self, payload: dict[str, Any], budget: Budget) -> dict[str, Any]:
        budget.check()
        remaining = max(0.05, budget.remaining())
        try:
            response = requests.post(_url(self.provider, self.path), headers=_headers(self.provider),
                                     json=payload, timeout=remaining, allow_redirects=False)
        except requests.Timeout as exc:
            budget.check()
            raise LocalTimeout('Provider 请求超时') from exc
        except requests.RequestException as exc:
            budget.check()
            raise ProviderClientError(f'Provider 请求失败：{type(exc).__name__}') from exc
        budget.check()
        if response.status_code < 200 or response.status_code >= 300:
            raise ProviderClientError(f'Provider 返回 HTTP {response.status_code}')
        try:
            if int(response.headers.get('Content-Length', '0') or 0) > 8 * 1024 * 1024:
                raise ProviderClientError('Provider 响应过大')
            raw = response.content
            if len(raw) > 8 * 1024 * 1024:
                raise ProviderClientError('Provider 响应过大')
        except ProviderClientError:
            raise
        except (TypeError, ValueError):
            raw = response.content
            if len(raw) > 8 * 1024 * 1024:
                raise ProviderClientError('Provider 响应过大')
        try:
            value = response.json()
        except ValueError as exc:
            raise ProviderClientError('Provider 返回的不是有效 JSON') from exc
        if not isinstance(value, dict):
            raise ProviderClientError('Provider 返回 JSON 必须是对象')
        return value

    def embed(self, texts: list[str], budget: Budget) -> list[list[float]]:
        if not texts:
            return []
        data = self._post({'model': self.model, 'input': list(texts)}, budget).get('data')
        if not isinstance(data, list) or len(data) != len(texts):
            raise ProviderClientError('embedding 返回数量与输入不一致')
        ordered: list[list[float] | None] = [None] * len(texts)
        for position, row in enumerate(data):
            if not isinstance(row, dict):
                raise ProviderClientError('embedding 响应条目无效')
            index = row.get('index', position)
            vector = row.get('embedding')
            if type(index) is not int or not 0 <= index < len(texts) or ordered[index] is not None:
                raise ProviderClientError('embedding 响应 index 无效')
            if not isinstance(vector, list) or not vector or any(type(v) not in (int, float) or not math.isfinite(v) for v in vector):
                raise ProviderClientError('embedding 向量格式无效')
            if self.dimension is None:
                self.dimension = len(vector)
            if len(vector) != self.dimension:
                raise ProviderClientError('embedding 向量维度不一致')
            ordered[index] = [float(v) for v in vector]
        if any(v is None for v in ordered):
            raise ProviderClientError('embedding 响应缺少向量')
        return [v for v in ordered if v is not None]

    def rerank(self, query: str, documents: list[str], budget: Budget) -> list[float]:
        if not documents:
            return []
        payload = {'model': self.model, 'query': str(query), 'documents': list(documents), 'top_n': len(documents)}
        response = self._post(payload, budget)
        rows = response.get('results', response.get('data'))
        if not isinstance(rows, list) or len(rows) != len(documents):
            raise ProviderClientError('rerank 返回数量与输入不一致')
        scores: list[float | None] = [None] * len(documents)
        for position, row in enumerate(rows):
            if not isinstance(row, dict):
                raise ProviderClientError('rerank 响应条目无效')
            index = row.get('index', position)
            score = row.get('relevance_score', row.get('score'))
            if type(index) is not int or not 0 <= index < len(documents) or scores[index] is not None:
                raise ProviderClientError('rerank 响应 index 无效')
            if type(score) not in (int, float) or not math.isfinite(score):
                raise ProviderClientError('rerank 分数格式无效')
            scores[index] = float(score)
        if any(score is None for score in scores):
            raise ProviderClientError('rerank 响应缺少分数')
        return [score for score in scores if score is not None]

    def probe(self, budget: Budget) -> dict[str, Any]:
        started = time.monotonic()
        if self.role == 'embedding':
            vector = self.embed(['本地知识连接测试'], budget)[0]
            return {'ok': True, 'role': self.role, 'model': self.model, 'count': 1,
                    'dimension': len(vector), 'latency_ms': round((time.monotonic() - started) * 1000, 1)}
        scores = self.rerank('本地知识连接测试', ['测试文档一', '测试文档二'], budget)
        return {'ok': True, 'role': self.role, 'model': self.model, 'count': len(scores),
                'top_score': max(scores), 'latency_ms': round((time.monotonic() - started) * 1000, 1)}


def _models(provider: dict[str, Any], role: str) -> list[str]:
    explicit = provider.get('embeddingModels' if role == 'embedding' else 'rerankModels')
    if not isinstance(explicit, list):
        explicit = provider.get('embedding_models' if role == 'embedding' else 'rerank_models')
    if isinstance(explicit, list):
        return [x.strip() for x in explicit if isinstance(x, str) and x.strip()]
    values = provider.get('models', [])
    if not isinstance(values, list):
        return []
    import re
    pattern = r'embed|e5|bge(?![-_]?rerank)|jina[-_].*embedding' if role == 'embedding' else r'rerank|reranker|cross[-_.]?encoder|jina[-_].*rank'
    return [x.strip() for x in values if isinstance(x, str) and x.strip() and re.search(pattern, x, re.I)]


def provider_catalog(providers: list[dict[str, Any]]) -> list[dict[str, Any]]:
    result = []
    for provider in providers if isinstance(providers, list) else []:
        if not isinstance(provider, dict) or not provider.get('id'):
            continue
        api_type = _api_type(provider)
        embedding = [] if api_type == 'anthropic' else _models(provider, 'embedding')
        rerank = [] if api_type == 'anthropic' else _models(provider, 'rerank')
        result.append({'id': provider['id'], 'name': provider.get('name') or provider['id'],
                       'api_type': api_type, 'embedding_models': embedding, 'rerank_models': rerank,
                       'configured': bool(provider.get('baseUrl')), 
                       'reason': 'Anthropic Provider 不支持 embedding/rerank' if api_type == 'anthropic' else None})
    return result
