"""Transactional corpus and separate human annotations, with connection-per-operation I/O."""
from contextlib import contextmanager
from datetime import datetime, timezone
import json
import re
from pathlib import Path
import sqlite3
import threading
from uuid import uuid4

from .datasets import convert, digest, text, url
from .matching import APP_INTENTS, coverage, fts_query, tokens, unknown_intent
from .reuse import normalize_question, requires_fresh_context, semantic_rank, applicable, hit, miss
from local_knowledge.diagnostics import log_event
from local_knowledge.intents import parse_knowledge_question,covers,topic_key
from local_knowledge.synthesis import answer_covers
from local_knowledge.lookup import excerpt_constraints_supported

FACT_STATES = ('correct', 'unverified', 'uncertain', 'incorrect')


def now():
    return datetime.now(timezone.utc).isoformat()


class KnowledgeStore:
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        with self.connection() as db:
            db.execute('PRAGMA journal_mode=WAL')
            db.executescript('''
                CREATE TABLE IF NOT EXISTS entries (
                    id TEXT PRIMARY KEY, kind TEXT NOT NULL, origin TEXT NOT NULL,
                    dataset TEXT NOT NULL, split TEXT NOT NULL, data TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS entry_kind ON entries(kind, origin, dataset);
                CREATE VIRTUAL TABLE IF NOT EXISTS entry_fts USING fts5(
                    id UNINDEXED, question, answer, context, metadata, tokenize='unicode61'
                );
                CREATE VIRTUAL TABLE IF NOT EXISTS baseline_fts USING fts5(
                    id UNINDEXED, question, answer, context, metadata, tokenize='unicode61'
                );
                CREATE TABLE IF NOT EXISTS annotations (
                    entry_id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS evaluations (
                    id TEXT PRIMARY KEY, dataset TEXT NOT NULL, task TEXT NOT NULL, data TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS reports (id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS import_jobs (
                    id TEXT PRIMARY KEY, status TEXT NOT NULL, phase TEXT NOT NULL,
                    config TEXT NOT NULL, file_path TEXT, processed INTEGER NOT NULL DEFAULT 0,
                    total INTEGER NOT NULL DEFAULT 0, imported INTEGER NOT NULL DEFAULT 0,
                    updated INTEGER NOT NULL DEFAULT 0, evaluations INTEGER NOT NULL DEFAULT 0,
                    embedding_processed INTEGER NOT NULL DEFAULT 0,
                    embedding_failed INTEGER NOT NULL DEFAULT 0,
                    message TEXT NOT NULL DEFAULT '', error TEXT, cancel_requested INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT
                );
                CREATE INDEX IF NOT EXISTS import_job_status ON import_jobs(status, created_at);
                CREATE TABLE IF NOT EXISTS import_job_files (
                    job_id TEXT PRIMARY KEY, path TEXT NOT NULL, cleaned INTEGER NOT NULL DEFAULT 0
                );
                CREATE TABLE IF NOT EXISTS entry_embeddings (
                    entry_id TEXT NOT NULL, provider_id TEXT NOT NULL, model TEXT NOT NULL,
                    dimension INTEGER NOT NULL, vector TEXT NOT NULL, updated_at TEXT NOT NULL,
                    PRIMARY KEY(entry_id, provider_id, model)
                );
                CREATE TABLE IF NOT EXISTS semantic_vectors (
                    entry_id TEXT NOT NULL, fingerprint TEXT NOT NULL, text_hash TEXT NOT NULL, vector TEXT NOT NULL,
                    PRIMARY KEY(entry_id, fingerprint)
                );
            ''')
            missing = db.execute("SELECT data FROM entries WHERE origin='public' AND id NOT IN (SELECT id FROM baseline_fts)").fetchall()
            for row in missing:
                self._index(db, json.loads(row['data']), update_baseline=True)

    @contextmanager
    def connection(self):
        with self.lock:
            db = sqlite3.connect(self.path, timeout=30)
            db.row_factory = sqlite3.Row
            try:
                with db:
                    yield db
            finally:
                db.close()

    def _materialize(self, row):
        entry = json.loads(row['data'])
        entry.update(original_source_name=entry.get('source_name', ''),
                     original_source_url=entry.get('source_url', ''), fact_status='unverified',
                     note='', annotated_at=None, updated_at=row['updated_at'])
        if row['annotation']:
            entry.update(json.loads(row['annotation']))
            entry['annotated_at'] = row['annotated_at']
        return entry

    def _index(self, db, entry, update_baseline=False):
        annotation = db.execute('SELECT data FROM annotations WHERE entry_id=?', (entry['id'],)).fetchone()
        view = {**entry, **(json.loads(annotation['data']) if annotation else {})}
        metadata = ' '.join([entry.get('title', ''), view.get('source_name', ''),
                             entry.get('source_name', ''), ' '.join(view.get('tags', []))])
        db.execute('DELETE FROM entry_fts WHERE id=?', (entry['id'],))
        db.execute('INSERT INTO entry_fts(id,question,answer,context,metadata) VALUES(?,?,?,?,?)', (
            entry['id'], ' '.join(tokens(entry['question'])), ' '.join(tokens(entry['answer'])),
            ' '.join(tokens(entry.get('context', ''))), ' '.join(tokens(metadata))))
        if update_baseline and entry['origin'] == 'public':
            original_metadata = ' '.join([entry.get('title', ''), entry.get('source_name', '')])
            db.execute('DELETE FROM baseline_fts WHERE id=?', (entry['id'],))
            db.execute('INSERT INTO baseline_fts(id,question,answer,context,metadata) VALUES(?,?,?,?,?)', (
                entry['id'], ' '.join(tokens(entry['question'])), ' '.join(tokens(entry['answer'])),
                ' '.join(tokens(entry.get('context', ''))), ' '.join(tokens(original_metadata))))

    def _upsert(self, db, entry):
        payload = json.dumps(entry, ensure_ascii=False, sort_keys=True)
        previous = db.execute('SELECT data FROM entries WHERE id=?', (entry['id'],)).fetchone()
        if previous and previous['data'] == payload:
            return False
        db.execute('INSERT INTO entries VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET '
                   'kind=excluded.kind,origin=excluded.origin,dataset=excluded.dataset,split=excluded.split,'
                   'data=excluded.data,updated_at=excluded.updated_at',
                   (entry['id'], entry['kind'], entry['origin'], entry['dataset'], entry['split'], payload, now()))
        self._index(db, entry, update_baseline=True)
        return True

    def import_data(self, content, fmt='records', name='导入内容', source_url='', partition='dev'):
        dataset, entries, evaluations = convert(content, fmt, name, source_url, partition)
        with self.connection() as db:
            updated = sum(self._upsert(db, entry) for entry in entries)
            for entry in entries:
                db.execute('DELETE FROM evaluations WHERE id=?', (entry['id'],))
            for item in evaluations:
                # Partition changes of the same sample must remove the previous
                # train copy before a held-out question is recorded.
                db.execute('DELETE FROM entries WHERE id=? AND dataset=?', (item['id'], dataset))
                db.execute('DELETE FROM entry_fts WHERE id=?', (item['id'],))
                db.execute('DELETE FROM baseline_fts WHERE id=?', (item['id'],))
                db.execute('INSERT INTO evaluations VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
                           (item['id'], dataset, item['task'], json.dumps(item, ensure_ascii=False)))
        return {'dataset': dataset, 'name': name, 'imported': len(entries), 'updated': updated,
                'evaluations': len(evaluations)}

    def _job_materialize(self, row):
        config = json.loads(row['config']) if row['config'] else {}
        total = row['total'] or 0
        processed = row['processed'] or 0
        percent = round(processed * 100 / total, 1) if total else 0
        return {
            'id': row['id'], 'status': row['status'], 'phase': row['phase'],
            'processed': processed, 'total': total, 'percent': percent,
            'imported': row['imported'] or 0, 'updated': row['updated'] or 0,
            'evaluations': row['evaluations'] or 0,
            'embedding': {'provider_id': config.get('provider_id', ''),
                          'model': config.get('embedding_model', ''),
                          'processed': row['embedding_processed'] or 0,
                          'failed': row['embedding_failed'] or 0},
            'rerank': {'provider_id': config.get('provider_id', ''),
                       'model': config.get('rerank_model', ''),
                       'enabled': bool(config.get('rerank_model'))},
            'config': config, 'file_path': row['file_path'] or '',
            'message': row['message'] or '', 'error': row['error'],
            'created_at': row['created_at'], 'started_at': row['started_at'],
            'finished_at': row['finished_at'], 'cancel_requested': bool(row['cancel_requested']),
        }

    def create_import_job(self, payload, file_path=None):
        if not isinstance(payload, dict):
            raise ValueError('任务配置必须是对象')
        job_id = 'import:' + uuid4().hex
        config = json.dumps(payload, ensure_ascii=False, sort_keys=True)
        created = now()
        with self.connection() as db:
            db.execute('INSERT INTO import_jobs(id,status,phase,config,file_path,message,created_at) '
                       'VALUES(?,?,?,?,?,?,?)',
                       (job_id, 'queued', 'reading', config, str(file_path or ''), '等待后台处理', created))
            if file_path:
                db.execute('INSERT INTO import_job_files(job_id,path) VALUES(?,?)', (job_id, str(file_path)))
            return self._job_materialize(db.execute('SELECT * FROM import_jobs WHERE id=?', (job_id,)).fetchone())

    def get_import_job(self, job_id):
        with self.connection() as db:
            row = db.execute('SELECT * FROM import_jobs WHERE id=?', (job_id,)).fetchone()
            if row is None:
                raise KeyError(job_id)
            return self._job_materialize(row)

    def list_import_jobs(self, limit=20):
        if type(limit) is not int or not 1 <= limit <= 100:
            raise ValueError('任务 limit 必须为1–100的整数')
        with self.connection() as db:
            return [self._job_materialize(row) for row in db.execute(
                'SELECT * FROM import_jobs ORDER BY created_at DESC LIMIT ?', (limit,))]

    def update_import_job(self, job_id, **patch):
        allowed = {'status', 'phase', 'processed', 'total', 'imported', 'updated', 'evaluations',
                   'embedding_processed', 'embedding_failed', 'message', 'error', 'cancel_requested',
                   'started_at', 'finished_at', 'file_path', 'config'}
        unknown = set(patch) - allowed
        if unknown:
            raise ValueError(f'任务字段不支持：{sorted(unknown)[0]}')
        if not patch:
            return self.get_import_job(job_id)
        with self.connection() as db:
            if not db.execute('SELECT 1 FROM import_jobs WHERE id=?', (job_id,)).fetchone():
                raise KeyError(job_id)
            values = []
            assignments = []
            for key, value in patch.items():
                assignments.append(f'{key}=?')
                values.append(json.dumps(value, ensure_ascii=False, sort_keys=True) if key == 'config' and isinstance(value, dict) else value)
            values.append(job_id)
            db.execute(f"UPDATE import_jobs SET {', '.join(assignments)} WHERE id=?", values)
            return self._job_materialize(db.execute('SELECT * FROM import_jobs WHERE id=?', (job_id,)).fetchone())

    def cancel_import_job(self, job_id):
        with self.connection() as db:
            row = db.execute('SELECT * FROM import_jobs WHERE id=?', (job_id,)).fetchone()
            if row is None:
                raise KeyError(job_id)
            if row['status'] in ('completed', 'failed', 'cancelled'):
                return self._job_materialize(row)
            if row['status'] == 'queued':
                db.execute("UPDATE import_jobs SET status='cancelled', phase='failed', message='已取消', finished_at=? WHERE id=?",
                           (now(), job_id))
            else:
                db.execute('UPDATE import_jobs SET cancel_requested=1, message=? WHERE id=?', ('正在取消…', job_id))
            return self._job_materialize(db.execute('SELECT * FROM import_jobs WHERE id=?', (job_id,)).fetchone())

    def recover_import_jobs(self):
        with self.connection() as db:
            stamp = now()
            cursor = db.execute("UPDATE import_jobs SET status='failed', phase='failed', error=?, message=?, finished_at=? "
                                "WHERE status IN ('queued','running')",
                                ('服务重启，中断了后台任务', '后台任务因服务重启中断', stamp))
            return cursor.rowcount

    def _save_embedding(self, db, entry_id, provider_id, model, vector):
        payload = json.dumps(vector, ensure_ascii=False)
        db.execute('INSERT INTO entry_embeddings(entry_id,provider_id,model,dimension,vector,updated_at) VALUES(?,?,?,?,?,?) '
                   'ON CONFLICT(entry_id,provider_id,model) DO UPDATE SET dimension=excluded.dimension,vector=excluded.vector,updated_at=excluded.updated_at',
                   (entry_id, provider_id, model, len(vector), payload, now()))

    def get(self, entry_id):
        with self.connection() as db:
            row = db.execute('SELECT e.*,a.data annotation,a.updated_at annotated_at FROM entries e '
                             'LEFT JOIN annotations a ON e.id=a.entry_id WHERE e.id=?', (entry_id,)).fetchone()
            if row is None:
                raise KeyError(entry_id)
            return self._materialize(row)

    def annotate(self, entry_id, patch):
        if not isinstance(patch, dict) or not patch:
            raise ValueError('标注必须是非空对象')
        allowed = {'fact_status', 'source_name', 'source_url', 'tags', 'note'}
        if set(patch) - allowed:
            raise ValueError('包含不支持的标注字段')
        clean = {}
        for field, value in patch.items():
            if field == 'fact_status':
                if value not in FACT_STATES:
                    raise ValueError('核验状态无效')
            elif field == 'source_url':
                value = url(value)
            elif field == 'tags':
                if not isinstance(value, list) or len(value) > 30:
                    raise ValueError('tags 必须是最多30个标签的数组')
                value = list(dict.fromkeys(text(tag, '标签', True, maximum=80) for tag in value))
            else:
                value = text(value, field, maximum=200 if field == 'source_name' else 4000)
            clean[field] = value
        with self.connection() as db:
            row = db.execute('SELECT data FROM entries WHERE id=?', (entry_id,)).fetchone()
            if not row:
                raise KeyError(entry_id)
            previous = db.execute('SELECT data FROM annotations WHERE entry_id=?', (entry_id,)).fetchone()
            annotation = {**(json.loads(previous['data']) if previous else {}), **clean}
            db.execute('INSERT INTO annotations VALUES(?,?,?) ON CONFLICT(entry_id) DO UPDATE SET '
                       'data=excluded.data,updated_at=excluded.updated_at',
                       (entry_id, json.dumps(annotation, ensure_ascii=False), now()))
            self._index(db, json.loads(row['data']))
        return self.get(entry_id)

    def add(self, row):
        if not isinstance(row, dict):
            raise ValueError('内容必须是对象')
        # Convert through the same validator, then give manual content a private origin.
        _, entries, _ = convert(json.dumps([{**row, 'split': 'train'}], ensure_ascii=False),
                                'records', '手动保存', '')
        entry = entries[0]
        entry.update(id='manual:' + uuid4().hex, origin='manual', dataset='', dataset_name='手动保存')
        with self.connection() as db:
            self._upsert(db, entry)
        return self.get(entry['id'])

    def search(self, query, scope='all', source='', tag='', fact_status='', sort='relevance', limit=20,
               kind='qa', dataset=None, baseline=False):
        query = text(query, 'query', maximum=2000)
        if kind not in ('qa', 'intent'):
            raise ValueError('kind 必须是 qa 或 intent')
        if scope not in ('all', 'history', 'public', 'manual') or sort not in ('relevance', 'verified'):
            raise ValueError('scope 或 sort 无效')
        if fact_status and fact_status not in FACT_STATES:
            raise ValueError('核验筛选无效')
        if type(limit) is not int or not 1 <= limit <= 50:
            raise ValueError('limit 必须为1–50的整数')
        source = text(source, 'source', maximum=200)
        tag = text(tag, 'tag', maximum=80)
        match = fts_query(query)
        index = 'baseline_fts' if baseline else 'entry_fts'
        with self.connection() as db:
            conditions, params = ['e.kind=?'], [kind]
            if scope != 'all':
                conditions.append('e.origin=?')
                params.append(scope)
            if kind == 'intent':
                conditions.append("e.split='train'")
            if dataset is not None:
                conditions.append('e.dataset=?')
                params.append(dataset)
            if baseline:
                conditions.append("e.origin='public'")
            select = 'SELECT e.*,a.data annotation,a.updated_at annotated_at, '
            joins = ' FROM entries e LEFT JOIN annotations a ON e.id=a.entry_id '
            if match:
                select += f'bm25({index},0,4,1,1,0.5) rank'
                joins += f'JOIN {index} ON e.id={index}.id '
                conditions.append(f'{index} MATCH ?')
                params.append(match)
            else:
                select += '0 rank'
                if query:
                    return {'results': [], 'total': 0}
            sql = select + joins + 'WHERE ' + ' AND '.join(conditions)
            rows = db.execute(sql + (' ORDER BY rank,e.id' if match else ' ORDER BY e.updated_at DESC,e.id'), params)
            results = []
            for row in rows:
                entry = self._materialize(row)
                if source and source.casefold() not in entry['source_name'].casefold():
                    continue
                if tag and tag not in entry['tags']:
                    continue
                if fact_status and entry['fact_status'] != fact_status:
                    continue
                entry['match_score'] = round(max(0, -row['rank']), 6)
                results.append(entry)
            if sort == 'verified':
                results.sort(key=lambda item: (FACT_STATES.index(item['fact_status']), -item['match_score'], item['id']))
        return {'results': results[:limit], 'total': len(results)}

    def classify(self, query, dataset=None, baseline=False):
        query = text(query, 'query', maximum=2000)
        if not query:
            return unknown_intent()
        rows = self.search(query, kind='intent', dataset=dataset, baseline=baseline, limit=5)['results']
        if not rows:
            return unknown_intent()
        best = rows[0]
        ratio = coverage(query, best['question'])
        if ratio < 0.4 or best['intent'] == '未知':
            return unknown_intent()
        return {'intent': best['intent'], 'native_label': best['native_label'], 'coverage': round(ratio, 4),
                'reason': '匹配已保存的意图样例', 'sample': {'id': best['id'], 'question': best['question'],
                                                     'source_name': best['original_source_name']},
                'method': 'local-baseline'}

    def qa_entries(self):
        with self.connection() as db:
            return [self._materialize(row) for row in db.execute(
                "SELECT e.*,a.data annotation,a.updated_at annotated_at FROM entries e "
                "LEFT JOIN annotations a ON e.id=a.entry_id WHERE e.kind='qa' ORDER BY e.updated_at DESC,e.id")]

    def _reusable(self,entry,constraints,source_valid=None):
        return (bool(entry['question'] and entry['answer']) and entry['fact_status'] in ('correct','unverified')
            and not entry.get('provenance_invalid') and not entry.get('derived_local')
            and (entry.get('reusable',entry['origin']!='history') or entry['fact_status']=='correct')
            and entry.get('system_constraints','').strip()==constraints
            and (not entry.get('reused_entry_id') or entry['fact_status']=='correct')
            and (source_valid is None or source_valid(entry)))

    def _generation_scope_matches(self,entry,context):
        original=entry.get('generation_context',[])
        restricted=any(m.get('role')=='user' and re.search(r'只(?:讨论|考虑|谈)|限定|假设|\bonly\b|this scenario',m.get('content',''),re.I) for m in original)
        return not restricted or original==(context or [])

    def saved_candidates(self,question,constraints='',context=None,limit=5,semantic=False):
        query=parse_knowledge_question(question)
        if (not query and not semantic) or requires_fresh_context(question,context):return []
        with self.connection() as db:
            entries=[self._materialize(row) for row in db.execute("SELECT e.*,a.data annotation,a.updated_at annotated_at FROM entries e "
                "LEFT JOIN annotations a ON e.id=a.entry_id WHERE e.kind='qa' AND e.origin='history' ORDER BY e.updated_at,e.id")]
        result=[]
        for entry in entries:
            if not self._reusable(entry,constraints):continue
            if not self._generation_scope_matches(entry,context):continue
            if semantic:
                result.append({**entry,'match_method':'semantic_candidate'})
            else:
                saved=parse_knowledge_question(entry['question'])
                if saved and topic_key(saved.topic)==topic_key(query.topic) and answer_covers(entry['answer'],query):
                    result.append({**entry,'match_method':'topic_evidence'})
        result.sort(key=lambda e:(FACT_STATES.index(e['fact_status']),len(e.get('generation_context',[])),e['id']))
        return result[:limit] if limit is not None else result

    def reuse(self, question, constraints='', context=None, models=None, budget=None, source_valid=None, request_id='', document_lookup=None):
        question = text(question, 'question', True, maximum=20000)
        constraints = text(constraints, 'system_constraints')
        context = context or []
        if requires_fresh_context(question, context):
            return miss('fresh_context_required')
        # Preserve explicit ongoing user instructions instead of treating a
        # matching topic as permission to ignore the current conversation.
        if not excerpt_constraints_supported({'system_constraints':'','context':context}):
            return miss('context_constraints')
        def eligible(entry):
            return self._reusable(entry,constraints,source_valid)
        candidates = [entry for entry in self.qa_entries() if eligible(entry)]
        def log_candidates(rows, method):
            log_event('knowledge.saved_search', request_id=request_id, question=question,
                method=method, eligible_count=len(candidates), candidate_count=len(rows),
                candidates=[{'entry_id':entry['id'],'question':entry['question'],'quote':entry['answer'],
                    'source_name':entry.get('source_name',''),'fact_status':entry['fact_status'],
                    'score':entry.get('match_score')} for entry in rows[:5]])
        if not candidates:
            log_candidates([], 'empty')
            return miss()
        # A local answer may now combine both a document and saved dialogues.
        # Probe that route even when an exact saved answer exists.
        if document_lookup is not None and document_lookup():
            log_candidates([], 'document_lookup_preferred')
            return miss('document_answer_available')
        exact = [entry for entry in candidates if normalize_question(entry['question']) == normalize_question(question)]
        if exact:
            exact.sort(key=lambda entry: FACT_STATES.index(entry['fact_status']))
            log_candidates(exact, 'normalized_question')
            # An exact saved question has already passed the user's original
            # applicability boundary. Avoid spending the local QA budget on a
            # second semantic check before returning a durable saved answer.
            return hit(exact[0], 'normalized_question')
        query=parse_knowledge_question(question)
        subset=[entry for entry in candidates if covers(query,parse_knowledge_question(entry['question']))
                and self._generation_scope_matches(entry,context) and answer_covers(entry['answer'],query)]
        if subset:
            subset.sort(key=lambda entry:FACT_STATES.index(entry['fact_status']))
            log_candidates(subset,'intent_subset')
            return hit(subset[0],'intent_subset')
        if models is not None:
            # Check a cheap indexed document definition before spending the
            # shared local deadline on semantic matching of saved answers.
            ranked = semantic_rank(self, question, candidates, models, budget)
            # Model scores rank semantic applicability; manual factual status
            # remains a separate field and is never set by this process.
            shortlist = sorted(ranked[:5], key=lambda entry: (FACT_STATES.index(entry['fact_status']), -entry['match_score']))
            log_candidates(shortlist, 'semantic')
            for entry in shortlist:
                budget.check()
                if not applicable(question, entry, context, constraints, models, budget):
                    continue
                budget.check()
                current = self.get(entry['id'])
                if current['answer'] != entry['answer'] or current['question'] != entry['question'] or not eligible(current):
                    return miss('source_changed')
                budget.check()
                return hit(current, 'semantic')
            return miss('no_applicable_saved_answer')
        log_candidates([], 'no_semantic_model')
        return miss()

    def sync_conversations(self, conversations):
        if not isinstance(conversations, list):
            raise ValueError('conversations 必须是数组')
        desired = set()
        with self.connection() as db:
            for conv in conversations:
                if not isinstance(conv, dict) or not conv.get('id'):
                    continue
                user = None
                user_id = ''
                prior = []
                before_user = []
                for msg in conv.get('messages', []):
                    if not isinstance(msg, dict) or not isinstance(msg.get('content'), str):
                        continue
                    if msg.get('role') == 'user':
                        user = msg['content'].strip()
                        user_id = msg.get('id', '')
                        before_user = list(prior)
                        prior.append({'role': 'user', 'content': msg['content']})
                        continue
                    if msg.get('role') in ('assistant', 'system'):
                        prior.append({'role': msg['role'], 'content': msg['content']})
                    answer = msg['content'].strip()
                    if (msg.get('role') != 'assistant' or not msg.get('id') or not user or not answer
                            or answer.startswith(('❌', '⏹️', '🔎', '🔁'))
                            or answer.endswith(('⏹️ _已停止_', '⏹️ _网页群聊已停止_'))
                            or (msg.get('webChat') or {}).get('status') in ('running', 'synthesizing', 'error', 'stopped')
                            or (msg.get('pluginProgress') and not msg.get('pluginResult'))):
                        continue
                    completion = msg.get('completion') or {}
                    if completion.get('status') and completion['status'] != 'complete':
                        continue
                    from local_knowledge.chat_sync import turn_hash
                    generation_context = completion.get('context', before_user)
                    constraints = completion.get('effective_constraints', '')
                    supplied_hash = completion.get('origin_hash')
                    valid_hash = supplied_hash == turn_hash(user, answer, generation_context, constraints)
                    context_changed = generation_context != before_user
                    derived_local = completion.get('kind') == 'local' and (msg.get('knowledge') or {}).get('origin') != 'saved_answer'
                    sources = [s for s in msg.get('sources', []) if isinstance(s, dict)]
                    originals = [s.get('content', '') for s in sources if isinstance(s.get('content'), str)]
                    for original in (msg.get('webChat') or {}).get('answers', []):
                        if isinstance(original, dict) and isinstance(original.get('content'), str):
                            originals.append(original['content'])
                    first = sources[0] if sources else {}
                    entry = {'id': f'history:{conv["id"]}:{msg["id"]}', 'kind': 'qa', 'origin': 'history',
                             'dataset': '', 'dataset_name': '', 'split': 'train', 'question': user[:100000],
                             'answer': answer[:100000], 'context': '\n'.join(originals)[:100000],
                             'title': conv.get('title', ''), 'intent': (msg.get('autoRoute') or {}).get('intent'),
                             'native_label': None, 'source_name': first.get('title') or msg.get('model') or conv.get('model') or '历史对话',
                             'source_url': first.get('url', ''), 'tags': [],
                             'reusable': completion.get('status') == 'complete' and completion.get('kind') in ('api', 'web') and valid_hash and not context_changed,
                             'provenance_invalid': bool(supplied_hash and not valid_hash) or context_changed,
                             'derived_local': derived_local, 'generation_context': generation_context, 'origin_hash': supplied_hash,
                             'system_constraints': completion.get('effective_constraints', ''),
                             'reused_entry_id': ((msg.get('knowledge') or {}).get('saved_entry') or {}).get('id'),
                             'conversation_id': conv['id'], 'user_message_id': user_id, 'message_id': msg['id'],
                             'completion_kind': completion.get('kind')}
                    desired.add(entry['id'])
                    self._upsert(db, entry)
            stale = [row['id'] for row in db.execute("SELECT id FROM entries WHERE origin='history'") if row['id'] not in desired]
            for entry_id in stale:
                db.execute('DELETE FROM entries WHERE id=?', (entry_id,))
                db.execute('DELETE FROM entry_fts WHERE id=?', (entry_id,))
                db.execute('DELETE FROM annotations WHERE entry_id=?', (entry_id,))

    def status(self):
        with self.connection() as db:
            count = db.execute('SELECT count(*) FROM entries').fetchone()[0]
            evaluations = db.execute('SELECT count(*) FROM evaluations').fetchone()[0]
            entries = [self._materialize(row) for row in db.execute(
                'SELECT e.*,a.data annotation,a.updated_at annotated_at FROM entries e LEFT JOIN annotations a ON e.id=a.entry_id')]
            report = db.execute('SELECT data FROM reports ORDER BY created_at DESC LIMIT 1').fetchone()
            datasets = {}
            for entry in entries:
                if entry['dataset']:
                    item = datasets.setdefault(entry['dataset'], {'id': entry['dataset'], 'name': entry['dataset_name'],
                                                                 'entries': 0, 'source_url': entry['original_source_url']})
                    item['entries'] += 1
        covered = sorted({entry['intent'] for entry in entries if entry['kind'] == 'intent' and entry['intent'] != '未知'})
        return {'entries': count, 'evaluations': evaluations, 'sources': sorted({entry['source_name'] for entry in entries}),
                'covered_intents': covered, 'uncovered_intents': [i for i in APP_INTENTS if i != '未知' and i not in covered],
                'datasets': list(datasets.values()), 'last_evaluation': json.loads(report['data']) if report else None}

    def evaluate(self):
        with self.connection() as db:
            samples = [json.loads(row['data']) for row in db.execute('SELECT data FROM evaluations ORDER BY id')]
            training = {digest(json.loads(row['data'])['question']) for row in db.execute(
                "SELECT data FROM entries WHERE kind='intent' AND origin='public' AND split='train'")}
        intent_pairs, native_hits, qa_ranks, overlap = [], 0, [], 0
        for sample in samples:
            if sample['task'] == 'intent':
                if digest(sample['query']) in training:
                    overlap += 1
                    continue
                prediction = self.classify(sample['query'], dataset=sample['dataset'], baseline=True)
                intent_pairs.append((sample['expected_intent'], prediction['intent']))
                native_hits += prediction['native_label'] == sample['expected_native_label']
            else:
                matches = self.search(sample['query'], dataset=sample['dataset'], baseline=True, limit=5)['results']
                rank = next((i for i, row in enumerate(matches, 1) if row['id'] in sample['expected_ids']), 0)
                qa_ranks.append(rank)
        labels = sorted({expected for expected, _ in intent_pairs})
        f1s = []
        for label in labels:
            tp = sum(expected == label and predicted == label for expected, predicted in intent_pairs)
            fp = sum(expected != label and predicted == label for expected, predicted in intent_pairs)
            fn = sum(expected == label and predicted != label for expected, predicted in intent_pairs)
            f1s.append(2 * tp / (2 * tp + fp + fn) if 2 * tp + fp + fn else 0)
        n, qn = len(intent_pairs), len(qa_ranks)
        report = {'created_at': now(), 'method': 'FTS5 中文双字词本地基线',
                  'scope': '公开子集；意图 holdout 问题不入索引，问答只检索原文；不包含私人历史和人工核验排序',
                  'intent': {'total': n, 'accuracy': sum(e == p for e, p in intent_pairs) / n if n else None,
                             'macro_f1': sum(f1s) / len(f1s) if f1s else None,
                             'native_accuracy': native_hits / n if n else None, 'labels': labels, 'excluded_overlap': overlap},
                  'qa': {'total': qn, 'hit_at_1': sum(r == 1 for r in qa_ranks) / qn if qn else None,
                         'hit_at_5': sum(r > 0 for r in qa_ranks) / qn if qn else None,
                         'mrr_at_5': sum(1 / r for r in qa_ranks if r) / qn if qn else None},
                  'datasets': sorted({s['dataset_name'] for s in samples})}
        with self.connection() as db:
            db.execute('INSERT INTO reports VALUES(?,?,?)', (uuid4().hex, json.dumps(report, ensure_ascii=False), report['created_at']))
        return report
