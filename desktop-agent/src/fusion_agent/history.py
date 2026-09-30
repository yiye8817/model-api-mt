"""Bounded, local history views. Saved data is never an execution instruction.

Session indexes contain references, timestamps and model names only. Existing
run folders remain the source of tasks/results, including runs from releases
which did not yet have interactive session indexes.
"""

from contextlib import contextmanager
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import re
import stat
import time
from uuid import uuid4

from .audit import redact_content
from .rendering import safe_terminal_text


_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}\Z")
_DIRECTORY = os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_NOFOLLOW", 0)
MAX_ENTRIES = 10000
MAX_SESSION_RUNS = 2000
MAX_SESSION_BYTES = 512 * 1024
MAX_STATE_BYTES = 512 * 1024
MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024
MAX_RESULT_BYTES = 2 * 1024 * 1024
MAX_QUERY_BYTES = 32 * 1024 * 1024


def _identifier(value):
    if not isinstance(value, str) or not _ID.fullmatch(value):
        raise ValueError("历史标识只能包含字母、数字、下划线和连字符，最多 128 字符。")
    return value


def _limit(value, maximum=200):
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= maximum:
        raise ValueError(f"历史查询数量必须在 1 至 {maximum} 之间。")
    return value


def _timestamp(value):
    if isinstance(value, (float, int)) and not isinstance(value, bool):
        try:
            if math.isfinite(value):
                return datetime.fromtimestamp(value, timezone.utc).isoformat()
        except (ValueError, OSError, OverflowError):
            pass
    return ""


class _Budget:
    def __init__(self, size=MAX_QUERY_BYTES):
        self.remaining = size


