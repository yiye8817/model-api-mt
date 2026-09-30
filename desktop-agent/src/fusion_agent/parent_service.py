"""Start the sibling Electron application only for its configured local endpoint.

Only GET probes are retried. A healthy API is not sufficient: webpage jobs need
the authenticated Electron bridge. The normal launcher retains its sandbox and
dependency checks; this module never installs packages or kills any process.
"""

from contextlib import contextmanager
import errno
import fcntl
import json
import math
import os
from pathlib import Path
import socket
import stat
import subprocess
import time
from urllib import error, parse, request

from .client import _base_url, _NoRedirect
from .config import ROOT, api_key
from .rendering import safe_terminal_text


class ParentServiceError(ValueError):
    def __init__(self, code, message, *, details=None):
        super().__init__(message)
        self.code = code
        self.details = details or {}


def _target(settings):
    normalized = _base_url(settings.base_url, settings.allow_remote_http)
    parts = parse.urlsplit(normalized)
    try:
        parent_port = int(os.environ.get("FUSION_PORT", "8765"))
    except ValueError:
        raise ParentServiceError("invalid_parent_port", "FUSION_PORT 必须是 1024..65535 的整数。") from None
    if not 1024 <= parent_port <= 65535:
        raise ParentServiceError("invalid_parent_port", "FUSION_PORT 必须是 1024..65535 的整数。")
    managed = (parts.scheme == "http" and parts.hostname in ("localhost", "127.0.0.1")
               and (parts.port or 80) == parent_port and parts.path.rstrip("/") == "/v1")
    return {"managed": managed, "base_url": normalized, "port": parent_port,
            "origin": f"http://127.0.0.1:{parent_port}"}


