import json
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from knowledge.jobs import ImportJobManager
from knowledge.store import KnowledgeStore


class KnowledgeJobTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tmp.name) / 'knowledge.sqlite3'
        self.store = KnowledgeStore(self.db_path)
        self.manager = ImportJobManager(self.store, lambda: [], Path(self.tmp.name) / 'imports')

    def tearDown(self):
        self.manager.shutdown()
        self.tmp.cleanup()

    def wait_for(self, job_id, statuses=('completed', 'failed', 'cancelled'), timeout=5):
        deadline = time.time() + timeout
        while time.time() < deadline:
            job = self.store.get_import_job(job_id)
            if job['status'] in statuses:
                return job
            time.sleep(0.02)
        self.fail(f'timed out waiting for {job_id}: {self.store.get_import_job(job_id)}')

    def test_schema_and_completed_text_job_persist_progress(self):
        job_id = self.manager.submit({
            'format': 'text', 'name': '说明文档', 'chunk_size': 200, 'chunk_overlap': 50,
        }, content=('第一段内容。' * 80).encode(), filename='guide.txt')
        queued = self.store.get_import_job(job_id)
        self.assertIn(queued['status'], ('queued', 'running'))
        self.assertEqual(queued['phase'], 'reading')
        job = self.wait_for(job_id)
        self.assertEqual(job['status'], 'completed')
        self.assertEqual(job['phase'], 'completed')
        self.assertGreater(job['imported'], 0)
        self.assertEqual(job['processed'], job['total'])
        self.assertIsNone(job['error'])
        self.assertGreater(self.store.status()['entries'], 0)

    def test_malformed_late_record_fails_without_partial_entries(self):
        job_id = self.manager.submit({
            'format': 'records', 'name': '错误记录',
        }, content=json.dumps([
            {'kind': 'qa', 'question': '有效问题', 'answer': '有效答案'}, {},
        ]).encode(), filename='bad.json')
        job = self.wait_for(job_id, statuses=('failed',))
        self.assertEqual(job['status'], 'failed')
        self.assertIn('第 2 条', job['error'])
        self.assertEqual(self.store.status()['entries'], 0)

    def test_recovery_marks_queued_and_running_jobs_failed(self):
        queued = self.store.create_import_job({'format': 'text', 'name': 'queued'}, None)
        running = self.store.create_import_job({'format': 'text', 'name': 'running'}, None)
        self.store.update_import_job(queued['id'], status='queued')
        self.store.update_import_job(running['id'], status='running', phase='chunking')
        recovered = self.store.recover_import_jobs()
        self.assertEqual(recovered, 2)
        for job_id in (queued['id'], running['id']):
            job = self.store.get_import_job(job_id)
            self.assertEqual(job['status'], 'failed')
            self.assertIn('服务重启', job['error'])

    def test_cancel_during_embedding_does_not_commit_batch(self):
        provider = {'id': 'p1', 'name': 'stub', 'baseUrl': 'http://stub', 'apiKey': 'key', 'models': ['embed']} 
        content = ('会触发取消的长文档。' * 100).encode()
        def slow_embed(_provider, _model, texts, timeout=120):
            time.sleep(0.2)
            return [[1.0, 0.0] for _ in texts]
        manager = ImportJobManager(self.store, lambda: [provider], Path(self.tmp.name) / 'cancel-imports')
        try:
            with patch('knowledge.jobs.embed_texts', slow_embed):
                job_id = manager.submit({
                'format': 'text', 'name': '取消文档', 'provider_id': 'p1',
                    'embedding_model': 'embed', 'chunk_size': 200, 'chunk_overlap': 50,
                }, content=content, filename='cancel.txt')
                time.sleep(0.03)
                manager.cancel(job_id)
                job = self.wait_for(job_id, statuses=('cancelled', 'failed'))
                self.assertEqual(job['status'], 'cancelled')
                self.assertEqual(self.store.status()['entries'], 0)
        finally:
            manager.shutdown()

    def test_raw_chunks_have_stable_ids_and_rerank_config_is_saved(self):
        payload = {'format': 'markdown', 'name': '知识文档', 'rerank_model': 'rerank-v1'}
        job_id = self.manager.submit(payload, content=('# 标题\n' + '正文。' * 100).encode(), filename='doc.md')
        job = self.wait_for(job_id)
        self.assertEqual(job['status'], 'completed')
        self.assertEqual(job['config']['rerank_model'], 'rerank-v1')
        with self.store.connection() as db:
            ids = [row['id'] for row in db.execute("SELECT id FROM entries WHERE id LIKE 'document:%:chunk:%'")]
        self.assertTrue(ids)
        self.assertEqual(ids, sorted(ids))


if __name__ == '__main__':
    unittest.main()
