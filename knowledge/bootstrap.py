"""Import checked-in public subsets; normal operation has no network dependency."""
import hashlib
import json
from pathlib import Path

from .store import KnowledgeStore


def create_store(path, resources=None):
    store = KnowledgeStore(path)
    root = resources or Path(__file__).resolve().parents[1] / 'resources' / 'benchmarks'
    manifest = root / 'manifest.json'
    if manifest.exists():
        for item in json.loads(manifest.read_text(encoding='utf-8'))['datasets']:
            content = (root / item['file']).read_bytes()
            if hashlib.sha256(content).hexdigest() != item['sha256']:
                raise ValueError(f'公开集校验失败：{item["file"]}')
            store.import_data(content.decode('utf-8'), item['format'], item['name'], item['source_url'])
    return store
