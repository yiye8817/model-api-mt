import re
import threading
import time
from dataclasses import asdict, replace
from pathlib import Path
from knowledge.freshness import needs_current_information

from .config import request_fingerprint, stable_hash, model_fingerprint, qa_configured
from .contracts import QueryResult, Citation, Position
from .ingest import check_file_freshness
from .matching import Matcher, EvidenceError
from .model_clients import Budget, Cancelled, LocalTimeout, ModelUnavailable
from .retrieval import effective_scope, keyword_search
from .lookup import lookup_term, term_variants, document_excerpt, excerpt_constraints_supported
from .diagnostics import log_event
from .synthesis import combine,answer_covers
from .intents import parse_knowledge_question


class RequestRegistry:
    def __init__(self):
        self.events={};self.active=set();self.deadlines={};self.lookups={};self.lock=threading.RLock()


class KnowledgeService:
    def __init__(self,store,retriever,models,settings,registry=None,history_lookup=None,semantic_history_lookup=None):
        self.store=store; self.retriever=retriever; self.models=models; self.settings=settings
        self.matcher=Matcher(models);self.registry=registry or RequestRegistry()
        self._events=self.registry.events;self._active=self.registry.active;self._lock=self.registry.lock
        self.history_lookup=history_lookup
        self.semantic_history_lookup=semantic_history_lookup

    def cancel(self,request_id):
        with self._lock:
            old=self.store.request(request_id)
            if old and old.get('result'): return False
            self._events.setdefault(request_id,threading.Event()).set()
            self.store.update_request(request_id,cancelled=True,stage='cancelled')
            return True

    def request_status(self,request_id): return self.store.request(request_id)

    def _check_sources(self,chunks,question,budget,final=False):
        deps={c.source_id:c.revision for c in chunks}
        if not self.store.dependencies_current(deps): raise EvidenceError('source_changed' if final else 'stale_source')
        for source_id in deps:
            s=self.store.get_source(source_id)
            if not s.context_complete: raise EvidenceError('insufficient_evidence')
            if s.nature=='historical_model_answer' and (any(key not in s.metadata for key in ('question','context','system_constraints','completion')) or s.metadata['completion'].get('status')!='complete'):
                raise EvidenceError('insufficient_evidence')
            if not check_file_freshness(s):
                self.store.invalidate_source(source_id,status='stale'); raise EvidenceError('source_changed' if final else 'stale_source')
            budget.check()
        if needs_current_information(question):
            if any(self.store.get_source(sid).valid_until is None for sid in deps): raise EvidenceError('stale_source')
        for chunk in chunks:
            source=self.store.get_source(chunk.source_id)
            chunk.source_context={'nature':source.nature,'kind':source.kind,'context':source.metadata.get('context',[]),
                'workbench_context':source.metadata.get('workbench_context',[]),'system_constraints':source.metadata.get('system_constraints',''),
                'question':source.metadata.get('question',''),'completion':source.metadata.get('completion',{}),
                'context_complete':source.context_complete,'completed_at':source.completed_at,'valid_until':source.valid_until}
        return deps

    def preview(self,request):
        config=self.settings();event=self._events.setdefault(request['request_id'],threading.Event());budget=Budget(config['local_timeout_seconds'],event)
        self.store.update_request(request['request_id'],stage='retrieval',trace=[{'stage':'retrieval','status':'running'}])
        scope=effective_scope(self.store,request.get('source_ids',[]),config['selected_source_ids'])
        candidates=self.retriever.retrieve(request['question'],scope,budget,allow_degraded=True)
        self._log_candidates(request,scope,candidates,'preview')
        self.store.update_request(request['request_id'],stage='preview',trace=[{'stage':'preview','status':'done','candidate_count':len(candidates)}])
        return candidates

    def _log_candidates(self,request,scope,candidates,method):
        rows=[]
        for candidate in candidates:
            chunk=candidate.chunk;source=self.store.get_source(chunk.source_id)
            rows.append({'chunk_id':chunk.id,'source_id':chunk.source_id,'title':source.title if source else '',
                'revision':chunk.revision,'position':asdict(chunk.position),'quote':chunk.text,
                'raw_score':candidate.raw_score,'score':candidate.score})
        log_event('knowledge.retrieval',request_id=request['request_id'],question=request['question'],
                  method=method,source_count=len(scope),candidate_count=len(rows),candidates=rows)

    def query(self,request):
        result=self._query(request)
        log_event('knowledge.query_result',request_id=request['request_id'],question=request['question'],
                  decision=result.decision,reason=result.reason,answer_origin=result.answer_origin,
                  duration_ms=result.duration_ms,citations=[asdict(c) for c in result.citations],trace=result.trace)
        return result

    def _extractive_lookup(self,request,scope,budget):
        config=self.settings()
        roles=all(config[role+'_endpoint'].get('model') and
            (config[role+'_endpoint'].get('source')=='provider' or config[role+'_endpoint'].get('url'))
            for role in ('embedding','rerank','qa'))
        if roles:
            # Retrieve both source kinds before considering generation.
            # Literal quotations do not depend on generation calibration.
            return self._semantic_lookup(request,scope,budget)
        document=self._document_lookup(request,scope,budget)
        if self.history_lookup is None or lookup_term(request['question']) is None or not excerpt_constraints_supported(request):return document
        pairs=self.history_lookup(request,scope,budget)
        log_event('knowledge.history_retrieval',request_id=request['request_id'],question=request['question'],
            candidate_count=len(pairs),candidates=[{'entry_id':e['id'],'question':e['question'],'quote':e['answer'],
                'source_id':c.source_id,'fact_status':e['fact_status']} for e,c in pairs])
        result=combine(request,document,pairs,self.store,budget)
        if result and result.answer_origin=='local_synthesis':
            chunks=[self.store.get_chunk(c.chunk_id) for c in result.citations]
            self._check_sources(chunks,request['question'],budget,final=True)
            current={e['id']:(e['question'],e['answer'],e['fact_status']) for e,c in self.history_lookup(request,scope,budget)}
            if any(current.get(e['id'])!=(e['question'],e['answer'],e['fact_status']) for e,c in pairs):raise EvidenceError('source_changed')
            budget.check()
        return result

    def probe_lookup(self,request,scope,budget):
        result=self._extractive_lookup(request,scope,budget)
        identity=(request_fingerprint(request,scope),stable_hash(self.settings()))
        with self._lock:
            self.registry.lookups[request['request_id']]=(identity,result)
        return bool(result)

    def _revalidate_extractive(self,request,scope,budget,result):
        scope=effective_scope(self.store,request.get('source_ids',[]),self.settings()['selected_source_ids'])
        chunks=[self.store.get_chunk(c.chunk_id) for c in result.citations]
        if any(c is None or c.source_id not in scope for c in chunks):raise EvidenceError('source_changed')
        self._check_sources(chunks,request['question'],budget,final=True)
        required={entry_id for step in result.trace for entry_id in step.get('saved_entry_ids',[])}
        if required:
            semantic=any(step.get('method')=='semantic_excerpts' for step in result.trace)
            lookup=self.semantic_history_lookup if semantic else self.history_lookup
            if lookup is None:raise EvidenceError('source_changed')
            current={e['id'] for e,c in lookup(request,scope,budget)}
            if not required<=current:raise EvidenceError('source_changed')
        budget.check()

    def _semantic_lookup(self,request,scope,budget):
        if not excerpt_constraints_supported(request):return None
        from .semantic import select
        pairs=self.semantic_history_lookup(request,scope,budget) if self.semantic_history_lookup else []
        eligible_history={c.source_id for e,c in pairs}
        allowed=[]
        sources=[self.store.get_source(sid) for sid in scope]
        readable_paths={str(Path(s.locator.get('path',s.title)).with_suffix('')) for s in sources
            if s and s.kind=='document' and Path(s.title).suffix.lower() in ('.html','.md','.txt','.markdown')}
        for source in sources:
            if source.kind=='document' and source.nature=='document':
                suffix=Path(source.title).suffix.lower()
                if suffix in ('.py','.js','.jsx','.ts','.tsx','.sh','.sql','.css'):continue
                if suffix=='.json' and str(Path(source.locator.get('path',source.title)).with_suffix('')) in readable_paths:continue
                allowed.append(source.id)
            elif source.id in eligible_history:allowed.append(source.id)
        if not allowed:return None
        self.store.update_request(request['request_id'],stage='retrieval')
        candidates=self.retriever.retrieve(request['question'],allowed,budget,balance_sources=True)
        self._log_candidates(request,allowed,candidates,'semantic')
        history_ids={c.chunk.source_id for c in candidates if c.chunk.source_id in eligible_history}
        relevant_pairs=[(e,c) for e,c in pairs if c.source_id in history_ids]
        log_event('knowledge.history_retrieval',request_id=request['request_id'],question=request['question'],method='semantic',
            candidate_count=len(relevant_pairs),candidates=[{'entry_id':e['id'],'question':e['question'],'quote':e['answer'],
                'source_id':c.source_id,'fact_status':e['fact_status']} for e,c in relevant_pairs])
        self._check_sources([c.chunk for c in candidates],request['question'],budget)
        result=select(request,candidates,self.store,self.models,budget,relevant_pairs)
        if result:self._revalidate_extractive(request,scope,budget,result)
        return result

    def _document_lookup(self,request,scope,budget):
        term=lookup_term(request['question'])
        # Excerpts cannot perform a requested translation or structured rewrite.
        special_format=not excerpt_constraints_supported(request)
        if term is None or special_format:
            log_event('knowledge.lookup',request_id=request['request_id'],question=request['question'],
                      lookup_term=term,source_count=len(scope),candidate_count=0,
                      reason='output_constraints_require_generation' if special_format else 'not_a_term_lookup',candidates=[])
            return None
        for variant in list(term_variants(term))[:8]:
            budget.check()
            # Reject navigation before stopping at a usable definition, rather
            # than letting short contents entries exhaust a fixed shortlist.
            ids=keyword_search(self.store,variant,scope,limit=None,require_all=True,document_only=True)
            matches=[];rows=[];siblings={};sources={}
            for chunk_id in ids:
                budget.check();chunk=self.store.get_chunk(chunk_id)
                if not chunk:continue
                if chunk.source_id not in sources:sources[chunk.source_id]=self.store.get_source(chunk.source_id)
                source=sources[chunk.source_id]
                if not source or source.kind!='document' or source.nature!='document':continue
                suffix=Path(source.title).suffix.lower()
                if suffix in ('.py','.js','.jsx','.ts','.tsx','.sh','.sql','.css'):continue
                if source.id not in siblings:siblings[source.id]=self.store.visible_chunks([source.id])
                following=[c for c in siblings[source.id] if chunk.ordinal<c.ordinal<=chunk.ordinal+2]
                excerpt=document_excerpt([chunk,*following],variant)
                query=parse_knowledge_question(request['question'])
                if excerpt and query and 'purpose' in query.facets and not answer_covers(excerpt.answer,replace(query,topic=variant)):excerpt=None
                rows.append({'chunk_id':chunk.id,'source_id':source.id,'title':source.title,'revision':chunk.revision,
                             'position':asdict(chunk.position),'quote':chunk.text,'definition_found':bool(excerpt)})
                if excerpt:
                    rank=0 if suffix in ('.html','.md','.markdown','.txt') else 1
                    matches.append((rank,-excerpt.quality,source.id,chunk.ordinal,source,excerpt))
                    if rank==0 and excerpt.quality>=3:break
            log_event('knowledge.lookup',request_id=request['request_id'],question=request['question'],
                      input_term=term,lookup_term=variant,source_count=len(scope),retrieved_count=len(ids),
                      candidate_count=len(rows),candidates=rows[:49]+rows[-1:] if len(rows)>50 else rows)
            if not matches:continue
            matches.sort(key=lambda x:x[:4])
            _,_,_,_,source,excerpt=matches[0]
            chunks=[c for c,_,_ in excerpt.quotes]
            self._check_sources(chunks,request['question'],budget,final=True)
            citations=[Citation(source.id,source.kind,source.title,c.id,c.revision,source.locator,p,quote)
                       for c,quote,p in excerpt.quotes]
            answer=excerpt.answer
            if variant!=term:answer=f'按本地资料中的“{variant}”理解你的问题：\n\n'+answer
            budget.check()
            return QueryResult(request['request_id'],'hit',answer=answer,citations=citations,
                trace=[{'stage':'extractive_retrieval','status':'done','method':'document_definition',
                        'input_term':term,'matched_term':variant,'corrected':variant!=term}],answer_origin='extractive_document')
        return None

    def _query(self,request,evaluation_threshold=None,cancellation=None):
        request_id=request['request_id']; started=time.monotonic(); config=self.settings()
        identity=stable_hash(request)
        with self._lock:
            previous=self.store.request(request_id)
            if previous and previous.get('identity') and previous['identity']!=identity: raise ValueError('Request ID already used for different input')
            if previous and previous.get('result'):
                value=previous['result']
                if value.get('decision')=='hit':
                    try:
                        if not config['enabled']:raise EvidenceError('disabled')
                        scope=effective_scope(self.store,request.get('source_ids',[]),config['selected_source_ids'])
                        chunks=[self.store.get_chunk(c['chunk_id']) for c in value['citations']]
                        if any(c is None or c.source_id not in scope for c in chunks):raise EvidenceError('source_changed')
                        self._check_sources(chunks,request['question'],Budget(config['local_timeout_seconds'],threading.Event()),final=True)
                        if value.get('answer_origin')=='local_synthesis':
                            required={entry_id for step in value.get('trace',[]) for entry_id in step.get('saved_entry_ids',[])}
                            semantic=any(step.get('method')=='semantic_excerpts' for step in value.get('trace',[]))
                            lookup=self.semantic_history_lookup if semantic else self.history_lookup
                            if lookup is None:raise EvidenceError('source_changed')
                            current={entry['id'] for entry,chunk in lookup(request,scope,Budget(config['local_timeout_seconds'],threading.Event()))}
                            if not required or not required<=current:raise EvidenceError('source_changed')
                        if value.get('answer_origin') not in ('extractive_document','local_synthesis'):
                            if not qa_configured(config):raise EvidenceError('qa_not_configured')
                            profile=self.store.profile(config['evaluation_profile_id'])
                            if not profile or not all(profile.get(k) for k in ('passed','real_models','reviewed')) or profile.get('fingerprint')!=model_fingerprint(config,profile.get('dimension',self.models.dimension)) or previous.get('execution_fingerprint')!=profile.get('fingerprint'):
                                raise EvidenceError('uncalibrated')
                    except EvidenceError as exc:
                        value=QueryResult(request_id,'miss',exc.reason).to_dict()
                        self.store.update_request(request_id,stage='miss',decision='miss',result=value)
                value['citations']=[Citation(**{**c,'position':Position(**c['position'])}) for c in value['citations']]
                return QueryResult(**value)
            if request_id in self._active: raise ValueError('Request ID is already running')
            event=self._events.setdefault(request_id,threading.Event())
            if cancellation is not None:
                event=cancellation
                self._events[request_id]=event
            if previous and previous.get('cancelled'): event.set()
            self._active.add(request_id)
            self.store.update_request(request_id,identity=identity)
        trace=[]; stage='prepare'; budget=Budget(config['local_timeout_seconds'],event)
        with self._lock:
            budget.deadline=min(budget.deadline,self.registry.deadlines.setdefault(request_id,budget.deadline))
        def transition(value,**extra):
            nonlocal stage
            stage=value; step={'stage':value,'status':'running',**extra}; trace.append(step)
            self.store.update_request(request_id,stage=value,trace=trace)
            budget.check()
        result=None
        try:
            budget.check()
            if not config['enabled'] and evaluation_threshold is None: raise EvidenceError('disabled')
            scope=effective_scope(self.store,request.get('source_ids',[]),config['selected_source_ids'])
            if scope and evaluation_threshold is None:
                with self._lock:probed=self.registry.lookups.pop(request_id,None)
                identity=(request_fingerprint(request,scope),stable_hash(config))
                if probed and probed[0]==identity:
                    extractive=probed[1]
                    if extractive:self._revalidate_extractive(request,scope,budget,extractive)
                else:extractive=self._extractive_lookup(request,scope,budget)
                if extractive:
                    result=extractive
                    trace.extend(extractive.trace)
                    result.trace=trace
            if result is None:
                if not qa_configured(config): raise EvidenceError('qa_not_configured')
                if not scope: raise EvidenceError('empty_index')
                profile=self.store.profile(config['evaluation_profile_id']) if config['evaluation_profile_id'] else None
                if evaluation_threshold is None:
                    if profile and getattr(self.models,'dimension',None) is None and profile.get('dimension'):
                        self.models.embed([request['question']],budget)
                    if not profile or not all(profile.get(k) for k in ('passed','real_models','reviewed')) or profile.get('fingerprint')!=self.models.fingerprint:
                        raise EvidenceError('uncalibrated')
                    threshold=profile['threshold']
                else: threshold=evaluation_threshold
                transition('prepare')
                question=self.matcher.prepare_question(request,budget)
                fingerprint=request_fingerprint(request,scope)
                cache_model=stable_hash([self.models.fingerprint,config['evaluation_profile_id'],threshold])
                cached=self.store.get_cache(fingerprint,cache_model) if evaluation_threshold is None else None
                if cached:
                    chunks=[self.store.get_chunk(cid) for cid in cached['chunk_ids']]
                    if any(c is None for c in chunks): raise EvidenceError('source_changed')
                    payload=cached['payload']; origin='validated_cache'
                else:
                    transition('retrieval')
                    candidates=self.retriever.retrieve(question.retrieval_question,scope,budget)
                    self._log_candidates(request,scope,candidates,'hybrid')
                    candidates=[c for c in candidates if c.score>=threshold]
                    if not candidates: raise EvidenceError('low_relevance')
                    # Reserve structured prompts, question, constraints, and answer tokens.
                    token_budget=config['qa_endpoint']['context_tokens']-config['qa_endpoint']['max_output_tokens']-self.models.count_tokens(request['question']+str(request.get('context',[])),budget)-800
                    chunks=self.retriever.evidence_units(candidates,max(0,token_budget),budget)
                    if not chunks: raise EvidenceError('insufficient_evidence')
                    self._check_sources(chunks,question.original,budget)
                    transition('matching',candidate_count=len(chunks),score=max(c.score for c in candidates))
                    self.matcher.match_evidence(question,chunks,budget)
                    transition('generate')
                    payload=self.matcher.generate(question,chunks,budget); origin='local_generated'
                self._check_sources(chunks,question.original,budget)
                transition('verify')
                validated=self.matcher.validate_answer(payload,question,chunks,budget)
                deps=self._check_sources(chunks,question.original,budget,final=True)
                citations=[]
                for citation in validated.citations:
                    source=self.store.get_source(citation.source_id)
                    citations.append(replace(citation,source_kind=source.kind,title=source.title,locator=source.locator))
                budget.check()
                result=QueryResult(request_id,'hit',answer=validated.answer,citations=citations,trace=trace,
                    local_model=config['qa_endpoint']['model'],answer_origin=origin)
                if evaluation_threshold is None:
                    expires=[self.store.get_source(sid).valid_until for sid in deps if self.store.get_source(sid).valid_until is not None]
                    if not self.store.put_cache(fingerprint,{'payload':payload,'chunk_ids':[c.id for c in chunks]},deps,cache_model,min(expires) if expires else None):
                        raise EvidenceError('source_changed')
                budget.check()
        except Cancelled: result=QueryResult(request_id,'cancelled','cancelled',trace=trace)
        except LocalTimeout: result=QueryResult(request_id,'miss','local_timeout',trace=trace)
        except EvidenceError as exc: result=QueryResult(request_id,'miss',exc.reason,trace=trace)
        except ModelUnavailable: result=QueryResult(request_id,'miss','invalid_answer' if stage in ('generate','verify') else 'local_unavailable',trace=trace)
        finally:
            with self._lock:
                if result is not None:
                    current=self.store.request(request_id)
                    if event.is_set() or current and current.get('cancelled'): result=QueryResult(request_id,'cancelled','cancelled',trace=trace)
                    result.duration_ms=round((time.monotonic()-started)*1000,2)
                    for step in trace: step['status']='done'
                    trace.append({'stage':result.decision,'status':'done','reason':result.reason,'duration_ms':result.duration_ms})
                    self.store.update_request(request_id,stage=result.decision,decision=result.decision,trace=trace,duration_ms=result.duration_ms,result=result.to_dict(),execution_fingerprint=self.models.fingerprint)
                self._active.discard(request_id)
        return result
