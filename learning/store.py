"""Transactional document snapshots; no model runtime is needed to read them."""
from contextlib import contextmanager
import json
from pathlib import Path
import sqlite3
import threading
import uuid
import unicodedata

from .contracts import LearningError, digest, dumps, now, paginate, text


class LearningStore:
    def __init__(self, data_dir):
        self.data_dir = Path(data_dir)
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        with self.connection() as db:
            db.executescript(Path(__file__).with_name('schema.sql').read_text())

    @contextmanager
    def connection(self):
        with self.lock:
            db = sqlite3.connect(self.data_dir/'learning.sqlite3', timeout=10)
            db.row_factory = sqlite3.Row
            db.execute('PRAGMA foreign_keys=ON')
            try:
                with db:
                    yield db
            finally:
                db.close()

    def _document(self, db, document_id, include_deleted=False):
        row = db.execute('SELECT * FROM documents WHERE id=?', (document_id,)).fetchone()
        if not row or (row['deleted'] and not include_deleted):
            raise LearningError('文档不存在或已移除', 404)
        doc = json.loads(row['body'])
        doc.update(id=row['id'], revision=row['revision'], content_hash=row['content_hash'])
        doc['sources'] = [json.loads(r['body']) for r in db.execute('SELECT body FROM document_sources WHERE document_id=?', (document_id,))]
        return doc

    def get_document(self, document_id):
        with self.connection() as db:
            return self._document(db, document_id)

    def upsert_document(self, source, chunks):
        origin = text(source.get('origin', 'learning'), '来源', 100)
        source_key = origin + ':' + text(source.get('source_id'), '来源 ID', 500)
        if not isinstance(chunks, list) or not chunks or any(not isinstance(c, dict) or not isinstance(c.get('text'), str) for c in chunks):
            raise LearningError('文档必须包含可读取的正文片段')
        content_hash = source.get('content_hash') or digest(dumps(chunks))
        with self.connection() as db:
            if db.execute('SELECT 1 FROM excluded_sources WHERE source_id=?', (source_key,)).fetchone():
                return None
            previous = db.execute('SELECT document_id FROM document_sources WHERE source_id=?', (source_key,)).fetchone()
            doc_id = previous['document_id'] if previous else digest(source_key)[:32]
            old = self._document(db, doc_id, True) if previous else None
            revision = old['revision'] if old else 0
            changed = not old or old['content_hash'] != content_hash
            if changed:
                revision += 1
            manual = old.get('manual', []) if old else []
            doc = {**(old or {}), 'id': doc_id, 'title': source.get('title') or '未命名文档',
                   'category': (old or {}).get('category', ''), 'tags': (old or {}).get('tags', []),
                   'manual': manual, 'status': 'needs_update' if old and old.get('analysis_id') and changed else 'pending',
                   'analysis_id': (old or {}).get('analysis_id'), 'warnings': source.get('warnings', []),
                   'updated_at': now(), 'created_at': (old or {}).get('created_at', now())}
            if old:
                for key in manual:
                    doc[key] = old[key]
                if not changed:
                    doc['status'] = old['status']
            doc.pop('sources', None)
            db.execute('INSERT INTO documents VALUES(?,?,?,?,0) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,content_hash=excluded.content_hash,body=excluded.body,deleted=0',
                       (doc_id, revision, content_hash, dumps(doc)))
            db.execute('INSERT OR REPLACE INTO document_sources VALUES(?,?,?,?)', (source_key, doc_id, origin, dumps({**source, 'chunks': None, 'origin': origin, 'source_key': source_key})))
            if changed:
                db.execute('INSERT INTO revisions VALUES(?,?,?)', (doc_id, revision, dumps({'content_hash': content_hash, 'created_at': now()})))
                from local_knowledge.text import keyword_tokens
                for i, value in enumerate(chunks):
                    chunk_id = digest(f'{doc_id}:{revision}:{i}')[:40]
                    chunk = {**value, 'id': chunk_id, 'document_id': doc_id, 'revision': revision, 'ordinal': i, 'title': doc['title']}
                    db.execute('INSERT INTO chunks VALUES(?,?,?,?,?)', (chunk_id, doc_id, revision, i, dumps(chunk)))
                    db.execute('INSERT INTO chunks_fts VALUES(?,?)', (chunk_id, ' '.join(keyword_tokens(chunk['text']))))
            return self._document(db, doc_id)

    def list_documents(self, filters, page=1, page_size=30):
        with self.connection() as db:
            docs = [self._document(db, r['id']) for r in db.execute('SELECT id FROM documents WHERE deleted=0')]
        q = str(filters.get('q', '')).casefold()
        docs = [d for d in docs if (not q or q in (d['title']+' '+d['category']+' '+' '.join(d['tags'])).casefold())
                and (not filters.get('category') or d['category'] == filters['category'])
                and (not filters.get('status') or d['status'] == filters['status'])
                and (not filters.get('origin') or any(s['origin'] == filters['origin'] for s in d['sources']))]
        docs.sort(key=lambda d: d['updated_at'], reverse=True)
        return paginate(docs, page, page_size)

    def get_chunks(self, document_id, revision):
        with self.connection() as db:
            self._document(db, document_id)
            return [json.loads(r['body']) for r in db.execute('SELECT body FROM chunks WHERE document_id=? AND revision=? ORDER BY ordinal', (document_id, revision))]

    def update_document(self, document_id, patch):
        if not isinstance(patch, dict) or not patch or set(patch) - {'title', 'category', 'tags'}:
            raise LearningError('仅支持修改标题、分类和标签')
        with self.connection() as db:
            doc = self._document(db, document_id)
            for key, value in patch.items():
                if key == 'tags':
                    if not isinstance(value, list) or len(value) > 30:
                        raise LearningError('标签最多 30 项')
                    value = list(dict.fromkeys(text(t, '标签', 80) for t in value))
                else:
                    value = text(value, key, 300, required=key == 'title')
                doc[key] = value
            doc['manual'] = list(set(doc.get('manual', [])) | set(patch))
            doc['updated_at'] = now()
            db.execute('UPDATE documents SET body=? WHERE id=?', (dumps(doc), document_id))
            return self._document(db, document_id)

    def remove_document(self, document_id):
        with self.connection() as db:
            doc = self._document(db, document_id)
            for source in doc['sources']:
                db.execute('INSERT OR IGNORE INTO excluded_sources VALUES(?)', (source['source_key'],))
            db.execute('UPDATE documents SET deleted=1 WHERE id=?', (document_id,))

    def resolve_scope(self, scope):
        if not isinstance(scope, dict) or scope.get('mode') not in ('all', 'selected'):
            raise LearningError('必须明确选择提问资料范围')
        ids = scope.get('document_ids', [])
        if scope['mode'] == 'selected' and (not isinstance(ids, list) or not ids or any(not isinstance(x, str) for x in ids)):
            raise LearningError('请选择至少一份文档')
        with self.connection() as db:
            if scope['mode'] == 'all':
                ids = [r['id'] for r in db.execute('SELECT id FROM documents WHERE deleted=0')]
            result = {i: self._document(db, i)['revision'] for i in ids}
        if not result:
            raise LearningError('还没有可用资料')
        return result

    def revisions_current(self, revisions):
        with self.connection() as db:
            for doc_id, revision in revisions.items():
                row = db.execute('SELECT revision,deleted FROM documents WHERE id=?', (doc_id,)).fetchone()
                if not row or row['deleted'] or row['revision'] != revision:
                    return False
        return True

    def create_job(self, kind, payload, revisions, dedupe_key=None):
        job = {'id': uuid.uuid4().hex, 'kind': kind, 'payload': payload, 'document_revisions': revisions,
               'dedupe_key': dedupe_key, 'status':'queued', 'phase':'queued', 'processed':0, 'total':0,
               'message':'等待处理', 'error':None, 'result':None, 'created_at':now(), 'updated_at':now()}
        with self.connection() as db:
            db.execute('INSERT INTO jobs VALUES(?,?,?)', (job['id'], job['status'], dumps(job)))
        return job

    def get_job(self, job_id):
        with self.connection() as db:
            row = db.execute('SELECT body FROM jobs WHERE id=?', (job_id,)).fetchone()
            if not row:
                raise LearningError('任务不存在', 404)
            return json.loads(row['body'])

    def active_jobs(self):
        with self.connection() as db:
            return [json.loads(r['body']) for r in db.execute("SELECT body FROM jobs WHERE status IN ('queued','running')")]

    def update_job(self, job_id, **patch):
        with self.connection() as db:
            row = db.execute('SELECT body FROM jobs WHERE id=?', (job_id,)).fetchone()
            if not row:
                raise LearningError('任务不存在', 404)
            job = {**json.loads(row['body']), **patch, 'updated_at':now()}
            db.execute('UPDATE jobs SET status=?,body=? WHERE id=?', (job['status'], dumps(job), job_id))
            return job

    def transition_job(self, job_id, expected, patch):
        with self.lock:
            job = self.get_job(job_id)
            if job['status'] not in expected:
                return False
            self.update_job(job_id, **patch)
            return True

    def assert_publishable(self, db, job_id, revisions):
        if job_id:
            row = db.execute('SELECT status FROM jobs WHERE id=?', (job_id,)).fetchone()
            if not row or row['status'] != 'running':
                raise LearningError('任务已取消', 409)
        for doc_id, revision in revisions.items():
            row = db.execute('SELECT revision,deleted FROM documents WHERE id=?', (doc_id,)).fetchone()
            if not row or row['deleted'] or row['revision'] != revision:
                raise LearningError('资料已更新或移除', 409)

    def commit_analysis(self, document_id, revision, analysis, job_id):
        value = json.loads(dumps(analysis))
        value.update(id=uuid.uuid4().hex, document_id=document_id, revision=revision, created_at=now())
        mapping, concepts = {}, {}
        for concept in value['concepts']:
            normalize = lambda s: ' '.join(unicodedata.normalize('NFKC', s).casefold().split())
            canonical = digest(normalize(concept['domain'])+'\n'+normalize(concept['name']))[:32]
            mapping[concept['id']] = canonical
            if canonical in concepts:
                concepts[canonical]['citations'].extend(concept['citations'])
            else:
                concepts[canonical] = {**concept, 'id':canonical, 'document_ids':[document_id]}
        value['concepts'] = list(concepts.values())
        def remap(node):
            if node.get('concept_id'):
                node['concept_id'] = mapping[node['concept_id']]
            for child in node['children']:
                remap(child)
        remap(value['tree'])
        for relation in value['relations']:
            relation.update(source=mapping[relation['source']], target=mapping[relation['target']])
            relation['id'] = digest(dumps([relation['source'],relation['target'],relation['type']]))[:32]
        with self.connection() as db:
            self.assert_publishable(db, job_id, {document_id:revision})
            doc = self._document(db, document_id)
            db.execute('INSERT INTO analyses VALUES(?,?,?,?)', (value['id'],document_id,revision,dumps(value)))
            for concept in value['concepts']:
                db.execute('INSERT OR IGNORE INTO concepts VALUES(?,?,?)', (concept['id'],concept['name'],concept['domain']))
                db.execute('INSERT INTO concept_mentions VALUES(?,?,?)', (concept['id'],value['id'],dumps(concept)))
            for relation in value['relations']:
                db.execute('INSERT OR REPLACE INTO relations VALUES(?,?,?)', (relation['id'],value['id'],dumps(relation)))
                for citation in relation['citations']:
                    db.execute('INSERT INTO relation_evidence VALUES(?,?,?)', (relation['id'],value['id'],dumps(citation)))
            for field in ('category','tags'):
                if field not in doc.get('manual', []):
                    doc[field] = value[field]
            doc.update(analysis_id=value['id'], status='completed', updated_at=now())
            db.execute('UPDATE documents SET body=? WHERE id=?', (dumps(doc),document_id))
        return value

    def get_analysis(self, document_id, revision=None):
        with self.connection() as db:
            doc = self._document(db, document_id)
            if revision is None:
                row = db.execute('SELECT body FROM analyses WHERE id=?', (doc.get('analysis_id'),)).fetchone()
            else:
                row = db.execute('SELECT body FROM analyses WHERE document_id=? AND revision=? ORDER BY rowid DESC LIMIT 1', (document_id,revision)).fetchone()
            if not row:
                raise LearningError('文档尚未生成分析与思维导图', 404)
            value = json.loads(row['body'])
            value['needs_update'] = value['revision'] != doc['revision']
            return value

    def active_analyses(self):
        with self.connection() as db:
            return [json.loads(r['body']) for r in db.execute('SELECT a.body FROM analyses a JOIN documents d ON a.document_id=d.id AND a.revision=d.revision WHERE d.deleted=0 AND json_extract(d.body,\'$.analysis_id\')=a.id')]