class History:
    """Read task summaries/details and persist minimal interactive sessions.

    Query scans are limited to 10,000 directory entries and 32 MiB of content.
    Unreadable, linked, oversized and damaged records are skipped independently.
    A detail result contains user-task text, final Markdown and tool status only;
    it deliberately omits system prompts, action arguments and tool output.
    """

    def __init__(self, runtime_dir, secrets=()):
        self.root = Path(runtime_dir).expanduser().absolute()
        self.secrets = tuple(value for value in secrets if isinstance(value, str) and value)

    def _text(self, value, maximum=None, *, single_line=False):
        if not isinstance(value, str):
            return ""
        value = safe_terminal_text(redact_content(value, self.secrets)).encode("utf-8", "replace").decode("utf-8")
        if single_line:
            value = " ".join(value.split())
        if maximum is not None and len(value) > maximum:
            value = value[:maximum] + "…"
        return value

    @contextmanager
    def _folder(self, name, *, create=False):
        # Match Runtime's no-linked-ancestor rule, then use directory-relative
        # opens so replacing a checked child pathname cannot redirect a read.
        if any(part.is_symlink() for part in (self.root, *self.root.parents)):
            raise ValueError("历史记录目录及上级目录不能是符号链接。")
        if create:
            self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        root_fd = os.open(self.root, _DIRECTORY)
        child_fd = None
        try:
            if create:
                try:
                    os.mkdir(name, mode=0o700, dir_fd=root_fd)
                except FileExistsError:
                    pass
            child_fd = os.open(name, _DIRECTORY, dir_fd=root_fd)
            if create:
                os.fchmod(child_fd, 0o700)
            yield child_fd
        finally:
            if child_fd is not None:
                os.close(child_fd)
            os.close(root_fd)

    def _read(self, parent_fd, name, maximum, budget, *, decode_json=False):
        fd = None
        try:
            # NONBLOCK prevents a forged FIFO from stalling a history command.
            fd = os.open(name, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | os.O_NONBLOCK, dir_fd=parent_fd)
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_size > maximum or info.st_size > budget.remaining:
                return None
            ceiling = min(maximum, budget.remaining)
            chunks = []
            size = 0
            while size <= ceiling:
                chunk = os.read(fd, min(65536, ceiling + 1 - size))
                if not chunk:
                    break
                size += len(chunk)
                chunks.append(chunk)
            budget.remaining = max(0, budget.remaining - size)
            if size > ceiling:
                return None
            text = b"".join(chunks).decode("utf-8")
            return json.loads(text) if decode_json else text
        except (OSError, ValueError, UnicodeError, RecursionError):
            return None
        finally:
            if fd is not None:
                os.close(fd)

    @staticmethod
    def _names(folder_fd, *, sessions=False):
        names = []
        with os.scandir(folder_fd) as entries:
            for index, entry in enumerate(entries):
                if index >= MAX_ENTRIES:
                    break
                name = entry.name[:-5] if sessions and entry.name.endswith(".json") else entry.name
                if not _ID.fullmatch(name):
                    continue
                if sessions and entry.name != name + ".json":
                    continue
                try:
                    if (entry.is_file(follow_symlinks=False) if sessions else entry.is_dir(follow_symlinks=False)):
                        names.append(name)
                except OSError:
                    continue
        return sorted(names, reverse=True)

    def _sessions(self, budget):
        values = []
        try:
            with self._folder("sessions") as folder_fd:
                for name in self._names(folder_fd, sessions=True):
                    value = self._read(folder_fd, name + ".json", MAX_SESSION_BYTES, budget, decode_json=True)
                    if not isinstance(value, dict) or value.get("session_id") != name or not isinstance(value.get("runs"), list):
                        continue
                    values.append(value)
        except (OSError, ValueError):
            pass
        return values

    @staticmethod
    def _references(sessions):
        refs = {}
        for session in sessions:
            for item in session["runs"][:MAX_SESSION_RUNS]:
                if isinstance(item, dict) and isinstance(item.get("run_id"), str) and _ID.fullmatch(item["run_id"]):
                    refs.setdefault(item["run_id"], {**item, "session_id": session["session_id"]})
        return refs

    def _run(self, folder_fd, run_id, budget, reference=None, *, detail=False, query=""):
        run_fd = None
        try:
            run_fd = os.open(run_id, _DIRECTORY, dir_fd=folder_fd)
            state = self._read(run_fd, "state.json", MAX_STATE_BYTES, budget, decode_json=True)
            transcript = self._read(run_fd, "transcript.json", MAX_TRANSCRIPT_BYTES, budget, decode_json=True)
            if not isinstance(state, dict):
                state = {}
            if not isinstance(transcript, list):
                transcript = []
            # An events-only reservation is not yet a user-visible task record.
            if not state and not transcript:
                return None
            task, original_task, user_tasks, tools = "", "", [], []
            for message in transcript[:2000]:
                if not isinstance(message, dict) or message.get("role") != "user" or not isinstance(message.get("content"), str):
                    continue
                try:
                    content = json.loads(message["content"])
                except (ValueError, RecursionError):
                    continue
                if not isinstance(content, dict):
                    continue
                if content.get("type") == "original_user_task":
                    # A transcript may retain messages from an already-completed
                    # conversation before starting an independent task.  The
                    # newest explicit original-task boundary owns this run;
                    # earlier tasks and tool summaries are historical context,
                    # not searchable metadata for the new run.
                    task = original_task = self._text(content.get("task"), 128000)
                    user_tasks = [task]
                    tools = []
                elif content.get("type") == "followup_user_task":
                    task = self._text(content.get("task"), 128000)
                    user_tasks.append(task)
                    # Only tools after this round's input belong to this run's
                    # step summary. Earlier observations remain in its transcript.
                    tools = []
                if detail and content.get("type") == "untrusted_tool_observation" and len(tools) < 200:
                    observation = content.get("observation")
                    if not isinstance(observation, dict):
                        continue
                    error = observation.get("error")
                    unknown = observation.get("outcome_unknown") is True
                    verification = observation.get("verification")
                    verification = verification if isinstance(verification, dict) else {}
                    tools.append({"tool": self._text(content.get("tool"), 100, single_line=True),
                                  "ok": observation.get("ok") is True,
                                  "outcome_unknown": unknown,
                                  "status": "待核验" if unknown or verification.get("status") == "pending" else "失败" if verification.get("status") == "failed" or observation.get("ok") is not True else "成功",
                                  "error_code": self._text(error.get("code"), 100, single_line=True) if isinstance(error, dict) else ""})
            answer = self._read(run_fd, "final.md", MAX_RESULT_BYTES, budget)
            if answer is None:
                answer = self._read(run_fd, "result.md", MAX_RESULT_BYTES, budget)
            reference = reference or {}
            steps = state.get("steps", 0)
            report = {"run_id": run_id,
                      "task": self._text(task, 128000 if detail else 400, single_line=not detail),
                      "original_task": self._text(original_task, 128000 if detail else 400, single_line=not detail),
                      "status": self._text(state.get("status", "unknown"), 80, single_line=True),
                      "model": self._text(reference.get("model") or state.get("model"), 200, single_line=True),
                      "started_at": _timestamp(state.get("started_at") or reference.get("started_at")),
                      "updated_at": _timestamp(state.get("updated_at")),
                      "steps": steps if isinstance(steps, int) and not isinstance(steps, bool) and 0 <= steps <= 200 else 0,
                      "session_id": reference.get("session_id"),
                      "answer": self._text(answer, None if detail else 400, single_line=not detail)}
            if query and query.casefold() not in " ".join((run_id, *user_tasks, self._text(answer), report["model"], report["status"])).casefold():
                return None
            if detail:
                report["tools"] = tools
                report["error_code"] = self._text(state.get("error_code"), 100, single_line=True)
                report["read_only"] = True
                report["notice"] = "历史记录仅供查看；不会恢复执行、重放动作或作为当前任务指令。"
            return report
        except OSError:
            return None
        finally:
            if run_fd is not None:
                os.close(run_fd)

    def list_runs(self, query="", limit=20, session_id=None):
        """Newest matching task/result summaries; no raw assistant/tool output."""
        _limit(limit)
        if not isinstance(query, str) or len(query) > 500:
            raise ValueError("历史查询关键词不能超过 500 字符。")
        if session_id is not None:
            _identifier(session_id)
        budget = _Budget()
        references = self._references(self._sessions(_Budget(4 * 1024 * 1024)))
        rows = []
        try:
            with self._folder("runs") as folder_fd:
                for name in self._names(folder_fd):
                    reference = references.get(name, {})
                    if session_id is not None and reference.get("session_id") != session_id:
                        continue
                    row = self._run(folder_fd, name, budget, reference, query=query)
                    if row:
                        rows.append(row)
                        if len(rows) >= limit:
                            break
        except (OSError, ValueError):
            pass
        return rows

    def detail(self, run_id):
        _identifier(run_id)
        budget = _Budget()
        reference = self._references(self._sessions(_Budget(4 * 1024 * 1024))).get(run_id)
        try:
            with self._folder("runs") as folder_fd:
                result = self._run(folder_fd, run_id, budget, reference, detail=True)
        except (OSError, ValueError):
            result = None
        if result is None:
            raise ValueError("未找到可读取的任务记录；记录可能损坏、过大或不是普通文件。")
        return result

    def list_sessions(self, limit=20):
        _limit(limit)
        return [{"session_id": item["session_id"], "started_at": _timestamp(item.get("started_at")),
                 "updated_at": _timestamp(item.get("updated_at")),
                 "model": self._text(item.get("model"), 200, single_line=True),
                 "run_count": len(item["runs"][:MAX_SESSION_RUNS])}
                for item in self._sessions(_Budget())[:limit]]

    def session_detail(self, session_id, limit=100):
        _identifier(session_id)
        _limit(limit)
        session = next((item for item in self._sessions(_Budget()) if item["session_id"] == session_id), None)
        if session is None:
            raise ValueError("未找到可读取的交互会话。")
        return {"session_id": session_id, "started_at": _timestamp(session.get("started_at")),
                "model": self._text(session.get("model"), 200, single_line=True),
                "runs": self.list_runs(limit=limit, session_id=session_id), "read_only": True}

    def recent_tasks(self, limit=100):
        """Local, single-line suggestions; never returns slash commands/controls."""
        _limit(limit)
        tasks = []
        for item in self.list_runs(limit=200):
            task = self._text(item["task"], single_line=True)
            if task and not task.startswith("/") and not task.endswith("…") and task not in tasks:
                tasks.append(task)
                if len(tasks) >= limit:
                    break
        return tasks

    @staticmethod
    def _write_session(folder_fd, session_id, value, *, replace=True):
        encoded = json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False).encode("utf-8")
        if len(encoded) > MAX_SESSION_BYTES:
            raise ValueError("交互会话索引已达到大小限制，请启动新的交互会话。")
        temporary = ".session-" + uuid4().hex
        fd = None
        try:
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600, dir_fd=folder_fd)
            os.fchmod(fd, 0o600)
            with os.fdopen(fd, "wb") as handle:
                fd = None
                handle.write(encoded)
                handle.flush()
                os.fsync(handle.fileno())
            if replace:
                os.replace(temporary, session_id + ".json", src_dir_fd=folder_fd, dst_dir_fd=folder_fd)
            else:
                # link is an atomic no-overwrite publication of a new index.
                os.link(temporary, session_id + ".json", src_dir_fd=folder_fd, dst_dir_fd=folder_fd, follow_symlinks=False)
            os.fsync(folder_fd)
        finally:
            if fd is not None:
                os.close(fd)
            try:
                os.unlink(temporary, dir_fd=folder_fd)
            except FileNotFoundError:
                pass

    def start_session(self, model=""):
        with self._folder("sessions", create=True) as folder_fd:
            for _ in range(8):
                session_id = "session-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ-") + uuid4().hex[:8]
                now = time.time()
                value = {"version": 1, "session_id": session_id, "started_at": now, "updated_at": now,
                         "model": self._text(model, 200, single_line=True), "runs": []}
                try:
                    self._write_session(folder_fd, session_id, value, replace=False)
                    return session_id
                except FileExistsError:
                    continue
        raise ValueError("无法生成新的交互会话标识。")

    def record_run(self, session_id, run_id, *, model="", task=None):
        """Attach a reserved run. Task is intentionally not duplicated in index."""
        _identifier(session_id)
        _identifier(run_id)
        with self._folder("sessions") as folder_fd:
            value = self._read(folder_fd, session_id + ".json", MAX_SESSION_BYTES, _Budget(), decode_json=True)
            if not isinstance(value, dict) or value.get("session_id") != session_id or not isinstance(value.get("runs"), list):
                raise ValueError("交互会话索引不可读取；已有任务记录未修改。")
            if any(isinstance(item, dict) and item.get("run_id") == run_id for item in value["runs"]):
                return
            if len(value["runs"]) >= MAX_SESSION_RUNS:
                raise ValueError("该交互会话已达到 2000 个任务，请启动新的交互会话。")
            now = time.time()
            value["runs"].append({"run_id": run_id, "model": self._text(model, 200, single_line=True), "started_at": now})
            value["updated_at"] = now
            self._write_session(folder_fd, session_id, value)
