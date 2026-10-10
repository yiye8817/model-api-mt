#!/usr/bin/env python3
"""Build attributed, deterministic public subsets without datasets/transformers dependencies."""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import tarfile
import urllib.request

MASSIVE_URL = 'https://amazon-massive-nlu-dataset.s3.amazonaws.com/amazon-massive-dataset-1.1.tar.gz'
CMRC_URL = 'https://raw.githubusercontent.com/ymcui/cmrc2018/master/squad-style-data/cmrc2018_dev.json'


def download_subsets(output):
    output.mkdir(parents=True, exist_ok=True)
    print('Downloading official MASSIVE 1.1 zh-CN file...', flush=True)
    with urllib.request.urlopen(MASSIVE_URL, timeout=60) as response:
        with tarfile.open(fileobj=response, mode='r|gz') as archive:
            for member in archive:
                if member.name.endswith('/zh-CN.jsonl') and member.isfile():
                    with archive.extractfile(member) as handle:
                        raw = handle.read(30 * 1024 * 1024)
                    break
            else:
                raise RuntimeError('Official archive has no zh-CN.jsonl')
    counts, records = Counter(), []
    for line in raw.decode('utf-8').splitlines():
        row = json.loads(line)
        key = (row['partition'], row['intent'])
        cap = 20 if row['partition'] == 'train' else 5
        if counts[key] >= cap:
            continue
        counts[key] += 1
        records.append({key: row[key] for key in ('id', 'locale', 'partition', 'intent', 'utt')})
    massive_path = output / 'massive-zh-CN.jsonl'
    massive_path.write_text('\n'.join(json.dumps(row, ensure_ascii=False) for row in records) + '\n', encoding='utf-8')
    print(f'MASSIVE subset: {len(records)} records', flush=True)
    print('Downloading official CMRC2018 development contexts...', flush=True)
    with urllib.request.urlopen(CMRC_URL, timeout=60) as response:
        cmrc_raw = response.read(20 * 1024 * 1024)
    cmrc = json.loads(cmrc_raw)
    articles, paragraphs = [], 0
    for article in cmrc['data']:
        selected = []
        for paragraph in article['paragraphs']:
            if paragraphs >= 160:
                break
            selected.append(paragraph)
            paragraphs += 1
        if selected:
            articles.append({**article, 'paragraphs': selected})
        if paragraphs >= 160:
            break
    cmrc_path = output / 'cmrc2018-dev.json'
    cmrc_path.write_text(json.dumps({'data': articles}, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    items = [
        {'name': 'MASSIVE 1.1 中文公开子集', 'format': 'massive', 'file': massive_path.name,
         'source_url': 'https://github.com/alexa/massive', 'upstream_url': MASSIVE_URL,
         'license': 'CC BY 4.0', 'version': '1.1', 'upstream_file_sha256': hashlib.sha256(raw).hexdigest(),
         'sampling': 'Original file order, first 20 train / 5 dev / 5 test per native intent',
         'counts': dict(Counter(row['partition'] for row in records))},
        {'name': 'CMRC2018 开发集文档检索子集', 'format': 'cmrc', 'file': cmrc_path.name,
         'source_url': 'https://github.com/ymcui/cmrc2018', 'upstream_url': CMRC_URL,
         'license': 'CC BY-SA 4.0', 'version': 'CMRC2018 dev',
         'upstream_file_sha256': hashlib.sha256(cmrc_raw).hexdigest(),
         'sampling': 'First 160 original development paragraphs; retain their questions only for evaluation',
         'counts': {'paragraphs': paragraphs, 'questions': sum(len(p['qas']) for a in articles for p in a['paragraphs'])}},
    ]
    for item in items:
        item['sha256'] = hashlib.sha256((output / item['file']).read_bytes()).hexdigest()
    (output / 'manifest.json').write_text(json.dumps({'datasets': items}, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print('Subsets and SHA256 manifest saved:', output, flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=Path(__file__).resolve().parents[1] / 'resources/benchmarks')
    args = parser.parse_args()
    download_subsets(args.output)
