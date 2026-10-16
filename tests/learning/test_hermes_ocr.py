import json
import shutil
import sys
import threading
from pathlib import Path

import pytest

from learning.contracts import LearningError
from learning.hermes import HermesClient


@pytest.fixture
def skill_cli(tmp_path,monkeypatch):
    cli=tmp_path/'hermes'
    cli.write_text('#!'+sys.executable+'\n'+'''import os,sys
from pathlib import Path
assert sys.argv[1:3]==['skills','install']
assert sys.argv[3].startswith('https://raw.githubusercontent.com/NousResearch/hermes-agent/')
assert '--yes' in sys.argv and '--force' not in sys.argv
folder=Path(os.environ['HERMES_HOME'])/'skills'/'pdf'
folder.mkdir(parents=True,exist_ok=True)
(folder/'SKILL.md').write_text('PDF OCR skill')
(folder/'references').mkdir(exist_ok=True)
(folder/'references'/'ocr-extraction.md').write_text('OCR extraction')
(Path(os.environ['HERMES_HOME'])/'installed-once').open('a').write('installed\\n')
''')
    cli.chmod(0o755)
    original=shutil.which
    monkeypatch.setattr(shutil,'which',lambda command: str(cli) if command=='hermes' else original(command))
    return cli


def client_with_artifact(tmp_path,artifact):
    class Session:
        def __init__(self,send_json,cwd,toolsets=None,**kwargs):
            self.emit=send_json;self.cwd=Path(cwd);self.tools=toolsets
        def start(self):return True
        def send_user(self,prompt):
            data=json.loads(prompt.split('\nINPUT_JSON\n')[1])
            assert self.tools=='terminal,file'
            assert Path(data['input_path']).read_bytes()==b'pdf-input'
            assert Path(data['skill_path']).is_file()
            artifact(Path(data['output_path']),data)
            self.emit({'type':'response','text':'OCR completed'})
            self.emit({'type':'done'})
        def close(self,**kwargs):pass
    return HermesClient(Session,lambda:[],lambda:True,tmp_path/'runtime')


def test_hermes_downloads_skill_then_reads_artifact_and_reuses_install(tmp_path,skill_cli):
    source=tmp_path/'scan.pdf';source.write_bytes(b'pdf-input')
    def artifact(path,data):
        path.write_text(json.dumps({'engine':'local-ocr-tool','pages':[{'page':2,'lines':[{'text':'OCR 原文','bbox':[.1,.2,.9,.4]}]}]}))
    client=client_with_artifact(tmp_path,artifact)
    for _ in range(2):
        value=client.ocr_pdf(source,[2],threading.Event(),lambda message:None)
        assert value==[{'page':2,'lines':[{'text':'OCR 原文','bbox':[.1,.2,.9,.4]}]}]
    cache=tmp_path/'runtime'/'ocr-tools'
    assert (cache/'installed-once').read_text()=='installed\n'
    assert list((tmp_path/'runtime').glob('ocr-job-*'))==[]
    assert source.read_bytes()==b'pdf-input'


@pytest.mark.parametrize('kind',['wrong-page','invalid-box','missing-file','symlink'])
def test_hermes_rejects_unusable_ocr_artifacts(tmp_path,skill_cli,kind):
    source=tmp_path/'scan.pdf';source.write_bytes(b'pdf-input')
    outside=tmp_path/'outside.json';outside.write_text('{"pages":[]}')
    def artifact(path,data):
        if kind=='missing-file':return
        if kind=='symlink':path.symlink_to(outside);return
        page=3 if kind=='wrong-page' else 2
        box=[0,0,2,1] if kind=='invalid-box' else [0,0,1,1]
        path.write_text(json.dumps({'engine':'ocr','pages':[{'page':page,'lines':[{'text':'text','bbox':box}]}]}))
    client=client_with_artifact(tmp_path,artifact)
    with pytest.raises(LearningError,match='OCR'):
        client.ocr_pdf(source,[2],threading.Event(),lambda message:None)
    assert list((tmp_path/'runtime').glob('ocr-job-*'))==[]


def test_unavailable_local_ocr_uses_hermes_but_cancellation_does_not(tmp_path,monkeypatch):
    from learning import ocr
    def unavailable(*args,**kwargs):raise ocr.LocalOCRError('missing local engine')
    monkeypatch.setattr(ocr,'local_pdf_ocr',unavailable)
    class Hermes:
        def ocr_pdf(self,path,pages,cancel,progress,**options):
            return [{'page':1,'lines':[{'text':'fallback evidence','bbox':[0,0,1,1]}]}]
    event=threading.Event()
    assert ocr.recognize_pdf(tmp_path/'scan.pdf',[1],event,Hermes())[0]['lines'][0]['text']=='fallback evidence'
    event.set()
    with pytest.raises(LearningError,match='取消'):
        ocr.recognize_pdf(tmp_path/'scan.pdf',[1],event,Hermes())


