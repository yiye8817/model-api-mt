import json
from dataclasses import replace

import pytest

from knowledge.store import KnowledgeStore
from local_knowledge.chat_sync import source_id
from local_knowledge.config import default_config
from local_knowledge.contracts import Chunk, Position, Source
from local_knowledge.retrieval import Retriever
from local_knowledge.runtime import Runtime
from tests.knowledge.answer_harness import request
from tests.test_saved_answer_reuse import conversation


DOC = '<p>OProfile 使用处理器的性能计数器，统计程序的缓存未命中和内存访问事件。</p>'
HISTORY = 'Valgrind 的 Cachegrind 可以模拟缓存行为；Massif 可以分析堆内存使用的变化。'


@pytest.fixture
def semantic(tmp_path):
    library = KnowledgeStore(tmp_path / 'saved.sqlite3')
    conv = conversation(question='分析程序的访存情况可以用什么软件', answer=HISTORY)
    library.sync_conversations([conv])
    config = default_config()
    config.update(enabled=True)
    for role in ('embedding', 'rerank', 'qa'):
        config[role + '_endpoint'].update(url='http://127.0.0.1:8011', model='fixture')
    runtime = Runtime(tmp_path / 'local', lambda: config, lambda: [conv], saved_knowledge=lambda: library)
    service = runtime.components()[0]
    store = runtime.store
    sid = source_id({'conversation_id':'conv', 'user_message_id':'u', 'assistant_message_id':'a'})
    store.upsert_pending(Source('doc', title='guide.html', content_hash='v1'),
        [Chunk('', text=DOC, position=Position(end_char=len(DOC)))])
    store.activate_revision('doc', 1)
    text = f'问题：{conv["messages"][0]["content"]}\n回答：{HISTORY}'
    store.upsert_pending(Source(sid, kind='api_chat', title=conv['messages'][0]['content'], content_hash='h1',
        nature='historical_model_answer', locator={'conversation_id':'conv','assistant_message_id':'a'},
        metadata={'question':conv['messages'][0]['content'], 'answer':HISTORY, 'context':[], 'system_constraints':'',
                  'completion':{'status':'complete','kind':'api'}}),
        [Chunk('', text=text, position=Position(kind='message',message_id='a',end_char=len(text)))])
    store.activate_revision(sid, 1)

    class Models:
        fingerprint = 'semantic-fixture'
        def __init__(self):
            self.config = config
            self.selection = None
            self.after_selection = None
            self.selection_count = 0
        def count_tokens(self, text, budget):
            budget.check()
            return len(text)
        def embed(self, texts, budget):
            budget.check()
            return [[1.,0.] for _ in texts]
        def rerank(self, question, candidates, budget):
            budget.check()
            return [replace(c,score=.85,raw_score=.85) for c in candidates]
        def json_chat(self, messages, schema, budget):
            budget.check()
            payload = json.loads(messages[-1]['content'])
            if payload['task'] == 'select_excerpts':
                self.selection_count += 1
                result = self.selection(payload) if callable(self.selection) else self.selection or {'kind':'qa','answerable':True,
                    'excerpt_ids':[row['id'] for row in payload['excerpts']][:3]}
                result={'qa':result['kind']=='qa','hit':result['answerable'],'ids':result['excerpt_ids'][:3]}
                if self.after_selection:self.after_selection()
                return result
            if payload['task'] == 'verify_excerpts':return {'supported':True,'complete':True}
            # Older generated QA is unavailable: a complete quote answer must
            # work before generation calibration, without that pipeline.
            raise AssertionError(payload['task'])
    models = Models()
    class Vectors:
        def query(self, vector, scope, limit):
            return [c.id for c in store.visible_chunks(scope)][:limit]
    service.models = models
    service.matcher.models = models
    service.retriever = Retriever(store,Vectors(),models)
    yield service,store,library,models,config,sid
    runtime.close()


