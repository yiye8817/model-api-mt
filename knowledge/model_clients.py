"""Small provider adapters for embedding and reranking requests."""
import re
from typing import Any

import requests


class ModelClientError(RuntimeError):
    """A configured provider could not satisfy a model request."""


def _api_type(provider: dict[str, Any]) -> str:
    return 'anthropic' if str(provider.get('apiType') or provider.get('api_type') or '').lower() == 'anthropic' else 'openai'


def _endpoint(base_url: str, path: str) -> str:
    base = str(base_url or '').rstrip('/')
    clean = path.strip('/')
    if base.endswith('/' + clean):
        return base
    return f'{base}/{clean}'


def _headers(provider: dict[str, Any]) -> dict[str, str]:
    key = str(provider.get('apiKey') or provider.get('api_key') or '').strip()
    headers = {'Content-Type': 'application/json', 'Accept': 'application/json'}
    if key:
        headers['Authorization'] = f'Bearer {key}'
    return headers


def _validate_openai_provider(provider: dict[str, Any]) -> None:
    if _api_type(provider) == 'anthropic':
        raise ModelClientError('Anthropic provider 不支持 embedding/rerank 接口')
    if not str(provider.get('baseUrl') or provider.get('base_url') or '').strip():
        raise ModelClientError('provider 缺少 baseUrl')


def _json_response(response: requests.Response) -> dict[str, Any]:
    if response.status_code >= 400:
        detail = response.text[:300].strip()
        raise ModelClientError(f'provider 返回 HTTP {response.status_code}' + (f'：{detail}' if detail else ''))
    try:
        payload = response.json()
    except ValueError as exc:
        raise ModelClientError('provider 返回的不是有效 JSON') from exc
    if not isinstance(payload, dict):
        raise ModelClientError('provider 返回 JSON 必须是对象')
    return payload


def _post(provider: dict[str, Any], path: str, payload: dict[str, Any], timeout: int) -> dict[str, Any]:
    _validate_openai_provider(provider)
    url = _endpoint(provider.get('baseUrl') or provider.get('base_url'), path)
    try:
        response = requests.post(url, headers=_headers(provider), json=payload, timeout=timeout)
    except requests.RequestException as exc:
        raise ModelClientError(f'provider 请求失败：{exc}') from exc
    return _json_response(response)


def embed_texts(provider: dict[str, Any], model: str, texts: list[str], timeout: int = 120) -> list[list[float]]:
    """Generate vectors and return them in the same order as texts."""
    if not isinstance(texts, list) or not texts:
        return []
    if not isinstance(model, str) or not model.strip():
        raise ModelClientError('embedding 模型不能为空')
    payload = _post(provider, 'embeddings', {'model': model.strip(), 'input': texts}, timeout)
    data = payload.get('data')
    if not isinstance(data, list) or len(data) != len(texts):
        raise ModelClientError('embedding 响应缺少完整 data')
    ordered: list[list[float] | None] = [None] * len(texts)
    for position, item in enumerate(data):
        if not isinstance(item, dict):
            raise ModelClientError('embedding 响应条目无效')
        index = item.get('index', position)
        if type(index) is not int or not 0 <= index < len(texts) or ordered[index] is not None:
            raise ModelClientError('embedding 响应 index 无效')
        vector = item.get('embedding')
        if not isinstance(vector, list) or not vector or not all(isinstance(value, (int, float)) for value in vector):
            raise ModelClientError('embedding 向量格式无效')
        ordered[index] = [float(value) for value in vector]
    if any(vector is None for vector in ordered):
        raise ModelClientError('embedding 响应缺少向量')
    result = [vector for vector in ordered if vector is not None]
    dimensions = {len(vector) for vector in result}
    if len(dimensions) != 1:
        raise ModelClientError('embedding 向量维度不一致')
    return result


def rerank_texts(provider: dict[str, Any], model: str, query: str, documents: list[str], timeout: int = 120) -> list[float]:
    """Return rerank scores aligned to the input document order."""
    if not isinstance(documents, list) or not documents:
        return []
    if not isinstance(model, str) or not model.strip():
        raise ModelClientError('rerank 模型不能为空')
    payload = _post(provider, 'rerank', {
        'model': model.strip(), 'query': query, 'documents': documents,
    }, timeout)
    data = payload.get('results', payload.get('data'))
    if not isinstance(data, list) or len(data) != len(documents):
        raise ModelClientError('rerank 响应缺少完整 results/data')
    scores: list[float | None] = [None] * len(documents)
    for position, item in enumerate(data):
        if not isinstance(item, dict):
            raise ModelClientError('rerank 响应条目无效')
        index = item.get('index', position)
        score = item.get('relevance_score', item.get('score'))
        if type(index) is not int or not 0 <= index < len(documents) or scores[index] is not None:
            raise ModelClientError('rerank 响应 index 无效')
        if not isinstance(score, (int, float)):
            raise ModelClientError('rerank 分数格式无效')
        scores[index] = float(score)
    if any(score is None for score in scores):
        raise ModelClientError('rerank 响应缺少分数')
    return [score for score in scores if score is not None]


def _metadata_models(provider: dict[str, Any], *names: str) -> list[str] | None:
    for name in names:
        value = provider.get(name)
        if isinstance(value, list):
            return [item.strip() for item in value if isinstance(item, str) and item.strip()]
    return None


def provider_capabilities(providers: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Project configured providers into selectable embedding/rerank models."""
    result = []
    for provider in providers if isinstance(providers, list) else []:
        if not isinstance(provider, dict) or not provider.get('id'):
            continue
        api_type = _api_type(provider)
        models = [item.strip() for item in provider.get('models', []) if isinstance(item, str) and item.strip()]
        explicit_embeddings = _metadata_models(provider, 'embeddingModels', 'embedding_models')
        explicit_rerank = _metadata_models(provider, 'rerankModels', 'rerank_models')
        if explicit_embeddings is None:
            explicit_embeddings = [item for item in models if re.search(r'embed|e5|jina-.*embedding|(^|[-_])bge(?![-_]?rerank)', item, re.I)]
        if explicit_rerank is None:
            explicit_rerank = [item for item in models if re.search(r'rerank|reranker|cross.encoder|jina-.*rank', item, re.I)]
        reason = None
        if api_type == 'anthropic':
            explicit_embeddings = []
            explicit_rerank = []
            reason = 'Anthropic provider 不支持 embedding/rerank'
        elif not explicit_embeddings and not explicit_rerank:
            reason = '无法推断该 provider 的 embedding/rerank 模型，请在 provider 中配置 capability metadata'
        result.append({
            'provider_id': provider['id'], 'name': provider.get('name') or provider['id'],
            'api_type': api_type, 'embedding_models': explicit_embeddings,
            'rerank_models': explicit_rerank, 'reason': reason,
        })
    return result
