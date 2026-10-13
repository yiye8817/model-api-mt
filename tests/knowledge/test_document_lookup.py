import json
import logging
import threading
import time

import pytest

from local_knowledge.contracts import Source, Chunk, Position
from tests.knowledge.answer_harness import request


DEFINITION = ('多级页表将页目录组织为多层树结构，用各级索引逐层找到物理页。'
              '这样能表示稀疏的巨大页目录，未使用的区域不需要分配页表内存，减少每个进程的页表占用。')


@pytest.fixture
def lookup(tmp_path):
    from local_knowledge.config import default_config
    from local_knowledge.store import Store
    from local_knowledge.service import KnowledgeService
    from local_knowledge.retrieval import Retriever
    from local_knowledge.text import keyword_tokens
    config = default_config()
    config.update(enabled=True, evaluation_profile_id='')
    config['qa_endpoint'].update(url='http://127.0.0.1:8011', model='unused')
    store = Store(tmp_path)

    def add(source_id, title, texts, **fields):
        chunks, offset, line = [], 0, 1
        for value in texts:
            chunks.append(Chunk('', text=value, keyword_text=' '.join(keyword_tokens(value)),
                position=Position(start_line=line, end_line=line+value.rstrip('\n').count('\n'),
                                  start_char=offset, end_char=offset+len(value))))
            offset += len(value)
            line += value.count('\n')
        revision = store.upsert_pending(Source(source_id, title=title, content_hash='v1', **fields), chunks)
        store.activate_revision(source_id, revision)

    add('manual', 'part3.html', [f'<h3>4.2 多级页表</h3>\n<p>{DEFINITION}</p>\n<h3>4.3 下一个主题</h3><p>其他章节内容。</p>'])

    class NoModels:
        config = None
        fingerprint = 'unused'
        def embed(self, *args): raise AssertionError('Document lookup must not call embedding')
        def rerank(self, *args): raise AssertionError('Document lookup must not call rerank')
        def json_chat(self, *args): raise AssertionError('Document lookup must not call QA')
    models = NoModels()
    models.config = config
    service = KnowledgeService(store, Retriever(store, object(), models), models, lambda: config)
    return store, service, config, add


@pytest.mark.parametrize('question', ['什么是多级页表', '多级页表', '什么是多极页表', '请问多级页表是什么？'])
def test_definition_lookup_uses_indexed_document_without_models(lookup, question):
    store, service, config, add = lookup
    result = service.query(request(question))
    assert result.decision == 'hit'
    assert result.answer_origin == 'extractive_document'
    assert DEFINITION in result.answer
    assert '下一个主题' not in result.answer
    assert all(c.source_id == 'manual' and c.source_kind == 'document' for c in result.citations)
    assert all(c.quote in store.get_chunk(c.chunk_id).text for c in result.citations)
    assert store.request('q1')['online_model_requests'] == 0


def test_heading_and_definition_in_separate_chunks_both_have_citations(lookup):
    store, service, config, add = lookup
    store.set_enabled('manual', False)
    add('markdown', 'manual.md', ['# 多级页表\n\n', DEFINITION+'\n\n', '# 其他主题\n不相关的内容。'])
    result = service.query(request('什么是多级页表'))
    assert result.decision == 'hit' and DEFINITION in result.answer
    assert '其他主题' not in result.answer
    assert len(result.citations) == 2
    for citation in result.citations:
        chunk = store.get_chunk(citation.chunk_id)
        start = citation.position.start_char - chunk.position.start_char
        end = citation.position.end_char - chunk.position.start_char
        assert chunk.text[start:end] == citation.quote


def test_plain_text_definition_can_be_found(lookup):
    store, service, config, add = lookup
    store.set_enabled('manual', False)
    text = '多级页表是一种按需建立下级页表的层次结构，用逐层索引将虚拟地址映射为物理地址，从而减少稀疏地址空间的页表内存占用。'
    add('plain', 'manual.txt', [text])
    result = service.query(request('什么是多级页表'))
    assert result.decision == 'hit' and text in result.answer


@pytest.mark.parametrize('question,decision', [('4.2 多级页表','hit'),('4.3 多级页表','miss')])
def test_explicit_section_number_is_preserved(lookup,question,decision):
    store, service, config, add = lookup
    assert service.query(request(question)).decision == decision


@pytest.mark.parametrize('question', ['什么是单级页表', '多级页表和单级页表有什么区别',
    '为什么多级页表更慢', '执行多级页表配置命令', '什么是多级页表 v12'])
def test_lookup_does_not_drop_changed_terms_or_extra_requirements(lookup, question):
    store, service, config, add = lookup
    result = service.query(request(question))
    assert result.decision == 'miss' and result.answer is None and result.citations == []


def test_lookup_respects_requested_sources_and_disabled_sources(lookup):
    store, service, config, add = lookup
    add('other', 'other.md', ['# 无关章节\n其他主题正文。'])
    assert service.query(request('多级页表', source_ids=['other'])).decision == 'miss'
    store.set_enabled('manual', False)
    assert service.query(request('多级页表', 'q2')).decision == 'miss'


