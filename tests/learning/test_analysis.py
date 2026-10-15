import copy
import json
import pytest

from learning.analysis import DocumentAnalyzer, validate_analysis
from learning.contracts import LearningError
from learning.jobs import LearningJobs, JobContext


def analysis_value(chunk, name='叠加', domain='物理'):
    citation = {'chunk_id': chunk['id'], 'quote': chunk['text'][:20]}
    return {'summary': '内容摘要', 'category': domain, 'tags': ['基础'],
        'tree': {'id':'root', 'label':'主题', 'children':[{'id':'node','label':name,'concept_id':'c','children':[],'citations':[citation]}]},
        'concepts':[{'id':'c','name':name,'domain':domain,'description':'状态的组合','aliases':[],'citations':[citation]}], 'relations':[]}


def context_for(store, doc):
    jobs = LearningJobs(store)
    job = store.create_job('analysis', {}, {doc['id']:doc['revision']})
    store.update_job(job['id'], status='running')
    import threading
    return jobs, JobContext(jobs, job['id'], threading.Event())


def test_analysis_covers_tail_and_preserves_previous_on_late_failure(store, source):
    chunks = [{'text': ('开头说明' if i == 0 else '末尾知识点')+'。'*8500,'position':{'kind':'lines'}} for i in range(2)]
    doc = store.upsert_document(source, chunks)
    class Model:
        fail = False
        def request(self, prompt, *args, **kwargs):
            data = json.loads(prompt.split('\nINPUT_JSON\n')[1])
            chunk = data['chunks'][0]
            if self.fail and '末尾' in chunk['text']:
                raise LearningError('第二批失败')
            return json.dumps(analysis_value(chunk, '尾部概念' if '末尾' in chunk['text'] else '开头概念'), ensure_ascii=False)
    model = Model(); analyzer = DocumentAnalyzer(store, model)
    jobs, context = context_for(store, doc)
    try:
        analyzer.run({'document_ids':[doc['id']]}, context)
        saved = store.get_analysis(doc['id'])
        assert saved['coverage'] == {'processed':2,'total':2}
        assert {c['name'] for c in saved['concepts']} == {'开头概念','尾部概念'}
        model.fail = True
        with pytest.raises(LearningError):
            analyzer.run({'document_ids':[doc['id']]}, context)
        assert store.get_analysis(doc['id'])['id'] == saved['id']
    finally:
        jobs.shutdown()


@pytest.mark.parametrize('break_kind', ['quote','id','endpoint','empty_quote'])
def test_invalid_model_evidence_or_structure_rejected(store, source, chunks, break_kind):
    doc = store.upsert_document(source, chunks)
    evidence = store.get_chunks(doc['id'],1)
    value = analysis_value(evidence[0])
    if break_kind == 'quote': value['concepts'][0]['citations'][0]['quote'] = '原文没有这句话'
    if break_kind == 'empty_quote': value['concepts'][0]['citations'][0]['quote'] = ''
    if break_kind == 'id': value['tree']['children'][0]['id'] = 'root'
    if break_kind == 'endpoint': value['relations'] = [{'source':'c','target':'missing','type':'related','citations':value['concepts'][0]['citations']}]
    with pytest.raises(LearningError):
        validate_analysis(value, evidence)


def test_model_tree_root_array_is_normalized_without_losing_evidence(store,source,chunks):
    doc=store.upsert_document(source,chunks);evidence=store.get_chunks(doc['id'],1)
    value=analysis_value(evidence[0]);value['tree']=[value['tree']]
    validated=validate_analysis(value,evidence)
    assert validated['tree']['id']=='root'
    assert validated['tree']['children'][0]['citations'][0]['quote']==chunks[0]['text'][:20]
