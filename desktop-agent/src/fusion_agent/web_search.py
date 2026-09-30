"""Bounded public-web search with deterministic fallback and optional parallelism.

Search page contents are untrusted observations.  Every backend must return only
small, URL-validated result records; raw HTML, subprocess stderr and library
exception text never enter the model observation.
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, wait
from dataclasses import dataclass
from html.parser import HTMLParser
import importlib
import json
import os
import re
import selectors
import signal
import shutil
import socket
import subprocess
import time
from typing import Callable, Iterable
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urljoin, urlsplit, urlunsplit, unquote
from urllib.request import Request, urlopen

from .contracts import ToolSpec


_DDG_ENDPOINT = "https://html.duckduckgo.com/html/"
_MAX_RESPONSE_BYTES = 2 * 1024 * 1024
_MAX_BACKEND_OUTPUT = 2 * 1024 * 1024
_BACKEND_ORDER = ("ddgo", "browser_use", "opencli", "playwright")
_BROWSER_USE_RESULT_MARKER = "__FUSION_WEB_SEARCH_RESULT__:"
_PROCESS_ENV_KEYS = {
    "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE",
    "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "XDG_CONFIG_HOME",
    "XDG_DATA_HOME", "XDG_CACHE_HOME", "DBUS_SESSION_BUS_ADDRESS", "XAUTHORITY",
    "TMPDIR", "TEMP", "TMP", "SYSTEMROOT", "COMSPEC", "PATHEXT",
}
_BROWSER_USE_ENV_KEYS = _PROCESS_ENV_KEYS | {
    # Browser Harness connection settings are not credentials.  API/model keys
    # are deliberately excluded because this backend runs no LLM.
    "BU_CDP_URL", "BU_CDP_WS", "BU_NAME", "BH_AGENT_WORKSPACE",
    "BH_REQUIRE_EXISTING_DAEMON", "BH_OPEN_LIVE_URL", "BH_TAB_MARKER", "BH_RECORD",
}
_OPENCLI_ENV_KEYS = _PROCESS_ENV_KEYS | {
    # Preserve local OpenCLI profile/bridge behavior, not arbitrary ambient
    # variables such as Fusion/model tokens or Node code-injection options.
    "OPENCLI_PROFILE", "OPENCLI_WINDOW", "OPENCLI_SITE_SESSION",
    "OPENCLI_BROWSER_CONNECT_TIMEOUT", "OPENCLI_BROWSER_COMMAND_TIMEOUT",
    "OPENCLI_CDP_ENDPOINT", "OPENCLI_CDP_TARGET", "OPENCLI_VERBOSE", "DEBUG_SNAPSHOT",
}
_TRACKING_QUERY_KEYS = {
    "fbclid", "gclid", "mc_cid", "mc_eid", "ref_src", "ref_url",
}
_SENSITIVE_QUERY_KEY = re.compile(
    r"(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|auth|authorization|"
    r"password|passwd|secret|session(?:id)?|cookie|key|signature|sig|credential|"
    r"credentials?|jwt|code|policy|key[_-]?pair[_-]?id|awsaccesskeyid|googleaccessid|"
    r"x[_-]?amz[_-]?[\w-]+|x[_-]?goog[_-]?[\w-]+|"
    r"s[epstvr]|spr|srt)", re.I,
)
_SENSITIVE_QUERY_KEY_PART = re.compile(
    r"(?:^|[^a-z0-9])(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|auth|"
    r"authorization|password|passwd|secret|session(?:id)?|cookie|key|signature|sig|"
    r"credential|credentials?|jwt|code|policy|key[_-]?pair[_-]?id|awsaccesskeyid|"
    r"googleaccessid)(?=$|[^a-z0-9])",
    re.I,
)


# Browser Use CLI 3 executes stdin as Python with these four browser helpers
# pre-imported.  User-controlled query/limit values never enter this source;
# they arrive through the two bounded environment values below.  The JS is
# also constant and only reads the current DDG result DOM.
_BROWSER_USE_TEMPLATE = r'''import json as _json
import os as _os
from urllib.parse import urlencode as _urlencode

_query = _os.environ["FUSION_SEARCH_QUERY"]
_maximum = max(1, min(int(_os.environ["FUSION_SEARCH_MAX_RESULTS"]), 20))
_target = None
try:
    _target = new_tab("https://html.duckduckgo.com/html/?" + _urlencode({"q": _query}))
    wait_for_load()
    _rows = js("""Array.from(document.querySelectorAll('.result')).slice(0, 20).map(row => { const a = row.querySelector('a.result__a'); const s = row.querySelector('.result__snippet'); return a ? {title:(a.textContent||'').trim(),url:a.href,snippet:(s?.textContent||'').trim()} : null; }).filter(Boolean)""")
    if not isinstance(_rows, list):
        _rows = []
    print("__FUSION_WEB_SEARCH_RESULT__:" + _json.dumps({"results": _rows[:_maximum]}, ensure_ascii=False))
finally:
    if _target is not None:
        close_tab(_target)
'''


class BackendFailure(Exception):
    """A backend failure safe to expose as a small structured diagnostic."""

    def __init__(self, code: str, message: str, *, status: str = "failed", retryable: bool = True):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status
        self.retryable = retryable


@dataclass(frozen=True)
class SearchResult:
    title: str
    url: str
    snippet: str
    source: str

    def public(self) -> dict:
        return {"title": self.title, "url": self.url, "snippet": self.snippet,
                "source": self.source}


def _clean_text(value, limit):
    if not isinstance(value, str):
        return ""
    value = re.sub(r"\s+", " ", value).strip()
    return value[:limit]


def _safe_result_url(value):
    """Return a public HTTP(S) URL without credentials, fragments or trackers."""
    if not isinstance(value, str) or not value.strip() or len(value) > 8192:
        return None
    value = value.strip()
    if any(ord(character) < 32 or ord(character) == 127 for character in value):
        return None
    if value.startswith("//"):
        value = "https:" + value
    try:
        parsed = urlsplit(value)
        if parsed.scheme.lower() not in ("http", "https") or not parsed.hostname:
            return None
        if parsed.username is not None or parsed.password is not None:
            return None
        # Never return local or special-use numeric hosts.  ``socket`` accepts
        # legacy integer, octal, hexadecimal and shortened dotted IPv4 forms
        # which ``ipaddress`` deliberately rejects; reject those numeric-looking
        # spellings before a later browser can reinterpret them as loopback.
        hostname = parsed.hostname.lower()
        hostname_without_dot = hostname.rstrip(".")
        if (not hostname_without_dot
                or hostname_without_dot == "localhost"
                or hostname_without_dot.endswith(".localhost")):
            return None
        # Never return local or special-use canonical numeric hosts. Search results are
        # not fetched here, but allowing them into a later model step creates an
        # avoidable SSRF pivot.
        try:
            import ipaddress
            address = ipaddress.ip_address(hostname_without_dot.strip("[]"))
            if not address.is_global:
                return None
            numeric_host = True
        except ValueError:
            if re.fullmatch(
                    r"(?:0x[0-9a-f]+|[0-9]+)(?:\.(?:0x[0-9a-f]+|[0-9]+))*",
                    hostname_without_dot, re.I):
                return None
            numeric_host = False
        host = hostname
        if numeric_host and ":" in host:
            host = f"[{host}]"
        try:
            port = parsed.port
        except ValueError:
            return None
        if port is not None and not ((parsed.scheme.lower() == "http" and port == 80)
                                    or (parsed.scheme.lower() == "https" and port == 443)):
            host = f"{host}:{port}"
        query_parts = []
        for field in parsed.query.split("&") if parsed.query else ():
            key = field.partition("=")[0]
            # Signed download URLs sometimes encode their parameter names more
            # than once.  Decode a bounded number of times so a double-encoded
            # API key or cloud signature cannot bypass log/observation stripping.
            decoding_incomplete = False
            for _ in range(8):
                decoded = unquote(key)
                if decoded == key:
                    break
                key = decoded
            else:
                # Deeply nested percent encoding has no legitimate role in a
                # query-field name here.  Drop it if another decoding pass is
                # still possible instead of allowing an arbitrary-depth bypass.
                decoding_incomplete = unquote(key) != key
            key = key.strip().lower()
            if (decoding_incomplete or key.startswith("utm_") or key in _TRACKING_QUERY_KEYS
                    or _SENSITIVE_QUERY_KEY.fullmatch(key)
                    or _SENSITIVE_QUERY_KEY_PART.search(key)):
                continue
            query_parts.append(field)
        return urlunsplit((parsed.scheme.lower(), host, parsed.path or "/",
                           "&".join(query_parts), ""))
    except (TypeError, ValueError, UnicodeError):
        return None


def _ddg_destination(href):
    """Resolve a DDG redirect without accepting non-HTTP target schemes."""
    if not isinstance(href, str):
        return None
    candidate = urljoin("https://duckduckgo.com/", href)
    try:
        parsed = urlsplit(candidate)
        if parsed.hostname and parsed.hostname.lower() in {
            "duckduckgo.com", "www.duckduckgo.com", "html.duckduckgo.com",
        } and parsed.path.rstrip("/") == "/l":
            target = parse_qs(parsed.query).get("uddg", [None])[0]
            if target:
                candidate = target
    except (TypeError, ValueError):
        return None
    return _safe_result_url(candidate)


class _DDGHTMLParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.results = []
        self._capture = None
        self._depth = 0
        self._pieces = []
        self._href = None

    @staticmethod
    def _classes(attrs):
        return set(dict(attrs).get("class", "").split())

    def handle_starttag(self, tag, attrs):
        if self._capture is not None:
            self._depth += 1
            return
        classes = self._classes(attrs)
        if tag == "a" and "result__a" in classes:
            self._capture, self._depth, self._pieces = "title", 1, []
            self._href = dict(attrs).get("href")
        elif "result__snippet" in classes and self.results:
            self._capture, self._depth, self._pieces = "snippet", 1, []

    def handle_startendtag(self, tag, attrs):
        # Search result titles/snippets are not represented by meaningful
        # self-closing tags.  Preserve spacing if one appears inside capture.
        if self._capture is not None:
            self._pieces.append(" ")

    def handle_endtag(self, tag):
        if self._capture is None:
            return
        self._depth -= 1
        if self._depth:
            return
        text = _clean_text("".join(self._pieces), 2000)
        if self._capture == "title":
            self.results.append({"title": text, "href": self._href, "snippet": ""})
        elif self.results:
            self.results[-1]["snippet"] = text
        self._capture = self._href = None
        self._pieces = []

    def handle_data(self, data):
        if self._capture is not None:
            self._pieces.append(data)


def _normalize_items(items, source, maximum):
    if isinstance(items, dict):
        for key in ("results", "items", "value", "data"):
            if isinstance(items.get(key), list):
                items = items[key]
                break
    if not isinstance(items, list):
        raise BackendFailure("invalid_output", "Search backend returned an unsupported result format.")
    output = []
    for item in items:
        if not isinstance(item, dict):
            continue
        url = item.get("url") or item.get("href") or item.get("link")
        # Each built-in route searches DuckDuckGo, so unwrap its redirect when
        # present; ordinary destination URLs pass through the same safety gate.
        url = _ddg_destination(url)
        title = _clean_text(item.get("title") or item.get("name"), 500)
        snippet = _clean_text(item.get("snippet") or item.get("body") or item.get("description"), 2000)
        if url and title:
            output.append(SearchResult(title=title, url=url, snippet=snippet, source=source))
        if len(output) >= maximum:
            break
    return output


def _default_fetch(url, data, headers, timeout):
    request = Request(url, data=data, headers=headers, method="POST")
    with urlopen(request, timeout=timeout) as response:
        status = getattr(response, "status", 200)
        if not 200 <= status < 300:
            raise BackendFailure("http_error", f"DDG returned HTTP {status}.")
        content_type = (response.headers.get("Content-Type", "") if response.headers else "").lower()
        if content_type and not any(kind in content_type for kind in ("text/html", "application/xhtml")):
            raise BackendFailure("invalid_content_type", "DDG did not return an HTML search page.")
        data = response.read(_MAX_RESPONSE_BYTES + 1)
    if len(data) > _MAX_RESPONSE_BYTES:
        raise BackendFailure("response_too_large", "DDG search response exceeded the safety limit.")
    return data


class DDGBackend:
    """DuckDuckGo HTML POST search (called ``ddgo`` in public diagnostics)."""

    name = "ddgo"

    def __init__(self, fetch: Callable | None = None):
        self.fetch = fetch or _default_fetch

    def search(self, query, maximum, timeout):
        body = urlencode({"q": query, "kl": "wt-wt"}).encode("utf-8")
        headers = {
            "Accept": "text/html,application/xhtml+xml",
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": "MultiLLM-Fusion-Desktop-Agent/1.0 (+public-web-search)",
        }
        try:
            raw = self.fetch(_DDG_ENDPOINT, body, headers, timeout)
            if not isinstance(raw, (bytes, bytearray)):
                raise BackendFailure("invalid_output", "DDG fetcher returned an invalid response.")
            if len(raw) > _MAX_RESPONSE_BYTES:
                raise BackendFailure("response_too_large", "DDG search response exceeded the safety limit.")
            parser = _DDGHTMLParser()
            parser.feed(bytes(raw).decode("utf-8", errors="replace"))
            return _normalize_items(parser.results, self.name, maximum)
        except BackendFailure:
            raise
        except (TimeoutError, socket.timeout):
            raise BackendFailure("timeout", "DDG search timed out.", status="timeout") from None
        except HTTPError as exc:
            raise BackendFailure("http_error", f"DDG returned HTTP {exc.code}.") from None
        except URLError:
            raise BackendFailure("network_error", "DDG search could not connect.") from None
        except (OSError, UnicodeError):
            raise BackendFailure("network_error", "DDG search failed before results were parsed.") from None


def _json_payload(text):
    if not isinstance(text, str) or len(text) > _MAX_BACKEND_OUTPUT:
        raise BackendFailure("invalid_output", "Search backend output was invalid or too large.")
    candidate = text.strip().lstrip("\ufeff")
    fence = re.fullmatch(r"```(?:json)?\s*([\s\S]*?)\s*```", candidate, re.I)
    if fence:
        candidate = fence.group(1).strip()
    try:
        return json.loads(candidate)
    except (json.JSONDecodeError, TypeError):
        # Some CLIs print a bounded informational prefix.  Decode the first
        # complete JSON value without treating the prefix as trusted output.
        decoder = json.JSONDecoder()
        for match in re.finditer(r"[\[{]", candidate[:8192]):
            try:
                value, end = decoder.raw_decode(candidate[match.start():])
                if not candidate[match.start() + end:].strip():
                    return value
            except json.JSONDecodeError:
                continue
        raise BackendFailure("invalid_output", "Search backend did not return valid JSON.") from None


def _marked_json_payload(text, marker):
    if not isinstance(text, str) or len(text) > _MAX_BACKEND_OUTPUT:
        raise BackendFailure("invalid_output", "Search backend output was invalid or too large.")
    matches = [line.strip()[len(marker):] for line in text.splitlines()
               if line.strip().startswith(marker)]
    if len(matches) != 1:
        raise BackendFailure("invalid_output", "Search backend did not return one marked JSON result.")
    try:
        return json.loads(matches[0])
    except (json.JSONDecodeError, TypeError):
        raise BackendFailure("invalid_output", "Search backend did not return valid marked JSON.") from None


def _browser_use_environment(source, query, maximum):
    environment = {key: value for key, value in source.items()
                   if key in _BROWSER_USE_ENV_KEYS and isinstance(value, str) and "\x00" not in value}
    environment.update({
        "FUSION_SEARCH_QUERY": query,
        "FUSION_SEARCH_MAX_RESULTS": str(maximum),
        "PYTHONIOENCODING": "utf-8",
        "PYTHONUTF8": "1",
    })
    return environment


def _search_cli_environment(source):
    """Pass only runtime/browser plumbing, never ambient API credentials."""
    environment = {key: value for key, value in source.items()
                   if key in _OPENCLI_ENV_KEYS and isinstance(value, str) and "\x00" not in value}
    environment.update({"PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"})
    return environment


def _terminate_process_group(process, process_group):
    """Best-effort termination of one isolated CLI process and its descendants."""
    if os.name == "posix":
        try:
            os.killpg(process_group, signal.SIGTERM)
        except (ProcessLookupError, PermissionError, OSError):
            pass
    else:
        try:
            process.terminate()
        except (OSError, ProcessLookupError):
            pass
    try:
        process.wait(timeout=0.25)
    except subprocess.TimeoutExpired:
        pass
    # A session leader can exit before a child which ignored SIGTERM.  Address
    # the saved group id even when the direct process has already been reaped.
    if os.name == "posix":
        try:
            os.killpg(process_group, signal.SIGKILL)
        except (ProcessLookupError, PermissionError, OSError):
            pass
    elif process.poll() is None:
        try:
            process.kill()
        except (OSError, ProcessLookupError):
            pass
    if process.poll() is None:
        try:
            process.wait(timeout=0.5)
        except (subprocess.TimeoutExpired, OSError):
            pass


def _run_bounded_process(argv, *, input_text=None, env=None, timeout=15,
                         output_limit=_MAX_BACKEND_OUTPUT, backend_label="Search CLI"):
    """Run a production CLI with a hard stdout cap and isolated process group.

    stderr is drained but never retained because backend diagnostics must not
    expose arbitrary command output.  The process starts a new POSIX session so
    timeout/output-limit cleanup can terminate browser children as one group.
    """
    deadline = time.monotonic() + max(0.25, float(timeout))
    process = subprocess.Popen(
        list(argv),
        stdin=subprocess.PIPE if input_text is not None else subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
        text=False,
        shell=False,
        start_new_session=(os.name == "posix"),
    )
    process_group = process.pid
    selector = selectors.DefaultSelector()
    stdout_chunks = []
    stdout_size = 0
    try:
        if process.stdin is not None:
            try:
                process.stdin.write(input_text.encode("utf-8"))
                process.stdin.flush()
            except (BrokenPipeError, OSError):
                pass
            finally:
                process.stdin.close()
        for stream, name in ((process.stdout, "stdout"), (process.stderr, "stderr")):
            if stream is not None:
                os.set_blocking(stream.fileno(), False)
                selector.register(stream, selectors.EVENT_READ, name)
        while selector.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                _terminate_process_group(process, process_group)
                raise BackendFailure("timeout", f"{backend_label} search timed out.", status="timeout")
            for key, _ in selector.select(timeout=min(remaining, 0.1)):
                stream = key.fileobj
                if key.data == "stdout":
                    read_size = max(1, min(65536, output_limit - stdout_size + 1))
                else:
                    read_size = 65536
                try:
                    chunk = os.read(stream.fileno(), read_size)
                except BlockingIOError:
                    continue
                if not chunk:
                    selector.unregister(stream)
                    continue
                if key.data == "stdout":
                    stdout_size += len(chunk)
                    if stdout_size > output_limit:
                        _terminate_process_group(process, process_group)
                        raise BackendFailure(
                            "output_too_large",
                            f"{backend_label} output exceeded the safety limit.",
                            retryable=False,
                        )
                    stdout_chunks.append(chunk)
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            _terminate_process_group(process, process_group)
            raise BackendFailure("timeout", f"{backend_label} search timed out.", status="timeout")
        try:
            returncode = process.wait(timeout=remaining)
        except subprocess.TimeoutExpired:
            _terminate_process_group(process, process_group)
            raise BackendFailure("timeout", f"{backend_label} search timed out.", status="timeout") from None
        stdout = b"".join(stdout_chunks).decode("utf-8", errors="replace")
        return subprocess.CompletedProcess(list(argv), returncode, stdout, "")
    except BaseException:
        _terminate_process_group(process, process_group)
        raise
    finally:
        selector.close()
        for stream in (process.stdout, process.stderr):
            if stream is not None:
                try:
                    stream.close()
                except OSError:
                    pass


class BrowserUseBackend:
    """Optional Browser Use CLI 3 backend; it does not invoke another LLM."""

    name = "browser_use"

    def __init__(self, runner: Callable | None = None, executable: str | None = None, environ=None):
        self.runner = runner
        self.executable = executable
        self.environ = os.environ if environ is None else environ

    def _run(self, executable, query, maximum, timeout):
        environment = _browser_use_environment(self.environ, query, maximum)
        try:
            if self.runner is not None:
                # Preserve the injected runner seam for tests/integrators.  The
                # production path below owns process isolation and output bounds.
                return self.runner([executable], input=_BROWSER_USE_TEMPLATE, env=environment,
                                   capture_output=True, text=True, timeout=max(0.25, timeout),
                                   shell=False, check=False)
            return _run_bounded_process(
                [executable], input_text=_BROWSER_USE_TEMPLATE, env=environment,
                timeout=timeout, backend_label="Browser Use",
            )
        except subprocess.TimeoutExpired:
            raise BackendFailure("timeout", "Browser Use search timed out.", status="timeout") from None
        except FileNotFoundError:
            raise BackendFailure("dependency_missing", "Browser Use CLI 3 is not installed in PATH.",
                                 status="unavailable", retryable=False) from None
        except (OSError, ValueError):
            raise BackendFailure("backend_error", "Browser Use CLI could not start.") from None

    def search(self, query, maximum, timeout):
        executable = self.executable or ("browser-use" if self.runner else shutil.which("browser-use"))
        if not executable:
            raise BackendFailure("dependency_missing", "Browser Use CLI 3 is not installed in PATH.",
                                 status="unavailable", retryable=False)
        try:
            completed = self._run(executable, query, maximum, timeout)
            if getattr(completed, "returncode", 1) != 0:
                raise BackendFailure("backend_error", "Browser Use CLI could not complete the public search.")
            value = _marked_json_payload(getattr(completed, "stdout", ""), _BROWSER_USE_RESULT_MARKER)
            return _normalize_items(value, self.name, maximum)
        except BackendFailure:
            raise
        except (TimeoutError, socket.timeout):
            raise BackendFailure("timeout", "Browser Use search timed out.", status="timeout") from None
        except Exception:
            raise BackendFailure("backend_error", "Browser Use could not complete the public search.") from None


class OpenCLIBackend:
    """Optional OpenCLI DuckDuckGo adapter, invoked once without a shell."""

    name = "opencli"

    def __init__(self, runner: Callable | None = None, executable: str | None = None, environ=None):
        self.runner = runner
        self.executable = executable
        self.environ = os.environ if environ is None else environ

    def _run(self, argv, timeout):
        try:
            environment = _search_cli_environment(self.environ)
            if self.runner is not None:
                return self.runner(argv, capture_output=True, text=True, timeout=max(0.25, timeout),
                                   env=environment, shell=False, check=False)
            return _run_bounded_process(
                argv, env=environment, timeout=timeout, backend_label="OpenCLI",
            )
        except subprocess.TimeoutExpired:
            raise BackendFailure("timeout", "OpenCLI search timed out.", status="timeout") from None
        except FileNotFoundError:
            raise BackendFailure("dependency_missing", "OpenCLI is not installed in PATH.",
                                 status="unavailable", retryable=False) from None
        except (OSError, ValueError):
            raise BackendFailure("backend_error", "OpenCLI could not start.") from None

    def search(self, query, maximum, timeout):
        executable = self.executable or ("opencli" if self.runner else shutil.which("opencli"))
        if not executable:
            raise BackendFailure("dependency_missing", "OpenCLI is not installed in PATH.",
                                 status="unavailable", retryable=False)
        # Keep a leading dash from being interpreted as another CLI option. A
        # leading space is part of the positional query and is harmless to DDG.
        cli_query = " " + query if query.startswith("-") else query
        completed = self._run([executable, "duckduckgo", "search", cli_query,
                               "--limit", str(min(maximum, 10)), "-f", "json"], timeout)
        returncode = getattr(completed, "returncode", 1)
        if returncode == 66:
            return []
        failures = {
            69: BackendFailure("backend_unavailable", "OpenCLI Browser Bridge is unavailable.",
                               status="unavailable"),
            75: BackendFailure("timeout", "OpenCLI search timed out.", status="timeout"),
            77: BackendFailure("authentication_required", "OpenCLI requires browser authentication.",
                               status="unavailable", retryable=False),
            78: BackendFailure("configuration_error", "OpenCLI search adapter is not configured.",
                               status="unavailable", retryable=False),
        }
        if returncode in failures:
            raise failures[returncode]
        if returncode != 0:
            raise BackendFailure("backend_error", "OpenCLI search command failed.")
        value = _json_payload(getattr(completed, "stdout", ""))
        return _normalize_items(value, self.name, maximum)


class PlaywrightBackend:
    """Final isolated headless Chromium fallback; Playwright is optional."""

    name = "playwright"

    def __init__(self, searcher: Callable | None = None):
        self.searcher = searcher

    @staticmethod
    def _default_searcher(query, maximum, timeout):
        try:
            module = importlib.import_module("playwright.sync_api")
            sync_playwright = getattr(module, "sync_playwright")
        except (ImportError, AttributeError):
            raise BackendFailure("dependency_missing",
                                 "Playwright is not installed in the Agent interpreter.",
                                 status="unavailable", retryable=False) from None
        manager = browser = None
        deadline = time.monotonic() + max(0.25, float(timeout))

        def remaining_ms():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise BackendFailure("timeout", "Playwright search timed out.", status="timeout")
            return max(1, int(remaining * 1000))

        try:
            manager = sync_playwright().start()
            browser = manager.chromium.launch(
                headless=True, chromium_sandbox=True, timeout=remaining_ms())
            page = browser.new_page()
            page.goto(_DDG_ENDPOINT + "?" + urlencode({"q": query}),
                      wait_until="domcontentloaded", timeout=remaining_ms())
            page.wait_for_selector(".result__a", timeout=remaining_ms())
            return page.eval_on_selector_all(
                ".result",
                "(rows, maximum) => rows.slice(0, maximum).map(row => { const a = row.querySelector('a.result__a'); const s = row.querySelector('.result__snippet'); return a ? {title:(a.textContent||'').trim(),url:a.href,snippet:(s?.textContent||'').trim()} : null; }).filter(Boolean)",
                maximum,
            )
        except BackendFailure:
            raise
        except Exception as exc:
            if time.monotonic() >= deadline or type(exc).__name__ == "TimeoutError":
                raise BackendFailure("timeout", "Playwright search timed out.", status="timeout") from None
            raise BackendFailure("backend_error", "Playwright could not complete the public search.") from None
        finally:
            if browser is not None:
                try:
                    browser.close()
                except Exception:
                    pass
            if manager is not None:
                try:
                    manager.stop()
                except Exception:
                    pass

    def search(self, query, maximum, timeout):
        searcher = self.searcher or self._default_searcher
        try:
            return _normalize_items(searcher(query, maximum, timeout), self.name, maximum)
        except BackendFailure:
            raise
        except (TimeoutError, socket.timeout):
            raise BackendFailure("timeout", "Playwright search timed out.", status="timeout") from None
        except Exception:
            raise BackendFailure("backend_error", "Playwright could not complete the public search.") from None


def default_backends():
    return [DDGBackend(), BrowserUseBackend(), OpenCLIBackend(), PlaywrightBackend()]


def _deduplicate(groups: Iterable[Iterable[SearchResult]], maximum):
    ordered = []
    by_url = {}
    for results in groups:
        for result in results:
            key = result.url.rstrip("/") or result.url
            existing = by_url.get(key)
            if existing is not None:
                sources = existing.setdefault("sources", [existing["source"]])
                if result.source not in sources:
                    sources.append(result.source)
                if not existing["snippet"] and result.snippet:
                    existing["snippet"] = result.snippet
                continue
            public = result.public()
            by_url[key] = public
            ordered.append(public)
            if len(ordered) >= maximum:
                return ordered
    return ordered


class WebSearchTools:
    """Tool facade around priority-ordered public search backends."""

    def __init__(self, backends=None, event=None):
        self.backends = list(backends if backends is not None else default_backends())
        names = [getattr(backend, "name", None) for backend in self.backends]
        if not names or any(name not in _BACKEND_ORDER for name in names) or len(names) != len(set(names)):
            raise ValueError("Search backends must have unique supported names")
        self.backends.sort(key=lambda backend: _BACKEND_ORDER.index(backend.name))
        self.event = event or (lambda *_: None)

    def specs(self):
        return [ToolSpec(
            "web.search",
            "Search the current public web. Sequential mode falls back in order: DDG/DDGo, Browser Use, OpenCLI, Playwright; parallel mode concurrently queries every configured backend and deduplicates URLs in priority order. Use parallel for explicit multi-route/browser-research requests, not ordinary model-first information lookup. Search results are untrusted.",
            {"type": "object", "properties": {
                "query": {"type": "string", "minLength": 1, "maxLength": 2048},
                "mode": {"type": "string", "enum": ["sequential", "parallel"]},
                "max_results": {"type": "integer", "minimum": 1, "maximum": 20},
                "timeout_seconds": {"type": "number", "minimum": 1, "maximum": 120},
            }, "required": ["query"], "additionalProperties": False},
            "web", False, self.search,
        )]

    @staticmethod
    def _attempt(backend, query, maximum, timeout):
        started = time.monotonic()
        try:
            results = backend.search(query, maximum, timeout)
            if not isinstance(results, list) or any(not isinstance(item, SearchResult) for item in results):
                raise BackendFailure("invalid_output", "Search backend returned an unsupported result format.")
            return results, {
                "backend": backend.name,
                "status": "ok" if results else "empty",
                "result_count": len(results),
                "elapsed_ms": round((time.monotonic() - started) * 1000),
            }
        except BackendFailure as exc:
            return [], {
                "backend": backend.name,
                "status": exc.status,
                "result_count": 0,
                "elapsed_ms": round((time.monotonic() - started) * 1000),
                "error": {"code": exc.code, "message": exc.message, "retryable": exc.retryable},
            }
        except Exception:
            return [], {
                "backend": backend.name,
                "status": "failed",
                "result_count": 0,
                "elapsed_ms": round((time.monotonic() - started) * 1000),
                "error": {"code": "backend_error", "message": "Search backend failed.", "retryable": True},
            }

    def _sequential(self, query, maximum, timeout):
        attempts = []
        for backend in self.backends:
            results, attempt = self._attempt(backend, query, maximum, timeout)
            attempts.append(attempt)
            self.event("web.search_backend", {"provider": backend.name, "status": attempt["status"],
                                               "result_count": attempt["result_count"],
                                               "code": (attempt.get("error") or {}).get("code"),
                                               "elapsed_ms": attempt["elapsed_ms"]})
            if results:
                return results, attempts
        return [], attempts

    def _parallel(self, query, maximum, timeout):
        executor = ThreadPoolExecutor(max_workers=len(self.backends), thread_name_prefix="fusion-search")
        futures = {executor.submit(self._attempt, backend, query, maximum, timeout): backend
                   for backend in self.backends}
        done, pending = wait(futures, timeout=timeout)
        by_name = {}
        for future in done:
            backend = futures[future]
            try:
                by_name[backend.name] = future.result()
            except Exception:
                by_name[backend.name] = ([], {"backend": backend.name, "status": "failed", "result_count": 0,
                                                    "elapsed_ms": round(timeout * 1000),
                                                    "error": {"code": "backend_error", "message": "Search backend failed.", "retryable": True}})
        for future in pending:
            backend = futures[future]
            future.cancel()
            by_name[backend.name] = ([], {"backend": backend.name, "status": "timeout", "result_count": 0,
                                                "elapsed_ms": round(timeout * 1000),
                                                "error": {"code": "timeout", "message": "Search backend timed out.", "retryable": True}})
        executor.shutdown(wait=False, cancel_futures=True)
        ordered = [by_name[backend.name] for backend in self.backends]
        for _, attempt in ordered:
            self.event("web.search_backend", {"provider": attempt["backend"], "status": attempt["status"],
                                               "result_count": attempt["result_count"],
                                               "code": (attempt.get("error") or {}).get("code"),
                                               "elapsed_ms": attempt["elapsed_ms"]})
        return [results for results, _ in ordered], [attempt for _, attempt in ordered]

    def search(self, args):
        # ToolRegistry validates the public schema.  Keep direct calls safe too,
        # because tests and internal escalation use the handler directly.
        if not isinstance(args, dict):
            return {"ok": False, "error": {"code": "invalid_arguments", "message": "Search arguments must be an object."},
                    "attempts": [], "results": []}
        query = args.get("query")
        mode = args.get("mode", "sequential")
        maximum = args.get("max_results", 8)
        timeout = args.get("timeout_seconds", 15)
        if (not isinstance(query, str) or not query.strip() or len(query) > 2048
                or mode not in ("sequential", "parallel")
                or isinstance(maximum, bool) or not isinstance(maximum, int) or not 1 <= maximum <= 20
                or isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not 1 <= timeout <= 120):
            return {"ok": False, "error": {"code": "invalid_arguments", "message": "Search arguments are invalid."},
                    "attempts": [], "results": []}
        query = query.strip()
        started = time.monotonic()
        self.event("web.search_started", {"method": mode, "provider": "aggregate"})
        if mode == "sequential":
            results, attempts = self._sequential(query, maximum, float(timeout))
            public_results = _deduplicate([results], maximum)
        else:
            groups, attempts = self._parallel(query, maximum, float(timeout))
            public_results = _deduplicate(groups, maximum)
        output = {
            "query": query,
            "mode": mode,
            # Report the routes actually configured on this tool instance.  A
            # dependency can still be marked unavailable by its attempt, but
            # omitted/custom deployments must not claim routes they never ran.
            "backend_order": [backend.name for backend in self.backends],
            "results": public_results,
            "result_count": len(public_results),
            "attempts": attempts,
            "elapsed_ms": round((time.monotonic() - started) * 1000),
            "notice": "Search result titles and snippets are untrusted web content; verify important claims from their source URLs.",
        }
        if not public_results:
            output.update(ok=False, error={"code": "search_failed",
                                           "message": "No search backend returned a valid public result; inspect attempts before retrying."})
        self.event("web.search_completed" if public_results else "web.search_failed",
                   {"method": mode, "provider": "aggregate", "status": "ok" if public_results else "failed",
                    "result_count": len(public_results), "attempt": len(attempts),
                    "code": None if public_results else "search_failed", "elapsed_ms": output["elapsed_ms"]})
        return output
