"""Explicit, local, site-scoped import of the current user's browser cookies.

The CLI is private to Electron's main process; it must never be an HTTP endpoint.
Discovery reads directory/profile metadata only. Extraction opens a read-only
SQLite transaction (including committed WAL changes), selects scoped rows, and
closes the source before optional keyring access. No passwords or history read.
"""
from __future__ import annotations

import configparser
import contextlib
import hashlib
import importlib
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import signal
import sqlite3
import sys
import tempfile
import time
from typing import Any


SITES_FILE = Path(__file__).resolve().parents[1] / "browser-login-sites.json"
MAX_ROWS = 5000
MAX_BYTES = 8 * 1024 * 1024
MAX_METADATA = 1024 * 1024
CHROMIUM_EPOCH = 11644473600
ERRORS = {
    "INVALID_REQUEST": "登录导入请求格式无效。",
    "INVALID_PROVIDER": "请选择支持的模型网站。",
    "PROFILE_NOT_FOUND": "浏览器配置已移动或不存在，请重新检测。",
    "SOURCE_UNAVAILABLE": "无法读取所选浏览器配置，请检查当前用户的文件权限。",
    "DATABASE_BUSY": "浏览器数据库繁忙或读取超时，请正常退出来源浏览器后重试，或使用扩展导出。",
    "DATABASE_FORMAT": "浏览器 Cookie 数据库格式暂不支持，请使用扩展导出。",
    "SOURCE_TOO_LARGE": "所选网站的数据超出导入限制，请使用扩展导出。",
    "DEPENDENCY_MISSING": "缺少 Chromium 解密依赖；请运行 ./run.sh 安装 requirements-browser.txt，或使用扩展导出。",
    "DECRYPTION_FAILED": "无法解密所选网站的 Cookie；请在同一 Linux 桌面用户下解锁系统密钥环并重试，或使用扩展导出。",
    "UNSUPPORTED_PLATFORM": "此浏览器配置导入功能目前支持 Linux。",
    "INTERNAL_ERROR": "登录信息读取失败，请使用扩展导出或在应用内手动登录。",
}
WARNINGS = {
    "PERSISTED_STATE_ONLY": "数据库导入只包含已落盘的 Cookie；浏览器内存会话和 localStorage 请使用扩展导出。导入后仍需在网页确认登录。",
    "ISOLATED_COOKIES_SKIPPED": "已跳过 Firefox 容器、隐私或分区上下文中的 Cookie，避免混用隔离会话。",
    "PARTITIONED_COOKIES_SKIPPED": "已跳过分区 Cookie，当前导入不会将其转换为普通 Cookie。",
    "EXPIRED_COOKIES_SKIPPED": "已跳过过期 Cookie。",
    "INVALID_COOKIES_SKIPPED": "已跳过字段或安全属性无效的 Cookie。",
    "UNSUPPORTED_ENCRYPTION": "部分 Cookie 使用当前解密器不支持的格式，请使用浏览器扩展导出。",
    "PROFILE_DISCOVERY_PARTIAL": "部分浏览器配置元数据无法读取，列表可能不完整。",
    **{key: ERRORS[key] for key in ("DEPENDENCY_MISSING", "DECRYPTION_FAILED")},
}


class LoginError(Exception):
    def __init__(self, code: str):
        self.code = code
        super().__init__(ERRORS[code])


def warning(code: str) -> dict[str, str]:
    return {"code": code, "message": WARNINGS[code]}


def domain_in_scope(domain: Any, roots: list[str]) -> bool:
    if not isinstance(domain, str):
        return False
    host = domain.lower().removeprefix(".")
    if len(host) > 253 or not re.fullmatch(r"[a-z0-9]+(?:[a-z0-9.-]*[a-z0-9])?", host):
        return False
    if ".." in host:
        return False
    return any(host == root or host.endswith("." + root) for root in roots)


def _children(path: Path) -> list[Path]:
    try:
        # Bounded metadata discovery. Cookies themselves are never opened here.
        children = []
        with os.scandir(path) as entries:
            for entry in entries:
                if len(children) >= 512:
                    break
                if entry.is_dir():
                    children.append(Path(entry.path))
        return sorted(children)
    except OSError:
        return []


def _cookie_path(profile: dict) -> Path:
    path = Path(profile["path"])
    if profile["family"] == "firefox":
        return path / "cookies.sqlite"
    network = path / "Network" / "Cookies"
    return network if network.is_file() else path / "Cookies"


