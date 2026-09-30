"""Local files and CLI tools. Shell commands run with the current user's permissions.

CLI defaults to host scope: workspace is a default directory, not a boundary.
Explicit workspace scope keeps the old files/cwd restriction. Neither is an OS
sandbox: an authorized shell command has its system user's permissions.
Command output is returned as an untrusted observation, never written to logs here.
"""

from __future__ import annotations

import codecs
import errno
import json
import os
from pathlib import Path
import selectors
import shutil
import signal
import stat
import subprocess
import sys
import threading
import time
import uuid

from .contracts import ToolError, ToolSpec
from .tool_resolution import executable_missing, simple_read_target


_ENV_ALLOWLIST = (
    "PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TERM",
    "TMPDIR", "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR",
    "DBUS_SESSION_BUS_ADDRESS", "XAUTHORITY", "XDG_CONFIG_HOME", "XDG_CACHE_HOME",
    # Chrome's Linux v11 cookie encryption selects the Secret Service backend
    # from the desktop-session environment.  Keep these non-secret session
    # markers and the keyring socket so yt-dlp can reuse the user's login
    # session when an authorized local tool is run by desktop-agent.
    "XDG_CURRENT_DESKTOP", "XDG_SESSION_TYPE", "XDG_SESSION_DESKTOP",
    "GNOME_DESKTOP_SESSION_ID", "SSH_AUTH_SOCK",
)
_MAX_FILE_BYTES = 1024 * 1024


def _integer(value, name, minimum, maximum):
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise ToolError("invalid_arguments", f"{name} must be an integer in {minimum}..{maximum}", not_executed=True)
    return value


def _boolean(value, name):
    if not isinstance(value, bool):
        raise ToolError("invalid_arguments", f"{name} must be a boolean", not_executed=True)
    return value


class _Output:
    def __init__(self, limit):
        self.limit = limit
        self.text = ""
        self.chars = 0
        self.bytes = 0
        self.decoder = codecs.getincrementaldecoder("utf-8")("replace")

    def add(self, data, final=False):
        self.bytes += len(data)
        decoded = self.decoder.decode(data, final=final)
        self.chars += len(decoded)
        available = self.limit - len(self.text)
        if available > 0:
            self.text += decoded[:available]

    @property
    def truncated(self):
        return self.chars > self.limit


