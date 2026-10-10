import json
from dataclasses import replace
import tempfile
import unittest
from pathlib import Path
from flask import Flask
from knowledge.api import register_knowledge_routes
from knowledge.store import KnowledgeStore


class SemanticModels:
    config = {'embedding_endpoint': {'url': 'http://localhost', 'model': 'semantic-test', 'model_revision': 'v1'}, 'rerank_endpoint': {}, 'qa_endpoint': {}}
    def __init__(self):
        self.embedded = []
    def embed(self, texts, budget):
        self.embedded.extend(texts)
        return [[1.0, 0.0] if any(word in value for word in ('牛顿', '经典力学奠基人')) else [0.0, 1.0] for value in texts]
    def rerank(self, query, candidates, budget):
        return [replace(candidate, score=0.95 if '牛顿' in candidate.chunk.text else 0.1) for candidate in candidates]
    def json_chat(self, messages, schema, budget):
        value = json.loads(messages[-1]['content'])
        return {'answers_question': '牛顿' in value['answer'] and '爱因斯坦' not in value['question'], 'reason': '主题与内容适用'}


class Budget:
    def check(self):
        pass


def conversation(question='牛顿是谁？', answer='牛顿是英国物理学家。', constraints='', status='complete'):
    from local_knowledge.chat_sync import turn_hash
    return {'id': 'conv', 'model': 'demo', 'messages': [
        {'id': 'u', 'role': 'user', 'content': question},
        {'id': 'a', 'role': 'assistant', 'content': answer,
         'completion': {'status': status, 'kind': 'api', 'context': [], 'effective_constraints': constraints,
                        'origin_hash': turn_hash(question, answer, [], constraints)}},
    ]}


class SavedAnswerReuseTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = KnowledgeStore(Path(self.tmp.name) / 'library.sqlite3')

    def tearDown(self):
        self.tmp.cleanup()

    def test_repeat_question_uses_saved_answer_without_any_model(self):
        self.store.sync_conversations([conversation()])
        result = self.store.reuse(' 牛顿是谁? ', '')
        self.assertEqual(result['decision'], 'hit')
        self.assertEqual(result['answer'], '牛顿是英国物理学家。')
        self.assertEqual(result['answer_origin'], 'saved_answer')
        self.assertEqual(result['saved_entry']['fact_status'], 'unverified')

    def test_related_question_is_not_treated_as_the_same_question(self):
        self.store.sync_conversations([conversation()])
        self.assertEqual(self.store.reuse('牛顿有哪些贡献', '')['decision'], 'miss')
        self.assertEqual(self.store.reuse('牛顿是谁，用英语回答', '')['decision'], 'miss')

    def test_pronoun_followup_uses_previous_turn_context(self):
        self.store.sync_conversations([conversation(question='他和牛顿谁更厉害', answer='两人分别代表不同科学时代。')])
        result = self.store.reuse('他和牛顿谁更厉害', '', context=[
            {'role': 'user', 'content': '爱因斯坦是谁？'},
            {'role': 'assistant', 'content': '爱因斯坦是理论物理学家。'},
        ])
        self.assertEqual(result['decision'], 'hit')
        self.assertEqual(result['match_method'], 'normalized_question')

    def test_semantic_paraphrase_matches_without_shared_question_keywords(self):
        self.store.sync_conversations([conversation()])
        result = self.store.reuse('经典力学奠基人的简介', '', models=SemanticModels(), budget=Budget())
        self.assertEqual(result['decision'], 'hit')
        self.assertEqual(result['answer_origin'], 'saved_answer')
        self.assertEqual(result['match_method'], 'semantic')

    def test_semantically_related_but_different_entity_is_rejected(self):
        self.store.sync_conversations([conversation()])
        result = self.store.reuse('爱因斯坦是什么人', '', models=SemanticModels(), budget=Budget())
        self.assertEqual(result['decision'], 'miss')

    def test_document_embeddings_are_reused_across_paraphrased_queries(self):
        self.store.sync_conversations([conversation()])
        models = SemanticModels()
        self.store.reuse('介绍一下牛顿', '', models=models, budget=Budget())
        before = len(models.embedded)
        self.store.reuse('经典力学奠基人的简介', '', models=models, budget=Budget())
        self.assertEqual(len(models.embedded) - before, 1)

    def test_manual_correctness_is_respected_without_promoting_unknown_truth(self):
        self.store.sync_conversations([conversation()])
        self.store.annotate('history:conv:a', {'fact_status': 'incorrect'})
        self.assertEqual(self.store.reuse('牛顿是谁', '')['decision'], 'miss')
        self.store.annotate('history:conv:a', {'fact_status': 'uncertain'})
        self.assertEqual(self.store.reuse('牛顿是谁', '')['decision'], 'miss')
        self.store.annotate('history:conv:a', {'fact_status': 'correct'})
        self.assertEqual(self.store.reuse('牛顿是谁', '')['saved_entry']['fact_status'], 'correct')

    def test_changed_system_constraints_are_not_ignored(self):
        self.store.sync_conversations([conversation(constraints='中文回答')])
        self.assertEqual(self.store.reuse('牛顿是谁', '英文回答')['decision'], 'miss')
        self.assertEqual(self.store.reuse('牛顿是谁', '中文回答')['decision'], 'hit')

    def test_incomplete_or_unknown_completion_is_not_reused(self):
        for status in ('stopped', 'partial', 'error', 'unknown'):
            self.store.sync_conversations([conversation(status=status)])
            self.assertEqual(self.store.reuse('牛顿是谁', '')['decision'], 'miss')
        old = conversation()
        del old['messages'][1]['completion']
        self.store.sync_conversations([old])
        self.assertEqual(self.store.reuse('牛顿是谁', '')['decision'], 'miss')

    def test_explicitly_verified_legacy_answer_can_be_reused(self):
        old = conversation()
        del old['messages'][1]['completion']
        self.store.sync_conversations([old])
        self.store.annotate('history:conv:a', {'fact_status': 'correct'})
        self.assertEqual(self.store.reuse('牛顿是谁', '')['decision'], 'hit')

    def test_question_normalization_preserves_meaningful_math_symbols(self):
        self.store.sync_conversations([conversation(question='2+2=?', answer='4')])
        self.assertEqual(self.store.reuse('22?', '')['decision'], 'miss')
        self.assertEqual(self.store.reuse('2+2=？', '')['answer'], '4')

    def test_time_sensitive_and_context_dependent_questions_are_not_replayed(self):
        for question in ('今天的天气？', '他是谁？', '这是什么意思？', '最新的汇率？'):
            self.store.sync_conversations([conversation(question=question)])
            self.assertEqual(self.store.reuse(question, '')['decision'], 'miss', question)

    def test_confirmed_correct_answer_is_preferred(self):
        one = conversation(answer='人工核验过的答案')
        two = conversation(answer='另一条未核验回答')
        two['id'] = 'other'
        self.store.sync_conversations([one, two])
        self.store.annotate('history:conv:a', {'fact_status': 'correct'})
        self.assertEqual(self.store.reuse('牛顿是谁', '')['answer'], '人工核验过的答案')

    def test_replayed_copies_cannot_override_original_incorrect_annotation(self):
        original = conversation()
        replay = conversation()
        replay['id'] = 'copy'
        replay['messages'][1]['knowledge'] = {'origin': 'saved_answer', 'saved_entry': {'id': 'history:conv:a'}}
        self.store.sync_conversations([original, replay])
        self.store.annotate('history:conv:a', {'fact_status': 'incorrect'})
        self.assertEqual(self.store.reuse('牛顿是谁', '')['decision'], 'miss')

    def test_local_generated_reply_is_not_independent_reusable_evidence(self):
        conv = conversation()
        conv['messages'][1]['completion']['kind'] = 'local'
        conv['messages'][1]['knowledge'] = {'origin': 'local_generated', 'citations': [{'source_id': 'deleted-source'}]}
        self.store.sync_conversations([conv])
        self.assertEqual(self.store.reuse('牛顿是谁', '')['decision'], 'miss')

    def test_edited_generation_context_invalidates_saved_answer(self):
        conv = conversation()
        conv['messages'].insert(0, {'id': 'changed', 'role': 'user', 'content': '假设牛顿是我朋友'})
        self.store.sync_conversations([conv])
        self.assertEqual(self.store.reuse('牛顿是谁', '')['decision'], 'miss')

    def test_modified_answer_with_old_hash_is_not_reused(self):
        conv = conversation()
        conv['messages'][1]['content'] = '编辑后的未经复核回答'
        self.store.sync_conversations([conv])
        self.assertEqual(self.store.reuse('牛顿是谁', '')['decision'], 'miss')

    def test_source_policy_can_disallow_an_existing_answer(self):
        self.store.sync_conversations([conversation()])
        self.assertEqual(self.store.reuse('牛顿是谁', '', source_valid=lambda entry: False)['decision'], 'miss')

    def test_endpoint_loads_saved_conversations_and_has_standard_hit_contract(self):
        app = Flask(__name__)
        register_knowledge_routes(app, lambda: self.store, lambda: [conversation()], prefix='/api/content-library')
        client = app.test_client()
        payload = {'request_id': 'repeat', 'question': '牛顿是谁', 'system_constraints': '', 'source_ids': []}
        response = client.post('/api/content-library/reuse', json=payload)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()['request_id'], 'repeat')
        self.assertEqual(response.get_json()['decision'], 'hit')
        self.assertEqual(client.post('/api/content-library/reuse', json={**payload, 'source_ids': ['limited-source']}).get_json()['decision'], 'miss')


if __name__ == '__main__':
    unittest.main()
