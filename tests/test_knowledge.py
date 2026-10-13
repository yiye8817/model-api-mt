import json
import tempfile
import unittest
from pathlib import Path

from knowledge.store import KnowledgeStore


class KnowledgeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / 'knowledge.sqlite3'
        self.store = KnowledgeStore(self.path)

    def tearDown(self):
        self.tmp.cleanup()

    def load(self, rows, name='测试集', fmt='records'):
        return self.store.import_data(json.dumps(rows, ensure_ascii=False), fmt, name, 'https://example.org/dataset')

    def test_chinese_saved_qa_matches_question_before_unrelated_answer(self):
        self.load([
            {'id': 'a', 'kind': 'qa', 'question': '如何安装Python？', 'answer': '下载安装包并运行安装程序。'},
            {'id': 'b', 'kind': 'qa', 'question': '如何种植玫瑰？', 'answer': '先准备土壤。'},
        ])
        result = self.store.search('安装Python')
        self.assertEqual(result['results'][0]['question'], '如何安装Python？')
        self.assertGreater(result['results'][0]['match_score'], 0)
        self.assertEqual(self.store.search('量子纠缠')['results'], [])

    def test_fts_syntax_and_quotes_are_plain_query_text(self):
        self.load([{'kind': 'qa', 'question': 'Python安装', 'answer': '安装包'}])
        self.assertIsInstance(self.store.search('"Python" OR NEAR(*): 安装')['results'], list)

    def test_annotation_survives_reimport_and_new_instance(self):
        rows = [{'id': 'a', 'kind': 'qa', 'question': 'Python安装', 'answer': '下载软件'}]
        self.load(rows)
        entry = self.store.search('Python')['results'][0]
        self.store.annotate(entry['id'], {'fact_status': 'correct', 'source_name': '官方文档',
                                         'source_url': 'https://python.org/', 'tags': ['安装'], 'note': '已检查'})
        self.load(rows)
        saved = KnowledgeStore(self.path).search('Python')['results'][0]
        self.assertEqual(saved['fact_status'], 'correct')
        self.assertEqual(saved['source_name'], '官方文档')
        self.assertEqual(saved['original_source_name'], '测试集')
        self.assertEqual(saved['tags'], ['安装'])
        self.assertEqual(self.store.status()['entries'], 1)
        self.assertEqual(self.store.search('官方文档')['results'][0]['id'], entry['id'])

    def test_manual_correctness_priority_and_filters(self):
        self.load([{'id': str(i), 'kind': 'qa', 'question': 'Python安装', 'answer': f'安装说明{i}'} for i in range(3)])
        rows = self.store.search('Python')['results']
        self.store.annotate(rows[-1]['id'], {'fact_status': 'correct', 'tags': ['指南'], 'source_name': '手册'})
        result = self.store.search('Python', sort='verified', tag='指南', source='手册', fact_status='correct')
        self.assertEqual(result['total'], 1)
        self.assertEqual(result['results'][0]['id'], rows[-1]['id'])
        self.assertEqual(self.store.search('Python', sort='verified')['results'][0]['id'], rows[-1]['id'])

    def test_bad_import_is_atomic(self):
        with self.assertRaises(ValueError):
            self.load([{'kind': 'qa', 'question': '有效问题', 'answer': '答案'}, {'kind': 'qa', 'question': '缺答案'}])
        self.assertEqual(self.store.status()['entries'], 0)

    def test_invalid_annotation_does_not_mutate(self):
        self.load([{'kind': 'qa', 'question': '有效问题', 'answer': '答案'}])
        entry = self.store.search('')['results'][0]
        for patch in ({'fact_status': 'maybe'}, {'source_url': 'javascript:alert(1)'}, {'tags': '标签'}, {'unknown': True}):
            with self.assertRaises(ValueError):
                self.store.annotate(entry['id'], patch)
        self.assertEqual(self.store.get(entry['id'])['fact_status'], 'unverified')

    def test_massive_holdout_is_not_indexed(self):
        self.load([
            {'id': '1', 'utt': '打开卧室灯', 'intent': 'iot_hue_lighton', 'partition': 'train', 'locale': 'zh-CN'},
            {'id': '2', 'utt': '播放无关保留样例', 'intent': 'play_music', 'partition': 'test', 'locale': 'zh-CN'},
        ], fmt='massive')
        self.assertEqual(self.store.status()['entries'], 1)
        self.assertEqual(self.store.status()['evaluations'], 1)
        result = self.store.classify('打开卧室灯')
        self.assertEqual(result['intent'], '工具调用')
        self.assertEqual(result['native_label'], 'iot_hue_lighton')
        self.assertEqual(self.store.classify('播放无关保留样例')['intent'], '未知')
        self.assertEqual(self.store.classify('')['intent'], '未知')

    def test_duplicate_question_across_intent_split_is_excluded_from_evaluation(self):
        self.load([
            {'id': '1', 'utt': '打开卧室灯', 'intent': 'iot_hue_lighton', 'partition': 'train'},
            {'id': '2', 'utt': '打开卧室灯', 'intent': 'iot_hue_lighton', 'partition': 'test'},
        ], fmt='massive')
        report = self.store.evaluate()
        self.assertEqual(report['intent']['total'], 0)
        self.assertEqual(report['intent']['excluded_overlap'], 1)

    def test_cmrc_evaluation_uses_context_not_gold_question(self):
        cmrc = {'data': [{'title': '太阳', 'paragraphs': [
            {'context': '太阳是一颗恒星，位于太阳系中心。', 'qas': [{'id': 'q1', 'question': '太阳是一颗什么？', 'answers': [{'text': '恒星'}]}]},
            {'context': '玫瑰是观赏植物，通常长有刺。', 'qas': [{'id': 'q2', 'question': '玫瑰有什么？', 'answers': [{'text': '刺'}]}]},
        ]}]}
        self.load(cmrc, name='CMRC开发集', fmt='cmrc')
        rows = self.store.search('')['results']
        self.assertTrue(all(row['question'] not in ['太阳是一颗什么？', '玫瑰有什么？'] for row in rows))
        report = self.store.evaluate()
        self.assertEqual(report['qa']['total'], 2)
        self.assertEqual(report['qa']['hit_at_1'], 1.0)
        self.assertEqual(report['qa']['mrr_at_5'], 1.0)
        self.assertIsNotNone(KnowledgeStore(self.path).status()['last_evaluation'])

    def test_cmrc_training_import_saves_qa_without_evaluating_it(self):
        cmrc = {'data': [{'title': '太阳', 'paragraphs': [{'context': '太阳是一颗恒星。',
                 'qas': [{'id': 'q1', 'question': '太阳是什么？', 'answers': [{'text': '恒星'}]}]}]}]}
        self.store.import_data(json.dumps(cmrc, ensure_ascii=False), 'cmrc', 'CMRC训练集', '', partition='train')
        entry = self.store.search('太阳')['results'][0]
        self.assertEqual(entry['question'], '太阳是什么？')
        self.assertEqual(entry['answer'], '恒星')
        self.assertEqual(entry['context'], '太阳是一颗恒星。')
        self.assertEqual(self.store.status()['evaluations'], 0)

    def test_cmrc_generated_question_ids_have_unambiguous_boundaries(self):
        cmrc = {'data': [{'paragraphs': [
            {'context': 'c', 'qas': [{'question': 'ab', 'answers': [{'text': 'c'}]}]},
            {'context': 'bc', 'qas': [{'question': 'a', 'answers': [{'text': 'bc'}]}]},
        ]}]}
        self.load(cmrc, fmt='cmrc')
        self.assertEqual(self.store.status()['evaluations'], 2)

    def test_conflicting_train_and_test_id_is_rejected_atomically(self):
        row = {'id': '1', 'utt': '打开卧室灯', 'intent': 'iot_hue_lighton', 'partition': 'train'}
        with self.assertRaises(ValueError):
            self.load([row, {**row, 'partition': 'test'}], fmt='massive')
        self.assertEqual(self.store.status()['entries'], 0)

    def test_benchmark_ignores_private_history_and_manual_status(self):
        self.load([{'kind': 'intent', 'id': 'train', 'question': '开灯', 'intent': '工具调用', 'split': 'train'},
                   {'kind': 'intent', 'id': 'test', 'question': '打开灯', 'intent': '工具调用', 'split': 'test'}])
        self.store.sync_conversations([self.conversation('打开灯', '灯已打开')])
        for entry in self.store.search('')['results']:
            self.store.annotate(entry['id'], {'fact_status': 'incorrect'})
        report = self.store.evaluate()
        self.assertEqual(report['intent']['total'], 1)

    def conversation(self, question='怎么安装Python', answer='下载Python安装包'):
        return {'id': 'conv', 'title': 'Python', 'messages': [
            {'id': 'u1', 'role': 'user', 'content': question},
            {'id': 'a1', 'role': 'assistant', 'content': answer, 'timestamp': 123},
        ]}

    def test_history_sync_edit_delete_and_annotation_preservation(self):
        conv = self.conversation()
        self.store.sync_conversations([conv])
        item = self.store.search('Python', scope='history')['results'][0]
        self.store.annotate(item['id'], {'fact_status': 'correct'})
        conv['messages'][1]['content'] = '使用新版Python安装包'
        self.store.sync_conversations([conv])
        edited = self.store.get(item['id'])
        self.assertEqual(edited['answer'], '使用新版Python安装包')
        self.assertEqual(edited['fact_status'], 'correct')
        self.store.sync_conversations([])
        self.assertEqual(self.store.search('Python', scope='history')['results'], [])

    def test_history_failure_and_inflight_responses_are_excluded(self):
        conversations = []
        for i, answer in enumerate(['', '❌ 请求失败', '⏹️ 已停止', '正在生成']):
            conv = self.conversation(answer=answer)
            conv['id'] = str(i)
            if i == 3:
                conv['messages'][1]['webChat'] = {'status': 'running'}
            conversations.append(conv)
        self.store.sync_conversations(conversations)
        self.assertEqual(self.store.status()['entries'], 0)

    def test_stopped_partial_history_is_not_a_complete_answer(self):
        conv = self.conversation(answer='这是部分回复\n\n⏹️ _已停止_')
        self.store.sync_conversations([conv])
        self.assertEqual(self.store.status()['entries'], 0)

    def test_reimport_train_sample_as_holdout_removes_searchable_copy(self):
        row = {'id': '1', 'utt': '打开卧室灯', 'intent': 'iot_hue_lighton', 'partition': 'train'}
        self.load([row], fmt='massive')
        self.load([{**row, 'partition': 'test'}], fmt='massive')
        self.assertEqual(self.store.status()['entries'], 0)
        self.assertEqual(self.store.status()['evaluations'], 1)
        self.assertEqual(self.store.classify('打开卧室灯')['intent'], '未知')
        self.load([row], fmt='massive')
        self.assertEqual(self.store.status()['evaluations'], 0)

    def test_cmrc_context_count_limit_is_enforced_without_qa(self):
        from unittest.mock import patch
        cmrc = {'data': [{'paragraphs': [{'context': str(i), 'qas': []} for i in range(4)]}]}
        with patch('knowledge.datasets.MAX_ROWS', 3), self.assertRaises(ValueError):
            self.load(cmrc, fmt='cmrc')

    def test_manual_qa_is_not_removed_by_history_sync(self):
        entry = self.store.add({'kind': 'qa', 'question': '自有Python笔记', 'answer': '安装记录'})
        self.store.sync_conversations([])
        self.assertEqual(self.store.get(entry['id'])['question'], '自有Python笔记')
        self.assertEqual(self.store.get(entry['id'])['fact_status'], 'unverified')

    def test_public_benchmark_is_unchanged_by_source_and_tag_annotations(self):
        self.load([{'kind': 'intent', 'id': 'a', 'question': '打开灯', 'intent': '工具调用'},
                   {'kind': 'intent', 'id': 'b', 'question': '新闻', 'intent': '讯息'},
                   {'kind': 'intent', 'id': 'c', 'question': '查看天气预报', 'intent': '讯息', 'split': 'test'}])
        before = self.store.evaluate()['intent']
        for entry in self.store.search('', kind='intent')['results']:
            self.store.annotate(entry['id'], {'tags': ['查看天气预报'], 'source_name': '查看天气预报'})
        self.assertEqual(self.store.evaluate()['intent'], before)

    def test_baseline_retrieval_cannot_use_manually_added_gold_query_tag(self):
        self.load([{'kind': 'qa', 'question': 'Python安装', 'answer': '下载安装包'}])
        entry = self.store.search('')['results'][0]
        self.store.annotate(entry['id'], {'tags': ['量子纠缠']})
        self.assertEqual(self.store.search('量子纠缠', baseline=True)['results'], [])
        self.assertEqual(self.store.search('量子纠缠')['total'], 1)

    def test_invalid_search_kind_is_rejected(self):
        with self.assertRaises(ValueError):
            self.store.search('test', kind=[])

    def test_inferred_ids_do_not_collide_for_different_question_answer_boundaries(self):
        self.load([{'question': 'ab', 'answer': 'c'}])
        first = self.store.search('')['results'][0]
        self.store.annotate(first['id'], {'fact_status': 'correct'})
        self.load([{'question': 'a', 'answer': 'bc'}])
        self.assertEqual(self.store.status()['entries'], 2)
        self.assertEqual(self.store.get(first['id'])['question'], 'ab')
        newer = next(row for row in self.store.search('')['results'] if row['question'] == 'a')
        self.assertEqual(newer['fact_status'], 'unverified')


if __name__ == '__main__':
    unittest.main()
