"""Read-only adapters for existing local document repositories."""
from dataclasses import asdict
import json

from .contracts import dumps, now


class SourceSynchronizer:
    def __init__(self, store, local_store=None, content_store=None):
        self.store, self.local_store, self.content_store = store, local_store, content_store

    def sync(self):
        result = dict(added=0, updated=0, removed=0, skipped=0, errors=[])
        for origin, getter in [('local_knowledge', self.local_store), ('content_library', self.content_store)]:
            if getter is None:
                continue
            try:
                repository = getter() if callable(getter) else getter
                if origin == 'local_knowledge':
                    snapshots = []
                    for source in repository.list_sources():
                        if source.kind != 'document' or source.status == 'deleted':
                            continue
                        chunks = [asdict(c) for c in repository.revision_chunks(source.id, source.revision)]
                        snapshots.append({'source_id': source.id, 'origin': origin, 'title': source.title,
                            'external_revision': source.revision, 'content_hash': source.content_hash,
                            'locator': source.locator, 'status': source.status, 'chunks': chunks})
                else:
                    snapshots = repository.document_snapshots()
            except Exception as exc:
                result['errors'].append({'origin': origin, 'error': str(exc)[:300]})
                continue
            seen = {origin+':'+s['source_id'] for s in snapshots}
            for source in snapshots:
                try:
                    with self.store.connection() as db:
                        previous = db.execute('SELECT d.revision FROM document_sources s JOIN documents d ON s.document_id=d.id WHERE s.source_id=?',
                                              (origin+':'+source['source_id'],)).fetchone()
                    if not source['chunks']:
                        result['skipped'] += 1
                        continue
                    doc = self.store.upsert_document(source, source['chunks'])
                    if doc is None:
                        result['skipped'] += 1
                    elif previous is None:
                        result['added'] += 1
                    elif previous['revision'] != doc['revision']:
                        result['updated'] += 1
                except Exception as exc:
                    result['errors'].append({'origin': origin, 'error': str(exc)[:300]})
            with self.store.connection() as db:
                rows = db.execute('SELECT source_id,document_id FROM document_sources WHERE origin=?', (origin,)).fetchall()
                for row in rows:
                    if row['source_id'] not in seen:
                        db.execute('DELETE FROM document_sources WHERE source_id=?', (row['source_id'],))
                        remaining = db.execute('SELECT 1 FROM document_sources WHERE document_id=?', (row['document_id'],)).fetchone()
                        if not remaining:
                            db.execute('UPDATE documents SET deleted=1 WHERE id=?', (row['document_id'],))
                        result['removed'] += 1
        return result
