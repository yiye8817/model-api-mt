"""Held-out evaluation. Gold labels are never sent to a model."""
import json
import math
import re
import threading
import uuid
from collections import Counter
from dataclasses import asdict
from pathlib import Path

from .config import model_fingerprint, stable_hash
from .contracts import EvaluationDataset, EvaluationReport
from .model_clients import ModelClients, Cancelled

CATEGORIES={'synonym','conditions','pronoun','missing','conflict','temporal'}


def validate_dataset(dataset):
    seen=set(); families=[]
    for split in (dataset.calibration,dataset.validation):
        if len(split)<30 or sum(x.get('expected_answerable') is True for x in split)<15:
            raise ValueError('Each split requires at least 30 labels and 15 answerable cases')
        counts=Counter(x.get('category') for x in split)
        if any(counts[c]<5 for c in CATEGORIES): raise ValueError('Each split must cover all six categories with five cases')
        group=set()
        for item in split:
            for field in ('id','family_id','category','question','context','expected_answerable','expected_claims','allowed_citations','critical_constraints','as_of'):
                if field not in item: raise ValueError(f'Missing evaluation field: {field}')
            if not isinstance(item['id'],str) or not item['id'] or item['id'] in seen: raise ValueError('Evaluation IDs must be unique')
            if not isinstance(item['question'],str) or not item['question'].strip() or type(item['expected_answerable']) is not bool:
                raise ValueError('Invalid evaluation question or label')
            if not isinstance(item['family_id'],str) or not item['family_id']: raise ValueError('Invalid family_id')
            for field in ('context','expected_claims','allowed_citations','critical_constraints'):
                if not isinstance(item[field],list): raise ValueError(f'{field} must be an array')
            if any(not isinstance(v,str) for v in item['expected_claims']): raise ValueError('Expected claims must be strings')
            if item['expected_answerable'] and (not item['expected_claims'] or not item['allowed_citations']): raise ValueError('Positive labels require claims and allowed citations')
            seen.add(item['id']); group.add(item['family_id'])
        families.append(group)
    if families[0]&families[1]: raise ValueError('A fact/wording family cannot cross calibration and validation')


def select_threshold(calibration):
    scores={row['score'] for row in calibration if row['hit'] and math.isfinite(row['score'])}
    if not scores: raise ValueError('Calibration produced no usable local answers')
    best=None
    for threshold in sorted(scores):
        hits=[r for r in calibration if r['hit'] and r['score']>=threshold]
        if any(not r['correct'] for r in hits): continue
        score=sum(r['correct'] for r in hits)
        if score and (best is None or (score,threshold)>best): best=(score,threshold)
    if best is None: raise ValueError('No calibrated threshold avoids erroneous local answers')
    return best[1]


def profile_compatible(profile,config):
    return bool(profile and all(profile.get(k) for k in ('passed','real_models','reviewed')) and
                not profile.get('cancelled') and profile.get('fingerprint')==model_fingerprint(config,profile.get('dimension')))


def _normal(text):
    for chinese,number in [('一','1'),('二','2'),('两','2'),('三','3'),('四','4'),('五','5'),('六','6'),('七','7'),('八','8'),('九','9'),('十','10')]:
        text=re.sub(chinese+r'(?=年|个月|月|天)',number,text)
    return re.sub(r'\s+','',text).lower()


def assess(item,result):
    if result.decision!='hit': return False
    if not item['expected_answerable']: return False
    answer=_normal(result.answer or '')
    if any(_normal(claim) not in answer for claim in item['expected_claims']): return False
    if not result.citations: return False
    for citation in result.citations:
        if not any((not ref.get('title') or ref['title']==citation.title) and
                   (not ref.get('source_id') or ref['source_id']==citation.source_id) and
                   bool(ref.get('quote')) and _normal(ref['quote']) in _normal(citation.quote) for ref in item['allowed_citations']):
            return False
    return True


