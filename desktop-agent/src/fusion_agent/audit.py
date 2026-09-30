"""Private structured step/content logs; terminal output is limited to sink warnings."""

from datetime import datetime, timezone
import json
import logging
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path
import re
import sys
import threading
from uuid import uuid4

from .rendering import safe_terminal_text


class _PrivateRotatingFileHandler(RotatingFileHandler):
    """Never let logging's error handler dump a private payload to stderr."""

    def __init__(self, *args, warning, **kwargs):
        self.warning = warning
        super().__init__(*args, **kwargs)

    def handleError(self, record):
        self.warning()


def redact_content(value, secrets=(), depth=0):
    if depth > 24:
        return "[DEPTH_LIMIT]"
    if isinstance(value, str):
        for secret in secrets:
            if secret:
                value = value.replace(secret, "[REDACTED]")
        value = re.sub(r"(?i)Bearer\s+[^\s\"'<>]+", "Bearer [REDACTED]", value)
        value = re.sub(r"(?im)((?:set-cookie|cookie|authorization)\s*:\s*)[^\r\n]+", r"\1[REDACTED]", value)
        value = re.sub(r"(?i)(https?://)[^\s/@]+:[^\s/@]+@", r"\1[REDACTED]@", value)
        value = re.sub(r"(?i)([?&](?:token|key|api[_-]?key|auth|password|secret)=)[^&\s]+", r"\1[REDACTED]", value)
        return re.sub(r'''(?i)((?:password|passwd|api[_-]?key|token|secret|cookie|authorization)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}]+)''', r'\1"[REDACTED]"', value)
    if isinstance(value, dict):
        return {str(key): "[REDACTED]" if re.fullmatch(r"(?:authorization|headers|cookies?|password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|localStorage)", str(key), re.I)
                else redact_content(item, secrets, depth + 1) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [redact_content(item, secrets, depth + 1) for item in value]
    return value


class Audit:
    FIELDS = {"run_id", "step", "steps", "tool", "capability", "mutating", "status", "ok", "code", "error_code", "error_type",
              "elapsed_ms", "duration_ms", "model", "attempt", "repair", "response_chars", "context_chars",
              "action_id", "max_steps", "task_chars", "skill_count", "message_count", "repair_count", "answer_chars", "result_count",
              "request_id", "http_id", "http_status", "server_code", "method", "endpoint", "reason", "scope", "verification_status",
              "returncode", "timed_out", "outcome_unknown", "body_bytes", "request_bytes", "response_bytes", "content_type", "status_code", "pending_count",
              "stage", "provider", "purpose", "sequence", "progress_id", "original_tool", "resolved_tool",
              "response_id", "response_delivery", "path", "sha256", "bytes", "directory", "report",
              "original", "normalized", "content_retained", "verified", "transient_deleted"}

    def __init__(self, path: Path, secrets=(), stream=None, content=True, max_content_chars=2000000, chunk_chars=8192, run_path=None):
        self._lock = threading.RLock()
        self._closed = False
        self.path = Path(path)
        self.secrets = tuple(secrets)
        self.stream = stream if stream is not None else sys.stderr
        self.content = content and os.environ.get("FUSION_LOG_CONTENT", "1").lower() not in ("0", "false", "off")
        self.max_content_chars = max(1, min(int(max_content_chars), 4000000))
        self.chunk_chars = max(1, min(int(chunk_chars), 16384))
        self.handler = None
        self.global_log_available = False
        self._global_failure_warned = False
        self.run_path = Path(run_path) if run_path is not None else None
        self.run_log_available = False
        self._run_handle = None
        self._run_failure_warned = False
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            if self.path.is_symlink() or self.path.parent.is_symlink():
                raise OSError("Linked log path")
            fd = os.open(self.path, os.O_CREAT | os.O_APPEND | os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0), 0o600)
            os.close(fd)
            self.path.chmod(0o600)
            self.handler = _PrivateRotatingFileHandler(self.path, maxBytes=5 * 1024 * 1024,
                                                       backupCount=3, encoding="utf-8",
                                                       warning=self._warn_global_log_failure)
            self.handler.setFormatter(logging.Formatter("%(message)s"))
            self.global_log_available = True
        except OSError:
            self._warn_global_log_failure()
        if self.run_path is not None:
            self._open_run_log()

    def _warning(self, message):
        try:
            self.stream.write(message + "\n")
            self.stream.flush()
        except (OSError, ValueError):
            # A closed output pipe must not prevent file logging.
            pass

    def _warn_global_log_failure(self):
        self.global_log_available = False
        if not self._global_failure_warned:
            self._global_failure_warned = True
            self._warning(f"全局 Agent 日志不可写：{safe_terminal_text(self.path)}；本轮日志仍会独立尝试保存。")

    def _open_run_log(self):
        parent_fd = None
        file_fd = None
        try:
            parent = self.run_path.parent
            if any(item.is_symlink() for item in (parent, *parent.parents)):
                raise OSError("Linked run log directory")
            parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            # Open relative to the checked directory: replacing its pathname must
            # not redirect creation into an unrelated directory.
            parent_fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_NOFOLLOW", 0))
            os.fchmod(parent_fd, 0o700)
            file_fd = os.open(self.run_path.name,
                              os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0),
                              0o600, dir_fd=parent_fd)
            os.fchmod(file_fd, 0o600)
            self._run_handle = os.fdopen(file_fd, "w", encoding="utf-8", newline="\n")
            file_fd = None
            self.run_log_available = True
        except (OSError, ValueError) as exc:
            self._warn_run_log_failure(type(exc).__name__)
        finally:
            if file_fd is not None:
                os.close(file_fd)
            if parent_fd is not None:
                os.close(parent_fd)

    def _warn_run_log_failure(self, error_type):
        self.run_log_available = False
        handle, self._run_handle = self._run_handle, None
        if handle is not None:
            try:
                handle.close()
            except (OSError, ValueError):
                pass
        if self._run_failure_warned:
            return
        self._run_failure_warned = True
        self._warning(f"本轮日志不可写：{safe_terminal_text(self.run_path)}；请查看全局 agent.log，并检查任务记录目录。")
        self("audit.run_log_failed", {"error_type": error_type,
             "reason": "本次任务日志不可写；继续保存全局日志，终端仅显示简短提示。",
             "payload": {"message": "本次任务的 events.jsonl 不可写；继续保存全局日志。",
                         "path": str(self.run_path)}})

    def __call__(self, event, fields=None):
        # Background web progress and the task loop share this sink. Keep each
        # event's segments in the same order in both files, including rotation.
        with self._lock:
            if not self._closed:
                self._record(event, fields)

    def _record(self, event, fields=None):
        result = {"time": datetime.now(timezone.utc).isoformat(), "component": "desktop-agent", "event": str(event)[:100]}
        for key, value in (fields or {}).items():
            if key not in self.FIELDS or not isinstance(value, (str, int, float, bool, type(None))):
                continue
            if isinstance(value, str):
                for secret in self.secrets:
                    if secret:
                        value = value.replace(secret, "[REDACTED]")
                value = value[:500]
            result[key] = value
        records = [result]
        if "payload" in (fields or {}):
            if not self.content:
                result["payload_omitted"] = True
            else:
                raw = json.dumps(redact_content(fields["payload"], self.secrets), ensure_ascii=False, default=str)
                chars = len(raw)
                raw = raw[:self.max_content_chars]
                parts = max(1, (len(raw) + self.chunk_chars - 1) // self.chunk_chars)
                payload_id = uuid4().hex
                records = [{**result, "payload_id": payload_id, "part": index + 1, "parts": parts, "chars": chars,
                            "truncated": chars > len(raw), "payload": raw[index*self.chunk_chars:(index+1)*self.chunk_chars]} for index in range(parts)]
        for record in records:
            line = json.dumps(record, ensure_ascii=False, default=str)
            if self.handler:
                self.handler.emit(logging.LogRecord("desktop-agent", logging.INFO, "", 0, line, (), None))
            if self._run_handle is not None:
                try:
                    self._run_handle.write(line + "\n")
                    self._run_handle.flush()
                except (OSError, ValueError) as exc:
                    self._warn_run_log_failure(type(exc).__name__)

    def close(self):
        with self._lock:
            if self._closed:
                return
            self._close()
            self._closed = True

    def _close(self):
        if self._run_handle is not None:
            try:
                self._run_handle.close()
            except (OSError, ValueError) as exc:
                self._warn_run_log_failure(type(exc).__name__)
            finally:
                self._run_handle = None
                self.run_log_available = False
        if self.handler:
            try:
                self.handler.close()
            except (OSError, ValueError):
                self._warn_global_log_failure()
