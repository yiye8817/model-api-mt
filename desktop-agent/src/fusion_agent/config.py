"""Private local configuration, separate from the parent desktop application's state."""

from dataclasses import dataclass, asdict
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


@dataclass
class Settings:
    base_url: str = "http://127.0.0.1:8765/v1"
    model: str = "chatgpt"
    api_key_env: str = "FUSION_AGENT_API_KEY"
    api_key_file: str = ""
    workspace: str = "workspace"
    runtime_dir: str = ".runtime"
    skills_dir: str = "skills"
    timeout: float = 900
    max_steps: int = 20
    max_context_chars: int = 160000
    allowed_capabilities: tuple = ("files", "skills", "web")
    browser_headless: bool = False
    browser_channel: str | None = None
    browser_sandbox: bool = True
    allow_remote_http: bool = False
    log_content: bool = True
    response_delivery: str = "file"
    save_problem_json: bool = True
    python_tool_fallback: bool = True
    filesystem_scope: str = "host"
    auto_save_config: bool = True
    verbose: bool = False
    non_interactive: bool = False
    auto_start_parent: bool = True
    default_skills: tuple = ()

    def validate(self):
        for key in ("base_url", "model", "api_key_env", "api_key_file", "workspace", "runtime_dir", "skills_dir"):
            if not isinstance(getattr(self, key), str):
                raise ValueError(f"配置 {key} 必须是字符串")
        for key in ("model", "base_url", "workspace", "runtime_dir", "skills_dir"):
            if not getattr(self, key).strip() or "\x00" in getattr(self, key):
                raise ValueError(key + " 不能为空或包含 NUL")
        for key, low, high in (("max_steps", 1, 100), ("max_context_chars", 10000, 40000000)):
            value = getattr(self, key)
            if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
                raise ValueError(f"{key} 范围为 {low}..{high}")
        if isinstance(self.timeout, bool) or not isinstance(self.timeout, (int, float)) or not 15 <= self.timeout <= 1800:
            raise ValueError("timeout 范围为 15..1800 秒")
        if not isinstance(self.browser_headless, bool) or not isinstance(self.allow_remote_http, bool) or not isinstance(self.browser_sandbox, bool):
            raise ValueError("browser_headless/browser_sandbox/allow_remote_http 必须是布尔值")
        if not isinstance(self.log_content, bool) or not isinstance(self.save_problem_json, bool) or not isinstance(self.python_tool_fallback, bool):
            raise ValueError("log_content/save_problem_json/python_tool_fallback 必须是布尔值")
        for key in ("auto_save_config", "verbose", "non_interactive", "auto_start_parent"):
            if not isinstance(getattr(self, key), bool):
                raise ValueError(f"{key} 必须是布尔值")
        if self.filesystem_scope not in ("host", "workspace"):
            raise ValueError("filesystem_scope 只能为 host 或 workspace")
        if (not isinstance(self.default_skills, (list, tuple)) or len(self.default_skills) > 64
                or any(not isinstance(x, str) or not x or len(x) > 128 for x in self.default_skills)):
            raise ValueError("default_skills 必须是最多 64 个技能名的数组")
        if self.response_delivery not in ("file", "inline"):
            raise ValueError("response_delivery 只能为 file 或 inline")
        if self.browser_channel not in (None, "chrome", "msedge", "chromium"):
            raise ValueError("browser_channel 可用 null/chromium/chrome/msedge")
        capabilities = {"files", "skills", "web", "shell", "browser", "desktop"}
        if not isinstance(self.allowed_capabilities, (list, tuple)) or any(item not in capabilities for item in self.allowed_capabilities):
            raise ValueError("allowed_capabilities 只能包含 files/skills/web/shell/browser/desktop")
        return self