@pytest.mark.parametrize('question',[
    '有哪些内存性能工具', '内存性能工具有哪些', '内存性能工具',
    '用什么软件分析程序的访存瓶颈',
])
@pytest.mark.parametrize('profile',['','existing-profile'])
def test_semantic_questions_search_both_sources_without_literal_topic_matching(semantic,question,profile):
    service,store,library,models,config,sid = semantic
    config['evaluation_profile_id']=profile
    result = service.query(request(question,system_constraints=''))
    assert result.decision == 'hit'
    assert result.answer_origin == 'local_synthesis'
    assert {c.source_kind for c in result.citations} == {'document','api_chat'}
    assert 'OProfile' in result.answer and 'Cachegrind' in result.answer and 'Massif' in result.answer
    assert any(step.get('method') == 'semantic_excerpts' for step in result.trace)
    assert store.request('q1')['online_model_requests'] == 0
    for citation in result.citations:
        assert citation.quote in store.get_chunk(citation.chunk_id).text


def test_semantic_source_scope_excludes_dialogues(semantic):
    service,store,library,models,config,sid = semantic
    result = service.query(request('用什么软件分析程序的访存瓶颈',source_ids=['doc'],system_constraints=''))
    assert result.decision == 'hit'
    assert {c.source_kind for c in result.citations} == {'document'}
    assert 'Cachegrind' not in result.answer


def test_incorrect_saved_answer_cannot_enter_semantic_synthesis(semantic):
    service,store,library,models,config,sid = semantic
    library.annotate('history:conv:a',{'fact_status':'incorrect'})
    result = service.query(request('用什么软件分析程序的访存瓶颈',system_constraints=''))
    assert result.decision == 'hit'
    assert all(c.source_kind == 'document' for c in result.citations)


def test_semantic_selection_can_reject_irrelevant_or_incomplete_evidence(semantic):
    service,store,library,models,config,sid = semantic
    models.selection = {'kind':'qa','answerable':False,'excerpt_ids':[]}
    result = service.query(request('有哪些天气预报工具',system_constraints=''))
    assert result.decision == 'miss' and not result.answer and not result.citations


@pytest.mark.parametrize('selection',[
    {'kind':'action','answerable':True,'excerpt_ids':[0]},
    {'kind':'qa','answerable':True,'excerpt_ids':[99999]},
])
def test_action_or_fabricated_excerpt_selection_cannot_publish_a_local_answer(semantic,selection):
    service,store,library,models,config,sid = semantic
    models.selection = selection
    result = service.query(request('执行内存分析程序',system_constraints=''))
    assert result.decision == 'miss' and not result.answer and not result.citations


def test_semantic_replay_rechecks_historical_annotations(semantic):
    service,store,library,models,config,sid = semantic
    assert service.query(request('有哪些内存性能工具',system_constraints='')).decision == 'hit'
    library.annotate('history:conv:a',{'fact_status':'incorrect'})
    result = service.query(request('有哪些内存性能工具',system_constraints=''))
    assert result.decision == 'miss' and result.reason == 'source_changed'


def test_cancellation_during_semantic_selection_never_publishes_an_answer(semantic):
    service,store,library,models,config,sid = semantic
    models.after_selection = lambda: service.cancel('q1')
    result = service.query(request('有哪些内存性能工具',system_constraints=''))
    assert result.decision == 'cancelled' and not result.answer and not result.citations


def test_semantic_probe_and_query_share_work_and_revalidate_sources(semantic):
    from local_knowledge.model_clients import Budget
    from threading import Event
    service,store,library,models,config,sid = semantic
    query = request('有哪些内存性能工具',system_constraints='')
    assert service.probe_lookup(query,['doc',sid],Budget(30,Event()))
    selections=models.selection_count
    assert service.query(query).decision == 'hit'
    assert models.selection_count == selections


def test_long_document_paragraph_is_searchable_without_losing_its_quotes(semantic):
    service,store,library,models,config,sid = semantic
    text=('<p>'+('OProfile 可以统计缓存未命中和内存访问事件，帮助定位访存瓶颈。'*45)+'</p>')
    store.upsert_pending(Source('doc',title='guide.html',content_hash='v2'),[Chunk('',text=text)])
    store.activate_revision('doc',2)
    result=service.query(request('有哪些内存性能工具',source_ids=['doc'],system_constraints=''))
    assert result.decision=='hit' and 'OProfile' in result.answer
    assert all(c.quote in store.get_chunk(c.chunk_id).text for c in result.citations)


