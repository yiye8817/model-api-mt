import threading
import pytest

from learning.hermes import HermesClient
from learning.contracts import LearningError


class Session:
    def __init__(self, emit, **kw):
        self.emit, self.closed = emit, False
    def start(self):
        return True
    def send_user(self, prompt):
        self.emit({'type': 'response', 'text': '真实结果'})
        self.emit({'type': 'done'})
    def close(self, **kw):
        self.closed = True


def test_hermes_collects_result_and_cleans_session(tmp_path):
    sessions = []
    def factory(send_json, **kwargs):
        session = Session(send_json, **kwargs)
        sessions.append(session)
        return session
    client = HermesClient(factory, lambda: [], lambda: True, tmp_path)
    assert client.request('问题', threading.Event(), lambda *a: None) == '真实结果'
    assert sessions[0].closed


def test_hermes_cancel_and_timeout_are_errors(tmp_path):
    class Silent(Session):
        def send_user(self, prompt):
            pass
    client = HermesClient(lambda send_json, **kw: Silent(send_json), lambda: [], lambda: True, tmp_path)
    with pytest.raises(LearningError, match='超时'):
        client.request('问题', threading.Event(), lambda *a: None, timeout=.02)
    event = threading.Event(); event.set()
    with pytest.raises(LearningError, match='取消'):
        client.request('问题', event, lambda *a: None)


def test_error_after_response_is_not_success(tmp_path):
    class Broken(Session):
        def send_user(self, prompt):
            self.emit({'type':'response', 'text':'不完整结果'})
            self.emit({'type':'error', 'error':'后端出错'})
            self.emit({'type':'done'})
    client = HermesClient(lambda send_json, **kw: Broken(send_json), lambda: [], lambda: True, tmp_path)
    with pytest.raises(LearningError, match='后端出错'):
        client.request('问题', threading.Event(), lambda *a: None)


def test_closed_server_session_does_not_spawn_late_process(tmp_path, monkeypatch):
    import server
    spawned = []
    def spawn(*args, **kw):
        spawned.append(True)
        raise RuntimeError('late spawn')
    monkeypatch.setattr(server.subprocess, 'Popen', spawn)
    session = server._HermesSession(lambda event: None, str(tmp_path))
    session.close()
    session._run_query(['unused'], {})
    assert spawned == []