def discover_profiles(home: Path | None = None, config_home: Path | None = None) -> tuple[list[dict], list[dict]]:
    """Return metadata only, including profiles with no cookies yet."""
    home = Path(home) if home is not None else Path.home()
    config = Path(config_home) if config_home is not None else (
        Path(os.environ.get("XDG_CONFIG_HOME", str(home / ".config")))
        if home == Path.home() else home / ".config"
    )
    found: dict[str, dict] = {}
    warnings = []

    def add(path: Path, browser: str, family: str, name: str):
        try:
            path = path.resolve(strict=True)
            if not path.is_dir() or path.stat().st_uid != os.getuid():
                return
        except OSError:
            return
        canonical = str(path)
        if canonical in found:
            return
        found[canonical] = {
            "id": hashlib.sha256((family + "\0" + canonical).encode()).hexdigest()[:24],
            "browser": browser, "family": family, "name": name[:200], "path": canonical,
        }

    firefox_roots = [
        home / ".mozilla/firefox", config / "mozilla/firefox",
        home / "snap/firefox/common/.mozilla/firefox",
        home / "snap/firefox/current/.mozilla/firefox",
        home / ".var/app/org.mozilla.firefox/.mozilla/firefox",
        home / ".var/app/org.mozilla.firefox/config/mozilla/firefox",
    ]
    for root in firefox_roots:
        ini = root / "profiles.ini"
        if ini.is_file():
            try:
                if ini.stat().st_size > MAX_METADATA:
                    raise ValueError()
                parser = configparser.ConfigParser(interpolation=None)
                with ini.open(encoding="utf-8-sig") as stream:
                    parser.read_file(stream)
                for section in parser.sections()[:512]:
                    if not section.startswith("Profile") or not parser.has_option(section, "Path"):
                        continue
                    item = parser[section]
                    path = Path(item["Path"])
                    if item.get("IsRelative", "1") == "1":
                        path = root / path
                    add(path, "Firefox", "firefox", item.get("Name", path.name))
            except (OSError, ValueError, configparser.Error):
                if not warnings:
                    warnings.append(warning("PROFILE_DISCOVERY_PARTIAL"))
        for path in _children(root):
            if (path / "cookies.sqlite").is_file():
                add(path, "Firefox", "firefox", path.name)

    variants = [
        ("Chrome", "com.google.Chrome", "google-chrome", ("", "-beta", "-unstable")),
        ("Chromium", "org.chromium.Chromium", "chromium", ("",)),
        ("Brave", "com.brave.Browser", "BraveSoftware/Brave-Browser", ("", "-Beta", "-Dev", "-Nightly")),
        ("Edge", "com.microsoft.Edge", "microsoft-edge", ("", "-beta", "-dev")),
        ("Vivaldi", "com.vivaldi.Vivaldi", "vivaldi", ("", "-snapshot")),
        ("Opera", "com.opera.Opera", "opera", ("", "-beta", "-developer")),
    ]
    snap_names = {"Chrome": "google-chrome", "Chromium": "chromium", "Brave": "brave",
                  "Edge": "microsoft-edge", "Vivaldi": "vivaldi", "Opera": "opera"}
    for browser, app_id, relative, channels in variants:
        for channel in channels:
            dirname = relative + channel
            snap = home / "snap" / snap_names[browser]
            roots = [config / dirname, home / ".var/app" / app_id / "config" / dirname,
                     snap / "common/.config" / dirname, snap / "current/.config" / dirname]
            if browser == "Chromium":
                roots.extend([snap / "common/chromium", snap / "current/chromium"])
            for root in roots:
                if (root / "Cookies").is_file() or (root / "Network/Cookies").is_file():
                    add(root, browser, "chromium", root.name)
                for path in _children(root):
                    if path.name in {"Guest Profile", "System Profile"}:
                        continue
                    if ((path / "Cookies").is_file() or (path / "Network/Cookies").is_file()
                            or (path.name == "Default" or re.fullmatch(r"Profile \d+", path.name))):
                        add(path, browser, "chromium", path.name + (" (" + channel[1:] + ")" if channel else ""))
    profiles = sorted(found.values(), key=lambda p: (p["browser"], p["name"], p["path"]))
    return profiles, warnings


