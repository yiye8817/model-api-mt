import json
from tests.learning.test_graph import save_analysis
from tests.learning.test_questions import build_service
from tests.learning.test_jobs import wait_terminal


def test_concept_exploration_saved_with_separate_extension(store, source, chunks):
    save_analysis(store,source,chunks,'叠加','物理')
    class Model:
        def available(self): return {'available':True}
        def request(self,prompt,*args,**kwargs):
            evidence = json.loads(prompt.split('\nINPUT_JSON\n')[1])['evidence']
            return json.dumps({'principles':'线性组合', 'prerequisites':'向量', 'examples':'状态叠加', 'pitfalls':'概率不是振幅',
                'related':'干涉', 'questions':['如何观察？'], 'extension':'额外的教学说明',
                'citations':[{'chunk_id':evidence[0]['id'],'quote':evidence[0]['text']}]},ensure_ascii=False)
    service = build_service(store,Model())
    try:
        concept = service.graph.list_concepts({})['items'][0]
        job = service.explore(concept['id'])
        result = wait_terminal(store,job['id'])
        assert result['status'] == 'completed'
        record = result['result']['exploration']
        assert record['extension'] == '额外的教学说明'
        assert store.get_explorations(concept['id'])[0]['principles'] == '线性组合'
        assert record['citations'][0]['quote'] == chunks[0]['text']
    finally:
        service.jobs.shutdown()
