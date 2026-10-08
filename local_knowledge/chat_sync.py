"""Collect only durable, provenance-matching completed text turns."""
import json
import threading
from dataclasses import asdict

from .config import stable_hash
from .contracts import Source, Chunk, Position
from .store import dumps
from .model_clients import Budget
from .text import keyword_tokens


def turn_hash(question,answer,context,system_constraints):
    return stable_hash({'question':question,'answer':answer,'context':context,'system_constraints':system_constraints})


def source_id(turn):
    return stable_hash([turn.get('source_kind','api_chat'),turn['conversation_id'],turn['user_message_id'],turn['assistant_message_id'],turn.get('locator',{}).get('tab_id','')])


class ChatSynchronizer:
    def __init__(self,store,imports):
        self.store=store; self.imports=imports; self._lock=threading.RLock(); self._snapshot=[]

    def record(self,turn):
        required=('conversation_id','user_message_id','assistant_message_id','question','answer','context','system_constraints','completion')
        if not isinstance(turn,dict) or any(k not in turn for k in required): raise ValueError('Completed turn is missing required fields')
        if any(not isinstance(turn[k],str) or not turn[k] for k in required[:5]) or not isinstance(turn['context'],list) or not isinstance(turn['completion'],dict):
            raise ValueError('Invalid completed turn')
        if turn.get('source_kind','api_chat') not in ('api_chat','web_chat','web_synthesis'): raise ValueError('Invalid chat source kind')
        sid=source_id(turn)
        # Keep credentials and unrelated fields out of the records, even on a hostile POST.
        allowed={k:turn[k] for k in required}
        allowed.update({k:turn[k] for k in ('provider_id','model','source_kind','locator','context_complete','candidate_ids') if k in turn})
        if any(k in allowed.get('locator',{}) for k in ('copy_path','apiKey','api_key','token')): raise ValueError('Invalid chat locator')
        with self.store.connection as conn:
            conn.execute('INSERT OR REPLACE INTO qa_records VALUES(?,?,?)',(sid,sid,dumps(allowed)))
        return sid

    def _turn_from_messages(self,conversation,user,assistant,context):
        completion=dict(assistant.get('completion') or {'status':'unknown','kind':'api'})
        if completion.get('kind') not in ('api',None): return None
        return dict(conversation_id=conversation['id'],user_message_id=user['id'],assistant_message_id=assistant['id'],
            question=user.get('content',''),answer=assistant.get('content',''),context=context,
            system_constraints=completion.get('effective_constraints',''),completion=completion,
            provider_id=assistant.get('providerId',conversation.get('providerId','')),model=assistant.get('model',conversation.get('model','')),source_kind='api_chat')

    def sync_snapshot(self,conversations,collect=True,force=False,conversation_ids=None):
        with self._lock:
            self._snapshot=conversations; message_map={}; pairs=[]
            for conversation in conversations:
                if not isinstance(conversation,dict) or not conversation.get('id'): continue
                messages=conversation.get('messages',[]); user=None; prior=[]; before_user=[]
                for message in messages:
                    if not isinstance(message,dict) or not message.get('id'): continue
                    message_map[(conversation['id'],message['id'])]=message
                    if message.get('role')=='user': user=message;before_user=list(prior)
                    elif message.get('role')=='assistant' and user:
                        turn=self._turn_from_messages(conversation,user,message,before_user)
                        if turn and turn['question'] and turn['answer']: pairs.append(turn)
                    if message.get('role') in ('user','assistant','system') and isinstance(message.get('content'),str):
                        prior.append({'role':message['role'],'content':message['content']})
            existing=self.store.list_sources(include_deleted=True)
            for source in existing:
                if source.kind not in ('api_chat','web_chat','web_synthesis'): continue
                locator=source.locator
                if locator.get('kind')=='web' and not locator.get('conversation_id'): continue
                if (locator.get('conversation_id'),locator.get('user_message_id')) not in message_map or (locator.get('conversation_id'),locator.get('assistant_message_id')) not in message_map:
                    self.store.invalidate_source(source.id)
            persisted={r['id']:json.loads(r['body']) for r in self.store.connection.execute('SELECT id,body FROM qa_records')}
            for turn in pairs:
                sid=source_id(turn)
                collect_turn=collect and (not conversation_ids or turn['conversation_id'] in conversation_ids)
                if collect_turn or sid in persisted or self.store.get_source(sid):
                    persisted[sid]=turn
                    with self.store.connection as conn: conn.execute('INSERT OR REPLACE INTO qa_records VALUES(?,?,?)',(sid,sid,dumps(turn)))
            for sid,turn in persisted.items():
                source=self.store.get_source(sid)
                force_turn=force and (not conversation_ids or turn['conversation_id'] in conversation_ids)
                if source and source.status=='deleted' and not force_turn: continue
                user=message_map.get((turn['conversation_id'],turn['user_message_id']))
                assistant=message_map.get((turn['conversation_id'],turn['assistant_message_id']))
                if not user or not assistant: continue
                if user.get('content')!=turn['question']: continue
                kind=turn.get('source_kind','api_chat')
                if kind=='web_chat':
                    web=assistant.get('webChat',{})
                    if web.get('status')=='stopped': continue
                    candidate=next((a for a in web.get('answers',[]) if a.get('tabId')==turn.get('locator',{}).get('tab_id')),None)
                    if not candidate or candidate.get('content')!=turn['answer'] or candidate.get('partial') or candidate.get('status')!='done' or not candidate.get('validation',{}).get('complete'): continue
                elif assistant.get('content')!=turn['answer']: continue
                self._publish(sid,turn,force_turn)

    def _publish(self,sid,turn,force):
        completion=turn['completion']; digest=turn_hash(turn['question'],turn['answer'],turn['context'],turn['system_constraints'])
        eligible=completion.get('status')=='complete' and completion.get('kind') in ('api','web') and completion.get('origin_hash')==digest
        eligible=eligible and turn.get('context_complete',True)
        content_hash=stable_hash({'turn':digest,'model':turn.get('model',''),'eligible':eligible})
        old=self.store.get_source(sid)
        if old and old.content_hash==content_hash and old.status not in ('deleted','stale'):
            if old.status!='pending' or any(j['payload'].get('source_id')==sid and j['payload'].get('revision')==old.revision for j in self.store.unfinished_jobs()): return
        locator=dict(turn.get('locator',{}))
        locator.update(conversation_id=turn['conversation_id'],user_message_id=turn['user_message_id'],assistant_message_id=turn['assistant_message_id'])
        locator.setdefault('kind','chat')
        source=Source(sid,kind=turn.get('source_kind','api_chat'),title=turn['question'][:100],locator=locator,content_hash=content_hash,
            context_complete=bool(eligible),nature='historical_model_answer',completed_at=completion.get('finished_at',0)/1000,
            metadata={'question':turn['question'],'answer':turn['answer'],'context':turn['context'],'system_constraints':turn['system_constraints'],
                      'model':turn.get('model','unknown'),'provider_id':turn.get('provider_id',''),'candidate_ids':turn.get('candidate_ids',[])})
        text=f"问题：{turn['question']}\n回答：{turn['answer']}"
        chunk=Chunk('answer',text=text,keyword_text=' '.join(keyword_tokens(text)),position=Position(kind='message',message_id=turn['assistant_message_id'],start_char=0,end_char=len(text)))
        revision=self.store.upsert_pending(source,[chunk])
        if force: self.store.set_enabled(sid,True)
        if not eligible:
            with self.store.connection as conn:
                conn.execute("UPDATE sources SET status='reference_only' WHERE id=?",(sid,))
                conn.execute("UPDATE chunks SET status='reference_only' WHERE source_id=? AND revision=?",(sid,revision))
            return
        job=self.store.create_job('chat_index',{'source_id':sid,'revision':revision})
        def index(job_id):
            event=self.imports.jobs.event(job_id)
            self.store.update_job(job_id,status='running',phase='indexing',total=1)
            if self.imports.index_revision:
                self.imports.index_revision(sid,revision,Budget(120,event))
                self.store.update_job(job_id,status='done',phase='done',succeeded=1,completed=1,items=[{'source_id':sid,'status':'success'}])
            else: self.store.update_job(job_id,status='waiting_index',phase='waiting_index')
        self.imports.jobs.submit(job,index)
