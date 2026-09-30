"""Small, text-only client for MultiLLM Fusion's OpenAI-compatible endpoint."""

import ipaddress
import http.client
import json
import re
import socket
import threading
import time
from urllib import error, parse, request
from uuid import UUID, uuid4

from .response_files import ResponseFile, ResponseFileError, ResponseStore


MAX_MESSAGES = 100
MAX_MESSAGE_CHARS = 200_000
MAX_TOTAL_CHARS = 500_000
MAX_REQUEST_BYTES = 4_000_000


class ClientError(Exception):
    """Transport error with bounded, sanitized server diagnostics for terminal/state."""

    def __init__(self, code: str, message: str, status: int | None = None, *,
                 server_code: str | None = None, request_id: str | None = None, http_id: str | None = None,
                 details: dict | None = None):
        super().__init__(message)
        self.code = code
        self.status = status
        self.server_code = server_code
        self.request_id = request_id
        self.http_id = http_id
        self.details = details or {}


_SECRET_KEY = re.compile(r"(?:authorization|cookie|password|passwd|api[_-]?key|token|secret)", re.I)


def _redact(value, secret: str, *, hide_urls=False):
    if isinstance(value, dict):
        return {str(key): "[REDACTED]" if _SECRET_KEY.search(str(key)) else _redact(item, secret, hide_urls=hide_urls)
                for key, item in value.items()}
    if isinstance(value, list):
        return [_redact(item, secret, hide_urls=hide_urls) for item in value]
    if not isinstance(value, str):
        return value
    value = value.replace(secret, "[REDACTED]") if secret else value
    value = re.sub(r"(?i)\bBearer\s+[^\s,;\"'<>]+", "Bearer [REDACTED]", value)
    value = re.sub(r'''(?ix)(\b(?:authorization|cookie|set-cookie|password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret)\s*["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;<>]+)''', r"\1[REDACTED]", value)
    value = re.sub(r"(?im)(\b(?:set-cookie|cookie)\s*[:=]\s*)[^\r\n]+", r"\1[REDACTED]", value)
    if hide_urls:
        value = re.sub(r"https?://[^\s<>\"']+", "[URL]", value)
    return value


def _short(value, secret: str, limit: int = 1000) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    # Redact before truncation so a secret cannot be cut in half and then escape matching.
    value = _redact(value, secret, hide_urls=True)
    return " ".join(re.sub(r"[\x00-\x1f\x7f-\x9f]", " ", value).split())[:limit]


def _error_details(raw: bytes, headers, secret: str) -> dict:
    """Only copy documented scalar diagnostics; never sources, traceback, headers or arbitrary bodies."""
    result = {}
    for header, field in (("X-Request-ID", "request_id"), ("X-HTTP-ID", "http_id")):
        header_id = _short(headers.get(header, "") if headers else "", secret, 128)
        if header_id:
            result[field] = header_id
    try:
        body = json.loads(raw)
    except (ValueError, UnicodeError, RecursionError):
        # Proxy error HTML can contain a credential, a request dump or scripts: never echo it.
        result["message"] = "服务端返回非 JSON 错误页面；请按 HTTP 状态及请求编号检查服务端日志。"
        result["body_format"] = "non_json"
        return result
    error_body = body.get("error", body.get("detail", {})) if isinstance(body, dict) else {}
    if isinstance(error_body, str):
        error_body = {"message": error_body}
    if not isinstance(error_body, dict):
        error_body = {}
    details = error_body.get("details", {})
    details = details if isinstance(details, dict) else {}
    for field, limit in (("code", 80), ("message", 1000), ("provider", 80)):
        value = _short(error_body.get(field), secret, limit)
        if value:
            result[field] = value
    if "request_id" not in result:
        value = _short(details.get("request_id", error_body.get("request_id", body.get("request_id") if isinstance(body, dict) else None)), secret, 128)
        if value:
            result["request_id"] = value
    errors = details.get("errors", error_body.get("errors", []))
    if isinstance(errors, list):
        clean = []
        for row in errors[:12]:
            if isinstance(row, dict):
                item = {field: value for field, limit in (("provider", 80), ("code", 80), ("message", 1000))
                        if (value := _short(row.get(field), secret, limit))}
                if item:
                    clean.append(item)
        if clean:
            result["errors"] = clean
    return result


