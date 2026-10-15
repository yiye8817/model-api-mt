import builtins
from learning.runtime import LearningRuntime


def test_runtime_reads_without_loading_chroma_or_document_parsers(tmp_path,monkeypatch):
    original = builtins.__import__
    def guarded(name,*a,**kw):
        if name.startswith(('chromadb','pypdf','docx')):
            raise AssertionError('可选依赖被提前导入')
        return original(name,*a,**kw)
    monkeypatch.setattr(builtins,'__import__',guarded)
    runtime = LearningRuntime(tmp_path,None,lambda:[],lambda:False,None,None)
    try:
        assert runtime.components().status()['documents'] == 0
        assert runtime.components().status()['hermes']['available'] is False
    finally:
        runtime.close()
