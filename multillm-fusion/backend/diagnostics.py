"""Private JSONL step diagnostics with explicit, bounded, secret-redacted payloads."""

from datetime import datetime, timezone
import json
import logging
from logging.handlers import RotatingFileHandler
import math
import os
from pathlib import Path
import re
import stat
import sys
import threading
from urllib.parse import quote
from uuid import uuid4


LOGGER = logging.getLogger("fusion")
LOGGER.addHandler(logging.NullHandler())
LOGGER.propagate = False
_lock = threading.RLock()
_emit_lock = threading.RLock()
_secrets: set[str] = set()
_configured = None
PAYLOAD_CHUNK_CHARS = 16_000
PAYLOAD_MAX_CHARS = 2_000_000
_FIELDS = frozenset({
    "request_id", "conversation_id", "job_id", "http_id", "provider", "purpose",
    "code", "state", "mode", "path", "artifact", "method", "route", "status",
    "error_type", "duration_ms", "queue_wait_ms", "queue_size", "output_chars",
    "input_chars", "provider_count", "source_count", "error_count", "timeout_seconds",
    "payload_id", "part", "parts", "chars", "truncated",
})
_IDENTIFIER = re.compile(r"^[A-Za-z0-9_.:-]{1,120}$")
_IDENTIFIER_FIELDS = frozenset({"request_id", "conversation_id", "job_id", "http_id", "provider", "purpose",
                               "code", "state", "mode", "artifact", "method", "error_type"})
_BEARER = re.compile(r"(?i)\bBearer\s+[^\s\"'<>]+")
_API_KEY = re.compile(r"\bsk-[A-Za-z0-9_-]{8,}")
_ASSIGNMENT = re.compile(r'''(?i)\b(api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|authorization|cookie|token)(["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^\s,;}&]+)''')
_HEADER = re.compile(r"(?im)\b((?:set-cookie|cookie|authorization|proxy-authorization)\s*:\s*)[^\r\n]+")
_URL_AUTH = re.compile(r"(?i)(\b[a-z][a-z0-9+.-]{0,31}://)[^\s/@]+@")
_URL_SECRET = re.compile(r'''(?i)([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|key|secret|auth|code|password)=)[^&\s'"<>]+''')
_SECRET_FIELDS = frozenset({"apikey", "accesstoken", "refreshtoken", "token", "secret", "password", "passwd",
                            "authorization", "proxyauthorization", "cookie", "cookies", "setcookie", "headers",
                            "requestheaders", "responseheaders", "login", "logins", "credentials", "env",
                            "environment", "environ", "localstorage", "sessionstorage", "storage", "session"})
_MISSING = object()


def register_secrets(*values):
    """Keep known credentials out of metadata, even when they resemble IDs."""
    with _lock:
        _secrets.update(value for value in values if isinstance(value, str) and value)


def _redact(value: str) -> str:
    with _lock:
        secrets = sorted(_secrets, key=len, reverse=True)
    for secret in secrets:
        value = value.replace(secret, "[REDACTED]")
        value = value.replace(json.dumps(secret, ensure_ascii=False)[1:-1], "[REDACTED]")
        value = value.replace(quote(secret, safe=""), "[REDACTED]")
    value = _URL_AUTH.sub(r"\1[REDACTED]@", value)
    value = _URL_SECRET.sub(r"\1[REDACTED]", value)
    value = _HEADER.sub(r"\1[REDACTED]", value)
    value = _BEARER.sub("Bearer [REDACTED]", value)
    value = _API_KEY.sub("[REDACTED]", value)
    return _ASSIGNMENT.sub(lambda match: match[1] + match[2] + "[REDACTED]", value)


