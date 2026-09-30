"""Private, bounded file handoff from the HTTP client to the local Agent.

Paths are created locally, never supplied by a server/model. A ResponseFile is
an in-process capability: only the exact outstanding reference issued by this
store may be consumed. Files are untrusted bytes until read and digest-checked.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import tempfile
import time
from uuid import uuid4

from .payload_repair import REPAIR_ALGORITHM


class ResponseFileError(ValueError):
    pass


def private_directory(path: Path) -> Path:
    """Refuse pre-existing symlinks, including parent components."""
    path = Path(os.path.abspath(path))
    if any(part.is_symlink() for part in (path, *path.parents)):
        raise ResponseFileError("响应/调试目录及其上级目录不能是符号链接。")
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    if not path.is_dir():
        raise ResponseFileError("响应/调试目录不是普通目录。")
    os.chmod(path, 0o700)
    return path


def private_write(path: Path, raw: bytes) -> None:
    """Publish a complete 0600 file in a private directory, never follow links."""
    parent = private_directory(path.parent)
    target = parent / path.name
    if target.exists() or target.is_symlink():
        raise ResponseFileError("拒绝覆盖已有响应/调试文件。")
    fd, temp = tempfile.mkstemp(prefix=".pending-", dir=parent)
    try:
        with os.fdopen(fd, "wb") as output:
            output.write(raw)
            output.flush()
            os.fsync(output.fileno())
        # link is an atomic no-clobber publication; replacing a pre-existing
        # user-selected path, even a dangling symlink, is never allowed.
        os.link(temp, target, follow_symlinks=False)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def json_bytes(value) -> bytes:
    # ensure_ascii also preserves lone surrogate evidence in invalid responses
    # without allowing a debug sink to crash the actual task.
    return (json.dumps(value, ensure_ascii=True, allow_nan=False, indent=2) + "\n").encode("utf-8")


@dataclass(frozen=True)
class ResponseFile:
    response_id: str
    path: str
    sha256: str
    bytes: int

    def metadata(self) -> dict:
        return {"type": "local_response_file", **asdict(self)}


class ResponseStore:
    MAX_REPLY_CHARS = 512 * 1024
    MAX_REPLY_BYTES = 4 * MAX_REPLY_CHARS

    def __init__(self, root: Path, *, retain_content: bool = True, event=None):
        self.root = Path(os.path.abspath(root))
        self.retain_content = retain_content is True
        self.event = event
        self._issued: dict[str, ResponseFile] = {}
        self._reserved: set[str] = set()
        self._wire_files: dict[str, Path] = {}

    def _emit(self, name, **fields):
        if self.event:
            self.event(name, fields)

    def _folder(self, response_id: str) -> Path:
        if not isinstance(response_id, str) or not re.fullmatch(r"[0-9a-f]{32}", response_id):
            raise ResponseFileError("响应文件编号不合法。")
        return self.root / response_id

    def reserve(self) -> str:
        private_directory(self.root)
        for _ in range(8):
            response_id = uuid4().hex
            try:
                self._folder(response_id).mkdir(mode=0o700, exist_ok=False)
            except FileExistsError:
                continue
            self._reserved.add(response_id)
            return response_id
        raise ResponseFileError("无法分配唯一响应目录。")

    def save_http(self, response_id: str, raw: bytes, metadata: dict) -> None:
        """Archive the bounded body only. Never persist request auth headers."""
        folder = self._folder(response_id)
        if response_id not in self._reserved:
            raise ResponseFileError("HTTP 响应编号不是本次本地请求。")
        if len(raw) > 64 * 1024 * 1024 + 1:
            raise ResponseFileError("HTTP 响应归档超过大小限制。")
        info = {"version": 1, "created_at": time.time(), "response_id": response_id,
                "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest(),
                "content_retained": self.retain_content, **metadata}
        if self.retain_content:
            wire = folder / "http-response.body"
            private_write(wire, raw)
            self._wire_files[response_id] = wire
            info["body_file"] = str(wire)
        private_write(folder / "http-metadata.json", json_bytes(info))

    def put(self, content: str, *, response_id: str | None = None, metadata=None) -> ResponseFile:
        if not isinstance(content, str) or len(content) > self.MAX_REPLY_CHARS:
            raise ResponseFileError("响应文本超过 512 Ki 字符限制或不是文本。")
        try:
            raw = content.encode("utf-8")
        except UnicodeError:
            raise ResponseFileError("响应不是有效 UTF-8 文本。") from None
        response_id = response_id or self.reserve()
        folder = self._folder(response_id)
        # Caller-issued IDs must have been reserved locally in this store.
        if response_id not in self._reserved or not folder.is_dir() or folder.is_symlink():
            raise ResponseFileError("响应目录尚未在本地创建。")
        path = folder / "reply.txt"
        private_write(path, raw)
        ref = ResponseFile(response_id, str(path), hashlib.sha256(raw).hexdigest(), len(raw))
        private_write(folder / "response.json", json_bytes({
            **ref.metadata(), "version": 1, "created_at": time.time(),
            "encoding": "utf-8", "content_retained": self.retain_content,
            "metadata": metadata or {}, "authority": "untrusted_model_response"}))
        self._issued[response_id] = ref
        self._emit("model.response_file_saved", **ref.metadata(), content_retained=self.retain_content)
        return ref

    def read(self, ref: ResponseFile) -> str:
        """Read before any parsing/dispatch; consume once, detect tampering."""
        if not isinstance(ref, ResponseFile) or self._issued.get(ref.response_id) is not ref:
            raise ResponseFileError("响应文件引用未知、不是本次请求或已被消费。")
        expected = self._folder(ref.response_id) / "reply.txt"
        if ref.path != str(expected) or any(p.is_symlink() for p in (expected, *expected.parents)):
            raise ResponseFileError("响应路径越界或包含符号链接。")
        fd = os.open(expected, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
        try:
            info = os.fstat(fd)
            if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
                    or info.st_size != ref.bytes or info.st_size > self.MAX_REPLY_BYTES
                    or stat.S_IMODE(info.st_mode) & 0o077):
                raise ResponseFileError("响应文件类型、权限或大小已变化，停止执行。")
            with os.fdopen(fd, "rb", closefd=False) as input_file:
                raw = input_file.read(self.MAX_REPLY_BYTES + 1)
            if len(raw) != ref.bytes or hashlib.sha256(raw).hexdigest() != ref.sha256:
                raise ResponseFileError("响应文件 SHA-256 校验失败，停止执行。")
            try:
                text = raw.decode("utf-8")
            except UnicodeError:
                raise ResponseFileError("响应文件不是有效 UTF-8。") from None
            if len(text) > self.MAX_REPLY_CHARS:
                raise ResponseFileError("响应文件字符数超过限制。")
        finally:
            os.close(fd)
        del self._issued[ref.response_id]
        if not self.retain_content:
            expected.unlink()
        self._emit("agent.response_file_read", **ref.metadata(), verified=True,
                   transient_deleted=not self.retain_content)
        return text

    def discard(self, response_id: str) -> None:
        """Best-effort cleanup of metadata-only handoffs not consumed by Runtime."""
        if self.retain_content:
            return
        self._issued.pop(response_id, None)
        if response_id in self._reserved:
            try:
                (self._folder(response_id) / "reply.txt").unlink(missing_ok=True)
            except OSError:
                pass


class RepairArchive:
    """Save exact problem input + normalized JSON + diagnostics for offline replay.

    Metadata-only policy deliberately saves no original/normalized contents.
    Contents are private but not redacted: redaction changes the failing bytes.
    """
    MAX_SAMPLES = 512

    def __init__(self, root: Path, *, enabled=True, content=True):
        self.root = Path(os.path.abspath(root))
        self.enabled = enabled is True
        self.content = content is True
        self.count = 0

    def save(self, source: str, *, action=None, normalizations=(), error=None, step=0, metadata=None) -> dict | None:
        if not self.enabled:
            return None
        if self.count >= self.MAX_SAMPLES:
            raise ResponseFileError("本轮 JSON 调试样本已达到 512 条上限。")
        raw = source.encode("utf-8", errors="surrogatepass")
        if len(raw) > ResponseStore.MAX_REPLY_BYTES:
            raise ResponseFileError("JSON 调试样本超过大小限制。")
        private_directory(self.root)
        folder = self.root / (f"{self.count + 1:04d}-step-{step:03d}-" + uuid4().hex[:12])
        folder.mkdir(mode=0o700, exist_ok=False)
        self.count += 1
        info = {"version": 1, "algorithm": REPAIR_ALGORITHM, "created_at": time.time(),
                "step": step, "status": "failed" if error else ("repaired" if normalizations else "valid"), "server_retry": False,
                "executed": False, "sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw),
                "content_retained": self.content, "metadata": metadata or {}}
        paths = {"directory": str(folder), "report": str(folder / "report.json")}
        if error and getattr(error, "details", {}).get("incomplete_response"):
            info.update(status="incomplete", executable=False)
        if self.content:
            private_write(folder / "original.invalid.json", raw)
            paths["original"] = str(folder / "original.invalid.json")
            info["normalizations"] = list(normalizations)
            info["error"] = ({"message": str(error), "details": getattr(error, "details", {})}
                             if error else None)
            try:
                json.loads(source)
            except json.JSONDecodeError as exc:
                info["original_json_error"] = {"line": exc.lineno, "column": exc.colno,
                                                "position": exc.pos, "message": exc.msg}
            except (ValueError, RecursionError):
                info["original_json_error"] = {"message": "value_or_depth_limit"}
            if error and getattr(error, "details", {}).get("incomplete_response"):
                info["status"] = "incomplete"
                info["executable"] = False
                partial = error.details.get("partial_answer")
                if isinstance(partial, str):
                    private_write(folder / "partial.txt", partial.encode("utf-8"))
                    private_write(folder / "partial.json", json_bytes({
                        "type": "incomplete_response", "partial_answer": partial,
                        "complete": False, "executable": False,
                        "notice": "Diagnostic only; never dispatch as an Agent action/final."}))
                    paths["partial_text"] = str(folder / "partial.txt")
                    paths["partial_json"] = str(folder / "partial.json")
            if action is not None:
                private_write(folder / "normalized.json", json_bytes(action))
                paths["normalized"] = str(folder / "normalized.json")
                field = {"python.run": "code", "local.run": "fallback_python"}.get(action.get("tool"))
                code = action.get("arguments", {}).get(field) if field else None
                if isinstance(code, str):
                    code_bytes = code.encode("utf-8", errors="surrogatepass")
                    private_write(folder / "decoded-tool.py", code_bytes)
                    paths["python_source"] = str(folder / "decoded-tool.py")
                    info["python_source"] = {"field": "arguments." + field,
                        "sha256": hashlib.sha256(code_bytes).hexdigest(), "bytes": len(code_bytes),
                        "executed": False, "notice": "Debug copy only; repair never executes code."}
        else:
            info["normalization_kinds"] = [item.get("kind") for item in normalizations]
            info["error_type"] = type(error).__name__ if error else None
        info["files"] = paths
        private_write(folder / "report.json", json_bytes(info))
        return {**paths, "status": info["status"], "sha256": info["sha256"],
                "content_retained": self.content}
