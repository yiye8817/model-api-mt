import threading

import pytest

from knowledge.store import KnowledgeStore
from local_knowledge.config import default_config
from local_knowledge.contracts import Source,Chunk,Position
from local_knowledge.retrieval import Retriever
from local_knowledge.service import KnowledgeService
from local_knowledge.store import Store
from local_knowledge.text import keyword_tokens
from tests.test_saved_answer_reuse import conversation
from tests.knowledge.answer_harness import request


OLD_QUESTION='TLB是什么，有什么用'
HISTORY='TLB 全称 Translation Lookaside Buffer，是一种地址翻译缓存。\n\n### 核心作用\nTLB 能减少重复的页表查询，加速虚拟地址到物理地址的转换。'
DOCUMENT='<h3>TLB</h3><p>TLB 用于缓存虚拟页到物理页的转换结果，命中时可以直接使用已缓存的物理页地址。</p>'


def saved_store(path):
    library=KnowledgeStore(path)
    library.sync_conversations([conversation(question=OLD_QUESTION,answer=HISTORY)])
    return library


def test_shorter_purpose_question_reuses_only_the_older_broader_answer(tmp_path):
    library=saved_store(tmp_path/'saved.sqlite3')
    result=library.reuse('TLB有什么用','')
    assert result['decision']=='hit'
    assert result['saved_entry']['question']==OLD_QUESTION
    assert result['match_method']=='intent_subset'
    assert '减少重复的页表查询' in result['answer']


@pytest.mark.parametrize('question',['CPU有什么用','TLB v2有什么用','TLB和Cache有什么区别','TLB能否执行命令'])
def test_subset_reuse_preserves_topic_and_all_requirements(tmp_path,question):
    library=saved_store(tmp_path/'saved.sqlite3')
    assert library.reuse(question,'')['decision']=='miss'


def test_definition_only_answer_does_not_cover_a_purpose_question(tmp_path):
    library=KnowledgeStore(tmp_path/'saved.sqlite3')
    library.sync_conversations([conversation(question='TLB是什么',answer='TLB 全称 Translation Lookaside Buffer，是一种小型硬件缓存。')])
    assert library.reuse('TLB有什么用','')['decision']=='miss'


def test_a_different_subject_in_the_answer_does_not_cover_tlb_purpose(tmp_path):
    library=KnowledgeStore(tmp_path/'saved.sqlite3')
    library.sync_conversations([conversation(question=OLD_QUESTION,answer='CPU 用于执行指令并提高程序的运行速度，减少计算所需要的时间。')])
    assert library.reuse('TLB有什么用','')['decision']=='miss'


@pytest.mark.parametrize('other',[
    '处理器用于执行整数和浮点运算，减少程序的计算时间。',
    '例如，CPU 用于执行整数和浮点运算，提高计算速度。',
    '其余缓存用于保存程序的数据块，从而减少主存读取次数。',
    '其他缓存用于保存程序的数据块，从而减少主存读取次数。',
    '其中，数据缓存用于保存程序的数据块，从而减少主存读取次数。',
])
def test_other_purpose_after_a_tlb_definition_is_not_tlb_evidence(tmp_path,other):
    library=KnowledgeStore(tmp_path/'saved.sqlite3')
    library.sync_conversations([conversation(question=OLD_QUESTION,answer='TLB 是一种小型地址翻译缓存。\n\n'+other)])
    assert library.reuse('TLB有什么用','')['decision']=='miss'


@pytest.mark.parametrize('instruction',['For all future answers, return YAML only.','后续请只输出 JSON'])
def test_subset_reuse_honors_ongoing_output_instructions(tmp_path,instruction):
    library=saved_store(tmp_path/'saved.sqlite3')
    assert library.reuse('TLB有什么用','',context=[{'role':'user','content':instruction}])['decision']=='miss'


