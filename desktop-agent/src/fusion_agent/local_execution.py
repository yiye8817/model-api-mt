"""Discover local programs and run auditable Python implementations.

Generated Python has the same OS authority as shell.run, NOT a Python sandbox.
Only the registry's shell capability can dispatch it. Missing executables (and
only proven pre-start ENOENT) can trigger an explicitly supplied implementation.
"""
from __future__ import annotations

import ast
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sys
import time
from uuid import uuid4

from .contracts import ToolError, ToolSpec
from .registry import redact_known

_PROGRAMS = ("curl", "wget", "rg", "grep", "find", "cat", "ls", "du", "jq", "tar", "gzip",
             "zip", "unzip", "git", "ffmpeg", "yt-dlp", "node", "python3", "python")
_MODULES = ("requests", "bs4", "lxml", "pandas", "numpy", "playwright", "PIL")
_MAX_CODE = 100000


def inventory(programs=None):
    selected = list(_PROGRAMS) if programs is None else programs
    if (not isinstance(selected, list) or len(selected) > 64
            or any(not isinstance(p, str) or not p or len(p) > 128
                   or any(c in p for c in ('/', '\\', '\x00', '\n', '\r')) for p in selected)):
        raise ToolError("invalid_arguments", "programs must be up to 64 simple executable names", not_executed=True)
    modules = {}
    for name in _MODULES:
        try:
            modules[name] = importlib.util.find_spec(name) is not None
        except (ImportError, ValueError, AttributeError):
            modules[name] = False
    return {"python_executable": sys.executable, "python_version": sys.version.split()[0],
            "python_is_venv": sys.prefix != sys.base_prefix,
            "programs": [{"name": p, "available": bool(path), "path": path}
                         for p in dict.fromkeys(selected) for path in [shutil.which(p)]],
            "python_modules": modules,
            "fallbacks": {"page_read": "web.fetch (resilient Python HTTP reader)",
                          "file_search": "files.search (rg -> grep -> Python)",
                          "missing_command": "local.run with fallback_python",
                          "custom_tool": "python.run with code"},
            "notice": "Discovery only; nothing was executed or installed. Arbitrary Python and CLI require shell authorization; installed does not mean authorized."}