def migrate_1174_settings(value):
    """Read both 1.17.4 schemas; conflicting aliases never broaden permissions.

    Loading does not write the file. A later explicit/default config save writes
    the canonical schema under the normal lock and atomic replace.
    """
    if not isinstance(value, dict):
        raise ValueError("Agent 配置必须是对象")
    value = dict(value)
    if "file_access" in value:
        old = value.pop("file_access")
        if not isinstance(old, str) or old not in ("unrestricted", "workspace"):
            raise ValueError("旧 file_access 配置值无效")
        canonical = "host" if old == "unrestricted" else "workspace"
        if "filesystem_scope" in value and value["filesystem_scope"] != canonical:
            raise ValueError("file_access 与 filesystem_scope 冲突；请显式选择文件访问范围")
        value["filesystem_scope"] = canonical
    if "persist_settings" in value:
        old = value.pop("persist_settings")
        if type(old) is not bool:
            raise ValueError("旧 persist_settings 必须是布尔值")
        if "auto_save_config" in value and value["auto_save_config"] != old:
            raise ValueError("persist_settings 与 auto_save_config 冲突")
        value["auto_save_config"] = old
    if "strict_json_protocol" in value:
        if type(value.pop("strict_json_protocol")) is not bool:
            raise ValueError("旧 strict_json_protocol 必须是布尔值")
        # Strict local parsing is always required, never disabled by migration.
    return value


def load_settings(path=None):
    config_path = Path(path).expanduser().absolute() if path else ROOT / "agent.config.json"
    value = {}
    if config_path.exists():
        if config_path.is_symlink() or config_path.stat().st_size > 65536:
            raise ValueError("Agent 配置不能是符号链接或超过 64 KiB")
        value = migrate_1174_settings(json.loads(config_path.read_text(encoding="utf-8")))
        if not isinstance(value, dict) or set(value) - set(Settings.__dataclass_fields__):
            raise ValueError("Agent 配置不是对象或包含未知字段")
    elif path:
        raise ValueError("指定的 Agent 配置文件不存在")
    settings = Settings(**value).validate()
    for key in ("workspace", "runtime_dir", "skills_dir", "api_key_file"):
        raw = getattr(settings, key)
        if raw:
            selected = Path(raw).expanduser()
            setattr(settings, key, str(selected if selected.is_absolute() else config_path.parent / selected))
    # Private metadata is deliberately absent from asdict()/the saved JSON.
    settings._config_path = str(config_path)
    return settings


def api_key(settings):
    value = os.environ.get(settings.api_key_env) if settings.api_key_env else None
    value = value or os.environ.get("FUSION_TOKEN")
    if value:
        return value.strip()
    # The sibling launcher changes cwd to the parent project. Anchor its
    # relative data directory there even when Agent starts from another cwd.
    data_directory = Path(os.environ.get("FUSION_DATA_DIR") or "~/.local/share/multillm-fusion").expanduser()
    if not data_directory.is_absolute():
        data_directory = ROOT.parent / data_directory
    selected = settings.api_key_file or str(data_directory / "api-key.txt")
    path = Path(selected)
    if not path.exists():
        raise ValueError("找不到本地 API 密钥：先启动 MultiLLM Fusion，或设置 FUSION_AGENT_API_KEY / api_key_file")
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 16384:
        raise ValueError("API 密钥文件必须是普通小文件")
    value = path.read_text(encoding="utf-8").strip()
    if not value or "\n" in value or "\r" in value:
        raise ValueError("API 密钥为空或包含换行")
    return value


def initialize(path):
    path = Path(path).expanduser().absolute()
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as output:
        json.dump(asdict(Settings()), output, ensure_ascii=False, indent=2)
        output.write("\n")
    return path


PATH_SETTINGS = frozenset({"workspace", "runtime_dir", "skills_dir", "api_key_file"})


def settings_dict(settings):
    """Only public, validated configuration, never API credential contents."""
    return asdict(settings.validate())


def setting_value(key, text):
    """Parse /config set values using each setting's declared kind."""
    if key not in Settings.__dataclass_fields__:
        raise ValueError("未知配置字段：" + key)
    default = getattr(Settings(), key)
    if isinstance(default, str):
        # Accept either a JSON string or normal shell-quoted CLI text.
        if text.startswith('"'):
            value = json.loads(text)
        else:
            value = text
    elif key == "browser_channel":
        value = None if text.strip() == "null" else text.strip('"')
    else:
        value = json.loads(text)
    if key in PATH_SETTINGS and value:
        value = str(Path(value).expanduser().absolute())
    return value