@contextlib.contextmanager
def _readonly_snapshot(path: Path, deadline: float):
    connection = None
    try:
        if not path.is_file() or path.stat().st_uid != os.getuid():
            raise LoginError("SOURCE_UNAVAILABLE")
        # mode=ro honors WAL. immutable=1 and raw file-copy fallbacks are unsafe
        # here: both can silently lose the most recent login writes.
        connection = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True, timeout=1.0)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA query_only=ON")
        connection.execute("PRAGMA trusted_schema=OFF")
        connection.set_progress_handler(lambda: int(time.monotonic() >= deadline), 1000)
        connection.execute("BEGIN")
        yield connection
    except sqlite3.Error as exc:
        code = getattr(exc, "sqlite_errorcode", None)
        code = (code & 0xFF) if isinstance(code, int) else code
        if code in (sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED, sqlite3.SQLITE_INTERRUPT):
            raise LoginError("DATABASE_BUSY") from None
        if code in (sqlite3.SQLITE_CANTOPEN, sqlite3.SQLITE_PERM, sqlite3.SQLITE_AUTH):
            raise LoginError("SOURCE_UNAVAILABLE") from None
        raise LoginError("DATABASE_FORMAT") from None
    except OSError:
        raise LoginError("SOURCE_UNAVAILABLE") from None
    finally:
        if connection is not None:
            connection.close()


def _scoped_rows(profile: dict, roots: list[str], deadline: float) -> tuple[list[dict], int]:
    firefox = profile["family"] == "firefox"
    table, host = ("moz_cookies", "host") if firefox else ("cookies", "host_key")
    wanted = (["host", "name", "value", "path", "expiry", "isSecure", "isHttpOnly", "sameSite", "isSession",
               "originAttributes", "isPartitioned", "partitionKey"] if firefox else
              ["host_key", "name", "value", "encrypted_value", "path", "expires_utc", "is_secure", "secure",
               "is_httponly", "samesite", "has_expires", "is_persistent", "top_frame_site_key",
               "is_partitioned", "partition_key", "has_cross_site_ancestor"])
    with _readonly_snapshot(_cookie_path(profile), deadline) as connection:
        columns = {row[1] for row in connection.execute(f'PRAGMA table_info("{table}")')}
        required = {host, "name", "value", "path"}
        required |= {"expiry", "isSecure", "isHttpOnly"} if firefox else {"expires_utc", "is_httponly"}
        if not required <= columns or (not firefox and not {"is_secure", "secure"} & columns):
            raise LoginError("DATABASE_FORMAT")
        selection = []
        for column in wanted:
            if column not in columns:
                continue
            # Oversized corrupt fields become NULL and are subsequently skipped.
            selection.append(f'CASE WHEN length("{column}") <= 65536 THEN "{column}" ELSE NULL END AS "{column}"')
        conditions, arguments = [], []
        for root in roots:
            conditions.append(f'(lower(ltrim("{host}", \'.\')) = ? OR lower("{host}") LIKE ?)')
            arguments.extend([root, "%." + root])
        cursor = connection.execute(
            f'SELECT {", ".join(selection)} FROM "{table}" WHERE {" OR ".join(conditions)} LIMIT ?',
            (*arguments, MAX_ROWS + 1))
        rows, total = [], 0
        for row in cursor:
            if time.monotonic() >= deadline:
                raise LoginError("DATABASE_BUSY")
            item = dict(row)
            total += sum(len(v.encode("utf-8")) if isinstance(v, str) else len(v) if isinstance(v, bytes) else 8
                         for v in item.values())
            if total > MAX_BYTES or len(rows) >= MAX_ROWS:
                raise LoginError("SOURCE_TOO_LARGE")
            rows.append(item)
        version = 0
        if not firefox:
            # Only the schema version is copied, never Local State or encryption keys.
            try:
                version_row = connection.execute("SELECT value FROM meta WHERE key = 'version'").fetchone()
                version = int(version_row[0]) if version_row else 0
            except (sqlite3.OperationalError, ValueError, TypeError):
                version = 0
        return rows, version


