import json
import time
import threading
from dataclasses import asdict
from pathlib import Path
from urllib.parse import urlsplit

from flask import Blueprint, jsonify, request

from .config import request_fingerprint, stable_hash
from .contracts import QueryResult, UploadItem, Source, Chunk, Position
from .model_clients import Budget, Cancelled, LocalTimeout, ModelUnavailable
from .store import StoreUnavailable
from .parsers import ParseError


def validate_query(value):
    if not isinstance(value,dict) or not isinstance(value.get('request_id'),str) or not 1<=len(value['request_id'])<=200 or not isinstance(value.get('question'),str) or not value['question'].strip() or len(value['question'])>20000:
        raise ValueError('request_id and a nonempty question (max 20000 characters) are required')
    if not isinstance(value.get('context',[]),list) or any(not isinstance(m,dict) or m.get('role') not in ('user','assistant','system') or not isinstance(m.get('content'),str) for m in value.get('context',[])):
        raise ValueError('Invalid context messages')
    if not isinstance(value.get('source_ids',[]),list) or any(not isinstance(x,str) for x in value.get('source_ids',[])):
        raise ValueError('Invalid source IDs')
    if not isinstance(value.get('system_constraints',''),str) or not isinstance(value.get('parameters',{}),dict) or value.get('mode','api') not in ('api','web'):
        raise ValueError('Invalid query constraints or mode')
    request_fingerprint(value,value.get('source_ids',[]))
    return value


