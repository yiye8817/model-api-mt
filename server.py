#!/usr/bin/env python3
"""
LLM API Manager - Python Backend with Terminal, Code Execution, File Management
Persistent storage for providers, conversations, and settings.

Usage:
    pip install flask requests
    pip install ddgs                # optional, for 联网搜索 (web search)
    pip install flask-sock         # optional, for WebSocket PTY terminal (syntax highlight + interactive)
    python server.py

Then open http://localhost:8765 in your browser.
"""

import json
import re
import sys
import os
import subprocess
import tempfile
import shutil
import logging
import sqlite3
from logging.handlers import RotatingFileHandler
import platform
import time
import threading
import queue
import uuid
import struct
import signal
import shlex
import ast
from urllib.parse import urlparse

# Get the absolute path of the directory where this script lives
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DIST_DIR = os.path.join(BASE_DIR, 'dist')
WORKSPACE_DIR = os.path.join(BASE_DIR, 'workspace')
DATA_DIR = os.path.join(BASE_DIR, 'data')
LOG_DIR = os.path.abspath(os.environ.get('LOG_DIR') or os.path.join(BASE_DIR, 'logs'))

# Create required directories
os.makedirs(WORKSPACE_DIR, exist_ok=True)
os.makedirs(DATA_DIR, exist_ok=True)
os.makedirs(LOG_DIR, exist_ok=True)

try:
    from flask import Flask, request, Response, send_from_directory, send_file, jsonify, stream_with_context, g, has_request_context
    import requests as http_requests
except ImportError:
    print("=" * 60)
    print("Required packages not found. Install them with:")
    print("  pip install flask requests")
    print("=" * 60)
    sys.exit(1)

# Configure console + rotating file logs.
def _int_env(name, default):
    try:
        return max(1, int(os.environ.get(name, default)))
    except (TypeError, ValueError):
        return default


_LOG_MAX_BYTES = _int_env('LOG_MAX_BYTES', 10 * 1024 * 1024)
_LOG_BACKUP_COUNT = _int_env('LOG_BACKUP_COUNT', 7)
_LLM_LOG_MAX_CHARS = _int_env('LLM_LOG_MAX_CHARS', 50000)
_LOG_LLM_CONTENT = os.environ.get('LOG_LLM_CONTENT', '1').strip().lower() not in ('0', 'false', 'no', 'off')
_LOG_FORMAT = logging.Formatter(
    '%(asctime)s [%(levelname)s] [%(name)s] %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S',
)

_console_handler = logging.StreamHandler()
_console_handler.setFormatter(_LOG_FORMAT)
_server_file_handler = RotatingFileHandler(
    os.path.join(LOG_DIR, 'server.log'),
    maxBytes=_LOG_MAX_BYTES,
    backupCount=_LOG_BACKUP_COUNT,
    encoding='utf-8',
)
_server_file_handler.setFormatter(_LOG_FORMAT)
logging.basicConfig(level=logging.INFO, handlers=[_console_handler, _server_file_handler], force=True)
# DDGS 会把单个备用引擎失败记为 INFO，随后正常回退；避免将其误认为接口失败。
logging.getLogger('ddgs').setLevel(logging.WARNING)
logging.getLogger('primp').setLevel(logging.WARNING)
logger = logging.getLogger('model_api')

_interaction_file_handler = RotatingFileHandler(
    os.path.join(LOG_DIR, 'llm-interactions.log'),
    maxBytes=_LOG_MAX_BYTES,
    backupCount=_LOG_BACKUP_COUNT,
    encoding='utf-8',
)
_interaction_file_handler.setFormatter(_LOG_FORMAT)
interaction_logger = logging.getLogger('llm_interactions')
interaction_logger.setLevel(logging.INFO)
interaction_logger.handlers.clear()
interaction_logger.addHandler(_interaction_file_handler)
interaction_logger.propagate = False

_SENSITIVE_LOG_KEYS = {
    'apikey', 'authorization', 'password', 'sudopassword', 'token',
    'accesstoken', 'refreshtoken', 'secret', 'clientsecret',
}
_SENSITIVE_CONTAINER_KEYS = {'keys', 'credentials', 'secrets'}


def _log_value(value, depth=0):
    """Return a JSON-serializable, size-limited value with credentials removed."""
    if depth > 12:
        return '<max-depth>'
    if isinstance(value, dict):
        out = {}
        for key, item in value.items():
            key_text = str(key)
            key_norm = re.sub(r'[^a-z0-9]', '', key_text.lower())
            if key_norm in _SENSITIVE_CONTAINER_KEYS:
                if isinstance(item, dict):
                    out[key_text] = {
                        str(child_key): ('***REDACTED***' if child_value else child_value)
                        for child_key, child_value in item.items()
                    }
                else:
                    out[key_text] = '***REDACTED***'
            elif key_norm in _SENSITIVE_LOG_KEYS or key_norm.endswith('apikey'):
                out[key_text] = '***REDACTED***'
            else:
                out[key_text] = _log_value(item, depth + 1)
        return out
    if isinstance(value, (list, tuple)):
        return [_log_value(item, depth + 1) for item in value]
    if isinstance(value, bytes):
        value = value.decode('utf-8', errors='replace')
    if isinstance(value, str):
        if value.startswith('data:'):
            return f'<data-url omitted; {len(value)} chars>'
        value = re.sub(r'(?i)(bearer\s+)[A-Za-z0-9._~+/=-]+', r'\1***REDACTED***', value)
        value = re.sub(r'(?i)\bsk-[A-Za-z0-9_-]{12,}\b', 'sk-***REDACTED***', value)
        value = re.sub(r'(https?://)[^/@:\s]+:[^/@\s]+@', r'\1***:***@', value)
        if len(value) > _LLM_LOG_MAX_CHARS:
            omitted = len(value) - _LLM_LOG_MAX_CHARS
            return value[:_LLM_LOG_MAX_CHARS] + f'\n... <truncated {omitted} chars>'
        return value
    if value is None or isinstance(value, (bool, int, float)):
        return value
    return str(value)


def _log_summary(value):
    if isinstance(value, dict):
        return {'logging': 'content-disabled', 'keys': list(value.keys())[:30]}
    if isinstance(value, (list, tuple)):
        return {'logging': 'content-disabled', 'items': len(value)}
    return {'logging': 'content-disabled', 'chars': len(str(value or ''))}


def _request_id():
    if has_request_context():
        return getattr(g, 'request_id', None)
    return None


def _log_interaction(event, **fields):
    """Write one structured LLM/search/workflow event; never fail the request."""
    try:
        if not _LOG_LLM_CONTENT:
            for key in ('messages', 'system_prompt', 'user_prompt', 'response', 'body'):
                if key in fields:
                    fields[key] = _log_summary(fields[key])
        record = {'event': event, 'request_id': fields.pop('request_id', None) or _request_id()}
        record.update(fields)
        interaction_logger.info(json.dumps(_log_value(record), ensure_ascii=False, separators=(',', ':')))
    except Exception as exc:
        logger.warning('Could not write interaction log: %s', exc)


def _sse_content(frame):
    """Extract text deltas from OpenAI- or Anthropic-style SSE frames."""
    if isinstance(frame, bytes):
        frame = frame.decode('utf-8', errors='replace')
    chunks = []
    for line in str(frame or '').splitlines():
        line = line.strip()
        if not line.startswith('data:'):
            continue
        raw = line[5:].strip()
        if not raw or raw == '[DONE]':
            continue
        try:
            data = json.loads(raw)
        except Exception:
            continue
        for choice in data.get('choices') or []:
            delta = choice.get('delta') or {}
            message = choice.get('message') or {}
            for key in ('reasoning_content', 'content'):
                text = delta.get(key)
                if isinstance(text, str):
                    chunks.append(text)
            text = message.get('content')
            if isinstance(text, str):
                chunks.append(text)
        delta = data.get('delta') or {}
        if isinstance(delta.get('text'), str):
            chunks.append(delta['text'])
        block = data.get('content_block') or {}
        if isinstance(block.get('text'), str):
            chunks.append(block['text'])
    return ''.join(chunks)


logger.info('日志已启用: server=%s interactions=%s',
            os.path.join(LOG_DIR, 'server.log'),
            os.path.join(LOG_DIR, 'llm-interactions.log'))

try:
    import plugin_manager as pm
except ImportError:
    pm = None

# Create Flask app
app = Flask(__name__, static_folder=None)
app.config['MAX_CONTENT_LENGTH'] = 50 * 1024 * 1024  # 50MB max upload

_FLOW_PREFIXES = (
    '/api/chat', '/api/research', '/api/agent', '/api/web-search',
    '/api/plugins', '/api/chat-with-plugin', '/claude-proxy/', '/hermes-proxy/',
)


@app.before_request
def _flow_log_start():
    path = request.path or ''
    if not any(path.startswith(prefix) for prefix in _FLOW_PREFIXES):
        return None
    g.request_id = request.headers.get('X-Request-ID') or uuid.uuid4().hex
    g.flow_started_at = time.monotonic()
    _log_interaction('flow.start', method=request.method, path=path)
    if request.method in ('POST', 'PUT', 'PATCH') and request.is_json:
        _log_interaction(
            'flow.input',
            method=request.method,
            path=path,
            body=request.get_json(silent=True),
        )
    logger.info('Flow start id=%s method=%s path=%s', g.request_id, request.method, path)
    return None


@app.after_request
def _flow_log_complete(response):
    request_id = getattr(g, 'request_id', None)
    if not request_id:
        return response
    elapsed_ms = round((time.monotonic() - getattr(g, 'flow_started_at', time.monotonic())) * 1000, 1)
    response.headers['X-Request-ID'] = request_id
    _log_interaction(
        'flow.complete',
        request_id=request_id,
        method=request.method,
        path=request.path,
        status=response.status_code,
        elapsed_ms=elapsed_ms,
        streamed=bool(response.is_streamed),
    )
    if not response.is_streamed and response.is_json:
        _log_interaction(
            'flow.output',
            request_id=request_id,
            method=request.method,
            path=request.path,
            status=response.status_code,
            body=response.get_json(silent=True),
        )
    logger.info('Flow complete id=%s status=%s elapsed_ms=%s path=%s',
                request_id, response.status_code, elapsed_ms, request.path)
    return response

# WebSocket + PTY terminal (optional: pip install flask-sock, Unix only)
_sock = None
try:
    if platform.system() != 'Windows':
        import pty
        import select
        from flask_sock import Sock
        _sock = Sock(app)
        _PTY_AVAILABLE = True
    else:
        _PTY_AVAILABLE = False
except ImportError:
    _PTY_AVAILABLE = False


class _PTYSession:
    """PTY shell session for WebSocket terminal (syntax highlight + interactive)."""
    def __init__(self, send_callback):
        self.send_callback = send_callback
        self.master_fd = None
        self.pid = None
        self.alive = False

    def start(self, cols=120, rows=30):
        shell = os.environ.get("SHELL", "/bin/bash")
        env = os.environ.copy()
        env.update({
            "TERM": "xterm-256color",
            "COLORTERM": "truecolor",
            "COLUMNS": str(cols),
            "LINES": str(rows),
            "LANG": os.environ.get("LANG", "en_US.UTF-8"),
        })
        self.pid, self.master_fd = pty.fork()
        if self.pid == 0:
            try:
                os.chdir(WORKSPACE_DIR)
            except Exception:
                pass
            os.execvpe(shell, [shell, "--login"], env)
        else:
            self.alive = True
            t = threading.Thread(target=self._read_loop, daemon=True)
            t.start()

    def cwd(self):
        """Return the shell's current directory when the host exposes /proc."""
        if not self.pid:
            return None
        try:
            current = os.readlink(f'/proc/{self.pid}/cwd')
            return current if os.path.isdir(current) else None
        except (OSError, TypeError):
            return None

    def _read_loop(self):
        while self.alive and self.master_fd is not None:
            try:
                r, _, _ = select.select([self.master_fd], [], [], 0.05)
                if r:
                    data = os.read(self.master_fd, 4096)
                    if data:
                        self.send_callback(data)
            except (OSError, TypeError):
                self.alive = False
                try:
                    self.send_callback(b"\r\n[Session ended]\r\n")
                except Exception:
                    pass
                break

    def write(self, data: bytes):
        if self.master_fd and self.alive:
            try:
                os.write(self.master_fd, data)
            except OSError:
                self.alive = False

    def resize(self, cols: int, rows: int):
        if self.master_fd and self.alive:
            try:
                import fcntl
                import termios
                winsize = struct.pack("HHHH", rows, cols, 0, 0)
                fcntl.ioctl(self.master_fd, termios.TIOCSWINSZ, winsize)
                if self.pid:
                    os.kill(self.pid, signal.SIGWINCH)
            except Exception:
                pass

    def close(self):
        self.alive = False
        if self.pid:
            try:
                os.kill(self.pid, signal.SIGTERM)
            except OSError:
                pass
        if self.master_fd is not None:
            try:
                os.close(self.master_fd)
            except OSError:
                pass
            self.master_fd = None


if _PTY_AVAILABLE and _sock is not None:
    @_sock.route('/ws')
    def terminal_ws(ws):
        session = _PTYSession(lambda data: ws.send(data))
        session.start(cols=120, rows=30)
        try:
            while True:
                try:
                    msg = ws.receive()
                    if msg is None:
                        break
                    if isinstance(msg, bytes):
                        session.write(msg)
                        continue
                    try:
                        obj = json.loads(msg)
                        t = obj.get("type")
                        if t == "input":
                            session.write((obj.get("data") or "").encode("utf-8"))
                        elif t == "resize":
                            session.resize(int(obj.get("cols", 80)), int(obj.get("rows", 24)))
                        elif t == "cwd":
                            ws.send(json.dumps({
                                "type": "cwd",
                                "requestId": obj.get("requestId"),
                                "cwd": session.cwd(),
                            }))
                        elif t == "ping":
                            ws.send(json.dumps({"type": "pong"}))
                    except (json.JSONDecodeError, TypeError):
                        session.write(msg.encode("utf-8") if isinstance(msg, str) else msg)
                except Exception:
                    break
        finally:
            session.close()


# ============================================================
# Claude Code 自定义后端代理
#   让 Claude Code（只会说 Anthropic Messages 协议）使用应用里"当前选中
#   的 provider"。anthropic 型 provider 直接透传；openai 型 provider 做
#   Anthropic <-> OpenAI 的请求/响应/流式翻译（含 tools / tool_use）。
#   - 启动 claude 时给它设置 ANTHROPIC_BASE_URL=<本服务>/claude-proxy
#     与 ANTHROPIC_API_KEY=<一次性 token>，token 映射到具体 provider。
# ============================================================
_claude_proxy_lock = threading.Lock()
_claude_proxy_providers = {}   # token -> {baseUrl, apiKey, model, apiType, name}


def _register_claude_provider(provider):
    """登记一个 provider，返回一次性 token（写入 claude 的 ANTHROPIC_API_KEY）。"""
    if not provider:
        return None
    base_url = (provider.get('baseUrl') or '').rstrip('/')
    model = provider.get('model') or provider.get('selectedModel') or ''
    if not base_url or not model:
        return None
    token = 'mapi_' + uuid.uuid4().hex + uuid.uuid4().hex
    with _claude_proxy_lock:
        _claude_proxy_providers[token] = {
            'baseUrl': base_url,
            'apiKey': provider.get('apiKey') or '',
            'model': model,
            'apiType': _norm_api_type(provider.get('apiType')),
            'name': provider.get('name') or '',
        }
    return token


def _unregister_claude_provider(token):
    if not token:
        return
    with _claude_proxy_lock:
        _claude_proxy_providers.pop(token, None)


def _claude_proxy_resolve():
    token = request.headers.get('x-api-key') or ''
    if not token:
        auth = request.headers.get('Authorization') or ''
        if auth.lower().startswith('bearer '):
            token = auth[7:].strip()
    with _claude_proxy_lock:
        prov = _claude_proxy_providers.get(token)
    return token, prov


def _anthropic_to_openai_messages(body):
    """Anthropic Messages 请求体 → OpenAI chat messages 列表。"""
    msgs = []
    system = body.get('system')
    if system:
        if isinstance(system, list):
            sys_text = '\n\n'.join(
                b.get('text', '') for b in system if isinstance(b, dict) and b.get('type') == 'text'
            )
        else:
            sys_text = str(system)
        if sys_text.strip():
            msgs.append({'role': 'system', 'content': sys_text})

    for m in body.get('messages', []):
        role = m.get('role')
        content = m.get('content')
        if isinstance(content, str):
            msgs.append({'role': role if role in ('user', 'assistant') else 'user', 'content': content})
            continue
        if not isinstance(content, list):
            continue
        if role == 'assistant':
            text_parts, tool_calls = [], []
            for b in content:
                if not isinstance(b, dict):
                    continue
                bt = b.get('type')
                if bt == 'text':
                    text_parts.append(b.get('text', ''))
                elif bt in ('thinking', 'redacted_thinking'):
                    # 上游 OpenAI 兼容端通常不认 thinking block；并入文本以免丢上下文
                    t = b.get('thinking') or b.get('data') or ''
                    if t:
                        text_parts.append(str(t))
                elif bt == 'tool_use':
                    tid = b.get('id') or f"toolu_{uuid.uuid4().hex[:24]}"
                    tool_calls.append({
                        'id': tid,
                        'type': 'function',
                        'function': {
                            'name': b.get('name') or 'tool',
                            'arguments': json.dumps(b.get('input') or {}, ensure_ascii=False),
                        },
                    })
            # 许多上游拒绝 content: null，统一用空串
            am = {'role': 'assistant', 'content': '\n'.join(t for t in text_parts if t) or ''}
            if tool_calls:
                am['tool_calls'] = tool_calls
            if am['content'] or tool_calls:
                msgs.append(am)
        else:  # user
            tool_results = [b for b in content if isinstance(b, dict) and b.get('type') == 'tool_result']
            others = [b for b in content if isinstance(b, dict) and b.get('type') != 'tool_result']
            for b in tool_results:
                rc = b.get('content')
                if isinstance(rc, list):
                    txt = '\n'.join(
                        (x.get('text', '') if isinstance(x, dict) and x.get('type') == 'text'
                         else ('[image]' if isinstance(x, dict) and x.get('type') == 'image' else str(x)))
                        for x in rc
                    )
                elif isinstance(rc, str):
                    txt = rc
                else:
                    txt = json.dumps(rc, ensure_ascii=False) if rc is not None else ''
                msgs.append({
                    'role': 'tool',
                    'tool_call_id': b.get('tool_use_id') or f"toolu_{uuid.uuid4().hex[:24]}",
                    'content': txt or '',
                })
            if others:
                parts = []
                for b in others:
                    if b.get('type') == 'text':
                        parts.append({'type': 'text', 'text': b.get('text', '')})
                    elif b.get('type') == 'image':
                        src = b.get('source') or {}
                        if src.get('type') == 'base64':
                            parts.append({'type': 'image_url', 'image_url': {
                                'url': f"data:{src.get('media_type', 'image/png')};base64,{src.get('data', '')}"}})
                        elif src.get('type') == 'url':
                            parts.append({'type': 'image_url', 'image_url': {'url': src.get('url', '')}})
                if parts and all(p['type'] == 'text' for p in parts):
                    msgs.append({'role': 'user', 'content': '\n'.join(p['text'] for p in parts)})
                elif parts:
                    msgs.append({'role': 'user', 'content': parts})
    return msgs


def _sanitize_json_schema(schema):
    """去掉部分上游（llama.cpp / 旧网关）不接受的 JSON Schema 字段。"""
    if not isinstance(schema, dict):
        return {'type': 'object', 'properties': {}}
    drop = {'$schema', '$id', '$ref', '$defs', 'definitions', 'additionalProperties',
            'unevaluatedProperties', 'patternProperties', 'strict'}
    out = {}
    for k, v in schema.items():
        if k in drop:
            continue
        if isinstance(v, dict):
            out[k] = _sanitize_json_schema(v)
        elif isinstance(v, list):
            out[k] = [_sanitize_json_schema(x) if isinstance(x, dict) else x for x in v]
        else:
            out[k] = v
    if 'type' not in out and 'properties' in out:
        out['type'] = 'object'
    return out or {'type': 'object', 'properties': {}}


def _anthropic_tools_to_openai(body):
    tools = body.get('tools')
    out = None
    if isinstance(tools, list) and tools:
        out = []
        for t in tools:
            if not isinstance(t, dict) or not t.get('name'):
                continue
            # Claude Code 会带 custom / bash 等特殊工具；无 input_schema 时给空 object
            params = t.get('input_schema') or t.get('parameters') or {'type': 'object', 'properties': {}}
            out.append({'type': 'function', 'function': {
                'name': t.get('name'),
                'description': (t.get('description') or '')[:4000],
                'parameters': _sanitize_json_schema(params),
            }})
        if not out:
            out = None
    choice = None
    tc = body.get('tool_choice')
    if isinstance(tc, dict):
        tt = tc.get('type')
        if tt == 'auto':
            choice = 'auto'
        elif tt == 'any':
            choice = 'required'
        elif tt == 'tool' and tc.get('name'):
            choice = {'type': 'function', 'function': {'name': tc.get('name')}}
        elif tt == 'none':
            choice = 'none'
    return out, choice


def _claude_proxy_build_openai_payload(body, model, *, with_stream_options=True):
    """构造发往 OpenAI 兼容上游的 payload。"""
    messages = _anthropic_to_openai_messages(body)
    tools, tool_choice = _anthropic_tools_to_openai(body)
    stream = bool(body.get('stream'))
    payload = {'model': model, 'messages': messages, 'stream': stream}
    # Anthropic 常传很大的 max_tokens；部分上游有上限，做温和裁剪
    mt = body.get('max_tokens')
    if mt:
        try:
            payload['max_tokens'] = min(int(mt), 128000)
        except Exception:
            pass
    if body.get('temperature') is not None:
        try: payload['temperature'] = float(body['temperature'])
        except Exception: pass
    if body.get('top_p') is not None:
        try: payload['top_p'] = float(body['top_p'])
        except Exception: pass
    if body.get('stop_sequences'):
        payload['stop'] = [str(x) for x in body['stop_sequences'] if str(x).strip()][:4]
    if tools:
        payload['tools'] = tools
    if tool_choice is not None:
        payload['tool_choice'] = tool_choice
    # stream_options 在不少本地/兼容网关上会直接 400，由调用方决定是否带上
    if stream and with_stream_options:
        payload['stream_options'] = {'include_usage': True}
    return payload

def _finish_to_stop_reason(fr):
    if fr == 'length':
        return 'max_tokens'
    if fr in ('tool_calls', 'function_call'):
        return 'tool_use'
    if fr == 'content_filter':
        return 'end_turn'
    return 'end_turn'


def _openai_json_to_anthropic(oai, model):
    choice = (oai.get('choices') or [{}])[0]
    msg = choice.get('message') or {}
    blocks = []
    text = msg.get('content')
    if isinstance(text, list):
        text = ''.join(p.get('text', '') for p in text if isinstance(p, dict))
    if text:
        blocks.append({'type': 'text', 'text': text})
    for tcall in (msg.get('tool_calls') or []):
        fn = tcall.get('function') or {}
        try:
            inp = json.loads(fn.get('arguments') or '{}')
        except Exception:
            inp = {}
        blocks.append({'type': 'tool_use', 'id': tcall.get('id') or f"toolu_{uuid.uuid4().hex[:24]}",
                       'name': fn.get('name'), 'input': inp})
    if not blocks:
        blocks = [{'type': 'text', 'text': ''}]
    usage = oai.get('usage') or {}
    return {
        'id': oai.get('id') or f"msg_{uuid.uuid4().hex[:24]}",
        'type': 'message', 'role': 'assistant', 'model': model,
        'content': blocks,
        'stop_reason': _finish_to_stop_reason(choice.get('finish_reason')),
        'stop_sequence': None,
        'usage': {
            'input_tokens': usage.get('prompt_tokens', 0) or 0,
            'output_tokens': usage.get('completion_tokens', 0) or 0,
        },
    }


def _openai_stream_to_anthropic_sse(resp, model):
    """OpenAI SSE 流 → Anthropic Messages SSE 事件流（含 text 与 tool_use）。"""
    def ev(t, obj):
        return f"event: {t}\ndata: {json.dumps(obj, ensure_ascii=False)}\n\n"

    msg_id = f"msg_{uuid.uuid4().hex[:24]}"
    yield ev("message_start", {"type": "message_start", "message": {
        "id": msg_id, "type": "message", "role": "assistant", "model": model,
        "content": [], "stop_reason": None, "stop_sequence": None,
        "usage": {"input_tokens": 0, "output_tokens": 0}}})
    yield ev("ping", {"type": "ping"})

    next_index = 0
    open_index = None            # 当前打开的 anthropic content block 序号
    text_index = None
    tool_map = {}                # openai tool_calls index -> anthropic block 序号
    finish_reason = None
    out_tokens = 0

    for raw in resp.iter_lines():
        if not raw:
            continue
        line = raw.decode('utf-8', 'ignore').strip()
        if not line.startswith('data:'):
            continue
        data = line[5:].strip()
        if data == '[DONE]':
            break
        try:
            chunk = json.loads(data)
        except Exception:
            continue
        if chunk.get('usage'):
            out_tokens = (chunk['usage'] or {}).get('completion_tokens', out_tokens) or out_tokens
        choices = chunk.get('choices') or []
        if not choices:
            continue
        choice = choices[0]
        delta = choice.get('delta') or {}

        text_piece = delta.get('content')
        if text_piece:
            if text_index is None:
                if open_index is not None:
                    yield ev("content_block_stop", {"type": "content_block_stop", "index": open_index})
                text_index = next_index
                next_index += 1
                open_index = text_index
                yield ev("content_block_start", {"type": "content_block_start", "index": text_index,
                                                 "content_block": {"type": "text", "text": ""}})
            elif open_index != text_index:
                yield ev("content_block_stop", {"type": "content_block_stop", "index": open_index})
                open_index = text_index
            yield ev("content_block_delta", {"type": "content_block_delta", "index": text_index,
                                             "delta": {"type": "text_delta", "text": text_piece}})

        for tc in (delta.get('tool_calls') or []):
            oi = tc.get('index', 0)
            fn = tc.get('function') or {}
            if oi not in tool_map:
                if open_index is not None:
                    yield ev("content_block_stop", {"type": "content_block_stop", "index": open_index})
                ai = next_index
                next_index += 1
                tool_map[oi] = ai
                open_index = ai
                yield ev("content_block_start", {"type": "content_block_start", "index": ai,
                         "content_block": {"type": "tool_use",
                                           "id": tc.get('id') or f"toolu_{uuid.uuid4().hex[:24]}",
                                           "name": fn.get('name') or "", "input": {}}})
            else:
                ai = tool_map[oi]
                if open_index != ai:
                    if open_index is not None:
                        yield ev("content_block_stop", {"type": "content_block_stop", "index": open_index})
                    open_index = ai
            args = fn.get('arguments')
            if args:
                yield ev("content_block_delta", {"type": "content_block_delta", "index": ai,
                                                 "delta": {"type": "input_json_delta", "partial_json": args}})

        if choice.get('finish_reason'):
            finish_reason = choice['finish_reason']

    if open_index is not None:
        yield ev("content_block_stop", {"type": "content_block_stop", "index": open_index})
    stop_reason = _finish_to_stop_reason(finish_reason) if finish_reason else ('tool_use' if tool_map else 'end_turn')
    yield ev("message_delta", {"type": "message_delta",
                               "delta": {"stop_reason": stop_reason, "stop_sequence": None},
                               "usage": {"output_tokens": out_tokens}})
    yield ev("message_stop", {"type": "message_stop"})


def _claude_proxy_openai_url(base_url):
    return _openai_endpoint(base_url, 'chat/completions')


@app.route('/claude-proxy/v1/messages', methods=['POST'])
def claude_proxy_messages():
    token, prov = _claude_proxy_resolve()
    if not prov:
        return jsonify({"type": "error", "error": {"type": "authentication_error",
                        "message": "未知的 provider token"}}), 401
    body = request.get_json(force=True, silent=True) or {}
    stream = bool(body.get('stream'))

    # ---- Anthropic 型 provider：直接透传到真实 Anthropic 端点 ----
    if prov['apiType'] == 'anthropic':
        url = _anthropic_endpoint(prov['baseUrl'], 'messages')
        headers = _anthropic_headers(prov['apiKey'], prov['baseUrl'])
        beta = request.headers.get('anthropic-beta')
        if beta:
            headers['anthropic-beta'] = beta
        body['model'] = prov['model'] or body.get('model')
        try:
            if stream:
                r = http_requests.post(url, headers=headers, json=body, stream=True, timeout=600)
                if r.status_code >= 400:
                    err = (r.text or '')[:800]
                    logger.warning("claude-proxy anthropic upstream %s: %s", r.status_code, err)
                    r.close()
                    return jsonify({"type": "error", "error": {"type": "api_error",
                                    "message": f"上游 {r.status_code}: {err}"}}), r.status_code
                def passthrough():
                    try:
                        for c in r.iter_content(chunk_size=8192):
                            if c:
                                yield c
                    finally:
                        try: r.close()
                        except Exception: pass
                return Response(stream_with_context(passthrough()), status=r.status_code,
                                content_type='text/event-stream',
                                headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'})
            r = http_requests.post(url, headers=headers, json=body, timeout=600)
            if r.status_code >= 400:
                err = (r.text or '')[:800]
                logger.warning("claude-proxy anthropic upstream %s: %s", r.status_code, err)
                return jsonify({"type": "error", "error": {"type": "api_error",
                                "message": f"上游 {r.status_code}: {err}"}}), r.status_code
            return Response(r.content, status=r.status_code, content_type='application/json')
        except http_requests.exceptions.RequestException as e:
            return jsonify({"type": "error", "error": {"type": "api_error", "message": str(e)}}), 502

    # ---- OpenAI 型 provider：翻译 ----
    model = prov['model']
    base = prov['baseUrl'] or ''
    # 本地/兼容端常因 stream_options 直接 400，默认不带；失败后再决定
    use_stream_opts = stream and not _is_local_baseurl(base)
    payload = _claude_proxy_build_openai_payload(body, model, with_stream_options=use_stream_opts)

    url = _claude_proxy_openai_url(base)
    headers = _openai_headers(base, prov['apiKey'])

    def _do_post(pl, want_stream):
        if want_stream:
            return http_requests.post(url, headers=headers, json=pl, stream=True, timeout=600)
        return http_requests.post(url, headers=headers, json=pl, timeout=600)

    try:
        if stream:
            r = _do_post(payload, True)
            # 常见 400：stream_options / tools schema —— 自动降级重试一次
            if r.status_code >= 400:
                err = (r.text or '')[:800]
                logger.warning("claude-proxy openai upstream %s (try1): %s", r.status_code, err)
                r.close()
                retry = dict(payload)
                retry.pop('stream_options', None)
                # 若错误像是 tools 不支持，去掉 tools 再试（保底能出文本）
                err_l = err.lower()
                if any(k in err_l for k in ('tool', 'function', 'schema', 'stream_options', 'unknown')):
                    if 'tool' in err_l or 'function' in err_l or 'schema' in err_l:
                        retry.pop('tools', None)
                        retry.pop('tool_choice', None)
                r = _do_post(retry, True)
                if r.status_code >= 400:
                    err2 = (r.text or '')[:800]
                    logger.warning("claude-proxy openai upstream %s (try2): %s", r.status_code, err2)
                    r.close()
                    return jsonify({"type": "error", "error": {"type": "api_error",
                                    "message": f"上游 {r.status_code}: {err2}"}}), r.status_code

            def gen():
                try:
                    for frame in _openai_stream_to_anthropic_sse(r, model):
                        yield frame
                except http_requests.exceptions.RequestException as e:
                    yield (f"event: error\ndata: " +
                           json.dumps({"type": "error", "error": {"type": "api_error", "message": str(e)}}) + "\n\n")
                finally:
                    try: r.close()
                    except Exception: pass
            return Response(stream_with_context(gen()), content_type='text/event-stream',
                            headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'})
        r = _do_post(payload, False)
        if r.status_code >= 400:
            err = (r.text or '')[:800]
            logger.warning("claude-proxy openai upstream %s: %s", r.status_code, err)
            retry = dict(payload)
            err_l = err.lower()
            if any(k in err_l for k in ('tool', 'function', 'schema')):
                retry.pop('tools', None)
                retry.pop('tool_choice', None)
                r2 = _do_post(retry, False)
                if r2.status_code < 400:
                    return jsonify(_openai_json_to_anthropic(r2.json(), model))
                err = (r2.text or '')[:800]
                logger.warning("claude-proxy openai upstream retry %s: %s", r2.status_code, err)
            return jsonify({"type": "error", "error": {"type": "api_error",
                            "message": f"上游 {r.status_code}: {err}"}}), r.status_code
        return jsonify(_openai_json_to_anthropic(r.json(), model))
    except http_requests.exceptions.RequestException as e:
        return jsonify({"type": "error", "error": {"type": "api_error", "message": str(e)}}), 502


@app.route('/claude-proxy/v1/messages/count_tokens', methods=['POST'])
def claude_proxy_count_tokens():
    """Claude Code 偶尔会调用 count_tokens。给一个粗略估算即可。"""
    body = request.get_json(force=True, silent=True) or {}
    try:
        blob = json.dumps(body, ensure_ascii=False)
    except Exception:
        blob = ''
    return jsonify({"input_tokens": max(1, len(blob) // 4)})


# ============================================================
# Claude Code 桥接（无头 stream-json，作为 Web 工作台后端）
#   - 进程: claude -p --input-format stream-json --output-format stream-json
#           --permission-mode bypassPermissions --verbose --add-dir <cwd>
#   - 单进程在 stream-json 输入模式下支持连续多轮，无需每轮 resume
#   - WS 协议(client->server): start / send / interrupt / stop / ping
#   - WS 事件(server->client): started / event(原始 claude 事件) / stderr / exit / error / pong
# ============================================================
def _claude_cli_path():
    import shutil
    # 优先用户级 native 安装（~/.local/bin/claude，更新无需 root，且通常在 PATH 中优先）
    home_bin = os.path.expanduser('~/.local/bin/claude')
    if os.path.isfile(home_bin) and os.access(home_bin, os.X_OK):
        return home_bin
    return shutil.which('claude')


class _ClaudeSession:
    """把一个常驻 claude 无头进程桥接到一个 WebSocket 连接。"""

    def __init__(self, send_json, cwd, model=None, provider=None):
        self.send_json = send_json          # 线程安全地把 dict 发给前端
        self.cwd = cwd
        self.model = model
        self.provider = provider            # {baseUrl, apiKey, model, apiType, name} 或 None
        self.token = None                   # claude-proxy 一次性 token
        self.provider_name = None
        self.proc = None
        self.alive = False
        self._stdin_lock = threading.Lock()

    def start(self):
        cli = _claude_cli_path()
        if not cli:
            self.send_json({"type": "error", "error": "未找到 claude CLI，请先安装 Claude Code"})
            return False
        cwd = self.cwd if (self.cwd and os.path.isdir(self.cwd)) else WORKSPACE_DIR
        self.cwd = cwd
        env = os.environ.copy()
        env.setdefault('CLAUDE_CODE_ENTRYPOINT', 'model-api-mt-web')

        # 用"当前选中 provider"配置 Claude Code：指向本服务的 claude-proxy
        model_arg = self.model
        if self.provider:
            self.token = _register_claude_provider(self.provider)
            if self.token:
                port = os.environ.get('PORT', '8765')
                env['ANTHROPIC_BASE_URL'] = f'http://127.0.0.1:{port}/claude-proxy'
                env['ANTHROPIC_API_KEY'] = self.token
                env['ANTHROPIC_AUTH_TOKEN'] = self.token
                env.pop('ANTHROPIC_DEFAULT_OPUS_MODEL', None)
                self.provider_name = self.provider.get('name') or ''
                model_arg = self.provider.get('model') or self.provider.get('selectedModel') or model_arg

        cmd = [
            cli, '-p', '--verbose',
            '--input-format', 'stream-json',
            '--output-format', 'stream-json',
            '--permission-mode', 'bypassPermissions',
            '--add-dir', cwd,
        ]
        if model_arg:
            cmd += ['--model', model_arg]
        self.model = model_arg
        try:
            self.proc = subprocess.Popen(
                cmd, cwd=cwd,
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                text=True, bufsize=1, env=env,
            )
        except Exception as e:
            self.send_json({"type": "error", "error": f"启动 claude 失败: {e}"})
            return False
        self.alive = True
        threading.Thread(target=self._read_stdout, daemon=True).start()
        threading.Thread(target=self._read_stderr, daemon=True).start()
        self.send_json({
            "type": "started", "cwd": cwd, "model": self.model or None,
            "provider": self.provider_name or None,
            "viaProxy": bool(self.token),
        })
        return True

    def _read_stdout(self):
        try:
            for line in self.proc.stdout:
                line = line.strip()
                if not line:
                    continue
                try:
                    evt = json.loads(line)
                    self.send_json({"type": "event", "event": evt})
                except json.JSONDecodeError:
                    self.send_json({"type": "event", "event": {"type": "raw", "text": line}})
        except Exception:
            pass
        finally:
            code = None
            try:
                code = self.proc.wait(timeout=2)
            except Exception:
                pass
            self.alive = False
            try:
                self.send_json({"type": "exit", "code": code})
            except Exception:
                pass

    def _read_stderr(self):
        try:
            for line in self.proc.stderr:
                if line:
                    self.send_json({"type": "stderr", "data": line.rstrip('\n')})
        except Exception:
            pass

    def send_user(self, text):
        if not (self.proc and self.alive):
            self.send_json({"type": "error", "error": "会话未启动或已结束"})
            return
        msg = {
            "type": "user",
            "message": {"role": "user", "content": [{"type": "text", "text": text}]},
        }
        try:
            with self._stdin_lock:
                self.proc.stdin.write(json.dumps(msg, ensure_ascii=False) + "\n")
                self.proc.stdin.flush()
        except Exception as e:
            self.send_json({"type": "error", "error": f"发送失败: {e}"})

    def interrupt(self):
        # SP1: 以发送 SIGINT 的方式中断当前回合；若失败则终止进程
        if self.proc and self.alive:
            try:
                self.proc.send_signal(signal.SIGINT)
            except Exception:
                self.close()

    def close(self):
        self.alive = False
        if self.token:
            _unregister_claude_provider(self.token)
            self.token = None
        if self.proc:
            try:
                if self.proc.poll() is None:
                    self.proc.terminate()
                    try:
                        self.proc.wait(timeout=3)
                    except Exception:
                        self.proc.kill()
            except Exception:
                pass


class _ClaudePtySession:
    """以交互式 PTY 方式运行 claude（原生 REPL，支持全部 slash 命令）。

    与 `_ClaudeSession`（headless stream-json）并存：这个走真终端，前端用 xterm 双向桥接。
    仍复用 provider 代理注入（ANTHROPIC_BASE_URL/TOKEN + --model），让交互式 claude 也走
    应用里选中的 provider。
    """

    def __init__(self, send_bytes, send_json, cwd, model=None, provider=None, continue_session=False):
        self.send_bytes = send_bytes
        self.send_json = send_json
        self.cwd = cwd
        self.model = model
        self.provider = provider
        self.continue_session = continue_session
        self.token = None
        self.master_fd = None
        self.pid = None
        self.alive = False

    def start(self, cols=120, rows=30):
        cli = _claude_cli_path()
        if not cli:
            self.send_json({"type": "error", "error": "未找到 claude CLI，请先安装 Claude Code"})
            return False
        cwd = self.cwd if (self.cwd and os.path.isdir(self.cwd)) else WORKSPACE_DIR
        self.cwd = cwd
        env = os.environ.copy()
        env.update({
            "TERM": "xterm-256color",
            "COLORTERM": "truecolor",
            "COLUMNS": str(cols),
            "LINES": str(rows),
            "LANG": os.environ.get("LANG", "en_US.UTF-8"),
        })
        env.setdefault('CLAUDE_CODE_ENTRYPOINT', 'model-api-mt-web')

        model_arg = self.model
        if self.provider:
            self.token = _register_claude_provider(self.provider)
            if self.token:
                port = os.environ.get('PORT', '8765')
                env['ANTHROPIC_BASE_URL'] = f'http://127.0.0.1:{port}/claude-proxy'
                env['ANTHROPIC_API_KEY'] = self.token
                env['ANTHROPIC_AUTH_TOKEN'] = self.token
                env.pop('ANTHROPIC_DEFAULT_OPUS_MODEL', None)
                model_arg = self.provider.get('model') or self.provider.get('selectedModel') or model_arg
        self.model = model_arg

        argv = [cli, '--add-dir', cwd]
        if model_arg:
            argv += ['--model', model_arg]
        if self.continue_session:
            # 切换模型时复用最近一次会话，保留当前对话上下文
            argv += ['--continue']

        try:
            self.pid, self.master_fd = pty.fork()
        except Exception as e:
            if self.token:
                _unregister_claude_provider(self.token)
                self.token = None
            self.send_json({"type": "error", "error": f"启动交互式 claude 失败: {e}"})
            return False
        if self.pid == 0:
            try:
                os.chdir(cwd)
            except Exception:
                pass
            try:
                os.execvpe(cli, argv, env)
            except Exception:
                os._exit(127)
        else:
            self.alive = True
            threading.Thread(target=self._read_loop, daemon=True).start()
            self.send_json({
                "type": "started", "cwd": cwd, "model": self.model or None,
                "provider": (self.provider or {}).get('name') if self.token else None,
                "viaProxy": bool(self.token),
            })
            return True

    def _read_loop(self):
        while self.alive and self.master_fd is not None:
            try:
                r, _, _ = select.select([self.master_fd], [], [], 0.05)
                if r:
                    data = os.read(self.master_fd, 8192)
                    if data:
                        self.send_bytes(data)
                    else:
                        break
            except (OSError, TypeError):
                break
        self.alive = False
        try:
            self.send_json({"type": "exit"})
        except Exception:
            pass

    def write(self, data: bytes):
        if self.master_fd and self.alive:
            try:
                os.write(self.master_fd, data)
            except OSError:
                self.alive = False

    def resize(self, cols: int, rows: int):
        if self.master_fd and self.alive:
            try:
                import fcntl
                import termios
                winsize = struct.pack("HHHH", rows, cols, 0, 0)
                fcntl.ioctl(self.master_fd, termios.TIOCSWINSZ, winsize)
                if self.pid:
                    os.kill(self.pid, signal.SIGWINCH)
            except Exception:
                pass

    def close(self):
        self.alive = False
        if self.token:
            _unregister_claude_provider(self.token)
            self.token = None
        if self.pid:
            try:
                os.kill(self.pid, signal.SIGTERM)
            except OSError:
                pass
            self.pid = None
        if self.master_fd is not None:
            try:
                os.close(self.master_fd)
            except OSError:
                pass
            self.master_fd = None


if _PTY_AVAILABLE and _sock is not None:
    @_sock.route('/ws-claude')
    def claude_ws(ws):
        session = None

        def send_json(obj):
            try:
                ws.send(json.dumps(obj, ensure_ascii=False))
            except Exception:
                pass

        try:
            while True:
                msg = ws.receive()
                if msg is None:
                    break
                try:
                    obj = json.loads(msg)
                except (json.JSONDecodeError, TypeError):
                    continue
                mtype = obj.get('type')
                if mtype == 'start':
                    if session:
                        session.close()
                    session = _ClaudeSession(send_json, obj.get('cwd') or WORKSPACE_DIR,
                                             obj.get('model'), obj.get('provider'))
                    session.start()
                elif mtype == 'send':
                    if not session:
                        session = _ClaudeSession(send_json, obj.get('cwd') or WORKSPACE_DIR,
                                                 obj.get('model'), obj.get('provider'))
                        if not session.start():
                            session = None
                            continue
                    session.send_user(obj.get('text') or '')
                elif mtype == 'interrupt':
                    if session:
                        session.interrupt()
                elif mtype == 'stop':
                    if session:
                        session.close()
                        session = None
                elif mtype == 'ping':
                    send_json({"type": "pong"})
        except Exception:
            pass
        finally:
            if session:
                session.close()

    @_sock.route('/ws-claude-term')
    def claude_term_ws(ws):
        """交互式 PTY 版 claude：前端 xterm 双向桥接，原生支持全部 slash 命令。"""
        session = None

        def send_json(obj):
            try:
                ws.send(json.dumps(obj, ensure_ascii=False))
            except Exception:
                pass

        def send_bytes(data):
            try:
                ws.send(data)
            except Exception:
                pass

        try:
            while True:
                msg = ws.receive()
                if msg is None:
                    break
                if isinstance(msg, bytes):
                    if session:
                        session.write(msg)
                    continue
                try:
                    obj = json.loads(msg)
                except (json.JSONDecodeError, TypeError):
                    if session:
                        session.write(msg.encode('utf-8') if isinstance(msg, str) else msg)
                    continue
                t = obj.get('type')
                if t == 'start':
                    if session:
                        session.close()
                    session = _ClaudePtySession(
                        send_bytes, send_json,
                        obj.get('cwd') or WORKSPACE_DIR,
                        obj.get('model'), obj.get('provider'),
                        continue_session=bool(obj.get('continue')),
                    )
                    session.start(int(obj.get('cols', 120)), int(obj.get('rows', 30)))
                elif t == 'input':
                    if session:
                        session.write((obj.get('data') or '').encode('utf-8'))
                elif t == 'resize':
                    if session:
                        session.resize(int(obj.get('cols', 120)), int(obj.get('rows', 30)))
                elif t == 'ping':
                    send_json({"type": "pong"})
        except Exception:
            pass
        finally:
            if session:
                session.close()


@app.route('/api/claude/available', methods=['GET'])
def claude_available():
    """报告 claude CLI 是否可用、版本，以及 WebSocket 是否就绪。"""
    cli = _claude_cli_path()
    version = ''
    if cli:
        try:
            version = subprocess.run(
                [cli, '--version'], capture_output=True, text=True, timeout=5
            ).stdout.strip()
        except Exception:
            version = ''
    return jsonify({
        "available": bool(cli) and _PTY_AVAILABLE and _sock is not None,
        "cli": bool(cli),
        "path": cli or '',
        "version": version,
        "ws": _PTY_AVAILABLE and _sock is not None,
        "default_cwd": WORKSPACE_DIR,
        "repo_dir": BASE_DIR,
    })


# ============================================================
# Hermes Agent 桥接（结构化 chat -q / 交互式 PTY chat --cli）
#   - 复用 claude-proxy 的 provider token 表，经 /hermes-proxy 转发 OpenAI 兼容请求
#   - WS: /ws-hermes（结构化） /ws-hermes-term（PTY）
# ============================================================
def _hermes_cli_path():
    import shutil
    candidates = [
        os.path.expanduser('~/.local/bin/hermes'),
        os.path.join(BASE_DIR, '.venv', 'bin', 'hermes'),
        os.path.expanduser('~/.hermes/hermes-agent/venv/bin/hermes'),
    ]
    for p in candidates:
        if os.path.isfile(p) and os.access(p, os.X_OK):
            return p
    return shutil.which('hermes')


def _hermes_python_path(cli_path=None):
    """Return a Python interpreter that can import the installed Hermes package."""
    candidates = [
        os.path.expanduser('~/.hermes/hermes-agent/venv/bin/python3'),
        os.path.expanduser('~/.hermes/hermes-agent/venv/bin/python'),
    ]
    if cli_path:
        candidates.extend([
            os.path.join(os.path.dirname(cli_path), 'python3'),
            os.path.join(os.path.dirname(cli_path), 'python'),
        ])
    for candidate in candidates:
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return sys.executable


def _hermes_prepare_runtime(provider=None, model=None):
    """为 hermes 子进程准备 HERMES_HOME（config.yaml 指向本地 hermes-proxy）。"""
    import shutil
    model_arg = model
    token = None
    provider_name = None
    hermes_home = None
    extra_env = {}
    via_proxy = False
    if provider and provider.get('baseUrl'):
        token = _register_claude_provider(provider)
        if token:
            port = os.environ.get('PORT', '8765')
            model_arg = provider.get('model') or provider.get('selectedModel') or model_arg
            provider_name = provider.get('name') or ''
            hermes_home = tempfile.mkdtemp(prefix='hermes-mt-')
            base_url = f'http://127.0.0.1:{port}/hermes-proxy/v1'
            cfg = (
                "model:\n"
                f"  default: {model_arg or 'gpt-4o-mini'}\n"
                "  provider: custom\n"
                f"  base_url: {base_url}\n"
                f"  api_key: {token}\n"
            )
            os.makedirs(os.path.join(hermes_home, 'logs'), exist_ok=True)
            with open(os.path.join(hermes_home, 'config.yaml'), 'w', encoding='utf-8') as f:
                f.write(cfg)
            extra_env['HERMES_HOME'] = hermes_home
            via_proxy = True
    return hermes_home, extra_env, model_arg, token, provider_name, via_proxy


def _hermes_cleanup_home(hermes_home):
    if hermes_home and os.path.isdir(hermes_home):
        import shutil
        try:
            shutil.rmtree(hermes_home, ignore_errors=True)
        except Exception:
            pass


def _hermes_parse_skills_output(text):
    skills = []
    for line in (text or '').splitlines():
        line = line.strip()
        if not line or line.startswith('┏') or line.startswith('┡') or line.startswith('└'):
            continue
        if line.startswith('┃') or line.startswith('│'):
            parts = [p.strip() for p in line.strip('┃│ ').split('│') if p.strip()]
            if parts and parts[0] not in ('Name', 'Installed Skills'):
                skills.append(parts[0])
    return skills


@app.route('/hermes-proxy/v1/chat/completions', methods=['POST'])
def hermes_proxy_chat():
    """Hermes custom provider → 侧边栏选中的 OpenAI 兼容上游（透传）。"""
    token, prov = _claude_proxy_resolve()
    if not prov:
        return jsonify({"error": {"message": "未知的 provider token"}}), 401
    body = request.get_json(force=True, silent=True) or {}
    stream = bool(body.get('stream'))
    body['model'] = prov['model'] or body.get('model')
    url = _claude_proxy_openai_url(prov['baseUrl'])
    headers = _openai_headers(prov['baseUrl'], prov['apiKey'], accept=True)
    try:
        if stream:
            r = http_requests.post(url, headers=headers, json=body, stream=True, timeout=600)
            def passthrough():
                try:
                    for chunk in r.iter_content(chunk_size=8192):
                        if chunk:
                            yield chunk
                finally:
                    try:
                        r.close()
                    except Exception:
                        pass
            return Response(
                stream_with_context(passthrough()),
                status=r.status_code,
                content_type=r.headers.get('Content-Type', 'text/event-stream'),
                headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'},
            )
        r = http_requests.post(url, headers=headers, json=body, timeout=600)
        return Response(r.content, status=r.status_code,
                        content_type=r.headers.get('Content-Type', 'application/json'))
    except http_requests.exceptions.RequestException as e:
        return jsonify({"error": {"message": str(e)}}), 502


class _HermesSession:
    """Hermes 结构化会话：最终回答走 quiet stdout，工具过程走 JSONL 事件管道。"""

    def __init__(self, send_json, cwd, model=None, provider=None):
        self.send_json = send_json
        self.cwd = cwd if (cwd and os.path.isdir(cwd)) else WORKSPACE_DIR
        self.model = model
        self.provider = provider
        self.session_id = None
        self.hermes_home = None
        self.token = None
        self.provider_name = None
        self.via_proxy = False
        self.alive = False
        self._lock = threading.Lock()
        self._running = False
        self._proc = None

    def start(self):
        cli = _hermes_cli_path()
        if not cli:
            self.send_json({"type": "error", "error": "未找到 hermes CLI，请先安装 Hermes Agent"})
            return False
        self.close(cleanup_only=True)
        self.hermes_home, _, self.model, self.token, self.provider_name, self.via_proxy = (
            _hermes_prepare_runtime(self.provider, self.model)
        )
        self.alive = True
        self.send_json({
            "type": "started", "cwd": self.cwd, "model": self.model or None,
            "provider": self.provider_name or None, "viaProxy": self.via_proxy,
        })
        return True

    def _run_env(self):
        env = os.environ.copy()
        if self.hermes_home:
            env['HERMES_HOME'] = self.hermes_home
        return env

    def send_user(self, text):
        if not self.alive:
            self.send_json({"type": "error", "error": "会话未启动或已结束"})
            return
        cli = _hermes_cli_path()
        if not cli:
            self.send_json({"type": "error", "error": "未找到 hermes CLI"})
            return
        event_runner = os.path.join(BASE_DIR, 'hermes_event_runner.py')
        cmd = [
            _hermes_python_path(cli), event_runner,
            'chat', '-q', text or '', '-Q',
            '--yolo', '--accept-hooks', '--source', 'tool',
        ]
        if self.via_proxy and self.model:
            cmd += ['-m', self.model, '--provider', 'custom']
        if self.session_id:
            cmd += ['--resume', self.session_id]
        env = self._run_env()
        with self._lock:
            if self._running:
                self.send_json({"type": "error", "error": "上一条消息仍在处理中"})
                return
            self._running = True
        threading.Thread(target=self._run_query, args=(cmd, env), daemon=True).start()

    @staticmethod
    def _progress_phase(tool):
        name = (tool or '').lower()
        if any(part in name for part in ('search', 'browser', 'web', 'ddg', 'wikipedia')):
            return 'search'
        if any(part in name for part in ('terminal', 'shell', 'command', 'python', 'execute')):
            return 'command'
        if any(part in name for part in ('file', 'read', 'write', 'patch', 'edit', 'directory')):
            return 'file'
        return 'tool'

    def _send_progress(self, event):
        event_type = str(event.get('event') or '')
        tool = str(event.get('tool') or '').strip()
        phase = self._progress_phase(tool)
        completed = event_type == 'tool.completed'
        failed = bool(event.get('isError'))
        labels = {
            'search': ('正在搜索', '搜索完成'),
            'command': ('正在执行', '执行完成'),
            'file': ('正在处理文件', '文件处理完成'),
            'tool': ('正在调用工具', '工具调用完成'),
        }
        title = labels[phase][1 if completed else 0]
        if failed:
            title = f'{title}（失败）'
        detail = (
            event.get('result') if completed
            else event.get('preview') or event.get('args')
        )
        payload = {
            'type': 'progress',
            'phase': phase,
            'status': 'error' if failed else ('completed' if completed else 'started'),
            'title': title,
            'tool': tool,
            'detail': str(detail or '').strip()[:1800],
            'urls': event.get('urls') or [],
        }
        if completed:
            payload['duration'] = event.get('duration') or 0
        self.send_json(payload)
        _log_interaction(
            'hermes.progress', phase=phase, status=payload['status'],
            tool=tool, detail=payload['detail'], urls=payload['urls'],
        )

    def _read_final_answer(self, session_id):
        if not session_id or not self.hermes_home:
            return ''
        db_path = os.path.join(self.hermes_home, 'state.db')
        if not os.path.isfile(db_path):
            return ''
        try:
            conn = sqlite3.connect(f'file:{db_path}?mode=ro', uri=True, timeout=5)
            try:
                row = conn.execute(
                    "SELECT content FROM messages "
                    "WHERE session_id = ? AND role = 'assistant' AND active = 1 "
                    "ORDER BY id DESC LIMIT 1",
                    (session_id,),
                ).fetchone()
            finally:
                conn.close()
            content = row[0] if row else ''
            if not isinstance(content, str):
                return str(content or '').strip()
            stripped = content.strip()
            if stripped.startswith('['):
                try:
                    parts = json.loads(stripped)
                    if isinstance(parts, list):
                        texts = [
                            part.get('text', '') for part in parts
                            if isinstance(part, dict) and isinstance(part.get('text'), str)
                        ]
                        if texts:
                            return '\n'.join(texts).strip()
                except (ValueError, TypeError):
                    pass
            return stripped
        except sqlite3.Error as exc:
            logger.warning('读取 Hermes 最终回答失败 session=%s: %s', session_id, exc)
            return ''

    def _run_query(self, cmd, env):
        event_r = event_w = None
        event_thread = None
        try:
            event_r, event_w = os.pipe()
            env = dict(env)
            env['HERMES_EVENT_FD'] = str(event_w)
            proc = subprocess.Popen(
                cmd, cwd=self.cwd, env=env,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                text=True, pass_fds=(event_w,),
            )
            self._proc = proc
            os.close(event_w)
            event_w = None

            def consume_events():
                try:
                    with os.fdopen(event_r, 'r', encoding='utf-8', errors='replace') as stream:
                        for line in stream:
                            try:
                                event = json.loads(line)
                                if isinstance(event, dict):
                                    self._send_progress(event)
                            except (ValueError, TypeError):
                                logger.debug('忽略无法解析的 Hermes 进度事件: %r', line[:300])
                except OSError:
                    pass

            event_thread = threading.Thread(target=consume_events, daemon=True)
            event_thread.start()
            event_r = None

            try:
                out, err = proc.communicate(timeout=900)
            except subprocess.TimeoutExpired:
                proc.kill()
                out, err = proc.communicate()
                err = (err or '') + '\nHermes 响应超时（900 秒）'

            if event_thread:
                event_thread.join(timeout=3)

            sid = self.session_id
            err_lines = []
            for line in (err or '').splitlines():
                stripped = line.strip()
                if stripped.startswith('session_id:'):
                    sid = stripped.split(':', 1)[1].strip() or sid
                elif stripped:
                    err_lines.append(line)
            self.session_id = sid
            answer = self._read_final_answer(sid) or (out or '').strip()
            clean_err = '\n'.join(err_lines).strip()
            if answer:
                self.send_json({'type': 'response', 'text': answer, 'session_id': sid})
                _log_interaction(
                    'hermes.response', session_id=sid, model=self.model,
                    provider=self.provider_name, response=answer,
                )
            if clean_err:
                self.send_json({'type': 'stderr', 'data': clean_err})
            if proc.returncode != 0 and not answer:
                self.send_json({
                    'type': 'error',
                    'error': (clean_err or f'hermes 退出码 {proc.returncode}')[:2000],
                })
        except Exception as e:
            self.send_json({'type': 'error', 'error': str(e)})
            logger.exception('Hermes 结构化会话执行失败')
        finally:
            self._proc = None
            if event_w is not None:
                try:
                    os.close(event_w)
                except OSError:
                    pass
            if event_r is not None:
                try:
                    os.close(event_r)
                except OSError:
                    pass
            with self._lock:
                self._running = False
            self.send_json({'type': 'done'})

    def close(self, cleanup_only=False):
        self.alive = False
        proc = self._proc
        if proc and proc.poll() is None:
            try:
                proc.terminate()
            except Exception:
                pass
        if self.token:
            _unregister_claude_provider(self.token)
            self.token = None
        _hermes_cleanup_home(self.hermes_home)
        self.hermes_home = None
        if not cleanup_only:
            try:
                self.send_json({"type": "exit"})
            except Exception:
                pass


class _HermesPtySession:
    """Hermes 交互式 PTY：hermes chat --cli。"""

    def __init__(self, send_bytes, send_json, cwd, model=None, provider=None, continue_session=False):
        self.send_bytes = send_bytes
        self.send_json = send_json
        self.cwd = cwd
        self.model = model
        self.provider = provider
        self.continue_session = continue_session
        self.hermes_home = None
        self.token = None
        self.master_fd = None
        self.pid = None
        self.alive = False

    def start(self, cols=120, rows=30):
        cli = _hermes_cli_path()
        if not cli:
            self.send_json({"type": "error", "error": "未找到 hermes CLI，请先安装 Hermes Agent"})
            return False
        cwd = self.cwd if (self.cwd and os.path.isdir(self.cwd)) else WORKSPACE_DIR
        self.cwd = cwd
        self.hermes_home, extra_env, model_arg, self.token, provider_name, via_proxy = (
            _hermes_prepare_runtime(self.provider, self.model)
        )
        self.model = model_arg
        env = os.environ.copy()
        env.update({
            "TERM": "xterm-256color",
            "COLORTERM": "truecolor",
            "COLUMNS": str(cols),
            "LINES": str(rows),
            "LANG": os.environ.get("LANG", "en_US.UTF-8"),
        })
        env.update(extra_env)

        argv = [cli, 'chat', '--cli', '--yolo', '--accept-hooks', '--source', 'tool']
        if via_proxy and model_arg:
            argv += ['-m', model_arg, '--provider', 'custom']
        if self.continue_session:
            argv += ['--continue']

        try:
            self.pid, self.master_fd = pty.fork()
        except Exception as e:
            if self.token:
                _unregister_claude_provider(self.token)
                self.token = None
            _hermes_cleanup_home(self.hermes_home)
            self.hermes_home = None
            self.send_json({"type": "error", "error": f"启动交互式 hermes 失败: {e}"})
            return False
        if self.pid == 0:
            try:
                os.chdir(cwd)
            except Exception:
                pass
            try:
                os.execvpe(cli, argv, env)
            except Exception:
                os._exit(127)
        else:
            self.alive = True
            threading.Thread(target=self._read_loop, daemon=True).start()
            self.send_json({
                "type": "started", "cwd": cwd, "model": self.model or None,
                "provider": provider_name or None, "viaProxy": via_proxy,
            })
            return True

    def _read_loop(self):
        while self.alive and self.master_fd is not None:
            try:
                r, _, _ = select.select([self.master_fd], [], [], 0.05)
                if r:
                    data = os.read(self.master_fd, 8192)
                    if data:
                        self.send_bytes(data)
                    else:
                        break
            except (OSError, TypeError):
                break
        self.alive = False
        try:
            self.send_json({"type": "exit"})
        except Exception:
            pass

    def write(self, data: bytes):
        if self.master_fd and self.alive:
            try:
                os.write(self.master_fd, data)
            except OSError:
                self.alive = False

    def resize(self, cols: int, rows: int):
        if self.master_fd and self.alive:
            try:
                import fcntl
                import termios
                winsize = struct.pack("HHHH", rows, cols, 0, 0)
                fcntl.ioctl(self.master_fd, termios.TIOCSWINSZ, winsize)
                if self.pid:
                    os.kill(self.pid, signal.SIGWINCH)
            except Exception:
                pass

    def close(self):
        self.alive = False
        if self.token:
            _unregister_claude_provider(self.token)
            self.token = None
        _hermes_cleanup_home(self.hermes_home)
        self.hermes_home = None
        if self.pid:
            try:
                os.kill(self.pid, signal.SIGTERM)
            except OSError:
                pass
            self.pid = None
        if self.master_fd is not None:
            try:
                os.close(self.master_fd)
            except OSError:
                pass
            self.master_fd = None


if _PTY_AVAILABLE and _sock is not None:
    @_sock.route('/ws-hermes')
    def hermes_ws(ws):
        session = None

        def send_json(obj):
            try:
                ws.send(json.dumps(obj, ensure_ascii=False))
            except Exception:
                pass

        try:
            while True:
                msg = ws.receive()
                if msg is None:
                    break
                try:
                    obj = json.loads(msg)
                except (json.JSONDecodeError, TypeError):
                    continue
                mtype = obj.get('type')
                if mtype == 'start':
                    if session:
                        session.close()
                    session = _HermesSession(
                        send_json, obj.get('cwd') or WORKSPACE_DIR,
                        obj.get('model'), obj.get('provider'),
                    )
                    session.start()
                elif mtype == 'send':
                    if not session:
                        session = _HermesSession(
                            send_json, obj.get('cwd') or WORKSPACE_DIR,
                            obj.get('model'), obj.get('provider'),
                        )
                        if not session.start():
                            session = None
                            continue
                    session.send_user(obj.get('text') or '')
                elif mtype == 'stop':
                    if session:
                        session.close()
                        session = None
                elif mtype == 'ping':
                    send_json({"type": "pong"})
        except Exception:
            pass
        finally:
            if session:
                session.close()

    @_sock.route('/ws-hermes-term')
    def hermes_term_ws(ws):
        session = None

        def send_json(obj):
            try:
                ws.send(json.dumps(obj, ensure_ascii=False))
            except Exception:
                pass

        def send_bytes(data):
            try:
                ws.send(data)
            except Exception:
                pass

        try:
            while True:
                msg = ws.receive()
                if msg is None:
                    break
                if isinstance(msg, bytes):
                    if session:
                        session.write(msg)
                    continue
                try:
                    obj = json.loads(msg)
                except (json.JSONDecodeError, TypeError):
                    if session:
                        session.write(msg.encode('utf-8') if isinstance(msg, str) else msg)
                    continue
                t = obj.get('type')
                if t == 'start':
                    if session:
                        session.close()
                    session = _HermesPtySession(
                        send_bytes, send_json,
                        obj.get('cwd') or WORKSPACE_DIR,
                        obj.get('model'), obj.get('provider'),
                        continue_session=bool(obj.get('continue')),
                    )
                    session.start(int(obj.get('cols', 120)), int(obj.get('rows', 30)))
                elif t == 'input':
                    if session:
                        session.write((obj.get('data') or '').encode('utf-8'))
                elif t == 'resize':
                    if session:
                        session.resize(int(obj.get('cols', 120)), int(obj.get('rows', 30)))
                elif t == 'ping':
                    send_json({"type": "pong"})
        except Exception:
            pass
        finally:
            if session:
                session.close()


@app.route('/api/hermes/available', methods=['GET'])
def hermes_available():
    cli = _hermes_cli_path()
    version = ''
    if cli:
        try:
            version = subprocess.run(
                [cli, '--version'], capture_output=True, text=True, timeout=8,
            ).stdout.strip().split('\n')[0]
        except Exception:
            version = ''
    return jsonify({
        "available": bool(cli) and _PTY_AVAILABLE and _sock is not None,
        "cli": bool(cli),
        "path": cli or '',
        "version": version,
        "ws": _PTY_AVAILABLE and _sock is not None,
        "default_cwd": WORKSPACE_DIR,
        "repo_dir": BASE_DIR,
    })


@app.route('/api/hermes/skills', methods=['GET'])
def hermes_skills_list():
    cli = _hermes_cli_path()
    if not cli:
        return jsonify({"skills": [], "error": "未找到 hermes CLI"}), 200
    try:
        out = subprocess.run(
            [cli, 'skills', 'list', '--enabled-only'],
            capture_output=True, text=True, timeout=45,
        ).stdout
        return jsonify({"skills": _hermes_parse_skills_output(out)})
    except Exception as e:
        return jsonify({"skills": [], "error": str(e)}), 200


_CLAUDE_NPM_PKG = '@anthropic-ai/claude-code'


def _parse_semver(text):
    """从一段文本里抽取第一个 x.y.z 版本号，返回 (major, minor, patch) 元组或 None。"""
    import re
    m = re.search(r'(\d+)\.(\d+)\.(\d+)', text or '')
    if not m:
        return None
    return (int(m.group(1)), int(m.group(2)), int(m.group(3)))


def _claude_current_version():
    cli = _claude_cli_path()
    if not cli:
        return None, None
    try:
        out = subprocess.run([cli, '--version'], capture_output=True, text=True, timeout=8).stdout.strip()
        return out, _parse_semver(out)
    except Exception:
        return None, None


def _claude_latest_version():
    """通过 npm registry 查询 claude-code 最新版本；失败返回 None（不阻塞启动）。"""
    import shutil
    npm = shutil.which('npm')
    if not npm:
        return None, None
    try:
        out = subprocess.run(
            [npm, 'view', _CLAUDE_NPM_PKG, 'version'],
            capture_output=True, text=True, timeout=20,
        ).stdout.strip()
        return out, _parse_semver(out)
    except Exception:
        return None, None


@app.route('/api/claude/version-check', methods=['GET'])
def claude_version_check():
    """检测 claude CLI 当前版本与 npm 上的最新版本，判断是否需要更新。"""
    cli = _claude_cli_path()
    if not cli:
        return jsonify({"cli": False, "error": "未找到 claude CLI"}), 200
    cur_raw, cur = _claude_current_version()
    latest_raw, latest = _claude_latest_version()
    if cur and latest:
        up_to_date = cur >= latest
    else:
        up_to_date = True  # 无法判定时不阻塞启动
    return jsonify({
        "cli": True,
        "current": cur_raw,
        "latest": latest_raw,
        "upToDate": up_to_date,
        "canCheck": bool(latest_raw),
    })


@app.route('/api/claude/update', methods=['POST'])
def claude_update():
    """更新 claude CLI 到最新版本。优先用 `claude update`，失败回退到 npm 全局安装。"""
    cli = _claude_cli_path()
    if not cli:
        return jsonify({"ok": False, "error": "未找到 claude CLI"}), 200

    logs = []
    ok = False
    method = None

    def _run(label, argv, timeout):
        nonlocal ok, method
        try:
            p = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
            logs.append(f'$ {" ".join(argv)}\n' + (p.stdout or '') + (p.stderr or ''))
            if p.returncode == 0:
                ok = True
                method = label
            return p.returncode == 0
        except Exception as e:
            logs.append(f'{label} 失败: {e}')
            return False

    # 1) claude 自带的自更新（全局只读时会失败）
    _run('claude update', [cli, 'update'], 300)

    # 2) 回退：native 用户级安装（装到 ~/.local，不需要 root，成功率最高）
    if not ok:
        _run('claude install latest', [cli, 'install', 'latest'], 600)

    # 3) 再回退：npm 全局安装（通常需要对全局 node_modules 的写权限）
    if not ok:
        import shutil
        npm = shutil.which('npm')
        if npm:
            _run('npm install -g', [npm, 'install', '-g', f'{_CLAUDE_NPM_PKG}@latest'], 600)
        else:
            logs.append('未找到 npm，跳过 npm 安装回退')

    new_raw, _ = _claude_current_version()
    hint = ''
    if not ok:
        hint = ('自动更新失败：当前 claude 可能安装在仅 root 可写的全局目录。'
                '可在终端手动执行 `claude install latest`（用户级安装，无需 root），'
                '或 `sudo npm install -g @anthropic-ai/claude-code@latest`。')
    return jsonify({
        "ok": ok,
        "method": method,
        "version": new_raw,
        "hint": hint,
        "output": '\n'.join(s.strip() for s in logs if s and s.strip())[-4000:],
    })


# ============================================================
# 文件查看：读取本机文件内容（给前端「文件管理器 / 文件 Tab」用）
# ============================================================
_FILE_READ_MAX_BYTES = 2 * 1024 * 1024  # 2MB 以内直接当文本返回

_CODE_EXT_LANG = {
    '.py': 'python', '.js': 'javascript', '.jsx': 'javascript', '.ts': 'typescript',
    '.tsx': 'tsx', '.json': 'json', '.html': 'html', '.htm': 'html', '.css': 'css',
    '.scss': 'scss', '.sh': 'bash', '.bash': 'bash', '.zsh': 'bash', '.yml': 'yaml',
    '.yaml': 'yaml', '.toml': 'toml', '.ini': 'ini', '.cfg': 'ini', '.sql': 'sql',
    '.go': 'go', '.rs': 'rust', '.java': 'java', '.c': 'c', '.h': 'c', '.cpp': 'cpp',
    '.cc': 'cpp', '.hpp': 'cpp', '.rb': 'ruby', '.php': 'php', '.kt': 'kotlin',
    '.swift': 'swift', '.dockerfile': 'dockerfile', '.xml': 'xml', '.vue': 'vue',
    '.svelte': 'svelte', '.dart': 'dart', '.lua': 'lua', '.r': 'r', '.pl': 'perl',
    '.md': 'markdown', '.markdown': 'markdown', '.txt': 'text', '.log': 'text',
    '.env': 'bash', '.gitignore': 'text', '.csv': 'text',
}

_MEDIA_MIME = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
    '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.avif': 'image/avif',
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
    '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
    '.mkv': 'video/x-matroska', '.m4v': 'video/mp4', '.avi': 'video/x-msvideo',
}


def _fs_media_kind(ext: str) -> str:
    """返回 image / audio / video，非媒体文件返回空字符串。"""
    e = (ext or '').lower()
    if e in ('.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico', '.avif'):
        return 'image'
    if e in ('.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac'):
        return 'audio'
    if e in ('.mp4', '.webm', '.mov', '.mkv', '.m4v', '.avi'):
        return 'video'
    return ''


@app.route('/api/local/fs/serve', methods=['GET'])
def local_fs_serve():
    """流式返回本机文件（图片 / 音频 / 视频预览）。"""
    raw = (request.args.get('path') or '').strip()
    if not raw:
        return jsonify({'error': '缺少 path 参数'}), 400
    full = os.path.abspath(os.path.expanduser(raw))
    if not os.path.isfile(full):
        return jsonify({'error': f'文件不存在: {full}', 'path': full}), 404
    ext = os.path.splitext(full)[1].lower()
    mime = _MEDIA_MIME.get(ext)
    if not mime:
        import mimetypes
        mime = mimetypes.guess_type(full)[0] or 'application/octet-stream'
    try:
        return send_file(full, mimetype=mime, conditional=True)
    except PermissionError:
        return jsonify({'error': f'无权读取: {full}', 'path': full}), 403
    except OSError as e:
        return jsonify({'error': str(e), 'path': full}), 400


@app.route('/api/local/fs/read', methods=['GET'])
def local_fs_read():
    """读取本机单个文件，返回文本内容（供前端「文件 Tab」渲染 md / 高亮代码）。
    query:
      path   要读取的文件绝对路径（必填）
    """
    raw = (request.args.get('path') or '').strip()
    if not raw:
        return jsonify({'error': '缺少 path 参数'}), 400
    full = os.path.abspath(os.path.expanduser(raw))
    if not os.path.exists(full):
        return jsonify({'error': f'文件不存在: {full}', 'path': full}), 404
    if os.path.isdir(full):
        return jsonify({'error': f'这是一个目录: {full}', 'path': full}), 400
    try:
        size = os.path.getsize(full)
    except OSError as e:
        return jsonify({'error': str(e), 'path': full}), 400

    name = os.path.basename(full)
    ext = os.path.splitext(name)[1].lower()
    if name.lower() == 'dockerfile':
        ext = '.dockerfile'
    lang = _CODE_EXT_LANG.get(ext, '')
    is_markdown = ext in ('.md', '.markdown')
    media_kind = _fs_media_kind(ext)

    if media_kind:
        return jsonify({
            'path': full, 'name': name, 'ext': ext, 'lang': lang,
            'is_markdown': False, 'size': size, 'binary': False,
            'media_kind': media_kind, 'content': '',
        })

    if size > _FILE_READ_MAX_BYTES:
        return jsonify({
            'path': full, 'name': name, 'ext': ext, 'lang': lang,
            'is_markdown': is_markdown, 'size': size, 'too_large': True,
            'content': '', 'error': f'文件过大（{size} 字节），超过 {_FILE_READ_MAX_BYTES} 字节上限',
        }), 200

    try:
        with open(full, 'rb') as f:
            data = f.read()
    except PermissionError:
        return jsonify({'error': f'无权读取: {full}', 'path': full}), 403
    except OSError as e:
        return jsonify({'error': str(e), 'path': full}), 400

    # 二进制检测：含 NUL 或大量不可解码字节则视为二进制，不返回内容
    if b'\x00' in data[:8000]:
        return jsonify({
            'path': full, 'name': name, 'ext': ext, 'lang': lang,
            'is_markdown': False, 'size': size, 'binary': True, 'content': '',
        }), 200
    try:
        text = data.decode('utf-8')
    except UnicodeDecodeError:
        try:
            text = data.decode('utf-8', errors='replace')
        except Exception:
            return jsonify({
                'path': full, 'name': name, 'ext': ext, 'lang': lang,
                'is_markdown': False, 'size': size, 'binary': True, 'content': '',
            }), 200

    return jsonify({
        'path': full, 'name': name, 'ext': ext, 'lang': lang,
        'is_markdown': is_markdown, 'size': size, 'binary': False,
        'content': text,
    })


# ============================================================
# Claude Code 插件 / Skill 市场（SP5）：搜索 + 一键安装
#   依赖 claude CLI：`claude plugin list --available --json` / `claude plugin install`
# ============================================================
def _run_claude_plugin(args, timeout=120):
    """运行 `claude plugin ...`，返回 (returncode, stdout, stderr)。"""
    cli = _claude_cli_path()
    if not cli:
        return (127, '', 'claude CLI 不可用')
    try:
        p = subprocess.run([cli, 'plugin'] + list(args),
                           capture_output=True, text=True, timeout=timeout)
        return (p.returncode, p.stdout or '', p.stderr or '')
    except subprocess.TimeoutExpired:
        return (124, '', f'命令超时（>{timeout}s）')
    except Exception as e:
        return (1, '', str(e))


@app.route('/api/claude/plugins/catalog', methods=['GET'])
def claude_plugins_catalog():
    """返回已安装插件 + 市场中可用插件（供前端搜索/安装）。
    结构: { installed: [...], available: [{pluginId,name,description,installCount,marketplaceName,source}] }
    """
    code, out, err = _run_claude_plugin(['list', '--available', '--json'], timeout=90)
    if code != 0:
        # 退化：尝试只列已安装（不联网）
        c2, o2, _ = _run_claude_plugin(['list', '--json'], timeout=30)
        if c2 == 0:
            try:
                installed = json.loads(o2)
            except Exception:
                installed = []
            return jsonify({'installed': installed, 'available': [], 'warning': err.strip()[:500]})
        return jsonify({'error': err.strip()[:1000] or '获取插件目录失败', 'installed': [], 'available': []}), 502
    try:
        data = json.loads(out)
    except Exception:
        return jsonify({'error': '解析 claude 输出失败', 'installed': [], 'available': []}), 502
    if isinstance(data, dict):
        return jsonify({
            'installed': data.get('installed', []),
            'available': data.get('available', []),
        })
    # 老版本可能直接返回数组（仅已安装）
    return jsonify({'installed': data if isinstance(data, list) else [], 'available': []})


@app.route('/api/claude/marketplaces', methods=['GET'])
def claude_marketplaces():
    """列出已配置的插件市场。"""
    code, out, err = _run_claude_plugin(['marketplace', 'list', '--json'], timeout=30)
    if code != 0:
        return jsonify({'error': err.strip()[:1000] or '获取市场失败', 'marketplaces': []}), 502
    try:
        return jsonify({'marketplaces': json.loads(out)})
    except Exception:
        return jsonify({'marketplaces': []})


@app.route('/api/claude/marketplaces/add', methods=['POST'])
def claude_marketplace_add():
    """添加一个市场（URL / 本地路径 / GitHub owner/repo）。"""
    body = request.get_json(silent=True) or {}
    source = (body.get('source') or '').strip()
    if not source:
        return jsonify({'error': '缺少 source'}), 400
    code, out, err = _run_claude_plugin(['marketplace', 'add', source], timeout=120)
    if code != 0:
        return jsonify({'error': (err or out).strip()[:1500] or '添加市场失败', 'ok': False}), 502
    return jsonify({'ok': True, 'output': (out or err).strip()[:2000]})


@app.route('/api/claude/plugins/install', methods=['POST'])
def claude_plugin_install():
    """安装一个插件（plugin@marketplace 或 plugin 名）。"""
    body = request.get_json(silent=True) or {}
    name = (body.get('name') or body.get('pluginId') or '').strip()
    scope = (body.get('scope') or 'user').strip()
    if not name:
        return jsonify({'error': '缺少 name/pluginId'}), 400
    if scope not in ('user', 'project', 'local'):
        scope = 'user'
    code, out, err = _run_claude_plugin(['install', name, '--scope', scope], timeout=180)
    if code != 0:
        return jsonify({'error': (err or out).strip()[:1500] or '安装失败', 'ok': False}), 502
    return jsonify({'ok': True, 'output': (out or err).strip()[:2000]})


@app.route('/api/claude/plugins/uninstall', methods=['POST'])
def claude_plugin_uninstall():
    """卸载一个已安装插件。"""
    body = request.get_json(silent=True) or {}
    name = (body.get('name') or body.get('pluginId') or '').strip()
    if not name:
        return jsonify({'error': '缺少 name/pluginId'}), 400
    code, out, err = _run_claude_plugin(['uninstall', name], timeout=120)
    if code != 0:
        return jsonify({'error': (err or out).strip()[:1500] or '卸载失败', 'ok': False}), 502
    return jsonify({'ok': True, 'output': (out or err).strip()[:2000]})


@app.route('/api/claude/plugins/enable', methods=['POST'])
def claude_plugin_enable():
    """启用一个已安装但被禁用的插件（启用后需 reload-plugins 或新会话才生效）。"""
    body = request.get_json(silent=True) or {}
    name = (body.get('name') or body.get('pluginId') or '').strip()
    scope = (body.get('scope') or '').strip()
    if not name:
        return jsonify({'error': '缺少 name/pluginId'}), 400
    args = ['enable', name]
    if scope in ('user', 'project', 'local'):
        args += ['--scope', scope]
    code, out, err = _run_claude_plugin(args, timeout=120)
    if code != 0:
        return jsonify({'error': (err or out).strip()[:1500] or '启用失败', 'ok': False}), 502
    return jsonify({'ok': True, 'output': (out or err).strip()[:2000]})


@app.route('/api/claude/plugins/disable', methods=['POST'])
def claude_plugin_disable():
    """禁用一个已启用的插件。"""
    body = request.get_json(silent=True) or {}
    name = (body.get('name') or body.get('pluginId') or '').strip()
    scope = (body.get('scope') or '').strip()
    if not name:
        return jsonify({'error': '缺少 name/pluginId'}), 400
    args = ['disable', name]
    if scope in ('user', 'project', 'local'):
        args += ['--scope', scope]
    code, out, err = _run_claude_plugin(args, timeout=120)
    if code != 0:
        return jsonify({'error': (err or out).strip()[:1500] or '禁用失败', 'ok': False}), 502
    return jsonify({'ok': True, 'output': (out or err).strip()[:2000]})


# ============================================================
# "Run code" 专用干净执行环境
#   - 不复用用户的交互式登录 shell（zsh 主题/高亮/自动建议会污染输出与输入）
#   - 流程：检测依赖 → 建/装依赖环境(venv) → 执行代码 → 进入干净交互 bash
#   - 退出码通过隐藏的 side 文件回传（不再往输出注入 printf 哨兵）
# ============================================================
RUN_VENV_DIR = os.path.join(WORKSPACE_DIR, '.venv-run')

# import 名 → pip 包名（常见不一致项）
_PY_IMPORT_TO_PKG = {
    'cv2': 'opencv-python', 'PIL': 'Pillow', 'yaml': 'PyYAML', 'bs4': 'beautifulsoup4',
    'sklearn': 'scikit-learn', 'skimage': 'scikit-image', 'Crypto': 'pycryptodome',
    'dotenv': 'python-dotenv', 'serial': 'pyserial', 'OpenSSL': 'pyOpenSSL',
    'dateutil': 'python-dateutil', 'docx': 'python-docx', 'pptx': 'python-pptx',
    'fitz': 'PyMuPDF', 'jwt': 'PyJWT', 'mpl_toolkits': 'matplotlib',
    'win32com': 'pywin32', 'attr': 'attrs', 'OpenGL': 'PyOpenGL',
}

_NODE_BUILTINS = {
    'fs', 'path', 'os', 'http', 'https', 'crypto', 'util', 'stream', 'events',
    'child_process', 'url', 'querystring', 'zlib', 'net', 'tls', 'dns', 'readline',
    'assert', 'buffer', 'process', 'cluster', 'dgram', 'module', 'timers', 'console',
    'v8', 'vm', 'worker_threads', 'perf_hooks', 'string_decoder', 'punycode', 'repl',
}


def _detect_python_deps(code):
    """解析顶层 import，过滤标准库，映射为 pip 包名。返回去重后的列表。"""
    try:
        tree = ast.parse(code)
    except Exception:
        return []
    mods = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for n in node.names:
                if n.name:
                    mods.add(n.name.split('.')[0])
        elif isinstance(node, ast.ImportFrom):
            if (node.level or 0) == 0 and node.module:
                mods.add(node.module.split('.')[0])
    stdlib = getattr(sys, 'stdlib_module_names', set())
    out = []
    for m in sorted(mods):
        if not m or m.startswith('_') or m in stdlib:
            continue
        pkg = _PY_IMPORT_TO_PKG.get(m, m)
        if pkg not in out:
            out.append(pkg)
    return out


def _detect_node_deps(code):
    """解析 require()/import 的包名，过滤内建与相对路径。"""
    found = set()
    for m in re.finditer(r"""require\(\s*['"]([^'"]+)['"]\s*\)""", code):
        found.add(m.group(1))
    for m in re.finditer(r"""\bfrom\s+['"]([^'"]+)['"]""", code):
        found.add(m.group(1))
    for m in re.finditer(r"""\bimport\s+['"]([^'"]+)['"]""", code):
        found.add(m.group(1))
    out = []
    for d in sorted(found):
        if not d or d.startswith('.') or d.startswith('/') or d.startswith('node:'):
            continue
        if d.startswith('@'):
            parts = d.split('/')
            name = '/'.join(parts[:2])
        else:
            name = d.split('/')[0]
        if name in _NODE_BUILTINS:
            continue
        if name not in out:
            out.append(name)
    return out


def _build_run_wrapper(language, code, needs_sudo=False):
    """写出 代码文件 + rc 文件 + 包装脚本，返回 (wrapper_path, exit_file)。
    包装脚本：检测/安装依赖 → 执行代码 → 写退出码到 side 文件 → exec 进干净交互 bash。"""
    ts = int(time.time() * 1000)
    prefix = os.path.join(WORKSPACE_DIR, f'.run_{ts}')
    exit_file = prefix + '.exit'
    rc_file = prefix + '.rc'
    lang = (language or 'bash').lower()
    if lang in ('python', 'py'):
        ext, kind = 'py', 'python'
    elif lang in ('javascript', 'js', 'node'):
        ext, kind = 'js', 'node'
    elif lang in ('c',):
        ext, kind = 'c', 'c'
    elif lang in ('cpp', 'c++', 'cxx'):
        ext, kind = 'cpp', 'cpp'
    elif lang in ('java',):
        ext, kind = 'java', 'java'
    elif lang in ('go',):
        ext, kind = 'go', 'go'
    elif lang in ('rust', 'rs'):
        ext, kind = 'rs', 'rust'
    elif lang in ('ruby', 'rb'):
        ext, kind = 'rb', 'ruby'
    elif lang in ('php',):
        ext, kind = 'php', 'php'
    elif lang in ('html',):
        ext, kind = 'html', 'html'
    else:
        ext, kind = 'sh', 'bash'
    # javac requires the source file name to match a public class. Keep Java
    # sources in a private run directory so the temporary name is invisible
    # to the user while still allowing `public class Main` to compile.
    java_class = 'Main'
    if kind == 'java':
        java_match = re.search(r'\bpublic\s+(?:final\s+|abstract\s+)?class\s+([A-Za-z_]\w*)', code)
        java_class = java_match.group(1) if java_match else 'Main'
        run_dir = prefix
        os.makedirs(run_dir, exist_ok=True)
        code_file = os.path.join(run_dir, java_class + '.java')
    else:
        code_file = prefix + '.' + ext
    with open(code_file, 'w', encoding='utf-8') as f:
        f.write(code)
    # 交互阶段的 rc：干净、固定提示符
    with open(rc_file, 'w', encoding='utf-8') as f:
        f.write("PS1='\\[\\033[1;32m\\]run\\[\\033[0m\\]:\\w\\$ '\n")
        f.write(f"cd {shlex.quote(WORKSPACE_DIR)}\n")

    ws_q = shlex.quote(WORKSPACE_DIR)
    cf_q = shlex.quote(code_file)
    ef_q = shlex.quote(exit_file)
    venv_q = shlex.quote(RUN_VENV_DIR)
    rc_q = shlex.quote(rc_file)

    lines = [
        '#!/usr/bin/env bash',
        'set +e',
        f'cd {ws_q}',
        "G='\\033[1;32m'; Y='\\033[1;33m'; N='\\033[0m'",
    ]
    if kind == 'python':
        deps = _detect_python_deps(code)
        lines += [
            'printf "%b\\n" "${G}==> 准备 Python 依赖环境...${N}"',
            f'if [ ! -x {venv_q}/bin/python ]; then printf "%b\\n" "${{Y}}创建虚拟环境 ({RUN_VENV_DIR}) ...${{N}}"; python3 -m venv {venv_q} || python3 -m venv --system-site-packages {venv_q}; fi',
            f'PYBIN={venv_q}/bin/python',
        ]
        if deps:
            deps_disp = ' '.join(deps)
            deps_q = ' '.join(shlex.quote(d) for d in deps)
            lines += [
                f'printf "%b\\n" "${{G}}==> 检测到依赖: {deps_disp} ，安装中(已安装会自动跳过)...${{N}}"',
                f'"$PYBIN" -m pip install --disable-pip-version-check {deps_q}',
            ]
        else:
            lines += ['printf "%b\\n" "${G}==> 未检测到第三方依赖。${N}"']
        lines += [
            'printf "%b\\n" "${G}==> 执行代码...${N}"',
            f'"$PYBIN" {cf_q}',
            '__rc=$?',
        ]
    elif kind == 'node':
        deps = _detect_node_deps(code)
        lines += ['printf "%b\\n" "${G}==> 准备 Node 依赖...${N}"']
        if deps:
            deps_disp = ' '.join(deps)
            deps_q = ' '.join(shlex.quote(d) for d in deps)
            lines += [
                '[ -f package.json ] || npm init -y >/dev/null 2>&1',
                f'printf "%b\\n" "${{G}}==> 安装依赖: {deps_disp}${{N}}"',
                f'npm install {deps_q}',
            ]
        else:
            lines += ['printf "%b\\n" "${G}==> 未检测到第三方依赖。${N}"']
        lines += [
            'printf "%b\\n" "${G}==> 执行代码...${N}"',
            f'node {cf_q}',
            '__rc=$?',
        ]
    elif kind == 'c':
        binary = prefix + '.bin'
        lines += [
            'printf "%b\\n" "${G}==> 编译 C...${N}"',
            f'gcc -O2 {cf_q} -o {shlex.quote(binary)}',
            '__rc=$?',
            'if [ "$__rc" -eq 0 ]; then',
            '  printf "%b\\n" "${G}==> 执行代码...${N}"',
            f'  {shlex.quote(binary)}',
            '  __rc=$?',
            'fi',
        ]
    elif kind == 'cpp':
        binary = prefix + '.bin'
        lines += [
            'printf "%b\\n" "${G}==> 编译 C++...${N}"',
            f'g++ -std=c++17 -O2 {cf_q} -o {shlex.quote(binary)}',
            '__rc=$?',
            'if [ "$__rc" -eq 0 ]; then',
            '  printf "%b\\n" "${G}==> 执行代码...${N}"',
            f'  {shlex.quote(binary)}',
            '  __rc=$?',
            'fi',
        ]
    elif kind == 'java':
        class_dir = os.path.dirname(code_file)
        lines += [
            'printf "%b\\n" "${G}==> 编译 Java...${N}"',
            f'javac -d {shlex.quote(class_dir)} {cf_q}',
            '__rc=$?',
            'if [ "$__rc" -eq 0 ]; then',
            '  printf "%b\\n" "${G}==> 执行代码...${N}"',
            f'  java -cp {shlex.quote(class_dir)} {shlex.quote(java_class)}',
            '  __rc=$?',
            'fi',
        ]
    elif kind == 'go':
        lines += [
            'printf "%b\\n" "${G}==> 执行 Go...${N}"',
            f'go run {cf_q}',
            '__rc=$?',
        ]
    elif kind == 'rust':
        binary = prefix + '.bin'
        lines += [
            'printf "%b\\n" "${G}==> 编译 Rust...${N}"',
            f'rustc -O {cf_q} -o {shlex.quote(binary)}',
            '__rc=$?',
            'if [ "$__rc" -eq 0 ]; then',
            '  printf "%b\\n" "${G}==> 执行代码...${N}"',
            f'  {shlex.quote(binary)}',
            '  __rc=$?',
            'fi',
        ]
    elif kind == 'ruby':
        lines += [
            'printf "%b\\n" "${G}==> 执行 Ruby...${N}"',
            f'ruby {cf_q}',
            '__rc=$?',
        ]
    elif kind == 'php':
        lines += [
            'printf "%b\\n" "${G}==> 执行 PHP...${N}"',
            f'php {cf_q}',
            '__rc=$?',
        ]
    elif kind == 'html':
        lines += [
            'printf "%b\\n" "${G}==> HTML 文件已保存，可使用预览按钮打开。${N}"',
            '__rc=0',
        ]
    else:  # bash / sh
        lines += [
            'printf "%b\\n" "${G}==> 执行脚本...${N}"',
            f'bash {cf_q}',
            '__rc=$?',
        ]
    lines += [
        f'printf "%s" "$__rc" > {ef_q}',
        'echo',
        'printf "%b\\n" "${G}==> 执行结束 (exit $__rc)，已进入交互终端，可继续输入。${N}"',
        f'exec bash --noprofile --rcfile {rc_q} -i',
    ]
    wrapper = prefix + '.sh'
    with open(wrapper, 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines) + '\n')
    return wrapper, exit_file


class _RunPTYSession:
    """专用于 Run 的 PTY 会话：跑干净包装脚本，PTY 输出走二进制帧，
    退出码通过监视 side 文件后以文本 JSON 帧 {type:'exec_done'} 回传。"""
    def __init__(self, send_bytes, send_text):
        self.send_bytes = send_bytes
        self.send_text = send_text
        self.master_fd = None
        self.pid = None
        self.alive = False
        self.exit_file = None
        self._exit_reported = False

    def start(self, language, code, cols=120, rows=30, needs_sudo=False):
        wrapper, exit_file = _build_run_wrapper(language, code, needs_sudo)
        self.exit_file = exit_file
        env = os.environ.copy()
        env.update({
            "TERM": "xterm-256color",
            "COLORTERM": "truecolor",
            "COLUMNS": str(cols),
            "LINES": str(rows),
            "LANG": os.environ.get("LANG", "en_US.UTF-8"),
            "PIP_DISABLE_PIP_VERSION_CHECK": "1",
        })
        self.pid, self.master_fd = pty.fork()
        if self.pid == 0:
            try:
                os.chdir(WORKSPACE_DIR)
            except Exception:
                pass
            os.execvpe('bash', ['bash', '--noprofile', '--norc', wrapper], env)
        else:
            self.alive = True
            threading.Thread(target=self._read_loop, daemon=True).start()

    def _check_exit_file(self):
        if self._exit_reported or not self.exit_file:
            return
        if not os.path.exists(self.exit_file):
            return
        try:
            with open(self.exit_file, 'r') as f:
                txt = f.read().strip()
        except Exception:
            return
        if txt == '':
            return
        self._exit_reported = True
        try:
            self.send_text(json.dumps({"type": "exec_done", "exit_code": int(txt)}))
        except Exception:
            pass

    def _read_loop(self):
        while self.alive and self.master_fd is not None:
            try:
                r, _, _ = select.select([self.master_fd], [], [], 0.05)
                if r:
                    data = os.read(self.master_fd, 4096)
                    if data:
                        self.send_bytes(data)
            except (OSError, TypeError):
                self.alive = False
                self._check_exit_file()
                try:
                    self.send_bytes(b"\r\n[Session ended]\r\n")
                except Exception:
                    pass
                break
            self._check_exit_file()

    def write(self, data: bytes):
        if self.master_fd and self.alive:
            try:
                os.write(self.master_fd, data)
            except OSError:
                self.alive = False

    def resize(self, cols: int, rows: int):
        if self.master_fd and self.alive:
            try:
                import fcntl
                import termios
                winsize = struct.pack("HHHH", rows, cols, 0, 0)
                fcntl.ioctl(self.master_fd, termios.TIOCSWINSZ, winsize)
                if self.pid:
                    os.kill(self.pid, signal.SIGWINCH)
            except Exception:
                pass

    def close(self):
        self.alive = False
        if self.pid:
            try:
                os.kill(self.pid, signal.SIGTERM)
            except OSError:
                pass
        if self.master_fd is not None:
            try:
                os.close(self.master_fd)
            except OSError:
                pass
            self.master_fd = None


if _PTY_AVAILABLE and _sock is not None:
    @_sock.route('/ws-run')
    def run_code_ws(ws):
        """首帧 {type:'start', language, code, cols?, rows?, needsSudo?}；之后 input/resize/ping。"""
        session = None
        try:
            first = ws.receive()
            if first is None:
                return
            try:
                spec = json.loads(first)
            except (json.JSONDecodeError, TypeError):
                return
            if spec.get('type') != 'start':
                return
            language = spec.get('language') or 'bash'
            code = spec.get('code') or ''
            cols = int(spec.get('cols', 120) or 120)
            rows = int(spec.get('rows', 30) or 30)
            needs_sudo = bool(spec.get('needsSudo'))
            session = _RunPTYSession(lambda b: ws.send(b), lambda s: ws.send(s))
            session.start(language, code, cols=cols, rows=rows, needs_sudo=needs_sudo)
            while True:
                msg = ws.receive()
                if msg is None:
                    break
                if isinstance(msg, bytes):
                    session.write(msg)
                    continue
                try:
                    obj = json.loads(msg)
                    t = obj.get("type")
                    if t == "input":
                        session.write((obj.get("data") or "").encode("utf-8"))
                    elif t == "resize":
                        session.resize(int(obj.get("cols", 80)), int(obj.get("rows", 24)))
                    elif t == "ping":
                        ws.send(json.dumps({"type": "pong"}))
                except (json.JSONDecodeError, TypeError):
                    session.write(msg.encode("utf-8") if isinstance(msg, str) else msg)
        except Exception:
            pass
        finally:
            if session:
                session.close()


# Track terminal working directory per session
terminal_cwd = {'path': WORKSPACE_DIR}
terminal_process = {'proc': None}

# ============================================================
# Persistent State Storage (providers, conversations, settings)
# Split: providers.json, app_meta.json, conversations/<id>.json
# ============================================================
STATE_FILE = os.path.join(DATA_DIR, 'app_state.json')  # legacy, for migration
PROVIDERS_FILE = os.path.join(DATA_DIR, 'providers.json')
META_FILE = os.path.join(DATA_DIR, 'app_meta.json')
CONVERSATIONS_DIR = os.path.join(DATA_DIR, 'conversations')
# Sudo password stored in workspace data (gitignore); used when Run needs sudo
SUDO_PASSWORD_FILE = os.path.join(DATA_DIR, '.sudo_pass')
# Per-model statistics: likes / response time / token usage aggregation
MODEL_STATS_FILE = os.path.join(DATA_DIR, 'model_stats.json')
_model_stats_lock = threading.Lock()
# 通用设置（LLM 参数 + Web 搜索 provider 配置）
SETTINGS_FILE = os.path.join(DATA_DIR, 'settings.json')
_settings_lock = threading.Lock()

os.makedirs(CONVERSATIONS_DIR, exist_ok=True)


def _read_sudo_password():
    """Read stored sudo password from workspace file; return None if not set."""
    if not os.path.exists(SUDO_PASSWORD_FILE):
        return None
    try:
        with open(SUDO_PASSWORD_FILE, 'r', encoding='utf-8') as f:
            return f.read().strip() or None
    except Exception:
        return None


def _save_sudo_password(password):
    """Save sudo password to workspace file for auto-run next time."""
    if not password:
        return
    try:
        with open(SUDO_PASSWORD_FILE, 'w', encoding='utf-8') as f:
            f.write(password.strip())
    except Exception as e:
        logger.warning(f"Could not save sudo password: {e}")

DEFAULT_STATE = {
    "providers": [],
    "conversations": [],
    "activeConversationId": None,
    "activeProviderId": None,
}


def _load_json(path, default=None):
    """Load JSON file; return default if missing or invalid."""
    if default is None:
        default = {}
    if not os.path.exists(path):
        return default
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception as e:
        logger.error(f"Failed to load {path}: {e}")
        return default


def _save_json(path, data):
    """Atomically write JSON file."""
    tmp_path = path + '.tmp'
    with open(tmp_path, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    if os.path.exists(path):
        os.replace(tmp_path, path)
    else:
        os.rename(tmp_path, path)


# ============================================================
# 通用设置：LLM 参数 + Web 搜索 provider 配置
# ============================================================
DEFAULT_SETTINGS = {
    'model_params': {
        'temperature': 0.7,             # 采样温度：越低越确定（0=贪婪），越高越发散
        'top_p': 1.0,                   # 核采样：保留累计概率前 top_p 的 tokens
        'max_tokens': None,             # 单次回复最大 tokens（None=由模型决定）
        'presence_penalty': 0.0,        # 已出现 token 的惩罚（正值促进新话题，-2..2）
        'frequency_penalty': 0.0,       # 高频 token 的惩罚（正值减少重复，-2..2）
        'seed': None,                   # 固定随机种子，便于复现
        'stop': [],                     # 停止序列（命中即截断）
        'system_prompt': '',            # 全局系统提示，自动注入到 messages 头部
    },
    'web_search': {
        'provider': 'duckduckgo',
        'topic': '',                    # 主题关键词（追加到 query 末尾）
        'preferred_sites': [],          # 优先来源域名 ['arxiv.org', 'github.com']
        'max_results': 6,
        'fetch_full_content': True,     # 抓取每个结果的网页正文供 LLM 使用
        'max_content_chars': 4000,      # 单个网页正文最多保留多少字符
        'keys': {                       # 各 provider 的密钥（按 provider 字段名存）
            'tavily': '',
            'serper': '',
            'brave': '',
            'bing': '',
            'google_cse_key': '',
            'google_cse_cx': '',
            'searxng_url': '',
        },
    },
    # 角色 → (providerId, model) 绑定。providerId 必须能在 providers.json 中找到。
    # 启用「自动选模型」后会按意图分类自动挑选对应角色的模型。
    'model_roles': {
        'intent':         {'providerId': '', 'model': ''},
        'chat_basic':     {'providerId': '', 'model': ''},
        'chat_advanced':  {'providerId': '', 'model': ''},
        'image_gen':      {'providerId': '', 'model': ''},
        'vision':         {'providerId': '', 'model': ''},
        'code_simple':    {'providerId': '', 'model': ''},
        'code_advanced':  {'providerId': '', 'model': ''},
        'web_search':     {'providerId': '', 'model': ''},
    },
    # 独立 OpenAI 兼容端点配置（暂只保存，不参与 chat 流程）。
    'model_endpoints': {
        'tts':  {'baseUrl': '', 'apiKey': '', 'model': ''},
        'asr':  {'baseUrl': '', 'apiKey': '', 'model': ''},
        'ocr':  {'baseUrl': '', 'apiKey': '', 'model': ''},
    },
}


def _deep_merge(dst, src):
    """递归合并 src 到 dst（不修改 src）。"""
    if not isinstance(src, dict) or not isinstance(dst, dict):
        return src
    for k, v in src.items():
        if isinstance(v, dict) and isinstance(dst.get(k), dict):
            _deep_merge(dst[k], v)
        else:
            dst[k] = v
    return dst


def _load_settings():
    """读取设置（与默认值合并），保证字段齐全。"""
    out = json.loads(json.dumps(DEFAULT_SETTINGS))  # 深拷贝默认
    cur = _load_json(SETTINGS_FILE, {})
    if isinstance(cur, dict):
        _deep_merge(out, cur)
    return out


def _save_settings(patch):
    """部分更新设置；返回完整最新设置。"""
    with _settings_lock:
        cur = _load_settings()
        if isinstance(patch, dict):
            _deep_merge(cur, patch)
        _save_json(SETTINGS_FILE, cur)
        return cur


@app.route('/api/settings', methods=['GET'])
def api_settings_get():
    return jsonify(_load_settings())


@app.route('/api/settings', methods=['POST'])
def api_settings_set():
    data = request.json or {}
    cur = _save_settings(data)
    return jsonify({'ok': True, 'settings': cur})


@app.route('/api/settings/reset', methods=['POST'])
def api_settings_reset():
    """重置为默认值。"""
    section = (request.json or {}).get('section')
    cur = _load_settings()
    if section in ('model_params', 'web_search', 'model_roles', 'model_endpoints'):
        cur[section] = json.loads(json.dumps(DEFAULT_SETTINGS[section]))
    else:
        cur = json.loads(json.dumps(DEFAULT_SETTINGS))
    _save_json(SETTINGS_FILE, cur)
    return jsonify({'ok': True, 'settings': cur})


def _migrate_legacy_state():
    """If old app_state.json exists and new layout is empty, migrate and remove legacy."""
    if not os.path.exists(STATE_FILE):
        return
    try:
        with open(STATE_FILE, 'r', encoding='utf-8') as f:
            data = json.load(f)
        state = {**DEFAULT_STATE, **data}
        save_state(state)
        try:
            os.remove(STATE_FILE)
            logger.info("Migrated state to providers + conversations layout, removed app_state.json")
        except Exception:
            pass
    except Exception as e:
        logger.error(f"Migration from app_state.json failed: {e}")


def load_state():
    """Load full app state from disk (providers + meta + each conversation file)."""
    _migrate_legacy_state()

    providers = _load_json(PROVIDERS_FILE, [])
    meta = _load_json(META_FILE, {})
    conv_ids = []
    for name in os.listdir(CONVERSATIONS_DIR):
        if name.endswith('.json'):
            conv_ids.append(name[:-5])

    conversations = []
    for cid in conv_ids:
        path = os.path.join(CONVERSATIONS_DIR, cid + '.json')
        c = _load_json(path, None)
        if c and isinstance(c, dict) and c.get('id') == cid:
            conversations.append(c)
        elif c and isinstance(c, dict):
            c['id'] = cid
            conversations.append(c)

    conversations.sort(key=lambda x: x.get('updatedAt', 0), reverse=True)
    return {
        "providers": providers if isinstance(providers, list) else [],
        "conversations": conversations,
        "activeConversationId": meta.get('activeConversationId'),
        "activeProviderId": meta.get('activeProviderId'),
    }


def save_state(state):
    """Save state: providers.json, app_meta.json, one file per conversation."""
    try:
        _save_json(PROVIDERS_FILE, state.get('providers', []))
        _save_json(META_FILE, {
            'activeConversationId': state.get('activeConversationId'),
            'activeProviderId': state.get('activeProviderId'),
        })
        current_ids = {c.get('id') for c in state.get('conversations', []) if c.get('id')}
        for c in state.get('conversations', []):
            cid = c.get('id')
            if not cid:
                continue
            path = os.path.join(CONVERSATIONS_DIR, cid + '.json')
            _save_json(path, c)
        for name in os.listdir(CONVERSATIONS_DIR):
            if name.endswith('.json'):
                cid = name[:-5]
                if cid not in current_ids:
                    try:
                        os.remove(os.path.join(CONVERSATIONS_DIR, name))
                    except Exception as e:
                        logger.warning(f"Could not remove deleted conversation file {name}: {e}")
        return True
    except Exception as e:
        logger.error(f"Failed to save state: {e}")
        return False


# ============================================================
# API Routes - Full State (providers + conversations + settings)
# ============================================================
@app.route('/api/state', methods=['GET'])
def get_state():
    """Load full app state from disk."""
    state = load_state()
    logger.info(f"State loaded: {len(state.get('providers', []))} providers, "
                f"{len(state.get('conversations', []))} conversations")
    return jsonify(state)


@app.route('/api/state', methods=['PUT'])
def put_state():
    """Save full app state to disk."""
    data = request.json
    if not data:
        return jsonify({"error": "No data provided"}), 400

    # Validate structure
    state = {
        "providers": data.get("providers", []),
        "conversations": data.get("conversations", []),
        "activeConversationId": data.get("activeConversationId"),
        "activeProviderId": data.get("activeProviderId"),
    }
    providers = state['providers'] if isinstance(state['providers'], list) else []
    defaults = [p for p in providers if isinstance(p, dict) and p.get('isDefault')]
    if providers and not defaults:
        providers[0]['isDefault'] = True
    elif len(defaults) > 1:
        keep = defaults[0].get('id')
        for p in providers:
            if isinstance(p, dict) and p.get('id') != keep:
                p['isDefault'] = False

    if save_state(state):
        logger.info(f"State saved: {len(state['providers'])} providers, "
                     f"{len(state['conversations'])} conversations")
        return jsonify({"status": "saved", "providers": len(state['providers']),
                        "conversations": len(state['conversations'])})
    else:
        return jsonify({"error": "Failed to save state"}), 500


# ============================================================
# API Routes - Individual Provider Operations
# ============================================================
@app.route('/api/providers', methods=['GET'])
def list_providers():
    """List all providers (full data including API keys)."""
    state = load_state()
    return jsonify(state.get('providers', []))


@app.route('/api/providers', methods=['POST'])
def add_provider():
    """Add a new provider."""
    data = request.json
    if not data or not data.get('name') or not data.get('baseUrl') or not data.get('apiKey'):
        return jsonify({"error": "name, baseUrl, and apiKey are required"}), 400

    state = load_state()
    provider = {
        "id": data.get('id', os.urandom(16).hex()),
        "name": data['name'],
        "baseUrl": data['baseUrl'].rstrip('/'),
        "apiKey": data['apiKey'],
        "apiType": _norm_api_type(data.get('apiType')),
        "isDefault": bool(data.get('isDefault', False)),
        "models": data.get('models', []),
        "selectedModel": data.get('selectedModel', ''),
    }

    # Update if exists, otherwise append
    existing_idx = next((i for i, p in enumerate(state['providers']) if p['id'] == provider['id']), None)
    if existing_idx is not None:
        state['providers'][existing_idx] = provider
    else:
        state['providers'].append(provider)

    if provider['isDefault']:
        for item in state['providers']:
            if item.get('id') != provider['id']:
                item['isDefault'] = False
    elif not any(item.get('isDefault') for item in state['providers']):
        state['providers'][0]['isDefault'] = True

    state['activeProviderId'] = provider['id']
    save_state(state)
    logger.info(f"Provider saved: {provider['name']}")
    return jsonify(provider), 201


@app.route('/api/providers/<provider_id>', methods=['PUT'])
def update_provider(provider_id):
    """Update an existing provider."""
    data = request.json
    if not data:
        return jsonify({"error": "No data provided"}), 400

    state = load_state()
    for i, p in enumerate(state['providers']):
        if p['id'] == provider_id:
            state['providers'][i] = {**p, **data, 'id': provider_id}
            save_state(state)
            logger.info(f"Provider updated: {state['providers'][i]['name']}")
            return jsonify(state['providers'][i])

    return jsonify({"error": "Provider not found"}), 404


@app.route('/api/providers/<provider_id>', methods=['DELETE'])
def delete_provider(provider_id):
    """Delete a provider."""
    state = load_state()
    state['providers'] = [p for p in state['providers'] if p['id'] != provider_id]
    if state.get('activeProviderId') == provider_id:
        state['activeProviderId'] = state['providers'][0]['id'] if state['providers'] else None
    save_state(state)
    logger.info(f"Provider deleted: {provider_id}")
    return jsonify({"status": "deleted"})


# ============================================================
# API Routes - Individual Conversation Operations
# ============================================================
@app.route('/api/conversations', methods=['GET'])
def list_conversations():
    """List all conversations."""
    state = load_state()
    return jsonify(state.get('conversations', []))


@app.route('/api/conversations', methods=['POST'])
def add_conversation():
    """Create a new conversation."""
    data = request.json
    if not data:
        return jsonify({"error": "No data provided"}), 400

    state = load_state()
    conv = {
        "id": data.get('id', os.urandom(16).hex()),
        "title": data.get('title', 'New Chat'),
        "messages": data.get('messages', []),
        "providerId": data.get('providerId', ''),
        "model": data.get('model', ''),
        "createdAt": data.get('createdAt', 0),
        "updatedAt": data.get('updatedAt', 0),
    }
    state['conversations'].insert(0, conv)
    state['activeConversationId'] = conv['id']
    save_state(state)
    logger.info(f"Conversation created: {conv['title']}")
    return jsonify(conv), 201


@app.route('/api/conversations/<conv_id>', methods=['PUT'])
def update_conversation(conv_id):
    """Update a conversation (messages, title, etc.)."""
    data = request.json
    if not data:
        return jsonify({"error": "No data provided"}), 400

    state = load_state()
    for i, c in enumerate(state['conversations']):
        if c['id'] == conv_id:
            state['conversations'][i] = {**c, **data, 'id': conv_id}
            save_state(state)
            return jsonify(state['conversations'][i])

    return jsonify({"error": "Conversation not found"}), 404


@app.route('/api/conversations/<conv_id>', methods=['DELETE'])
def delete_conversation(conv_id):
    """Delete a conversation."""
    state = load_state()
    state['conversations'] = [c for c in state['conversations'] if c['id'] != conv_id]
    if state.get('activeConversationId') == conv_id:
        state['activeConversationId'] = None
    save_state(state)
    logger.info(f"Conversation deleted: {conv_id}")
    return jsonify({"status": "deleted"})


# ============================================================
# API Routes - Model Discovery
# ============================================================
_LOCAL_HOST_RE = re.compile(r'^https?://(127\.0\.0\.1|localhost|0\.0\.0\.0|\[?::1\]?|192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)')


def _is_local_baseurl(base_url):
    return bool(_LOCAL_HOST_RE.match(base_url or ''))


# ============================================================
# Anthropic (Claude Messages API) 适配
#   把 Anthropic /v1/messages 的请求/响应翻译成 OpenAI 兼容格式，
#   让前端（统一按 OpenAI SSE 解析）无需改动即可对接 Claude 原生接口。
# ============================================================
ANTHROPIC_VERSION = '2023-06-01'


def _norm_api_type(api_type):
    return 'anthropic' if str(api_type or '').lower() == 'anthropic' else 'openai'


def _openai_endpoint(base_url, path):
    """Build an OpenAI-compatible endpoint from a configured base URL.

    Most compatible providers accept ``{base}/{path}``, while QuickRouter's
    public API lives below ``/v1`` even when the provider is configured with
    its bare API origin. Also accept users configuring either ``.../v1`` or
    the complete endpoint, without appending the path twice.
    """
    b = (base_url or '').rstrip('/')
    clean_path = str(path or '').strip('/')
    if not clean_path:
        return b
    if b.endswith(f'/{clean_path}'):
        return b
    if b.endswith('/v1'):
        return f"{b}/{clean_path}"

    try:
        parsed = urlparse(b)
        host = (parsed.hostname or '').lower()
        configured_path = (parsed.path or '').rstrip('/')
    except Exception:
        host = ''
        configured_path = ''
    if host == 'api.quickrouter.ai' and not configured_path:
        return f"{b}/v1/{clean_path}"
    return f"{b}/{clean_path}"


def _api_key_value(api_key):
    """Return the configured key without imposing a provider-specific format.

    API keys are opaque values.  In particular, MiMo deployments may issue
    credentials whose prefix is not one of the examples in their docs, so the
    server must never validate or rewrite the prefix supplied by the user.
    """
    return str(api_key or '').strip()


def _is_xiaomi_mimo_baseurl(base_url):
    """MiMo's OpenAI-compatible gateway authenticates with ``api-key``."""
    try:
        host = (urlparse(str(base_url or '')).hostname or '').lower().rstrip('.')
    except Exception:
        return False
    return host == 'xiaomimimo.com' or host.endswith('.xiaomimimo.com')


def _openai_headers(base_url, api_key, *, accept=False):
    """Build provider headers, including Xiaomi MiMo's non-standard auth name."""
    headers = {'Content-Type': 'application/json'}
    if accept:
        headers['Accept'] = 'application/json'
    key = _api_key_value(api_key)
    if key:
        if _is_xiaomi_mimo_baseurl(base_url):
            headers['api-key'] = key
        else:
            headers['Authorization'] = f'Bearer {key}'
    return headers


def _anthropic_endpoint(base_url, path):
    """根据配置的 baseUrl 推导 Anthropic 端点。
    兼容末尾带或不带 /v1，也接受用户直接填写完整的 /messages 端点。"""
    b = (base_url or '').rstrip('/')
    clean_path = str(path or '').strip('/')
    if b.endswith(f'/{clean_path}'):
        return b
    if b.endswith('/v1'):
        b = b[:-3].rstrip('/')
    return f"{b}/v1/{clean_path}"


def _anthropic_headers(api_key, base_url=''):
    h = {'Content-Type': 'application/json', 'anthropic-version': ANTHROPIC_VERSION}
    key = _api_key_value(api_key)
    if key:
        # MiMo documents ``api-key`` for both its OpenAI and Anthropic
        # compatible gateways; native Anthropic keeps using ``x-api-key``.
        h['api-key' if _is_xiaomi_mimo_baseurl(base_url) else 'x-api-key'] = key
    return h


def _flatten_text(content):
    """把 OpenAI content（字符串或多模态数组）压成纯文本（用于 system / 兜底）。"""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        out = []
        for p in content:
            if isinstance(p, dict) and p.get('type') == 'text':
                out.append(p.get('text', ''))
        return '\n'.join(out)
    return str(content or '')


def _openai_content_to_anthropic(content):
    """OpenAI 消息 content → Anthropic content blocks（支持文本与 image_url）。"""
    if content is None:
        return ''
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        blocks = []
        for part in content:
            if not isinstance(part, dict):
                blocks.append({'type': 'text', 'text': str(part)})
                continue
            ptype = part.get('type')
            if ptype == 'text':
                blocks.append({'type': 'text', 'text': part.get('text', '')})
            elif ptype == 'image_url':
                iu = part.get('image_url')
                url = iu.get('url', '') if isinstance(iu, dict) else (iu if isinstance(iu, str) else '')
                if url.startswith('data:'):
                    try:
                        meta, b64 = url.split(',', 1)
                        media_type = meta.split(';')[0].split(':', 1)[1]
                    except Exception:
                        media_type, b64 = 'image/png', ''
                    blocks.append({'type': 'image', 'source': {'type': 'base64', 'media_type': media_type, 'data': b64}})
                elif url:
                    blocks.append({'type': 'image', 'source': {'type': 'url', 'url': url}})
        return blocks or ''
    return str(content)


def _build_anthropic_payload(model, messages, *, stream, max_tokens, temperature=None, top_p=None, stop=None):
    """把 OpenAI 风格请求体翻译成 Anthropic /v1/messages 请求体。"""
    system_parts = []
    conv = []
    for m in messages or []:
        role = m.get('role')
        if role == 'system':
            t = _flatten_text(m.get('content'))
            if t:
                system_parts.append(t)
            continue
        if role not in ('user', 'assistant'):
            role = 'user'
        conv.append({'role': role, 'content': _openai_content_to_anthropic(m.get('content'))})

    payload = {
        'model': model,
        'messages': conv,
        'stream': bool(stream),
        # Anthropic 必填 max_tokens
        'max_tokens': int(max_tokens) if max_tokens else 4096,
    }
    sys_text = '\n\n'.join(system_parts)
    if sys_text:
        payload['system'] = sys_text
    if temperature is not None:
        try: payload['temperature'] = float(temperature)
        except Exception: pass
    if top_p is not None:
        try: payload['top_p'] = float(top_p)
        except Exception: pass
    if stop:
        if isinstance(stop, list):
            seqs = [str(x) for x in stop if str(x).strip()]
        elif isinstance(stop, str) and stop.strip():
            seqs = [stop.strip()]
        else:
            seqs = []
        if seqs:
            payload['stop_sequences'] = seqs[:4]
    return payload


def _anthropic_stream_to_openai(resp, model):
    """把 Anthropic SSE 流翻译成 OpenAI 兼容 SSE 流（生成器，逐帧 yield）。"""
    created = int(time.time())
    cid = f"chatcmpl-{created}"
    prompt_tokens = 0
    completion_tokens = 0

    def _chunk(delta=None, finish_reason=None):
        d = {
            'id': cid, 'object': 'chat.completion.chunk', 'created': created, 'model': model,
            'choices': [{'index': 0, 'delta': delta or {}, 'finish_reason': finish_reason}],
        }
        return f"data: {json.dumps(d)}\n\n"

    yield _chunk(delta={'role': 'assistant'})
    for raw in resp.iter_lines():
        if not raw:
            continue
        line = raw.decode('utf-8', 'ignore')
        if not line.startswith('data:'):
            continue
        data_str = line[5:].strip()
        if not data_str:
            continue
        try:
            evt = json.loads(data_str)
        except Exception:
            continue
        etype = evt.get('type')
        if etype == 'message_start':
            u = (evt.get('message') or {}).get('usage') or {}
            prompt_tokens = u.get('input_tokens', 0) or 0
        elif etype == 'content_block_delta':
            delta = evt.get('delta') or {}
            if delta.get('type') == 'text_delta':
                yield _chunk(delta={'content': delta.get('text', '')})
        elif etype == 'message_delta':
            u = evt.get('usage') or {}
            if 'output_tokens' in u:
                completion_tokens = u.get('output_tokens', 0) or 0
        elif etype == 'error':
            err = evt.get('error') or {}
            yield f"data: {json.dumps({'error': err.get('message') or str(err)})}\n\n"
            return
        elif etype == 'message_stop':
            break
    yield _chunk(finish_reason='stop')
    total = (prompt_tokens or 0) + (completion_tokens or 0)
    usage_frame = {
        'id': cid, 'object': 'chat.completion.chunk', 'created': created, 'model': model,
        'choices': [],
        'usage': {'prompt_tokens': prompt_tokens, 'completion_tokens': completion_tokens, 'total_tokens': total},
    }
    yield f"data: {json.dumps(usage_frame)}\n\n"
    yield "data: [DONE]\n\n"


def _anthropic_json_to_openai(adata, model):
    """把 Anthropic 非流式响应翻译成 OpenAI chat.completion 结构。"""
    text = ''
    for blk in adata.get('content') or []:
        if isinstance(blk, dict) and blk.get('type') == 'text':
            text += blk.get('text', '')
    u = adata.get('usage') or {}
    pt = u.get('input_tokens', 0) or 0
    ct = u.get('output_tokens', 0) or 0
    return {
        'id': adata.get('id') or f"chatcmpl-{int(time.time())}",
        'object': 'chat.completion',
        'created': int(time.time()),
        'model': model,
        'choices': [{
            'index': 0,
            'message': {'role': 'assistant', 'content': text},
            'finish_reason': adata.get('stop_reason') or 'stop',
        }],
        'usage': {'prompt_tokens': pt, 'completion_tokens': ct, 'total_tokens': pt + ct},
    }


@app.route('/api/models', methods=['POST'])
def fetch_models():
    data = request.json
    base_url = data.get('baseUrl', '').rstrip('/')
    api_key = data.get('apiKey', '')
    api_type = _norm_api_type(data.get('apiType'))
    if not base_url:
        return jsonify({"error": "baseUrl is required"}), 400
    # 本地 LLM 服务（llama-server / ollama / lm-studio 等）通常不强制要求 API Key，允许留空
    if not api_key and not _is_local_baseurl(base_url):
        return jsonify({"error": "apiKey is required for non-local providers"}), 400
    try:
        if api_type == 'anthropic':
            url = _anthropic_endpoint(base_url, 'models')
            headers = _anthropic_headers(api_key, base_url)
        else:
            url = _openai_endpoint(base_url, 'models')
            headers = _openai_headers(base_url, api_key)
        resp = http_requests.get(url, headers=headers, timeout=30)
        if resp.status_code == 401 and _is_xiaomi_mimo_baseurl(base_url):
            return jsonify({
                "error": "小米 MiMo 鉴权失败：API Key 未被服务端接受，请确认 API Key、Base URL/区域和账号权限后重试。"
            }), 401
        resp.raise_for_status()
        result = resp.json()
        models = sorted([m['id'] for m in result.get('data', [])])
        logger.info(f"Fetched {len(models)} models from {base_url}")
        return jsonify({"models": models})
    except http_requests.exceptions.RequestException as e:
        logger.error(f"Failed to fetch models: {e}")
        return jsonify({"error": str(e)}), 500


# ============================================================
# API Routes - Web Search (for 联网搜索 / latest info)
# ============================================================
try:
    from ddgs import DDGS
    _DDGS_AVAILABLE = True
except ImportError:
    try:
        # 兼容已安装的旧包；新环境统一安装 ddgs。
        from duckduckgo_search import DDGS
        _DDGS_AVAILABLE = True
    except ImportError:
        _DDGS_AVAILABLE = False


# ---------------- 网页正文抓取 ----------------
def _fetch_page_text(url, timeout=8, max_chars=4000):
    """抓取网页并提取主要正文。返回 {url, title, text, error?}。"""
    out = {'url': url, 'title': '', 'text': ''}
    if not url:
        out['error'] = 'empty url'
        return out
    try:
        headers = {
            'User-Agent': 'Mozilla/5.0 (compatible; model-api-mt/1.0; +https://github.com/) AppleWebKit/537.36',
            'Accept': 'text/html,application/xhtml+xml',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        }
        r = http_requests.get(url, headers=headers, timeout=timeout, allow_redirects=True)
        if r.status_code != 200:
            out['error'] = f'HTTP {r.status_code}'
            return out
        # 简单内容类型检查：非 html 跳过
        ctype = (r.headers.get('Content-Type') or '').lower()
        if ctype and 'html' not in ctype and 'xml' not in ctype:
            out['error'] = f'not html: {ctype}'
            return out
        html = r.text or ''
        # 1) 优先 trafilatura（提取效果最好）
        try:
            import trafilatura  # type: ignore
            text = trafilatura.extract(html, include_comments=False, include_tables=True) or ''
            title = ''
            try:
                meta = trafilatura.extract_metadata(html)
                if meta:
                    title = (getattr(meta, 'title', '') or '') or ''
            except Exception:
                pass
            if text or title:
                out['title'] = (title or '').strip()
                out['text'] = text.strip()[:max_chars]
                return out
        except ImportError:
            pass
        # 2) 回退到 BeautifulSoup
        try:
            from bs4 import BeautifulSoup  # type: ignore
            soup = BeautifulSoup(html, 'html.parser')
            for s in soup(['script', 'style', 'nav', 'footer', 'aside', 'noscript']):
                s.decompose()
            title = (soup.title.get_text() if soup.title else '').strip()
            text = soup.get_text('\n', strip=True)
            text = re.sub(r'\n{3,}', '\n\n', text)
            out['title'] = title
            out['text'] = text[:max_chars]
            return out
        except ImportError:
            pass
        # 3) 最后回退：粗暴去标签
        text = re.sub(r'(?is)<(script|style)[^>]*>.*?</\1>', ' ', html)
        text = re.sub(r'<[^>]+>', ' ', text)
        text = re.sub(r'\s+', ' ', text).strip()
        m = re.search(r'(?is)<title[^>]*>(.*?)</title>', html)
        out['title'] = (m.group(1).strip() if m else '')[:200]
        out['text'] = text[:max_chars]
        return out
    except Exception as e:
        out['error'] = str(e)
        return out


@app.route('/api/fetch-page', methods=['POST'])
def api_fetch_page():
    """抓取并提取网页正文。Body: {url, max_chars?, timeout?}"""
    data = request.json or {}
    url = (data.get('url') or '').strip()
    if not url:
        return jsonify({'error': 'url is required'}), 400
    max_chars = int(data.get('max_chars') or 6000)
    timeout = int(data.get('timeout') or 10)
    return jsonify(_fetch_page_text(url, timeout=timeout, max_chars=max_chars))


def _csp_frame_ancestors(csp_header: str):
    """从 CSP 头解析 frame-ancestors 指令的 token 列表；无该指令则返回 None。"""
    if not csp_header:
        return None
    for part in csp_header.split(';'):
        part = part.strip()
        if not part:
            continue
        low = part.lower()
        if low.startswith('frame-ancestors'):
            rest = part.split(None, 1)
            if len(rest) < 2:
                return []
            return rest[1].split()
    return None


def _frame_ancestors_allows(tokens, embedder_origin: str, target_origin: str) -> bool:
    if tokens is None:
        return True  # 无 frame-ancestors 时不据此拒绝（仍可能被 XFO 拦）
    if not tokens or any(t.lower() == "'none'" for t in tokens):
        return False
    if any(t == '*' for t in tokens):
        return True
    embedder = (embedder_origin or '').rstrip('/')
    target = (target_origin or '').rstrip('/')
    for t in tokens:
        tl = t.lower()
        if tl == "'self'" and embedder and target and embedder == target:
            return True
        if t.startswith('http://') or t.startswith('https://'):
            if embedder == t.rstrip('/') or embedder.startswith(t.rstrip('/') + '/'):
                return True
            # 允许 scheme://host 形式匹配
            try:
                from urllib.parse import urlparse
                et = urlparse(embedder)
                pt = urlparse(t)
                if pt.scheme and pt.netloc and et.scheme == pt.scheme and et.netloc == pt.netloc:
                    return True
            except Exception:
                pass
    return False


def _check_url_frameable(url: str, embedder_origin: str = ''):
    """探测目标页是否允许被 iframe 嵌入。返回 {frameable, reason, final_url}。"""
    out = {'frameable': True, 'reason': '', 'final_url': url}
    if not url or not re.match(r'^https?://', url, re.I):
        out['frameable'] = False
        out['reason'] = 'invalid url'
        return out
    headers = {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0',
        'Accept': 'text/html,application/xhtml+xml',
    }
    resp = None
    try:
        try:
            resp = http_requests.head(url, headers=headers, timeout=8, allow_redirects=True)
            # 部分站点对 HEAD 返回 405/403，改 GET
            if resp.status_code in (403, 405, 501) or not resp.headers:
                resp.close()
                resp = None
        except Exception:
            resp = None
        if resp is None:
            resp = http_requests.get(url, headers=headers, timeout=8, allow_redirects=True, stream=True)
        out['final_url'] = str(resp.url or url)
        rh = {k.lower(): v for k, v in resp.headers.items()}
        xfo = (rh.get('x-frame-options') or '').strip()
        if xfo:
            xu = xfo.upper()
            if 'DENY' in xu:
                out['frameable'] = False
                out['reason'] = f'X-Frame-Options: {xfo}'
                return out
            if 'SAMEORIGIN' in xu:
                out['frameable'] = False
                out['reason'] = f'X-Frame-Options: {xfo}'
                return out
        csp = rh.get('content-security-policy') or ''
        tokens = _csp_frame_ancestors(csp)
        if tokens is not None:
            from urllib.parse import urlparse
            target_origin = ''
            try:
                p = urlparse(out['final_url'])
                target_origin = f'{p.scheme}://{p.netloc}'
            except Exception:
                pass
            if not _frame_ancestors_allows(tokens, embedder_origin, target_origin):
                out['frameable'] = False
                out['reason'] = f"CSP frame-ancestors: {' '.join(tokens)}"
                return out
        return out
    except Exception as e:
        # 探测失败时保守：仍尝试嵌入，由前端处理空白页
        out['reason'] = f'check failed: {e}'
        return out
    finally:
        try:
            if resp is not None:
                resp.close()
        except Exception:
            pass


@app.route('/api/web/frame-check', methods=['GET'])
def api_web_frame_check():
    """检查 URL 是否允许被本应用 iframe 嵌入。?url=https://..."""
    url = (request.args.get('url') or '').strip()
    if not url:
        return jsonify({'error': 'url is required'}), 400
    if not re.match(r'^https?://', url, re.I):
        url = 'https://' + url
    embedder = (request.headers.get('Origin') or '').strip()
    if not embedder:
        embedder = (request.host_url or '').rstrip('/')
    result = _check_url_frameable(url, embedder_origin=embedder)
    return jsonify(result)


# ---------------- 多 provider Web 搜索 ----------------
_WS_PROVIDER_INFO = [
    {'id': 'duckduckgo', 'name': 'DuckDuckGo', 'requires_key': False,
     'website': 'https://duckduckgo.com', 'note': '免费，无需 API key（pip install ddgs）'},
    {'id': 'tavily', 'name': 'Tavily', 'requires_key': True, 'key_field': 'tavily',
     'website': 'https://tavily.com', 'note': '为 LLM 优化；1000 次/月免费'},
    {'id': 'serper', 'name': 'Serper (Google)', 'requires_key': True, 'key_field': 'serper',
     'website': 'https://serper.dev', 'note': '注册即送 2500 次免费'},
    {'id': 'brave', 'name': 'Brave Search', 'requires_key': True, 'key_field': 'brave',
     'website': 'https://brave.com/search/api/', 'note': '2000 次/月免费'},
    {'id': 'bing', 'name': 'Bing Search v7', 'requires_key': True, 'key_field': 'bing',
     'website': 'https://portal.azure.com', 'note': 'Azure F0 免费 1000 次/月'},
    {'id': 'google_cse', 'name': 'Google Custom Search', 'requires_key': True,
     'key_fields': ['google_cse_key', 'google_cse_cx'],
     'website': 'https://programmablesearchengine.google.com',
     'note': '需 key + 搜索引擎 ID（cx）；100 次/天免费'},
    {'id': 'searxng', 'name': 'SearXNG（自部署）', 'requires_key': True, 'key_field': 'searxng_url',
     'website': 'https://searxng.org', 'note': '填写实例 URL，例如 https://my-searxng.example.com'},
]


@app.route('/api/web-search/providers', methods=['GET'])
def api_ws_providers():
    out = []
    for it in _WS_PROVIDER_INFO:
        info = dict(it)
        info['available'] = (it['id'] != 'duckduckgo') or _DDGS_AVAILABLE
        out.append(info)
    return jsonify({'providers': out})


def _ws_apply_site_filter(query, preferred_sites):
    sites = [s.strip() for s in (preferred_sites or []) if s and s.strip()]
    if not sites:
        return query
    site_q = ' OR '.join(f'site:{s}' for s in sites[:5])
    return f'{query} ({site_q})'


def _ws_duckduckgo(query, max_results, region=None):
    if not _DDGS_AVAILABLE:
        raise RuntimeError('ddgs 未安装：pip install ddgs')
    # duckduckgo-search 旧版常用 wt-wt 表示“全球”；新版 ddgs 要求
    # country-language（如 cn-zh、us-en）。wt-wt 会错误访问 wt.wikipedia.org。
    ddgs_region = str(region or 'cn-zh').strip().lower()
    if ddgs_region in ('wt-wt', 'wt', 'global', 'auto') or not re.match(r'^[a-z]{2}-[a-z]{2,3}$', ddgs_region):
        ddgs_region = 'cn-zh'
    items = list(DDGS().text(query, max_results=max_results, region=ddgs_region))
    return [{'title': r.get('title', ''), 'url': r.get('href', ''), 'snippet': r.get('body', '')}
            for r in (items or [])]


def _ws_tavily(query, max_results, key, topic=None, preferred_sites=None):
    if not key:
        raise RuntimeError('Tavily 缺少 API key（在「设置 → Web 搜索」里配置）')
    body = {'api_key': key, 'query': query, 'max_results': max_results}
    if topic and topic in ('general', 'news', 'finance'):
        body['topic'] = topic
    if preferred_sites:
        body['include_domains'] = list(preferred_sites)[:8]
    r = http_requests.post('https://api.tavily.com/search', json=body, timeout=20)
    if r.status_code != 200:
        raise RuntimeError(f'Tavily HTTP {r.status_code}: {r.text[:200]}')
    data = r.json() or {}
    return [{'title': it.get('title', ''), 'url': it.get('url', ''), 'snippet': it.get('content', '')}
            for it in (data.get('results') or [])]


def _ws_serper(query, max_results, key):
    if not key:
        raise RuntimeError('Serper 缺少 API key（在「设置 → Web 搜索」里配置）')
    r = http_requests.post('https://google.serper.dev/search',
                           headers={'X-API-KEY': key, 'Content-Type': 'application/json'},
                           json={'q': query, 'num': max_results}, timeout=15)
    if r.status_code != 200:
        raise RuntimeError(f'Serper HTTP {r.status_code}: {r.text[:200]}')
    data = r.json() or {}
    organic = data.get('organic') or []
    return [{'title': it.get('title', ''), 'url': it.get('link', ''), 'snippet': it.get('snippet', '')}
            for it in organic[:max_results]]


def _ws_brave(query, max_results, key):
    if not key:
        raise RuntimeError('Brave 缺少 API key')
    r = http_requests.get('https://api.search.brave.com/res/v1/web/search',
                          headers={'X-Subscription-Token': key, 'Accept': 'application/json'},
                          params={'q': query, 'count': max_results}, timeout=15)
    if r.status_code != 200:
        raise RuntimeError(f'Brave HTTP {r.status_code}: {r.text[:200]}')
    data = r.json() or {}
    items = (data.get('web') or {}).get('results') or []
    return [{'title': it.get('title', ''), 'url': it.get('url', ''), 'snippet': it.get('description', '')}
            for it in items[:max_results]]


def _ws_bing(query, max_results, key):
    if not key:
        raise RuntimeError('Bing 缺少 API key')
    r = http_requests.get('https://api.bing.microsoft.com/v7.0/search',
                          headers={'Ocp-Apim-Subscription-Key': key},
                          params={'q': query, 'count': max_results, 'mkt': 'zh-CN'}, timeout=15)
    if r.status_code != 200:
        raise RuntimeError(f'Bing HTTP {r.status_code}: {r.text[:200]}')
    data = r.json() or {}
    items = (data.get('webPages') or {}).get('value') or []
    return [{'title': it.get('name', ''), 'url': it.get('url', ''), 'snippet': it.get('snippet', '')}
            for it in items[:max_results]]


def _ws_google_cse(query, max_results, key, cx):
    if not key or not cx:
        raise RuntimeError('Google CSE 需要 API key 和 搜索引擎 ID（cx）')
    r = http_requests.get('https://www.googleapis.com/customsearch/v1',
                          params={'key': key, 'cx': cx, 'q': query, 'num': min(10, max_results)},
                          timeout=15)
    if r.status_code != 200:
        raise RuntimeError(f'Google CSE HTTP {r.status_code}: {r.text[:200]}')
    data = r.json() or {}
    items = data.get('items') or []
    return [{'title': it.get('title', ''), 'url': it.get('link', ''), 'snippet': it.get('snippet', '')}
            for it in items[:max_results]]


def _ws_searxng(query, max_results, base_url):
    if not base_url:
        raise RuntimeError('SearXNG 需要实例 URL')
    base = base_url.rstrip('/')
    r = http_requests.get(f'{base}/search', params={'q': query, 'format': 'json'}, timeout=15)
    if r.status_code != 200:
        raise RuntimeError(f'SearXNG HTTP {r.status_code}: {r.text[:200]}')
    data = r.json() or {}
    items = data.get('results') or []
    return [{'title': it.get('title', ''), 'url': it.get('url', ''), 'snippet': it.get('content', '')}
            for it in items[:max_results]]


@app.route('/api/web-search', methods=['POST'])
def web_search():
    """统一搜索 API（支持多 provider + 抓取正文）。
    Body: {
        query, provider?, max_results?, topic?, preferred_sites?,
        fetch_full_content?, max_content_chars?,
        keys?: {...}
    }
    返回 {provider, query, results: [{title, url, link, snippet, content?, fetched_title?}]}
    """
    data = request.json or {}
    query = (data.get('query') or '').strip()
    if not query:
        return jsonify({'error': 'query is required', 'results': []}), 400

    settings = _load_settings()
    cfg = settings.get('web_search') or {}
    provider = (data.get('provider') or cfg.get('provider') or 'duckduckgo').strip().lower()
    max_results = min(15, max(1, int(data.get('max_results') or cfg.get('max_results') or 6)))
    topic = data.get('topic') if data.get('topic') is not None else cfg.get('topic')
    preferred_sites = data.get('preferred_sites') if data.get('preferred_sites') is not None else cfg.get('preferred_sites')
    fetch_full = bool(data.get('fetch_full_content') if data.get('fetch_full_content') is not None else cfg.get('fetch_full_content'))
    max_content_chars = int(data.get('max_content_chars') or cfg.get('max_content_chars') or 4000)
    keys = {**(cfg.get('keys') or {}), **(data.get('keys') or {})}

    final_query = query
    if topic and isinstance(topic, str) and topic.strip():
        final_query = f'{query} {topic.strip()}'

    try:
        if provider == 'duckduckgo':
            results = _ws_duckduckgo(_ws_apply_site_filter(final_query, preferred_sites), max_results)
        elif provider == 'tavily':
            results = _ws_tavily(final_query, max_results, keys.get('tavily', ''),
                                 topic=topic if isinstance(topic, str) else None,
                                 preferred_sites=preferred_sites)
        elif provider == 'serper':
            results = _ws_serper(_ws_apply_site_filter(final_query, preferred_sites), max_results, keys.get('serper', ''))
        elif provider == 'brave':
            results = _ws_brave(_ws_apply_site_filter(final_query, preferred_sites), max_results, keys.get('brave', ''))
        elif provider == 'bing':
            results = _ws_bing(_ws_apply_site_filter(final_query, preferred_sites), max_results, keys.get('bing', ''))
        elif provider == 'google_cse':
            results = _ws_google_cse(_ws_apply_site_filter(final_query, preferred_sites), max_results,
                                     keys.get('google_cse_key', ''), keys.get('google_cse_cx', ''))
        elif provider == 'searxng':
            results = _ws_searxng(_ws_apply_site_filter(final_query, preferred_sites), max_results,
                                  keys.get('searxng_url', ''))
        else:
            return jsonify({'error': f'未知 provider: {provider}', 'results': []}), 400
    except Exception as e:
        logger.warning(f'web-search ({provider}) error: {e}')
        return jsonify({'error': str(e), 'provider': provider, 'results': []}), 502

    # 并发抓取网页正文
    if fetch_full and results:
        try:
            from concurrent.futures import ThreadPoolExecutor, as_completed
            workers = min(6, len(results))
            with ThreadPoolExecutor(max_workers=workers) as ex:
                fut_map = {ex.submit(_fetch_page_text, r.get('url') or '',
                                     8, max_content_chars): r for r in results}
                for fut in as_completed(fut_map, timeout=20):
                    r = fut_map[fut]
                    try:
                        page = fut.result()
                    except Exception as _e:
                        page = {'text': '', 'title': '', 'error': str(_e)}
                    r['content'] = (page or {}).get('text') or ''
                    r['fetched_title'] = (page or {}).get('title') or ''
                    if not r.get('snippet') and r['content']:
                        r['snippet'] = (r['content'][:200] + '…') if len(r['content']) > 200 else r['content']
        except Exception as e:
            logger.warning(f'web-search fetch_full failed: {e}')

    for r in results:
        r['link'] = r.get('url') or r.get('link', '')

    return jsonify({
        'provider': provider,
        'query': final_query,
        'preferred_sites': preferred_sites or [],
        'results': results,
    })


# ============================================================
# API Routes - 讯息检索研究工作流 (research)
# 大模型先给关键词+候选站点 → 复用 /api/web-search 抓正文 → 结构化整理
# ============================================================
def _loose_json(text):
    """宽松解析 JSON：直接 parse，失败则截取首个 {...}。"""
    if not text:
        return None
    try:
        return json.loads(text.strip())
    except Exception:
        m = re.search(r'\{.*\}', text, re.DOTALL)
        if m:
            try:
                return json.loads(m.group(0))
            except Exception:
                return None
    return None


def _resolve_research_llm(data, settings, providers):
    """确定「讯息」工作流使用的 LLM 凭据：body 优先 → web_search 角色 → chat_basic。
    返回 (base_url, api_key, model, api_type)；找不到返回 (None, None, None, None)。"""
    base_url = (data.get('baseUrl') or '').rstrip('/')
    api_key = data.get('apiKey') or ''
    model = data.get('model') or ''
    api_type = _norm_api_type(data.get('apiType') or 'openai')
    if base_url and model:
        return base_url, api_key, model, api_type
    for role in ('web_search', 'chat_advanced', 'chat_basic'):
        t = _resolve_role_target(role, settings, providers)
        if t.get('kind') == 'role':
            p = next((x for x in providers if x.get('id') == t.get('providerId')), None)
            return (
                (t.get('baseUrl') or '').rstrip('/'),
                t.get('apiKey') or '',
                t.get('model') or '',
                _norm_api_type((p or {}).get('apiType') or 'openai'),
            )
    return None, None, None, None


_RESEARCH_PLAN_SYSTEM = (
    "你是一个联网检索规划助手。根据用户的「讯息查询」，生成用于搜索引擎的检索方案。\n"
    "只输出一个合法 JSON 对象，不要任何额外文本：\n"
    '{"keywords": ["核心关键词", ...], "queries": ["可直接用于搜索引擎的检索式", ...], '
    '"sites": ["建议优先检索的权威站点域名，如 reuters.com", ...], "rationale": "≤30字 说明"}\n'
    "要求：queries 2-4 条，覆盖不同角度，可含时间限定词；sites 0-5 个，只填域名不带 http；"
    "若无明显站点倾向，sites 用空数组。输出语言与用户查询一致。"
)

_RESEARCH_SYNTH_SYSTEM = (
    "你是一个讯息整理助手。基于提供的『检索到的网页内容』，针对用户的问题做客观、准确的整理。\n"
    "要求：\n"
    "1. 用 Markdown 输出；默认结构：一句话结论 → 关键要点(分条) → 需要时给出表格/时间线 → 末尾『来源』列表(带序号与链接)。\n"
    "2. 正文中对关键信息用 [n] 标注来源序号，与末尾来源编号一一对应。\n"
    "3. 只使用检索内容中的事实，不要编造；信息不足时明确说明。\n"
    "4. 严格遵循用户给出的『展示格式要求』(如表格 / 时间线 / 纯摘要 / 字数限制)。\n"
)


@app.route('/api/research/plan', methods=['POST'])
def research_plan():
    """讯息工作流第 1 步：大模型给出 关键词 + 检索式 + 候选站点。Body: {query, baseUrl?,apiKey?,model?,apiType?}"""
    data = request.json or {}
    query = (data.get('query') or '').strip()
    if not query:
        return jsonify({'error': 'query is required'}), 400
    settings = _load_settings()
    providers = _load_json(PROVIDERS_FILE, [])
    if not isinstance(providers, list):
        providers = []
    base_url, api_key, model, api_type = _resolve_research_llm(data, settings, providers)
    if not (base_url and model):
        return jsonify({'error': '未配置「讯息(web_search)」或 chat_basic 角色模型'}), 400
    try:
        raw = _llm_chat(base_url, api_key, model, _RESEARCH_PLAN_SYSTEM,
                        f"用户查询：{query}", max_tokens=400, temperature=0.2, api_type=api_type)
    except Exception as e:
        logger.error(f"research/plan LLM error: {e}")
        return jsonify({'error': f'plan LLM error: {e}'}), 502
    parsed = _loose_json(raw) or {}
    queries = [q for q in (parsed.get('queries') or []) if isinstance(q, str) and q.strip()]
    if not queries:
        queries = [query]
    clean_sites = []
    for s in (parsed.get('sites') or []):
        if not isinstance(s, str):
            continue
        s = re.sub(r'^https?://', '', s).strip().strip('/').split('/')[0]
        if s:
            clean_sites.append(s)
    return jsonify({
        'keywords': [k for k in (parsed.get('keywords') or []) if isinstance(k, str)][:8],
        'queries': queries[:5],
        'sites': clean_sites[:5],
        'rationale': parsed.get('rationale') or '',
        'raw': raw,
    })


@app.route('/api/research/synthesize', methods=['POST'])
def research_synthesize():
    """讯息工作流末步：把抓取到的网页内容结构化整理。
    Body: {query, sources:[{title,url,content,snippet}], format?, instruction?, baseUrl?,...}"""
    data = request.json or {}
    query = (data.get('query') or '').strip()
    sources = data.get('sources') or []
    instruction = (data.get('instruction') or '').strip()
    fmt = (data.get('format') or '').strip()
    if not query and not instruction:
        return jsonify({'error': 'query is required'}), 400
    settings = _load_settings()
    providers = _load_json(PROVIDERS_FILE, [])
    if not isinstance(providers, list):
        providers = []
    base_url, api_key, model, api_type = _resolve_research_llm(data, settings, providers)
    if not (base_url and model):
        return jsonify({'error': '未配置「讯息(web_search)」或 chat_basic 角色模型'}), 400

    blocks, used = [], []
    for i, s in enumerate(sources[:8], 1):
        if not isinstance(s, dict):
            continue
        title = (s.get('title') or s.get('fetched_title') or '').strip()
        url = (s.get('url') or s.get('link') or '').strip()
        content = (s.get('content') or s.get('snippet') or '').strip()
        if not (url or content):
            continue
        used.append({'n': i, 'title': title, 'url': url})
        blocks.append(f"[来源{i}] {title}\nURL: {url}\n内容:\n{content[:3500]}")
    src_block = "\n\n".join(blocks) if blocks else "（无有效检索内容，请说明无法获取资料）"

    user_prompt = (
        f"# 用户问题\n{query}\n\n"
        + (f"# 展示格式要求\n{fmt}\n\n" if fmt else "")
        + (f"# 额外指令\n{instruction}\n\n" if instruction else "")
        + f"# 检索到的网页内容\n{src_block}\n"
    )
    try:
        answer = _llm_chat(base_url, api_key, model, _RESEARCH_SYNTH_SYSTEM,
                           user_prompt, max_tokens=2200, temperature=0.3, api_type=api_type)
    except Exception as e:
        logger.error(f"research/synthesize LLM error: {e}")
        return jsonify({'error': f'synthesize LLM error: {e}'}), 502
    return jsonify({'answer': answer, 'sources': used})


# ============================================================
# API Routes - Chat Proxy
# ============================================================
@app.route('/api/chat', methods=['POST'])
def chat_proxy():
    data = request.json
    base_url = data.get('baseUrl', '').rstrip('/')
    api_key = data.get('apiKey', '')
    api_type = _norm_api_type(data.get('apiType'))
    model = data.get('model', '')
    messages = list(data.get('messages', []))
    stream = data.get('stream', True)

    if not base_url or not model or not messages:
        return jsonify({"error": "baseUrl, model, and messages are required"}), 400
    # 本地 LLM 服务（llama-server / ollama / lm-studio 等）不强制要求 apiKey
    if not api_key and not _is_local_baseurl(base_url):
        return jsonify({"error": "apiKey is required for non-local providers"}), 400

    # 通用 LLM 参数：客户端可显式传，否则用 settings 里的默认值
    settings = _load_settings()
    mp = settings.get('model_params') or {}

    def _pick(name, default=None):
        v = data.get(name)
        return v if v is not None else mp.get(name, default)

    temperature = _pick('temperature', 0.7)
    top_p = _pick('top_p')
    max_tokens = _pick('max_tokens')
    presence_penalty = _pick('presence_penalty')
    frequency_penalty = _pick('frequency_penalty')
    seed = _pick('seed')
    stop = _pick('stop')
    system_prompt = (_pick('system_prompt') or '').strip()

    # 注入 system prompt：仅当首条不是 system 时插入（避免覆盖前端已有 system）
    if system_prompt and (not messages or messages[0].get('role') != 'system'):
        messages = [{'role': 'system', 'content': system_prompt}] + messages

    if api_type == 'anthropic':
        # Claude 原生 Messages API：单独构造 URL / 鉴权头 / 请求体
        url = _anthropic_endpoint(base_url, 'messages')
        headers = _anthropic_headers(api_key, base_url)
        payload = _build_anthropic_payload(
            model, messages, stream=stream, max_tokens=max_tokens,
            temperature=temperature, top_p=top_p, stop=stop,
        )
    else:
        url = _openai_endpoint(base_url, 'chat/completions')
        headers = _openai_headers(base_url, api_key)

        payload = {
            'model': model,
            'messages': messages,
            'stream': stream,
        }
        try: payload['temperature'] = float(temperature) if temperature is not None else 0.7
        except Exception: payload['temperature'] = 0.7
        if top_p is not None:
            try: payload['top_p'] = float(top_p)
            except Exception: pass
        if max_tokens:
            try: payload['max_tokens'] = int(max_tokens)
            except Exception: pass
        if presence_penalty is not None:
            try: payload['presence_penalty'] = float(presence_penalty)
            except Exception: pass
        if frequency_penalty is not None:
            try: payload['frequency_penalty'] = float(frequency_penalty)
            except Exception: pass
        if seed is not None and seed != '':
            try: payload['seed'] = int(seed)
            except Exception: pass
        if stop:
            if isinstance(stop, list) and stop:
                payload['stop'] = [str(x) for x in stop if str(x).strip()][:4]
            elif isinstance(stop, str) and stop.strip():
                payload['stop'] = [stop.strip()]
        # DeepSeek V4 等兼容接口支持显式关闭思考。只接受固定枚举，避免任意扩展参数透传。
        thinking = data.get('thinking')
        if isinstance(thinking, dict) and thinking.get('type') in ('enabled', 'disabled'):
            payload['thinking'] = {'type': thinking['type']}
        # 流式模式下请求最后一帧带 usage（OpenAI 兼容；不支持的 provider 会忽略）
        if stream:
            payload['stream_options'] = {'include_usage': True}

    logger.info(f"Chat request: type={api_type}, model={model}, messages={len(messages)}, stream={stream}")
    interaction_id = uuid.uuid4().hex
    started_at = time.monotonic()
    flow = request.path
    _log_interaction(
        'llm.request',
        interaction_id=interaction_id,
        flow=flow,
        api_type=api_type,
        base_url=base_url,
        model=model,
        stream=bool(stream),
        messages=messages,
        body=payload,
    )

    max_retries = 3
    retry_codes = (429, 503)

    def do_request(stream_req=False):
        return http_requests.post(url, json=payload, headers=headers, stream=stream_req, timeout=120)

    try:
        if stream:
            def generate():
                resp = None
                response_parts = []
                stream_error = None
                response_status = None
                try:
                    for attempt in range(max_retries + 1):
                        resp = do_request(stream_req=True)
                        if resp.status_code in retry_codes and attempt < max_retries:
                            delay = 2 ** (attempt + 1)
                            logger.info(f"Chat 429/503, retry {attempt + 1}/{max_retries} after {delay}s")
                            try:
                                resp.close()
                            except Exception:
                                pass
                            time.sleep(delay)
                            continue
                        break
                    response_status = resp.status_code if resp is not None else 0
                    if resp is None or resp.status_code >= 400:
                        err_text = (resp.text[:500] if resp and resp.text else (resp.reason if resp else 'Unknown')) or ''
                        stream_error = f'{response_status} {err_text}'
                        yield f"data: {json.dumps({'error': stream_error})}\n\n"
                        return
                    if api_type == 'anthropic':
                        # 把 Claude SSE 翻译为 OpenAI 兼容 SSE，前端无需区分
                        for frame in _anthropic_stream_to_openai(resp, model):
                            response_parts.append(_sse_content(frame))
                            yield frame
                    else:
                        for line in resp.iter_lines():
                            if line:
                                frame = line.decode('utf-8') + '\n'
                                response_parts.append(_sse_content(frame))
                                yield frame
                except http_requests.exceptions.RequestException as e:
                    stream_error = str(e)
                    yield f"data: {json.dumps({'error': stream_error})}\n\n"
                finally:
                    event = 'llm.error' if stream_error else 'llm.response'
                    _log_interaction(
                        event,
                        interaction_id=interaction_id,
                        flow=flow,
                        model=model,
                        stream=True,
                        status=response_status,
                        elapsed_ms=round((time.monotonic() - started_at) * 1000, 1),
                        response=''.join(response_parts),
                        error=stream_error,
                    )
                    if resp is not None:
                        try:
                            resp.close()
                        except Exception:
                            pass

            return Response(
                stream_with_context(generate()),
                content_type='text/event-stream',
                headers={
                    'Cache-Control': 'no-cache',
                    'X-Accel-Buffering': 'no',
                }
            )
        else:
            for attempt in range(max_retries + 1):
                resp = do_request(stream_req=False)
                if resp.status_code in retry_codes and attempt < max_retries:
                    delay = 2 ** (attempt + 1)
                    logger.info(f"Chat 429/503, retry {attempt + 1}/{max_retries} after {delay}s")
                    time.sleep(delay)
                    continue
                break
            resp.raise_for_status()
            result = (_anthropic_json_to_openai(resp.json(), model)
                      if api_type == 'anthropic' else resp.json())
            _log_interaction(
                'llm.response',
                interaction_id=interaction_id,
                flow=flow,
                model=model,
                status=resp.status_code,
                elapsed_ms=round((time.monotonic() - started_at) * 1000, 1),
                usage=result.get('usage') if isinstance(result, dict) else None,
                response=result,
            )
            return jsonify(result)

    except http_requests.exceptions.RequestException as e:
        logger.error(f"Chat proxy error: {e}")
        _log_interaction(
            'llm.error',
            interaction_id=interaction_id,
            flow=flow,
            model=model,
            elapsed_ms=round((time.monotonic() - started_at) * 1000, 1),
            error=str(e),
        )
        return jsonify({"error": str(e)}), 500


TTS_URL = 'http://8.137.86.157:10001/v1/tts'

@app.route('/api/tts', methods=['POST'])
def tts_proxy():
    data = request.json or {}
    text = (data.get('text') or '').strip()
    if not text:
        return jsonify({"error": "text is required"}), 400
    payload = {'text': text[:5000], 'speed': data.get('speed', 1), 'seed': data.get('seed', 412)}
    try:
        resp = http_requests.post(TTS_URL, json=payload, headers={'Content-Type': 'application/json'}, timeout=30)
        if resp.status_code >= 400:
            return jsonify({"error": resp.text or resp.reason}), resp.status_code
        ct = resp.headers.get('Content-Type', 'audio/mpeg')
        return Response(resp.content, mimetype=ct)
    except http_requests.exceptions.RequestException as e:
        logger.error(f"TTS proxy error: {e}")
        return jsonify({"error": str(e)}), 500


@app.route('/api/test-connection', methods=['POST'])
def test_connection():
    data = request.json or {}
    base_url = (data.get('baseUrl') or '').rstrip('/')
    api_key = data.get('apiKey', '')
    api_type = _norm_api_type(data.get('apiType'))
    model = data.get('model', '').strip()
    if not base_url or not api_key:
        return jsonify({"ok": False, "error": "baseUrl and apiKey are required"}), 400
    if not model:
        return jsonify({"ok": False, "error": "model is required for test"}), 400
    if api_type == 'anthropic':
        url = _anthropic_endpoint(base_url, 'messages')
        headers = _anthropic_headers(api_key, base_url)
        payload = {
            'model': model,
            'messages': [{'role': 'user', 'content': 'Hi'}],
            'stream': False,
            'max_tokens': 5,
        }
    else:
        url = _openai_endpoint(base_url, 'chat/completions')
        headers = _openai_headers(base_url, api_key)
        payload = {
            'model': model,
            'messages': [{'role': 'user', 'content': 'Hi'}],
            'stream': False,
            'max_tokens': 5,
        }
    try:
        resp = http_requests.post(url, json=payload, headers=headers, timeout=15)
        if resp.status_code >= 400:
            err = resp.text[:300] if resp.text else resp.reason
            return jsonify({"ok": False, "error": f"{resp.status_code}: {err}"})
        return jsonify({"ok": True})
    except http_requests.exceptions.RequestException as e:
        return jsonify({"ok": False, "error": str(e)})


# ============================================================
# API Routes - Model Statistics (likes / response time / tokens)
# ============================================================
def _load_model_stats():
    if not os.path.exists(MODEL_STATS_FILE):
        return {}
    try:
        with open(MODEL_STATS_FILE, 'r', encoding='utf-8') as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception as e:
        logger.error(f"Failed to load model_stats: {e}")
        return {}


def _save_model_stats(stats):
    try:
        _save_json(MODEL_STATS_FILE, stats)
        return True
    except Exception as e:
        logger.error(f"Failed to save model_stats: {e}")
        return False


def _model_stats_key(provider_id, model):
    return f"{(provider_id or '').strip()}::{(model or '').strip()}"


def _empty_stat_entry():
    return {
        "likes": 0,
        "samples": 0,
        "totalDurationMs": 0,
        "totalTokens": 0,
        "totalPromptTokens": 0,
        "totalCompletionTokens": 0,
        "lastDurationMs": None,
        "lastTokens": None,
        "lastUpdated": None,
    }


@app.route('/api/model-stats', methods=['GET'])
def list_model_stats():
    """Return all per-model stats (with derived avg metrics)."""
    stats = _load_model_stats()
    out = {}
    for k, v in stats.items():
        if not isinstance(v, dict):
            continue
        e = {**_empty_stat_entry(), **v}
        n = max(1, int(e.get("samples") or 0))
        e["avgDurationMs"] = (e["totalDurationMs"] / n) if e.get("samples") else None
        e["avgTokens"] = (e["totalTokens"] / n) if e.get("samples") else None
        out[k] = e
    return jsonify({"stats": out})


@app.route('/api/model-stats/record', methods=['POST'])
def record_model_stat():
    """Append one chat sample: { providerId, model, durationMs, tokens?, promptTokens?, completionTokens? }."""
    data = request.json or {}
    provider_id = (data.get('providerId') or '').strip()
    model = (data.get('model') or '').strip()
    if not provider_id or not model:
        return jsonify({"error": "providerId and model are required"}), 400
    try:
        duration_ms = int(data.get('durationMs') or 0)
    except (TypeError, ValueError):
        duration_ms = 0
    try:
        tokens = int(data.get('tokens') or 0)
    except (TypeError, ValueError):
        tokens = 0
    try:
        prompt_tokens = int(data.get('promptTokens') or 0)
    except (TypeError, ValueError):
        prompt_tokens = 0
    try:
        completion_tokens = int(data.get('completionTokens') or 0)
    except (TypeError, ValueError):
        completion_tokens = 0

    key = _model_stats_key(provider_id, model)
    with _model_stats_lock:
        stats = _load_model_stats()
        e = {**_empty_stat_entry(), **(stats.get(key) or {})}
        e['samples'] = int(e.get('samples') or 0) + 1
        e['totalDurationMs'] = int(e.get('totalDurationMs') or 0) + duration_ms
        e['totalTokens'] = int(e.get('totalTokens') or 0) + tokens
        e['totalPromptTokens'] = int(e.get('totalPromptTokens') or 0) + prompt_tokens
        e['totalCompletionTokens'] = int(e.get('totalCompletionTokens') or 0) + completion_tokens
        e['lastDurationMs'] = duration_ms
        e['lastTokens'] = tokens
        e['lastUpdated'] = int(time.time() * 1000)
        stats[key] = e
        _save_model_stats(stats)
    return jsonify({"ok": True, "key": key, "stat": stats[key]})


@app.route('/api/model-stats/like', methods=['POST'])
def like_model():
    """Toggle / set like for a model: { providerId, model, liked: bool }. Adjusts likes count by ±1."""
    data = request.json or {}
    provider_id = (data.get('providerId') or '').strip()
    model = (data.get('model') or '').strip()
    if not provider_id or not model:
        return jsonify({"error": "providerId and model are required"}), 400
    liked = bool(data.get('liked'))
    key = _model_stats_key(provider_id, model)
    with _model_stats_lock:
        stats = _load_model_stats()
        e = {**_empty_stat_entry(), **(stats.get(key) or {})}
        e['likes'] = max(0, int(e.get('likes') or 0) + (1 if liked else -1))
        e['lastUpdated'] = int(time.time() * 1000)
        stats[key] = e
        _save_model_stats(stats)
    return jsonify({"ok": True, "key": key, "likes": stats[key]['likes']})


# ============================================================
# API Routes - Agent Workflow (plan → script → fill params → run)
# 流程: 用户需求 → LLM 拆分步骤 → LLM 生成脚本+参数 → 用户填表 → 执行
# ============================================================
def _parse_balanced_json_object(s, start):
    """从 s[start]=='{' 开始用括号配平扫描，正确忽略字符串字面量里的 { / }，
    返回 (parsed_dict, end_index_inclusive) 或 (None, -1)。
    解析时使用 strict=False 允许 string 里出现字面换行/制表符等 LLM 常见输出。"""
    if start < 0 or start >= len(s) or s[start] != '{':
        return None, -1
    depth = 0
    in_str = False
    escape = False
    for i in range(start, len(s)):
        c = s[i]
        if in_str:
            if escape:
                escape = False
            elif c == '\\':
                escape = True
            elif c == '"':
                in_str = False
        else:
            if c == '"':
                in_str = True
            elif c == '{':
                depth += 1
            elif c == '}':
                depth -= 1
                if depth == 0:
                    candidate = s[start:i + 1]
                    try:
                        return json.loads(candidate, strict=False), i
                    except json.JSONDecodeError:
                        return None, -1
    return None, -1


def _extract_json_object(text):
    """Robustly extract a JSON object from LLM output.

    处理常见 LLM 输出形态：
      1) ```json ... ``` / ```...``` 代码块包裹（script 字段里通常含 `}`，
         不能用非贪婪到第一个 `}`，必须括号配平扫描）。
      2) 直接就是裸 JSON。
      3) 文本中嵌入了 JSON 对象（前后可能有解释性文字）。
    同时使用 json.loads(strict=False) 允许字符串字面量内出现裸 \n/\t 等控制字符，
    这是 LLM 在 multi-line script 字段里最常违反的 JSON 规范。
    """
    if not text:
        return None

    # 1) 优先尝试 markdown 代码块里的 JSON。允许任意/无语言标记。
    #    注意：用贪婪匹配 + 括号配平，避免被 script 内 `}` 截断。
    for m in re.finditer(r'```(?:[a-zA-Z0-9_+\-]*)\s*\n?([\s\S]*?)\n?```', text):
        block = m.group(1)
        first = block.find('{')
        if first < 0:
            continue
        parsed, _ = _parse_balanced_json_object(block, first)
        if parsed is not None:
            return parsed

    # 2) 整段文本里搜索第一个能解析成功的平衡 { ... } 对象
    search_from = 0
    while True:
        first = text.find('{', search_from)
        if first < 0:
            break
        parsed, end = _parse_balanced_json_object(text, first)
        if parsed is not None:
            return parsed
        # 当前 `{` 不可解析，跳到下一个 `{` 继续尝试
        search_from = first + 1

    # 3) 兜底：first..last 区域整体尝试
    first = text.find('{')
    last = text.rfind('}')
    if first >= 0 and last > first:
        try:
            return json.loads(text[first:last + 1], strict=False)
        except json.JSONDecodeError:
            pass
    return None


def _extract_script_fallback(text, pref_lang=''):
    """JSON 完全解析失败时，从 LLM 输出的 markdown 代码块中抽取裸脚本兜底。
    优先匹配指定语言；其次按 bash/python 优先级；最后兜底任意围栏。
    返回 {language, script, parameters: []} 或 None。"""
    if not text:
        return None
    candidates = []
    if pref_lang in ('bash', 'sh', 'shell'):
        candidates.append(('bash', r'bash|sh|shell'))
        candidates.append(('python', r'python|py'))
    elif pref_lang in ('python', 'py'):
        candidates.append(('python', r'python|py'))
        candidates.append(('bash', r'bash|sh|shell'))
    else:
        candidates.append(('bash', r'bash|sh|shell'))
        candidates.append(('python', r'python|py'))

    for lang, pat in candidates:
        m = re.search(rf'```\s*(?:{pat})\b[^\n]*\n([\s\S]*?)\n?```', text, re.IGNORECASE)
        if m:
            script = m.group(1).strip()
            if script:
                return {'language': lang, 'script': script, 'parameters': []}
    # 任意 fenced code block
    m = re.search(r'```[a-zA-Z0-9_+\-]*\s*\n([\s\S]*?)\n?```', text)
    if m:
        script = m.group(1).strip()
        if script:
            return {'language': pref_lang if pref_lang in ('bash', 'python') else 'bash',
                    'script': script, 'parameters': []}
    return None


def _salvage_truncated_script_json(text, pref_lang=''):
    """救援被 max_tokens 截断的 LLM JSON 输出（最常见的 agent 失败模式）。

    典型场景: LLM 已经开始输出 {"language":"bash","script":"#!/bin/bash\\n..."
    但脚本太长在中间被截断，整段缺少结尾的 `"` 与 `}`，标准 JSON 解析失败。
    本函数手动定位 `"script"` 字段值起点，按 JSON 字符串转义规则逐字符解码，
    遇到未转义的 `"` 视为正常收尾；遇到文本末尾视为截断收尾（仍返回已生成部分）。
    `parameters` 字段如果存在且能独立解析则一并取出，否则置空。
    返回 {language, script, parameters, truncated: bool} 或 None。"""
    if not text:
        return None
    m = re.search(r'"script"\s*:\s*"', text)
    if not m:
        return None
    start = m.end()
    chars = []
    i = start
    n = len(text)
    truncated = True
    while i < n:
        c = text[i]
        if c == '\\':
            if i + 1 >= n:
                # 截断在转义符上，丢弃尾部反斜杠
                break
            nxt = text[i + 1]
            mapping = {'n': '\n', 't': '\t', 'r': '\r', '"': '"', '\\': '\\', '/': '/', 'b': '\b', 'f': '\f'}
            if nxt in mapping:
                chars.append(mapping[nxt])
                i += 2
                continue
            if nxt == 'u' and i + 6 <= n:
                try:
                    chars.append(chr(int(text[i + 2:i + 6], 16)))
                    i += 6
                    continue
                except ValueError:
                    pass
            # 非标 JSON 转义（如 LLM 把 bash 的 \$ 直接写进来），原样保留 next char
            chars.append(nxt)
            i += 2
            continue
        if c == '"':
            truncated = False
            break
        chars.append(c)
        i += 1
    script = ''.join(chars).rstrip()
    if not script:
        return None

    # 推断 language
    lang = (pref_lang or '').lower()
    if lang not in ('bash', 'python'):
        lm = re.search(r'"language"\s*:\s*"([a-zA-Z]+)"', text)
        if lm:
            raw = lm.group(1).lower()
            lang = 'python' if raw in ('python', 'py') else 'bash'
        else:
            lang = 'bash'

    # 尽量恢复 parameters：从原文里截 parameters 字段那一段试着配平 + 解析
    parameters = []
    pm = re.search(r'"parameters"\s*:\s*\[', text)
    if pm:
        ps = pm.end() - 1  # 指向 '['
        depth = 0
        in_str = False
        escape = False
        end = -1
        for j in range(ps, n):
            ch = text[j]
            if in_str:
                if escape:
                    escape = False
                elif ch == '\\':
                    escape = True
                elif ch == '"':
                    in_str = False
            else:
                if ch == '"':
                    in_str = True
                elif ch == '[':
                    depth += 1
                elif ch == ']':
                    depth -= 1
                    if depth == 0:
                        end = j
                        break
        if end > ps:
            try:
                parsed_params = json.loads(text[ps:end + 1], strict=False)
                if isinstance(parsed_params, list):
                    parameters = parsed_params
            except json.JSONDecodeError:
                pass

    return {
        'language': lang,
        'script': script,
        'parameters': parameters,
        'truncated': truncated,
    }


def _llm_chat_full(base_url, api_key, model, system_prompt, user_prompt, max_tokens=2000, temperature=0.2, extra_messages=None, api_type='openai', request_options=None):
    """单轮非流式 chat completion，返回 (content, finish_reason)，并记录完整交互日志。"""
    messages = [
        {'role': 'system', 'content': system_prompt},
        {'role': 'user', 'content': user_prompt},
    ]
    if extra_messages:
        messages.extend(extra_messages)

    normalized_type = _norm_api_type(api_type)
    interaction_id = uuid.uuid4().hex
    started_at = time.monotonic()
    flow = request.path if has_request_context() else 'internal'
    _log_interaction(
        'llm.request',
        interaction_id=interaction_id,
        flow=flow,
        api_type=normalized_type,
        base_url=base_url,
        model=model,
        stream=False,
        temperature=temperature,
        max_tokens=max_tokens,
        request_options=request_options or {},
        messages=messages,
    )

    try:
        if normalized_type == 'anthropic':
            url = _anthropic_endpoint(base_url, 'messages')
            headers = _anthropic_headers(api_key, base_url)
            payload = _build_anthropic_payload(
                model, messages, stream=False, max_tokens=max_tokens, temperature=temperature,
            )
            resp = http_requests.post(url, json=payload, headers=headers, timeout=180)
            resp.raise_for_status()
            data = _anthropic_json_to_openai(resp.json(), model)
        else:
            url = _openai_endpoint(base_url, 'chat/completions')
            headers = _openai_headers(base_url, api_key)
            payload = {
                'model': model,
                'messages': messages,
                'stream': False,
                'temperature': temperature,
                'max_tokens': max_tokens,
            }
            if request_options:
                reserved = {'model', 'messages', 'stream', 'temperature', 'max_tokens'}
                conflict = reserved.intersection(request_options)
                if conflict:
                    raise ValueError(f"request_options cannot override reserved fields: {sorted(conflict)}")
                payload.update(request_options)
            resp = http_requests.post(url, json=payload, headers=headers, timeout=180)
            resp.raise_for_status()
            data = resp.json()
        choice = (data.get('choices') or [{}])[0]
        content = choice.get('message', {}).get('content', '') or ''
        finish_reason = choice.get('finish_reason') or ''
        _log_interaction(
            'llm.response',
            interaction_id=interaction_id,
            flow=flow,
            model=model,
            status=getattr(resp, 'status_code', 200),
            elapsed_ms=round((time.monotonic() - started_at) * 1000, 1),
            finish_reason=finish_reason,
            usage=data.get('usage'),
            response=content,
        )
        return content, finish_reason
    except Exception as exc:
        _log_interaction(
            'llm.error',
            interaction_id=interaction_id,
            flow=flow,
            model=model,
            elapsed_ms=round((time.monotonic() - started_at) * 1000, 1),
            error=str(exc),
        )
        raise



def _llm_json_chat_full(base_url, api_key, model, system_prompt, user_prompt, max_tokens=2000, temperature=0.2, extra_messages=None, api_type='openai'):
    """生成结构化 JSON；DeepSeek V4 关闭默认思考，避免输出预算被 reasoning 耗尽。

    OpenAI 兼容网关对扩展参数的支持不一致，因此参数被拒绝或返回空正文时会自动降级。
    返回值与 ``_llm_chat_full`` 一致。
    """
    normalized_type = _norm_api_type(api_type)
    model_lower = (model or '').lower()
    is_deepseek_v4 = model_lower.startswith('deepseek-v4')

    if normalized_type == 'anthropic':
        variants = [('plain', None)]
    elif is_deepseek_v4:
        variants = [
            ('nonthinking-json', {
                'thinking': {'type': 'disabled'},
                'response_format': {'type': 'json_object'},
            }),
            ('nonthinking', {'thinking': {'type': 'disabled'}}),
            ('plain', None),
        ]
    else:
        variants = [
            ('json', {'response_format': {'type': 'json_object'}}),
            ('plain', None),
        ]

    last_empty = ('', '')
    last_error = None
    for index, (mode, options) in enumerate(variants):
        try:
            content, finish_reason = _llm_chat_full(
                base_url, api_key, model, system_prompt, user_prompt,
                max_tokens=max_tokens,
                temperature=temperature,
                extra_messages=extra_messages,
                api_type=api_type,
                request_options=options,
            )
        except http_requests.exceptions.RequestException as exc:
            last_error = exc
            if index + 1 < len(variants):
                logger.warning(
                    "structured LLM mode %s rejected for model=%s; retrying with fallback: %s",
                    mode, model, exc,
                )
                continue
            raise

        if content and content.strip():
            return content, finish_reason

        last_empty = (content or '', finish_reason)
        if index + 1 < len(variants):
            logger.warning(
                "structured LLM mode %s returned empty content for model=%s, finish_reason=%r; retrying",
                mode, model, finish_reason,
            )

    if last_error and not any(last_empty):
        raise last_error
    return last_empty

def _llm_chat(base_url, api_key, model, system_prompt, user_prompt, max_tokens=2000, temperature=0.2, api_type='openai'):
    """向后兼容包装：仅返回 content。"""
    content, _ = _llm_chat_full(base_url, api_key, model, system_prompt, user_prompt, max_tokens, temperature, api_type=api_type)
    return content


_AGENT_CONTINUE_SYSTEM = (
    "你之前的脚本输出在中途被截断了。现在请**直接接续**输出剩余的脚本字符，"
    "保证用户把你的输出原样拼到已有脚本末尾后，整段脚本是完整可执行的。\n"
    "硬性约束：\n"
    "1) 绝对不要重复之前已经输出过的任何字符（用户会做原样拼接）；\n"
    "2) 绝对不要使用 markdown 代码围栏（不要 ```...```）；\n"
    "3) 不要任何解释/说明/前缀/JSON；\n"
    "4) 只输出脚本本身的字符，输出完最后一个字符就停止。"
)


def _strip_continuation_artifacts(text):
    """LLM 即便被告知不要 markdown，仍可能输出 ```bash ... ``` 围栏。剥离之。"""
    if not text:
        return text
    s = text.strip()
    m = re.match(r'^```[a-zA-Z0-9_+\-]*\s*\n?([\s\S]*?)\n?```\s*$', s)
    if m:
        return m.group(1)
    # 也剥离常见的前缀客套（"好的，下面继续输出..." 之类，整个首行 ≤80 字符则剥掉）
    s2 = re.sub(r'^\s*(?:好的|当然|继续|续写|继续输出|下面是|下面继续|这是|接下来是|这里是)[^\n]{0,80}\n', '', text, count=1)
    return s2


def _trim_overlap_prefix(prefix, continuation, max_overlap=400, min_overlap=8):
    """若 continuation 的开头与 prefix 的末尾有重叠（LLM 误重复尾巴），剪掉重叠部分。
    从长到短试，找到最长的重叠 k 使 continuation[:k] == prefix[-k:]，返回 continuation[k:]。"""
    if not prefix or not continuation:
        return continuation
    upper = min(max_overlap, len(prefix), len(continuation))
    for k in range(upper, max(min_overlap - 1, 0), -1):
        if continuation[:k] == prefix[-k:]:
            return continuation[k:]
    return continuation


def _continue_truncated_script(base_url, api_key, model, partial_script, language, max_rounds=3):
    """脚本被截断时调用 LLM 接续，最多 max_rounds 轮。返回 (script, finished)。

    finished=True 表示模型本轮 finish_reason != 'length'（自然结束）；
    finished=False 表示用完所有轮次仍被截断 / 续写出错。"""
    script = partial_script or ''
    if not script.strip():
        return script, False
    finished = False
    for round_idx in range(max_rounds):
        tail = script[-1500:]
        user_prompt = (
            f"脚本语言: {language}\n"
            f"以下是当前脚本的最后 ~1500 个字符（你不要重复它，从最后一个字符之后接着写）：\n"
            f"<<<PARTIAL_TAIL>>>\n{tail}\n<<<END_PARTIAL_TAIL>>>\n\n"
            "请直接输出后续脚本字符（不带 markdown、不带解释、不要重复 <<< 中的任何字符）。"
        )
        try:
            cont, finish_reason = _llm_chat_full(
                base_url, api_key, model, _AGENT_CONTINUE_SYSTEM, user_prompt,
                max_tokens=4000, temperature=0.1,
            )
        except http_requests.exceptions.RequestException as e:
            logger.warning(f"_continue_truncated_script round {round_idx + 1} LLM error: {e}")
            break
        cont = _strip_continuation_artifacts(cont)
        if not cont or not cont.strip():
            logger.warning(f"_continue_truncated_script round {round_idx + 1} empty continuation, stopping")
            break
        original_len = len(cont)
        cont = _trim_overlap_prefix(script, cont)
        if not cont:
            logger.warning(f"_continue_truncated_script round {round_idx + 1}: continuation fully overlapped prefix, stopping")
            break
        # 续写连标点都不是只是空白，多半是 LLM 已经认为结束了
        meaningful = cont.strip()
        script += cont
        logger.warning(
            f"_continue_truncated_script round {round_idx + 1}: appended {len(cont)} chars "
            f"(raw={original_len}, finish_reason={finish_reason!r}, total now {len(script)})"
        )
        if finish_reason != 'length':
            finished = True
            break
        if len(meaningful) < 4:
            # 防止无限糊弄
            break
    return script, finished


_AGENT_PLAN_SYSTEM = (
    "你是一个任务规划助手。用户描述要在 Linux/macOS 终端完成的一个任务，"
    "你需要把它拆解为 2 至 8 个简明的执行步骤。"
    "严格只输出 JSON，不要 markdown，不要解释。"
    "格式：{\"steps\":[{\"title\":\"...\",\"description\":\"...\"}, ...]}\n"
    "title 用一句话概括（≤20字），description 解释这一步要做什么及关键命令/工具（一两句话即可）。"
)

_AGENT_PROMPT_SYSTEM = (
    "你是项目需求提示词设计助手。根据用户需求、运行环境和目标编程语言，"
    "生成一段可以直接发送给代码大模型的工程开发提示词。提示词必须明确项目目标、"
    "运行环境、语言、目录结构、入口文件、依赖安装、编译/运行命令、错误处理和验收标准。"
    "只输出 JSON，不要 markdown 或额外说明。格式："
    '{"prompt":"完整提示词","summary":"一句话概括"}'
)

_AGENT_CODE_FIX_SYSTEM = (
    "你是跨语言编译与依赖修复助手。给定一段代码、语言和真实执行错误，"
    "请返回可以直接替换原文件的完整代码。根据需要给出依赖包和安装命令，"
    "不要省略代码，不要输出 markdown 围栏。只输出 JSON："
    '{"code":"完整代码","language":"语言","dependencies":["包名"],'
    '"install_commands":["安装命令"],"summary":"修复说明"}'
)

_AGENT_SCRIPT_SYSTEM = (
    "你是一个脚本生成助手。根据用户的任务和已规划好的步骤，生成一个**单文件、可直接执行**的脚本。"
    "\n"
    "**必须按步骤顺序组织脚本代码，并在每一步开头输出该步骤的描述**，便于运行日志追踪：\n"
    "  - bash: 在每一步代码之前，先 `echo` 一行 `==== [Step <序号>/<总数>] <title>: <description> ====`，"
    "    序号从 1 开始，总数 = 用户给的步骤总数；title/description 直接用用户给的中文/英文，"
    "    必要时合并为单行（去掉换行）。\n"
    "  - python: 用 `print(\"==== [Step ...]\")` 输出同样格式。\n"
    "  - 每一步的代码紧跟在对应 echo/print 之后；不同步骤之间空一行分隔。\n"
    "  - 不要漏掉任何一步，也不要把多个步骤合并到同一个 echo 头下。\n"
    "\n"
    "如果脚本运行需要用户在执行前提供输入（比如目录路径、用户名、是否覆盖、选项等），把它们抽取为参数。"
    "参数在脚本中通过环境变量引用：用 ${PARAM_NAME} 形式（PARAM_NAME 大写下划线）。"
    "尽量在脚本顶部使用 set -euo pipefail（bash）以让错误立即可见。"
    "严格只输出 JSON，不要 markdown，不要解释。\n"
    "格式：{"
    "\"language\":\"bash\"|\"python\","
    "\"script\":\"...\","
    "\"parameters\":[{"
    "\"name\":\"PARAM_NAME\","
    "\"type\":\"text\"|\"password\"|\"number\"|\"boolean\"|\"select\","
    "\"label\":\"用户友好显示名\","
    "\"description\":\"可选说明\","
    "\"default\":\"\","
    "\"required\":true,"
    "\"options\":[\"A\",\"B\"]}]}\n"
    "parameters 可以为空数组。boolean 类型在脚本里取 1/0 字符串。\n"
    "脚本应当输出关键的过程信息（echo/print），便于失败时排查。"
)

_AGENT_FIX_SYSTEM = (
    "你是一个脚本修复助手。给定原脚本（含参数）+ 实际运行的失败输出 + 退出码，"
    "请基于错误原因，输出修复后的完整脚本与（如有变化的）参数定义。"
    "严格只输出 JSON，格式与脚本生成接口完全一致："
    "{\"language\":..., \"script\":..., \"parameters\":[...], \"reason\":\"一句话解释主要修复点\"}"
    "不要 markdown，不要解释。"
)

_AGENT_REFINE_SYSTEM = (
    "你是一个脚本迭代优化助手。给定原任务、当前脚本（含参数）、上一次运行的输出（成功或失败）、以及用户用自然语言描述的"
    "「改进/调整需求」，请生成下一个版本的脚本以满足用户的最新意图（保留原任务核心目标）。"
    "如果用户想要更高效/更稳健/更详细输出/不同输出格式/换工具实现等，都属于这里要处理的诉求。"
    "严格只输出 JSON，格式与脚本生成接口一致："
    "{\"language\":..., \"script\":..., \"parameters\":[...], \"reason\":\"一句话总结本次调整\"}"
    "不要 markdown，不要解释。"
)

_AGENT_REFINE_STEP_SYSTEM = (
    "你是一个任务步骤精修助手。用户给出整体任务、整个步骤计划，以及他想重新生成的「目标步骤」（含其当前的 title 和 description，"
    "也可能包含他的修改提示/反馈）。你的任务是根据他的修改提示重写这一步：保持与整体任务和上下文（前后步骤）的一致性，"
    "不要改变其它步骤；如果用户的修改提示与当前 title/description 冲突，以修改提示为准；如果没有提示，就在原内容基础上做一次"
    "改写/优化（更清晰、更具体、必要时补充关键命令）。"
    "严格只输出 JSON，不要 markdown，不要解释。"
    "格式：{\"title\":\"...\",\"description\":\"...\",\"reason\":\"一句话说明本次改动重点\"}"
    "title ≤ 20 字，description 一两句话，必要时含关键命令/工具。"
)


_STEP_MARKER_RE = re.compile(r'\[\s*Step\s+\d+\s*/\s*\d+\s*\]', re.IGNORECASE)


def _sanitize_step_line(text, max_len=200):
    """把步骤文本压成单行：去换行/制表/多余空白；限长。"""
    if not text:
        return ''
    s = re.sub(r'\s+', ' ', str(text)).strip()
    return s[:max_len]


def _ensure_step_logging(script, language, steps):
    """为脚本注入步骤日志的兜底：

    1) 在脚本头部插入一段"步骤计划"清单 echo/print（不论 LLM 是否做了步骤标记，
       这段计划块都能让用户直观看到整个工作流）；如果脚本已经包含我们注入过的清单标记
       （`AI_WORKFLOW_PLAN_HEADER`），就不重复注入。
    2) 如果 LLM 显然忽略了"在每一步前 echo"的指令（脚本里 Step 标记数 < 步骤数的一半），
       则额外在头部清单上方加一行警示，便于用户感知。

    这个函数**只在脚本顶部追加内容**，不修改 LLM 写的代码主体，避免破坏脚本逻辑。
    """
    if not script or not steps:
        return script
    if 'AI_WORKFLOW_PLAN_HEADER' in script:
        return script

    lang = (language or '').lower()
    n = len(steps)
    plan_lines = []
    for i, s in enumerate(steps, 1):
        if not isinstance(s, dict):
            continue
        title = _sanitize_step_line(s.get('title') or '', 80)
        desc = _sanitize_step_line(s.get('description') or '', 200)
        body = f"[{i}/{n}] {title}" + (f" — {desc}" if desc else '')
        plan_lines.append(body)
    if not plan_lines:
        return script

    found_markers = len(_STEP_MARKER_RE.findall(script))
    weak = found_markers < max(1, (n + 1) // 2)

    if lang == 'python':
        py_lines = [
            "# AI_WORKFLOW_PLAN_HEADER",
            "print('================ AI 工作流脚本 ================')",
            f"print('共 {n} 个步骤:')",
        ]
        for line in plan_lines:
            esc = line.replace("'", "\\'")
            py_lines.append(f"print('  {esc}')")
        if weak:
            py_lines.append(
                "print('⚠  注意: 模型未在每一步前输出 [Step] 日志，请对照上面的步骤计划自行追踪进度。')"
            )
        py_lines.append("print('================================================')")
        header = "\n".join(py_lines) + "\n\n"
        # 尝试把 header 插在 shebang/encoding 行之后，否则插到最前
        m = re.match(r'\A((?:#![^\n]*\n)?(?:#.*coding[:=][^\n]*\n)?)', script)
        head_pos = m.end() if m else 0
        return script[:head_pos] + header + script[head_pos:]

    # bash / sh / shell 默认走 bash
    bash_lines = [
        "# AI_WORKFLOW_PLAN_HEADER",
        "echo '================ AI 工作流脚本 ================'",
        f"echo '共 {n} 个步骤:'",
    ]
    for line in plan_lines:
        safe = line.replace("'", "'\"'\"'")
        bash_lines.append(f"echo '  {safe}'")
    if weak:
        bash_lines.append(
            "echo '⚠  注意: 模型未在每一步前输出 [Step] 日志，请对照上面的步骤计划自行追踪进度。'"
        )
    bash_lines.append("echo '================================================'")
    header = "\n".join(bash_lines) + "\n\n"
    # 插在 shebang 之后；set -euo pipefail 也保留在原位，不动
    m = re.match(r'\A(#![^\n]*\n)', script)
    head_pos = m.end() if m else 0
    return script[:head_pos] + header + script[head_pos:]


def _require_provider(data):
    """校验 LLM provider 信息。本地（127.0.0.1/localhost/私有 IP）不强制 apiKey。"""
    base_url = (data.get('baseUrl') or '').rstrip('/')
    api_key = data.get('apiKey') or ''
    model = data.get('model') or ''
    if not base_url or not model:
        return None, jsonify({"error": "baseUrl and model are required"}), 400
    if not api_key and not _is_local_baseurl(base_url):
        return None, jsonify({"error": "apiKey is required for non-local providers"}), 400
    return (base_url, api_key, model), None, None


@app.route('/api/agent/prompt', methods=['POST'])
def agent_prompt():
    """Turn a short project request into a complete prompt for the current chat."""
    data = request.json or {}
    goal = (data.get('message') or '').strip()
    environment = (data.get('environment') or 'local').strip()
    language = (data.get('language') or 'python').strip().lower()
    if not goal:
        return jsonify({'error': 'message required'}), 400
    triple, err_resp, err_code = _require_provider(data)
    if err_resp is not None:
        return err_resp, err_code
    base_url, api_key, model = triple
    user_prompt = (
        f"用户需求：{goal}\n"
        f"运行环境：{environment}\n"
        f"目标语言：{language}\n\n"
        "请生成一段可直接交给代码生成模型的完整工程提示词。"
        "必须要求输出完整项目文件、相对路径、依赖清单、入口文件、编译命令、运行命令、"
        "验收方式和失败后的诊断信息。"
    )
    try:
        ai_text, _ = _llm_json_chat_full(
            base_url, api_key, model, _AGENT_PROMPT_SYSTEM, user_prompt, max_tokens=3000,
        )
    except http_requests.exceptions.RequestException as exc:
        logger.error('agent_prompt LLM error: %s', exc)
        return jsonify({'error': str(exc)}), 502
    parsed = _extract_json_object(ai_text)
    prompt = str(parsed.get('prompt') or '').strip() if isinstance(parsed, dict) else ''
    if not prompt:
        # Keep the feature useful with models that ignore the JSON instruction.
        prompt = ai_text.strip()
    if not prompt:
        return jsonify({'error': 'LLM did not return a prompt'}), 422
    return jsonify({
        'prompt': prompt,
        'summary': str(parsed.get('summary') or '').strip() if isinstance(parsed, dict) else '',
        'environment': environment,
        'language': language,
    })


@app.route('/api/agent/fix-code', methods=['POST'])
def agent_fix_code():
    """Rewrite a failed code block using the selected provider."""
    data = request.json or {}
    code = str(data.get('code') or '')
    language = str(data.get('language') or 'text').strip().lower()
    output = str(data.get('output') or '')[-6000:]
    exit_code = data.get('exitCode')
    if not code.strip():
        return jsonify({'error': 'code required'}), 400
    triple, err_resp, err_code = _require_provider(data)
    if err_resp is not None:
        return err_resp, err_code
    base_url, api_key, model = triple
    user_prompt = (
        f"语言: {language}\n退出码: {exit_code}\n"
        f"原始代码:\n```{language}\n{code}\n```\n"
        f"编译/执行输出:\n```\n{output}\n```\n"
        "请修复所有错误，保留原始需求，返回完整可替换代码；如果缺少依赖，同时给出安装命令。"
    )
    try:
        ai_text, _ = _llm_json_chat_full(
            base_url, api_key, model, _AGENT_CODE_FIX_SYSTEM, user_prompt, max_tokens=12000,
        )
    except http_requests.exceptions.RequestException as exc:
        logger.error('agent_fix_code LLM error: %s', exc)
        return jsonify({'error': str(exc)}), 502
    parsed = _extract_json_object(ai_text)
    fixed = str(parsed.get('code') or '').strip() if isinstance(parsed, dict) else ''
    if not fixed:
        block = re.search(r'```(?:[a-zA-Z0-9_+\-]*)\s*\n([\s\S]*?)\n?```', ai_text)
        fixed = block.group(1).strip() if block else ''
    if not fixed:
        return jsonify({'error': 'LLM did not return replacement code', 'raw': ai_text[:2000]}), 422
    return jsonify({
        'code': fixed,
        'language': str(parsed.get('language') or language).strip().lower() if isinstance(parsed, dict) else language,
        'dependencies': parsed.get('dependencies') if isinstance(parsed, dict) and isinstance(parsed.get('dependencies'), list) else [],
        'install_commands': parsed.get('install_commands') if isinstance(parsed, dict) and isinstance(parsed.get('install_commands'), list) else [],
        'summary': str(parsed.get('summary') or '').strip() if isinstance(parsed, dict) else '',
    })


@app.route('/api/agent/plan', methods=['POST'])
def agent_plan():
    """User goal → list of steps. Body: { message, baseUrl, apiKey, model }."""
    data = request.json or {}
    goal = (data.get('message') or '').strip()
    environment = (data.get('environment') or 'local-linux').strip()
    preferred_language = (data.get('language') or '').strip().lower()
    if not goal:
        return jsonify({"error": "message required"}), 400
    triple, err_resp, err_code = _require_provider(data)
    if err_resp is not None:
        return err_resp, err_code
    base_url, api_key, model = triple

    user_prompt = (
        f"任务: {goal}\n"
        f"运行环境: {environment}\n"
        f"用户首选语言: {preferred_language or '由模型选择'}\n"
        "请输出 JSON {steps: [{title, description}, ...], language: \"为该任务推荐的最合适编程语言\"}。\n"
        "language 从 python/node/go/c/cpp/java/rust/bash 中选最合适的一个；若是通用脚本/运维类任务用 bash 或 python。"
    )
    try:
        ai_text, _ = _llm_json_chat_full(base_url, api_key, model, _AGENT_PLAN_SYSTEM, user_prompt, max_tokens=1500)
    except http_requests.exceptions.RequestException as e:
        logger.error(f"agent_plan LLM error: {e}")
        return jsonify({"error": str(e)}), 502
    parsed = _extract_json_object(ai_text)
    if not parsed or 'steps' not in parsed or not isinstance(parsed['steps'], list):
        return jsonify({"error": "LLM did not return valid JSON", "raw": ai_text[:1500]}), 422
    steps = []
    for s in parsed['steps']:
        if not isinstance(s, dict):
            continue
        steps.append({
            "title": str(s.get('title') or '').strip()[:120],
            "description": str(s.get('description') or '').strip()[:600],
        })
    language = str(parsed.get('language') or '').strip().lower()
    if language not in ('python', 'node', 'js', 'javascript', 'go', 'c', 'cpp', 'c++', 'java', 'rust', 'bash', 'sh'):
        language = ''
    return jsonify({"steps": steps, "language": language})


@app.route('/api/agent/script', methods=['POST'])
def agent_script():
    """Steps + goal → executable script + parameter form schema.
    Body: { message, steps, baseUrl, apiKey, model, language? }."""
    data = request.json or {}
    goal = (data.get('message') or '').strip()
    steps = data.get('steps') or []
    pref_lang = (data.get('language') or '').strip().lower()
    environment = (data.get('environment') or 'local-linux').strip()
    if not goal or not isinstance(steps, list) or not steps:
        return jsonify({"error": "message and steps required"}), 400
    triple, err_resp, err_code = _require_provider(data)
    if err_resp is not None:
        return err_resp, err_code
    base_url, api_key, model = triple

    steps_text = '\n'.join(
        f"{i+1}. {s.get('title','')}: {s.get('description','')}" for i, s in enumerate(steps) if isinstance(s, dict)
    )
    lang_hint = f"\n首选语言: {pref_lang}" if pref_lang in ('bash', 'python') else ""
    user_prompt = f"任务: {goal}\n步骤:\n{steps_text}{lang_hint}\n请输出 JSON。"
    try:
        ai_text, finish_reason = _llm_json_chat_full(base_url, api_key, model, _AGENT_SCRIPT_SYSTEM, user_prompt, max_tokens=8000)
    except http_requests.exceptions.RequestException as e:
        logger.error(f"agent_script LLM error: {e}")
        return jsonify({"error": str(e)}), 502
    parsed = _extract_json_object(ai_text)
    if not parsed or not parsed.get('script'):
        # JSON 解析失败：依次尝试 markdown 代码块 / 截断 JSON 救援
        fallback = _extract_script_fallback(ai_text, pref_lang) or _salvage_truncated_script_json(ai_text, pref_lang)
        if fallback and fallback.get('script'):
            via = 'truncated-json-salvage' if fallback.get('truncated') else 'code-block-fallback'
            logger.warning(f"agent_script: JSON parse failed, used {via} (script={len(fallback['script'])} chars, raw_total={len(ai_text)}, finish_reason={finish_reason!r})")
            parsed = fallback
        else:
            logger.warning(
                "agent_script: invalid JSON and no salvage possible, len=%d, finish_reason=%r, head=%r, tail=%r",
                len(ai_text), finish_reason, ai_text[:400], ai_text[-200:],
            )
            return jsonify({"error": "LLM did not return valid script JSON", "raw": ai_text[:1500]}), 422

    # JSON 解析成功但 finish_reason='length' 同样视为被截断
    if finish_reason == 'length' and not parsed.get('truncated'):
        parsed['truncated'] = True

    lang_out = (parsed.get('language') or 'bash').lower()
    if parsed.get('truncated'):
        full_script, finished = _continue_truncated_script(base_url, api_key, model, parsed['script'], lang_out)
        parsed['script'] = full_script
        parsed['truncated'] = not finished
        logger.warning(f"agent_script: auto-continuation done, finished={finished}, final_script_len={len(full_script)}")

    # === 语法校验 + 失败时一轮自动修复 ===
    validation = {'ok': True, 'fixed': False, 'error': ''}
    if pm:
        ok, err = pm.validate_syntax(parsed['script'], lang_out)
        validation['ok'] = ok
        validation['error'] = err if not ok else ''
        if not ok:
            logger.warning(f"agent_script: syntax check failed, attempting one fix round")
            fix_user = (
                f"以下 {lang_out} 脚本存在语法错误：\n```{lang_out}\n{parsed['script']}\n```\n\n"
                f"语法检查报告：\n```\n{err}\n```\n\n"
                "请只修复语法问题，输出修复后的完整 JSON（与生成脚本接口格式一致，"
                "{\"language\":..., \"script\":..., \"parameters\":[...], \"reason\":\"修复点摘要\"}）。"
            )
            try:
                ai_fix, _ = _llm_json_chat_full(
                    base_url, api_key, model, _AGENT_FIX_SYSTEM, fix_user, max_tokens=8000
                )
                fix_parsed = (
                    _extract_json_object(ai_fix)
                    or _extract_script_fallback(ai_fix, lang_out)
                    or _salvage_truncated_script_json(ai_fix, lang_out)
                )
                if fix_parsed and fix_parsed.get('script'):
                    ok2, err2 = pm.validate_syntax(fix_parsed['script'], (fix_parsed.get('language') or lang_out).lower())
                    if ok2:
                        parsed['script'] = fix_parsed['script']
                        lang_out = (fix_parsed.get('language') or lang_out).lower()
                        if fix_parsed.get('parameters'):
                            parsed['parameters'] = fix_parsed['parameters']
                        validation = {'ok': True, 'fixed': True, 'error': '', 'previous_error': err}
                        logger.warning("agent_script: syntax auto-fix succeeded")
                    else:
                        validation = {'ok': False, 'fixed': False, 'error': err2, 'previous_error': err}
                        logger.warning(f"agent_script: syntax auto-fix still invalid: {err2[:200]}")
            except Exception as e:
                logger.warning(f"agent_script: syntax fix LLM error: {e}")
                validation['fix_error'] = str(e)

    # 兜底注入步骤计划日志（不改 LLM 写的主体；用户运行脚本时能看到工作流全貌）
    parsed['script'] = _ensure_step_logging(parsed['script'], lang_out, steps)

    return jsonify({
        "language": lang_out,
        "script": parsed['script'],
        "parameters": parsed.get('parameters') or [],
        "truncated": bool(parsed.get('truncated')),
        "validation": validation,
    })


@app.route('/api/agent/refine', methods=['POST'])
def agent_refine():
    """Iterate the script based on previous run output + user's natural-language refinement.
    Body: { message, script, language, parameters, output, exitCode, refinement, baseUrl, apiKey, model }."""
    data = request.json or {}
    triple, err_resp, err_code = _require_provider(data)
    if err_resp is not None:
        return err_resp, err_code
    base_url, api_key, model = triple

    goal = (data.get('message') or '').strip()
    script = data.get('script') or ''
    language = (data.get('language') or 'bash').lower()
    parameters = data.get('parameters') or []
    output = (data.get('output') or '')[-4000:]
    exit_code = data.get('exitCode')
    refinement = (data.get('refinement') or '').strip()
    if not script or not refinement:
        return jsonify({"error": "script and refinement required"}), 400

    user_prompt = (
        f"原任务: {goal}\n原语言: {language}\n原参数定义: {json.dumps(parameters, ensure_ascii=False)}\n"
        f"上一次脚本:\n```{language}\n{script}\n```\n"
        f"上次运行退出码: {exit_code}\n上次运行输出（截尾 4000 字）:\n```\n{output}\n```\n"
        f"用户的改进/调整需求:\n{refinement}\n"
        "请基于这些信息生成下一版脚本，输出 JSON。"
    )
    try:
        ai_text, finish_reason = _llm_json_chat_full(base_url, api_key, model, _AGENT_REFINE_SYSTEM, user_prompt, max_tokens=8000)
    except http_requests.exceptions.RequestException as e:
        logger.error(f"agent_refine LLM error: {e}")
        return jsonify({"error": str(e)}), 502
    parsed = _extract_json_object(ai_text)
    if not parsed or not parsed.get('script'):
        fallback = _extract_script_fallback(ai_text, language) or _salvage_truncated_script_json(ai_text, language)
        if fallback and fallback.get('script'):
            via = 'truncated-json-salvage' if fallback.get('truncated') else 'code-block-fallback'
            logger.warning(f"agent_refine: JSON parse failed, used {via} (script={len(fallback['script'])} chars, raw_total={len(ai_text)}, finish_reason={finish_reason!r})")
            parsed = fallback
        else:
            logger.warning(
                "agent_refine: invalid JSON and no salvage possible, len=%d, finish_reason=%r, head=%r, tail=%r",
                len(ai_text), finish_reason, ai_text[:400], ai_text[-200:],
            )
            return jsonify({"error": "LLM did not return valid refine JSON", "raw": ai_text[:1500]}), 422

    if finish_reason == 'length' and not parsed.get('truncated'):
        parsed['truncated'] = True

    lang_out = (parsed.get('language') or language).lower()
    if parsed.get('truncated'):
        full_script, finished = _continue_truncated_script(base_url, api_key, model, parsed['script'], lang_out)
        parsed['script'] = full_script
        parsed['truncated'] = not finished
        logger.warning(f"agent_refine: auto-continuation done, finished={finished}, final_script_len={len(full_script)}")

    return jsonify({
        "language": lang_out,
        "script": parsed['script'],
        "parameters": parsed.get('parameters') or parameters,
        "reason": parsed.get('reason') or '',
        "truncated": bool(parsed.get('truncated')),
    })


# ============================================================
# API Routes - Agent 多文件工程化项目（代码编写工作流）
# 生成多文件工程 → 落盘 workspace/projects/<slug> → 生成 run.sh → bash 执行
# ============================================================
_AGENT_PROJECT_SYSTEM = (
    "你是资深软件工程师。基于任务与开发计划，生成一个【可直接运行的工程化项目】。\n"
    "只输出一个合法 JSON 对象，不要任何额外文本，结构：\n"
    '{"language":"python|node|go|c|cpp|java|rust|bash",'
    '"files":[{"path":"相对路径，如 src/main.py","content":"完整文件内容"}],'
    '"entry":"入口文件相对路径","run_cmd":"从项目根目录可直接执行的运行命令",'
    '"deps":["第三方依赖包名"],"summary":"一句话说明项目结构"}\n'
    "要求：\n"
    "- 文件完整可运行，包含必要的依赖清单(Python: requirements.txt；Node: package.json；Go: go.mod)。\n"
    "- 全部使用相对路径，禁止绝对路径或 .. 越级。\n"
    "- 工程化：合理拆分模块、含基本错误处理与必要注释。\n"
    "- run_cmd 是从项目根目录的一条命令；编译型语言用 && 串联编译与运行。\n"
)

_PROJECT_RUNNABLE = {'python', 'py', 'node', 'js', 'javascript', 'go', 'c', 'cpp', 'c++',
                     'java', 'rust', 'rs', 'bash', 'sh', 'shell'}


def _project_run_sh(language, entry, run_cmd, deps):
    """为多文件工程生成 run.sh 内容（含依赖安装 + 运行）。"""
    lang = (language or '').lower()
    entry = entry or ''
    run_cmd = (run_cmd or '').strip()
    deps = [d for d in (deps or []) if isinstance(d, str) and d.strip()]
    header = ['#!/usr/bin/env bash', 'set -e', 'cd "$(dirname "$0")"', '']
    body = []
    if lang in ('python', 'py'):
        body += [
            'VENV=".venv-run"',
            '[ -x "$VENV/bin/python" ] || { echo "==> 创建虚拟环境"; python3 -m venv "$VENV"; }',
            'if [ -f requirements.txt ]; then echo "==> 安装依赖"; "$VENV/bin/pip" install -q -r requirements.txt; fi',
        ]
        if deps:
            body.append(f'"$VENV/bin/pip" install -q {" ".join(shlex.quote(d) for d in deps)} || true')
        body += ['echo "==> 运行"', f'exec "$VENV/bin/python" {shlex.quote(entry)}' if entry else f'exec "$VENV/bin/python" {run_cmd}']
    elif lang in ('node', 'js', 'javascript'):
        body += ['[ -f package.json ] && npm install --silent || npm init -y >/dev/null 2>&1']
        if deps:
            body.append(f'npm install --silent {" ".join(shlex.quote(d) for d in deps)} || true')
        body += ['echo "==> 运行"', f'exec node {shlex.quote(entry)}' if entry else f'exec {run_cmd}']
    elif lang == 'go':
        body += ['[ -f go.mod ] || go mod init app >/dev/null 2>&1', 'go mod tidy 2>/dev/null || true',
                 'echo "==> 运行"', f'exec {run_cmd or "go run ."}']
    elif lang in ('bash', 'sh', 'shell'):
        body += ['echo "==> 运行"', f'exec {run_cmd or ("bash " + shlex.quote(entry))}']
    elif lang == 'c':
        body += [
            'echo "==> 编译 C"',
            f'gcc -O2 {shlex.quote(entry)} -o .project-bin',
            'echo "==> 运行"',
            'exec ./.project-bin',
        ]
    elif lang in ('cpp', 'c++', 'cxx'):
        body += [
            'echo "==> 编译 C++"',
            f'g++ -std=c++17 -O2 {shlex.quote(entry)} -o .project-bin',
            'echo "==> 运行"',
            'exec ./.project-bin',
        ]
    elif lang in ('rust', 'rs'):
        body += [
            'echo "==> 编译 Rust"',
            f'rustc -O {shlex.quote(entry)} -o .project-bin',
            'echo "==> 运行"',
            'exec ./.project-bin',
        ]
    else:
        # Java and unusual project layouts may need package-specific commands;
        # keep the model-provided command for those cases.
        body += ['echo "==> 编译并运行"', run_cmd or 'echo "未提供 run_cmd"; exit 1']
    return '\n'.join(header + body) + '\n'


def _materialize_project(parsed, goal, slug=None):
    """把 LLM 返回的项目 JSON 落盘到 workspace/projects/<slug>，并生成 run.sh。
    返回前端所需结构；出错返回 {'error': ...}。"""
    language = (parsed.get('language') or '').strip().lower() or 'python'
    files = parsed.get('files') or []
    entry = (parsed.get('entry') or '').strip()
    run_cmd = (parsed.get('run_cmd') or '').strip()
    deps = parsed.get('deps') or []
    summary = (parsed.get('summary') or '').strip()

    if not slug:
        slug = _slugify_name((goal or 'project')[:32], 'project').lower() + '_' + str(int(time.time()))[-6:]
    proj_dir = os.path.join(WORKSPACE_DIR, 'projects', slug)
    os.makedirs(proj_dir, exist_ok=True)
    proj_real = os.path.realpath(proj_dir)

    written = []
    for f in files:
        if not isinstance(f, dict):
            continue
        rel = (f.get('path') or '').strip()
        content = f.get('content')
        if not rel or content is None:
            continue
        norm = os.path.normpath(rel)
        if os.path.isabs(norm) or norm.startswith('..'):
            continue
        full = os.path.realpath(os.path.join(proj_dir, norm))
        if os.path.commonpath([full, proj_real]) != proj_real:
            continue
        os.makedirs(os.path.dirname(full), exist_ok=True)
        try:
            with open(full, 'w', encoding='utf-8') as fp:
                fp.write(content if isinstance(content, str) else str(content))
            written.append({'path': norm, 'content': content})
        except Exception as e:
            logger.warning(f"materialize_project write {norm} error: {e}")

    if not written:
        return {'error': '项目没有可写入的文件'}

    # entry 兜底：找一个看起来像入口的文件
    if not entry:
        names = [w['path'] for w in written]
        entry = next((n for n in names if os.path.basename(n) in
                      ('main.py', 'app.py', 'index.js', 'main.js', 'main.go', 'main.c', 'main.cpp', 'main.rs', 'Main.java')), names[0])

    run_sh = _project_run_sh(language, entry, run_cmd, deps)
    try:
        run_path = os.path.join(proj_dir, 'run.sh')
        with open(run_path, 'w', encoding='utf-8') as fp:
            fp.write(run_sh)
        os.chmod(run_path, 0o755)
    except Exception as e:
        logger.warning(f"materialize_project run.sh error: {e}")

    exec_command = f"cd {shlex.quote(proj_real)} && bash run.sh"
    return {
        'slug': slug,
        'dir': proj_real,
        'language': language,
        'entry': entry,
        'run_cmd': run_cmd,
        'deps': deps,
        'summary': summary,
        'files': written,
        'run_sh': run_sh,
        'exec_command': exec_command,
    }


def _render_project_files(files, per_file=3000):
    out = []
    for f in (files or []):
        if not isinstance(f, dict):
            continue
        p = f.get('path') or ''
        c = (f.get('content') or '')
        if not p:
            continue
        out.append(f"--- {p} ---\n{c[:per_file]}")
    return "\n\n".join(out) if out else "(无文件)"


@app.route('/api/agent/project', methods=['POST'])
def agent_project():
    """开发计划 → 多文件工程项目（落盘 + run.sh）。
    Body: { message, steps, language?, baseUrl, apiKey, model }"""
    data = request.json or {}
    goal = (data.get('message') or '').strip()
    steps = data.get('steps') or []
    pref_lang = (data.get('language') or '').strip().lower()
    environment = (data.get('environment') or 'local-linux').strip()
    triple, err_resp, err_code = _require_provider(data)
    if err_resp is not None:
        return err_resp, err_code
    base_url, api_key, model = triple
    if not goal:
        return jsonify({'error': 'message required'}), 400

    steps_text = '\n'.join(
        f"{i+1}. {s.get('title','')}: {s.get('description','')}"
        for i, s in enumerate(steps) if isinstance(s, dict)
    )
    lang_hint = f"\n推荐语言: {pref_lang}" if pref_lang else ""
    user_prompt = (
        f"任务: {goal}\n运行环境: {environment}\n开发计划:\n{steps_text}{lang_hint}\n"
        "请生成工程化项目，输出 JSON。"
    )
    try:
        ai_text, finish_reason = _llm_json_chat_full(base_url, api_key, model, _AGENT_PROJECT_SYSTEM, user_prompt, max_tokens=12000)
    except http_requests.exceptions.RequestException as e:
        logger.error(f"agent_project LLM error: {e}")
        return jsonify({'error': str(e)}), 502
    parsed = _extract_json_object(ai_text)
    if not parsed or not isinstance(parsed.get('files'), list) or not parsed['files']:
        return jsonify({'error': 'LLM 未返回有效的项目文件 JSON', 'raw': ai_text[:1500]}), 422
    result = _materialize_project(parsed, goal)
    if 'error' in result:
        return jsonify(result), 400
    result['truncated'] = (finish_reason == 'length')
    return jsonify(result)


@app.route('/api/agent/fix-project', methods=['POST'])
def agent_fix_project():
    """工程项目运行失败 → 让 LLM 修复并重写文件（覆盖同一 slug）。
    Body: { message, slug, language, files, output, exitCode, baseUrl, apiKey, model }"""
    data = request.json or {}
    goal = (data.get('message') or '').strip()
    slug = (data.get('slug') or '').strip() or None
    language = (data.get('language') or '').strip().lower()
    files = data.get('files') or []
    output = (data.get('output') or '')[-4000:]
    exit_code = data.get('exitCode')
    triple, err_resp, err_code = _require_provider(data)
    if err_resp is not None:
        return err_resp, err_code
    base_url, api_key, model = triple
    if not files:
        return jsonify({'error': 'files required'}), 400

    user_prompt = (
        f"任务: {goal}\n语言: {language}\n"
        f"当前项目文件:\n{_render_project_files(files)}\n\n"
        f"运行退出码: {exit_code}\n运行输出(截尾 4000 字):\n```\n{output}\n```\n\n"
        "请修复使其能成功编译并运行。输出完整项目 JSON（结构与生成接口一致），"
        "files 必须包含项目所有文件的完整内容（即使未改动），summary 用一句话说明修复点。"
    )
    try:
        ai_text, finish_reason = _llm_json_chat_full(base_url, api_key, model, _AGENT_PROJECT_SYSTEM, user_prompt, max_tokens=12000)
    except http_requests.exceptions.RequestException as e:
        logger.error(f"agent_fix_project LLM error: {e}")
        return jsonify({'error': str(e)}), 502
    parsed = _extract_json_object(ai_text)
    if not parsed or not isinstance(parsed.get('files'), list) or not parsed['files']:
        return jsonify({'error': 'LLM 未返回有效的修复 JSON', 'raw': ai_text[:1500]}), 422
    if language and not parsed.get('language'):
        parsed['language'] = language
    result = _materialize_project(parsed, goal, slug=slug)
    if 'error' in result:
        return jsonify(result), 400
    result['truncated'] = (finish_reason == 'length')
    result['reason'] = parsed.get('summary') or '已根据错误修复项目'
    return jsonify(result)


@app.route('/api/agent/refine-project', methods=['POST'])
def agent_refine_project():
    """根据后续提示词修订工程项目（修改计划/重写代码，覆盖同一 slug）。
    Body: { message, slug, language, files, refinement, baseUrl, apiKey, model }"""
    data = request.json or {}
    goal = (data.get('message') or '').strip()
    slug = (data.get('slug') or '').strip() or None
    language = (data.get('language') or '').strip().lower()
    files = data.get('files') or []
    refinement = (data.get('refinement') or '').strip()
    triple, err_resp, err_code = _require_provider(data)
    if err_resp is not None:
        return err_resp, err_code
    base_url, api_key, model = triple
    if not refinement:
        return jsonify({'error': 'refinement required'}), 400

    user_prompt = (
        f"原任务: {goal}\n语言: {language}\n"
        f"当前项目文件:\n{_render_project_files(files)}\n\n"
        f"用户的新需求/调整:\n{refinement}\n\n"
        "请据此修订开发方案并重写代码。输出完整项目 JSON（结构与生成接口一致），"
        "files 必须包含项目所有文件的完整内容，summary 用一句话说明本次改动。"
    )
    try:
        ai_text, finish_reason = _llm_json_chat_full(base_url, api_key, model, _AGENT_PROJECT_SYSTEM, user_prompt, max_tokens=12000)
    except http_requests.exceptions.RequestException as e:
        logger.error(f"agent_refine_project LLM error: {e}")
        return jsonify({'error': str(e)}), 502
    parsed = _extract_json_object(ai_text)
    if not parsed or not isinstance(parsed.get('files'), list) or not parsed['files']:
        return jsonify({'error': 'LLM 未返回有效的修订 JSON', 'raw': ai_text[:1500]}), 422
    if language and not parsed.get('language'):
        parsed['language'] = language
    result = _materialize_project(parsed, goal, slug=slug)
    if 'error' in result:
        return jsonify(result), 400
    result['truncated'] = (finish_reason == 'length')
    result['reason'] = parsed.get('summary') or '已根据新需求重写项目'
    return jsonify(result)


@app.route('/api/agent/refine-step', methods=['POST'])
def agent_refine_step():
    """重新生成单个步骤。
    Body: {
        message: 整体任务,
        steps: [{title, description}, ...] 当前完整步骤列表,
        index: 要重生成的步骤索引（0-based）,
        hint?: 用户对该步骤的修改提示/反馈（可选）,
        baseUrl, apiKey, model
    }
    返回 {title, description, reason}
    """
    data = request.json or {}
    triple, err_resp, err_code = _require_provider(data)
    if err_resp is not None:
        return err_resp, err_code
    base_url, api_key, model = triple

    goal = (data.get('message') or '').strip()
    steps = data.get('steps') or []
    try:
        idx = int(data.get('index'))
    except Exception:
        return jsonify({"error": "index must be an integer"}), 400
    if not goal or not isinstance(steps, list) or not steps:
        return jsonify({"error": "message and steps required"}), 400
    if idx < 0 or idx >= len(steps):
        return jsonify({"error": f"index out of range (0..{len(steps)-1})"}), 400
    hint = (data.get('hint') or '').strip()
    target = steps[idx] if isinstance(steps[idx], dict) else {}
    cur_title = str(target.get('title') or '').strip()
    cur_desc = str(target.get('description') or '').strip()

    # 上下文：把前后步骤摘要给模型，便于保持一致
    def _fmt(i, s, marker=''):
        if not isinstance(s, dict):
            return f"{i+1}. (空)"
        return f"{i+1}. {marker}{s.get('title','').strip()}: {s.get('description','').strip()}"

    others_lines = []
    for i, s in enumerate(steps):
        if i == idx:
            others_lines.append(_fmt(i, s, marker='⟵ 这一步要重写  '))
        else:
            others_lines.append(_fmt(i, s))
    others_text = '\n'.join(others_lines)

    user_prompt = (
        f"整体任务:\n{goal}\n\n"
        f"当前完整步骤计划:\n{others_text}\n\n"
        f"目标步骤的当前内容:\n  title: {cur_title}\n  description: {cur_desc}\n\n"
        f"用户的修改提示/反馈:\n{hint if hint else '(无具体提示，请基于上下文做一次更清晰、更具体的改写)'}\n\n"
        "请只输出该步骤新的 JSON：{\"title\":..., \"description\":..., \"reason\":...}。"
    )
    try:
        ai_text, _ = _llm_json_chat_full(base_url, api_key, model, _AGENT_REFINE_STEP_SYSTEM, user_prompt, max_tokens=600)
    except http_requests.exceptions.RequestException as e:
        logger.error(f"agent_refine_step LLM error: {e}")
        return jsonify({"error": str(e)}), 502
    parsed = _extract_json_object(ai_text)
    if not parsed or not isinstance(parsed, dict):
        return jsonify({"error": "LLM did not return valid step JSON", "raw": ai_text[:1500]}), 422
    new_title = str(parsed.get('title') or '').strip()[:120] or cur_title
    new_desc = str(parsed.get('description') or '').strip()[:600] or cur_desc
    return jsonify({
        "title": new_title,
        "description": new_desc,
        "reason": (str(parsed.get('reason') or '').strip())[:200],
        "index": idx,
    })


@app.route('/api/local-hub/url', methods=['GET'])
def local_hub_url():
    """Return configured local-hub URL (Local LLM management page) for the frontend to open externally.
    可通过环境变量 LOCAL_HUB_URL 覆盖（默认 http://127.0.0.1:8080）。"""
    return jsonify({"url": os.environ.get('LOCAL_HUB_URL') or 'http://127.0.0.1:8080'})


@app.route('/api/agent/fix', methods=['POST'])
def agent_fix():
    """Failed script + output → fixed script. Body: { message, script, language, parameters, output, exitCode, baseUrl, apiKey, model }."""
    data = request.json or {}
    triple, err_resp, err_code = _require_provider(data)
    if err_resp is not None:
        return err_resp, err_code
    base_url, api_key, model = triple

    goal = (data.get('message') or '').strip()
    script = data.get('script') or ''
    language = (data.get('language') or 'bash').lower()
    parameters = data.get('parameters') or []
    output = (data.get('output') or '')[-4000:]
    exit_code = data.get('exitCode')
    if not script:
        return jsonify({"error": "script required"}), 400

    user_prompt = (
        f"原任务: {goal}\n原语言: {language}\n原参数定义: {json.dumps(parameters, ensure_ascii=False)}\n"
        f"原脚本:\n```{language}\n{script}\n```\n"
        f"运行退出码: {exit_code}\n输出/错误（截尾 4000 字）:\n```\n{output}\n```\n"
        "请根据错误修复脚本（保持任务目标），输出 JSON。"
    )
    try:
        ai_text, finish_reason = _llm_json_chat_full(base_url, api_key, model, _AGENT_FIX_SYSTEM, user_prompt, max_tokens=8000)
    except http_requests.exceptions.RequestException as e:
        logger.error(f"agent_fix LLM error: {e}")
        return jsonify({"error": str(e)}), 502
    parsed = _extract_json_object(ai_text)
    if not parsed or not parsed.get('script'):
        fallback = _extract_script_fallback(ai_text, language) or _salvage_truncated_script_json(ai_text, language)
        if fallback and fallback.get('script'):
            via = 'truncated-json-salvage' if fallback.get('truncated') else 'code-block-fallback'
            logger.warning(f"agent_fix: JSON parse failed, used {via} (script={len(fallback['script'])} chars, raw_total={len(ai_text)}, finish_reason={finish_reason!r})")
            parsed = fallback
        else:
            logger.warning(
                "agent_fix: invalid JSON and no salvage possible, len=%d, finish_reason=%r, head=%r, tail=%r",
                len(ai_text), finish_reason, ai_text[:400], ai_text[-200:],
            )
            return jsonify({"error": "LLM did not return valid fix JSON", "raw": ai_text[:1500]}), 422

    if finish_reason == 'length' and not parsed.get('truncated'):
        parsed['truncated'] = True

    lang_out = (parsed.get('language') or language).lower()
    if parsed.get('truncated'):
        full_script, finished = _continue_truncated_script(base_url, api_key, model, parsed['script'], lang_out)
        parsed['script'] = full_script
        parsed['truncated'] = not finished
        logger.warning(f"agent_fix: auto-continuation done, finished={finished}, final_script_len={len(full_script)}")

    return jsonify({
        "language": lang_out,
        "script": parsed['script'],
        "parameters": parsed.get('parameters') or parameters,
        "reason": parsed.get('reason') or '',
        "truncated": bool(parsed.get('truncated')),
    })


# ============================================================
# API Routes - Auto Route （意图分析 + 角色路由 + 上下文话题判定）
# ============================================================
INTENT_PROMPT_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'yitu.txt')


def _load_intent_prompt() -> str:
    """读取 yitu.txt 作为基础意图分析提示词；附加 same_topic 字段说明。"""
    base = ''
    try:
        if os.path.exists(INTENT_PROMPT_FILE):
            with open(INTENT_PROMPT_FILE, 'r', encoding='utf-8') as f:
                base = f.read().strip()
    except Exception as e:
        logger.warning(f"_load_intent_prompt failed: {e}")
    extra = (
        "\n\n# 额外字段（必须输出，不要省略）\n"
        "- `same_topic`: 布尔值，表示「本次输入是否与下面提供的『当前对话上下文』属于同一话题/任务连续上下文」。"
        "如果用户明显切换到了新话题、或上下文为空，请输出 false。\n"
        "- 仍然只输出一个合法 JSON 对象，包含字段 intent/keywords/complexity/reason/same_topic，"
        "不要任何额外文本。\n"
        "# 输出格式示例\n"
        "{\"intent\":\"代码编写\",\"keywords\":[\"Python\",\"爬虫\",\"异步\"],"
        "\"complexity\":\"复杂\",\"reason\":\"含网络请求与并发逻辑\",\"same_topic\":false}\n"
    )
    return (base + extra) if base else (
        "你是一个意图识别引擎。仅输出 JSON："
        "{\"intent\":\"...\",\"keywords\":[],\"complexity\":null,\"reason\":\"...\",\"same_topic\":false}"
        + extra
    )


# 意图 → 角色 / 端点 的固定映射（与前端 model_roles 角色名一致）
_INTENT_TO_ROLE = {
    '讯息':     'web_search',
    '问答':     'chat_basic',
    '工具调用':  'chat_basic',
    '网页控制':  'chat_basic',
    '图文理解':  'vision',
    '音频理解':  'asr',           # 走 model_endpoints.asr
    '文字润色':  'chat_basic',
    '数据分析':  'chat_advanced',
    '生成图片':  'image_gen',
    '生成音频':  'tts',           # 走 model_endpoints.tts
    '未知':     'chat_basic',
}


def _resolve_role_target(role: str, settings: dict, providers: list) -> dict:
    """根据角色名查 (providerId, model)，并补上 baseUrl/apiKey。

    返回 dict：
      - role:        最终选定的 role
      - kind:        'role'（普通对话）/ 'endpoint'（tts/asr/ocr）/ 'unbound'（未配置）
      - providerId / model / baseUrl / apiKey （kind='role' 时有效）
      - endpoint:   {baseUrl, apiKey, model}（kind='endpoint' 时有效）
    """
    out = {"role": role, "kind": "unbound"}

    if role in ('tts', 'asr', 'ocr'):
        ep = ((settings.get('model_endpoints') or {}).get(role) or {})
        out["kind"] = "endpoint"
        out["endpoint"] = {
            "baseUrl": ep.get('baseUrl') or '',
            "apiKey":  ep.get('apiKey')  or '',
            "model":   ep.get('model')   or '',
        }
        if not (ep.get('baseUrl') and ep.get('model')):
            out["kind"] = "unbound"
        return out

    binding = ((settings.get('model_roles') or {}).get(role) or {})
    pid = binding.get('providerId') or ''
    model = binding.get('model') or ''
    if not pid or not model:
        return out
    p = next((x for x in (providers or []) if x.get('id') == pid), None)
    if not p:
        return out
    out.update({
        "kind": "role",
        "providerId": pid,
        "model": model,
        "baseUrl": p.get('baseUrl') or '',
        "apiKey":  p.get('apiKey')  or '',
        "providerName": p.get('name') or '',
    })
    return out


@app.route('/api/auto-route', methods=['POST'])
def api_auto_route():
    """根据用户消息和当前对话上下文做意图分析 + 角色路由判断。

    Body:
      message:           str   - 当前用户输入（必填）
      recent_messages:   [{role, content}]  - 当前对话最近若干条（用于 same_topic 判断）
      baseUrl/apiKey/model:                  - intent 模型凭据；若缺省则用 settings.model_roles.intent
    返回：
      {
        intent, complexity, keywords, reason, same_topic,
        role,                       # 映射后的角色名（如 chat_basic / vision / ...）
        target: { kind, providerId?, model?, baseUrl?, apiKey?, endpoint? },
        raw: <LLM 原文>
      }
    """
    data = request.json or {}
    message = (data.get('message') or '').strip()
    if not message:
        return jsonify({"error": "message required"}), 400

    # 意图理解过程日志（前端「意图分析」面板展示）
    _t0 = time.time()
    trace = []

    def _trace(step, detail='', status='done'):
        trace.append({
            "step": step,
            "detail": detail,
            "status": status,
            "ms": int((time.time() - _t0) * 1000),
        })

    settings = _load_settings()
    providers = _load_json(PROVIDERS_FILE, [])
    if not isinstance(providers, list):
        providers = []

    # intent 模型凭据：优先 body，缺省时用 settings.model_roles.intent → 在 providers 中查
    base_url = (data.get('baseUrl') or '').rstrip('/')
    api_key = data.get('apiKey') or ''
    model = data.get('model') or ''
    if not (base_url and model):
        intent_bind = ((settings.get('model_roles') or {}).get('intent') or {})
        ip = next((p for p in providers if p.get('id') == intent_bind.get('providerId')), None)
        if ip:
            base_url = (ip.get('baseUrl') or '').rstrip('/')
            api_key = ip.get('apiKey') or ''
            model = intent_bind.get('model') or ''

    if not (base_url and model):
        return jsonify({"error": "intent model not configured (settings.model_roles.intent)"}), 400
    if not api_key and not _is_local_baseurl(base_url):
        return jsonify({"error": "intent model apiKey required"}), 400

    try:
        _host = re.sub(r'^https?://', '', base_url).split('/')[0]
    except Exception:
        _host = base_url
    _trace("加载意图提示词", f"yitu.txt{'（已加载）' if os.path.exists(INTENT_PROMPT_FILE) else '（缺失，用内置）'}")
    _trace("调用意图模型", f"{model} @ {_host}")

    # 拼接最近上下文摘要（最多 6 条 / 每条 300 字）
    recent = data.get('recent_messages') or []
    if not isinstance(recent, list):
        recent = []
    ctx_lines = []
    for m in recent[-6:]:
        if not isinstance(m, dict):
            continue
        role = (m.get('role') or '').strip()
        c = m.get('content')
        if isinstance(c, list):
            # 多模态消息：抽出 text 部分
            c = '\n'.join((it.get('text') or '') for it in c if isinstance(it, dict) and it.get('type') == 'text')
        c = (c or '').strip()
        if not role or not c:
            continue
        ctx_lines.append(f"[{role}] {c[:300]}")
    ctx_block = ("\n".join(ctx_lines) if ctx_lines else "(无)")

    system = _load_intent_prompt()
    user_prompt = (
        f"# 当前对话上下文（最多最近 6 条）：\n{ctx_block}\n\n"
        f"# 本次用户输入：\n{message}\n"
    )

    try:
        ai_text = _llm_chat(base_url, api_key, model, system, user_prompt, max_tokens=400, temperature=0.0)
    except Exception as e:
        logger.error(f"auto-route LLM error: {e}")
        _trace("调用意图模型", f"失败：{e}", status="error")
        return jsonify({"error": f"intent LLM error: {e}", "trace": trace}), 502

    # 解析 JSON：宽松一点，去掉 ``` 包裹 / 多余文本
    parsed = None
    try:
        parsed = json.loads(ai_text.strip())
    except Exception:
        m = re.search(r'\{.*\}', ai_text, re.DOTALL)
        if m:
            try:
                parsed = json.loads(m.group(0))
            except Exception:
                parsed = None

    if not isinstance(parsed, dict):
        parsed = {"intent": "未知", "keywords": [], "complexity": None,
                  "reason": "解析失败", "same_topic": True}

    intent = parsed.get('intent') or '未知'
    complexity = parsed.get('complexity') or None
    keywords = parsed.get('keywords') or []
    reason = parsed.get('reason') or ''
    same_topic = bool(parsed.get('same_topic', True))

    _kw = '、'.join([str(k) for k in keywords][:5]) if keywords else '—'
    _trace(
        "解析意图结果",
        f"意图={intent}" + (f"（{complexity}）" if complexity else "")
        + f" · 关键词：{_kw}" + (f" · 依据：{reason}" if reason else ""),
        status=("warn" if intent == '未知' else "done"),
    )

    # intent → role 映射；代码编写按 complexity 拆分
    if intent == '代码编写':
        role = 'code_advanced' if (complexity == '复杂') else 'code_simple'
    else:
        role = _INTENT_TO_ROLE.get(intent, 'chat_basic')
    _trace("匹配角色", f"{intent} → {role}")

    target = _resolve_role_target(role, settings, providers)

    # 角色未绑定时回退到 chat_basic
    if target.get('kind') == 'unbound' and role != 'chat_basic':
        fallback = _resolve_role_target('chat_basic', settings, providers)
        if fallback.get('kind') == 'role':
            target = fallback
            target['fallback_from'] = role
            _trace("角色未绑定，回退", f"{role} → chat_basic", status="warn")
            role = 'chat_basic'

    # 选定模型的过程日志
    if target.get('kind') == 'role':
        _trace("选定模型", f"{target.get('providerName') or target.get('providerId')} / {target.get('model')}")
    elif target.get('kind') == 'endpoint':
        ep = target.get('endpoint') or {}
        _trace("选定专用端点", f"{role}：{ep.get('model') or '(未配置)'}")
    else:
        _trace("未找到可用模型", f"角色 {role} 未绑定，沿用当前模型", status="warn")

    return jsonify({
        "intent": intent,
        "complexity": complexity,
        "keywords": keywords,
        "reason": reason,
        "same_topic": same_topic,
        "role": role,
        "target": target,
        "trace": trace,
        "raw": ai_text,
    })


# ============================================================
# API Routes - Plugins (LLM-generated reusable Python plugins)
# Merged from model-api-mt: /api/plugins/* + /api/chat-with-plugin
# ============================================================
@app.route('/api/plugins', methods=['GET'])
def list_plugins():
    if not pm:
        return jsonify({"plugins": []})
    plugins = []
    for d in pm.PLUGINS_DIR.iterdir():
        if d.is_dir():
            j = d / "plugin.json"
            if j.exists():
                try:
                    with open(j, 'r', encoding='utf-8') as f:
                        info = json.load(f)
                    info["path"] = str(d)
                    plugins.append(info)
                except Exception:
                    pass
    plugins.sort(key=lambda x: x.get("created_at", ""), reverse=True)
    return jsonify({"plugins": plugins})


@app.route('/api/plugins/<plugin_name>', methods=['GET'])
def get_plugin(plugin_name):
    if not pm:
        return jsonify({"error": "Plugins not available"}), 404
    d = pm.PLUGINS_DIR / plugin_name
    if not d.is_dir():
        return jsonify({"error": "Plugin not found"}), 404
    out = {"name": plugin_name, "path": str(d)}
    if (d / "plugin.json").exists():
        with open(d / "plugin.json", 'r', encoding='utf-8') as f:
            out["info"] = json.load(f)
    if (d / "main.py").exists():
        with open(d / "main.py", 'r', encoding='utf-8') as f:
            out["code"] = f.read()
    return jsonify(out)


@app.route('/api/plugins/<plugin_name>/run', methods=['POST'])
def run_plugin(plugin_name):
    """运行已存在的插件。

    可选 JSON body：
      auto_fix:     bool，失败时是否调 LLM 自动按错误日志修复（默认 True）
      max_attempts: int，含首次执行的最大尝试次数（默认 3，1~5）
      baseUrl/apiKey/model: 自动修复需要的 LLM 凭据；若缺失则只跑一次。
    """
    if not pm:
        return jsonify({"error": "Plugins not available"}), 404
    d = pm.PLUGINS_DIR / plugin_name
    if not d.is_dir():
        return jsonify({"error": "Plugin not found"}), 404

    data = request.json or {}
    auto_fix = bool(data.get("auto_fix", True))
    try:
        max_attempts = int(data.get("max_attempts") or 3)
    except Exception:
        max_attempts = 3
    max_attempts = max(1, min(5, max_attempts))
    base_url = (data.get("baseUrl") or "").rstrip("/")
    api_key = data.get("apiKey") or ""
    model = data.get("model") or ""

    sudo_pwd = _read_sudo_password()
    code, language = pm.get_plugin_code(d)

    plugin_message = ""
    info_path = d / "plugin.json"
    if info_path.exists():
        try:
            with open(info_path, 'r', encoding='utf-8') as f:
                plugin_message = (json.load(f) or {}).get("description") or ""
        except Exception:
            plugin_message = ""

    exec_r = pm.execute_plugin(d, auto_install=True, sudo_password=sudo_pwd)
    exec_r["code"] = code
    exec_r["language"] = language
    success = bool(exec_r.get("success"))
    attempts = [{
        "attempt": 1, "success": success,
        "language": language, "returncode": exec_r.get("returncode"),
    }]

    progress = []
    can_autofix = (
        auto_fix and not success and base_url and model
        and (api_key or _is_local_baseurl(base_url))
    )
    if can_autofix:
        try:
            final, progress = _drive_autofix(
                d, plugin_message, code, language, exec_r,
                base_url, api_key, model, sudo_pwd,
                max_attempts=max_attempts, start_attempt=1, attempts=attempts,
            )
            exec_r = final["exec_r"]
            code = final["code"]
            language = final["language"]
            attempts = final["attempts"]
        except Exception as e:
            logger.error(f"run_plugin auto-fix error: {e}")

    exec_r["attempts"] = attempts
    exec_r["code"] = code
    exec_r["language"] = language
    if progress:
        exec_r["progress"] = progress
    return jsonify(exec_r)


@app.route('/api/plugins/<plugin_name>/code', methods=['PUT'])
def update_plugin_code(plugin_name):
    if not pm:
        return jsonify({"error": "Plugins not available"}), 404
    data = request.json or {}
    code = data.get("code", "")
    language = (data.get("language") or "").lower() or None
    d = pm.PLUGINS_DIR / plugin_name
    if not d.is_dir():
        return jsonify({"error": "Plugin not found"}), 404
    final_lang = pm.update_plugin_main(d, code, language=language)
    return jsonify({"message": "ok", "plugin_name": plugin_name, "language": final_lang})


@app.route('/api/plugins/<plugin_name>/chat', methods=['POST'])
def plugin_chat(plugin_name):
    """根据用户的修改需求 + 可选的引用上下文，让 LLM 修改插件代码并重新运行。

    JSON body：
      message:      str  - 用户的修改指令（必填）
      current_code: str  - 当前代码（必填）
      context:      str  - 可选；用户从执行输出里"引用"的片段（错误日志/选中文字），
                           会作为关键上下文一起发给 LLM。
      auto_fix:     bool - 修改后执行失败是否再走自动修复循环（默认 True）
      max_attempts: int  - 包含首次执行在内的最大尝试次数（默认 3，1~5）
      baseUrl/apiKey/model: LLM 凭据
    """
    if not pm:
        return jsonify({"success": False, "message": "Plugins not available"}), 404
    data = request.json or {}
    msg = (data.get("message") or "").strip()
    current_code = data.get("current_code") or ""
    context = (data.get("context") or "").strip()
    base_url = (data.get("baseUrl") or "").rstrip("/")
    api_key = data.get("apiKey") or ""
    model = data.get("model") or ""
    auto_fix = bool(data.get("auto_fix", True))
    try:
        max_attempts = int(data.get("max_attempts") or 3)
    except Exception:
        max_attempts = 3
    max_attempts = max(1, min(5, max_attempts))

    if not msg or not current_code:
        return jsonify({"success": False, "message": "message and current_code required"}), 400
    d = pm.PLUGINS_DIR / plugin_name
    if not d.is_dir():
        return jsonify({"success": False, "message": "Plugin not found"}), 404
    if not base_url or not model:
        return jsonify({"success": False, "message": "baseUrl, model required"}), 400
    if not api_key and not _is_local_baseurl(base_url):
        return jsonify({"success": False, "message": "apiKey required"}), 400

    cur_lang = pm.get_plugin_language(d)
    system = (
        f"你是一个代码修改助手。只输出修改后的完整 {cur_lang} 代码（用 ```{cur_lang} 代码块包裹），不要解释。"
        "如果需要 root 权限，请直接使用 sudo（运行环境会自动注入已保存的 root 密码）。\n\n"
        + (pm.PLUGIN_OUTPUT_FORMAT_BASH if cur_lang == 'bash' else pm.PLUGIN_OUTPUT_FORMAT_PY)
    )
    ctx_block = (
        f"\n\n用户引用的关键上下文（来自上一次执行的输出/选中文本，请重点参考）：\n```\n{context}\n```\n"
        if context else ""
    )
    user = (
        f"当前代码（{cur_lang}）：\n```{cur_lang}\n{current_code}\n```\n\n"
        f"修改需求：{msg}{ctx_block}\n\n请输出修改后的完整代码（使用 ```{cur_lang} 代码块）。"
    )
    try:
        ai_text = _llm_chat(base_url, api_key, model, system, user, max_tokens=4000, temperature=0.2)
        new_code, new_lang = pm.extract_code(ai_text, default_language=cur_lang)
        if not new_code:
            return jsonify({"success": False, "message": "无法提取代码", "ai_response": ai_text})
        final_lang = pm.update_plugin_main(d, new_code, language=new_lang)
        sudo_pwd = _read_sudo_password()
        exec_r = pm.execute_plugin(d, auto_install=True, sudo_password=sudo_pwd)
        exec_r["code"] = new_code
        exec_r["language"] = final_lang
        success = bool(exec_r.get("success"))
        attempts = [{
            "attempt": 1, "success": success,
            "language": final_lang, "returncode": exec_r.get("returncode"),
        }]

        progress = []
        if auto_fix and not success:
            try:
                # 这里把"用户修改需求 + 引用上下文"作为 message + extra_user_context
                # 让自动修复回路也能利用用户提供的关键信息。
                final, progress = _drive_autofix(
                    d, msg, new_code, final_lang, exec_r,
                    base_url, api_key, model, sudo_pwd,
                    max_attempts=max_attempts, start_attempt=1, attempts=attempts,
                    extra_user_context=context or None,
                )
                exec_r = final["exec_r"]
                new_code = final["code"]
                final_lang = final["language"]
                attempts = final["attempts"]
            except Exception as e:
                logger.error(f"plugin_chat auto-fix error: {e}")

        exec_r["attempts"] = attempts
        exec_r["code"] = new_code
        exec_r["language"] = final_lang
        if progress:
            exec_r["progress"] = progress

        return jsonify({
            "success": True, "message": "ok",
            "code": new_code, "language": final_lang,
            "exec_result": exec_r,
        })
    except Exception as e:
        logger.error(f"Plugin chat error: {e}")
        return jsonify({"success": False, "message": str(e)})


@app.route('/api/plugins/<plugin_name>', methods=['DELETE'])
def delete_plugin(plugin_name):
    if not pm:
        return jsonify({"error": "Plugins not available"}), 404
    import shutil
    d = pm.PLUGINS_DIR / plugin_name
    if not d.is_dir():
        return jsonify({"error": "Plugin not found"}), 404
    shutil.rmtree(d)
    return jsonify({"message": "deleted"})


@app.route('/api/plugins/<plugin_name>/output/<path:filename>')
def plugin_output_file(plugin_name, filename):
    if not pm:
        return jsonify({"error": "Not found"}), 404
    d = pm.PLUGINS_DIR / plugin_name / "output"
    safe = os.path.basename(filename)
    path = os.path.join(d, safe)
    if not os.path.isfile(path):
        return jsonify({"error": "File not found"}), 404
    return send_from_directory(d, safe)


_PLUGIN_GEN_SYSTEM = (
    "你是一个代码生成助手。用户描述任务，你只输出可执行代码（用代码块包裹），不要解释。\n"
    "请根据任务复杂度选择合适的语言：\n"
    "  - 系统命令组合（apt/systemctl/grep/awk/find/curl/dpkg…）优先用 ```bash``` 代码块。\n"
    "  - 数据处理 / 网络请求 / 计算 / 复杂格式化 / 需要丰富 JSON 输出，优先用 ```python``` 代码块。\n\n"
    "【单文件输出】简单任务直接用 ```bash``` 或 ```python``` 一个代码块即可。\n\n"
    "【多文件项目输出 — 推荐用于复杂任务】\n"
    "当任务涉及多个模块、需要配置/依赖说明、需要拆分通用工具时，请按项目工程组织代码。"
    "为每个文件单独使用代码块，并在 fence 上以 `语言:相对路径` 形式声明路径，例如：\n"
    "    ```python:main.py\n    ...入口代码...\n    ```\n"
    "    ```python:lib/utils.py\n    ...通用函数...\n    ```\n"
    "    ```text:requirements.txt\n    requests==2.31.0\n    ```\n"
    "硬性约束：\n"
    "  - 入口文件必须命名 main.py 或 main.sh；\n"
    "  - 路径只能用相对路径，不能含 .. 或绝对路径；\n"
    "  - 多文件项目仍需保证入口文件结尾按规定输出 ===PLUGIN_RESULT=== 行。\n\n"
    "【root 权限】如果需要 root 权限，请直接使用 sudo（运行环境会自动注入已保存的 root 密码，bash 中的 sudo 会从 stdin 读密码；"
    "python 中如需 sudo，建议封装为 bash 子命令调用，例如 subprocess.run(['bash','-lc','sudo apt-get …'])）。\n\n"
    "【语法要求】你输出的代码会先经过 `bash -n` / `ast.parse` 静态语法检查，请确保没有低级语法错误。\n\n"
    "Bash 输出格式说明：\n" + pm.PLUGIN_OUTPUT_FORMAT_BASH +
    "\nPython 输出格式说明：\n" + pm.PLUGIN_OUTPUT_FORMAT_PY
) if pm else ""


_PLUGIN_FIX_SYSTEM = (
    "你是一个代码修复助手。给定原代码（含语言）和实际运行的失败日志，"
    "请输出修复后的完整代码（同语言，用同样的代码块包裹），不要解释。"
    "如果错误是因为缺少依赖、权限不足等系统层面的问题，请在脚本里增加适当的安装/sudo 命令。"
    "需要 root 权限请直接使用 sudo（运行环境会自动注入密码）。\n\n"
    "Bash 输出格式：\n" + pm.PLUGIN_OUTPUT_FORMAT_BASH +
    "\nPython 输出格式：\n" + pm.PLUGIN_OUTPUT_FORMAT_PY
) if pm else ""


def _summarize_plugin_failure(exec_r: dict) -> str:
    """从执行结果里挑最关键的错误片段（最近 ~3500 字）。"""
    parts = []
    res = exec_r.get('result') or {}
    if isinstance(res, dict):
        if res.get('type') == 'text' and res.get('content'):
            parts.append(str(res['content']))
        else:
            for it in (res.get('content') or []):
                if isinstance(it, dict) and it.get('type') == 'status' and it.get('status') == 'error':
                    parts.append(str(it.get('message', '')))
    if exec_r.get('stderr'):
        parts.append(f"[stderr]\n{exec_r['stderr']}")
    if exec_r.get('stdout'):
        parts.append(f"[stdout]\n{exec_r['stdout']}")
    if exec_r.get('returncode') is not None:
        parts.append(f"[exit_code] {exec_r.get('returncode')}")
    text = "\n".join(p for p in parts if p).strip()
    return text[-3500:] if text else "(no output)"


def _plugin_step_event(phase: str, status: str, message: str, **extra) -> dict:
    """构造一条插件执行过程事件（供 SSE 流和最终汇总都使用）。

    phase  ∈ {'gen','validate','create','exec','fix','error'}
    status ∈ {'running','done','error','info','output'}  output 表示插件子进程的行级 stdout/stderr
    """
    ev = {
        "type": "step",
        "phase": phase,
        "status": status,
        "message": message,
        "ts": time.time(),
    }
    ev.update(extra)
    return ev


def _stream_execute_with_events(plugin_dir, phase, attempt, sudo_pwd):
    """用流式插件执行 + Queue 桥接，把行级 stdout/stderr 作为 step 事件 yield 出来。

    生成器：
      - 中途 yield `_plugin_step_event(phase, 'output', '', attempt=N, stream='stdout|stderr', text='...\\n')`
      - 最后 yield `{'type':'_exec_done', 'exec_r': {...}}`
    """
    q: queue.Queue = queue.Queue()
    result_holder: dict = {}
    SENTINEL = object()

    def on_output(stream_name: str, text: str):
        q.put((stream_name, text))

    def runner():
        try:
            result_holder['exec_r'] = pm.stream_execute_plugin(
                plugin_dir, auto_install=True, sudo_password=sudo_pwd,
                on_output=on_output,
            )
        except Exception as e:
            result_holder['error'] = str(e)
            logger.error(f"_stream_execute_with_events runner error: {e}")
        finally:
            q.put(SENTINEL)

    t = threading.Thread(target=runner, daemon=True)
    t.start()

    while True:
        item = q.get()
        if item is SENTINEL:
            break
        stream_name, text = item
        yield _plugin_step_event(
            phase, "output", "",  # message 留空，前端按 text 渲染
            attempt=attempt, stream=stream_name, text=text,
        )
    t.join(timeout=1)

    exec_r = result_holder.get('exec_r')
    if exec_r is None:
        exec_r = {
            "success": False,
            "result": {"type": "mixed", "content": [
                {"type": "status", "status": "error", "message": result_holder.get('error') or "插件执行内部错误"},
            ]},
            "stdout": "",
            "stderr": result_holder.get('error') or "",
            "returncode": -1,
        }
    yield {"type": "_exec_done", "exec_r": exec_r}


def _plugin_autofix_loop(plugin_dir, message, code, language, exec_r,
                          base_url, api_key, model, sudo_pwd,
                          max_attempts=3, start_attempt=1, attempts=None,
                          extra_user_context=None):
    """从一次 exec_r 之后开始的自动修复循环（基于错误日志 → 调 LLM → 重新执行）。

    生成器：yield 中间步骤事件 (`type='step'`)；
    最后 yield 一个 `{'type': '_autofix_done', 'exec_r': ..., 'code': ..., 'language': ..., 'attempts': [...]}`
    用于上层拿到收尾后的状态。

    参数：
      start_attempt: 进入本循环之前已经尝试过的次数（从 1 起算）。
      max_attempts:  总尝试次数上限（含已经发生的尝试）。
      attempts:      已有的尝试记录，会在原 list 上追加。
      extra_user_context: 可选，作为修复 prompt 的额外上下文（例如用户选中/引用的输出片段）。
    """
    if attempts is None:
        attempts = []
    success = bool(exec_r.get("success"))
    attempt = start_attempt

    while not success and attempt < max_attempts:
        attempt += 1
        failure = _summarize_plugin_failure(exec_r)
        yield _plugin_step_event(
            "fix", "running",
            f"调用 LLM 修复代码（第 {attempt}/{max_attempts} 次）...",
            attempt=attempt, failure_preview=failure[-600:],
        )
        ctx_block = (
            f"\n\n用户额外上下文（人工引用的关键信息，请重点参考）：\n```\n{extra_user_context}\n```\n"
            if extra_user_context else ""
        )
        fix_user = (
            f"原任务：\n{message}\n\n"
            f"原语言：{language}\n"
            f"原代码：\n```{language}\n{code}\n```\n\n"
            f"运行失败日志（最近 {len(failure)} 字）：\n```\n{failure}\n```{ctx_block}\n"
            f"请输出**修复后的完整代码**，仍用 ```{language}``` 代码块包裹。"
            "若必须切换语言才能解决，可以改用另一种代码块。"
        )
        try:
            ai_text = _llm_chat(
                base_url, api_key, model,
                _PLUGIN_FIX_SYSTEM, fix_user,
                max_tokens=3000, temperature=0.2,
            )
        except Exception as e:
            err_msg = f"LLM 调用失败: {e}"
            logger.warning(f"plugin auto-fix LLM error (attempt {attempt}): {e}")
            yield _plugin_step_event("fix", "error", err_msg, attempt=attempt)
            attempts.append({
                "attempt": attempt, "success": False,
                "language": language, "error": err_msg,
            })
            break

        new_code, new_lang = pm.extract_code(ai_text, default_language=language)
        if not new_code:
            err_msg = "LLM 未返回可用代码"
            yield _plugin_step_event("fix", "error", err_msg, attempt=attempt)
            attempts.append({
                "attempt": attempt, "success": False,
                "language": language, "error": err_msg,
            })
            break

        language = new_lang or language
        code = new_code
        code_lines = len(code.splitlines())
        pm.update_plugin_main(plugin_dir, code, language=language)
        yield _plugin_step_event(
            "fix", "done",
            f"修复后的 {language} 代码已写入（{code_lines} 行）",
            attempt=attempt, language=language,
            code_lines=code_lines, code_preview=code[:1500],
        )

        yield _plugin_step_event(
            "exec", "running", f"执行第 {attempt} 次（实时日志见下方）...", attempt=attempt,
        )
        # 流式执行 + 行级输出事件
        exec_r = None
        for ev in _stream_execute_with_events(plugin_dir, "exec", attempt, sudo_pwd):
            if ev.get("type") == "_exec_done":
                exec_r = ev["exec_r"]
            else:
                yield ev
        exec_r = exec_r or {"success": False, "returncode": -1, "stdout": "", "stderr": "exec failed"}
        exec_r["code"] = code
        exec_r["language"] = language
        success = bool(exec_r.get("success", False))
        rc = exec_r.get("returncode")
        attempts.append({
            "attempt": attempt, "success": success,
            "language": language, "returncode": rc,
        })
        yield _plugin_step_event(
            "exec", "done" if success else "error",
            (f"✅ 第 {attempt} 次执行成功" if success
             else f"❌ 第 {attempt} 次执行失败（exit={rc}）"),
            attempt=attempt, success=success, returncode=rc,
        )

    yield {
        "type": "_autofix_done",
        "exec_r": exec_r,
        "code": code,
        "language": language,
        "attempts": attempts,
    }


def _drive_autofix(plugin_dir, message, code, language, exec_r,
                    base_url, api_key, model, sudo_pwd,
                    max_attempts=3, start_attempt=1, attempts=None,
                    extra_user_context=None):
    """非生成器封装：把 `_plugin_autofix_loop` 的事件收集到 progress 列表，返回最终结果。"""
    progress = []
    final = {
        "exec_r": exec_r, "code": code,
        "language": language,
        "attempts": attempts if attempts is not None else [],
    }
    for ev in _plugin_autofix_loop(
        plugin_dir, message, code, language, exec_r,
        base_url, api_key, model, sudo_pwd,
        max_attempts=max_attempts, start_attempt=start_attempt,
        attempts=attempts, extra_user_context=extra_user_context,
    ):
        if ev.get("type") == "_autofix_done":
            final = ev
        else:
            progress.append(ev)
    return final, progress


def _run_plugin_pipeline(message, base_url, api_key, model, sudo_pwd,
                          auto_fix=True, max_attempts=3):
    """生成器：执行 plugin 流水线，逐步 yield 进度事件，最后 yield 一个 {'type':'final', ...}。

    事件协议：
      {'type':'step','phase':'gen','status':'running','message':'调用 LLM 生成代码...'}
      {'type':'step','phase':'gen','status':'done','message':'已生成 python 代码 (24 行)','language':'python','code_lines':24,'code_preview':'...'}
      {'type':'step','phase':'create','status':'done','message':'插件 plugin_xxx 已创建','plugin_name':'plugin_xxx','language':'python'}
      {'type':'step','phase':'exec','status':'running','attempt':1,'message':'执行第 1 次...'}
      {'type':'step','phase':'exec','status':'done|error','attempt':1,'success':bool,'returncode':int,'message':'...'}
      {'type':'step','phase':'fix','status':'running','attempt':2,'message':'调用 LLM 修复代码...'}
      {'type':'step','phase':'fix','status':'done','attempt':2,'language':'python','code_lines':30,'code_preview':'...'}
      {'type':'final','response':'...','plugin_result':{...}}
    """
    attempts: list = []

    yield _plugin_step_event("gen", "running", "调用 LLM 生成插件代码...")
    try:
        ai_text = _llm_chat(
            base_url, api_key, model,
            _PLUGIN_GEN_SYSTEM,
            f"请为以下任务生成代码（自行选择 bash 或 python 中更合适的一种）：{message}",
            max_tokens=3000, temperature=0.2,
        )
    except Exception as e:
        msg = f"LLM 调用失败: {e}"
        yield _plugin_step_event("gen", "error", msg)
        yield {
            "type": "final",
            "response": "请求失败",
            "plugin_result": {
                "success": False,
                "result": {"type": "mixed", "content": [
                    {"type": "status", "status": "error", "message": msg}
                ]},
                "attempts": attempts,
            },
        }
        return

    # 优先尝试多文件项目工程化输出；不行再回退单文件
    project = pm.extract_project_files(ai_text)
    files: list = []
    if project:
        files = project['files']
        language = project['language']
        entry = project['entry']
        code = next((f['content'] for f in files if f['path'] == entry), files[0]['content'])
    else:
        code, language = pm.extract_code(ai_text)
        entry = None
        if not code:
            msg = "未在 LLM 输出中识别到 bash/python 代码块"
            yield _plugin_step_event("gen", "error", msg)
            yield {
                "type": "final",
                "response": "无法生成有效代码",
                "plugin_result": {
                    "success": False,
                    "result": {"type": "mixed", "content": [
                        {"type": "status", "status": "error", "message": msg}
                    ]},
                    "ai_response": ai_text,
                    "attempts": attempts,
                },
            }
            return

    code_lines = len(code.splitlines())
    if files:
        yield _plugin_step_event(
            "gen", "done",
            f"已生成 {language} 项目（{len(files)} 个文件，入口 {entry}）",
            language=language, code_lines=code_lines, code_preview=code[:1500],
            files=[{'path': f['path'], 'language': f['language']} for f in files],
        )
    else:
        yield _plugin_step_event(
            "gen", "done",
            f"已生成 {language} 代码（{code_lines} 行）",
            language=language, code_lines=code_lines, code_preview=code[:1500],
        )

    # === 语法校验 + 失败时一轮自动修复 ===
    yield _plugin_step_event("validate", "running", "运行语法检查...")
    if files:
        ok, errs = pm.validate_project_files(files)
        err_text = '\n\n'.join(errs)
    else:
        ok, err_text = pm.validate_syntax(code, language)
    if ok:
        yield _plugin_step_event("validate", "done", "✅ 语法检查通过")
    else:
        yield _plugin_step_event(
            "validate", "error",
            "❌ 生成代码存在语法错误，调用 LLM 修复中...",
            validation_error=err_text[:1500],
        )
        fix_user = (
            f"原任务：\n{message}\n\n"
            f"以下 {language} 代码存在语法错误：\n```{language}\n{code}\n```\n\n"
            f"语法检查报告：\n```\n{err_text}\n```\n\n"
            f"请只修复语法问题，输出修复后的完整代码（仍用 ```{language}``` 包裹）。"
            + ("\n（如果是多文件项目，请保留原有文件路径结构，使用 ```lang:path 形式包裹每个文件。）"
               if files else "")
        )
        try:
            ai_fix = _llm_chat(
                base_url, api_key, model,
                _PLUGIN_FIX_SYSTEM, fix_user,
                max_tokens=4000, temperature=0.1,
            )
            project2 = pm.extract_project_files(ai_fix) if files else None
            if project2:
                files = project2['files']
                language = project2['language']
                entry = project2['entry']
                code = next((f['content'] for f in files if f['path'] == entry), files[0]['content'])
                ok2, errs2 = pm.validate_project_files(files)
                err_text2 = '\n\n'.join(errs2)
            else:
                new_code, new_lang = pm.extract_code(ai_fix, default_language=language)
                if new_code:
                    code = new_code
                    language = new_lang or language
                    files = []
                ok2, err_text2 = pm.validate_syntax(code, language)
            if ok2:
                yield _plugin_step_event(
                    "validate", "done",
                    "✅ 语法已自动修复通过",
                    code_preview=code[:1500], code_lines=len(code.splitlines()),
                )
            else:
                yield _plugin_step_event(
                    "validate", "error",
                    "⚠ 修复后仍有语法错误，将照常执行（运行时若失败会再走自动修复）",
                    validation_error=err_text2[:1500],
                )
        except Exception as e:
            yield _plugin_step_event(
                "validate", "error",
                f"⚠ 语法修复失败（{e}），将照常执行",
            )

    name = pm.generate_plugin_name(message)
    plugin_dir = pm.create_plugin(
        name,
        code=code if not files else '',
        description=message,
        language=language,
        files=files if files else None,
        entry=entry,
    )
    yield _plugin_step_event(
        "create", "done",
        f"插件 {name} 已创建" + (f"（{len(files)} 个文件）" if files else ""),
        plugin_name=name, language=language,
    )

    yield _plugin_step_event("exec", "running", "执行第 1 次（实时日志见下方）...", attempt=1)
    exec_r = None
    for ev in _stream_execute_with_events(plugin_dir, "exec", 1, sudo_pwd):
        if ev.get("type") == "_exec_done":
            exec_r = ev["exec_r"]
        else:
            yield ev
    exec_r = exec_r or {"success": False, "returncode": -1, "stdout": "", "stderr": "exec failed"}
    exec_r["code"] = code
    exec_r["language"] = language
    success = bool(exec_r.get("success", False))
    rc = exec_r.get("returncode")
    attempts.append({
        "attempt": 1, "success": success, "language": language, "returncode": rc,
    })
    yield _plugin_step_event(
        "exec", "done" if success else "error",
        ("✅ 第 1 次执行成功" if success
         else f"❌ 第 1 次执行失败（exit={rc}）"),
        attempt=1, success=success, returncode=rc,
    )

    if auto_fix and not success:
        for ev in _plugin_autofix_loop(
            plugin_dir, message, code, language, exec_r,
            base_url, api_key, model, sudo_pwd,
            max_attempts=max_attempts, start_attempt=1, attempts=attempts,
        ):
            if ev.get("type") == "_autofix_done":
                exec_r = ev["exec_r"]
                code = ev["code"]
                language = ev["language"]
                attempts = ev["attempts"]
                success = bool(exec_r.get("success"))
            else:
                yield ev

    exec_r["attempts"] = attempts
    if success and len(attempts) > 1:
        response = f"✅ 插件执行成功（自动修复 {len(attempts) - 1} 次后通过）"
    elif success:
        response = "✅ 插件执行成功"
    else:
        response = f"❌ 插件执行失败（已尝试 {len(attempts)} 次）"

    yield {"type": "final", "response": response, "plugin_result": exec_r}


def _validate_plugin_chat_request(data):
    """复用的请求体校验。返回 (err_response, status) 或 (None, None)。"""
    message = (data.get("message") or "").strip()
    base_url = (data.get("baseUrl") or "").rstrip("/")
    api_key = data.get("apiKey") or ""
    model = data.get("model") or ""
    if not message:
        return jsonify({"error": "message required"}), 400
    if not pm:
        return jsonify({"error": "Plugins not available"}), 503
    if not base_url or not model:
        return jsonify({"error": "baseUrl, model required"}), 400
    if not api_key and not _is_local_baseurl(base_url):
        return jsonify({"error": "apiKey required"}), 400
    return None, None


@app.route('/api/chat-with-plugin', methods=['POST'])
def chat_with_plugin():
    """非流式接口：跑完整个流水线，返回最终结果与全部过程事件 (progress[])。"""
    data = request.json or {}
    err, code_ = _validate_plugin_chat_request(data)
    if err is not None:
        return err, code_

    message = (data.get("message") or "").strip()
    base_url = (data.get("baseUrl") or "").rstrip("/")
    api_key = data.get("apiKey") or ""
    model = data.get("model") or ""
    auto_fix = bool(data.get("auto_fix", True))
    try:
        max_attempts = int(data.get("max_attempts") or 3)
    except Exception:
        max_attempts = 3
    max_attempts = max(1, min(5, max_attempts))

    sudo_pwd = _read_sudo_password()
    progress: list = []
    final_payload = None
    try:
        for ev in _run_plugin_pipeline(
            message, base_url, api_key, model,
            sudo_pwd, auto_fix=auto_fix, max_attempts=max_attempts,
        ):
            if ev.get("type") == "final":
                final_payload = ev
            else:
                progress.append(ev)
    except Exception as e:
        logger.error(f"Chat-with-plugin error: {e}")
        return jsonify({
            "response": "请求失败",
            "plugin_result": {
                "success": False,
                "result": {"type": "mixed", "content": [
                    {"type": "status", "status": "error", "message": str(e)}
                ]},
                "attempts": [],
            },
            "progress": progress,
        })

    if not final_payload:
        return jsonify({
            "response": "请求失败",
            "plugin_result": {
                "success": False,
                "result": {"type": "mixed", "content": [
                    {"type": "status", "status": "error", "message": "插件流水线未返回最终结果"}
                ]},
                "attempts": [],
            },
            "progress": progress,
        })

    return jsonify({
        "response": final_payload.get("response", ""),
        "plugin_result": final_payload.get("plugin_result") or {},
        "progress": progress,
    })


@app.route('/api/chat-with-plugin/stream', methods=['POST'])
def chat_with_plugin_stream():
    """SSE 流式接口：把插件流水线的关键过程实时推送给前端。

    每个事件是一行：data: <json>\\n\\n
    事件 type 取值：
      - 'step'  : 中间步骤（phase/status/message/...）
      - 'final' : {'response':'...', 'plugin_result':{...}}
    最后会发 'data: [DONE]\\n\\n'。
    """
    data = request.json or {}
    err, code_ = _validate_plugin_chat_request(data)
    if err is not None:
        return err, code_

    message = (data.get("message") or "").strip()
    base_url = (data.get("baseUrl") or "").rstrip("/")
    api_key = data.get("apiKey") or ""
    model = data.get("model") or ""
    auto_fix = bool(data.get("auto_fix", True))
    try:
        max_attempts = int(data.get("max_attempts") or 3)
    except Exception:
        max_attempts = 3
    max_attempts = max(1, min(5, max_attempts))

    sudo_pwd = _read_sudo_password()

    def gen():
        try:
            for ev in _run_plugin_pipeline(
                message, base_url, api_key, model,
                sudo_pwd, auto_fix=auto_fix, max_attempts=max_attempts,
            ):
                yield 'data: ' + json.dumps(ev, ensure_ascii=False) + '\n\n'
        except GeneratorExit:
            return
        except Exception as e:
            logger.error(f"chat-with-plugin/stream error: {e}")
            yield 'data: ' + json.dumps(
                _plugin_step_event("error", "error", str(e)),
                ensure_ascii=False,
            ) + '\n\n'
            yield 'data: ' + json.dumps({
                "type": "final",
                "response": "请求失败",
                "plugin_result": {
                    "success": False,
                    "result": {"type": "mixed", "content": [
                        {"type": "status", "status": "error", "message": str(e)}
                    ]},
                    "attempts": [],
                },
            }, ensure_ascii=False) + '\n\n'
        yield 'data: [DONE]\n\n'

    headers = {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',
        'Connection': 'keep-alive',
    }
    return Response(stream_with_context(gen()), headers=headers)


# ============================================================
# API Routes - File Save
# ============================================================
@app.route('/api/save-file', methods=['POST'])
def save_file():
    """Save code content to a file in the workspace directory."""
    data = request.json
    filename = data.get('filename', '')
    content = data.get('content', '')

    if not filename:
        return jsonify({"error": "filename is required"}), 400

    safe_name = os.path.basename(filename)
    if not safe_name:
        return jsonify({"error": "Invalid filename"}), 400

    filepath = os.path.join(WORKSPACE_DIR, safe_name)

    try:
        with open(filepath, 'w', encoding='utf-8') as f:
            f.write(content)
        logger.info(f"Saved file: {filepath}")
        return jsonify({
            "status": "saved",
            "path": filepath,
            "filename": safe_name,
            "size": len(content),
        })
    except Exception as e:
        logger.error(f"Save file error: {e}")
        return jsonify({"error": str(e)}), 500


# ============================================================
# 智能保存：从代码推断准确文件名 + 检测依赖 + 生成可运行 shell 脚本
# ============================================================
_SAVE_LANG_EXT = {
    'python': 'py', 'py': 'py',
    'javascript': 'js', 'js': 'js', 'node': 'js',
    'typescript': 'ts', 'ts': 'ts',
    'bash': 'sh', 'sh': 'sh', 'shell': 'sh',
    'html': 'html', 'css': 'css', 'json': 'json',
    'java': 'java', 'cpp': 'cpp', 'c++': 'cpp', 'cxx': 'cpp', 'c': 'c',
    'go': 'go', 'rust': 'rs', 'rs': 'rs', 'ruby': 'rb', 'php': 'php',
    'sql': 'sql', 'yaml': 'yaml', 'yml': 'yml', 'xml': 'xml',
    'markdown': 'md', 'md': 'md', 'txt': 'txt',
}


def _slugify_name(s, default='script'):
    s = re.sub(r'[^A-Za-z0-9._-]+', '_', (s or '').strip()).strip('._-')
    return s or default


def _camel_to_snake(s):
    s = re.sub(r'(?<!^)(?=[A-Z])', '_', s or '').lower()
    return re.sub(r'_+', '_', s).strip('_') or 'script'


def _infer_code_filename(code, language):
    """从代码内容推断一个准确的文件名（含扩展名）。
    优先级：注释里的显式文件名 → 语言特定的类/函数/标题名 → 兜底。"""
    lang = (language or '').lower()
    ext = _SAVE_LANG_EXT.get(lang) or (lang if (lang and lang.isalnum()) else 'txt')
    lines = code.splitlines()
    head = '\n'.join(lines[:25])

    # 1) 注释里的显式文件名提示： filename: x.py / 文件名：x.py
    m = re.search(r'(?:file\s*name|filename|file|文件名|脚本名)\s*[:：]\s*[`"\']?([\w\-./]+\.[A-Za-z0-9]+)', head, re.I)
    if not m:
        # 单独一行的文件名注释： `# foo.py` / `// foo.js` / `<!-- a.html -->`
        m = re.search(r'^\s*(?:#|//|--|;|<!--|/\*)\s*([\w\-]+\.[A-Za-z0-9]+)\s*(?:-->|\*/)?\s*$', head, re.M)
    if m:
        cand = os.path.basename(m.group(1))
        stem, _dot, e = cand.rpartition('.')
        if stem:
            return _slugify_name(stem) + '.' + (e or ext)

    base = 'script'
    if lang == 'java':
        jm = (re.search(r'public\s+(?:final\s+|abstract\s+)?class\s+(\w+)', code)
              or re.search(r'\bclass\s+(\w+)', code))
        return (jm.group(1) if jm else 'Main') + '.java'  # Java 文件名须与 public class 同名
    if lang == 'html':
        tm = re.search(r'<title[^>]*>\s*(.*?)\s*</title>', code, re.I | re.S)
        base = _slugify_name((tm.group(1)[:40] if tm and tm.group(1).strip() else ''), 'index')
    elif lang in ('python', 'py'):
        cm = re.search(r'^\s*class\s+(\w+)', code, re.M)
        fm = re.search(r'^\s*def\s+(\w+)', code, re.M)
        if cm:
            base = _camel_to_snake(cm.group(1))
        elif fm and fm.group(1) not in ('main', 'run'):
            base = fm.group(1)
        else:
            base = 'script'
    elif lang in ('javascript', 'js', 'typescript', 'ts', 'node'):
        cm = (re.search(r'(?:export\s+default\s+)?class\s+(\w+)', code)
              or re.search(r'function\s+(\w+)', code)
              or re.search(r'(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(', code))
        base = _camel_to_snake(cm.group(1)) if cm else 'script'
    elif lang == 'css':
        base = 'style'
    elif lang == 'sql':
        base = 'query'
    elif lang in ('go', 'c', 'cpp', 'c++', 'cxx', 'rust', 'rs'):
        base = 'main'
    return _slugify_name(base) + '.' + ext


def _unique_workspace_name(fname):
    """若 workspace 下已存在同名文件，则追加 _1/_2… 避免覆盖。"""
    if not os.path.exists(os.path.join(WORKSPACE_DIR, fname)):
        return fname
    stem, dot, ext = fname.rpartition('.')
    if not stem:
        stem, ext, dot = fname, '', ''
    i = 1
    while True:
        cand = f"{stem}_{i}{dot}{ext}"
        if not os.path.exists(os.path.join(WORKSPACE_DIR, cand)):
            return cand
        i += 1


def _build_save_runner(language, filename, code):
    """生成运行用 shell 脚本内容。返回 (runner_name, script, deps, req_name)。
    不可运行的语言返回 ('', '', [], None)。脚本与代码文件同目录，用相对名引用。"""
    lang = (language or '').lower()
    stem = filename.rpartition('.')[0] or filename
    fq = shlex.quote(filename)
    sq = shlex.quote(stem)
    runner_name = f'run_{_slugify_name(stem)}.sh'
    header = ['#!/usr/bin/env bash', 'set -e', 'cd "$(dirname "$0")"', '']
    deps = []
    req_name = None
    body = []

    if lang in ('python', 'py'):
        deps = _detect_python_deps(code)
        req_name = 'requirements.txt'
        body += [
            'VENV=".venv-run"',
            '[ -x "$VENV/bin/python" ] || { echo "==> 创建虚拟环境 $VENV"; python3 -m venv "$VENV"; }',
            'if [ -f requirements.txt ]; then echo "==> 安装依赖 (requirements.txt)"; "$VENV/bin/pip" install -q -r requirements.txt; fi',
            'echo "==> 运行"',
            f'exec "$VENV/bin/python" {fq}',
        ]
    elif lang in ('javascript', 'js', 'node'):
        deps = _detect_node_deps(code)
        body += ['[ -f package.json ] || npm init -y >/dev/null 2>&1']
        if deps:
            body += [f'echo "==> 安装依赖: {" ".join(deps)}"',
                     f'npm install {" ".join(shlex.quote(d) for d in deps)}']
        body += ['echo "==> 运行"', f'exec node {fq}']
    elif lang in ('typescript', 'ts'):
        deps = _detect_node_deps(code)
        body += ['[ -f package.json ] || npm init -y >/dev/null 2>&1',
                 'command -v ts-node >/dev/null 2>&1 || { echo "==> 安装 ts-node"; npm install ts-node typescript; }']
        if deps:
            body += [f'npm install {" ".join(shlex.quote(d) for d in deps)}']
        body += ['echo "==> 运行"', f'exec npx ts-node {fq}']
    elif lang in ('bash', 'sh', 'shell'):
        body += ['echo "==> 运行"', f'exec bash {fq}']
    elif lang == 'c':
        libs = ''
        if re.search(r'#include\s*<math\.h>', code):
            libs += ' -lm'
        if re.search(r'#include\s*<pthread\.h>', code):
            libs += ' -lpthread'
        body += ['echo "==> 编译"', f'gcc -O2 {fq} -o {sq}{libs}', 'echo "==> 运行"', f'exec ./{sq}']
    elif lang in ('cpp', 'c++', 'cxx'):
        libs = ' -lpthread' if re.search(r'#include\s*<(thread|pthread\.h)>', code) else ''
        body += ['echo "==> 编译"', f'g++ -std=c++17 -O2 {fq} -o {sq}{libs}', 'echo "==> 运行"', f'exec ./{sq}']
    elif lang == 'go':
        has_third = bool(re.search(r'"[\w.-]+\.[\w.-]+/', code))  # 形如 github.com/x/y
        if has_third:
            body += ['[ -f go.mod ] || go mod init app >/dev/null 2>&1', 'go mod tidy || true']
        body += ['echo "==> 运行"', f'exec go run {fq}']
    elif lang == 'java':
        body += ['echo "==> 编译"', f'javac {fq}', 'echo "==> 运行"', f'exec java {sq}']
    elif lang in ('rust', 'rs'):
        body += ['echo "==> 编译"', f'rustc -O {fq} -o {sq}', 'echo "==> 运行"', f'exec ./{sq}']
    elif lang in ('ruby', 'rb'):
        body += ['echo "==> 运行"', f'exec ruby {fq}']
    elif lang == 'php':
        body += ['echo "==> 运行"', f'exec php {fq}']
    elif lang == 'html':
        body += ['echo "==> HTML 文件已保存，可使用前端预览按钮打开"']
    else:
        return ('', '', [], None)

    script = '\n'.join(header + body) + '\n'
    return (runner_name, script, deps, req_name)


@app.route('/api/save-code', methods=['POST'])
def save_code():
    """智能保存：推断文件名 → 保存代码 → 检测依赖(写 requirements.txt) → 生成 run_*.sh。
    body: { content|code, language, filename? }"""
    data = request.json or {}
    code = data.get('content') or data.get('code') or ''
    language = (data.get('language') or '').lower()
    explicit = (data.get('filename') or '').strip()
    if not code.strip():
        return jsonify({'error': 'content is required'}), 400

    if explicit:
        fname = os.path.basename(explicit)
        if '.' not in fname:
            fname = f"{fname}.{_SAVE_LANG_EXT.get(language, 'txt')}"
    else:
        fname = _infer_code_filename(code, language)
    fname = _unique_workspace_name(fname)
    filepath = os.path.join(WORKSPACE_DIR, fname)

    try:
        with open(filepath, 'w', encoding='utf-8') as f:
            f.write(code)
    except Exception as e:
        logger.error(f"save-code write error: {e}")
        return jsonify({'error': str(e)}), 500

    result = {
        'file': {'path': filepath, 'name': fname},
        'language': language,
        'deps': [],
        'extras': [],
    }

    runner_name, runner_script, deps, req_name = _build_save_runner(language, fname, code)
    result['deps'] = deps

    if req_name and deps:
        try:
            reqp = os.path.join(WORKSPACE_DIR, req_name)
            with open(reqp, 'w', encoding='utf-8') as f:
                f.write('\n'.join(deps) + '\n')
            result['extras'].append({'path': reqp, 'name': req_name, 'kind': 'requirements'})
            result['requirements'] = {'path': reqp, 'name': req_name}
        except Exception as e:
            logger.warning(f"save-code requirements error: {e}")

    if runner_script:
        try:
            runp = os.path.join(WORKSPACE_DIR, runner_name)
            with open(runp, 'w', encoding='utf-8') as f:
                f.write(runner_script)
            try:
                os.chmod(runp, 0o755)
            except Exception:
                pass
            result['runner'] = {'path': runp, 'name': runner_name, 'script': runner_script}
            result['extras'].append({'path': runp, 'name': runner_name, 'kind': 'runner'})
        except Exception as e:
            logger.warning(f"save-code runner error: {e}")

    logger.info(f"save-code: {fname} (deps={deps}, runner={runner_name if runner_script else '-'})")
    return jsonify(result)


@app.route('/api/markdown-to-files', methods=['POST'])
def markdown_to_files():
    data = request.json or {}
    content = data.get('content', '')
    folder = (data.get('folder') or 'project').strip().replace('..', '').replace('/', '_')
    if not content:
        return jsonify({"error": "content is required"}), 400
    ext_map = {
        'py': '.py', 'python': '.py', 'js': '.js', 'javascript': '.js', 'ts': '.ts', 'typescript': '.ts',
        'html': '.html', 'css': '.css', 'json': '.json', 'md': '.md', 'markdown': '.md', 'sh': '.sh',
        'bash': '.sh', 'sql': '.sql', 'yaml': '.yml', 'yml': '.yml', 'xml': '.xml', 'go': '.go',
        'rs': '.rs', 'rust': '.rs', 'java': '.java', 'c': '.c', 'cpp': '.cpp', 'rb': '.rb', 'php': '.php',
    }
    blocks = re.findall(r'```(\w*)\s*\n(.*?)```', content, re.DOTALL)
    out_dir = os.path.join(WORKSPACE_DIR, folder)
    os.makedirs(out_dir, exist_ok=True)
    saved = []
    for i, (lang, code) in enumerate(blocks):
        ext = ext_map.get(lang.lower(), '.txt') if lang else '.txt'
        safe_name = f"block_{i}{ext}"
        path = os.path.join(out_dir, safe_name)
        try:
            with open(path, 'w', encoding='utf-8') as f:
                f.write(code.rstrip('\n') + '\n')
            saved.append({"path": path, "name": safe_name})
        except Exception as e:
            logger.error(f"markdown-to-files save error: {e}")
    return jsonify({"saved": saved, "folder": folder})


# ============================================================
# API Routes - Code Execution (incl. sudo password for shell)
# ============================================================
RUN_CODE_TIMEOUT_SEC = 30  # 固定 30 秒，每次执行独立，不会累积

# 交互式运行会话：session_id -> { proc, temp_path, queue }
_run_sessions = {}
_run_sessions_lock = threading.Lock()


def _run_interactive_reader(proc, out_queue, run_input):
    """Thread: read from Popen stdout, then put exit code. Used for non-shell or when PTY unavailable."""
    try:
        if run_input:
            try:
                proc.stdin.write(run_input)
                proc.stdin.flush()
            except Exception:
                pass
        for line in iter(proc.stdout.readline, ''):
            out_queue.put(('out', line))
    except Exception:
        pass
    finally:
        try:
            proc.wait()
        except Exception:
            pass
        out_queue.put(('exit', getattr(proc, 'returncode', -1)))


def _run_shell_pty_reader(master_fd, pid, out_queue):
    """Thread: read from PTY master (shell script run), then waitpid and put exit. sudo 等可读 TTY 并提示输入密码."""
    try:
        while True:
            r, _, _ = select.select([master_fd], [], [], 0.05)
            if r:
                data = os.read(master_fd, 4096)
                if not data:
                    break
                out_queue.put(('out', data.decode('utf-8', errors='replace')))
    except (OSError, TypeError):
        pass
    finally:
        exit_code = -1
        try:
            _, status = os.waitpid(pid, 0)
            if os.WIFEXITED(status):
                exit_code = os.WEXITSTATUS(status)
        except OSError:
            pass
        out_queue.put(('exit', exit_code))


@app.route('/api/sudo-password-saved', methods=['GET'])
def sudo_password_saved():
    """Return whether a sudo password is stored (for frontend to skip dialog)."""
    return jsonify({"saved": _read_sudo_password() is not None})


@app.route('/api/sudo-password', methods=['POST'])
def save_sudo_password():
    """Save sudo password to workspace (e.g. after terminal prompts for it)."""
    data = request.json or {}
    password = (data.get('password') or '').strip()
    if not password:
        return jsonify({"error": "password required"}), 400
    _save_sudo_password(password)
    return jsonify({"ok": True})


def _run_saved_code(language, code, timeout_sec=30, compile_only=False):
    """Run a saved/compiled snippet through the same generated runner used by
    the Save action. This keeps compiler flags, Java class naming and runtime
    output identical between code blocks and project files."""
    lang = (language or '').strip().lower()
    run_dir = tempfile.mkdtemp(prefix='.run-code-', dir=WORKSPACE_DIR)
    try:
        filename = _infer_code_filename(code, lang)
        if lang == 'java':
            # _infer_code_filename already follows public class naming rules.
            filename = filename if filename.endswith('.java') else 'Main.java'
        code_path = os.path.join(run_dir, filename)
        os.makedirs(os.path.dirname(code_path), exist_ok=True)
        with open(code_path, 'w', encoding='utf-8') as handle:
            handle.write(code)

        runner_name, runner_script, _deps, _req_name = _build_save_runner(lang, filename, code)
        if not runner_script:
            return {
                'output': f"语言 {lang or '(未指定)'} 没有可用的编译/运行器",
                'exit_code': 1,
                'error': 'unsupported language runner',
            }
        # For compile-only requests, strip the run portion from the generated
        # runner and let the compiler's own diagnostics reach the UI.
        if compile_only and lang == 'go':
            lines = runner_script.splitlines()
            kept = []
            for line in lines:
                if line.strip() in {'echo "==> 运行"', 'echo "==> 执行"'}:
                    break
                kept.append(line)
            kept += ['echo "==> 编译 Go"', f'go build -o .run-code-bin {shlex.quote(filename)}']
            runner_script = '\n'.join(kept) + '\n'
        elif compile_only and lang in {'c', 'cpp', 'c++', 'cxx', 'java', 'rust', 'rs'}:
            lines = runner_script.splitlines()
            kept = []
            for line in lines:
                if line.strip() in {'echo "==> 运行"', 'echo "==> 执行"'}:
                    break
                if line.strip().startswith('exec ./') or line.strip().startswith('exec java '):
                    break
                kept.append(line)
            runner_script = '\n'.join(kept) + '\n'
        runner_path = os.path.join(run_dir, runner_name or 'run.sh')
        with open(runner_path, 'w', encoding='utf-8') as handle:
            handle.write(runner_script)
        os.chmod(runner_path, 0o755)
        result = subprocess.run(
            ['bash', runner_path],
            cwd=run_dir,
            capture_output=True,
            text=True,
            timeout=timeout_sec,
            env={**os.environ, 'PYTHONIOENCODING': 'utf-8'},
        )
        output = result.stdout or ''
        if result.stderr:
            output += ('\n' if output else '') + result.stderr
        return {
            'output': output,
            'exit_code': result.returncode,
            'error': result.stderr if result.returncode != 0 else None,
            'file': filename,
            'compiled': lang in {'c', 'cpp', 'c++', 'cxx', 'java', 'go', 'rust', 'rs'},
            'compile_only': bool(compile_only),
        }
    except subprocess.TimeoutExpired:
        return {'output': '', 'exit_code': 124, 'error': f'Execution timed out ({timeout_sec} second limit)'}
    except FileNotFoundError as exc:
        return {'output': '', 'exit_code': 127, 'error': f'Runtime/compiler not found: {exc}'}
    except Exception as exc:
        logger.exception('saved code execution failed')
        return {'output': '', 'exit_code': 1, 'error': str(exc)}
    finally:
        shutil.rmtree(run_dir, ignore_errors=True)


@app.route('/api/run-code', methods=['POST'])
def run_code():
    """Execute code and return the output. For shell with sudo, password can be sent or read from workspace file."""
    data = request.json or {}
    code = data.get('code', '')
    language = data.get('language', '')
    sudo_password = data.get('sudoPassword')  # optional; if provided, save and use
    compile_only = bool(data.get('compileOnly'))
    # 可选: 额外环境变量（agent 工作流把参数表单的值注入到这里）。仅接收 string→string。
    extra_env_raw = data.get('env')
    extra_env = {}
    if isinstance(extra_env_raw, dict):
        for k, v in extra_env_raw.items():
            try:
                key = str(k).strip()
                if not key or not re.match(r'^[A-Za-z_][A-Za-z0-9_]*$', key):
                    continue
                extra_env[key] = '' if v is None else str(v)
            except Exception:
                continue
    # 超时后再次 Run 可传 timeoutSeconds，每次延长 10s，本接口使用该值（限制 10～300 秒）
    timeout_sec = data.get('timeoutSeconds')
    if timeout_sec is not None:
        try:
            timeout_sec = max(10, min(300, int(timeout_sec)))
        except (TypeError, ValueError):
            timeout_sec = RUN_CODE_TIMEOUT_SEC
    else:
        timeout_sec = RUN_CODE_TIMEOUT_SEC

    if not code:
        return jsonify({"error": "code is required"}), 400

    # Compiled languages share the saved runner implementation. HTML is
    # treated as a successful render target; the frontend opens it in the
    # sandboxed preview panel after saving.
    compiled_languages = {'c', 'cpp', 'c++', 'cxx', 'java', 'rust', 'rs', 'go', 'ruby', 'rb', 'php', 'html'}
    if str(language).lower() in compiled_languages:
        result = _run_saved_code(language, code, timeout_sec=timeout_sec, compile_only=compile_only)
        return jsonify(result), (200 if result.get('exit_code') == 0 else 400)

    lang_config = {
        'python': {'cmd': [sys.executable], 'ext': '.py'},
        'py': {'cmd': [sys.executable], 'ext': '.py'},
        'javascript': {'cmd': ['node'], 'ext': '.js'},
        'js': {'cmd': ['node'], 'ext': '.js'},
        'bash': {'cmd': ['bash'], 'ext': '.sh'},
        'sh': {'cmd': ['sh'], 'ext': '.sh'},
        'shell': {'cmd': ['bash'], 'ext': '.sh'},
    }

    config = lang_config.get(language)
    if not config:
        return jsonify({
            "error": f"Unsupported language: '{language}'. Supported: {', '.join(lang_config.keys())}",
            "exit_code": 1,
        }), 400

    needs_sudo = language in ('bash', 'sh', 'shell') and 'sudo' in code
    run_input = None
    interactive = data.get('interactive')
    if needs_sudo:
        if interactive:
            # 交互模式：不自动送密码，让 "[sudo] 密码：" 等提示先显示，用户在前端输入框输入
            run_input = None
        else:
            pwd = sudo_password if sudo_password else _read_sudo_password()
            if pwd:
                if sudo_password:
                    _save_sudo_password(sudo_password)
                run_input = pwd.strip() + '\n'
            else:
                return jsonify({
                    "error": "此命令需要 sudo，请在前端输入密码后重试",
                    "exit_code": 1,
                    "needs_sudo": True,
                }), 400

    try:
        with tempfile.NamedTemporaryFile(
            mode='w', suffix=config['ext'], dir=WORKSPACE_DIR,
            delete=False, encoding='utf-8'
        ) as f:
            f.write(code)
            temp_path = f.name

        try:
            cmd = config['cmd'] + [temp_path]
            logger.info(f"Running: {' '.join(cmd)}" + (" (with sudo)" if run_input else ""))

            if interactive:
                session_id = str(uuid.uuid4())
                out_queue = queue.Queue()
                use_pty = (
                    language in ('bash', 'sh', 'shell') and _PTY_AVAILABLE
                )
                if use_pty:
                    env = os.environ.copy()
                    env.update({
                        'TERM': 'xterm-256color',
                        'COLORTERM': 'truecolor',
                        'LANG': os.environ.get('LANG', 'en_US.UTF-8'),
                    })
                    if extra_env:
                        env.update(extra_env)
                    pid, master_fd = pty.fork()
                    if pid == 0:
                        try:
                            os.chdir(WORKSPACE_DIR)
                        except Exception:
                            pass
                        os.execvpe('bash', ['bash', temp_path], env)
                    else:
                        t = threading.Thread(
                            target=_run_shell_pty_reader,
                            args=(master_fd, pid, out_queue),
                            daemon=True,
                        )
                        t.start()
                        with _run_sessions_lock:
                            _run_sessions[session_id] = {
                                'master_fd': master_fd,
                                'pid': pid,
                                'temp_path': temp_path,
                                'queue': out_queue,
                            }
                        return jsonify({"session_id": session_id, "interactive": True})
                else:
                    proc = subprocess.Popen(
                        cmd,
                        stdin=subprocess.PIPE,
                        stdout=subprocess.PIPE,
                        stderr=subprocess.STDOUT,
                        text=True,
                        bufsize=1,
                        cwd=WORKSPACE_DIR,
                        env={**os.environ, 'PYTHONIOENCODING': 'utf-8', **extra_env},
                    )
                    t = threading.Thread(
                        target=_run_interactive_reader,
                        args=(proc, out_queue, run_input),
                        daemon=True,
                    )
                    t.start()
                    with _run_sessions_lock:
                        _run_sessions[session_id] = {
                            'proc': proc,
                            'temp_path': temp_path,
                            'queue': out_queue,
                        }
                    return jsonify({"session_id": session_id, "interactive": True})
            else:
                result = subprocess.run(
                    cmd,
                    input=run_input,
                    capture_output=True,
                    text=True,
                    timeout=timeout_sec,
                    cwd=WORKSPACE_DIR,
                    env={**os.environ, 'PYTHONIOENCODING': 'utf-8', **extra_env},
                )

                output = result.stdout
                if result.stderr:
                    output += ('\n' if output else '') + result.stderr

                return jsonify({
                    "output": output,
                    "exit_code": result.returncode,
                    "error": result.stderr if result.returncode != 0 else None,
                })
        finally:
            if not interactive:
                try:
                    os.unlink(temp_path)
                except Exception:
                    pass

    except subprocess.TimeoutExpired:
        return jsonify({
            "error": f"Execution timed out ({timeout_sec} second limit)",
            "exit_code": 124,
            "output": "",
        })
    except FileNotFoundError as e:
        return jsonify({
            "error": f"Runtime not found: {e}. Make sure the language runtime is installed.",
            "exit_code": 127,
            "output": "",
        })
    except Exception as e:
        logger.error(f"Code execution error: {e}")
        return jsonify({"error": str(e), "exit_code": 1, "output": ""})


@app.route('/api/run-code-stream/<session_id>', methods=['GET'])
def run_code_stream(session_id):
    """SSE stream for interactive run output. Sends out/exit events."""
    with _run_sessions_lock:
        session = _run_sessions.get(session_id)
    if not session:
        return jsonify({"error": "session not found"}), 404

    def generate():
        out_queue = session['queue']
        try:
            while True:
                try:
                    item = out_queue.get(timeout=0.5)
                    if item[0] == 'out':
                        yield f"data: {json.dumps({'type': 'out', 'text': item[1]})}\n\n"
                    elif item[0] == 'exit':
                        exit_code = item[1]
                        yield f"data: {json.dumps({'type': 'exit', 'exit_code': exit_code})}\n\n"
                        break
                except queue.Empty:
                    if session.get('proc') and session['proc'].poll() is not None:
                        exit_code = session['proc'].returncode
                        yield f"data: {json.dumps({'type': 'exit', 'exit_code': exit_code})}\n\n"
                        break
                    yield "data: {\"type\":\"ping\"}\n\n"
        finally:
            with _run_sessions_lock:
                if session_id in _run_sessions:
                    s = _run_sessions.pop(session_id)
                    try:
                        if s.get('proc') and s['proc'].poll() is None:
                            s['proc'].kill()
                    except Exception:
                        pass
                    try:
                        if s.get('pid'):
                            try:
                                os.kill(s['pid'], signal.SIGTERM)
                            except OSError:
                                pass
                    except Exception:
                        pass
                    try:
                        if s.get('master_fd') is not None:
                            try:
                                os.close(s['master_fd'])
                            except OSError:
                                pass
                    except Exception:
                        pass
                    try:
                        if s.get('temp_path') and os.path.exists(s['temp_path']):
                            os.unlink(s['temp_path'])
                    except Exception:
                        pass

    return Response(
        stream_with_context(generate()),
        content_type='text/event-stream',
        headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'},
    )


@app.route('/api/run-code-input', methods=['POST'])
def run_code_input():
    """Send user input to an interactive run session (PTY or Popen). Body: { session_id, input }."""
    data = request.json or {}
    sid = data.get('session_id')
    if not sid:
        return jsonify({"error": "session_id required"}), 400
    with _run_sessions_lock:
        session = _run_sessions.get(sid)
    if not session:
        return jsonify({"error": "session not found"}), 404
    user_input = data.get('input', '')
    if not isinstance(user_input, str):
        user_input = str(user_input)
    if not user_input.endswith('\n'):
        user_input += '\n'
    payload = user_input.encode('utf-8')
    try:
        if session.get('master_fd') is not None:
            try:
                os.write(session['master_fd'], payload)
                return jsonify({"status": "ok"})
            except OSError as e:
                return jsonify({"error": str(e)}), 400
        proc = session.get('proc')
        if not proc or proc.poll() is not None:
            return jsonify({"error": "process already exited"}), 400
        proc.stdin.write(user_input)
        proc.stdin.flush()
        return jsonify({"status": "ok"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route('/api/run-code-kill', methods=['POST'])
def run_code_kill():
    """立即终止一个交互式执行会话（用户在 AI 工作流里点「停止」）。
    Body: { session_id }
    Returns: 200 {ok:true} | 404 session not found。"""
    data = request.json or {}
    sid = data.get('session_id')
    if not sid:
        return jsonify({"error": "session_id required"}), 400
    with _run_sessions_lock:
        session = _run_sessions.pop(sid, None)
    if not session:
        return jsonify({"ok": True, "note": "session not found (already finished)"}), 200
    # 复用与 SSE finally 一致的清理逻辑
    try:
        if session.get('proc') and session['proc'].poll() is None:
            session['proc'].kill()
    except Exception:
        pass
    try:
        if session.get('pid'):
            try:
                os.kill(session['pid'], signal.SIGTERM)
            except OSError:
                pass
    except Exception:
        pass
    try:
        if session.get('master_fd') is not None:
            try:
                os.close(session['master_fd'])
            except OSError:
                pass
    except Exception:
        pass
    try:
        if session.get('temp_path') and os.path.exists(session['temp_path']):
            os.unlink(session['temp_path'])
    except Exception:
        pass
    return jsonify({"ok": True})


@app.route('/api/run-code-inject-sudo', methods=['POST'])
def run_code_inject_sudo():
    """Inject the saved sudo password into a running interactive session.
    前端在检测到 [sudo] password 提示时调用，避免在前端持有明文密码。
    Body: { session_id }
    Returns: 200 {ok:true} | 404 session_not_found | 409 {saved:false} | 500 error.
    """
    data = request.json or {}
    sid = data.get('session_id')
    if not sid:
        return jsonify({"error": "session_id required"}), 400
    pwd = _read_sudo_password()
    if not pwd:
        return jsonify({"saved": False, "error": "no saved sudo password"}), 409
    with _run_sessions_lock:
        session = _run_sessions.get(sid)
    if not session:
        return jsonify({"error": "session not found"}), 404
    payload = (pwd.strip() + '\n').encode('utf-8')
    try:
        if session.get('master_fd') is not None:
            try:
                os.write(session['master_fd'], payload)
                return jsonify({"ok": True})
            except OSError as e:
                return jsonify({"error": str(e)}), 400
        proc = session.get('proc')
        if not proc or proc.poll() is not None:
            return jsonify({"error": "process already exited"}), 400
        proc.stdin.write(pwd.strip() + '\n')
        proc.stdin.flush()
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ============================================================
# API Routes - Terminal (Shell Command Execution)
# ============================================================
@app.route('/api/terminal-ws-available', methods=['GET'])
def terminal_ws_available():
    """Whether WebSocket PTY terminal is available (syntax highlight + interactive)."""
    return jsonify({"available": _PTY_AVAILABLE and _sock is not None})


@app.route('/api/terminal-env', methods=['GET'])
def terminal_env():
    """Return USER and HOST from environment for shell prompt matching."""
    user = os.environ.get('USER', '')
    host = os.environ.get('HOST', '') or os.environ.get('HOSTNAME', '')
    if not host:
        try:
            host = subprocess.run(
                ['hostname', '-s'],
                capture_output=True,
                text=True,
                timeout=2,
            ).stdout.strip() or ''
        except Exception:
            host = ''
    return jsonify({"USER": user, "HOST": host})


@app.route('/api/terminal', methods=['POST'])
def terminal_exec():
    """Execute a shell command and return the output."""
    data = request.json
    command = data.get('command', '').strip()
    cwd = data.get('cwd', terminal_cwd.get('path', WORKSPACE_DIR))

    if not command:
        return jsonify({"error": "command is required"}), 400

    if cwd == '~':
        cwd = os.path.expanduser('~')
    elif not os.path.isabs(cwd):
        cwd = os.path.join(WORKSPACE_DIR, cwd)
    if not os.path.isdir(cwd):
        cwd = WORKSPACE_DIR

    # Handle 'cd' command specially
    if command.startswith('cd '):
        target = command[3:].strip().strip('"').strip("'")
        if target == '~':
            new_cwd = os.path.expanduser('~')
        elif target == '-':
            new_cwd = terminal_cwd.get('prev', cwd)
        elif os.path.isabs(target):
            new_cwd = target
        else:
            new_cwd = os.path.normpath(os.path.join(cwd, target))

        if os.path.isdir(new_cwd):
            terminal_cwd['prev'] = cwd
            terminal_cwd['path'] = new_cwd
            return jsonify({
                "stdout": f"Changed directory to: {new_cwd}",
                "stderr": "", "exit_code": 0, "cwd": new_cwd,
            })
        else:
            return jsonify({
                "stdout": "",
                "stderr": f"cd: no such directory: {target}",
                "exit_code": 1, "cwd": cwd,
            })
    elif command == 'cd':
        home = os.path.expanduser('~')
        terminal_cwd['prev'] = cwd
        terminal_cwd['path'] = home
        return jsonify({"stdout": f"Changed directory to: {home}", "stderr": "", "exit_code": 0, "cwd": home})
    elif command == 'pwd':
        return jsonify({"stdout": cwd, "stderr": "", "exit_code": 0, "cwd": cwd})

    def stream_output():
        proc = None
        try:
            is_windows = platform.system() == 'Windows'
            env = {**os.environ, 'PYTHONIOENCODING': 'utf-8'}
            if is_windows:
                proc = subprocess.Popen(command, shell=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                       text=True, cwd=cwd, env=env, bufsize=1)
            else:
                proc = subprocess.Popen(['bash', '-c', command], stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                       text=True, cwd=cwd, env=env, bufsize=1)
            terminal_process['proc'] = proc
            for line in iter(proc.stdout.readline, ''):
                yield f"data: {json.dumps({'out': line})}\n\n"
            proc.wait()
        except Exception as e:
            logger.error(f"Terminal error: {e}")
            yield f"data: {json.dumps({'error': str(e)})}\n\n"
        finally:
            exit_code = proc.returncode if proc is not None else 1
            if proc is not None:
                terminal_process['proc'] = None
            yield f"data: {json.dumps({'exit': exit_code, 'cwd': cwd})}\n\n"

    terminal_cwd['path'] = cwd
    return Response(
        stream_with_context(stream_output()),
        content_type='text/event-stream',
        headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'},
    )


@app.route('/api/terminal-complete', methods=['POST'])
def terminal_complete():
    data = request.json or {}
    line = (data.get('line') or '').strip()
    cwd = data.get('cwd', terminal_cwd.get('path', WORKSPACE_DIR))
    if cwd == '~':
        cwd = os.path.expanduser('~')
    elif not os.path.isabs(cwd):
        cwd = os.path.join(WORKSPACE_DIR, cwd)
    if not os.path.isdir(cwd):
        cwd = WORKSPACE_DIR
    part = line.split()[-1] if line else ''
    if not part or part in ('', '.', '..'):
        base = cwd
        prefix = part or ''
    elif '/' in part or part.startswith('~'):
        if part.startswith('~'):
            base = os.path.expanduser(os.path.dirname(part) or '~')
        elif os.path.isabs(part):
            base = os.path.dirname(part) or os.path.sep
        else:
            base = os.path.normpath(os.path.join(cwd, os.path.dirname(part)))
        prefix = os.path.basename(part)
    else:
        base = cwd
        prefix = part
    if not os.path.isdir(base):
        return jsonify({"completions": []})
    try:
        names = os.listdir(base)
        completions = []
        for n in sorted(names):
            if n.startswith(prefix) or not prefix:
                path = os.path.join(base, n)
                completions.append(n + '/' if os.path.isdir(path) else n)
        return jsonify({"completions": completions[:50]})
    except Exception:
        return jsonify({"completions": []})


@app.route('/api/terminal-cancel', methods=['POST'])
def terminal_cancel():
    """Kill the currently running terminal command (e.g. ping)."""
    proc = terminal_process.get('proc')
    if proc is not None:
        try:
            proc.kill()
        except Exception:
            pass
        terminal_process['proc'] = None
    return jsonify({"ok": True})


# ============================================================
# API Routes - File Upload
# ============================================================
@app.route('/api/upload', methods=['POST'])
def upload_file():
    """Upload a file to the workspace directory."""
    if 'file' not in request.files:
        return jsonify({"error": "No file provided"}), 400

    file = request.files['file']
    if not file.filename:
        return jsonify({"error": "No filename"}), 400

    safe_name = os.path.basename(file.filename)
    filepath = os.path.join(WORKSPACE_DIR, safe_name)
    file.save(filepath)
    logger.info(f"Uploaded: {filepath}")
    return jsonify({"status": "uploaded", "path": filepath, "filename": safe_name})


# ============================================================
# API Routes - Workspace File Listing
# ============================================================
@app.route('/api/workspace', methods=['GET'])
def list_workspace():
    """List files in the workspace directory."""
    try:
        files = []
        for name in sorted(os.listdir(WORKSPACE_DIR)):
            fpath = os.path.join(WORKSPACE_DIR, name)
            if os.path.isfile(fpath):
                files.append({
                    "name": name,
                    "size": os.path.getsize(fpath),
                    "modified": os.path.getmtime(fpath),
                })
        return jsonify({"files": files, "path": WORKSPACE_DIR})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ============================================================
# API Routes - Preview HTML files from workspace
# ============================================================
@app.route('/api/preview/<path:filename>')
def preview_file(filename):
    """Serve a file from workspace for preview."""
    safe_name = os.path.basename(filename)
    filepath = os.path.join(WORKSPACE_DIR, safe_name)
    if not os.path.isfile(filepath):
        return jsonify({"error": "File not found"}), 404
    return send_from_directory(WORKSPACE_DIR, safe_name)


# ============================================================
# Transparent Proxy Routes
# ============================================================
@app.route('/proxy/<path:path>', methods=['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'])
def transparent_proxy(path):
    target_base = request.headers.get('X-Target-Base', '').rstrip('/')
    if not target_base:
        return jsonify({"error": "X-Target-Base header is required for proxy mode"}), 400

    target_url = f"{target_base}/{path}"
    headers = {}
    for key, value in request.headers:
        if key.lower() not in ('host', 'x-target-base', 'content-length', 'transfer-encoding'):
            headers[key] = value

    try:
        if request.method == 'GET':
            resp = http_requests.get(target_url, headers=headers, params=request.args, timeout=30)
        elif request.method == 'OPTIONS':
            return Response('', status=200)
        else:
            is_stream = False
            body = None
            if request.is_json:
                body = request.get_json(force=True)
                is_stream = body.get('stream', False)
            else:
                body = request.get_data()

            if is_stream:
                def generate():
                    with http_requests.post(target_url, json=body, headers=headers, stream=True, timeout=120) as r:
                        r.raise_for_status()
                        for line in r.iter_lines():
                            if line:
                                yield line.decode('utf-8') + '\n'

                return Response(
                    stream_with_context(generate()),
                    content_type='text/event-stream',
                    headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'}
                )
            else:
                resp = http_requests.request(
                    request.method, target_url,
                    json=body if request.is_json else None,
                    data=None if request.is_json else body,
                    headers=headers, timeout=30
                )

        response_headers = {}
        for key in ('content-type',):
            if key in resp.headers:
                response_headers[key] = resp.headers[key]

        return Response(resp.content, status=resp.status_code, headers=response_headers)

    except http_requests.exceptions.RequestException as e:
        logger.error(f"Proxy error: {e}")
        return jsonify({"error": str(e)}), 502


# ============================================================
# Serve Frontend
# ============================================================
@app.route('/')
def serve_index():
    """Serve the React frontend index.html."""
    if not os.path.isdir(DIST_DIR):
        return (
            "<h1>Frontend not built yet</h1>"
            "<p>Run <code>npm run build</code> first to generate the dist/ folder, "
            "then restart this server.</p>"
        ), 404
    index_file = os.path.join(DIST_DIR, 'index.html')
    if not os.path.isfile(index_file):
        return (
            "<h1>index.html not found</h1>"
            "<p>The dist/ folder exists but index.html is missing. "
            "Run <code>npm run build</code> again.</p>"
        ), 404
    return send_from_directory(DIST_DIR, 'index.html')


@app.route('/<path:path>')
def serve_static(path):
    """Serve static files from dist/, fallback to index.html for SPA routing."""
    if path.startswith('api/') or path.startswith('proxy/'):
        return jsonify({"error": "Not found"}), 404

    file_path = os.path.join(DIST_DIR, path)
    if os.path.isfile(file_path):
        return send_from_directory(DIST_DIR, path)
    return send_from_directory(DIST_DIR, 'index.html')


# ============================================================
# CORS Headers
# ============================================================
@app.after_request
def add_cors_headers(response):
    response.headers['Access-Control-Allow-Origin'] = '*'
    response.headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS, PATCH'
    response.headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization, X-Target-Base'
    response.headers['Access-Control-Expose-Headers'] = 'Content-Type'
    if request.method == 'OPTIONS':
        response.status_code = 200
    return response


# ============================================================
# Local LLM Hub - 本地模型管理（受 /home/yiye/cursor_prj/frontend 启发）
#   - GGUF 模型目录扫描 + llama-server 启停 + HF 下载 + API 文档
#   - 所有路由都在 /api/local/* 命名空间，避免与现有 /api/* 冲突
# ============================================================
import shutil as _shutil
from collections import deque as _deque

_LOCAL_DATA_DIR = os.path.join(DATA_DIR, 'local')
os.makedirs(_LOCAL_DATA_DIR, exist_ok=True)
_MODEL_DIRS_FILE = os.path.join(_LOCAL_DATA_DIR, 'model_dirs.json')
_HF_DOWNLOAD_DIR = os.environ.get('HF_DOWNLOAD_DIR') or os.path.join(_LOCAL_DATA_DIR, 'models')
os.makedirs(_HF_DOWNLOAD_DIR, exist_ok=True)

# llama-server 二进制路径来源优先级：
#   1) 用户在 UI 里保存的路径（_LLAMA_BIN_FILE）
#   2) 环境变量 LLAMA_SERVER_BIN
#   3) PATH 上的 llama-server / llama.cpp-server
_LLAMA_BIN_FILE = os.path.join(_LOCAL_DATA_DIR, 'llama_server_bin.json')
_LLAMA_DEFAULT_PORT = int(os.environ.get('LLAMA_SERVER_PORT', '8090'))


def _which_llama_server():
    """在 PATH 中找 llama-server / llama.cpp-server / server。"""
    for name in ('llama-server', 'llama.cpp-server', 'llama_cpp_server'):
        p = _shutil.which(name)
        if p:
            return p
    return None


def _load_saved_llama_bin():
    if not os.path.exists(_LLAMA_BIN_FILE):
        return ''
    try:
        with open(_LLAMA_BIN_FILE, 'r', encoding='utf-8') as f:
            data = json.load(f)
        p = (data or {}).get('path') or ''
        return p if isinstance(p, str) else ''
    except Exception:
        return ''


def _save_llama_bin(path):
    try:
        if path:
            with open(_LLAMA_BIN_FILE, 'w', encoding='utf-8') as f:
                json.dump({'path': path}, f, ensure_ascii=False, indent=2)
        else:
            if os.path.exists(_LLAMA_BIN_FILE):
                os.remove(_LLAMA_BIN_FILE)
    except Exception as e:
        logger.warning(f"save llama-server bin failed: {e}")


def _llama_bin_sources():
    """返回三种来源的探测结果。"""
    return {
        'saved': _load_saved_llama_bin(),
        'env': os.environ.get('LLAMA_SERVER_BIN') or '',
        'which': _which_llama_server() or '',
    }


def _get_llama_server_bin():
    """按优先级 saved > env > which 解析出当前生效的 llama-server 二进制。"""
    src = _llama_bin_sources()
    for key in ('saved', 'env', 'which'):
        p = src.get(key) or ''
        if p and os.path.isfile(p) and os.access(p, os.X_OK):
            return p
    # 即使不可执行也优先返回 saved/env，方便上层报错时定位
    for key in ('saved', 'env', 'which'):
        p = src.get(key) or ''
        if p:
            return p
    return None
# llama-server 绑定的 host：默认 127.0.0.1（只本机访问）；远端 GPU 机器上跑 hub 时建议设 0.0.0.0
# 这样开发机的浏览器可以通过 http://<远端 IP>:<port>/v1 直连 OpenAI API
_LLAMA_DEFAULT_HOST = os.environ.get('LLAMA_SERVER_HOST', '127.0.0.1')

_llama_state = {
    'proc': None,         # subprocess.Popen
    'host': None,         # llama-server 绑定的 host
    'port': None,
    'model_path': None,
    'mmproj_path': None,
    'started_at': 0,
    'logs': _deque(maxlen=2000),
}
_llama_lock = threading.Lock()
_hf_downloads = {}  # id -> {url, filename, dst, total, downloaded, status, error, repo_id}
_hf_lock = threading.Lock()


def _load_model_dirs():
    if not os.path.exists(_MODEL_DIRS_FILE):
        return []
    try:
        with open(_MODEL_DIRS_FILE, 'r', encoding='utf-8') as f:
            data = json.load(f)
            return [d for d in data if isinstance(d, str) and os.path.isabs(d)]
    except Exception:
        return []


def _save_model_dirs(dirs):
    try:
        with open(_MODEL_DIRS_FILE, 'w', encoding='utf-8') as f:
            json.dump(sorted(set(dirs)), f, indent=2, ensure_ascii=False)
    except Exception as e:
        logger.warning(f"save model dirs failed: {e}")


def _scan_gguf_in(directory, max_files=500):
    """递归扫描目录下的 .gguf 文件。返回结构化列表。"""
    out = []
    try:
        for root, _dirs, files in os.walk(directory, followlinks=False):
            for fn in files:
                if not fn.lower().endswith('.gguf'):
                    continue
                fp = os.path.join(root, fn)
                try:
                    st = os.stat(fp)
                except OSError:
                    continue
                # 推测 repo_id：取相对目录的最后一两段
                rel = os.path.relpath(root, directory)
                if rel == '.':
                    repo_id = os.path.basename(directory.rstrip('/'))
                else:
                    parts = rel.split(os.sep)
                    repo_id = parts[-1] if len(parts) == 1 else f"{parts[-2]}/{parts[-1]}"
                out.append({
                    'path': fp,
                    'filename': fn,
                    'size': st.st_size,
                    'mtime': int(st.st_mtime * 1000),
                    'repo_id': repo_id,
                    'source': f'dir:{directory}',
                    'mmproj': 'mmproj' in fn.lower(),
                })
                if len(out) >= max_files:
                    return out
    except Exception as e:
        logger.warning(f"scan gguf in {directory} failed: {e}")
    return out


# ---------------- Model Dirs ----------------
@app.route('/api/local/dirs', methods=['GET'])
def local_dirs_list():
    dirs = _load_model_dirs()
    items = []
    for d in dirs:
        items.append({'path': d, 'exists': os.path.isdir(d)})
    return jsonify({'items': items, 'download_dir': _HF_DOWNLOAD_DIR})


@app.route('/api/local/dirs', methods=['POST'])
def local_dirs_add():
    data = request.json or {}
    p = (data.get('path') or '').strip()
    if not p or not os.path.isabs(p):
        return jsonify({'error': '需要绝对路径'}), 400
    if not os.path.isdir(p):
        return jsonify({'error': '目录不存在'}), 400
    dirs = _load_model_dirs()
    if p not in dirs:
        dirs.append(p)
        _save_model_dirs(dirs)
    return jsonify({'ok': True, 'items': dirs})


@app.route('/api/local/dirs', methods=['DELETE'])
def local_dirs_remove():
    data = request.json or {}
    p = (data.get('path') or '').strip()
    dirs = [d for d in _load_model_dirs() if d != p]
    _save_model_dirs(dirs)
    return jsonify({'ok': True, 'items': dirs})


@app.route('/api/local/dirs/scan', methods=['GET'])
def local_dirs_scan():
    """预览任意目录里的 gguf（无需先登记）。query: ?path=..."""
    p = (request.args.get('path') or '').strip()
    if not p or not os.path.isdir(p):
        return jsonify({'error': '目录无效'}), 400
    return jsonify({'items': _scan_gguf_in(p)})


# ---------------- 文件系统浏览（供前端文件/目录选择器使用） ----------------
def _fs_default_dir():
    """文件浏览的默认起点：用户主目录，回退到工作区。"""
    try:
        h = os.path.expanduser('~')
        if os.path.isdir(h):
            return h
    except Exception:
        pass
    return WORKSPACE_DIR


@app.route('/api/local/fs/list', methods=['GET'])
def local_fs_list():
    """浏览「当前 hub 所在机器」的文件系统，给前端的文件/目录选择器用。
    query:
      path        要列出的目录，缺省=用户主目录
      only_dirs   '1' 只返回目录（用于选目录）
      ext         逗号分隔的后缀过滤（仅作用于文件），如 '.gguf'
      show_hidden '1' 显示以 . 开头的隐藏项
    """
    raw = (request.args.get('path') or '').strip()
    only_dirs = (request.args.get('only_dirs') or '') in ('1', 'true', 'yes')
    show_hidden = (request.args.get('show_hidden') or '') in ('1', 'true', 'yes')
    exts = [e.strip().lower() for e in (request.args.get('ext') or '').split(',') if e.strip()]
    exts = [(e if e.startswith('.') else '.' + e) for e in exts]

    base = os.path.abspath(os.path.expanduser(raw)) if raw else _fs_default_dir()
    if not os.path.isdir(base):
        return jsonify({'error': f'目录不存在或不是目录: {base}', 'path': base}), 400

    try:
        names = os.listdir(base)
    except PermissionError:
        return jsonify({'error': f'无权访问该目录: {base}', 'path': base}), 403
    except OSError as e:
        return jsonify({'error': str(e), 'path': base}), 400

    entries = []
    for name in names:
        if not show_hidden and name.startswith('.'):
            continue
        full = os.path.join(base, name)
        try:
            is_dir = os.path.isdir(full)
        except OSError:
            continue
        if is_dir:
            entries.append({'name': name, 'path': full, 'is_dir': True})
        else:
            if only_dirs:
                continue
            if exts and not any(name.lower().endswith(e) for e in exts):
                continue
            item = {'name': name, 'path': full, 'is_dir': False}
            try:
                st = os.stat(full)
                item['size'] = st.st_size
                item['mtime'] = int(st.st_mtime * 1000)
                item['executable'] = os.access(full, os.X_OK)
            except OSError:
                item['size'] = 0
                item['mtime'] = 0
                item['executable'] = False
            entries.append(item)
        if len(entries) >= 3000:
            break

    entries.sort(key=lambda x: (not x['is_dir'], x['name'].lower()))

    parent = os.path.dirname(base.rstrip(os.sep)) or os.sep
    if parent == base:
        parent = None

    shortcuts = []
    home = os.path.expanduser('~')
    if os.path.isdir(home):
        shortcuts.append({'label': '主目录', 'path': home})
    if os.path.isdir(WORKSPACE_DIR):
        shortcuts.append({'label': '工作区', 'path': WORKSPACE_DIR})
    try:
        if _HF_DOWNLOAD_DIR and os.path.isdir(_HF_DOWNLOAD_DIR):
            shortcuts.append({'label': '下载目录', 'path': _HF_DOWNLOAD_DIR})
    except Exception:
        pass
    shortcuts.append({'label': '根目录', 'path': os.sep})

    return jsonify({
        'path': base,
        'parent': parent,
        'sep': os.sep,
        'shortcuts': shortcuts,
        'entries': entries,
    })


@app.route('/api/local/fs/mkdir', methods=['POST'])
def local_fs_mkdir():
    """在指定父目录下新建子目录（给目录选择器「新建文件夹」用）。
    body: { parent: 父目录绝对路径, name: 新目录名 }
    返回: { ok, path }（path 为新目录绝对路径）
    """
    body = request.get_json(silent=True) or {}
    parent = (body.get('parent') or '').strip()
    name = (body.get('name') or '').strip()
    if not parent or not name:
        return jsonify({'ok': False, 'error': '缺少 parent 或 name'}), 400
    # 只允许单级目录名，禁止路径分隔符与上跳，避免越权创建
    if name in ('.', '..') or '/' in name or '\\' in name or os.sep in name:
        return jsonify({'ok': False, 'error': '目录名不能包含路径分隔符'}), 400
    parent_abs = os.path.abspath(os.path.expanduser(parent))
    if not os.path.isdir(parent_abs):
        return jsonify({'ok': False, 'error': f'父目录不存在: {parent_abs}'}), 400
    target = os.path.join(parent_abs, name)
    if os.path.exists(target):
        if os.path.isdir(target):
            return jsonify({'ok': True, 'path': target, 'existed': True})
        return jsonify({'ok': False, 'error': '同名文件已存在'}), 409
    try:
        os.makedirs(target, exist_ok=True)
    except PermissionError:
        return jsonify({'ok': False, 'error': f'无权在此创建目录: {parent_abs}'}), 403
    except OSError as e:
        return jsonify({'ok': False, 'error': str(e)}), 400
    return jsonify({'ok': True, 'path': target})


# ---------------- Local Models (扫描已登记目录 + HF 下载目录) ----------------
@app.route('/api/local/models', methods=['GET'])
def local_models_list():
    dirs = list(_load_model_dirs())
    if os.path.isdir(_HF_DOWNLOAD_DIR) and _HF_DOWNLOAD_DIR not in dirs:
        dirs.append(_HF_DOWNLOAD_DIR)
    items = []
    seen = set()
    for d in dirs:
        if not os.path.isdir(d):
            continue
        for it in _scan_gguf_in(d):
            if it['path'] in seen:
                continue
            seen.add(it['path'])
            items.append(it)
    items.sort(key=lambda x: (-x['mtime'], x['repo_id']))
    return jsonify({
        'items': items,
        'current': _llama_status_dict(),
    })


@app.route('/api/local/models', methods=['DELETE'])
def local_models_delete():
    data = request.json or {}
    path = data.get('path') or ''
    if not path or not os.path.isfile(path):
        return jsonify({'error': '文件不存在'}), 400
    if not path.lower().endswith('.gguf'):
        return jsonify({'error': '只允许删除 .gguf 文件'}), 400
    try:
        os.unlink(path)
        return jsonify({'ok': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ---------------- llama-server 进程管理 ----------------
def _llama_status_dict():
    proc = _llama_state.get('proc')
    if not proc:
        return None
    if proc.poll() is not None:
        # 进程已结束
        return None
    bound_host = _llama_state.get('host') or '127.0.0.1'
    port = _llama_state.get('port')
    # 给浏览器使用的 base_url：
    #   - 如果 llama-server 绑了 0.0.0.0，建议浏览器用当前 hub 的请求 host（远端 IP/域名）替代
    #   - 否则只能本机访问
    public_host = bound_host
    try:
        if bound_host in ('0.0.0.0', '::'):
            req_host = request.host.split(':')[0] if request else '127.0.0.1'
            public_host = req_host or '127.0.0.1'
    except RuntimeError:
        pass  # outside request context
    return {
        'pid': proc.pid,
        'host': bound_host,
        'public_host': public_host,
        'port': port,
        'model_path': _llama_state.get('model_path'),
        'filename': os.path.basename(_llama_state.get('model_path') or ''),
        'mmproj_path': _llama_state.get('mmproj_path'),
        'started_at': _llama_state.get('started_at'),
        'base_url': f"http://{public_host}:{port}/v1",
    }


def _read_llama_logs(proc):
    """后台线程：把 llama-server 的 stdout/stderr 行追加到 ring buffer。"""
    try:
        for line in iter(proc.stdout.readline, ''):
            if not line:
                break
            _llama_state['logs'].append(line.rstrip('\n'))
    except Exception:
        pass


@app.route('/api/local/server/status', methods=['GET'])
def local_server_status():
    bin_path = _get_llama_server_bin()
    return jsonify({
        'running': _llama_status_dict() is not None,
        'status': _llama_status_dict(),
        'binary': bin_path,
        'binary_available': bool(bin_path),
        'default_host': _LLAMA_DEFAULT_HOST,
        'default_port': _LLAMA_DEFAULT_PORT,
    })


@app.route('/api/local/server/start', methods=['POST'])
def local_server_start():
    bin_path = _get_llama_server_bin()
    if not bin_path:
        return jsonify({
            'error': '未找到 llama-server 二进制。请在「本地模型 Hub」面板里设置 llama-server 路径，'
                     '或把 llama-server 放入 PATH / 设置环境变量 LLAMA_SERVER_BIN。'
        }), 500
    if not (os.path.isfile(bin_path) and os.access(bin_path, os.X_OK)):
        return jsonify({
            'error': f'llama-server 路径无效或不可执行: {bin_path}'
        }), 500
    data = request.json or {}
    model_path = (data.get('path') or '').strip()
    if not model_path or not os.path.isfile(model_path):
        return jsonify({'error': '模型文件不存在'}), 400
    bind_host = (data.get('host') or _LLAMA_DEFAULT_HOST or '127.0.0.1').strip()
    port = int(data.get('port') or _LLAMA_DEFAULT_PORT)
    ctx = int(data.get('ctx') or 4096)
    n_gpu_layers = int(data.get('n_gpu_layers') or 0)
    mmproj = (data.get('mmproj') or '').strip() or None
    extra_args = data.get('extra_args') or []

    with _llama_lock:
        prev = _llama_state.get('proc')
        if prev and prev.poll() is None:
            try:
                prev.terminate()
                prev.wait(timeout=5)
            except Exception:
                try:
                    prev.kill()
                except Exception:
                    pass
        _llama_state['logs'].clear()

        cmd = [bin_path, '-m', model_path, '--host', bind_host,
               '--port', str(port), '-c', str(ctx)]
        if n_gpu_layers > 0:
            cmd += ['-ngl', str(n_gpu_layers)]
        if mmproj and os.path.isfile(mmproj):
            cmd += ['--mmproj', mmproj]
        if isinstance(extra_args, list):
            cmd += [str(a) for a in extra_args if str(a).strip()]
        try:
            proc = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
                cwd=os.path.dirname(model_path) or WORKSPACE_DIR,
            )
        except Exception as e:
            return jsonify({'error': f'启动失败: {e}'}), 500
        _llama_state['proc'] = proc
        _llama_state['host'] = bind_host
        _llama_state['port'] = port
        _llama_state['model_path'] = model_path
        _llama_state['mmproj_path'] = mmproj
        _llama_state['started_at'] = int(time.time() * 1000)
        threading.Thread(target=_read_llama_logs, args=(proc,), daemon=True).start()
    # 等几百毫秒让 server 初始化（不阻塞太久）
    time.sleep(0.4)
    return jsonify({'ok': True, 'status': _llama_status_dict(), 'cmd': ' '.join(cmd)})


@app.route('/api/local/server/stop', methods=['POST'])
def local_server_stop():
    with _llama_lock:
        proc = _llama_state.get('proc')
        if not proc or proc.poll() is not None:
            return jsonify({'ok': True, 'message': '未在运行'})
        try:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
        except Exception as e:
            return jsonify({'error': str(e)}), 500
        _llama_state['proc'] = None
        _llama_state['host'] = None
        _llama_state['port'] = None
        _llama_state['model_path'] = None
        _llama_state['mmproj_path'] = None
    return jsonify({'ok': True})


@app.route('/api/local/server/binary', methods=['GET'])
def local_server_binary_get():
    bin_path = _get_llama_server_bin()
    src = _llama_bin_sources()
    # 标记每个来源的可用性
    def _probe(p):
        return {
            'path': p,
            'exists': bool(p) and os.path.isfile(p),
            'executable': bool(p) and os.path.isfile(p) and os.access(p, os.X_OK),
        }
    return jsonify({
        'binary': bin_path,
        'available': bool(bin_path and os.path.isfile(bin_path) and os.access(bin_path, os.X_OK)),
        'binary_file': _LLAMA_BIN_FILE,
        'sources': {
            'saved': _probe(src.get('saved') or ''),
            'env': _probe(src.get('env') or ''),
            'which': _probe(src.get('which') or ''),
        },
        'env_name': 'LLAMA_SERVER_BIN',
    })


@app.route('/api/local/server/binary', methods=['PUT', 'POST'])
def local_server_binary_set():
    data = request.json or {}
    raw = (data.get('path') or '').strip()
    if not raw:
        return jsonify({'error': '需要绝对路径'}), 400
    # 允许 ~ 展开
    p = os.path.abspath(os.path.expanduser(raw))
    if not os.path.isabs(p):
        return jsonify({'error': '需要绝对路径'}), 400
    if not os.path.isfile(p):
        return jsonify({'error': f'文件不存在: {p}'}), 400
    if not os.access(p, os.X_OK):
        return jsonify({'error': f'文件不可执行（缺少 +x 权限）: {p}'}), 400
    _save_llama_bin(p)
    return local_server_binary_get()


@app.route('/api/local/server/binary', methods=['DELETE'])
def local_server_binary_clear():
    _save_llama_bin('')
    return local_server_binary_get()


@app.route('/api/local/server/logs', methods=['GET'])
def local_server_logs():
    n = int(request.args.get('n') or 200)
    lines = list(_llama_state.get('logs') or [])[-max(1, min(2000, n)):]
    return jsonify({'lines': lines})


# ---------------- HuggingFace 下载（简版：requests 流式） ----------------
def _hf_resolve_url(url_or_repo, filename=''):
    """统一解析为可下载的 https URL。
    支持: 完整 https://huggingface.co/.../resolve/... URL、owner/repo + filename、owner/repo/filename。"""
    s = (url_or_repo or '').strip()
    if not s:
        return None, None
    if s.startswith('http://') or s.startswith('https://'):
        # 直接 URL；从中尝试提取 filename
        fn = filename or s.rstrip('/').split('/')[-1]
        return s, fn
    # owner/repo[/filename]
    parts = s.split('/')
    if len(parts) >= 3 and parts[2].lower().endswith('.gguf'):
        owner, repo, fn = parts[0], parts[1], '/'.join(parts[2:])
        return f'https://huggingface.co/{owner}/{repo}/resolve/main/{fn}', os.path.basename(fn)
    if len(parts) == 2 and filename:
        return f'https://huggingface.co/{parts[0]}/{parts[1]}/resolve/main/{filename}', os.path.basename(filename)
    return None, None


def _hf_download_worker(job_id, url, dst, hf_token=None):
    info = _hf_downloads.get(job_id)
    if not info:
        return
    headers = {'User-Agent': 'model-api-mt/1.0'}
    if hf_token:
        headers['Authorization'] = f'Bearer {hf_token}'
    tmp_path = dst + '.part'
    info['current_file'] = os.path.basename(dst)
    try:
        with http_requests.get(url, headers=headers, stream=True, timeout=60, allow_redirects=True) as r:
            r.raise_for_status()
            total = int(r.headers.get('Content-Length') or 0)
            info['total'] = total
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            done = 0
            t_start = time.time()
            t_window_start = t_start
            done_window_start = 0
            with open(tmp_path, 'wb') as f:
                for chunk in r.iter_content(chunk_size=1024 * 1024):
                    if info.get('cancel'):
                        info['status'] = 'cancelled'
                        try: f.close()
                        except Exception: pass
                        try: os.unlink(tmp_path)
                        except Exception: pass
                        return
                    if chunk:
                        f.write(chunk)
                        done += len(chunk)
                        info['downloaded'] = done
                        now = time.time()
                        # 滑动窗口（最近 ~2s）估算速度
                        dt = now - t_window_start
                        if dt >= 1.0:
                            speed = (done - done_window_start) / dt if dt > 0 else 0
                            info['speed_bps'] = int(speed)
                            if total and speed > 0:
                                info['eta_seconds'] = int(max(0, (total - done) / speed))
                            t_window_start = now
                            done_window_start = done
        os.replace(tmp_path, dst)
        info['status'] = 'done'
        info['downloaded'] = info.get('total') or done
        info['speed_bps'] = 0
        info['eta_seconds'] = 0
        info['finished_at'] = int(time.time() * 1000)
    except Exception as e:
        info['status'] = 'error'
        info['error'] = str(e)
        info['finished_at'] = int(time.time() * 1000)
        try: os.unlink(tmp_path)
        except Exception: pass


def _hf_list_repo_files(repo_id, hf_token=None):
    """调用 HF API 列出仓库根目录下文件名（不递归）。失败返回 []。"""
    if not repo_id or '/' not in repo_id:
        return []
    headers = {'User-Agent': 'model-api-mt/1.0'}
    if hf_token:
        headers['Authorization'] = f'Bearer {hf_token}'
    try:
        r = http_requests.get(f'https://huggingface.co/api/models/{repo_id}',
                              headers=headers, timeout=10)
        if r.status_code != 200:
            return []
        siblings = r.json().get('siblings') or []
        return [s.get('rfilename') for s in siblings if s.get('rfilename')]
    except Exception:
        return []


def _hf_pick_mmproj_filename(files):
    """从仓库文件列表中挑一个最像 mmproj 的 .gguf 文件名。"""
    cands = [f for f in files if 'mmproj' in (f or '').lower() and f.lower().endswith('.gguf')]
    if not cands:
        return None
    # 优先 f16 > bf16 > 其它（更精确）
    def score(name):
        n = name.lower()
        s = 0
        if 'f16' in n: s += 3
        if 'bf16' in n: s += 2
        if 'q8' in n: s += 1
        return -s, len(n)
    cands.sort(key=score)
    return cands[0]


def _hf_serialize_job(info):
    """把内部 info dict 序列化为对外公开的 job 字段（兼容 frontend 协议）。"""
    if not info:
        return None
    return {
        # 旧兼容字段
        'id': info.get('id'),
        'url': info.get('url'),
        'filename': info.get('filename'),
        'dst': info.get('dst'),
        'total': info.get('total'),
        'downloaded': info.get('downloaded'),
        'status': info.get('status'),
        'error': info.get('error'),
        'started_at': info.get('started_at'),
        'finished_at': info.get('finished_at'),
        # frontend 风格字段
        'job_id': info.get('id'),
        'repo_id': info.get('repo_id'),
        'total_size': info.get('total'),
        'downloaded_bytes': info.get('downloaded'),
        'speed_bps': info.get('speed_bps') or 0,
        'eta_seconds': info.get('eta_seconds'),
        'current_file': info.get('current_file') or info.get('filename'),
        'connections': info.get('connections') or 1,
        'downloader': info.get('downloader') or 'requests',
        'is_mmproj': bool(info.get('is_mmproj')),
        'parent_job_id': info.get('parent_job_id'),
    }


def _hf_start_job(repo_id, filename, hf_token=None, *, is_mmproj=False, parent_job_id=None):
    """启动一个 HF 下载任务，返回 (job_id, error)。"""
    src = repo_id or ''
    if not _hf_resolve_url(src, filename)[0] and src and not src.startswith('http'):
        src = f"{repo_id}/{filename}" if repo_id and filename else src
    url, fn = _hf_resolve_url(src, filename)
    if not url or not fn:
        return None, '无法解析下载链接，请提供 repo_id + filename 或完整 HF URL'
    dst = os.path.join(_HF_DOWNLOAD_DIR, fn)
    if os.path.exists(dst):
        return None, f'文件已存在: {dst}'
    job_id = uuid.uuid4().hex[:12]
    info = {
        'id': job_id,
        'url': url,
        'repo_id': repo_id if repo_id and not repo_id.startswith('http') else None,
        'filename': fn,
        'dst': dst,
        'total': 0,
        'downloaded': 0,
        'status': 'running',
        'error': None,
        'cancel': False,
        'started_at': int(time.time() * 1000),
        'is_mmproj': is_mmproj,
        'parent_job_id': parent_job_id,
        'speed_bps': 0,
        'eta_seconds': None,
        'current_file': fn,
    }
    with _hf_lock:
        _hf_downloads[job_id] = info
    threading.Thread(target=_hf_download_worker, args=(job_id, url, dst, hf_token), daemon=True).start()
    return job_id, None


@app.route('/api/local/hf/download', methods=['POST'])
def local_hf_download():
    """启动 HF 下载。
    Body 兼容两种风格：
      - frontend 风格: {repo_id, filename, mmproj}
        * mmproj=true  -> 自动从同 repo 找 mmproj-*.gguf 启动第二个任务
        * mmproj=string -> 直接当作 mmproj 文件名启动第二个任务
        * mmproj=false/null -> 跳过
      - 旧风格: {url|repo_id, filename}
    """
    data = request.json or {}
    repo_id = (data.get('repo_id') or '').strip()
    filename = (data.get('filename') or '').strip()
    url_in = (data.get('url') or '').strip()
    mmproj = data.get('mmproj')
    hf_token = (data.get('hf_token') or os.environ.get('HF_TOKEN') or '').strip() or None

    # 主任务来源：优先 repo_id+filename，其次直接 url
    if repo_id and filename:
        primary_src = repo_id
    elif url_in:
        primary_src = url_in
    elif repo_id and not filename:
        return jsonify({'error': '必须提供 filename'}), 400
    else:
        return jsonify({'error': '必须提供 repo_id+filename 或 url'}), 400

    job_id, err = _hf_start_job(primary_src, filename, hf_token=hf_token)
    if err:
        return jsonify({'error': err}), 400

    # mmproj 附加任务
    mmproj_job_id = None
    mmproj_filename = None
    try:
        if isinstance(mmproj, str) and mmproj.strip():
            mmproj_filename = mmproj.strip()
        elif mmproj is True or (isinstance(mmproj, str) and mmproj.lower() in ('true', '1', 'yes')):
            if repo_id and '/' in repo_id:
                files = _hf_list_repo_files(repo_id, hf_token=hf_token)
                mmproj_filename = _hf_pick_mmproj_filename(files)
        if mmproj_filename and repo_id:
            mmproj_job_id, _e = _hf_start_job(
                repo_id, mmproj_filename, hf_token=hf_token,
                is_mmproj=True, parent_job_id=job_id,
            )
    except Exception as _e:
        logger.warning(f'mmproj auto-start failed: {_e}')

    info = _hf_downloads.get(job_id) or {}
    return jsonify({
        'ok': True,
        'id': job_id,
        'job_id': job_id,
        'dst': info.get('dst'),
        'mmproj_job_id': mmproj_job_id,
        'job': _hf_serialize_job(info),
    })


@app.route('/api/local/hf/downloads', methods=['GET'])
def local_hf_downloads_list():
    items = [_hf_serialize_job(info) for jid, info in list(_hf_downloads.items())]
    items.sort(key=lambda x: -(x.get('started_at') or 0))
    return jsonify({'items': items, 'download_dir': _HF_DOWNLOAD_DIR})


@app.route('/api/local/hf/cancel/<job_id>', methods=['POST'])
def local_hf_cancel(job_id):
    info = _hf_downloads.get(job_id)
    if not info:
        return jsonify({'error': 'job not found'}), 404
    info['cancel'] = True
    return jsonify({'ok': True})


@app.route('/api/local/hf/clear', methods=['POST'])
def local_hf_clear_finished():
    with _hf_lock:
        for jid in list(_hf_downloads.keys()):
            if _hf_downloads[jid].get('status') in ('done', 'cancelled', 'error'):
                _hf_downloads.pop(jid, None)
    return jsonify({'ok': True})


@app.route('/api/local/hf/downloads/<job_id>/stream', methods=['GET'])
def local_hf_download_stream(job_id):
    """SSE 实时下载进度。事件格式:
      data: {"type":"progress","job":{...}}\n\n
      data: {"type":"done","job":{...}}\n\n
      data: {"type":"error","job":{...}}\n\n
      data: {"type":"cancelled","job":{...}}\n\n
      data: {"type":"end"}\n\n
    """
    if job_id not in _hf_downloads:
        return jsonify({'error': 'job not found'}), 404

    def gen():
        last_done = -1
        last_status = None
        # 立即推一次当前状态，前端能马上看到进度
        info0 = _hf_downloads.get(job_id)
        if info0:
            yield f"data: {json.dumps({'type': 'progress', 'job': _hf_serialize_job(info0)}, ensure_ascii=False)}\n\n"
            last_done = info0.get('downloaded', 0)
            last_status = info0.get('status')
        # 轮询本地状态，最多 24 小时
        deadline = time.time() + 24 * 3600
        while time.time() < deadline:
            time.sleep(0.5)
            info = _hf_downloads.get(job_id)
            if not info:
                yield f"data: {json.dumps({'type': 'end'})}\n\n"
                return
            cur_status = info.get('status')
            cur_done = info.get('downloaded', 0)
            if cur_status != last_status or cur_done != last_done:
                ev_type = 'progress'
                if cur_status == 'done':
                    ev_type = 'done'
                elif cur_status == 'error':
                    ev_type = 'error'
                elif cur_status == 'cancelled':
                    ev_type = 'cancelled'
                yield f"data: {json.dumps({'type': ev_type, 'job': _hf_serialize_job(info)}, ensure_ascii=False)}\n\n"
                last_status = cur_status
                last_done = cur_done
            if cur_status in ('done', 'error', 'cancelled'):
                yield f"data: {json.dumps({'type': 'end'})}\n\n"
                return
            # 心跳，防止反向代理超时
            yield ': keep-alive\n\n'

    headers = {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',
        'Connection': 'keep-alive',
    }
    return Response(stream_with_context(gen()), headers=headers)


@app.route('/api/local/server/status/stream', methods=['GET'])
def local_server_status_stream():
    """SSE 推送 llama-server 状态变化和实时日志。事件格式：
      data: {"type":"status","status":{...}}\n\n
      data: {"type":"log","line":"..."}\n\n
    """
    def gen():
        last_status_serialized = None
        # 第一次推送当前 snapshot
        try:
            cur = _llama_status_dict()
            cur_s = json.dumps(cur or {}, sort_keys=True, ensure_ascii=False)
            last_status_serialized = cur_s
            yield f"data: {json.dumps({'type': 'status', 'status': cur}, ensure_ascii=False)}\n\n"
        except Exception:
            pass
        # 用 (snapshot 长度, 最后一行内容) 作为日志游标，简单可靠（ring buffer）
        logs_buf = _llama_state.get('logs')
        prev_len = len(logs_buf) if logs_buf is not None else 0
        # 一次性补发最近 50 行历史日志，便于前端立即看到
        try:
            recent = list(logs_buf or [])[-50:]
            for ln in recent:
                yield f"data: {json.dumps({'type': 'log', 'line': ln}, ensure_ascii=False)}\n\n"
        except Exception:
            pass
        deadline = time.time() + 6 * 3600  # 最长 6 小时
        while time.time() < deadline:
            time.sleep(0.5)
            try:
                cur = _llama_status_dict()
                cur_s = json.dumps(cur or {}, sort_keys=True, ensure_ascii=False)
                if cur_s != last_status_serialized:
                    last_status_serialized = cur_s
                    yield f"data: {json.dumps({'type': 'status', 'status': cur}, ensure_ascii=False)}\n\n"
                # 推送新增日志
                cur_logs = list(_llama_state.get('logs') or [])
                if len(cur_logs) > prev_len:
                    new_lines = cur_logs[prev_len:]
                    for ln in new_lines:
                        yield f"data: {json.dumps({'type': 'log', 'line': ln}, ensure_ascii=False)}\n\n"
                    prev_len = len(cur_logs)
                elif len(cur_logs) < prev_len:
                    # ring buffer 触发了 maxlen 溢出，重置游标
                    prev_len = len(cur_logs)
                # 心跳
                yield ': keep-alive\n\n'
            except GeneratorExit:
                return
            except Exception:
                # 静默继续
                pass

    headers = {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',
        'Connection': 'keep-alive',
    }
    return Response(stream_with_context(gen()), headers=headers)


# ---------------- System Caps ----------------
@app.route('/api/local/system-caps', methods=['GET'])
def local_system_caps():
    bin_path = _get_llama_server_bin()
    src = _llama_bin_sources()
    return jsonify({
        'llama_server': {
            'binary': bin_path,
            'available': bool(bin_path and os.path.isfile(bin_path) and os.access(bin_path, os.X_OK)),
            'sources': src,
            'binary_file': _LLAMA_BIN_FILE,
        },
        'aria2c': {
            'binary': _shutil.which('aria2c'),
            'available': bool(_shutil.which('aria2c')),
        },
        'huggingface_hub': {
            'available': False,  # 简版没用 hf_hub，使用 requests 流式
        },
        'download_dir': _HF_DOWNLOAD_DIR,
        'default_port': _LLAMA_DEFAULT_PORT,
    })


# ---------------- API 文档 ----------------
@app.route('/api/local/api-docs', methods=['GET'])
def local_api_docs():
    """返回当前 model-api-mt 后端 + 已运行 llama-server 的 OpenAI 兼容端点列表。"""
    base = request.host_url.rstrip('/')
    llama_url = (_llama_status_dict() or {}).get('base_url')
    groups = [
        {
            'name': 'OpenAI 兼容（来自当前已加载的 llama-server）',
            'base_url': llama_url or '(尚未加载本地模型)',
            'note': '加载本地模型后此处会变成 http://127.0.0.1:<port>/v1，可在主聊天界面用「本地」provider 直接调用。',
            'endpoints': [
                {'method': 'GET', 'path': '/v1/models', 'desc': '列出当前已加载模型'},
                {'method': 'POST', 'path': '/v1/chat/completions', 'desc': 'OpenAI 兼容聊天完成（支持 stream / 多模态 image_url）'},
                {'method': 'POST', 'path': '/v1/completions', 'desc': 'OpenAI 兼容文本补全'},
                {'method': 'POST', 'path': '/v1/embeddings', 'desc': 'Embeddings（如模型支持）'},
            ],
        },
        {
            'name': 'Local LLM Hub（model-api-mt 提供）',
            'base_url': base,
            'endpoints': [
                {'method': 'GET', 'path': '/api/local/system-caps', 'desc': '探测 llama-server / aria2c 可用性'},
                {'method': 'GET', 'path': '/api/local/dirs', 'desc': '已登记的模型扫描目录'},
                {'method': 'POST', 'path': '/api/local/dirs', 'desc': '添加扫描目录（body: {path}）'},
                {'method': 'DELETE', 'path': '/api/local/dirs', 'desc': '移除扫描目录（body: {path}）'},
                {'method': 'GET', 'path': '/api/local/dirs/scan?path=...', 'desc': '预览任意目录中的 .gguf'},
                {'method': 'GET', 'path': '/api/local/models', 'desc': '聚合扫描结果（含下载目录）'},
                {'method': 'DELETE', 'path': '/api/local/models', 'desc': '删除某个 .gguf 文件（body: {path}）'},
                {'method': 'GET', 'path': '/api/local/server/status', 'desc': 'llama-server 当前状态'},
                {'method': 'GET', 'path': '/api/local/server/status/stream', 'desc': 'SSE 实时状态 + llama-server 日志'},
                {'method': 'POST', 'path': '/api/local/server/start', 'desc': '启动 llama-server（body: {path, port?, ctx?, n_gpu_layers?, mmproj?}）'},
                {'method': 'POST', 'path': '/api/local/server/stop', 'desc': '停止 llama-server'},
                {'method': 'GET', 'path': '/api/local/server/binary', 'desc': '获取 llama-server 二进制路径（saved/env/which 三种来源）'},
                {'method': 'PUT', 'path': '/api/local/server/binary', 'desc': '保存 llama-server 二进制路径（body: {path}）'},
                {'method': 'DELETE', 'path': '/api/local/server/binary', 'desc': '清除自定义 llama-server 路径，回退 env/PATH'},
                {'method': 'GET', 'path': '/api/local/server/logs?n=200', 'desc': '最近 N 行日志'},
                {'method': 'POST', 'path': '/api/local/hf/download', 'desc': '下载 GGUF（body: {repo_id, filename, mmproj?} 或 {url}）'},
                {'method': 'GET', 'path': '/api/local/hf/downloads', 'desc': '所有下载任务及进度'},
                {'method': 'GET', 'path': '/api/local/hf/downloads/<id>/stream', 'desc': 'SSE 实时下载进度'},
                {'method': 'POST', 'path': '/api/local/hf/cancel/<id>', 'desc': '取消某个下载'},
                {'method': 'POST', 'path': '/api/local/hf/clear', 'desc': '清理已完成/已取消/失败的任务'},
            ],
            'aliases': [
                {'method': 'GET', 'path': '/api/system/caps -> /api/local/system-caps'},
                {'method': 'GET', 'path': '/api/status -> /api/local/server/status'},
                {'method': 'GET', 'path': '/api/status/stream -> /api/local/server/status/stream'},
                {'method': 'POST', 'path': '/api/models/load -> /api/local/server/start'},
                {'method': 'POST', 'path': '/api/models/unload -> /api/local/server/stop'},
                {'method': 'POST', 'path': '/api/hf/download -> /api/local/hf/download'},
                {'method': 'GET', 'path': '/api/hf/downloads -> /api/local/hf/downloads'},
                {'method': 'GET', 'path': '/api/hf/downloads/<id>/stream -> /api/local/hf/downloads/<id>/stream'},
                {'method': 'POST', 'path': '/api/hf/downloads/<id>/cancel -> /api/local/hf/cancel/<id>'},
                {'method': 'POST', 'path': '/api/hf/downloads/clear -> /api/local/hf/clear'},
            ],
        },
        {
            'name': 'Agent 工作流（model-api-mt 提供）',
            'base_url': base,
            'endpoints': [
                {'method': 'POST', 'path': '/api/agent/plan', 'desc': '需求 → 步骤列表(含推荐语言)'},
                {'method': 'POST', 'path': '/api/agent/script', 'desc': '步骤 → 可执行脚本 + 参数表单'},
                {'method': 'POST', 'path': '/api/agent/project', 'desc': '步骤 → 多文件工程项目(落盘+run.sh)'},
                {'method': 'POST', 'path': '/api/agent/fix-project', 'desc': '工程运行失败 → 修复并重写文件'},
                {'method': 'POST', 'path': '/api/agent/refine-project', 'desc': '后续提示词 → 修订并重写工程'},
                {'method': 'POST', 'path': '/api/agent/refine', 'desc': '基于运行结果 + 用户细化指令重新生成脚本'},
                {'method': 'POST', 'path': '/api/agent/fix', 'desc': '基于失败输出生成修复脚本'},
                {'method': 'POST', 'path': '/api/research/plan', 'desc': '讯息 → 关键词/检索式/候选站点'},
                {'method': 'POST', 'path': '/api/research/synthesize', 'desc': '检索内容 → 结构化整理输出'},
            ],
        },
    ]
    return jsonify({'groups': groups})


# ============================================================
# Frontend-compatible aliases
#   把 /api/local/* 的能力以 /home/yiye/cursor_prj/frontend 项目的同名路径暴露，
#   方便统一前端逻辑：远端 hub 不论是 model-api-mt 还是 frontend backend 都能用同一套调用。
# ============================================================
@app.route('/api/system/caps', methods=['GET'])
def alias_system_caps():
    return local_system_caps()


@app.route('/api/system/llama-server-binary', methods=['GET'])
def alias_llama_bin_get():
    return local_server_binary_get()


@app.route('/api/system/llama-server-binary', methods=['PUT', 'POST'])
def alias_llama_bin_set():
    return local_server_binary_set()


@app.route('/api/system/llama-server-binary', methods=['DELETE'])
def alias_llama_bin_clear():
    return local_server_binary_clear()


@app.route('/api/status', methods=['GET'])
def alias_status():
    return local_server_status()


@app.route('/api/settings/model-dirs', methods=['GET'])
def alias_dirs_get():
    return local_dirs_list()


@app.route('/api/settings/model-dirs', methods=['POST'])
def alias_dirs_add():
    return local_dirs_add()


@app.route('/api/settings/model-dirs', methods=['DELETE'])
def alias_dirs_remove():
    return local_dirs_remove()


@app.route('/api/settings/model-dirs/scan', methods=['GET'])
def alias_dirs_scan():
    return local_dirs_scan()


@app.route('/api/system/fs/list', methods=['GET'])
def alias_fs_list():
    return local_fs_list()


# /api/models 已有 POST（拉远端 OpenAI 模型列表）；这里只加 GET / DELETE 两个别名
@app.route('/api/models', methods=['GET'])
def alias_models_get():
    return local_models_list()


@app.route('/api/models', methods=['DELETE'])
def alias_models_delete():
    return local_models_delete()


@app.route('/api/models/load', methods=['POST'])
def alias_models_load():
    return local_server_start()


@app.route('/api/models/unload', methods=['POST'])
def alias_models_unload():
    return local_server_stop()


@app.route('/api/hf/download', methods=['POST'])
def alias_hf_download():
    return local_hf_download()


@app.route('/api/hf/downloads', methods=['GET'])
def alias_hf_downloads_list():
    return local_hf_downloads_list()


@app.route('/api/hf/downloads/<job_id>/cancel', methods=['POST'])
def alias_hf_cancel(job_id):
    return local_hf_cancel(job_id)


@app.route('/api/hf/downloads/clear', methods=['POST'])
def alias_hf_clear():
    return local_hf_clear_finished()


@app.route('/api/hf/downloads/<job_id>/stream', methods=['GET'])
def alias_hf_download_stream(job_id):
    return local_hf_download_stream(job_id)


@app.route('/api/status/stream', methods=['GET'])
def alias_status_stream():
    return local_server_status_stream()


# ============================================================
# Main Entry Point
# ============================================================
if __name__ == '__main__':
    PORT = int(os.environ.get('PORT', 8765))
    HOST = os.environ.get('HOST', '0.0.0.0')
    DEBUG = os.environ.get('FLASK_DEBUG', '0').strip().lower() in ('1', 'true', 'yes', 'on')

    if not os.path.isdir(DIST_DIR):
        print(f"\n⚠️  WARNING: dist/ directory not found at {DIST_DIR}")
        print("   Run 'npm run build' first to build the frontend.\n")
    else:
        files = os.listdir(DIST_DIR)
        print(f"\n✅ dist/ directory found with {len(files)} file(s)")

    # Show existing state info
    state = load_state()
    print(f"📦 Data directory: {DATA_DIR}")
    print(f"   Providers:     {len(state.get('providers', []))}")
    print(f"   Conversations: {len(state.get('conversations', []))}")

    print(f"""
╔══════════════════════════════════════════════════════════╗
║           LLM API Manager - Full Stack Server            ║
╠══════════════════════════════════════════════════════════╣
║                                                          ║
║  🌐 Server:  http://localhost:{PORT:<5}                      ║
║  📁 Workspace: {WORKSPACE_DIR:<40} ║
║  💾 Data:      {DATA_DIR:<40} ║
║                                                          ║
║  API Endpoints:                                          ║
║    GET/PUT  /api/state         - Full state load/save    ║
║    CRUD     /api/providers     - Provider management     ║
║    CRUD     /api/conversations - Conversation management ║
║    POST     /api/chat          - Chat completion proxy   ║
║    POST     /api/models        - Fetch available models  ║
║    POST     /api/save-file     - Save code to file       ║
║    POST     /api/save-code     - 智能保存(名/依赖/脚本)   ║
║    POST     /api/run-code      - Execute code            ║
║    POST     /api/terminal      - Run shell commands      ║
║    POST     /api/upload        - Upload files            ║
║    GET      /api/workspace     - List workspace files    ║
║    GET      /api/preview/*     - Preview saved files     ║
║    POST     /api/web-search    - DuckDuckGo search       ║
║    POST     /api/tts           - Text-to-speech proxy    ║
║    GET/POST /api/model-stats   - Per-model likes/timing  ║
║    CRUD     /api/plugins/*     - LLM-generated plugins   ║
║    POST     /api/chat-with-plugin - Generate & run plugin║
║    WS       /ws                - PTY terminal (xterm)    ║
║    WS       /ws-run            - Clean run (deps+exec)   ║
║                                                          ║
║  Features:                                               ║
║    ✅ Backend-persistent providers & conversations       ║
║    ✅ Multi-provider LLM API management                  ║
║    ✅ Image & file upload in chat                        ║
║    ✅ Code save, run & HTML preview                      ║
║    ✅ Built-in terminal + WebSocket PTY (flask-sock)     ║
║    ✅ Streaming responses with markdown                  ║
║    ✅ Web search (ddgs)                                  ║
║    ✅ TTS proxy & sudo-aware shell execution             ║
║    ✅ LLM-generated reusable plugins                     ║
║                                                          ║
╚══════════════════════════════════════════════════════════╝
    """)

    logger.info('Starting server host=%s port=%s debug=%s', HOST, PORT, DEBUG)
    app.run(host=HOST, port=PORT, debug=DEBUG, threaded=True, use_reloader=DEBUG)