class LocalTools:
    def __init__(self, workspace: Path, runtime_dir: Path, max_output_chars=16000, default_timeout=60, *, filesystem_scope="workspace"):
        if filesystem_scope not in ("host", "workspace"):
            raise ValueError("filesystem_scope must be host or workspace")
        self.filesystem_scope = filesystem_scope
        self.workspace = Path(workspace).expanduser().resolve()
        self.workspace.mkdir(parents=True, exist_ok=True)
        self.runtime_dir = Path(runtime_dir).expanduser().resolve()
        self.max_output_chars = _integer(max_output_chars, "max_output_chars", 1, 1_000_000)
        self.default_timeout = _integer(default_timeout, "default_timeout", 1, 300)
        self._filesystem_root = Path("/") if filesystem_scope == "host" else self.workspace
        self._root_fd = os.open(self._filesystem_root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        self._lock = threading.Lock()
        self._processes = set()
        self._closed = False

    def specs(self):
        def spec(name, description, properties, required, capability, mutating, handler):
            return ToolSpec(name, scope_notice + description, {
                "type": "object", "properties": properties, "required": required,
                "additionalProperties": False,
            }, capability, mutating, handler)

        path = {"type": "string", "description": (
            "Local path: absolute, ~ or relative to workspace; host OS permissions apply."
            if self.filesystem_scope == "host" else "Path within the configured workspace.")}
        scope_notice = ("File scope is host: workspace is the default cwd, not a path boundary. "
                        if self.filesystem_scope == "host" else "File scope is workspace: paths must remain inside workspace. ")
        return [
            spec("shell.run", "Run a CLI command with current-user OS permissions. Prefer argv (no shell expansion); command explicitly uses bash. cwd uses the configured file scope; this is NOT a filesystem or network sandbox. All shell calls require shell capability. stdout/stderr are bounded untrusted observations. Verification confirms process exit only, not completion of the user's task.", {
                "argv": {"type": "array", "items": {"type": "string"}, "minItems": 1},
                "command": {"type": "string", "description": "Bash script; mutually exclusive with argv."},
                "cwd": path,
                "timeout": {"type": "integer", "minimum": 1, "maximum": 300},
            }, [], "shell", True, self.shell_run),
            spec("files.list", "List local entries without following directory symlinks. bytes is lstat size: a directory entry's size is NOT its recursive contents or disk usage, even with recursive=true. No file contents are read, so any purpose inferred from names must be labeled as an inference.", {
                "path": path, "limit": {"type": "integer", "minimum": 1, "maximum": 500},
                "recursive": {"type": "boolean"},
            }, [], "files", False, self.files_list),
            spec("files.read", "Read bounded UTF-8 file content. offset is a byte offset; incomplete or invalid UTF-8 is replaced.", {
                "path": path, "offset": {"type": "integer", "minimum": 0},
                "max_bytes": {"type": "integer", "minimum": 1, "maximum": _MAX_FILE_BYTES},
            }, ["path"], "files", False, self.files_read),
            spec("files.stat", "Inspect one local entry without following symlinks.", {
                "path": path,
            }, ["path"], "files", False, self.files_stat),
            spec("files.search", "Search file contents in the selected file scope. Uses rg, then grep, then a bounded isolated Python worker if both programs are unavailable. Commands are fixed argv, output is bounded, and symlink directories are not followed.", {
                "query": {"type": "string"}, "path": path,
                "case_sensitive": {"type": "boolean"}, "fixed_strings": {"type": "boolean"},
                "max_results": {"type": "integer", "minimum": 1, "maximum": 200},
                "timeout": {"type": "integer", "minimum": 1, "maximum": 60},
            }, ["query"], "files", False, self.files_search),
            spec("files.write", "Atomically write UTF-8 text locally and verify the destination by bounded byte-for-byte readback. Existing files require overwrite=true; parent creation requires create_parents=true.", {
                "path": path, "content": {"type": "string"}, "overwrite": {"type": "boolean"},
                "create_parents": {"type": "boolean"},
            }, ["path", "content"], "files", True, self.files_write),
            spec("files.mkdir", "Create a directory in the selected file scope and verify it. Parent creation is explicit.", {
                "path": path, "parents": {"type": "boolean"}, "exist_ok": {"type": "boolean"},
            }, ["path"], "files", True, self.files_mkdir),
            spec("files.copy", "Copy one regular local file atomically. Existing destinations require overwrite=true.", {
                "source": path, "destination": path, "overwrite": {"type": "boolean"},
                "create_parents": {"type": "boolean"},
            }, ["source", "destination"], "files", True, self.files_copy),
            spec("files.move", "Move one local file or directory without following symlinks. Existing destinations require overwrite=true.", {
                "source": path, "destination": path, "overwrite": {"type": "boolean"},
                "create_parents": {"type": "boolean"},
            }, ["source", "destination"], "files", True, self.files_move),
            spec("files.delete", "Delete one local file, symlink, or directory. Non-empty directories require recursive=true; the filesystem scope root cannot be deleted.", {
                "path": path, "recursive": {"type": "boolean"},
            }, ["path"], "files", True, self.files_delete),
        ]

    def _path(self, value="."):
        if self._closed:
            raise ToolError("closed", "Local tools are closed", not_executed=True)
        if not isinstance(value, str) or not value or "\x00" in value:
            raise ToolError("invalid_arguments", "path must be a nonempty string without NUL", not_executed=True)
        try:
            candidate = (self.workspace / Path(value).expanduser()).resolve()
            relative = candidate if self.filesystem_scope == "host" else candidate.relative_to(self.workspace)
        except (ValueError, RuntimeError, OSError):
            if self.filesystem_scope == "host":
                raise ToolError("path_resolution_failed", "Cannot resolve the requested local path", not_executed=True) from None
            raise ToolError(
                "path_outside_workspace",
                "Path must resolve inside the workspace; the requested target was not accessed. "
                "Do not replace the original target with an unrelated workspace listing. "
                "The user can explicitly choose another workspace before retrying.",
                not_executed=True,
                details={"requested_path": value[:4096], "workspace": str(self.workspace),
                         "recovery": "user_select_workspace", "access_performed": False},
            ) from None
        return candidate, relative

    def _dir_fd(self, relative, create=False):
        fd = os.dup(self._root_fd)
        try:
            parts = relative.parts[1:] if relative.is_absolute() else relative.parts
            for component in parts:
                if create:
                    try:
                        os.mkdir(component, 0o700, dir_fd=fd)
                    except FileExistsError:
                        pass
                next_fd = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                os.close(fd)
                fd = next_fd
            return fd
        except OSError:
            os.close(fd)
            raise

    def _lexical_relative(self, value):
        if self._closed:
            raise ToolError("closed", "Local tools are closed", not_executed=True)
        if not isinstance(value, str) or not value or "\x00" in value:
            raise ToolError("invalid_arguments", "path must be a nonempty string without NUL", not_executed=True)
        if self.filesystem_scope == "host":
            path = Path(os.path.abspath(self.workspace / Path(value).expanduser()))
            # Resolve parents but preserve the leaf: stat/delete/move operate on
            # a symlink itself, never silently on its target.
            return path.parent.resolve() / path.name if path.name else Path("/")
        path = Path(value).expanduser()
        if path.is_absolute():
            try:
                path = path.relative_to(self.workspace)
            except ValueError:
                raise ToolError("path_outside_workspace", "Path must remain inside the configured workspace", not_executed=True) from None
        if any(part == ".." for part in path.parts):
            raise ToolError("path_outside_workspace", "Path must be relative and remain inside the workspace", not_executed=True)
        relative = Path(*[part for part in path.parts if part not in ("", ".")])
        if not relative.parts:
            return Path(".")
        return relative

    def _is_scope_root(self, path):
        return path == (Path("/") if self.filesystem_scope == "host" else Path("."))

    @staticmethod
    def _file_error(exc):
        if exc.errno in (errno.ELOOP, errno.ENOTDIR):
            return ToolError("unsafe_path", "Path includes a symlink or is not the expected file type")
        if isinstance(exc, FileExistsError):
            return ToolError("file_exists", "Destination exists; set overwrite=true to replace it")
        if isinstance(exc, FileNotFoundError):
            return ToolError("not_found", "File or directory does not exist")
        if isinstance(exc, PermissionError):
            return ToolError("permission_denied", "Current user lacks file permissions")
        return ToolError("file_error", f"File operation failed (errno={exc.errno})")

    def files_list(self, args):
        _, relative = self._path(args.get("path", "."))
        limit = _integer(args.get("limit", 100), "limit", 1, 500)
        recursive = _boolean(args.get("recursive", False), "recursive")
        entries = []
        truncated = False

        def visit(fd, base):
            nonlocal truncated
            with os.scandir(fd) as iterator:
                for entry in iterator:
                    if len(entries) >= limit:
                        truncated = True
                        return
                    info = entry.stat(follow_symlinks=False)
                    kind = "symlink" if stat.S_ISLNK(info.st_mode) else "directory" if stat.S_ISDIR(info.st_mode) else "file" if stat.S_ISREG(info.st_mode) else "special"
                    rel = base / entry.name
                    entries.append({"path": rel.as_posix(), "type": kind, "bytes": info.st_size})
                    if recursive and kind == "directory":
                        nested = os.open(entry.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                        try:
                            visit(nested, rel)
                        finally:
                            os.close(nested)
                        if truncated:
                            return

        try:
            fd = self._dir_fd(relative)
            try:
                visit(fd, relative)
            finally:
                os.close(fd)
        except OSError as exc:
            raise self._file_error(exc) from None
        return {"path": relative.as_posix(), "entries": sorted(entries, key=lambda item: item["path"]),
                "truncated": truncated,
                "size_semantics": {"bytes": "lstat_st_size", "directory_total_measured": False,
                                   "file_contents_read": False},
                "notice": "目录的 bytes 是目录项自身大小，不是递归内容总量或磁盘占用；"
                          "recursive=true 也不会计算目录总大小。未做容量统计时须标为未统计。"
                          "未读取文件内容，依据文件名推测的用途须明确标注为推测。"}

    def files_read(self, args):
        _, relative = self._path(args.get("path"))
        offset = _integer(args.get("offset", 0), "offset", 0, 2**63 - 1)
        limit = _integer(args.get("max_bytes", 65536), "max_bytes", 1, _MAX_FILE_BYTES)
        try:
            parent_fd = self._dir_fd(relative.parent)
            try:
                fd = os.open(relative.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent_fd)
            finally:
                os.close(parent_fd)
            with os.fdopen(fd, "rb") as stream:
                info = os.fstat(stream.fileno())
                if not stat.S_ISREG(info.st_mode):
                    raise ToolError("invalid_file", "Only regular files can be read")
                stream.seek(offset)
                data = stream.read(limit + 1)
        except OSError as exc:
            raise self._file_error(exc) from None
        truncated = len(data) > limit
        data = data[:limit]
        return {"path": relative.as_posix(), "content": data.decode("utf-8", "replace"), "bytes": len(data), "file_bytes": info.st_size, "offset": offset, "next_offset": offset + len(data), "truncated": truncated}

    def files_stat(self, args):
        relative = self._lexical_relative(args.get("path"))
        try:
            parent = self._dir_fd(relative.parent)
            try:
                info = (os.fstat(parent) if self._is_scope_root(relative)
                        else os.stat(relative.name, dir_fd=parent, follow_symlinks=False))
            finally:
                os.close(parent)
        except OSError as exc:
            raise self._file_error(exc) from None
        kind = "symlink" if stat.S_ISLNK(info.st_mode) else "directory" if stat.S_ISDIR(info.st_mode) else "file" if stat.S_ISREG(info.st_mode) else "special"
        return {"path": relative.as_posix(), "type": kind, "bytes": info.st_size,
                "mode": oct(stat.S_IMODE(info.st_mode)), "modified_ns": info.st_mtime_ns}

    def files_search(self, args):
        query = args.get("query")
        if not isinstance(query, str) or not query or "\x00" in query:
            raise ToolError("invalid_arguments", "query must be a nonempty string without NUL", not_executed=True)
        _, relative = self._path(args.get("path", "."))
        case = _boolean(args.get("case_sensitive", True), "case_sensitive")
        fixed = _boolean(args.get("fixed_strings", True), "fixed_strings")
        limit = _integer(args.get("max_results", 100), "max_results", 1, 200)
        timeout = _integer(args.get("timeout", min(self.default_timeout, 60)), "timeout", 1, 60)
        target = relative.as_posix() or "."
        rg = ["rg", "--json", "--color=never", "--no-messages"]
        if fixed: rg.append("--fixed-strings")
        if not case: rg.append("--ignore-case")
        rg.extend(["--", query, target])
        attempts = []
        try:
            result = self.shell_run({"argv": rg, "timeout": timeout})
        except ToolError as exc:
            if exc.code != "command_not_found": raise
            result = None
            attempts.append({"backend": "rg", "status": "unavailable"})
        matches = []
        backend = "rg"
        if result is not None:
            attempts.append({"backend": "rg", "status": "completed", "returncode": result["returncode"]})
            if result["returncode"] not in (0, 1):
                result = None
        if result is not None:
            for line in result["stdout"].splitlines():
                try: event = json.loads(line)
                except json.JSONDecodeError: continue
                if event.get("type") != "match": continue
                data = event["data"]; sub = data.get("submatches", [{}])[0]
                matches.append({"path": data["path"]["text"], "line": data["line_number"],
                                "column": sub.get("start", 0) + 1, "text": data["lines"]["text"].rstrip("\r\n")})
                if len(matches) >= limit: break
        else:
            backend = "grep"
            grep = ["grep", "-rIHn", "--binary-files=without-match"]
            if fixed: grep.append("-F")
            if not case: grep.append("-i")
            grep.extend(["--", query, target])
            try:
                result = self.shell_run({"argv": grep, "timeout": timeout})
            except ToolError as exc:
                if exc.code != "command_not_found" or not exc.not_executed:
                    raise
                attempts.append({"backend": "grep", "status": "unavailable"})
                # Fixed bundled source, not generated Python: files authorization
                # remains sufficient. A child process also bounds hostile regex.
                worker = Path(__file__).with_name("workspace_search.py")
                options = {"query": query, "path": str(Path(target).relative_to(self._filesystem_root)) if Path(target).is_absolute() else target, "case_sensitive": case,
                           "fixed_strings": fixed, "max_results": limit,
                           "budget": max(512, self.max_output_chars - 512)}
                result = self.shell_run({"argv": [sys.executable, "-I", str(worker),
                    str(self._filesystem_root), json.dumps(options, ensure_ascii=False)], "timeout": timeout})
                if result["timed_out"]:
                    return {"ok": False, "backend": "python", "query": query, "path": target,
                            "attempts": attempts, "error": {"code": "search_timeout",
                            "message": "Python search timed out; narrow the path or simplify the expression."}}
                try:
                    if result["stdout_truncated"]:
                        raise ValueError()
                    data = json.loads(result["stdout"])
                    if not isinstance(data, dict) or not isinstance(data.get("ok"), bool):
                        raise ValueError()
                except (ValueError, TypeError):
                    raise ToolError("python_search_output_invalid", "Python search did not return a complete result") from None
                ok = result["returncode"] == 0 and data["ok"]
                if self.filesystem_scope == "host":
                    for match in data.get("matches", []):
                        match["path"] = str(self._filesystem_root / match["path"])
                return {**data, "ok": ok, "query": query, "path": target, "backend": "python",
                        "attempts": [*attempts, {"backend": "python", "status": "completed"}],
                        "verification": {"status": "verified" if ok else "failed",
                                         "scope": "files", "method": "bounded_python_search"}}
            attempts.append({"backend": "grep", "status": "completed", "returncode": result["returncode"]})
            for line in result["stdout"].splitlines()[:limit]:
                parts = line.split(":", 2)
                if len(parts) == 3 and parts[1].isdigit():
                    matches.append({"path": parts[0], "line": int(parts[1]), "column": None, "text": parts[2]})
        ok = not result["timed_out"] and result["returncode"] in (0, 1)
        return {"ok": ok, "query": query, "path": target, "backend": backend, "matches": matches,
                "truncated": len(matches) >= limit or result["stdout_truncated"], "attempts": attempts,
                "verification": {"status": "verified" if ok else "failed", "method": "bounded_search_exit", "scope": "files"}}

    def files_mkdir(self, args):
        relative = self._lexical_relative(args.get("path"))
        if self._is_scope_root(relative):
            raise ToolError("invalid_file", "Cannot create the filesystem scope root", not_executed=True)
        parents = _boolean(args.get("parents", False), "parents")
        exist_ok = _boolean(args.get("exist_ok", False), "exist_ok")
        try:
            parent = self._dir_fd(relative.parent, create=parents)
            try:
                try: os.mkdir(relative.name, 0o700, dir_fd=parent)
                except FileExistsError:
                    info = os.stat(relative.name, dir_fd=parent, follow_symlinks=False)
                    if not exist_ok or not stat.S_ISDIR(info.st_mode): raise
                info = os.stat(relative.name, dir_fd=parent, follow_symlinks=False)
                verified = stat.S_ISDIR(info.st_mode)
                os.fsync(parent)
            finally: os.close(parent)
        except OSError as exc:
            raise self._file_error(exc) from None
        return {"ok": verified, "path": relative.as_posix(), "verification": {"status": "verified" if verified else "failed", "method": "directory_stat", "scope": "files"}}

    def files_copy(self, args):
        source = self._lexical_relative(args.get("source")); destination = self._lexical_relative(args.get("destination"))
        overwrite = _boolean(args.get("overwrite", False), "overwrite")
        create = _boolean(args.get("create_parents", False), "create_parents")
        if self._is_scope_root(source) or self._is_scope_root(destination):
            raise ToolError("invalid_file", "Source and destination must be files", not_executed=True)
        temp = f".fusion-agent-copy-{uuid.uuid4().hex}.tmp"
        src_parent = dst_parent = None
        try:
            src_parent = self._dir_fd(source.parent); dst_parent = self._dir_fd(destination.parent, create=create)
            try:
                src_fd = os.open(source.name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=src_parent)
                with os.fdopen(src_fd, "rb") as src:
                    info = os.fstat(src.fileno())
                    if not stat.S_ISREG(info.st_mode): raise ToolError("invalid_file", "Only regular files can be copied")
                    out_fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=dst_parent)
                    with os.fdopen(out_fd, "wb") as out:
                        shutil.copyfileobj(src, out, 1024 * 1024); out.flush(); os.fsync(out.fileno())
                        written = os.fstat(out.fileno())
                if overwrite: os.replace(temp, destination.name, src_dir_fd=dst_parent, dst_dir_fd=dst_parent)
                else: os.link(temp, destination.name, src_dir_fd=dst_parent, dst_dir_fd=dst_parent, follow_symlinks=False)
                os.fsync(dst_parent)
                verified = os.stat(destination.name, dir_fd=dst_parent, follow_symlinks=False).st_size == info.st_size == written.st_size
            finally:
                if dst_parent is not None:
                    try: os.unlink(temp, dir_fd=dst_parent)
                    except FileNotFoundError: pass
                if src_parent is not None: os.close(src_parent)
                if dst_parent is not None: os.close(dst_parent)
        except OSError as exc:
            raise self._file_error(exc) from None
        return {"ok": verified, "source": source.as_posix(), "destination": destination.as_posix(), "bytes": info.st_size,
                "verification": {"status": "verified" if verified else "failed", "method": "destination_stat", "scope": "files"}}

    def files_move(self, args):
        source = self._lexical_relative(args.get("source")); destination = self._lexical_relative(args.get("destination"))
        overwrite = _boolean(args.get("overwrite", False), "overwrite")
        create = _boolean(args.get("create_parents", False), "create_parents")
        if self._is_scope_root(source) or self._is_scope_root(destination):
            raise ToolError("invalid_file", "Cannot move the filesystem scope root", not_executed=True)
        try:
            src_parent = self._dir_fd(source.parent); dst_parent = self._dir_fd(destination.parent, create=create)
            try:
                os.stat(source.name, dir_fd=src_parent, follow_symlinks=False)
                if not overwrite:
                    try: os.stat(destination.name, dir_fd=dst_parent, follow_symlinks=False)
                    except FileNotFoundError: pass
                    else: raise FileExistsError(errno.EEXIST, "destination exists")
                os.replace(source.name, destination.name, src_dir_fd=src_parent, dst_dir_fd=dst_parent)
                os.fsync(src_parent); os.fsync(dst_parent)
                os.stat(destination.name, dir_fd=dst_parent, follow_symlinks=False)
                try: os.stat(source.name, dir_fd=src_parent, follow_symlinks=False); verified = False
                except FileNotFoundError: verified = True
            finally: os.close(src_parent); os.close(dst_parent)
        except OSError as exc:
            raise self._file_error(exc) from None
        return {"ok": verified, "source": source.as_posix(), "destination": destination.as_posix(),
                "verification": {"status": "verified" if verified else "failed", "method": "rename_stat", "scope": "files"}}

    def files_delete(self, args):
        relative = self._lexical_relative(args.get("path")); recursive = _boolean(args.get("recursive", False), "recursive")
        if self._is_scope_root(relative):
            raise ToolError("invalid_file", "Cannot delete the filesystem scope root", not_executed=True)
        try:
            parent = self._dir_fd(relative.parent)
            try:
                info = os.stat(relative.name, dir_fd=parent, follow_symlinks=False)
                if stat.S_ISDIR(info.st_mode):
                    if recursive:
                        self._delete_tree(parent, relative.name)
                    else: os.rmdir(relative.name, dir_fd=parent)
                else: os.unlink(relative.name, dir_fd=parent)
                os.fsync(parent)
                try: os.stat(relative.name, dir_fd=parent, follow_symlinks=False); verified = False
                except FileNotFoundError: verified = True
            finally: os.close(parent)
        except OSError as exc:
            raise self._file_error(exc) from None
        return {"ok": verified, "path": relative.as_posix(), "recursive": recursive,
                "verification": {"status": "verified" if verified else "failed", "method": "absence_stat", "scope": "files"}}

    def _delete_tree(self, parent_fd, name):
        """Remove a tree using directory descriptors and never follow links."""
        fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd)
        try:
            with os.scandir(fd) as entries:
                for entry in entries:
                    info = entry.stat(follow_symlinks=False)
                    if stat.S_ISDIR(info.st_mode): self._delete_tree(fd, entry.name)
                    else: os.unlink(entry.name, dir_fd=fd)
            os.fsync(fd)
        finally:
            os.close(fd)
        os.rmdir(name, dir_fd=parent_fd)

    @staticmethod
    def _written_file_matches(parent_fd, name, data, written_info):
        # Anchor readback to the same directory used for publication. Never follow
        # a replacement symlink or block opening a replacement FIFO.
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent_fd)
        with os.fdopen(fd, "rb") as stream:
            before = os.fstat(stream.fileno())
            expected_identity = (written_info.st_dev, written_info.st_ino)
            if not stat.S_ISREG(before.st_mode) or (before.st_dev, before.st_ino) != expected_identity:
                return False
            observed = stream.read(len(data) + 1)
            after = os.fstat(stream.fileno())
            destination = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        # This confirms only the observed destination now. Concurrent writers can
        # change it later; a replaced destination or a change during read fails.
        return (
            observed == data
            and before.st_size == after.st_size == len(data)
            and (before.st_mtime_ns, before.st_ctime_ns) == (after.st_mtime_ns, after.st_ctime_ns)
            and stat.S_ISREG(destination.st_mode)
            and (destination.st_dev, destination.st_ino) == expected_identity
            and (destination.st_size, destination.st_mtime_ns, destination.st_ctime_ns)
            == (after.st_size, after.st_mtime_ns, after.st_ctime_ns)
        )

    def files_write(self, args):
        _, relative = self._path(args.get("path"))
        content = args.get("content")
        if not isinstance(content, str):
            raise ToolError("invalid_arguments", "content must be a string", not_executed=True)
        try:
            data = content.encode("utf-8")
        except UnicodeEncodeError:
            raise ToolError("invalid_arguments", "content must contain valid Unicode text", not_executed=True) from None
        if len(data) > _MAX_FILE_BYTES:
            raise ToolError("file_too_large", "A single write is limited to 1 MiB", not_executed=True)
        overwrite = _boolean(args.get("overwrite", False), "overwrite")
        create = _boolean(args.get("create_parents", False), "create_parents")
        if not relative.name:
            raise ToolError("invalid_file", "Cannot replace the filesystem scope root", not_executed=True)
        temp_name = f".fusion-agent-{uuid.uuid4().hex}.tmp"
        try:
            parent_fd = self._dir_fd(relative.parent, create=create)
            try:
                fd = os.open(temp_name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent_fd)
                try:
                    with os.fdopen(fd, "wb") as stream:
                        stream.write(data)
                        stream.flush()
                        os.fsync(stream.fileno())
                        written_info = os.fstat(stream.fileno())
                    if overwrite:
                        os.replace(temp_name, relative.name, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
                    else:
                        os.link(temp_name, relative.name, src_dir_fd=parent_fd, dst_dir_fd=parent_fd, follow_symlinks=False)
                    os.fsync(parent_fd)
                    try:
                        verified = self._written_file_matches(parent_fd, relative.name, data, written_info)
                    except OSError:
                        verified = False
                finally:
                    try:
                        os.unlink(temp_name, dir_fd=parent_fd)
                    except FileNotFoundError:
                        pass
            finally:
                os.close(parent_fd)
        except OSError as exc:
            raise self._file_error(exc) from None
        result = {"ok": verified, "path": relative.as_posix(), "bytes": len(data), "overwrite": overwrite,
                  "verification": {"status": "verified" if verified else "failed", "method": "file_readback", "scope": "files"}}
        if not verified:
            result["error"] = {"code": "verification_failed", "message": "File was written, but destination readback could not confirm the requested content. Inspect the destination before retrying."}
        return result

    @staticmethod
    def _kill_group(process):
        # Keep this bounded even if a child ignores SIGTERM. Killing the group also
        # handles children that retain a pipe after their immediate parent exits.
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            process.wait(timeout=0.15)
        except subprocess.TimeoutExpired:
            pass
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait(timeout=2)

    def shell_run(self, args):
        argv, command = args.get("argv"), args.get("command")
        if argv is not None and command is not None:
            raise ToolError("invalid_arguments", "Provide argv or command, not both", not_executed=True)
        if argv is not None:
            if not isinstance(argv, list) or not argv or any(not isinstance(item, str) or "\x00" in item for item in argv) or not argv[0]:
                raise ToolError("invalid_arguments", "argv must be a nonempty array of strings without NUL", not_executed=True)
            invocation = argv
        elif isinstance(command, str) and command.strip() and "\x00" not in command:
            invocation = ["/bin/bash", "--noprofile", "--norc", "-c", command]
        else:
            raise ToolError("invalid_arguments", "Provide argv or a nonempty command", not_executed=True)
        cwd, relative = self._path(args.get("cwd", "."))
        timeout = _integer(args.get("timeout", self.default_timeout), "timeout", 1, 300)
        env = {key: os.environ[key] for key in _ENV_ALLOWLIST if key in os.environ}
        env.setdefault("PATH", os.defpath)
        started = time.monotonic()
        try:
            with self._lock:
                if self._closed:
                    raise ToolError("closed", "Local tools are closed", not_executed=True)
                process = subprocess.Popen(invocation, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                                           stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                           shell=False, start_new_session=True, close_fds=True)
                self._processes.add(process)
        except OSError as exc:
            if exc.errno == errno.ENOENT and executable_missing(invocation[0], cwd, env):
                details = {"stage": "process_start", "errno": exc.errno, "executable": invocation[0]}
                target = simple_read_target(args, self.workspace)
                if target is not None:
                    details["equivalent_read_target"] = target
                raise ToolError("command_not_found", "Executable was not found; no process was started. Choose an installed equivalent and preserve the original task and target.",
                                not_executed=True, details=details) from None
            raise ToolError("command_start_failed", f"Command could not start (errno={exc.errno}); check the executable and cwd before choosing a corrected action",
                            not_executed=True, details={"stage": "process_start", "errno": exc.errno}) from None
        output = {"stdout": _Output(self.max_output_chars), "stderr": _Output(self.max_output_chars)}
        selector = selectors.DefaultSelector()
        timed_out = False
        try:
            for name in output:
                stream = getattr(process, name)
                os.set_blocking(stream.fileno(), False)
                selector.register(stream, selectors.EVENT_READ, name)
            while selector.get_map() or process.poll() is None:
                remaining = timeout - (time.monotonic() - started)
                if remaining <= 0:
                    timed_out = True
                    self._kill_group(process)
                    break
                for key, _ in selector.select(min(remaining, 0.1)):
                    try:
                        data = os.read(key.fileobj.fileno(), 65536)
                    except BlockingIOError:
                        continue
                    if data:
                        output[key.data].add(data)
                    else:
                        selector.unregister(key.fileobj)
                        output[key.data].add(b"", final=True)
            process.wait(timeout=2)
        except BaseException:
            self._kill_group(process)
            raise
        finally:
            # Stop surviving children even if the command itself returned normally.
            self._kill_group(process)
            selector.close()
            process.stdout.close()
            process.stderr.close()
            with self._lock:
                self._processes.discard(process)
        succeeded = not timed_out and process.returncode == 0
        result = {"ok": succeeded, "cwd": relative.as_posix(), "returncode": process.returncode, "timed_out": timed_out,
                "duration_ms": round((time.monotonic() - started) * 1000),
                "stdout": output["stdout"].text, "stderr": output["stderr"].text,
                "stdout_bytes": output["stdout"].bytes, "stderr_bytes": output["stderr"].bytes,
                "stdout_truncated": output["stdout"].truncated, "stderr_truncated": output["stderr"].truncated,
                "verification": {"status": "verified" if succeeded else "failed", "method": "process_exit", "scope": "shell"}}
        if timed_out:
            result["error"] = {"code": "command_timeout", "message": "Command timed out; inspect its output and state before retrying."}
        elif not succeeded:
            result["error"] = {"code": "command_failed", "message": f"Command exited with status {process.returncode}."}
        return result

    def close(self):
        with self._lock:
            if self._closed:
                return
            self._closed = True
            processes = list(self._processes)
            os.close(self._root_fd)
        for process in processes:
            self._kill_group(process)