class EvaluationRunner:
    def __init__(self,service,store,queue=None):
        self.service=service; self.store=store; self.queue=queue

    @property
    def real_models(self):
        return bool(self.service and type(self.service.models) is ModelClients and all(
            self.service.models.config[key].get('model_revision') for key in ('embedding_endpoint','rerank_endpoint','qa_endpoint')))

    def enqueue(self,calibration_path,validation_path):
        if self.queue is None: raise ValueError('Evaluation queue is not configured')
        job_id=self.store.create_job('evaluation',{'calibration_path':str(calibration_path),'validation_path':str(validation_path)})
        self.queue.submit(job_id,self._run_job)
        return job_id

    def _run_job(self,job_id):
        job=self.store.job(job_id); cancellation=self.queue.event(job_id)
        if job['cancel_requested']: cancellation.set()
        dataset=EvaluationDataset(self._read(job['payload']['calibration_path']),self._read(job['payload']['validation_path']))
        self.store.update_job(job_id,status='running',phase='calibration',total=len(dataset.calibration)+len(dataset.validation))
        try:
            report=self.run(dataset,cancellation,job_id)
            data=asdict(report); data.update(fingerprint=report.model_fingerprint,passed=report.meets_release_gate(),cancelled=False)
            self.store.save_profile(job_id,data)
            self.store.update_job(job_id,status='done',phase='done',result={**data,'report_id':job_id})
        except Cancelled:
            self.store.update_job(job_id,status='cancelled',phase='cancelled',result={'cancelled':True,'passed':False})

    def _read(self,path):
        p=Path(path)
        if p.stat().st_size>20*1024*1024: raise ValueError('Evaluation file exceeds 20 MiB')
        return [json.loads(line) for line in p.read_text(encoding='utf-8-sig').splitlines() if line.strip()]

    def run(self,dataset,cancellation,job_id=None):
        validate_dataset(dataset)
        dataset_hash=stable_hash(asdict(dataset)); validation_hash=stable_hash(dataset.validation)
        # A failed holdout is consumed; do not use repeated runs to select a threshold.
        for row in self.store.connection.execute('SELECT body FROM evaluation_profiles'):
            profile=json.loads(row['body'])
            if profile.get('validation_hash')==validation_hash:
                raise ValueError('Validation dataset has already been consumed; use a new held-out dataset')
        run_id=job_id or uuid.uuid4().hex
        def execute(item,threshold,split):
            if job_id and self.store.job(job_id)['cancel_requested']: cancellation.set()
            if cancellation.is_set(): raise Cancelled('Evaluation cancelled')
            req=dict(request_id=f'{run_id}-{split}-{item["id"]}',question=item['question'],context=item['context'],
                system_constraints='仅据材料回答，保留对象、数值及单位。',source_ids=[],mode='api',online_target=None,parameters={})
            result=self.service._query(req,evaluation_threshold=threshold,cancellation=cancellation)
            if result.decision=='cancelled': raise Cancelled('Evaluation cancelled')
            score=max((step.get('score',-1e308) for step in result.trace),default=-1e308)
            record={'id':item['id'],'category':item['category'],'expected_answerable':item['expected_answerable'],'hit':result.decision=='hit',
                    'correct':assess(item,result),'score':score,'decision':result.decision,'reason':result.reason,
                    'answer':result.answer,'citations':[asdict(c) for c in result.citations],'duration_ms':result.duration_ms}
            if job_id:
                snapshot=self.store.job(job_id)
                self.store.update_job(job_id,phase=split,completed=snapshot['completed']+1)
            return record
        calibration=[execute(item,-1e308,'calibration') for item in dataset.calibration]
        threshold=select_threshold(calibration)
        # Persist the frozen threshold before accessing any validation case.
        marker=dict(validation_hash=validation_hash,fingerprint=self.service.models.fingerprint,passed=False,real_models=self.real_models,
                    reviewed=False,cancelled=False,threshold=threshold)
        self.store.save_profile(run_id,marker)
        validation=[execute(item,threshold,'validation') for item in dataset.validation]
        report=EvaluationReport(answerable=sum(r['expected_answerable'] for r in validation),correct_hits=sum(r['hit'] and r['correct'] for r in validation),
            wrong_hits=sum(r['hit'] and not r['correct'] for r in validation),items=validation,model_fingerprint=self.service.models.fingerprint,
            dataset_hash=dataset_hash,real_models=self.real_models,threshold=threshold,dimension=self.service.models.dimension,
            calibration=calibration,validation_hash=validation_hash)
        if job_id: self.store.update_job(job_id,succeeded=report.correct_hits,failed=report.wrong_hits)
        return report

    def activate(self,report_id,current_fingerprint):
        report=self.store.profile(report_id)
        if not report or not all(report.get(k) for k in ('passed','real_models','reviewed')) or report.get('cancelled') or report.get('wrong_hits',0) or report.get('fingerprint')!=current_fingerprint:
            return False
        if self.service and not all(self.service.models.config[k]['model_revision'] for k in ('embedding_endpoint','rerank_endpoint','qa_endpoint')): return False
        return True
