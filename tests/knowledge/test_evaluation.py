import copy
from threading import Event

import pytest


@pytest.mark.parametrize('hits,wrong,passes',[(0,0,False),(18,1,False),(18,0,True),(17,0,False)])
def test_release_gate(hits,wrong,passes):
    from local_knowledge.contracts import EvaluationReport
    assert EvaluationReport(answerable=30,correct_hits=hits,wrong_hits=wrong).meets_release_gate() is passes


def test_validation_labels_never_select_threshold():
    from local_knowledge.evaluation import select_threshold
    calibration=[{'score':.8,'hit':True,'correct':True}, {'score':.9,'hit':True,'correct':True}, {'score':.3,'hit':True,'correct':False}]
    assert select_threshold(calibration)==.8
    with pytest.raises(ValueError): select_threshold([{'score':.9,'hit':True,'correct':False}])


def test_paraphrase_family_not_split_across_sets():
    from local_knowledge.evaluation import validate_dataset
    from local_knowledge.contracts import EvaluationDataset
    def examples(prefix):
        return [{'id':f'{prefix}-{i}','family_id':f'{prefix}-family-{i}','category':category,'question':'A warranty?',
                 'context':[],'expected_answerable':category in ('synonym','conditions','pronoun'),'expected_claims':['三年'],
                 'allowed_citations':[{'quote':'保修三年'}],'critical_constraints':[],'as_of':'2026-10-08'}
                for i,category in enumerate(sum(([category]*5 for category in ('synonym','conditions','pronoun','missing','conflict','temporal')),[]))]
    data=EvaluationDataset(examples('cal'),examples('val'))
    validate_dataset(data)
    data.validation[0]['family_id']=data.calibration[0]['family_id']
    with pytest.raises(ValueError,match='family'): validate_dataset(data)


def test_model_revision_or_transform_change_disables_profile():
    from local_knowledge.evaluation import profile_compatible
    from local_knowledge.config import default_config,model_fingerprint
    config=default_config(); profile={'passed':True,'real_models':True,'reviewed':True,'dimension':2,'fingerprint':model_fingerprint(config,2)}
    assert profile_compatible(profile,config)
    config['rerank_endpoint']['score_transform']='sigmoid'
    assert not profile_compatible(profile,config)


@pytest.mark.parametrize('field,value',[('real_models',False),('cancelled',True),('wrong_hits',1)])
def test_cancelled_evaluation_cannot_activate(tmp_path,field,value):
    from local_knowledge.store import Store
    from local_knowledge.evaluation import EvaluationRunner
    store=Store(tmp_path)
    report={'passed':True,'real_models':True,'reviewed':True,'cancelled':False,'wrong_hits':0,'fingerprint':'model','dimension':2}
    report[field]=value
    store.save_profile('report',report)
    assert not EvaluationRunner(None,store).activate('report','model')


def test_real_models_required_flag(tmp_path):
    from local_knowledge.evaluation import EvaluationRunner
    from tests.knowledge.answer_harness import build_harness
    store,models,service,c=build_harness(tmp_path)
    assert EvaluationRunner(service,store).real_models is False