def _json_get(url, *, token=None, timeout=2):
    headers = {"Accept": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    # Loopback must not go through a proxy, nor send credentials to a redirect.
    opener = request.build_opener(request.ProxyHandler({}), _NoRedirect())
    try:
        with opener.open(request.Request(url, headers=headers), timeout=timeout) as response:
            raw = response.read(262145)
            if len(raw) > 262144:
                return {"kind": "invalid_response"}
            try:
                value = json.loads(raw)
            except (ValueError, UnicodeError, RecursionError):
                return {"kind": "invalid_response"}
            return {"kind": "ok", "value": value}
    except error.HTTPError as exc:
        status = exc.code
        exc.close()
        return {"kind": "http_error", "http_status": status}
    except error.URLError as exc:
        reason = exc.reason
        if isinstance(reason, OSError) and reason.errno == errno.ECONNREFUSED:
            return {"kind": "offline"}
        return {"kind": "unreachable"}
    except (OSError, socket.timeout):
        return {"kind": "unreachable"}


def parent_status(settings, *, timeout=2):
    """Read-only status. External/custom endpoints remain the API client's job."""
    target = _target(settings)
    report = {"managed": target["managed"], "base_url": target["base_url"]}
    if not target["managed"]:
        return {**report, "state": "external", "message": "自定义或远端 API，不由 Agent 管理启动。"}
    health = _json_get(target["origin"] + "/health", timeout=timeout)
    if health["kind"] == "offline":
        return {**report, "state": "offline", "message": "父服务尚未监听。"}
    if health["kind"] == "unreachable":
        return {**report, "state": "unreachable", "message": "父服务连接超时或状态未知；请检查端口。"}
    if health["kind"] != "ok" or health.get("value") != {"status": "ok"}:
        return {**report, "state": "unexpected_service", "http_status": health.get("http_status"),
                "message": "端口已响应，但不是预期的父服务健康接口；请检查 base_url 和端口占用。"}
    try:
        credential = api_key(settings)
    except (ValueError, OSError):
        return {**report, "state": "auth_error", "message": "父服务已响应，但找不到有效本地 API 密钥；请检查密钥配置。"}
    status = _json_get(target["origin"] + "/internal/status", token=credential, timeout=timeout)
    if status.get("http_status") in (401, 403):
        return {**report, "state": "auth_error", "http_status": status["http_status"],
                "message": "父服务认证失败；请检查 Agent API 密钥与父应用是否一致。"}
    if status["kind"] in ("offline", "unreachable"):
        return {**report, "state": "unreachable", "message": "父服务健康检查后失去响应；没有重发任务。"}
    value = status.get("value")
    if (status["kind"] != "ok" or not isinstance(value, dict)
            or not isinstance(value.get("bridge_connected"), bool)
            or not isinstance(value.get("providers"), dict)
            or not isinstance(value.get("busy"), bool)):
        return {**report, "state": "unexpected_service", "http_status": status.get("http_status"),
                "message": "端口不是可识别的 MultiLLM Fusion 状态接口；不会启动另一个实例。"}
    recovery = value.get("web_recovery")
    recovery_supported = (value.get("service") == "multillm-fusion"
                          and isinstance(value.get("capabilities"), dict)
                          and type(value["capabilities"].get("web_recovery")) is int
                          and value["capabilities"]["web_recovery"] == 1
                          and isinstance(recovery, dict)
                          and type(recovery.get("max_wait_seconds")) in (int, float)
                          and math.isfinite(recovery["max_wait_seconds"])
                          and 0 < recovery["max_wait_seconds"] <= 7200
                          and type(recovery.get("recovery_timeout_seconds")) in (int, float)
                          and math.isfinite(recovery["recovery_timeout_seconds"])
                          and 0 <= recovery["recovery_timeout_seconds"] <= 600)
    return {**report, "state": "ready" if value["bridge_connected"] else "bridge_wait",
            "message": "父服务及网页桥接已就绪。" if value["bridge_connected"] else "API 已运行，网页桥接尚未连接。",
            "bridge_connected": value["bridge_connected"], "busy": value["busy"],
            "providers": value["providers"], "queue_size": value.get("queue_size", 0),
            "web_recovery_supported": recovery_supported,
            "web_recovery_timeout": math.ceil(recovery["max_wait_seconds"]) if recovery_supported else None,
            "web_progress_supported": (value.get("service") == "multillm-fusion"
                                       and isinstance(value.get("capabilities"), dict)
                                       and type(value["capabilities"].get("web_progress")) is int
                                       and value["capabilities"]["web_progress"] == 1)}


def _project_root():
    return ROOT.parent


def _private_directory(path):
    path = Path(path).expanduser().absolute()
    if any(parent.is_symlink() for parent in (path, *path.parents)):
        raise ParentServiceError("unsafe_parent_log", "父应用日志目录不能经过符号链接。")
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    return path


def _private_open(path, flags):
    fd = os.open(path, flags | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0), 0o600)
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1:
        os.close(fd)
        raise ParentServiceError("unsafe_parent_log", "父应用启动记录必须是当前用户独占的普通文件。")
    os.fchmod(fd, 0o600)
    return fd


@contextmanager
def _startup_lock(path, deadline, progress):
    fd = _private_open(path, os.O_RDWR)
    waiting = False
    try:
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if not waiting:
                    progress("另一个 Agent 正在启动父应用，等待就绪…")
                    waiting = True
                if time.monotonic() >= deadline:
                    raise ParentServiceError("parent_start_timeout", "等待另一个 Agent 启动父应用超时；没有重复启动。")
                time.sleep(min(0.2, max(0, deadline - time.monotonic())))
        yield fd
    finally:
        os.close(fd)


def _process_identity(pid):
    """Linux start ticks prevent treating a recycled PID as our launcher."""
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 1:
        return None
    try:
        value = Path(f"/proc/{pid}/stat").read_text()
        fields = value[value.rfind(")") + 2:].split()
        if fields[0] == "Z":
            return None
        return fields[19]
    except (OSError, IndexError):
        return None


def _read_launch(fd):
    os.lseek(fd, 0, os.SEEK_SET)
    try:
        value = json.loads(os.read(fd, 8193))
    except (ValueError, UnicodeError, RecursionError):
        return None
    if (not isinstance(value, dict) or not isinstance(value.get("pid"), int)
            or isinstance(value["pid"], bool) or value["pid"] <= 1 or "identity" not in value):
        return None
    if value["identity"] is None:
        # Some restricted /proc mounts hide the child. We cannot prove that it
        # exited; retain the launch record rather than silently start twice.
        return {**value, "identity_unavailable": True}
    if not isinstance(value["identity"], str) or _process_identity(value["pid"]) != value["identity"]:
        return None
    return value


