import json
import os
import re
import signal
import subprocess
import tempfile
import time

from .sources import normalize


class SearchFailure(RuntimeError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def run_command(argv, cancel):
    env = dict(os.environ)
    env.update(OPENCLI_BROWSER_CONNECT_TIMEOUT='8', OPENCLI_BROWSER_COMMAND_TIMEOUT='25', OPENCLI_WINDOW='background')
    # Files avoid filling a pipe while Chrome or a trace produces verbose output.
    with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
        try:
            process = subprocess.Popen(argv, stdout=out, stderr=err, env=env, start_new_session=True)
        except FileNotFoundError as exc:
            raise SearchFailure('NOT_INSTALLED', '未找到 OpenCLI，请安装后重新搜索') from exc
        start = time.monotonic()
        try:
            while process.poll() is None:
                if cancel.wait(.1):
                    raise SearchFailure('CANCELLED', '已停止')
                if time.monotonic() - start > 40:
                    raise SearchFailure('TIMEOUT', 'OpenCLI 搜索超时')
            out.seek(0); err.seek(0)
            stdout = out.read(2_000_000).decode('utf-8', 'replace')
            stderr = err.read(16000).decode('utf-8', 'replace')
            if process.returncode:
                found = re.search(r'\bcode:\s*[\'"]?([A-Z_]+)', stderr)
                code = found.group(1) if found else {69: 'BROWSER_CONNECT', 77: 'AUTH_REQUIRED'}.get(process.returncode, 'COMMAND_EXEC')
                message = {'BROWSER_CONNECT': 'OpenCLI 浏览器扩展未连接，请连接 Chrome 后重试',
                           'AUTH_REQUIRED': '该站点需要登录，请在 Chrome 登录后重试'}.get(code, stderr[-800:] or 'OpenCLI 搜索失败')
                raise SearchFailure(code, message)
            try:
                result = json.loads(stdout)
            except ValueError as exc:
                raise SearchFailure('INVALID_RESULT', 'OpenCLI 返回了无法解析的结果') from exc
            if isinstance(result, dict) and result.get('error'):
                failure = result['error']
                raise SearchFailure(failure.get('code', 'COMMAND_EXEC'), failure.get('message', 'OpenCLI 搜索失败'))
            return result
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(2)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL); process.wait()


class OpenCliSearch:
    def __init__(self, run=run_command, limit=3):
        self.run = run; self.limit = min(5, max(1, limit))

    def search(self, site, query, cancel, emit):
        sites = {'google': 'google', 'official': 'google', 'github': 'google', 'youtube': 'youtube', 'x': 'twitter', 'reddit': 'reddit'}
        if site not in sites:
            raise SearchFailure('ARGUMENT', '未知搜索来源')
        original = str(query).strip()[:600]
        for attempt in range(1, 4):
            if cancel.is_set():
                raise SearchFailure('CANCELLED', '已停止')
            current = original if attempt == 1 else re.sub(r'[？?！!，,；;。]', ' ', original).strip()
            if attempt == 3:
                current = ' '.join(current.split()[:12]) + ' information'
            if site == 'github':
                current = 'site:github.com ' + current
                if attempt == 1:
                    emit('status', {'channel': site, 'status': 'running', 'detail': 'OpenCLI Google 站内搜索 GitHub'})
            elif site == 'official':
                current += ' official documentation 官网'
            adapter = sites[site]
            if attempt == 3 and site in ('youtube', 'reddit', 'x'):
                domain = {'youtube': 'youtube.com', 'reddit': 'reddit.com', 'x': 'x.com'}[site]
                adapter = 'google'; current = f'site:{domain} {current}'
                emit('status', {'channel': site, 'status': 'retrying', 'attempt': attempt,
                                'detail': '站点适配仍失败，修正为 OpenCLI Google 站内搜索'})
            if current.startswith('-'):
                current = 'search ' + current
            argv = ['opencli', adapter, 'search', current, '--limit', str(self.limit), '-f', 'json',
                    '--trace', 'retain-on-failure', '--window', 'background', '--site-session', 'ephemeral']
            if site == 'x' and adapter == 'twitter':
                argv += ['--product', 'live']
            try:
                payload = self.run(argv, cancel)
                rows = payload if isinstance(payload, list) else payload.get('items', payload.get('results', [])) if isinstance(payload, dict) else []
                results = [s for row in rows if (s := normalize(row, site))]
                domain = {'youtube': 'youtube.com', 'reddit': 'reddit.com', 'x': 'x.com', 'github': 'github.com'}.get(site)
                if domain:
                    from urllib.parse import urlsplit
                    allowed = {domain, 'twitter.com'} if site == 'x' else {domain}
                    results = [s for s in results if any((urlsplit(s['url']).hostname or '').lower() == item or
                               (urlsplit(s['url']).hostname or '').lower().endswith('.' + item) for item in allowed)]
                if results:
                    return results[:self.limit]
                raise SearchFailure('EMPTY_RESULT', '未检索到相关内容')
            except SearchFailure as exc:
                if exc.code in ('AUTH_REQUIRED', 'BROWSER_CONNECT', 'CAPTCHA', 'RATE_LIMIT', 'NOT_INSTALLED', 'CANCELLED') or attempt == 3:
                    raise
                emit('status', {'channel': site, 'status': 'retrying', 'attempt': attempt + 1,
                                'detail': f'调整检索词后重试（{attempt + 1}/3）：{exc.code}'})