def _normalize(row: dict, family: str, roots: list[str], now: float) -> tuple[dict | None, str | None]:
    firefox = family == "firefox"
    isolated = row.get("originAttributes") if firefox else None
    if isolated or (firefox and "originAttributes" in row and isolated is None):
        return None, "ISOLATED_COOKIES_SKIPPED"
    partition_fields = ("isPartitioned", "partitionKey") if firefox else ("top_frame_site_key", "is_partitioned", "partition_key")
    if any(row.get(key) or (key in row and row[key] is None) for key in partition_fields):
        return None, "PARTITIONED_COOKIES_SKIPPED"
    domain = row.get("host" if firefox else "host_key")
    name, value, path = row.get("name"), row.get("value"), row.get("path")
    if (not domain_in_scope(domain, roots) or not isinstance(name, str) or not name or len(name) > 1024
            or not isinstance(value, str) or not isinstance(path, str) or not path.startswith("/")
            or any(c in name for c in "\r\n\0;=") or any(c in value + path for c in "\r\n\0")):
        return None, "INVALID_COOKIES_SKIPPED"
    try:
        expiration = float(row["expiry"] if firefox else row["expires_utc"])
        if not math.isfinite(expiration):
            raise ValueError()
        if firefox:
            session = bool(row.get("isSession", expiration <= 0))
        else:
            session = expiration == 0 or row.get("has_expires") == 0 or row.get("is_persistent") == 0
            expiration = expiration / 1_000_000 - CHROMIUM_EPOCH
        if not session and expiration <= now:
            return None, "EXPIRED_COOKIES_SKIPPED"
        same_site_value = row.get("sameSite" if firefox else "samesite", -1)
        same_site = {-1: "unspecified", 0: "no_restriction", 1: "lax", 2: "strict"}.get(same_site_value)
        if same_site is None:
            return None, "INVALID_COOKIES_SKIPPED"
        secure_value = row.get("isSecure") if firefox else row.get("is_secure", row.get("secure"))
        http_only_value = row.get("isHttpOnly") if firefox else row.get("is_httponly")
        if secure_value not in (0, 1) or http_only_value not in (0, 1):
            return None, "INVALID_COOKIES_SKIPPED"
        secure, http_only = bool(secure_value), bool(http_only_value)
        if same_site == "no_restriction" and not secure:
            # Chromium refuses insecure SameSite=None. Never weaken to unspecified.
            return None, "INVALID_COOKIES_SKIPPED"
        cookie = {"name": name, "value": value, "domain": domain.lower(), "path": path,
                  "secure": secure, "httpOnly": http_only, "hostOnly": not domain.startswith("."),
                  "session": session, "sameSite": same_site}
        if not session:
            cookie["expirationDate"] = expiration
        return cookie, None
    except (TypeError, ValueError, OverflowError):
        return None, "INVALID_COOKIES_SKIPPED"


def _chromium_values(browser: str, rows: list[dict], version: int) -> dict[tuple[str, str, str], str]:
    """Use public upstream loaders on a private, strictly scoped encrypted DB.

    Public loader is intentionally preferred to calling its private _decrypt API.
    Security metadata remains ours: CookieJar discards SameSite and session flags.
    Source: https://github.com/borisbabic/browser_cookie3/blob/master/browser_cookie3/__init__.py
    """
    try:
        # The optional library or DBus can print diagnostics; discard those rather
        # than risk cookie contents in Electron's logs or the JSON transport.
        with open(os.devnull, "w") as sink, contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
            try:
                library = importlib.import_module("browser_cookie3")
            except ImportError:
                raise LoginError("DEPENDENCY_MISSING") from None
            loader_type = getattr(library, browser, None)
            if loader_type is None:
                raise LoginError("DECRYPTION_FAILED")
            with tempfile.TemporaryDirectory(prefix="multillm-login-") as directory:
                target = Path(directory) / "selected-cookies.sqlite"
                fd = os.open(target, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
                os.close(fd)
                with contextlib.closing(sqlite3.connect(target)) as db, db:
                    db.execute("CREATE TABLE cookies (host_key TEXT, path TEXT, is_secure INTEGER, expires_utc INTEGER, name TEXT, value TEXT, encrypted_value BLOB, is_httponly INTEGER)")
                    db.execute("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)")
                    db.execute("INSERT INTO meta VALUES ('version', ?)", (str(version),))
                    db.executemany("INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [
                        (row["host_key"], row["path"], row.get("is_secure", row.get("secure", 0)),
                         row["expires_utc"], row["name"], "", row["encrypted_value"], row["is_httponly"])
                        for row in rows])
                # No source file path or Local State is supplied to the decoder.
                jar = loader_type(cookie_file=str(target), domain_name="").load()
                allowed = {(row["host_key"], row["path"], row["name"]) for row in rows}
                return {(cookie.domain, cookie.path, cookie.name): cookie.value for cookie in jar
                        if (cookie.domain, cookie.path, cookie.name) in allowed and isinstance(cookie.value, str)}
    except LoginError:
        raise
    except Exception:
        raise LoginError("DECRYPTION_FAILED") from None