def save_settings(settings, path=None, *, keys=None):
    """Merge selected fields and atomically save private JSON under an OS lock.

    Concurrent interactive sessions do not clobber unrelated settings. An
    invalid existing file or failed write leaves it unchanged. Permissions are
    0600 and no API key value is ever included (only env/file references).
    """
    import fcntl
    import stat
    import tempfile
    values = settings_dict(settings)
    selected = set(values) if keys is None else set(keys)
    if selected - set(values):
        raise ValueError("不能保存未知配置字段")
    target = Path(path or getattr(settings, "_config_path", ROOT / "agent.config.json")).expanduser().absolute()
    if any(p.is_symlink() for p in (target, *target.parents)):
        raise ValueError("配置文件及其父目录不能为符号链接")
    target.parent.mkdir(parents=True, exist_ok=True)
    lock_path = target.with_name(target.name + ".lock")
    lock = os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    tmp = None
    try:
        if not stat.S_ISREG(os.fstat(lock).st_mode):
            raise ValueError("配置锁必须是普通文件")
        fcntl.flock(lock, fcntl.LOCK_EX)
        current = {}
        if target.exists() or target.is_symlink():
            fd = os.open(target, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            try:
                info = os.fstat(fd)
                if not stat.S_ISREG(info.st_mode) or info.st_size > 65536:
                    raise ValueError("配置必须是最大 64 KiB 的普通文件")
                with os.fdopen(fd, "r", encoding="utf-8", closefd=False) as stream:
                    current = migrate_1174_settings(json.load(stream))
            finally:
                os.close(fd)
            if not isinstance(current, dict) or set(current) - set(values):
                raise ValueError("现有配置包含未知字段，不覆盖")
        # Preserve existing relative-path semantics for unrelated fields.
        merged = {**asdict(Settings()), **current, **{k: values[k] for k in selected}}
        Settings(**merged).validate()
        raw = (json.dumps(merged, ensure_ascii=False, indent=2, allow_nan=False) + "\n").encode("utf-8")
        if len(raw) > 65536:
            raise ValueError("配置超过 64 KiB 限制")
        fd, tmp = tempfile.mkstemp(prefix="." + target.name + ".", suffix=".tmp", dir=target.parent)
        with os.fdopen(fd, "wb") as stream:
            os.fchmod(stream.fileno(), 0o600)
            stream.write(raw); stream.flush(); os.fsync(stream.fileno())
        if target.is_symlink():
            raise ValueError("配置路径已变为符号链接，不覆盖")
        os.replace(tmp, target); tmp = None
        parent_fd = os.open(target.parent, os.O_RDONLY | os.O_DIRECTORY)
        try: os.fsync(parent_fd)
        finally: os.close(parent_fd)
    finally:
        if tmp:
            try: os.unlink(tmp)
            except FileNotFoundError: pass
        os.close(lock)
    settings._config_path = str(target)
    return target


def update_settings(settings, changes, *, persist=None):
    """Validate/save before changing the live settings; failure is transactional.

    Programmatic Settings without a config path remain in memory unless saving
    is explicitly requested. CLI load_settings always attaches its exact path.
    """
    from copy import deepcopy
    if set(changes) - set(Settings.__dataclass_fields__):
        raise ValueError("未知配置字段")
    candidate = deepcopy(settings)
    for key, value in changes.items():
        setattr(candidate, key, value)
    candidate.validate()
    should_save = persist if persist is not None else (
        settings.auto_save_config and hasattr(settings, "_config_path"))
    # Turning autosave on/off is itself persisted when bound to a real config.
    if persist is None and "auto_save_config" in changes and hasattr(settings, "_config_path"):
        should_save = True
    target = save_settings(candidate, keys=changes) if should_save else None
    for key in changes:
        setattr(settings, key, getattr(candidate, key))
    if target:
        settings._config_path = str(target)
    return target
