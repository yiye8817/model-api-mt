"""HTTP boundary for the document learning workspace."""
import io
from flask import Blueprint, jsonify, request, send_file
from .contracts import LearningError, paginate, text


def public_job(job):
    return {k:v for k,v in job.items() if k not in ('payload','dedupe_key')}


def create_blueprint(get_service):
    bp = Blueprint('learning',__name__,url_prefix='/api/learning')
    def service(): return get_service()
    def body():
        value = request.get_json(silent=True)
        if not isinstance(value,dict): raise LearningError('请求必须为 JSON 对象')
        return value
    def options(value):
        result = {}
        for key in ('provider_id','model'):
            if value.get(key) is not None: result[key] = text(value[key],key,300)
        return result
    def paging():
        try: return int(request.args.get('page','1')),int(request.args.get('page_size','30'))
        except ValueError: raise LearningError('分页参数无效')
    def filters():
        value = request.args.to_dict()
        if value.get('document_ids'): value['document_ids'] = value['document_ids'].split(',')
        return value
    @bp.errorhandler(LearningError)
    def error(exc): return jsonify(error=str(exc)),exc.status
    @bp.get('/status')
    def status():
        value = service().status(); value['jobs'] = [public_job(j) for j in value['jobs']]
        return jsonify(value)
    @bp.post('/sync')
    def sync(): return jsonify(service().sync())
    @bp.get('/documents')
    def documents(): return jsonify(service().store.list_documents(filters(),*paging()))
    @bp.post('/documents/upload')
    def upload(): return jsonify(service().upload([(f.filename or '',f.stream) for f in request.files.getlist('files')],options(request.form))),202
    @bp.post('/documents/link')
    def link():
        value = body(); return jsonify(service().import_link(value.get('url'),options(value))),202
    @bp.get('/documents/<document_id>')
    def document(document_id): return jsonify(document=service().store.get_document(document_id))
    @bp.patch('/documents/<document_id>')
    def update(document_id): return jsonify(document=service().store.update_document(document_id,body()))
    @bp.delete('/documents/<document_id>')
    def remove(document_id): service().store.remove_document(document_id); return jsonify(ok=True)
    @bp.get('/documents/<document_id>/content')
    def content(document_id):
        s = service(); doc = s.store.get_document(document_id)
        try: revision = int(request.args.get('revision',doc['revision']))
        except ValueError: raise LearningError('修订参数无效')
        chunks = s.store.get_chunks(document_id,revision)
        if request.args.get('chunk_id'): chunks = [c for c in chunks if c['id'] == request.args['chunk_id']]
        if not chunks: raise LearningError('文档片段不存在',404)
        return jsonify({**paginate(chunks,*paging()),'document_id':document_id,'revision':revision,'title':doc['title']})
    @bp.get('/documents/<document_id>/analysis')
    def analysis(document_id): return jsonify(analysis=service().store.get_analysis(document_id))
    @bp.post('/analyze')
    def analyze():
        value = body(); return jsonify(job=public_job(service().analyze(value.get('scope'),options(value)))),202
    @bp.get('/concepts')
    def concepts(): return jsonify(service().graph.list_concepts(filters(),*paging()))
    @bp.get('/concepts/<concept_id>')
    def concept(concept_id):
        s = service(); value = s.graph.get_concept(concept_id)
        value['explorations'] = s.store.get_explorations(concept_id)
        return jsonify(concept=value)
    @bp.post('/concepts/<concept_id>/explore')
    def explore(concept_id): return jsonify(job=public_job(service().explore(concept_id,body().get('scope')))),202
    @bp.get('/graph')
    def graph(): return jsonify(service().graph.graph(filters(),*paging()))
    @bp.get('/conversations')
    def conversations(): return jsonify(service().store.list_conversations(filters(),*paging()))
    @bp.get('/conversations/<conversation_id>')
    def conversation(conversation_id): return jsonify(conversation=service().store.get_conversation(conversation_id))
    @bp.post('/questions')
    def question():
        value = body(); job = service().ask(value.get('question'),value.get('scope'),value.get('conversation_id'),**options(value))
        return jsonify(job=public_job(job)),202
    @bp.get('/archives')
    def archives(): return jsonify(service().archives.list_archives(filters(),*paging()))
    @bp.post('/archives')
    def archive_create():
        value = body(); return jsonify(job=public_job(service().create_archive(value.get('scope'),value.get('title',''),options(value)))),202
    @bp.post('/archives/notes')
    def note():
        value = body(); origin = value.get('origin')
        if not isinstance(origin,dict): raise LearningError('请选择已有学习记录')
        s = service(); record = s.store.get_learning_record(origin)
        markdown = record.get('answer') or '\n\n'.join(str(record.get(k,'')) for k in ('principles','prerequisites','examples','pitfalls','related'))
        if record.get('extension'): markdown += '\n\n拓展说明：\n'+record['extension']
        result = s.archives.save_note(text(value.get('title') or record.get('question') or '知识点学习笔记','笔记标题',300),markdown,
            record.get('citations',[]),record['document_revisions'],origin)
        return jsonify(archive=result),201
    @bp.get('/archives/<archive_id>')
    def archive(archive_id): return jsonify(archive=service().archives.get_archive(archive_id))
    @bp.get('/archives/<archive_id>/export')
    def export(archive_id):
        data,mime,name = service().archives.export(archive_id,request.args.get('format','markdown'))
        return send_file(io.BytesIO(data),mimetype=mime,as_attachment=True,download_name=name)
    @bp.get('/jobs/<job_id>')
    def job(job_id): return jsonify(job=public_job(service().store.get_job(job_id)))
    @bp.post('/jobs/<job_id>/cancel')
    def cancel(job_id): return jsonify(job=public_job(service().jobs.cancel(job_id)))
    return bp