def extract(profile: dict, provider_id: str, roots: list[str], *, now: float | None = None) -> dict:
    rows, version = _scoped_rows(profile, roots, time.monotonic() + 8)
    now = time.time() if now is None else now
    cookies, encrypted, warnings, skipped = [], [], [], 0
    codes = set()

    def skip(code: str, count: int = 1):
        nonlocal skipped
        skipped += count
        if code not in codes:
            warnings.append(warning(code))
            codes.add(code)

    for row in rows:
        cookie, reason = _normalize(row, profile["family"], roots, now)
        if reason:
            skip(reason)
            continue
        encrypted_value = row.get("encrypted_value")
        if profile["family"] == "chromium" and not row["value"] and encrypted_value:
            if not isinstance(encrypted_value, bytes) or encrypted_value[:3] not in (b"v10", b"v11"):
                skip("UNSUPPORTED_ENCRYPTION")
            else:
                encrypted.append((row, cookie))
        elif profile["family"] == "chromium" and encrypted_value is None and "encrypted_value" in row:
            skip("INVALID_COOKIES_SKIPPED")
        else:
            cookies.append(cookie)
    if encrypted:
        try:
            values = _chromium_values(profile["browser"], [row for row, _ in encrypted], version)
            for row, cookie in encrypted:
                key = (row["host_key"], row["path"], row["name"])
                if key not in values or any(c in values[key] for c in "\r\n\0") or len(values[key]) > 65536:
                    skip("DECRYPTION_FAILED")
                    continue
                cookie["value"] = values[key]
                cookies.append(cookie)
        except LoginError as exc:
            skip(exc.code, len(encrypted))
            if not cookies:
                # Keep the actionable code while making skipped counts available.
                return {"ok": False, "error": {"code": exc.code, "message": ERRORS[exc.code]},
                        "skipped": skipped, "warnings": warnings}
    warnings.append(warning("PERSISTED_STATE_ONLY"))
    return {"ok": True, "provider_id": provider_id, "cookies": cookies, "warnings": warnings, "skipped": skipped}


def handle_request(request: Any, *, home: Path | None = None, config_home: Path | None = None) -> dict:
    try:
        if not sys.platform.startswith("linux"):
            raise LoginError("UNSUPPORTED_PLATFORM")
        if not isinstance(request, dict) or request.get("action") not in ("list", "extract"):
            raise LoginError("INVALID_REQUEST")
        profiles, warnings = discover_profiles(home, config_home)
        if request["action"] == "list":
            # find_spec does not import browser_cookie3, open a DB, or query a keyring.
            try:
                available = importlib.util.find_spec("browser_cookie3") is not None
            except (ImportError, ValueError):
                available = False
            return {"ok": True, "profiles": profiles, "warnings": warnings,
                    "capabilities": {"chromium_decryption": available}}
        provider_id = request.get("provider_id")
        sites = json.loads(SITES_FILE.read_text(encoding="utf-8"))
        if not isinstance(provider_id, str) or provider_id not in sites:
            raise LoginError("INVALID_PROVIDER")
        profile = next((p for p in profiles if p["id"] == request.get("profile_id")), None)
        if profile is None:
            raise LoginError("PROFILE_NOT_FOUND")
        return extract(profile, provider_id, sites[provider_id]["domains"])
    except LoginError as exc:
        return {"ok": False, "error": {"code": exc.code, "message": ERRORS[exc.code]}}
    except Exception:
        # Never serialize raw SQLite, OS, keyring, or JSON exception details.
        return {"ok": False, "error": {"code": "INTERNAL_ERROR", "message": ERRORS["INTERNAL_ERROR"]}}


def main() -> None:
    def terminate(signum, _frame):
        # Unwind TemporaryDirectory/SQLite contexts when Electron cancels.
        raise SystemExit(128 + signum)

    signal.signal(signal.SIGTERM, terminate)
    try:
        raw = sys.stdin.buffer.read(16385)
        if len(raw) > 16384:
            raise ValueError()
        request = json.loads(raw)
        result = handle_request(request)
    except (ValueError, UnicodeError):
        result = {"ok": False, "error": {"code": "INVALID_REQUEST", "message": ERRORS["INVALID_REQUEST"]}}
    except Exception:
        result = {"ok": False, "error": {"code": "INTERNAL_ERROR", "message": ERRORS["INTERNAL_ERROR"]}}
    sys.stdout.write(json.dumps(result, ensure_ascii=False, separators=(",", ":")) + "\n")


if __name__ == "__main__":
    main()