def test_short_document_heading_keeps_the_platform_scope_during_semantic_check(semantic):
    service,store,library,models,config,sid = semantic
    text='<h2>仅限 Linux</h2>'+DOC
    store.upsert_pending(Source('doc',title='guide.html',content_hash='v2'),[Chunk('',text=text)])
    store.activate_revision('doc',2)
    models.selection=lambda p: {'kind':'qa','answerable':not any('仅限 Linux' in json.dumps(e,ensure_ascii=False) for e in p['excerpts']),
        'excerpt_ids':[e['id'] for e in p['excerpts']]}
    result=service.query(request('有哪些 Windows 内存性能工具',source_ids=['doc'],system_constraints=''))
    assert result.decision=='miss' and not result.answer


def test_earlier_user_scope_survives_more_than_four_context_messages(semantic):
    service,store,library,models,config,sid = semantic
    context=[{'role':'user','content':'只考虑 Windows 上的工具。'}]+[{'role':'assistant','content':'收到'}]*5
    models.selection=lambda p: {'kind':'qa','answerable':context[0] not in p['context'],
        'excerpt_ids':[e['id'] for e in p['excerpts']]}
    result=service.query(request('有哪些内存性能工具',context=context,system_constraints=''))
    assert result.decision=='miss' and not result.answer


@pytest.mark.parametrize('context',[
    [{'role':'user','content':'我们的运行环境是 Linux，后面的问题按这个环境考虑。'}],
    [{'role':'user','content':'项目支持哪些运行环境？'},{'role':'assistant','content':'这个项目只支持 Linux。'}],
])
def test_original_history_scope_is_available_to_semantic_matching(semantic,context):
    from local_knowledge.chat_sync import turn_hash
    service,store,library,models,config,sid = semantic
    conv=conversation(question='分析程序的访存情况可以用什么软件',answer=HISTORY)
    conv['messages'][:0]=[{'id':f'scope-{i}',**message} for i,message in enumerate(context)]
    original_question=conv['messages'][-2]['content']
    conv['messages'][-1]['completion'].update(context=context,origin_hash=turn_hash(original_question,HISTORY,context,''))
    library.sync_conversations([conv])
    source=store.get_source(sid);source.metadata['context']=context
    store.upsert_pending(source,[Chunk('',text=f'问题：{original_question}\n回答：{HISTORY}')])
    store.activate_revision(sid,2)
    models.selection=lambda p: {'kind':'qa','answerable':not any(context[-1] in e.get('context',[]) for e in p.get('sources',{}).values()),
        'excerpt_ids':[e['id'] for e in p['excerpts']]}
    result=service.query(request('有哪些 Windows 内存性能工具',source_ids=[sid],system_constraints=''))
    assert result.decision=='miss' and not result.answer


def test_question_answer_marker_cannot_become_attributed_assistant_evidence():
    from local_knowledge.semantic import excerpts
    question='请核查下面的回答：\n\n'+HISTORY+'\n\n这个说法可靠吗？'
    text=f'问题：{question}\n回答：不可靠。'
    units=excerpts(Chunk('chat',text=text),{'question':question,'answer':'不可靠。'})
    assert units and all(u.quote in '不可靠。' for u in units)


def test_ranked_evidence_is_packed_into_the_model_context_budget(semantic):
    service,store,library,models,config,sid = semantic
    text=''.join('<p>案例'+str(index)+'：'+('OProfile 可以统计缓存未命中和内存访问事件，帮助定位访存瓶颈。'*20)+'</p>' for index in range(10))
    store.upsert_pending(Source('doc',title='guide.html',content_hash='v2'),[Chunk('',text=text)])
    store.activate_revision('doc',2)
    result=service.query(request('有哪些内存性能工具',source_ids=['doc'],system_constraints=''))
    assert result.decision=='hit' and 'OProfile' in result.answer