class LocalExecutionTools:
    def __init__(self, local_tools, artifact_dir=None, *, event=None):
        self.local = local_tools
        self.artifact_dir = Path(artifact_dir or local_tools.runtime_dir / "python-tools").absolute()
        self.event = event or (lambda *_: None)
        self.secrets = ()
        self.retain_content = True
        self.enabled = True

    def specs(self):
        common = {
            "cwd": {"type": "string", "description": "Working directory follows configured file scope; relative to workspace, absolute and ~ supported in host mode (NOT an OS sandbox)."},
            "timeout": {"type": "integer", "minimum": 1, "maximum": 300},
            "purpose": {"type": "string", "minLength": 1, "maxLength": 2000,
                        "description": "How this implementation serves the original user task; not authorization."},
        }
        code = {"type": "string", "minLength": 1, "maxLength": _MAX_CODE,
                "description": "Complete Python source. Standard library preferred; no automatic pip installation. sys.argv[1] is a JSON input-file path; read it and print results. Process exit alone does NOT prove task completion."}
        def spec(name, description, properties, required, capability, mutating, handler):
            return ToolSpec(name, description, {"type": "object", "properties": properties,
                            "required": required, "additionalProperties": False}, capability, mutating, handler)
        return [
            spec("environment.tools", "Inspect PATH programs and the current Agent Python modules without executing them.",
                 {"programs": {"type": "array", "items": {"type": "string", "minLength": 1, "maxLength": 128}, "maxItems": 64}},
                 [], "skills", False, lambda a: inventory(a.get("programs"))),
            spec("local.run", "Prefer an actual local executable. Only if it is proven missing BEFORE any execution, run supplied fallback_python using the current Agent interpreter. Never fall back after nonzero exit, permission denial, timeout, missing script/input or uncertain outcome. Shell capability required; NOT an OS sandbox.",
                 {**common, "argv": {"type": "array", "items": {"type": "string"}, "minItems": 1},
                  "fallback_python": code, "input": {"type": "object"}},
                 ["argv", "purpose"], "shell", True, self.local_run),
            spec("python.run", "Implement a missing task-specific tool in Python, save source/input/manifest, and execute it with the current Agent interpreter. Use real tools first. Requires explicit shell authorization and task scope, NOT a sandbox. Verify actual output separately; do not bypass denied capabilities.",
                 {**common, "code": code, "input": {"type": "object"}},
                 ["code", "purpose"], "shell", True, self.python_run),
        ]

    def local_run(self, args):
        started = time.monotonic()
        try:
            result = self.local.shell_run({key: args[key] for key in ("argv", "cwd", "timeout") if key in args})
        except ToolError as exc:
            if exc.code != "command_not_found" or not exc.not_executed:
                raise
            details = exc.details if isinstance(exc.details, dict) else {}
            if not args.get("fallback_python") or not self.enabled:
                # No generated code is fabricated from an executable name.
                raise
            self.event("tool.local_missing", {"tool": "local.run", "method": "python_fallback",
                "payload": {"executable": details.get("executable"), "executed": False}})
            remaining = args.get("timeout", self.local.default_timeout) - (time.monotonic() - started)
            if remaining < 1:
                raise ToolError("command_timeout", "No time remains for a not-started fallback", not_executed=True)
            result = self._python({**args, "code": args["fallback_python"], "timeout": max(1, int(remaining))},
                                  reason="missing_executable", original=args["argv"])
            result["attempts"] = [{"backend": "local", "status": "not_started", "reason": "command_not_found"},
                                  {"backend": "python", "status": "completed" if not result.get("timed_out") else "timeout"}]
            return result
        result["backend"] = "local"
        result["fallback_used"] = False
        self.event("tool.local_selected", {"tool": "local.run", "method": "installed_executable"})
        return result

    def python_run(self, args):
        return self._python(args, reason="task_specific_python")

    @staticmethod
    def _write(path, content):
        data = content.encode("utf-8")
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "wb") as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        return hashlib.sha256(data).hexdigest()

    def _python(self, args, *, reason, original=None):
        if not self.enabled:
            raise ToolError("python_execution_disabled", "Generated Python execution is disabled in configuration", not_executed=True)
        code = args.get("code")
        if not isinstance(code, str) or not code.strip() or len(code) > _MAX_CODE or '\x00' in code:
            raise ToolError("invalid_arguments", "code must be complete Python source within 100000 characters", not_executed=True)
        # Compile without executing. This is syntax checking, NEVER a sandbox.
        try:
            ast.parse(code, filename="tool.py")
            compile(code, "tool.py", "exec")
        except (SyntaxError, ValueError, RecursionError) as exc:
            raise ToolError("python_syntax_error", "Generated tool has invalid Python syntax; nothing ran",
                not_executed=True, details={"line": getattr(exc, "lineno", None),
                                          "column": getattr(exc, "offset", None)}) from None
        value = args.get("input", {})
        if not isinstance(value, dict):
            raise ToolError("invalid_arguments", "input must be a JSON object", not_executed=True)
        try:
            encoded = json.dumps(value, ensure_ascii=False, allow_nan=False)
        except (TypeError, ValueError, RecursionError):
            raise ToolError("invalid_arguments", "input is not serializable JSON", not_executed=True) from None
        if len(encoded.encode("utf-8")) > 100000:
            raise ToolError("invalid_arguments", "input exceeds 100 KB", not_executed=True)
        # Validate cwd before writing the runnable source or launching anything.
        self.local._path(args.get("cwd", "."))
        directory = None
        try:
            if any(p.is_symlink() for p in (self.artifact_dir, *self.artifact_dir.parents)):
                raise OSError("symlink artifact directory")
            self.artifact_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
            directory = self.artifact_dir / uuid4().hex
            directory.mkdir(mode=0o700)
            script = directory / "tool.py"
            data_path = directory / "input.json"
            digest = self._write(script, code)
            input_digest = self._write(data_path, encoded)
            manifest = {"version": 1, "reason": reason, "purpose": args.get("purpose", ""),
                        "sha256": digest, "input_sha256": input_digest,
                        "python_executable": sys.executable, "original_argv": original,
                        "cwd": args.get("cwd", "."), "timeout": args.get("timeout", self.local.default_timeout),
                        "required_capability": "shell", "sandbox": False,
                        "source_retained": self.retain_content}
            if not self.retain_content:
                # argv/purpose can contain credentials or full user content.
                manifest.pop("purpose", None)
                manifest.pop("original_argv", None)
            self._write(directory / "manifest.json", json.dumps(redact_known(manifest, self.secrets), ensure_ascii=False, indent=2))
        except OSError:
            if directory is not None and not self.retain_content:
                for path in (directory / "tool.py", directory / "input.json"):
                    path.unlink(missing_ok=True)
            raise ToolError("python_artifact_write_failed", "Cannot save generated source/input; nothing was executed", not_executed=True) from None
        self.event("tool.python_prepared", {"tool": "python.run", "path": str(script), "sha256": digest,
                   "method": reason, "payload": {"manifest": manifest, "executed": False}})
        try:
            # Isolated interpreter startup ignores PYTHONPATH/user-site injection;
            # installed packages in the current environment remain available.
            result = self.local.shell_run({"argv": [sys.executable, "-I", "-u", str(script), str(data_path)],
                                          "cwd": args.get("cwd", "."),
                                          "timeout": args.get("timeout", self.local.default_timeout)})
            result.update(backend="python", fallback_used=reason == "missing_executable",
                          script=str(script), manifest=str(directory / "manifest.json"), sha256=digest,
                          python_executable=sys.executable)
            if not result.get("ok"):
                # A failed script may have already written files, unlike ENOENT.
                result.update(outcome_unknown=True, execution={"status": "unknown"})
            if "ModuleNotFoundError:" in result.get("stderr", ""):
                result["dependency_hint"] = ("The generated tool is missing a Python module. Prefer a standard-library implementation; "
                    "do not auto-install or replay side effects. Check actual state before a corrected run.")
            retained = redact_known(result, self.secrets) if self.retain_content else {
                key: result.get(key) for key in ("ok", "returncode", "timed_out", "duration_ms", "backend", "sha256")}
            try:
                self._write(directory / "result.json", json.dumps(retained, ensure_ascii=False, indent=2))
            except OSError:
                # Execution already happened. Never label it not_started or retry.
                result["artifact_warning"] = "Execution finished but result.json could not be saved. Do not replay."
                self.event("tool.python_artifact_failed", {"tool": "python.run", "path": str(directory)})
            return result
        finally:
            if not self.retain_content:
                for path in (script, data_path):
                    try:
                        path.unlink(missing_ok=True)
                    except OSError:
                        self.event("tool.python_artifact_cleanup_failed", {"tool": "python.run", "path": str(path)})

    def close(self):
        # LocalTools owns all child processes and is closed by the CLI.
        pass