def _record_launch(fd, process, log_path):
    value = {"pid": process.pid, "identity": _process_identity(process.pid), "log_path": str(log_path)}
    os.lseek(fd, 0, os.SEEK_SET)
    os.ftruncate(fd, 0)
    os.write(fd, (json.dumps(value) + "\n").encode("utf-8"))
    os.fsync(fd)
    return value


def _launch(project, log_path):
    if not (project / "run.sh").is_file() or not (project / "electron/main.cjs").is_file():
        raise ParentServiceError("parent_project_missing", "找不到父项目 run.sh 和 Electron 入口；请将 desktop-agent 放在父项目内。")
    # Rotate only immediately before starting a new launcher. The running
    # launcher's inherited fd remains attached to this file until it exits;
    # its stream is deliberately not advertised as a bounded rotating log.
    if log_path.exists() or log_path.is_symlink():
        fd = _private_open(log_path, os.O_WRONLY | os.O_APPEND)
        try:
            rotate = os.fstat(fd).st_size >= 5 * 1024 * 1024
        finally:
            os.close(fd)
        if rotate:
            for index in (2, 1):
                older = log_path.with_name(log_path.name + f".{index}")
                if older.exists() or older.is_symlink():
                    checked = _private_open(older, os.O_RDONLY)
                    os.close(checked)
                    older.replace(log_path.with_name(log_path.name + f".{index + 1}"))
            log_path.replace(log_path.with_name(log_path.name + ".1"))
    fd = _private_open(log_path, os.O_WRONLY | os.O_APPEND)
    environment = {**os.environ, "FUSION_LOG_DIR": str(log_path.parent)}
    if environment.get("FUSION_DATA_DIR"):
        data_directory = Path(environment["FUSION_DATA_DIR"]).expanduser()
        environment["FUSION_DATA_DIR"] = str(data_directory if data_directory.is_absolute() else project / data_directory)
    try:
        with os.fdopen(fd, "ab", buffering=0) as output:
            output.write(f"\n--- Agent parent launch {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} ---\n".encode())
            # Invoke the exact sibling launcher. No shell command concatenation,
            # detached stdin, no inherited terminal, and no sandbox downgrade.
            return subprocess.Popen(["bash", str(project / "run.sh"), "--skip-install"],
                                    cwd=project, stdin=subprocess.DEVNULL,
                                    stdout=output, stderr=subprocess.STDOUT,
                                    env=environment,
                                    start_new_session=True, close_fds=True)
    except OSError as exc:
        raise ParentServiceError("parent_spawn_failed", "无法执行父应用启动器，请检查 bash 和父项目权限。",
                                 details={"errno": exc.errno}) from None


