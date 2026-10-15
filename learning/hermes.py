"""Synchronous job adapter over the application's actual Hermes sessions."""
from pathlib import Path
import queue
import shutil
import tempfile
import time

from .contracts import LearningError


class HermesClient:
    def __init__(self, session_factory, get_providers, cli_available, work_dir):
        self.session_factory, self.get_providers = session_factory, get_providers
        self.cli_available, self.work_dir = cli_available, Path(work_dir)
        self.work_dir.mkdir(parents=True, exist_ok=True)

    def available(self):
        return {'available': bool(self.cli_available()), 'engine': 'Hermes'}

    def request(self, prompt, cancel, progress, provider_id=None, model=None, timeout=900):
        if cancel.is_set():
            raise LearningError('任务已取消')
        if not self.available()['available']:
            raise LearningError('Hermes CLI 不可用，请先配置 Hermes', 503)
        providers = self.get_providers() or []
        provider = next((p for p in providers if p.get('id') == provider_id), None) if provider_id else next((p for p in providers if p.get('isDefault')), None)
        if provider_id and not provider:
            raise LearningError('所选模型配置不存在')
        if provider:
            provider = {**provider, 'model': model or provider.get('selectedModel') or provider.get('model') or next(iter(provider.get('models', [])), None)}
        events = queue.Queue()
        cwd = tempfile.mkdtemp(prefix='job-', dir=self.work_dir)
        session = None
        try:
            session = self.session_factory(send_json=events.put, cwd=cwd, provider=provider, model=model)
            if not session.start():
                raise LearningError('Hermes 会话启动失败', 503)
            session.send_user(prompt)
            deadline, answer, error = time.monotonic()+timeout, '', ''
            while True:
                if cancel.is_set():
                    raise LearningError('任务已取消')
                if time.monotonic() >= deadline:
                    raise LearningError('Hermes 响应超时', 504)
                try:
                    event = events.get(timeout=min(.1, max(.001, deadline-time.monotonic())))
                except queue.Empty:
                    continue
                kind = event.get('type')
                if kind == 'response':
                    answer = event.get('text', '')
                elif kind == 'error':
                    error = event.get('error') or 'Hermes 执行失败'
                elif kind == 'progress':
                    progress(event.get('title') or 'Hermes 正在处理')
                elif kind in ('done', 'exit'):
                    if error:
                        raise LearningError(error, 502)
                    if not answer.strip():
                        raise LearningError('Hermes 没有返回有效内容', 502)
                    return answer
        finally:
            if session:
                session.close(cleanup_only=True)
            shutil.rmtree(cwd, ignore_errors=True)