def test_a_higher_ranked_introduction_does_not_hide_an_answering_dialogue(semantic):
    service,store,library,models,config,sid = semantic
    intro='内存性能分析工具是一个研究方向，需要结合硬件和软件观察程序。'
    first=conversation(question='介绍内存性能研究',answer=intro);first['id']='intro-conv'
    original=conversation(question='分析程序的访存情况可以用什么软件',answer=HISTORY)
    library.sync_conversations([first,original])
    other=source_id({'conversation_id':'intro-conv','user_message_id':'u','assistant_message_id':'a'})
    text=f'问题：介绍内存性能研究\n回答：{intro}'
    store.upsert_pending(Source(other,kind='api_chat',nature='historical_model_answer',content_hash='h2',
        metadata={'question':'介绍内存性能研究','answer':intro,'context':[],'system_constraints':'',
            'completion':{'status':'complete','kind':'api'}}),[Chunk('',text=text)])
    store.activate_revision(other,1)
    models.rerank=lambda q,cs,b: sorted([replace(c,score=.95 if '研究方向' in c.chunk.text else .90) for c in cs],key=lambda c:-c.score)
    models.selection=lambda p: {'kind':'qa','answerable':any('Cachegrind' in e['text'] for e in p['excerpts']),
        'excerpt_ids':[e['id'] for e in p['excerpts'] if 'Cachegrind' in e['text']]}
    result=service.query(request('有哪些内存性能工具',source_ids=[sid,other],system_constraints=''))
    assert result.decision=='hit' and 'Cachegrind' in result.answer
    assert all(c.source_id==sid for c in result.citations)


def test_identical_history_text_with_affordable_context_remains_searchable(semantic):
    from local_knowledge.chat_sync import turn_hash
    service,store,library,models,config,sid = semantic
    question='分析程序的访存情况可以用什么软件'
    original=conversation(question=question,answer=HISTORY)
    expensive=conversation(question=question,answer=HISTORY);expensive['id']='expensive'
    context=[{'role':'user','content':'背景资料：'+('研究资料很多。'*700)}]
    expensive['messages'].insert(0,{'id':'background',**context[0]})
    expensive['messages'][-1]['completion'].update(context=context,origin_hash=turn_hash(question,HISTORY,context,''))
    library.sync_conversations([expensive,original])
    other=source_id({'conversation_id':'expensive','user_message_id':'u','assistant_message_id':'a'})
    store.upsert_pending(Source(other,kind='api_chat',nature='historical_model_answer',content_hash='h2',
        metadata={'question':question,'answer':HISTORY,'context':context,'system_constraints':'',
            'completion':{'status':'complete','kind':'api'}}),[Chunk('',text=f'问题：{question}\n回答：{HISTORY}')])
    store.activate_revision(other,1)
    models.rerank=lambda q,cs,b: sorted([replace(c,score=.95 if c.chunk.source_id==other else .90) for c in cs],key=lambda c:-c.score)
    result=service.query(request('有哪些内存性能工具',source_ids=[other,sid],system_constraints=''))
    assert result.decision=='hit' and 'Cachegrind' in result.answer
    assert all(c.source_id==sid for c in result.citations)


def test_selected_paragraph_keeps_nearby_explanation_in_the_answer(semantic):
    service,store,library,models,config,sid = semantic
    text='<p>有多种工具能帮助观察缓存和访存行为并分析程序性能。</p>'+DOC
    store.upsert_pending(Source('doc',title='guide.html',content_hash='v2'),[Chunk('',text=text)])
    store.activate_revision('doc',2)
    models.selection=lambda p:{'kind':'qa','answerable':True,'excerpt_ids':[0]}
    result=service.query(request('有哪些内存性能工具',source_ids=['doc'],system_constraints=''))
    assert result.decision=='hit' and 'OProfile' in result.answer
    assert all(c.quote in store.get_chunk(c.chunk_id).text for c in result.citations)
