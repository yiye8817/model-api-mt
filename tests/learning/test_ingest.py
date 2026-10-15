import threading
import pytest

from learning.contracts import LearningError
from learning.ingest import parse_upload, parse_link, make_chunks
from web_research.pages import extract_article


def test_text_upload_preserves_tail_and_line_positions(tmp_path):
    path = tmp_path/'手册.md'
    path.write_text('# 开始\n'+('知识点解释\n'*800)+'# 最后\n末尾知识点', encoding='utf-8')
    result = parse_upload(path, threading.Event())
    chunks = make_chunks(result['units'], 'doc', 1)
    assert '末尾知识点' in chunks[-1]['text']
    assert all(c['position']['kind'] == 'lines' for c in chunks)


def test_unsupported_and_oversize_uploads_are_rejected(tmp_path):
    path = tmp_path/'image.png'
    path.write_bytes(b'fake')
    with pytest.raises(LearningError, match='格式'):
        parse_upload(path, threading.Event())
    path = tmp_path/'huge.txt'
    with path.open('wb') as f:
        f.truncate(20*1024*1024+1)
    with pytest.raises(LearningError, match='20'):
        parse_upload(path, threading.Event())


def test_article_extraction_can_read_beyond_search_excerpt():
    document = {'html':'<article>'+('正文。'*7000)+'文章末尾</article>'}
    text, _, _ = extract_article(document, max_chars=None)
    assert text.endswith('文章末尾')
    assert len(extract_article(document)[0]) == 18000


def test_link_import_uses_snapshot_and_rejects_login(monkeypatch):
    from learning import ingest
    monkeypatch.setattr(ingest, 'fetch_page', lambda *args, **kw: {'url':'https://example.com/doc', 'html':'<article>科学知识。'*20+'</article>', 'truncated':True})
    result = parse_link('https://example.com/doc', threading.Event())
    assert result['source']['locator']['url'] == 'https://example.com/doc'
    assert result['warnings']
    monkeypatch.setattr(ingest, 'fetch_page', lambda *args, **kw: {'title':'Sign in', 'html':'<title>Sign in</title><p>Please sign in to continue</p>'})
    with pytest.raises(LearningError):
        parse_link('https://example.com/doc', threading.Event())


def test_private_link_rejected_before_fetch():
    with pytest.raises(LearningError):
        parse_link('http://127.0.0.1/private', threading.Event())
