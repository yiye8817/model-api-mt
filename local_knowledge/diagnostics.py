"""Structured local-search diagnostics use the application's rotating log."""
import json
import logging
import os
import re

logger = logging.getLogger('local_knowledge')
CONTENT_KEYS = frozenset(('question', 'lookup_term', 'input_term', 'matched_term', 'quote', 'answer'))


def log_event(event, **fields):
    enabled = os.environ.get('LOG_LLM_CONTENT', '1').strip().lower() not in ('0', 'false', 'no', 'off')
    def clean(value, key=''):
        if not enabled and key in CONTENT_KEYS:
            return '<content-disabled>'
        if isinstance(value, dict):
            return {k: clean(v, k) for k, v in value.items()}
        if isinstance(value, list):
            return [clean(v) for v in value]
        if isinstance(value, str):
            value = re.sub(r'(?i)(bearer\s+)[A-Za-z0-9._~+/=-]+', r'\1***REDACTED***', value)
            return re.sub(r'(?i)\bsk-[A-Za-z0-9_-]{12,}\b', 'sk-***REDACTED***', value)[:1600]
        return value
    try:
        logger.info(json.dumps(clean({'event': event, **fields}), ensure_ascii=False, allow_nan=False))
    except (TypeError, ValueError):
        logger.warning('Local search diagnostics could not be serialized')