class _NoRedirect(request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def encode_request_payload(payload: dict) -> bytes:
    try:
        body = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode("utf-8")
    except (ValueError, TypeError, UnicodeError, RecursionError):
        raise ClientError("invalid_payload", "API 请求无法编码为有效 UTF-8 JSON。") from None
    if len(body) > MAX_REQUEST_BYTES:
        raise ClientError("request_too_large", "API 请求体超过 4,000,000 UTF-8 字节限制。")
    return body


def validate_chat_request(messages: list[dict], model: str = "chatgpt") -> dict:
    """Match the server's hard limits without trimming any task or system instructions."""
    if not isinstance(messages, list) or not messages:
        raise ClientError("invalid_messages", "对话消息必须是非空列表。")
    if len(messages) > MAX_MESSAGES:
        raise ClientError("message_count_limit", "API 对话超过 100 条消息限制。")
    if not isinstance(model, str) or not 1 <= len(model) <= 200:
        raise ClientError("invalid_model", "模型名称不正确。")
    clean = []
    for message in messages:
        if (not isinstance(message, dict) or set(message) != {"role", "content"}
                or message["role"] not in ("system", "user", "assistant")
                or not isinstance(message["content"], str)):
            raise ClientError("invalid_messages", "仅支持 system/user/assistant 的纯文本消息。")
        if len(message["content"]) > MAX_MESSAGE_CHARS:
            raise ClientError("message_length_limit", "API 单条消息超过 200,000 字符限制。")
        clean.append({"role": message["role"], "content": message["content"]})
    if sum(len(item["content"]) for item in clean) > MAX_TOTAL_CHARS:
        raise ClientError("message_total_limit", "API 对话内容累计超过 500,000 字符限制。")
    if not any(item["role"] == "user" and item["content"].strip() for item in clean):
        raise ClientError("invalid_messages", "API 对话必须包含至少一条非空用户消息。")
    payload = {"model": model, "messages": clean, "stream": False}
    encode_request_payload(payload)
    return payload


def _base_url(value: str, allow_remote_http: bool) -> str:
    if not isinstance(value, str):
        raise ClientError("invalid_base_url", "API base URL 必须是字符串。")
    try:
        parts = parse.urlsplit(value)
        host = parts.hostname
        port = parts.port
    except (ValueError, TypeError):
        raise ClientError("invalid_base_url", "API base URL 格式不正确。") from None
    if (parts.scheme not in ("http", "https") or not host or parts.username
            or parts.password or parts.query or parts.fragment
            or any(ord(char) < 33 for char in value)):
        raise ClientError("invalid_base_url", "API base URL 必须是无账号、查询参数和片段的 HTTP(S) 地址。")
    if port is not None and not 1 <= port <= 65535:
        raise ClientError("invalid_base_url", "API 端口不正确。")
    try:
        loopback = ipaddress.ip_address(host).is_loopback
    except ValueError:
        loopback = host.lower() == "localhost"
    if parts.scheme == "http" and not loopback and not allow_remote_http:
        raise ClientError("remote_http_disabled", "远端 API 请使用 HTTPS，或显式允许远端 HTTP。")
    if "%" in parts.netloc or "\\" in parts.netloc:
        raise ClientError("invalid_base_url", "API 主机格式不正确。")
    path = parts.path.rstrip("/")
    if not path:
        path = "/v1"
    return parse.urlunsplit((parts.scheme, parts.netloc, path, "", ""))


class FusionClient:
    def __init__(self, base_url: str, api_key: str, model: str = "chatgpt", timeout: float = 600,
                 allow_remote_http: bool = False, max_response_bytes: int = 8 * 1024 * 1024, event=None,
                 web_progress: bool = False, web_recovery_timeout=None,
                 response_delivery: str = "inline", response_store: ResponseStore | None = None):
        self.base_url = _base_url(base_url, allow_remote_http)
        if not isinstance(api_key, str) or not api_key or "\r" in api_key or "\n" in api_key:
            raise ClientError("invalid_api_key", "请配置非空的本地 API 密钥。")
        if not isinstance(model, str) or not model or len(model) > 200:
            raise ClientError("invalid_model", "模型名称不正确。")
        if not isinstance(timeout, (float, int)) or isinstance(timeout, bool) or not 0 < timeout <= 3600:
            raise ClientError("invalid_timeout", "API 超时必须在 0 至 3600 秒之间。")
        if not isinstance(max_response_bytes, int) or not 1024 <= max_response_bytes <= 64 * 1024 * 1024:
            raise ClientError("invalid_response_limit", "响应大小限制不正确。")
        if response_delivery not in ("inline", "file"):
            raise ClientError("invalid_response_delivery", "response_delivery 只能为 inline 或 file。")
        if response_delivery == "file" and not isinstance(response_store, ResponseStore):
            raise ClientError("invalid_response_delivery", "文件响应模式需要本地 ResponseStore。")
        self.response_delivery, self.response_store = response_delivery, response_store
        self._api_key = api_key
        self.model = model
        self.timeout = timeout
        self.max_response_bytes = max_response_bytes
        self.event = event
        # The parent status handshake, or an explicit caller opt-in, must advertise
        # this extension. Generic OpenAI servers receive neither probes nor headers.
        self.web_progress = web_progress is True
        if (web_recovery_timeout is not None and (type(web_recovery_timeout) is not int
                or not 0 < web_recovery_timeout <= 7200)):
            raise ClientError("invalid_timeout", "网页恢复总等待预算必须为 1..7200 秒的整数。")
        self.web_recovery_timeout = web_recovery_timeout
        # Direct connections avoid accidentally forwarding a local API key to an environment proxy.
        self._opener = request.build_opener(request.ProxyHandler({}), _NoRedirect())

    def _emit(self, name, **fields):
        if self.event:
            self.event(name, _redact(fields, self._api_key))

    def _request(self, endpoint: str, payload: dict | None = None, *, progress_id=None, response_id=None) -> dict:
        body = None if payload is None else encode_request_payload(payload)
        req = request.Request(self.base_url + endpoint, data=body, headers={
            "Authorization": "Bearer " + self._api_key,
            "Content-Type": "application/json", "Accept": "application/json",
        }, method="GET" if payload is None else "POST")
        if endpoint == "/chat/completions":
            # Keep Desktop Agent calls in the native background view. Generic
            # OpenAI-compatible servers ignore this local routing hint.
            req.add_header("X-Fusion-Request-Source", "desktop-top")
        if progress_id:
            req.add_header("X-Fusion-Progress-ID", progress_id)
        started = time.monotonic()
        self._emit("model.http_request", method=req.method, endpoint=endpoint, model=self.model,
                   request_bytes=len(body or b""), payload=payload)
        try:
            # Never retry: a failed/timed-out request may already have submitted the webpage prompt.
            # Only the authenticated parent handshake opts into a longer
            # generation wait. Model-list requests retain their short timeout.
            timeout = (max(self.timeout, self.web_recovery_timeout or 0)
                       if endpoint == "/chat/completions" else self.timeout)
            with self._opener.open(req, timeout=timeout) as response:
                raw = response.read(self.max_response_bytes + 1)
                status = response.status
                request_id = _short(response.headers.get("X-Request-ID"), self._api_key, 128)
                http_id = _short(response.headers.get("X-HTTP-ID"), self._api_key, 128)
        except error.HTTPError as exc:
            status = exc.code
            raw = b""
            try:
                raw = exc.read(65537)
                details = _error_details(raw[:65536], exc.headers, self._api_key)
                if len(raw) > 65536:
                    details["body_truncated"] = True
            except (OSError, ValueError, http.client.HTTPException):
                details = _error_details(b"", exc.headers, self._api_key)
                details["message"] = "无法读取服务端错误详情。"
            finally:
                exc.close()
            if response_id is not None:
                self._save_http_file(response_id, raw[:65536], {"status": status, "error": True,
                    "body_truncated": len(raw) > 65536,
                    "request_id": details.get("request_id"), "http_id": details.get("http_id")})
            server_code, request_id = details.get("code"), details.get("request_id")
            http_id = details.get("http_id")
            pieces = [f"API 返回 HTTP {status}" + (f" ({server_code})" if server_code else "")]
            if details.get("message"):
                pieces.append(details["message"])
            for row in details.get("errors", []):
                pieces.append(" / ".join(row[field] for field in ("provider", "code", "message") if field in row))
            if request_id:
                pieces.append("请求编号：" + request_id)
            if http_id:
                pieces.append("HTTP 请求编号：" + http_id)
            if status == 502:
                # A Fusion 502 can be produced after the browser job has been
                # admitted (for example when a provider page needs a manual
                # action). Do not replay the POST: keep the per-request
                # progress observer alive and direct the user to the Fusion
                # window where the page can be operated safely.
                details["fusion_manual_action_required"] = True
                if progress_id:
                    details["fusion_progress_id"] = progress_id
                details["fusion_server_listening"] = bool(progress_id and self.web_progress)
                pieces.append("请到 MultiLLM Fusion 窗口处理当前网页操作；Desktop Agent 将继续监听 Fusion 服务器结果")
            else:
                pieces.append("请求未自动重试；请检查网页和服务端日志后决定下一步。")
            self._emit("model.http_error", status=status, code="http_error", server_code=server_code,
                       request_id=request_id, http_id=http_id, duration_ms=round((time.monotonic() - started) * 1000), payload=details)
            raise ClientError("http_error", "；".join(pieces), status, server_code=server_code,
                              request_id=request_id, http_id=http_id, details=details) from None
        except (TimeoutError, socket.timeout):
            self._emit("model.http_error", code="api_timeout", duration_ms=round((time.monotonic() - started) * 1000))
            raise ClientError("api_timeout", "API 请求超时；网页可能仍在生成，请检查后再决定是否重试。") from None
        except (error.URLError, OSError, ValueError, http.client.HTTPException):
            self._emit("model.http_error", code="connection_error", duration_ms=round((time.monotonic() - started) * 1000))
            raise ClientError("connection_error", "无法完成 API 连接；请求未自动重试。") from None
        metadata = {"status": status, "request_id": request_id, "http_id": http_id, "response_bytes": len(raw),
                    "duration_ms": round((time.monotonic() - started) * 1000)}
        if response_id is not None:
            self._save_http_file(response_id, raw, {**metadata,
                "body_truncated": len(raw) > self.max_response_bytes})
        if len(raw) > self.max_response_bytes:
            self._emit("model.http_response", **metadata, code="response_too_large")
            raise ClientError("response_too_large", "API 响应超过大小限制。")
        try:
            result = json.loads(raw)
        except (ValueError, UnicodeError, RecursionError):
            self._emit("model.http_response", **metadata, code="invalid_response")
            raise ClientError("invalid_response", "API 响应不是有效 JSON。") from None
        self._emit("model.http_response", **metadata, payload=result)
        if not isinstance(result, dict) or "error" in result:
            raise ClientError("invalid_response", "API 返回错误或非对象响应；请查看服务端脱敏日志。")
        return result

    def _save_http_file(self, response_id, raw, metadata):
        try:
            self.response_store.save_http(response_id, raw, metadata)
        except (OSError, ResponseFileError) as exc:
            self._emit("model.response_file_error", error_type=type(exc).__name__)
            raise ClientError("response_file_write_failed", "服务器响应落盘失败；请求不会自动重发，未执行本轮动作。") from None

    def complete(self, messages: list[dict]) -> str | ResponseFile:
        payload = validate_chat_request(messages, self.model)
        response_id = None
        if self.response_delivery == "file":
            try:
                response_id = self.response_store.reserve()
            except (OSError, ResponseFileError):
                raise ClientError("response_file_write_failed", "无法创建本地响应目录；本次请求未发送。") from None
        observer = None
        keep_progress_after_error = False
        if self.web_progress:
            observer = _WebProgress(self)
            try:
                observer.start()
            except Exception as exc:
                observer._emit("model.web_progress_unavailable", code="progress_unavailable", error_type=type(exc).__name__)
                observer = None
        try:
            result = self._request("/chat/completions", payload, progress_id=observer.key if observer else None,
                                   response_id=response_id)
        except ClientError as exc:
            if exc.status == 502 and observer:
                # The POST is never repeated. Keep observing the original
                # correlation ID briefly so a Fusion-side/manual recovery
                # result is visible even though this HTTP call failed.
                keep_progress_after_error = True
                observer.extend_after_error()
                exc.details.setdefault("fusion_progress_id", observer.key)
                exc.details["fusion_server_listening"] = True
            raise
        finally:
            if observer:
                observer.close(keep_listening=keep_progress_after_error)
        try:
            choice = result["choices"][0]
            message = choice["message"]
            content = message["content"]
            if (not isinstance(content, str) or not content.strip()
                    or message.get("role", "assistant") != "assistant" or message.get("tool_calls")
                    or choice.get("finish_reason") in ("length", "content_filter", "tool_calls", "function_call")):
                raise ValueError()
        except (KeyError, IndexError, TypeError, ValueError):
            raise ClientError("invalid_completion", "API 未返回完整的助手文本；本客户端只支持纯文本协议。") from None
        if response_id is not None:
            try:
                ref = self.response_store.put(content, response_id=response_id, metadata={"model": self.model})
            except (OSError, ResponseFileError):
                self.response_store.discard(response_id)
                raise ClientError("response_file_write_failed", "助手文本无法安全落盘；本轮动作未执行，请查看 HTTP 响应归档。") from None
            self._emit("model.response", model=self.model, response_chars=len(content),
                       response_delivery="file", payload={"response_file": ref.metadata()})
            return ref
        self._emit("model.response", model=self.model, response_chars=len(content), payload={"content": content})
        return content

    def models(self) -> list[dict]:
        result = self._request("/models")
        rows = result.get("data")
        if not isinstance(rows, list) or len(rows) > 1000:
            raise ClientError("invalid_models", "API 模型列表格式不正确。")
        models = []
        for row in rows:
            if not isinstance(row, dict) or not isinstance(row.get("id"), str) or len(row["id"]) > 200:
                raise ClientError("invalid_models", "API 模型列表格式不正确。")
            models.append({"id": row["id"], "object": "model"})
        return models


Client = FusionClient


_WEB_STAGES = frozenset({"queued", "preparing", "rate_limited", "send_dispatched", "accepted", "server_responded", "waiting_response",
                         "retrying", "manual_retry_required", "recovering", "verification_required", "verification_cleared",
                         "candidates_started", "candidate_saved", "candidate_failed", "candidate_timed_out", "candidate_cancelled", "fusion_started", "fusion_completed",
                         "generating", "collecting", "provider_completed", "provider_failed",
                         "completed", "failed", "cancelled"})


class _WebProgress:
    """Read-only, per-call observation; failures never retry or change the POST."""
    INTERVAL = 0.5
    HTTP_TIMEOUT = 0.6

    def __init__(self, client):
        self.client = client
        self.key = str(uuid4())
        self.cursor = 0
        self.request_id = None
        self.done = False
        self.stop = threading.Event()
        self.closed = threading.Event()
        self.deadline = time.monotonic() + client.timeout + 1
        self.opener = request.build_opener(request.ProxyHandler({}), _NoRedirect())
        self.thread = threading.Thread(target=self._run, name="fusion-web-progress", daemon=True)

    def _emit(self, name, **fields):
        if not self.closed.is_set():
            try:
                self.client._emit(name, **fields)
            except Exception:
                # A progress callback must not affect the task's result.
                pass

    def start(self):
        self.thread.start()

    def extend_after_error(self):
        """Keep the original progress correlation alive after an HTTP 502."""
        # Do not keep a daemon observer around for the full model timeout. A
        # short bounded window is enough to surface a manual Fusion action or
        # a server-side terminal event without replaying the POST.
        self.deadline = time.monotonic() + min(self.client.web_recovery_timeout or 90, 180)
        self._emit("model.fusion_server_listening", progress_id=self.key,
                   timeout_seconds=max(0, round(self.deadline - time.monotonic())))

    def close(self, *, keep_listening=False):
        if keep_listening:
            # The daemon thread continues polling the same request ID. Its
            # bounded deadline is set by extend_after_error().
            return
        self.stop.set()
        # Permit one final read after the completion/error response. A stalled
        # debug endpoint must not delay the result indefinitely or print later.
        self.thread.join(timeout=self.HTTP_TIMEOUT + 0.2)
        self.closed.set()

    def _read(self):
        url = self.client.base_url + "/progress/" + self.key + "?after=" + str(self.cursor)
        req = request.Request(url, headers={"Authorization": "Bearer " + self.client._api_key,
                                            "Accept": "application/json"})
        with self.opener.open(req, timeout=self.HTTP_TIMEOUT) as response:
            raw = response.read(131073)
            if len(raw) > 131072:
                raise ValueError("progress_too_large")
            report = json.loads(raw)
        if (not isinstance(report, dict) or type(report.get("done")) is not bool
                or type(report.get("sequence")) is not int or not 0 <= report["sequence"] <= 1_000_000
                or not isinstance(report.get("events"), list) or len(report["events"]) > 256):
            raise ValueError("invalid_progress")
        if report.get("pending") is True and report.get("request_id") is None and not report["events"]:
            return
        request_id = str(UUID(report["request_id"]))
        if self.request_id is not None and self.request_id != request_id:
            raise ValueError("progress_request_changed")
        if report["sequence"] < self.cursor:
            raise ValueError("progress_cursor_reversed")
        rows, cursor = [], self.cursor
        for row in report["events"]:
            if (not isinstance(row, dict) or type(row.get("sequence")) is not int
                    or not cursor < row["sequence"] <= report["sequence"]
                    or not isinstance(row.get("stage"), str) or row["stage"] not in _WEB_STAGES):
                raise ValueError("invalid_progress_event")
            clean = {"request_id": request_id, "progress_id": self.key,
                     "sequence": row["sequence"], "stage": row["stage"]}
            provider = row.get("provider")
            if isinstance(provider, str) and re.fullmatch(r"[a-z][a-z0-9_-]{0,39}", provider):
                clean["provider"] = provider
            if row.get("purpose") in ("candidate", "fusion"):
                clean["purpose"] = row["purpose"]
            if row["stage"] == "server_responded" and type(row.get("http_status")) is int and 100 <= row["http_status"] <= 599:
                clean["http_status"] = row["http_status"]
            rows.append(clean)
            cursor = row["sequence"]
        self.request_id, self.cursor, self.done = request_id, report["sequence"], report["done"]
        for row in rows:
            self._emit("model.web_progress", **row)

    def _run(self):
        try:
            while time.monotonic() < self.deadline:
                finishing = self.stop.is_set()
                self._read()
                if self.done or finishing:
                    break
                self.stop.wait(self.INTERVAL)
        except Exception as exc:
            if isinstance(exc, error.HTTPError):
                exc.close()
            self._emit("model.web_progress_unavailable", code="progress_unavailable",
                       error_type=type(exc).__name__)