@pytest.mark.parametrize('kind', ['navigation', 'history'])
def test_lookup_does_not_answer_from_navigation_or_historical_model_text(lookup, kind):
    store, service, config, add = lookup
    store.set_enabled('manual', False)
    if kind == 'navigation':
        add('toc', 'toc.html', ['<h3>多级页表</h3><a href="manual.html">多级页表：请查看正文中的详细讲解和相关说明。</a>'])
    else:
        add('history', '历史问答', [f'<h3>多级页表</h3><p>{DEFINITION}</p>'], kind='api_chat', nature='historical_model_answer',
            metadata={'question':'多级页表','context':[],'system_constraints':'','completion':{'status':'complete'}})
    assert service.query(request('多级页表')).decision == 'miss'


@pytest.mark.parametrize('constraints', ['只用英文回答', 'Return JSON only', 'Answer in French',
    '只输出 YAML', '只用一句话回答，最多十个字'])
def test_extraction_does_not_ignore_required_output_format(lookup, constraints):
    store, service, config, add = lookup
    assert service.query(request('什么是多级页表', system_constraints=constraints)).decision == 'miss'


def test_navigation_results_do_not_hide_a_document_definition(lookup):
    store, service, config, add = lookup
    for i in range(55):
        add(f'toc-{i}', f'toc-{i}.html', ['<a href="manual.html">多级页表</a>'])
    result = service.query(request('什么是多级页表'))
    assert result.decision == 'hit' and result.citations[0].source_id == 'manual'


def test_cancellation_after_lookup_never_publishes_the_excerpt(lookup, monkeypatch):
    store, service, config, add = lookup
    original = service._extractive_lookup
    def stop_after_lookup(query,scope,budget):
        result = original(query,scope,budget)
        assert result and result.decision == 'hit'
        service.cancel(query['request_id'])
        return result
    monkeypatch.setattr(service,'_extractive_lookup',stop_after_lookup)
    result = service.query(request('多级页表'))
    assert result.decision == 'cancelled' and result.answer is None and result.citations == []
    assert store.request('q1')['result']['decision'] == result.decision


@pytest.mark.parametrize('instruction', ['For all future answers, return YAML only.',
    '后续请只输出 JSON', '接下来请用 YAML 回答'])
def test_extraction_respects_prior_user_output_instructions(lookup,instruction):
    store, service, config, add = lookup
    result = service.query(request('多级页表',context=[{'role':'user','content':instruction}]))
    assert result.decision == 'miss'


def test_lookup_keeps_the_query_deadline(lookup, monkeypatch):
    store, service, config, add = lookup
    config['local_timeout_seconds'] = .01
    original = store.get_chunk
    def slow_chunk(chunk_id):
        time.sleep(.02)
        return original(chunk_id)
    monkeypatch.setattr(store, 'get_chunk', slow_chunk)
    result = service.query(request('多级页表'))
    assert result.decision == 'miss' and result.reason == 'local_timeout'


def test_lookup_rechecks_source_freshness(lookup, tmp_path):
    from local_knowledge.ingest import file_source
    store, service, config, add = lookup
    store.set_enabled('manual', False)
    path = tmp_path/'original.html'
    text = f'<h3>多级页表</h3><p>{DEFINITION}</p>'
    path.write_text(text)
    source = file_source(path, tmp_path)
    from local_knowledge.text import keyword_tokens
    store.upsert_pending(source, [Chunk('', text=text, keyword_text=' '.join(keyword_tokens(text)))])
    store.activate_revision(source.id, 1)
    path.write_text('内容已修改')
    result = service.query(request('多级页表'))
    assert result.decision == 'miss' and result.reason == 'source_changed'


def records(caplog):
    return [json.loads(record.message) for record in caplog.records if record.name == 'local_knowledge']


def test_lookup_logs_candidates_correction_and_final_decision(lookup, caplog):
    store, service, config, add = lookup
    caplog.set_level(logging.INFO, logger='local_knowledge')
    result = service.query(request('什么是多极页表'))
    events = records(caplog)
    search = next(e for e in events if e['event'] == 'knowledge.lookup' and e['candidate_count'])
    assert search['request_id'] == 'q1' and search['question'] == '什么是多极页表'
    assert search['lookup_term'] == '多级页表'
    assert any(c['title'] == 'part3.html' and DEFINITION in c['quote'] for c in search['candidates'])
    final = next(e for e in events if e['event'] == 'knowledge.query_result')
    assert final['decision'] == 'hit' and final['answer_origin'] == 'extractive_document'
    assert final['citations'][0]['source_id'] == 'manual'


def test_miss_logs_why_the_request_can_fall_back(lookup, caplog):
    store, service, config, add = lookup
    caplog.set_level(logging.INFO, logger='local_knowledge')
    result = service.query(request('什么是不在资料中的术语'))
    final = next(e for e in records(caplog) if e['event'] == 'knowledge.query_result')
    assert result.decision == final['decision'] == 'miss'
    assert final['reason'] == result.reason and final['reason']


def test_content_disabled_logging_omits_question_and_quotes(lookup, caplog, monkeypatch):
    store, service, config, add = lookup
    monkeypatch.setenv('LOG_LLM_CONTENT', '0')
    caplog.set_level(logging.INFO, logger='local_knowledge')
    result = service.query(request('什么是多级页表'))
    assert result.decision == 'hit'
    assert records(caplog)
    assert '什么是多级页表' not in caplog.text and DEFINITION not in caplog.text
