import copy
import time

import pytest


def setup_sync(tmp_path):
    from local_knowledge.store import Store
    from local_knowledge.ingest import ImportManager
    from local_knowledge.chat_sync import ChatSynchronizer,turn_hash
    store=Store(tmp_path); imports=ImportManager(store,lambda sid,rev,b:store.activate_revision(sid,rev))
    turn={'conversation_id':'conv','user_message_id':'user','assistant_message_id':'answer','question':'A 保修期？','answer':'A 保修三年。',
        'context':[],'system_constraints':'中文','provider_id':'provider','model':'model','completion':{'status':'complete','kind':'api','request_id':'r','finished_at':time.time()*1000,'effective_constraints':'中文'}}
    turn['completion']['origin_hash']=turn_hash(turn['question'],turn['answer'],turn['context'],turn['system_constraints'])
    conversations=[{'id':'conv','providerId':'provider','model':'model','messages':[
        {'id':'user','role':'user','content':turn['question']},
        {'id':'answer','role':'assistant','content':turn['answer'],'completion':copy.deepcopy(turn['completion'])}]}]
    return store,imports,ChatSynchronizer(store,imports),turn,conversations


def finish_queue(imports): imports.jobs.queue.join()


def test_double_record_same_messages_one_source(tmp_path):
    store,imports,sync,turn,state=setup_sync(tmp_path)
    try:
        first=sync.record(turn); second=sync.record(turn)
        assert first==second
        assert store.visible_chunks()==[]
        sync.sync_snapshot(state); finish_queue(imports)
        assert len(store.list_sources())==1 and len(store.visible_chunks())==1
        sync.sync_snapshot(state); finish_queue(imports)
        assert store.get_source(first).revision==1
    finally: imports.close()


def test_edit_and_delete_invalidate_before_index_queue(tmp_path):
    store,imports,sync,turn,state=setup_sync(tmp_path)
    try:
        sid=sync.record(turn);sync.sync_snapshot(state);finish_queue(imports)
        assert store.dependencies_current({sid:1})
        state[0]['messages'][1]['content']='编辑后的回答'
        sync.sync_snapshot(state)
        assert not store.dependencies_current({sid:1})
        sync.sync_snapshot([])
        assert store.get_source(sid).status=='deleted'
    finally: imports.close()


def test_edit_question_keeps_old_answer_reference_only(tmp_path):
    store,imports,sync,turn,state=setup_sync(tmp_path)
    try:
        sid=sync.record(turn);sync.sync_snapshot(state);finish_queue(imports)
        state[0]['messages'][0]['content']='B 保修期？'
        sync.sync_snapshot(state);finish_queue(imports)
        assert not store.dependencies_current({sid:1})
        assert store.get_source(sid).context_complete is False
    finally: imports.close()


@pytest.mark.parametrize('status',['stopped','partial','error','unknown'])
def test_stopped_partial_error_unknown_not_answerable(tmp_path,status):
    store,imports,sync,turn,state=setup_sync(tmp_path)
    try:
        turn['completion']['status']=status;state[0]['messages'][1]['completion']['status']=status
        sync.record(turn);sync.sync_snapshot(state);finish_queue(imports)
        assert store.visible_chunks()==[]
    finally: imports.close()


def test_saved_state_crash_reconciled_on_startup(tmp_path):
    store,imports,sync,turn,state=setup_sync(tmp_path)
    try:
        sync.sync_snapshot(state);finish_queue(imports)
        assert len(store.visible_chunks())==1
    finally: imports.close()


def test_local_answer_not_collected_as_independent_authority(tmp_path):
    store,imports,sync,turn,state=setup_sync(tmp_path)
    try:
        state[0]['messages'][1]['completion']['kind']='local'
        sync.sync_snapshot(state);finish_queue(imports)
        assert store.list_sources()==[]
    finally: imports.close()


def test_record_cannot_resurrect_deleted_turn(tmp_path):
    store,imports,sync,turn,state=setup_sync(tmp_path)
    try:
        sid=sync.record(turn);sync.sync_snapshot(state);finish_queue(imports)
        sync.sync_snapshot([])
        sync.record(turn);sync.sync_snapshot([]);finish_queue(imports)
        assert store.get_source(sid).status=='deleted' and store.visible_chunks()==[]
    finally: imports.close()


def test_import_selected_conversation_does_not_delete_other_sources(tmp_path):
    store,imports,sync,turn,state=setup_sync(tmp_path)
    try:
        sid=sync.record(turn);sync.sync_snapshot(state);finish_queue(imports)
        other=copy.deepcopy(state[0]);other['id']='other';other['messages'][0]['id']='u2';other['messages'][1]['id']='a2'
        sync.sync_snapshot(state+[other],collect=True,force=True,conversation_ids=['other']);finish_queue(imports)
        assert store.get_source(sid).status=='indexed'
    finally: imports.close()


def test_pending_chat_index_restored_after_crash(tmp_path):
    store,imports,sync,turn,state=setup_sync(tmp_path)
    try:
        sid=sync.record(turn);sync.sync_snapshot(state);finish_queue(imports)
        with store.connection as conn:
            conn.execute("UPDATE sources SET status='pending' WHERE id=?",(sid,))
            conn.execute("UPDATE chunks SET status='pending' WHERE source_id=?",(sid,))
        job=store.create_job('chat_index',{'source_id':sid,'revision':1})
        imports.recover();finish_queue(imports)
        assert store.job(job)['status']=='done'
        assert store.get_source(sid).status=='indexed'
    finally: imports.close()
