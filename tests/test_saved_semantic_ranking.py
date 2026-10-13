from knowledge.reuse import semantic_rank
from knowledge.store import KnowledgeStore


QUESTION = '经典力学的奠基人是谁？'


class SemanticModels:
    config = {'embedding_endpoint': {'model': 'saved-ranking-test'}}

    def embed(self, texts, budget):
        return [[1.0, 0.0] if text == QUESTION or '牛顿' in text else [0.0, 1.0]
                for text in texts]

    def rerank(self, question, candidates, budget):
        # Preserve the cosine shortlist so reranking cannot recover an omitted match.
        return candidates


class Budget:
    def check(self):
        pass


def saved_entries():
    return [{'id': 'newton', 'question': '牛顿是谁？', 'answer': '牛顿是经典力学的奠基人。'}] + [
        {'id': f'unrelated-{index}', 'question': f'菜谱 {index} 的做法？', 'answer': '先准备食材，再烹饪。'}
        for index in range(24)
    ]


def test_cold_cache_keeps_query_match_in_rerank_shortlist(tmp_path):
    store = KnowledgeStore(tmp_path / 'library.sqlite3')

    ranked = semantic_rank(store, QUESTION, saved_entries(), SemanticModels(), Budget())

    assert len(ranked) == 20
    assert ranked[0]['id'] == 'newton'
    assert ranked[0]['match_method'] == 'semantic'


def test_cold_and_warm_cache_produce_same_query_ranking(tmp_path):
    store = KnowledgeStore(tmp_path / 'library.sqlite3')
    entries = saved_entries()
    models = SemanticModels()

    cold = semantic_rank(store, QUESTION, entries, models, Budget())
    warm = semantic_rank(store, QUESTION, entries, models, Budget())

    assert cold == warm
    assert warm[0]['id'] == 'newton'