def _sanitize_payload(value, *, depth=0, active=None):
    """Only explicit JSON-like data is logged; never introspect objects or environments."""
    if depth > 32:
        return "[TRUNCATED: maximum nesting]"
    if value is None or isinstance(value, (bool, int)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, str):
        return _redact(value)
    if not isinstance(value, (dict, list, tuple)):
        return "[OMITTED: non-JSON value]"
    active = set() if active is None else active
    if id(value) in active:
        return "[OMITTED: circular reference]"
    active.add(id(value))
    try:
        if isinstance(value, dict):
            result = {}
            for key, item in value.items():
                if not isinstance(key, str):
                    continue
                normalized = re.sub(r"[^a-z0-9]", "", key.lower())
                result[_redact(key)] = "[REDACTED]" if normalized in _SECRET_FIELDS else _sanitize_payload(item, depth=depth + 1, active=active)
            return result
        return [_sanitize_payload(item, depth=depth + 1, active=active) for item in value]
    finally:
        active.remove(id(value))


def error_payload(exc: BaseException, *, depth=0):
    """Capture selected error fields and nested causes without tracebacks or local variables."""
    if depth >= 8:
        return {"message": "[TRUNCATED: exception causes]"}
    result = {"error_type": type(exc).__name__, "message": str(exc)}
    for field in ("code", "status", "details"):
        if getattr(exc, field, None) is not None:
            result[field] = getattr(exc, field)
    cause = exc.__cause__ or (None if exc.__suppress_context__ else exc.__context__)
    if cause is not None and cause is not exc:
        result["cause"] = error_payload(cause, depth=depth + 1)
    return result


def sanitize_error(value, *, depth=0):
    """Keep useful provider error fields safe for API responses and persisted artifacts."""
    if depth > 16:
        return {"message": "[TRUNCATED: error nesting]"}
    if isinstance(value, dict):
        allowed = {"code", "message", "type", "error_type", "status", "status_code", "request_id", "http_id", "job_id",
                   "provider", "reason", "error", "errors", "details", "cause", "causes"}
        return {key: sanitize_error(item, depth=depth + 1) for key, item in value.items() if key in allowed}
    if isinstance(value, (list, tuple)):
        return [sanitize_error(item, depth=depth + 1) for item in value[:40]]
    if isinstance(value, str):
        if re.search(r"(?i)<(?:!doctype|html|head|body|script|form)\b", value):
            return "[OMITTED: HTML error response]"
        return _redact(value)[:2000]
    if value is None or isinstance(value, (bool, int)):
        return value
    if isinstance(value, float) and math.isfinite(value):
        return value
    return "[OMITTED: unstructured error detail]"


class JsonFormatter(logging.Formatter):
    def format(self, record):
        # Deliberately ignore record.msg, args, exc_info and arbitrary extra fields.
        data = {"time": datetime.fromtimestamp(record.created, timezone.utc).isoformat(timespec="milliseconds"),
                "level": record.levelname.lower(), "component": "backend"}
        name = getattr(record, "event_name", "")
        data["event"] = _redact(name) if isinstance(name, str) and _IDENTIFIER.fullmatch(name) else "unstructured_log_omitted"
        metadata = getattr(record, "event_fields", {})
        if isinstance(metadata, dict):
            for key, value in metadata.items():
                if key not in _FIELDS:
                    continue
                if isinstance(value, float) and not math.isfinite(value):
                    continue
                if value is None or isinstance(value, (bool, int, float)):
                    data[key] = value
                elif isinstance(value, str):
                    if key in _IDENTIFIER_FIELDS and not _IDENTIFIER.fullmatch(value):
                        value = "unrecognized"
                    data[key] = _redact(value)[:1000 if key == "path" else 160]
        # event() has already sanitized and chunked this field once for both sinks.
        payload = getattr(record, "event_payload", None)
        if isinstance(payload, str):
            data["payload"] = payload
        return json.dumps(data, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


class PrivateRotatingHandler(RotatingFileHandler):
    def _open(self):
        flags = os.O_APPEND | os.O_CREAT | os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0)
        fd = os.open(self.baseFilename, flags, 0o600)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1:
                raise PermissionError("Diagnostic output must be a regular file owned by this user")
            os.fchmod(fd, 0o600)
            handle = os.fdopen(fd, "a", encoding="utf-8")
        except BaseException:
            os.close(fd)
            raise
        return handle