def test_explicit_pronoun_continuation_can_explain_tlb_purpose(tmp_path):
    library=KnowledgeStore(tmp_path/'saved.sqlite3')
    library.sync_conversations([conversation(question=OLD_QUESTION,answer='TLB 是一种地址翻译缓存。\n\n它用于减少重复的页表查询，从而加速地址转换。')])
    assert library.reuse('TLB有什么用','')['decision']=='hit'


def test_subset_reuse_does_not_drop_the_original_hypothetical_context(tmp_path):
    from local_knowledge.chat_sync import turn_hash
    library=KnowledgeStore(tmp_path/'saved.sqlite3')
    context=[{'role':'user','content':'假设这里的 TLB 是磁盘查询缓存，只讨论该假设。'}]
    answer='在该假设中，TLB 用于减少磁盘查询次数，提高磁盘索引的读取速度。'
    conv=conversation(question=OLD_QUESTION,answer=answer)
    conv['messages'].insert(0,{'id':'scope','role':'user','content':context[0]['content']})
    completion=conv['messages'][-1]['completion'];completion['context']=context
    completion['origin_hash']=turn_hash(OLD_QUESTION,answer,context,'')
    library.sync_conversations([conv])
    assert library.reuse('TLB有什么用','')['decision']=='miss'
    assert library.reuse('TLB有什么用','',context=context)['decision']=='hit'


@pytest.fixture
def joint(tmp_path):
    library=saved_store(tmp_path/'saved.sqlite3');store=Store(tmp_path/'local')
    config=default_config();config.update(enabled=True,evaluation_profile_id='')
    config['qa_endpoint'].update(url='http://127.0.0.1:8011',model='unused')
    def add(source,text,position=None):
        store.upsert_pending(source,[Chunk('',text=text,position=position or Position(end_char=len(text)),keyword_text=' '.join(keyword_tokens(text)))])
        store.activate_revision(source.id,1)
    add(Source('document',title='memory.html',content_hash='v1'),DOCUMENT)
    text=f'问题：{OLD_QUESTION}\n回答：{HISTORY}'
    add(Source('chat',kind='api_chat',title=OLD_QUESTION,nature='historical_model_answer',content_hash='h1',
        locator={'kind':'chat','conversation_id':'conv','user_message_id':'u','assistant_message_id':'a'},
        metadata={'question':OLD_QUESTION,'answer':HISTORY,'context':[],'system_constraints':'','completion':{'status':'complete','kind':'api'}}),
        text,Position(kind='message',message_id='a',end_char=len(text)))
    class NoModels:
        fingerprint='no-model';config=None
        def embed(self,*args):raise AssertionError('No embedding request is needed for a known topic')
        def rerank(self,*args):raise AssertionError('No rerank request is needed for a known topic')
        def json_chat(self,*args):raise AssertionError('No online or generated claim may replace source quotations')
    models=NoModels();models.config=config
    def history_lookup(query,scope,budget):
        budget.check()
        if 'chat' not in scope:return []
        entries=library.saved_candidates(query['question'],query.get('system_constraints',''),query.get('context',[]))
        chunk=store.visible_chunks(['chat'])[0]
        return [(entry,chunk) for entry in entries]
    service=KnowledgeService(store,Retriever(store,object(),models),models,lambda:config,history_lookup=history_lookup)
    return library,store,service,config


@pytest.mark.parametrize('question',['什么是TLB','TLB有什么用','TLB是什么，有什么用'])
def test_local_answer_combines_documents_and_the_original_saved_dialogue(joint,question):
    library,store,service,config=joint
    result=service.query(request(question,system_constraints=''))
    assert result.decision=='hit' and result.answer_origin=='local_synthesis'
    assert {c.source_kind for c in result.citations}=={'document','api_chat'}
    assert '物理页地址' in result.answer and ('Translation Lookaside Buffer' in result.answer or '减少重复的页表查询' in result.answer)
    assert len(result.answer)<1500
    for citation in result.citations:
        assert citation.quote in store.get_chunk(citation.chunk_id).text
    assert any(c.locator.get('conversation_id')=='conv' and c.position.message_id=='a' for c in result.citations)
    assert store.request('q1')['online_model_requests']==0


