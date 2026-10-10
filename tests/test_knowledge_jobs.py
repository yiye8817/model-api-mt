import tempfile
import time
import unittest
from pathlib import Path

from local_knowledge.ingest import ImportManager
from local_knowledge.store import Store


class KnowledgeJobProgressTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = Store(Path(self.tmp.name))

    def tearDown(self):
        self.tmp.cleanup()

    def test_new_job_has_persisted_progress_contract(self):
        job_id = self.store.create_job("paths", {"roots": ["/tmp/docs"]})
        job = self.store.job(job_id)

        self.assertEqual(job["stage"], "queued")
        self.assertEqual(job["current_item"], "")
        self.assertEqual(job["bytes_total"], 0)
        self.assertEqual(job["bytes_completed"], 0)
        self.assertEqual(job["chunks_total"], 0)
        self.assertEqual(job["chunks_completed"], 0)
        self.assertEqual(job["batches_total"], 0)
        self.assertEqual(job["batches_completed"], 0)
        self.assertIsInstance(job["started_at"], float)
        self.assertIsInstance(job["updated_at"], float)
        self.assertIsNone(job["finished_at"])
        self.assertEqual(job["last_error"], "")
        self.assertTrue(job["notification_key"])

    def test_progress_updates_are_persisted_and_counters_do_not_go_backwards(self):
        job_id = self.store.create_job("paths", {})
        first = self.store.update_job_progress(job_id, {
            "stage": "embedding",
            "current_item": "manual.md",
            "bytes_total": 100,
            "bytes_completed": 60,
            "chunks_total": 8,
            "chunks_completed": 4,
            "batches_total": 2,
            "batches_completed": 1,
        })
        second = self.store.update_job_progress(job_id, {
            "bytes_completed": 20,
            "chunks_completed": 2,
            "batches_completed": 0,
        })

        self.assertEqual(first["stage"], "embedding")
        self.assertEqual(second["bytes_completed"], 60)
        self.assertEqual(second["chunks_completed"], 4)
        self.assertEqual(second["batches_completed"], 1)
        self.assertEqual(self.store.job(job_id)["current_item"], "manual.md")

    def test_active_jobs_and_terminal_updates_are_idempotent(self):
        active_id = self.store.create_job("paths", {})
        done_id = self.store.create_job("paths", {})
        self.store.update_job(done_id, status="done", stage="done", phase="done", finished_at=time.time())

        self.assertEqual([j["id"] for j in self.store.active_jobs()], [active_id])
        terminal = self.store.update_job_progress(done_id, {"stage": "embedding", "bytes_completed": 5})
        self.assertEqual(terminal["status"], "done")
        self.assertEqual(terminal["stage"], "done")

    def test_restart_recovery_resumes_reindex_once(self):
        job_id = self.store.create_job("reindex", {"source_id": "source-1", "revision": 2})
        self.store.update_job(job_id, status="running", stage="embedding")
        calls = []
        manager = ImportManager(self.store, index_revision=lambda source, revision, budget: calls.append((source, revision)))
        try:
            manager.recover()
            deadline = time.time() + 2
            while time.time() < deadline and self.store.job(job_id)["status"] != "done":
                time.sleep(0.01)
            self.assertEqual(self.store.job(job_id)["status"], "done")
            self.assertEqual(calls, [("source-1", 2)])
        finally:
            manager.close()


if __name__ == "__main__":
    unittest.main()
