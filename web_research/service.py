import queue
import threading
import time
from concurrent.futures import ThreadPoolExecutor

from .sources import select_sources, annotate_query
from .keywords import original_plan


class ResearchPipeline:
    def __init__(self, provider, sites, ddgs, parse_official, synthesize, log=lambda *args, **kwargs: None, keyword_plan=None, parse_source=None):
        self.provider = provider; self.sites = sites; self.ddgs = ddgs
        self.parse_official = parse_official; self.synthesize = synthesize; self.log = log
        self.keyword_plan = keyword_plan
        self.parse_source = parse_source

    def events(self, data, cancel):
        output = queue.Queue()
        data = dict(data)
        sources, provider_answer, plan = [], {}, {}
        keyword_cancel = threading.Event()
        page_pool = None
        started = time.monotonic()
        def emit(kind, payload):
            if not cancel.is_set():
                output.put({'type': kind, **payload})
        def work(channel, task, query=None):
            details = {'query_language': query['language'], 'search_query': query['query']} if query else {}
            emit('status', {'channel': channel, 'status': 'running', **details})
            try:
                task()
                if channel != 'keywords' or not keyword_cancel.is_set():
                    emit('status', {'channel': channel, 'status': 'done', **details})
            except Exception as exc:
                if not cancel.is_set() and (channel != 'keywords' or not keyword_cancel.is_set()):
                    detail = str(exc)[:800]
                    if data.get('apiKey'):
                        detail = detail.replace(data['apiKey'], '[REDACTED]')
                    emit('status', {'channel': channel, 'status': 'error', 'detail': detail, 'code': getattr(exc, 'code', 'SEARCH_FAILED'), **details})
                    if channel == 'synthesis':
                        emit('error', {'detail': detail})
            finally:
                output.put({'type': '_done', 'channel': channel})
        def start(channel, task, query=None):
            threading.Thread(target=work, args=(channel, task, query), daemon=True).start()
        def query_emitter(query):
            def emit_result(kind, payload):
                payload = {**payload, 'query_language': query['language'], 'search_query': query['query']}
                if kind == 'result' and payload.get('result'):
                    payload['result'] = annotate_query(payload['result'], query)
                emit(kind, payload)
            return emit_result
        def publish(channel, rows, query):
            for row in rows:
                if cancel.is_set():
                    return
                query_emitter(query)('result', {'channel': channel, 'result': row})
        def search_site(site, query):
            publish(site, self.sites.search(site, query['query'], cancel, query_emitter(query)), query)
        def official(query):
            rows = self.sites.search('official', query['query'], cancel, query_emitter(query))
            for row in rows:
                publish('official', [row], query)
                if cancel.is_set():
                    return
                try:
                    publish('official', self.parse_official(row, cancel), query)
                except Exception:
                    if cancel.is_set():
                        return
                    query_emitter(query)('status', {'channel': 'official', 'status': 'error',
                        'code': 'PAGE_UNAVAILABLE', 'detail': '候选网页正文不可用，继续解析其他官方链接'})
        def launch_queries(selected_plan):
            queries = selected_plan['queries']
            data.update(search_queries=queries, search_keywords=selected_plan.get('keywords', {}))
            cache = [{'done': threading.Event(), 'rows': [], 'error': None} for _ in queries]
            def ddgs(query, entry):
                try:
                    rows = self.ddgs(query['query'], cancel, query_emitter(query))
                    entry['rows'] = [annotate_query(row, query) for row in rows]
                    publish('ddgs', rows, query)
                except Exception as exc:
                    entry['error'] = exc
                    raise
                finally:
                    entry['done'].set()
            def shared_search(term, event, emit_provider):
                # The bilingual searches already run independently. Reuse
                # their evidence instead of issuing the same DDGS work again.
                if len(queries) == 1:
                    return self.ddgs(term, event, emit_provider)
                rows = []
                for entry in cache:
                    while not entry['done'].wait(.1):
                        if event.is_set():
                            return []
                    rows.extend(entry['rows'])
                if not rows:
                    raise next((entry['error'] for entry in cache if entry['error']), RuntimeError('双语检索未返回结果'))
                return rows
            # Official discovery starts first, then both languages fan out.
            for query in queries:
                start('official', lambda query=query: official(query), query)
            for site in ('google', 'youtube', 'x', 'reddit', 'github'):
                for query in queries:
                    start(site, lambda site=site, query=query: search_site(site, query), query)
            for query, entry in zip(queries, cache):
                start('ddgs', lambda query=query, entry=entry: ddgs(query, entry), query)
            start('provider', lambda: provider_answer.update(self.provider(data, cancel, emit, shared_search) or {}))
            return len(queries) * 7 + 1
        planning = self.keyword_plan is not None
        if planning:
            start('keywords', lambda: plan.update(self.keyword_plan(data, keyword_cancel, emit)))
            remaining = 0
        else:
            remaining = launch_queries(original_plan(data['query']))
        synthesizing, parsing, pages_remaining = False, False, 0
        def launch_parsing():
            nonlocal page_pool
            groups = {}
            for source in sources:
                groups.setdefault(source['url'], []).append(source)
            page_pool = ThreadPoolExecutor(max_workers=6, thread_name_prefix='research-page')
            emit('status', {'channel': 'parsing', 'status': 'running', 'detail': f'解析 {len(groups)} 个网页并提取内容摘要'})
            def parse(references):
                try:
                    representative = next((row for row in references if row.get('channel') in ('x', 'reddit') and row.get('content')), references[0])
                    try:
                        result = self.parse_source(representative, data, cancel)
                    except Exception as exc:
                        if cancel.is_set():
                            return
                        result = {'parse_status': 'error', 'parse_error': str(exc)[:500], 'summary': '', 'content': ''}
                    for reference in references:
                        fields = {key: value for key, value in result.items() if key in
                            ('parse_status', 'parse_error', 'parse_method', 'parsed_chars', 'summary', 'content', 'title', 'resolved_url', 'published_at', 'reference_only')}
                        emit('result', {'channel': reference['channel'], 'result': {**reference, **fields}})
                finally:
                    output.put({'type': '_page_done'})
            for references in groups.values():
                for reference in references:
                    emit('result', {'channel': reference['channel'], 'result': {**reference, 'parse_status': 'running'}})
                page_pool.submit(parse, references)
            return len(groups)
        try:
            yield {'type': 'start', 'model': data['model']}
            while not cancel.is_set():
                if planning and time.monotonic() - started > 60:
                    keyword_cancel.set()
                    fallback = original_plan(data['query'])
                    emit('status', {'channel': 'keywords', 'status': 'error', 'code': 'KEYWORDS_TIMEOUT',
                                    'detail': '关键词提取超时，按原问题继续检索'})
                    emit('plan', fallback)
                    remaining = launch_queries(fallback)
                    planning = False
                if time.monotonic() - started > (360 if self.parse_source else 240):
                    yield {'type': 'error', 'detail': '综合搜索超时，已保留返回的结果'}
                    return
                try:
                    event = output.get(timeout=1)
                except queue.Empty:
                    yield {'type': 'heartbeat'}
                    continue
                if event['type'] == '_page_done':
                    pages_remaining -= 1
                    if pages_remaining:
                        continue
                    emit('status', {'channel': 'parsing', 'status': 'done', 'detail': '网页解析完成'})
                elif event['type'] == '_done':
                    if event['channel'] == 'keywords':
                        if planning:
                            selected_plan = plan or original_plan(data['query'])
                            event = {'type': 'plan', **selected_plan}
                            self.log('research.plan', **event)
                            yield event
                            if cancel.is_set():
                                return
                            remaining = launch_queries(selected_plan)
                            planning = False
                        continue
                    if event['channel'] == 'synthesis':
                        return
                    remaining -= 1
                else:
                    if event['type'] == 'result' and event['result'].get('url'):
                        source = event['result']
                        old = next((i for i,s in enumerate(sources) if s.get('id') == source.get('id')), None)
                        if old is None:
                            sources.append(source)
                        else:
                            sources[old] = source
                    self.log('research.' + event['type'], **event)
                    yield event
                    if event['type'] == 'complete':
                        return
                if not planning and not remaining and not synthesizing and not pages_remaining:
                    if self.parse_source and not parsing:
                        parsing = True
                        pages_remaining = launch_parsing()
                        if pages_remaining:
                            continue
                    selected = select_sources(sources, require_parsed=self.parse_source is not None)
                    if not selected:
                        yield {'type': 'error', 'detail': '没有成功解析的网页正文，无法整合内容摘要' if self.parse_source else '未获取到可核对的网页资料，无法确认最新信息'}
                        return
                    synthesizing = True
                    def synthesize():
                        result = self.synthesize(data, selected, provider_answer)
                        emit('complete', {**result, 'sources': selected, 'duration_ms': int((time.monotonic()-started)*1000)})
                    start('synthesis', synthesize)
        finally:
            keyword_cancel.set()
            cancel.set()
            if page_pool:
                page_pool.shutdown(wait=False, cancel_futures=True)