def configure_logging(log_dir=None, stream=None, secrets=(), *, max_bytes=5 * 1024 * 1024, backup_count=3):
    """Configure once per destination. Both sinks emit identical component=backend JSONL."""
    global _configured
    register_secrets(*secrets)
    directory = Path(log_dir or os.environ.get("FUSION_LOG_DIR") or Path(__file__).resolve().parent.parent / "logs").expanduser().absolute()
    destination = directory / "backend.log"
    sink = sys.stderr if stream is None else stream
    identity = (str(destination), id(sink), max_bytes, backup_count)
    with _emit_lock:
        if identity == _configured:
            return destination
        file_handler, file_error = None, None
        try:
            directory.mkdir(mode=0o700, parents=True, exist_ok=True)
            if directory.is_symlink() or directory.stat().st_uid != os.getuid():
                raise PermissionError("Diagnostic directory must be owned by this user and must not be a symbolic link")
            file_handler = PrivateRotatingHandler(destination, maxBytes=max_bytes, backupCount=backup_count, encoding="utf-8")
        except OSError as exc:
            # Diagnostics should not stop the desktop when a directory is read-only.
            file_error = type(exc).__name__
        terminal_handler = logging.StreamHandler(sink)
        formatter = JsonFormatter()
        handlers = [terminal_handler] + ([file_handler] if file_handler is not None else [])
        for handler in handlers:
            handler.setFormatter(formatter)
            handler._fusion_diagnostic = True
        for handler in list(LOGGER.handlers):
            if getattr(handler, "_fusion_diagnostic", False):
                LOGGER.removeHandler(handler)
                handler.close()
        for handler in handlers:
            LOGGER.addHandler(handler)
        LOGGER.setLevel(logging.INFO)
        # A later configure call can retry after a permission/path problem is fixed.
        _configured = identity if file_handler is not None else None
        if file_error:
            event("log.file_unavailable", level="warning", code="log_file_unavailable", path=str(destination), error_type=file_error)
    return destination


def event(name: str, *, level="info", payload=_MISSING, **fields):
    severity = {"debug": logging.DEBUG, "info": logging.INFO, "warning": logging.WARNING, "error": logging.ERROR}.get(level, logging.INFO)
    if payload is _MISSING or os.environ.get("FUSION_LOG_CONTENT", "1") == "0":
        with _emit_lock:
            LOGGER.log(severity, "", extra={"event_name": name, "event_fields": fields})
        return
    try:
        serialized = json.dumps(_sanitize_payload(payload), ensure_ascii=False, separators=(",", ":"), allow_nan=False)
        chars = len(serialized)
        serialized = serialized[:PAYLOAD_MAX_CHARS]
        parts = max(1, math.ceil(len(serialized) / PAYLOAD_CHUNK_CHARS))
        payload_id = str(uuid4())
        # Keep all chunks consecutive, including when worker threads log concurrently.
        with _emit_lock:
            for index in range(parts):
                metadata = dict(fields, payload_id=payload_id, part=index + 1, parts=parts,
                                chars=chars, truncated=chars > PAYLOAD_MAX_CHARS)
                LOGGER.log(severity, "", extra={"event_name": name, "event_fields": metadata,
                           "event_payload": serialized[index * PAYLOAD_CHUNK_CHARS:(index + 1) * PAYLOAD_CHUNK_CHARS]})
    except (TypeError, ValueError, RecursionError):
        # A diagnostic serialization failure must not interrupt a model request.
        with _emit_lock:
            LOGGER.log(severity, "", extra={"event_name": name, "event_fields": dict(fields, code="log_payload_unavailable")})


def shutdown_logging():
    """Close only owned handlers; useful for independent standalone runs and tests."""
    global _configured
    with _emit_lock:
        for handler in list(LOGGER.handlers):
            if getattr(handler, "_fusion_diagnostic", False):
                LOGGER.removeHandler(handler)
                handler.close()
        _configured = None