def test_uploaded_scan_falls_back_to_hermes_and_is_analyzed(tmp_path,skill_cli,monkeypatch):
    from learning import ocr
    from learning.runtime import LearningRuntime
    from tests.learning.test_end_to_end import StructuredSession
    from tests.learning.test_pdf_ocr import scanned_pdf
    from tests.learning.test_jobs import wait_terminal
    def unavailable(*args,**kwargs):raise ocr.LocalOCRError('engine unavailable')
    monkeypatch.setattr(ocr,'local_pdf_ocr',unavailable)
    class Session(StructuredSession):
        def __init__(self,send_json,**kwargs):super().__init__(send_json,**kwargs);self.tools=kwargs.get('toolsets')
        def send_user(self,prompt):
            data=json.loads(prompt.split('\nINPUT_JSON\n')[1])
            if data['operation']!='ocr':return super().send_user(prompt)
            assert self.tools=='terminal,file'
            Path(data['output_path']).write_text(json.dumps({'engine':'OCR test tool','pages':[{'page':1,'lines':[{'text':'量子叠加是状态的线性组合。','bbox':[.1,.2,.9,.4]}]}]}))
            self.emit({'type':'response','text':'done'});self.emit({'type':'done'})
    runtime=LearningRuntime(tmp_path/'learning',Session,lambda:[],lambda:True)
    path=tmp_path/'scan.pdf';scanned_pdf(path)
    try:
        service=runtime.components()
        with path.open('rb') as stream:accepted=service.upload([('扫描资料.pdf',stream)],{})['items'][0]
        job=wait_terminal(service.store,accepted['job_id'])
        assert job['status']=='completed',job.get('error')
        analysis=service.store.get_analysis(accepted['document_id'])
        assert analysis['coverage']=={'processed':1,'total':1}
        assert analysis['concepts'][0]['citations'][0]['position']['kind']=='pdf_ocr'
    finally:runtime.close()


def test_cancelled_skill_download_does_not_start_ocr_session(tmp_path,skill_cli):
    skill_cli.write_text('#!'+sys.executable+'\nimport time\ntime.sleep(20)\n')
    client=HermesClient(lambda **kw:pytest.fail('Cancelled download started OCR'),lambda:[],lambda:True,tmp_path/'runtime')
    source=tmp_path/'scan.pdf';source.write_bytes(b'pdf')
    event=threading.Event();timer=threading.Timer(.15,event.set);timer.start()
    try:
        with pytest.raises(LearningError,match='取消'):
            client.ocr_pdf(source,[1],event,lambda message:None)
        assert list((tmp_path/'runtime').glob('ocr-job-*'))==[]
    finally:timer.join()


def test_failed_skill_install_keeps_diagnostics_and_does_not_run_ocr(tmp_path,skill_cli):
    skill_cli.write_text('#!'+sys.executable+'\nprint("Download connection failed")\n')
    client=HermesClient(lambda **kw:pytest.fail('Failed install started OCR'),lambda:[],lambda:True,tmp_path/'runtime')
    with pytest.raises(LearningError,match='下载或安装'):
        client.ocr_pdf(tmp_path/'scan.pdf',[1],threading.Event(),lambda message:None)
    assert 'Download connection failed' in (tmp_path/'runtime'/'ocr-tools'/'install.log').read_text()


def test_skill_download_accepts_existing_socks_proxy_configuration(tmp_path,skill_cli,monkeypatch):
    from learning.hermes_ocr import ensure_skill
    monkeypatch.setenv('ALL_PROXY','socks://127.0.0.1:10811')
    skill_cli.write_text(skill_cli.read_text().replace('import os,sys','import os,sys\nassert os.environ["ALL_PROXY"]=="socks5://127.0.0.1:10811"'))
    client=HermesClient(lambda **kw:None,lambda:[],lambda:True,tmp_path/'runtime')
    assert ensure_skill(client,threading.Event(),lambda message:None).is_file()


def test_concurrent_ocr_jobs_do_not_collide_in_the_tool_environment(tmp_path,skill_cli):
    import time
    from concurrent.futures import ThreadPoolExecutor
    from learning.hermes_ocr import ensure_skill
    source=tmp_path/'scan.pdf';source.write_bytes(b'pdf-input')
    def artifact(path,data):
        environment=Path(data['tool_env_dir']);environment.mkdir(parents=True,exist_ok=True)
        marker=environment/'busy'
        with marker.open('x'):
            try:
                time.sleep(.15)
                path.write_text(json.dumps({'engine':'ocr','pages':[{'page':2,'lines':[{'text':'recognized','bbox':[0,0,1,1]}]}]}))
            finally:marker.unlink()
    client=client_with_artifact(tmp_path,artifact)
    ensure_skill(client,threading.Event(),lambda message:None)
    gate=threading.Barrier(2)
    def run():
        gate.wait()
        return client.ocr_pdf(source,[2],threading.Event(),lambda message:None)
    with ThreadPoolExecutor(2) as pool:
        futures=[pool.submit(run) for _ in range(2)]
        assert all(future.result()[0]['lines'][0]['text']=='recognized' for future in futures)
