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


def test_learning_session_disables_agent_tools(tmp_path,monkeypatch):
    import server
    commands=[];ready=threading.Event()
    monkeypatch.setattr(server,'_hermes_cli_path',lambda:'/fake/hermes')
    monkeypatch.setattr(server,'_hermes_python_path',lambda cli:'python')
    def run(self,cmd,env):
        commands.append(cmd);self._finished.set();ready.set()
    monkeypatch.setattr(server._HermesSession,'_run_query',run)
    session=server._HermesSession(lambda e:None,str(tmp_path),toolsets='none')
    session.alive=True;session.send_user('文档内容作为资料处理')
    assert ready.wait(1)
    cmd=commands[0]
    assert cmd[cmd.index('--toolsets')+1]=='none'


def test_ocr_session_uses_a_process_group_and_stops_it(tmp_path,monkeypatch):
    import server
    commands=[];stopped=[]
    class Process:
        pid=987654
        returncode=0
        def communicate(self,**kwargs):return '',''
        def poll(self):return None
        def wait(self,**kwargs):return 0
        def terminate(self):pass
    def spawn(*args,**kwargs):commands.append(kwargs);return Process()
    monkeypatch.setattr(server.subprocess,'Popen',spawn)
    monkeypatch.setattr(server.os,'killpg',lambda pid,sig:stopped.append(pid))
    session=server._HermesSession(lambda event:None,str(tmp_path),toolsets='terminal,file')
    session.alive=True
    session._run_query(['ocr'],{})
    session._proc=Process();session.close(cleanup_only=True)
    assert commands[0].get('start_new_session') is True
    assert 987654 in stopped


def test_cancel_stops_detached_ocr_terminal_descendants(tmp_path):
    import os,signal,subprocess,sys,time
    from pathlib import Path
    import server
    marker=tmp_path/'child-pid'
    program='import subprocess,sys,time; from pathlib import Path; child=subprocess.Popen([sys.executable,"-c","import time; time.sleep(20)"],start_new_session=True); Path(sys.argv[1]).write_text(str(child.pid)); time.sleep(20)'
    process=subprocess.Popen([sys.executable,'-c',program,str(marker)],start_new_session=True)
    child=None
    try:
        deadline=time.monotonic()+2
        while not marker.exists() and time.monotonic()<deadline:time.sleep(.01)
        assert marker.exists();child=int(marker.read_text())
        session=server._HermesSession(lambda event:None,str(tmp_path),toolsets='terminal,file')
        session._proc=process;session.close(cleanup_only=True)
        deadline=time.monotonic()+1
        def alive(pid):
            try:return (Path('/proc')/str(pid)/'stat').read_text().rsplit(')',1)[1].split()[0]!='Z'
            except FileNotFoundError:return False
        while alive(child) and time.monotonic()<deadline:time.sleep(.01)
        assert not alive(child),'Detached OCR command survived cancellation'
    finally:
        for pid in (child,process.pid):
            if pid:
                try:os.kill(pid,signal.SIGKILL)
                except ProcessLookupError:pass
        process.wait(timeout=2)