def create_blueprint(service=None,imports=None,evaluations=None,sync=None,runtime=None):
    bp=Blueprint('local_knowledge',__name__,url_prefix='/api/knowledge')
    def components():
        if runtime is None: return service,imports,evaluations,sync
        instance=runtime() if callable(runtime) else runtime
        return instance.components()
    def runtime_instance(): return runtime() if callable(runtime) else runtime
    def source_or_404(source_id):
        source=components()[0].store.get_source(source_id)
        if not source or source.status=='deleted': raise KeyError(source_id)
        return source
    @bp.errorhandler(ValueError)
    def bad_input(exc): return jsonify(error=str(exc)),400
    @bp.errorhandler(KeyError)
    def not_found(exc): return jsonify(error='Knowledge object not found'),404
    @bp.errorhandler(ParseError)
    def parse_error(exc): return jsonify(error=str(exc)),413 if 'too_large' in str(exc) else 400
    @bp.errorhandler(StoreUnavailable)
    def unavailable(exc): return jsonify(error='Local knowledge storage is unavailable'),503

    @bp.get('/status')
    def status():
        s,imp,ev,cs=components();c=s.settings();sources=s.store.list_sources()
        profile=s.store.profile(c['evaluation_profile_id']) if c['evaluation_profile_id'] else None
        return jsonify(enabled=c['enabled'],roles={role:{'configured':bool(c[role+'_endpoint']['url'] and c[role+'_endpoint']['model']),'model':c[role+'_endpoint']['model']} for role in ('embedding','rerank','qa')},
            index={'pending':sum(x.status=='pending' for x in sources)},counts={'sources':len(sources),'indexed':sum(x.status=='indexed' and x.enabled for x in sources)},
            calibration={'passed':bool(profile and profile.get('passed')),'reviewed':bool(profile and profile.get('reviewed')),'compatible':bool(profile and profile.get('fingerprint')==s.models.fingerprint),'profile_id':c['evaluation_profile_id']})

    @bp.post('/probe')
    def probe():
        s,*_=components()
        return jsonify(roles=s.models.probe(Budget(s.settings()['local_timeout_seconds'],threading.Event())))

    @bp.get('/sources')
    def sources():
        s,*_=components();q=request.args.get('q','').lower()
        return jsonify(sources=[asdict(x) for x in s.store.list_sources() if q in x.title.lower()])

    @bp.patch('/sources/<source_id>')
    def enable(source_id):
        source_or_404(source_id);data=request.get_json(silent=True) or {}
        if type(data.get('enabled')) is not bool: raise ValueError('enabled must be boolean')
        s,*_=components();s.store.set_enabled(source_id,data['enabled'])
        return jsonify(source=asdict(s.store.get_source(source_id)))

    @bp.delete('/sources/<source_id>')
    def delete(source_id):
        source=source_or_404(source_id);s,imp,*_=components()
        s.store.invalidate_source(source_id)
        copy_path=source.locator.get('copy_path')
        if copy_path:
            path=Path(copy_path).resolve()
            if path.is_relative_to((s.store.data_dir/'imports').resolve()): path.unlink(missing_ok=True)
        with s.store.connection as conn:
            conn.execute('DELETE FROM chunks_fts WHERE chunk_id IN (SELECT id FROM chunks WHERE source_id=?)',(source_id,))
            conn.execute('DELETE FROM chunks WHERE source_id=?',(source_id,))
            conn.execute('DELETE FROM qa_records WHERE source_id=?',(source_id,))
            source.metadata={};conn.execute('UPDATE sources SET body=? WHERE id=?',(json.dumps(asdict(source),ensure_ascii=False),source_id))
        def cleanup(job_id):
            s.retriever.vectors.delete(source_id);s.store.update_job(job_id,status='done',phase='done')
        job=s.store.create_job('cleanup',{'source_id':source_id});imp.jobs.submit(job,cleanup)
        return jsonify(ok=True)

    @bp.post('/import')
    def import_sources():
        data=request.get_json(silent=True) or {};s,imp,ev,cs=components()
        if data.get('kind')=='api_chats':
            instance=runtime_instance()
            if instance is None: raise ValueError('Conversation importer is not configured')
            ids=data.get('conversation_ids',[])
            if not isinstance(ids,list): raise ValueError('conversation_ids must be an array')
            selected=[c for c in instance.conversations() if not ids or c.get('id') in ids]
            # Reconcile all existing sources first; filtering is only for the explicit new import.
            cs.sync_snapshot(instance.conversations(),collect=False)
            job=s.store.create_job('api_chats',{})
            def run(job_id):
                cs.sync_snapshot(instance.conversations(),collect=True,force=True,conversation_ids=ids)
                s.store.update_job(job_id,status='done',phase='done',completed=len(selected),total=len(selected))
            imp.jobs.submit(job,run)
        else: job=imp.enqueue(data)
        return jsonify(job_id=job),202

    @bp.post('/upload')
    def upload():
        _,imp,*_=components();job_id=request.form.get('job_id','');paths=json.loads(request.form.get('relative_paths','[]'));files=request.files.getlist('files')
        if not isinstance(paths,list) or len(paths)!=len(files) or any(not isinstance(x,str) for x in paths): raise ValueError('Relative paths must correspond to upload files')
        items=[UploadItem(path,file.stream) for path,file in zip(paths,files)]
        try: job=imp.append_upload(job_id,items,request.form.get('final')=='true',request.form.get('batch_id'))
        except ValueError as exc:
            if 'Batch ID' in str(exc): return jsonify(error=str(exc)),409
            raise
        return jsonify(job_id=job_id,job=job),202

    @bp.post('/sources/<source_id>/refresh')
    def refresh(source_id):
        source=source_or_404(source_id);s,imp,ev,cs=components()
        if source.locator.get('kind')=='file': job=imp.enqueue({'kind':'paths','roots':[source.locator['path']]})
        else:
            job=s.store.create_job('reindex',{'source_id':source_id,'revision':source.revision})
            def run(job_id):
                s.retriever.index_revision(source_id,source.revision,Budget(120,imp.jobs.event(job_id)))
                s.store.update_job(job_id,status='done',phase='done')
            imp.jobs.submit(job,run)
        return jsonify(job_id=job),202

    @bp.get('/jobs/<job_id>')
    def job_status(job_id): return jsonify(job=components()[1].snapshot(job_id))
    @bp.post('/jobs/<job_id>/cancel')
    def job_cancel(job_id): return jsonify(ok=True,cancel_requested=components()[1].cancel(job_id))

    @bp.post('/query')
    def query():
        data=validate_query(request.get_json(silent=True))
        try:
            instance=runtime_instance()
            if instance and (instance.data_dir/'sync-pending').exists(): instance.sync_after_save(instance.conversations())
            return jsonify(components()[0].query(data).to_dict())
        except (StoreUnavailable,ModelUnavailable): return jsonify(QueryResult(data['request_id'],'miss','local_unavailable').to_dict())

    @bp.post('/query/<request_id>/cancel')
    def query_cancel(request_id): return jsonify(ok=True,cancelled=components()[0].cancel(request_id))
    @bp.get('/requests/<request_id>')
    def progress(request_id):
        result=components()[0].request_status(request_id)
        if result is None: raise KeyError(request_id)
        return jsonify({k:result.get(k) for k in ('request_id','stage','trace','decision','online_model_requests','duration_ms')})

    @bp.get('/sources/<source_id>/content')
    def content(source_id):
        source=source_or_404(source_id)
        revision=request.args.get('revision',type=int)
        if revision is None: raise ValueError('revision is required')
        if source.revision!=revision or source.status in ('stale','pending'): return jsonify(error='source_changed'),409
        units=source.metadata.get('units') or [{'text':c.text,'position':asdict(c.position)} for c in components()[0].store.revision_chunks(source_id,revision)]
        return jsonify(source_id=source_id,revision=revision,text='\n'.join(x['text'] for x in units),units=units)

    @bp.post('/record')
    def record():
        data=request.get_json(silent=True) or {};s,imp,ev,cs=components()
        sid=cs.record(data.get('turn'))
        for call in data.get('online_calls',[]):
            s.store.record_online_call(data['turn']['completion'].get('request_id',''),call['call_id'],call.get('kind','web'),call.get('model','unknown'))
        instance=runtime_instance()
        if instance: cs.sync_snapshot(instance.conversations(),collect=False)
        source=s.store.get_source(sid)
        return jsonify(source_id=sid,revision=source.revision if source else 0,status=source.status if source else 'pending')

    @bp.post('/evaluate')
    def evaluate():
        data=request.get_json(silent=True) or {};s,imp,ev,cs=components()
        if data.get('operation')=='activate':
            report=s.store.profile(data.get('report_id',''))
            if not report or data.get('reviewed') is not True: raise ValueError('A reviewed report is required')
            report['reviewed']=True;s.store.save_profile(data['report_id'],report)
            if not ev.activate(data['report_id'],s.models.fingerprint): return jsonify(error='Evaluation report is invalid or incompatible'),409
            return jsonify(evaluation_profile_id=data['report_id'])
        if data.get('operation','run')!='run': raise ValueError('Invalid evaluation operation')
        paths=[]
        for key in ('calibration_source_id','validation_source_id'):
            source=source_or_404(data.get(key,''))
            if source.status!='evaluation_dataset': raise ValueError('Evaluation input must be an uploaded evaluation dataset')
            paths.append(source.locator['copy_path'])
        return jsonify(job_id=ev.enqueue(*paths)),202

    @bp.post('/web-import')
    def web_import():
        data=request.get_json(silent=True) or {};snapshot=data.get('snapshot');s,imp,ev,cs=components()
        if not isinstance(snapshot,dict) or not isinstance(snapshot.get('messages'),list): raise ValueError('Visible conversation snapshot is required')
        url=snapshot.get('url','');p=urlsplit(url)
        if p.scheme not in ('http','https') or not p.hostname or p.username or p.password: raise ValueError('Invalid web source URL')
        job=s.store.create_job('web',{})
        def run(job_id):
            items=[];user=None
            for message in snapshot['messages']:
                if not isinstance(message,dict) or message.get('role') not in ('user','assistant') or not isinstance(message.get('content'),str):
                    items.append({'status':'skipped','reason':'unknown_message_role'});continue
                if message['role']=='user': user=message;continue
                if not user or not message.get('complete'):
                    items.append({'status':'skipped','reason':'incomplete_or_unpaired'});continue
                sid=stable_hash(['visible_web',url,user.get('id'),message.get('id')]);text='问题：'+user['content']+'\n回答：'+message['content']
                source=Source(sid,kind='web_chat',title=user['content'][:100],locator={'kind':'web','url':url,'site':snapshot.get('site','unknown'),'page_conversation_id':snapshot.get('conversation_id')},content_hash=stable_hash(text),context_complete=bool(snapshot.get('context_complete')),nature='historical_model_answer',metadata={'model':snapshot.get('model') or 'unknown','visible_only':True})
                rev=s.store.upsert_pending(source,[Chunk('visible',text=text,position=Position(kind='message',message_id=message.get('id')))])
                if source.context_complete: s.retriever.index_revision(sid,rev,Budget(120,imp.jobs.event(job_id)))
                else:
                    with s.store.connection as conn: conn.execute("UPDATE sources SET status='reference_only' WHERE id=?",(sid,))
                items.append({'source_id':sid,'status':'success'})
            s.store.update_job(job_id,status='done',phase='done',items=items,completed=len(items),total=len(items),succeeded=sum(x['status']=='success' for x in items),skipped=sum(x['status']=='skipped' for x in items))
        imp.jobs.submit(job,run)
        return jsonify(job_id=job),202
    return bp
