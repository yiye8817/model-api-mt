"""Small Flask surface for the local content library."""
from functools import wraps
import time

from flask import jsonify, request
from local_knowledge.diagnostics import log_event


def register_knowledge_routes(app, get_store, get_conversations, prefix='/api/knowledge', get_semantic=None, get_document_lookup=None):
    def safe(fn):
        @wraps(fn)
        def wrapped(*args, **kwargs):
            try:
                return fn(*args, **kwargs)
            except ValueError as exc:
                return jsonify({'error': str(exc)}), 400
            except KeyError:
                return jsonify({'error': '条目不存在，可能已随原会话删除'}), 404
        return wrapped

    def body():
        value = request.get_json(silent=True)
        if not isinstance(value, dict):
            raise ValueError('请求必须是 JSON 对象')
        return value

    def synced():
        store = get_store()
        store.sync_conversations(get_conversations())
        return store

    @app.get(prefix + '/status')
    @safe
    def knowledge_status():
        return jsonify(synced().status())

    @app.post(prefix + '/search')
    @safe
    def knowledge_search():
        data = body()
        store = synced()
        query = data.get('query', '')
        result = store.search(query, scope=data.get('scope', 'all'), source=data.get('source', ''),
                              tag=data.get('tag', ''), fact_status=data.get('fact_status', ''),
                              sort=data.get('sort', 'relevance'), limit=data.get('limit', 20),
                              kind=data.get('kind', 'qa'))
        return jsonify({**result, 'intent': store.classify(query)})

    @app.post(prefix + '/reuse')
    @safe
    def knowledge_reuse():
        from .datasets import text
        from .reuse import miss
        from local_knowledge.model_clients import Cancelled, LocalTimeout, ModelUnavailable
        from local_knowledge.matching import EvidenceError
        data = body()
        request_id = text(data.get('request_id'), 'request_id', True, maximum=200)
        question = text(data.get('question'), 'question', True, maximum=20000)
        constraints = text(data.get('system_constraints', ''), 'system_constraints')
        context = data.get('context', [])
        sources = data.get('source_ids', [])
        if not isinstance(context, list) or any(not isinstance(m, dict) or not isinstance(m.get('content'), str) for m in context):
            raise ValueError('context 必须是消息数组')
        if not isinstance(sources, list) or any(not isinstance(s, str) for s in sources):
            raise ValueError('source_ids 必须是字符串数组')
        def respond(result, duration_ms=0):
            log_event('knowledge.saved_result',request_id=request_id,question=question,
                decision=result['decision'],reason=result['reason'],answer_origin=result.get('answer_origin'),
                duration_ms=duration_ms,saved_entry=result.get('saved_entry'),quote=result.get('answer') or '')
            return jsonify({'request_id':request_id,**result,'duration_ms':duration_ms})
        if sources or data.get('bypass_saved_reuse'):
            return respond(miss('source_scope_or_regenerate'))
        started = time.monotonic()
        models, budget, progress, source_valid = None, None, lambda stage: None, None
        try:
            if get_semantic:
                models, budget, progress, source_valid = get_semantic(request_id)
            progress('retrieval')
            result = synced().reuse(question, constraints, context=context, models=models, budget=budget,
                                    source_valid=source_valid, request_id=request_id,
                                    document_lookup=(lambda:get_document_lookup(data,budget)) if get_document_lookup else None)
            progress('hit' if result['decision'] == 'hit' else 'prepare')
        except Cancelled:
            result = {**miss('cancelled'), 'decision': 'cancelled'}
        except LocalTimeout:
            result = miss('local_timeout')
        except ModelUnavailable:
            result = miss('local_unavailable')
        except EvidenceError as exc:
            result = miss(exc.reason)
        return respond(result,round((time.monotonic()-started)*1000,1))

    @app.post(prefix + '/import')
    @safe
    def knowledge_import():
        data = body()
        result = get_store().import_data(data.get('content'), data.get('format', 'records'),
                                        data.get('name', '导入内容'), data.get('source_url', ''),
                                        data.get('partition', 'dev'))
        return jsonify(result)

    @app.post(prefix + '/evaluate')
    @safe
    def knowledge_evaluate():
        body()
        return jsonify(get_store().evaluate())

    @app.post(prefix + '/entries')
    @safe
    def knowledge_add():
        return jsonify(get_store().add(body())), 201

    @app.get(prefix + '/entries/<entry_id>')
    @safe
    def knowledge_entry(entry_id):
        return jsonify(synced().get(entry_id))

    @app.patch(prefix + '/entries/<entry_id>')
    @safe
    def knowledge_annotate(entry_id):
        return jsonify(synced().annotate(entry_id, body()))
