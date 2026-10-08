import copy
import hashlib
import ipaddress
import json
import math
from urllib.parse import urlsplit


def default_config() -> dict:
    def endpoint(protocol):
        return dict(url='', protocol=protocol, model='', model_revision='', allow_lan=False)
    return dict(enabled=False, collect_api_chats=True, collect_web_chats=True,
        embedding_endpoint=endpoint('openai_embeddings'),
        rerank_endpoint={**endpoint('llama_rerank'), 'score_transform': 'identity'},
        qa_endpoint={**endpoint('llama_chat'), 'context_tokens': 4096, 'max_output_tokens': 1024},
        vector_top_k=20, rerank_top_k=5, local_timeout_seconds=30,
        evaluation_profile_id='', online_fallback=True, selected_source_ids=[],
        time_sensitive_ttl_seconds=3600)


def merge_config(base: dict, patch: dict) -> dict:
    out = copy.deepcopy(base)
    for key, value in patch.items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = merge_config(out[key], value)
        else:
            out[key] = copy.deepcopy(value)
    return out


def validate_config(value: dict) -> dict:
    if not isinstance(value, dict):
        raise ValueError('local_knowledge must be an object')
    default = default_config()
    if set(value) - set(default):
        raise ValueError('Unknown local knowledge setting')
    c = merge_config(default, value)
    for key in ('enabled', 'collect_api_chats', 'collect_web_chats', 'online_fallback'):
        if type(c[key]) is not bool:
            raise ValueError(f'{key} must be boolean')
    for key in ('vector_top_k', 'rerank_top_k', 'time_sensitive_ttl_seconds'):
        if type(c[key]) is not int or c[key] < 1:
            raise ValueError(f'{key} must be a positive integer')
    if (type(c['local_timeout_seconds']) not in (int, float)
            or not math.isfinite(c['local_timeout_seconds']) or c['local_timeout_seconds'] <= 0):
        raise ValueError('local_timeout_seconds must be finite and positive')
    if not isinstance(c['evaluation_profile_id'], str) or not isinstance(c['selected_source_ids'], list) or any(not isinstance(v, str) for v in c['selected_source_ids']):
        raise ValueError('Invalid evaluation profile or source IDs')
    for key in ('embedding_endpoint', 'rerank_endpoint', 'qa_endpoint'):
        e = c[key]
        if not isinstance(e, dict) or set(e) - set(default[key]):
            raise ValueError(f'Invalid {key}')
        if e['protocol'] != default[key]['protocol'] or type(e['allow_lan']) is not bool:
            raise ValueError(f'Invalid {key} protocol')
        if any(not isinstance(e[v], str) for v in ('url', 'model', 'model_revision')):
            raise ValueError(f'Invalid {key} values')
        if e['url']:
            p = urlsplit(e['url'])
            if p.scheme not in ('http', 'https') or not p.hostname or p.username or p.password or p.query or p.fragment:
                raise ValueError('A local endpoint must be a plain HTTP(S) URL')
            if p.hostname != 'localhost':
                try:
                    address = ipaddress.ip_address(p.hostname)
                except ValueError:
                    if not e['allow_lan']:
                        raise ValueError('Local endpoints require a loopback host')
                else:
                    private_lan = address.is_private and not address.is_unspecified and not address.is_multicast and not address.is_link_local
                    if not address.is_loopback and not (e['allow_lan'] and private_lan):
                        raise ValueError('Public endpoints cannot be local model roles')
    if c['rerank_endpoint']['score_transform'] not in ('identity', 'sigmoid'):
        raise ValueError('Unsupported rerank score transform')
    for key in ('context_tokens', 'max_output_tokens'):
        if type(c['qa_endpoint'][key]) is not int or c['qa_endpoint'][key] < 1:
            raise ValueError(f'{key} must be positive')
    return c


def stable_hash(value) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def request_fingerprint(request: dict, effective_scope) -> str:
    target = request.get('online_target')
    if target is not None:
        if not isinstance(target, dict) or set(target) - {'kind', 'provider_id', 'model', 'target_ids'}:
            raise ValueError('Invalid online target; credentials are not permitted')
    keys = ('question', 'context', 'system_constraints', 'mode', 'parameters', 'online_target')
    return stable_hash({**{k: request.get(k) for k in keys}, 'source_ids': sorted(effective_scope)})


def model_fingerprint(config: dict, dimension: int | None = None) -> str:
    return stable_hash({'roles': {k: config[k] for k in ('embedding_endpoint', 'rerank_endpoint', 'qa_endpoint')},
                        'dimension': dimension, 'verifier_version': 'evidence-v1'})