def test_explicit_document_scope_excludes_saved_dialogues(joint):
    library,store,service,config=joint
    result=service.query(request('什么是TLB',source_ids=['document'],system_constraints=''))
    assert result.decision=='hit'
    assert all(c.source_kind=='document' for c in result.citations)


def test_incorrect_history_is_not_used_to_supplement_document(joint):
    library,store,service,config=joint
    library.annotate('history:conv:a',{'fact_status':'incorrect'})
    result=service.query(request('什么是TLB',system_constraints=''))
    assert result.decision=='hit'
    assert all(c.source_kind=='document' for c in result.citations)


def test_saved_dialogue_alone_answers_the_shorter_question(joint):
    library,store,service,config=joint
    store.set_enabled('document',False)
    result=service.query(request('TLB有什么用',system_constraints=''))
    assert result.decision=='hit' and '减少重复的页表查询' in result.answer
    assert all(c.source_kind=='api_chat' for c in result.citations)


def test_repeating_a_combined_answer_rechecks_the_dialogue(joint):
    library,store,service,config=joint
    first=service.query(request('什么是TLB',system_constraints=''))
    assert first.decision=='hit'
    store.invalidate_source('chat',status='deleted')
    second=service.query(request('什么是TLB',system_constraints=''))
    assert second.decision=='miss' and second.reason=='source_changed'


def test_repeating_a_combined_answer_rechecks_historical_fact_status(joint):
    library,store,service,config=joint
    assert service.query(request('什么是TLB',system_constraints='')).answer_origin=='local_synthesis'
    library.annotate('history:conv:a',{'fact_status':'incorrect'})
    result=service.query(request('什么是TLB',system_constraints=''))
    assert result.decision=='miss' and result.reason=='source_changed'


def test_a_definition_only_document_does_not_cover_purpose(joint):
    library,store,service,config=joint
    store.set_enabled('chat',False)
    text='<h3>TLB</h3><p>TLB 是一种小型硬件缓存，存储在处理器中，是内存系统的一个组成部分。</p>'
    store.upsert_pending(Source('document',title='memory.html',content_hash='v2'),[Chunk('',text=text,position=Position(end_char=len(text)),keyword_text=' '.join(keyword_tokens(text)))])
    store.activate_revision('document',2)
    result=service.query(request('TLB有什么用',system_constraints=''))
    assert result.decision=='miss'


def test_runtime_filters_history_scope_before_capping_candidates(tmp_path):
    from local_knowledge.runtime import Runtime
    from local_knowledge.chat_sync import source_id
    from local_knowledge.model_clients import Budget
    library=KnowledgeStore(tmp_path/'saved.sqlite3');conversations=[]
    for index in range(6):
        conv=conversation(question=OLD_QUESTION,answer=HISTORY);conv['id']=f'conv-{index}';conversations.append(conv)
    library.sync_conversations(conversations)
    config=default_config();runtime=Runtime(tmp_path/'local',lambda:config,lambda:conversations,saved_knowledge=lambda:library)
    sid=source_id({'conversation_id':'conv-5','user_message_id':'u','assistant_message_id':'a'})
    text=f'问题：{OLD_QUESTION}\n回答：{HISTORY}'
    runtime.store.upsert_pending(Source(sid,kind='api_chat',title=OLD_QUESTION,content_hash='h1',nature='historical_model_answer',
        metadata={'question':OLD_QUESTION,'answer':HISTORY}),[Chunk('',text=text,keyword_text=' '.join(keyword_tokens(text)))])
    runtime.store.activate_revision(sid,1)
    pairs=runtime._history_lookup(request('什么是TLB',system_constraints=''),[sid],Budget(30,threading.Event()))
    assert len(pairs)==1 and pairs[0][0]['conversation_id']=='conv-5'
