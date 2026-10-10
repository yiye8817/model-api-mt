"""Durable background import jobs for local documents."""
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import threading
from uuid import uuid4

from .datasets import convert, digest
from .documents import DocumentError, chunk_text, parse_document
from .model_clients import ModelClientError, embed_texts
from .store import now


class JobCancelled(Exception):
    pass


class ImportJobManager:
    def __init__(self, store, get_providers, work_dir, max_workers=2):
        self.store = store
        self.get_providers = get_providers
        self.work_dir = Path(work_dir)
        self.work_dir.mkdir(parents=True, exist_ok=True)
        self.executor = ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix='knowledge-import')
        self.lock = threading.RLock()
        self.futures = {}

    def submit(self, payload, content=None, filename=''):
        if not isinstance(payload, dict):
            raise ValueError('任务配置必须是对象')
        config = dict(payload)
        config.setdefault('chunk_size', 800)
        config.setdefault('chunk_overlap', 120)
        path = None
        if content is not None:
            if not isinstance(content, (bytes, bytearray)):
                raise ValueError('导入内容必须是二进制数据')
            safe_name = Path(filename or 'import.bin').name
            path = self.work_dir / f'{uuid4().hex}-{safe_name}'
            path.write_bytes(bytes(content))
        job = self.store.create_import_job(config, path)
        future = self.executor.submit(self._run, job['id'])
        with self.lock:
            self.futures[job['id']] = future
        return job['id']

    def cancel(self, job_id):
        job = self.store.cancel_import_job(job_id)
        with self.lock:
            future = self.futures.get(job_id)
            if future and future.cancel():
                self.store.update_import_job(job_id, status='cancelled', phase='failed', message='已取消', finished_at=now())
        return self.store.get_import_job(job_id)

    def shutdown(self):
        self.executor.shutdown(wait=False, cancel_futures=True)

    def _is_cancelled(self, job_id):
        return bool(self.store.get_import_job(job_id).get('cancel_requested'))

    def _phase(self, job_id, phase, message='', **fields):
        fields.update(phase=phase, message=message)
        return self.store.update_import_job(job_id, **fields)

    def _provider(self, config):
        provider_id = config.get('provider_id')
        if not provider_id:
            return None
        providers = self.get_providers() or []
        provider = next((item for item in providers if isinstance(item, dict) and item.get('id') == provider_id), None)
        if provider is None:
            raise ModelClientError('所选 provider 不存在')
        if not config.get('embedding_model'):
            raise ModelClientError('已选择 provider，但 embedding_model 为空')
        return provider

    def _raw_entries(self, content, config, filename):
        parsed = parse_document(content, filename or 'import.txt', config.get('format', 'text'))
        chunks = chunk_text(parsed.text, config.get('chunk_size', 800), config.get('chunk_overlap', 120))
        name = config.get('name') or parsed.filename
        source_url = config.get('source_url', '')
        document_id = digest(parsed.text + '\n' + name + '\n' + source_url)
        entries = []
        for index, chunk in enumerate(chunks):
            entries.append({
                'id': f'document:{document_id}:chunk:{index}', 'kind': 'qa', 'origin': 'manual',
                'dataset': f'document:{document_id}', 'dataset_name': name, 'split': 'train',
                'question': f'{name} 第{index + 1}段', 'answer': chunk, 'context': '',
                'title': parsed.filename, 'intent': None, 'native_label': None,
                'source_name': name, 'source_url': source_url, 'tags': [],
            })
        return entries, []

    def _structured_entries(self, content, config):
        try:
            text = content.decode('utf-8-sig')
        except UnicodeDecodeError as exc:
            raise DocumentError('结构化导入文件必须使用 UTF-8 编码') from exc
        dataset, entries, evaluations = convert(text, config.get('format', 'records'),
                                                config.get('name', '导入内容'), config.get('source_url', ''),
                                                config.get('partition', 'dev'))
        return entries, evaluations

    def _prepare(self, content, config, filename):
        fmt = config.get('format', 'records')
        if fmt in ('text', 'markdown', 'pdf', 'docx'):
            return self._raw_entries(content, config, filename)
        if fmt in ('records', 'massive', 'cmrc'):
            return self._structured_entries(content, config)
        raise DocumentError(f'format 不支持：{fmt}')

    def _commit_entries(self, job_id, entries, evaluations, vectors, config):
        if self._is_cancelled(job_id):
            raise JobCancelled()
        updated = 0
        with self.store.connection() as db:
            for entry in entries:
                if self._is_cancelled(job_id):
                    raise JobCancelled()
                updated += self.store._upsert(db, entry)
            for entry in entries:
                db.execute('DELETE FROM evaluations WHERE id=?', (entry['id'],))
            dataset = entries[0].get('dataset', '') if entries else ''
            for item in evaluations:
                db.execute('DELETE FROM entries WHERE id=? AND dataset=?', (item['id'], dataset))
                db.execute('DELETE FROM entry_fts WHERE id=?', (item['id'],))
                db.execute('DELETE FROM baseline_fts WHERE id=?', (item['id'],))
                db.execute('INSERT INTO evaluations VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
                           (item['id'], item.get('dataset', dataset), item['task'], json.dumps(item, ensure_ascii=False)))
            if vectors:
                provider_id = config['provider_id']
                model = config['embedding_model']
                for entry, vector in zip(entries, vectors):
                    self.store._save_embedding(db, entry['id'], provider_id, model, vector)
        return updated

    def _run(self, job_id):
        file_path = None
        try:
            job = self.store.get_import_job(job_id)
            if job['status'] == 'cancelled':
                return
            self.store.update_import_job(job_id, status='running', started_at=now(), message='正在读取文档')
            config = job['config']
            file_path = Path(config.get('file_path') or job.get('file_path') or '')
            if not file_path or not file_path.exists():
                raise DocumentError('后台任务文件不存在')
            content = file_path.read_bytes()
            if self._is_cancelled(job_id):
                raise JobCancelled()
            self._phase(job_id, 'chunking', '正在解析并切分文档')
            entries, evaluations = self._prepare(content, config, file_path.name.split('-', 1)[-1])
            self.store.update_import_job(job_id, total=len(entries), evaluations=len(evaluations), message='已完成文档切分')
            if self._is_cancelled(job_id):
                raise JobCancelled()
            vectors = []
            provider = self._provider(config)
            if provider and entries:
                self._phase(job_id, 'embedding', '正在生成 embedding', embedding_processed=0, embedding_failed=0)
                texts = [f"{entry.get('question', '')}\n{entry.get('answer', '')}\n{entry.get('context', '')}" for entry in entries]
                try:
                    vectors = embed_texts(provider, config['embedding_model'], texts)
                except Exception:
                    self.store.update_import_job(job_id, embedding_failed=len(entries))
                    raise
                self.store.update_import_job(job_id, embedding_processed=len(vectors))
            if self._is_cancelled(job_id):
                raise JobCancelled()
            self._phase(job_id, 'indexing', '正在写入内容库')
            updated = self._commit_entries(job_id, entries, evaluations, vectors, config)
            self.store.update_import_job(job_id, status='completed', phase='completed', processed=len(entries),
                                         imported=len(entries), updated=updated, message='文档索引完成', finished_at=now())
        except JobCancelled:
            self.store.update_import_job(job_id, status='cancelled', phase='failed', message='已取消', finished_at=now())
        except Exception as exc:
            self.store.update_import_job(job_id, status='failed', phase='failed', error=str(exc), message='后台索引失败', finished_at=now())
        finally:
            if file_path and file_path.exists():
                try:
                    file_path.unlink()
                except OSError:
                    pass
            with self.lock:
                self.futures.pop(job_id, None)