def ensure_parent(settings, *, auto_start=True, timeout=90, progress=None, event=None, verbose=False):
    """Ensure a local project's API AND bridge are ready before task submission.

    `progress(message)` emits brief user-facing text; `event(name, fields)` is
    optional file audit. Custom endpoints are never started or modified here.
    """
    if not isinstance(timeout, (int, float)) or isinstance(timeout, bool) or not 0 < timeout <= 300:
        raise ValueError("父应用启动等待时间必须为 0..300 秒。")
    progress_callback = progress or (lambda message: None)
    def inform(message):
        progress_callback(safe_terminal_text(message))
    def emit(name, fields):
        if event:
            event(name, fields)
    deadline = time.monotonic() + timeout
    probe_timeout = lambda: max(0.01, min(2, (deadline - time.monotonic()) / 2))
    report = parent_status(settings, timeout=probe_timeout())
    emit("parent.checked", {"status": report["state"], "payload": report})
    if report["state"] in ("external", "ready"):
        return report
    if report["state"] not in ("offline", "bridge_wait"):
        raise ParentServiceError("parent_" + report["state"], report["message"], details=report)
    if not auto_start:
        raise ParentServiceError("parent_not_ready", report["message"] + " 请启动父项目 ./run.sh --skip-install。", details=report)
    project = _project_root()
    configured_directory = Path(os.environ.get("FUSION_LOG_DIR") or "logs").expanduser()
    directory = _private_directory(configured_directory if configured_directory.is_absolute() else project / configured_directory)
    log_path = directory / "agent-parent-start.log"
    lock_path = directory / f"agent-parent-{_target(settings)['port']}.lock"
    try:
        with _startup_lock(lock_path, deadline, inform) as lock_fd:
            # Re-check under the process-shared lock; another Agent may have
            # finished while we waited, so don't start a duplicate launcher.
            report = parent_status(settings, timeout=probe_timeout())
            if report["state"] == "ready":
                return report
            if report["state"] not in ("offline", "bridge_wait"):
                raise ParentServiceError("parent_" + report["state"], report["message"], details=report)
            existing = _read_launch(lock_fd)
            child = None
            if existing:
                inform("已有父应用启动记录，无法读取进程身份；继续检查 API 和网页桥接，不重复启动…"
                       if existing.get("identity_unavailable") else "父应用启动器仍在运行，继续等待 API 和网页桥接…")
                emit("parent.start_reused", {"status": report["state"], "payload": existing})
            else:
                inform("正在启动父应用并等待网页桥接…" + (f" 启动日志：{log_path}" if verbose else ""))
                child = _launch(project, log_path)
                existing = _record_launch(lock_fd, child, log_path)
                emit("parent.start_requested", {"payload": existing})
            handed_off = False
            while time.monotonic() < deadline:
                report = parent_status(settings, timeout=probe_timeout())
                if report["state"] == "ready":
                    inform("父服务及网页桥接已就绪。")
                    emit("parent.ready", {"status": "ready", "payload": report})
                    return {**report, "started": child is not None, "log_path": str(log_path)}
                if report["state"] in ("unexpected_service", "unreachable") or (
                        report["state"] == "auth_error" and report.get("http_status") in (401, 403)):
                    raise ParentServiceError("parent_" + report["state"], report["message"], details=report)
                returncode = child.poll() if child is not None else None
                if returncode == 0 and report["state"] == "bridge_wait" and not handed_off:
                    # Electron's single-instance guard exits the second
                    # launcher with 0. A manually started first instance may
                    # still be applying provider config. Wait for its bridge.
                    handed_off = True
                    inform("启动器已结束，API 仍在运行；继续等待现有父应用连接网页桥接…")
                    emit("parent.start_handoff", {"returncode": 0, "status": report["state"]})
                # poll() is authoritative for our own child, including systems
                # whose /proc view hides children in another PID namespace.
                alive = (returncode is None if child is not None else
                         existing.get("identity_unavailable") or
                         bool(existing.get("identity")) and _process_identity(existing.get("pid")) == existing["identity"])
                if not handed_off and (returncode is not None or not alive):
                    emit("parent.start_failed", {"returncode": returncode, "payload": {"log_path": str(log_path)}})
                    raise ParentServiceError("parent_start_failed", "父应用启动器已退出；请查看启动日志。缺依赖时先在父项目运行 ./run.sh 安装并启动。",
                                             details={"returncode": returncode, "log_path": str(log_path)})
                time.sleep(min(0.25, max(0, deadline - time.monotonic())))
            emit("parent.start_timeout", {"status": report["state"], "payload": {"log_path": str(log_path)}})
            raise ParentServiceError("parent_start_timeout", "等待父应用及网页桥接超时；没有重复启动，也没有终止现有进程。请检查父窗口和启动日志。",
                                     details={"state": report["state"], "log_path": str(log_path)})
    except ParentServiceError as exc:
        if "log_path" not in exc.details:
            exc.details["log_path"] = str(log_path)
        if str(log_path) not in str(exc):
            exc.args = (str(exc) + f" 启动日志：{safe_terminal_text(log_path)}",)
        raise
    except OSError as exc:
        raise ParentServiceError("parent_start_io", f"无法写入父应用启动记录，请检查目录权限：{safe_terminal_text(directory)}",
                                 details={"errno": exc.errno}) from None
