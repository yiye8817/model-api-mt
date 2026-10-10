import re
import threading
import time
from dataclasses import asdict, replace

from .config import request_fingerprint, stable_hash, model_fingerprint, qa_configured
from .contracts import QueryResult, Citation, Position
from .ingest import check_file_freshness
from .matching import Matcher, EvidenceError
from .model_clients import Budget, Cancelled, LocalTimeout, ModelUnavailable
from .retrieval import effective_scope


class RequestRegistry:
    def __init__(self):
        self.events={};self.active=set();self.deadlines={};self.lock=threading.RLock()


class KnowledgeService:
    def __init__(self,store,retriever,models,settings,registry=None):
        self.store=store; self.retriever=retriever; self.models=models; self.settings=settings
        self.matcher=Matcher(models);self.registry=registry or RequestRegistry()
        self._events=self.registry.events;self._active=self.registry.active;self._lock=self.registry.lock

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
        if re.search(r'最新|当前|现在|今日|今天|\blatest\b|\bcurrently\b|\btoday\b',question,re.I):
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
        candidates=self.retriever.retrieve(request['question'],scope,budget)
        self.store.update_request(request['request_id'],stage='preview',trace=[{'stage':'preview','status':'done','candidate_count':len(candidates)}])
        return candidates

    def query(self,request): return self._query(request)

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
                        if not qa_configured(config):raise EvidenceError('qa_not_configured')
                        profile=self.store.profile(config['evaluation_profile_id'])
                        if not profile or not all(profile.get(k) for k in ('passed','real_models','reviewed')) or profile.get('fingerprint')!=model_fingerprint(config,profile.get('dimension',self.models.dimension)) or previous.get('execution_fingerprint')!=profile.get('fingerprint'):
                            raise EvidenceError('uncalibrated')
                        scope=effective_scope(self.store,request.get('source_ids',[]),config['selected_source_ids'])
                        chunks=[self.store.get_chunk(c['chunk_id']) for c in value['citations']]
                        if any(c is None or c.source_id not in scope for c in chunks):raise EvidenceError('source_changed')
                        self._check_sources(chunks,request['question'],Budget(config['local_timeout_seconds'],threading.Event()),final=True)
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
            if not qa_configured(config): raise EvidenceError('qa_not_configured')
            scope=effective_scope(self.store,request.get('source_ids',[]),config['selected_source_ids'])
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
                candidates=[c for c in candidates if c.score>=threshold]
                if not candidates: raise EvidenceError('low_relevance')
                # Reserve the structured prompts, question, constraints, and answer tokens.
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
