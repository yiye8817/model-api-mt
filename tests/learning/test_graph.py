from learning.graph import GraphService
from tests.learning.test_analysis import analysis_value
from learning.analysis import validate_analysis


def save_analysis(store, source, chunks, name, domain):
    doc = store.upsert_document(source, chunks)
    value = validate_analysis(analysis_value(store.get_chunks(doc['id'],1)[0], name, domain), store.get_chunks(doc['id'],1))
    value['coverage'] = {'processed':1,'total':1}
    store.commit_analysis(doc['id'],1,value,None)
    return doc


def test_shared_concepts_keep_other_sources_and_domains_separate(store, source, chunks):
    a = save_analysis(store, source, chunks, '叠加', '物理')
    b = save_analysis(store, {**source,'source_id':'b'}, chunks, '叠加', '物理')
    save_analysis(store, {**source,'source_id':'c'}, chunks, '叠加', '图像')
    graph = GraphService(store)
    concepts = graph.list_concepts({})['items']
    assert len(concepts) == 2
    physical = next(c for c in concepts if c['domain'] == '物理')
    assert set(physical['document_ids']) == {a['id'],b['id']}
    store.remove_document(a['id'])
    kept = graph.get_concept(physical['id'])
    assert kept['document_ids'] == [b['id']]
    assert graph.graph({})['coverage'] == {'analyzed':2,'total':2}


def test_updated_document_does_not_contribute_stale_graph(store, source, chunks):
    doc = save_analysis(store, source, chunks, '叠加','物理')
    store.upsert_document({**source,'content_hash':'new'}, chunks)
    assert store.get_analysis(doc['id'])['needs_update'] is True
    assert GraphService(store).list_concepts({})['total'] == 0
