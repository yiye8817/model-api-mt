"""SQLite is authoritative; vector results must be rechecked here."""
import json
import sqlite3
import threading
import time
import uuid
from dataclasses import asdict
from pathlib import Path

from .contracts import Source, Chunk, chunk_from_dict
from .config import stable_hash


class StoreUnavailable(RuntimeError):
    pass


def dumps(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False)


class Store:
    def __init__(self, data_dir: Path):
        self.data_dir = Path(data_dir)
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self._local = threading.local()
        self._lock = threading.RLock()
        conn = self.connection
        try:
            conn.executescript(Path(__file__).with_name('schema.sql').read_text())
            self._init_fts(conn)
        except sqlite3.Error as exc:
            conn.close()
            self._local.connection = None
            raise StoreUnavailable(f'Local knowledge requires SQLite FTS5: {exc}') from exc

    def _init_fts(self, conn):
        conn.execute('CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(chunk_id UNINDEXED, keywords, tokenize="unicode61")')
        conn.commit()

    @property
    def connection(self):
        conn = getattr(self._local, 'connection', None)
        if conn is None:
            conn = sqlite3.connect(self.data_dir / 'knowledge.sqlite3', timeout=5)
            conn.row_factory = sqlite3.Row
            conn.execute('PRAGMA foreign_keys=ON')
            conn.execute('PRAGMA journal_mode=WAL')
            conn.execute('PRAGMA busy_timeout=5000')
            self._local.connection = conn
        return conn

    def get_source(self, source_id: str) -> Source | None:
        row = self.connection.execute('SELECT * FROM sources WHERE id=?', (source_id,)).fetchone()
        if row is None:
            return None
        body = json.loads(row['body'])
        body.update(revision=row['revision'], enabled=bool(row['enabled']), status=row['status'])
        return Source(**body)

    def list_sources(self, include_deleted=False) -> list[Source]:
        sql = 'SELECT id FROM sources' + ('' if include_deleted else " WHERE status!='deleted'") + ' ORDER BY id'
        return [self.get_source(row['id']) for row in self.connection.execute(sql)]

    def _invalidate_cache(self, conn, source_id):
        conn.execute('DELETE FROM answer_cache WHERE fingerprint IN (SELECT fingerprint FROM cache_dependencies WHERE source_id=?)', (source_id,))

    def upsert_pending(self, source: Source, chunks) -> int:
        with self._lock, self.connection as conn:
            old = self.get_source(source.id)
            if old and old.content_hash == source.content_hash and old.status not in ('deleted', 'stale'):
                return old.revision
            revision = old.revision + 1 if old else 1
            source.revision = revision
            source.status = 'pending'
            if old:
                source.enabled = old.enabled
            self._invalidate_cache(conn, source.id)
            conn.execute('INSERT OR REPLACE INTO sources VALUES(?,?,?,?,?,?)',
                         (source.id, revision, source.content_hash, int(source.enabled), source.status, dumps(asdict(source))))
            conn.execute("UPDATE chunks SET status='obsolete' WHERE source_id=?", (source.id,))
            conn.execute('DELETE FROM chunks_fts WHERE chunk_id IN (SELECT id FROM chunks WHERE source_id=?)', (source.id,))
            for ordinal, chunk in enumerate(chunks):
                chunk.source_id, chunk.revision, chunk.ordinal = source.id, revision, ordinal
                chunk.id = stable_hash([source.id, revision, ordinal, chunk.text])
                chunk.status = 'pending'
                conn.execute('INSERT OR REPLACE INTO chunks VALUES(?,?,?,?,?,?)',
                             (chunk.id, source.id, revision, ordinal, chunk.status, dumps(asdict(chunk))))
                conn.execute('INSERT INTO chunks_fts(chunk_id,keywords) VALUES(?,?)', (chunk.id, chunk.keyword_text or chunk.text))
            return revision

    def activate_revision(self, source_id, revision) -> bool:
        with self._lock, self.connection as conn:
            row = conn.execute("UPDATE sources SET status='indexed' WHERE id=? AND revision=? AND status='pending'", (source_id, revision))
            if row.rowcount == 0:
                return False
            conn.execute("UPDATE chunks SET status='indexed' WHERE source_id=? AND revision=?", (source_id, revision))
            return True

    def set_enabled(self, source_id, enabled):
        with self._lock, self.connection as conn:
            conn.execute('UPDATE sources SET enabled=? WHERE id=?', (int(enabled), source_id))
            if not enabled:
                self._invalidate_cache(conn, source_id)

    def invalidate_source(self, source_id, status='deleted'):
        with self._lock, self.connection as conn:
            conn.execute('UPDATE sources SET enabled=0,status=? WHERE id=?', (status, source_id))
            conn.execute("UPDATE chunks SET status='obsolete' WHERE source_id=?", (source_id,))
            self._invalidate_cache(conn, source_id)

    def revision_chunks(self, source_id, revision):
        return [chunk_from_dict(json.loads(r['body'])) for r in self.connection.execute(
            'SELECT body FROM chunks WHERE source_id=? AND revision=? ORDER BY ordinal', (source_id, revision))]

    def visible_chunks(self, source_ids=None):
        if source_ids == []:
            return []
        sql = "SELECT c.body FROM chunks c JOIN sources s ON s.id=c.source_id WHERE s.enabled=1 AND s.status='indexed' AND c.status='indexed' AND c.revision=s.revision"
        args = []
        if source_ids is not None:
            sql += ' AND s.id IN (' + ','.join('?' for _ in source_ids) + ')'
            args.extend(source_ids)
        sql += ' ORDER BY c.source_id,c.ordinal'
        return [chunk_from_dict(json.loads(row['body'])) for row in self.connection.execute(sql, args)]

    def get_chunk(self, chunk_id):
        row = self.connection.execute('SELECT body FROM chunks WHERE id=?', (chunk_id,)).fetchone()
        return chunk_from_dict(json.loads(row['body'])) if row else None

    def dependencies_current(self, deps) -> bool:
        if not deps:
            return False
        for source_id, revision in deps.items():
            s = self.get_source(source_id)
            if not s or not s.enabled or s.status != 'indexed' or s.revision != revision or (s.valid_until is not None and s.valid_until <= time.time()):
                return False
        return True

    def put_cache(self, fingerprint, result, deps, model_fingerprint, valid_until=None):
        with self._lock, self.connection as conn:
            if not self.dependencies_current(deps):
                return False
            conn.execute('INSERT OR REPLACE INTO answer_cache VALUES(?,?,?,?)', (fingerprint, model_fingerprint, valid_until, dumps(result)))
            conn.execute('DELETE FROM cache_dependencies WHERE fingerprint=?', (fingerprint,))
            conn.executemany('INSERT INTO cache_dependencies VALUES(?,?,?)', [(fingerprint, k, v) for k,v in deps.items()])
            return True

    def get_cache(self, fingerprint, model_fingerprint):
        row = self.connection.execute('SELECT * FROM answer_cache WHERE fingerprint=? AND model_fingerprint=?', (fingerprint,model_fingerprint)).fetchone()
        if row is None or row['valid_until'] is not None and row['valid_until'] <= time.time():
            return None
        deps = {r['source_id']:r['revision'] for r in self.connection.execute('SELECT source_id,revision FROM cache_dependencies WHERE fingerprint=?', (fingerprint,))}
        return json.loads(row['body']) if self.dependencies_current(deps) else None

    def create_job(self, kind, payload):
        job_id = uuid.uuid4().hex
        body = dict(id=job_id,kind=kind,status='queued',phase='queued',completed=0,total=0,succeeded=0,skipped=0,failed=0,cancel_requested=False,items=[],result=None,payload=payload)
        with self.connection as conn:
            conn.execute('INSERT INTO index_jobs VALUES(?,?,?)', (job_id,'queued',dumps(body)))
        return job_id

    def job(self, job_id):
        row = self.connection.execute('SELECT body FROM index_jobs WHERE id=?', (job_id,)).fetchone()
        return json.loads(row['body']) if row else None

    def update_job(self, job_id, **changes):
        with self._lock, self.connection as conn:
            job = self.job(job_id)
            if job is None:
                raise KeyError(job_id)
            job.update(changes)
            conn.execute('UPDATE index_jobs SET status=?,body=? WHERE id=?', (job['status'],dumps(job),job_id))
            return job

    def unfinished_jobs(self):
        return [json.loads(r['body']) for r in self.connection.execute("SELECT body FROM index_jobs WHERE status NOT IN ('done','failed','cancelled')")]

    def request(self, request_id):
        row = self.connection.execute('SELECT body FROM request_runs WHERE id=?', (request_id,)).fetchone()
        if row is None:
            return None
        body = json.loads(row['body'])
        body['online_model_requests'] = self.connection.execute('SELECT count(*) FROM online_calls WHERE request_id=?', (request_id,)).fetchone()[0]
        return body

    def update_request(self, request_id, **changes):
        with self._lock, self.connection as conn:
            body = self.request(request_id) or dict(request_id=request_id, stage='queued',trace=[],decision=None,cancelled=False,duration_ms=0)
            body.update(changes)
            conn.execute('INSERT OR REPLACE INTO request_runs VALUES(?,?)', (request_id,dumps(body)))
            return body

    def record_online_call(self, request_id, call_id, kind, model):
        if request_id:
            with self.connection as conn:
                conn.execute('INSERT OR IGNORE INTO online_calls VALUES(?,?,?,?)', (request_id,call_id,kind,model))

    def save_profile(self, profile_id, body):
        with self.connection as conn:
            conn.execute('INSERT OR REPLACE INTO evaluation_profiles VALUES(?,?)', (profile_id,dumps(body)))

    def profile(self, profile_id):
        row = self.connection.execute('SELECT body FROM evaluation_profiles WHERE id=?', (profile_id,)).fetchone()
        return json.loads(row['body']) if row else None
