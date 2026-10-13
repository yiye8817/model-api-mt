"""Validate complete imports and separate held-out questions from searchable text."""
import hashlib
import json
from urllib.parse import urlsplit

from .matching import APP_INTENTS, MASSIVE_MAPPING

MAX_ROWS = 20000
MAX_TEXT = 100000


def text(value, field, required=False, maximum=MAX_TEXT):
    if not isinstance(value, str):
        raise ValueError(f'{field} 必须是文本')
    value = value.strip()
    if required and not value:
        raise ValueError(f'{field} 不能为空')
    if len(value) > maximum:
        raise ValueError(f'{field} 超过 {maximum} 字符')
    return value


def url(value):
    value = text(value, '来源链接', maximum=2000)
    if value:
        parsed = urlsplit(value)
        if parsed.scheme not in ('http', 'https') or not parsed.netloc or parsed.username or parsed.password:
            raise ValueError('来源链接必须是 HTTP(S) 地址')
    return value


def digest(value):
    return hashlib.sha256(value.encode('utf-8')).hexdigest()[:24]


def read_rows(content):
    content = text(content, '导入内容', True, maximum=40 * 1024 * 1024)
    try:
        value = json.loads(content)
    except json.JSONDecodeError:
        rows = []
        for number, line in enumerate(content.splitlines(), 1):
            if not line.strip():
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError as exc:
                raise ValueError(f'第 {number} 行 JSON 无效：{exc.msg}') from exc
        value = rows
    return value


def convert(content, fmt, name, source_url, partition='dev'):
    name = text(name, '数据集名称', True, maximum=200)
    source_url = url(source_url)
    dataset = digest(name + '\n' + source_url)
    value = read_rows(content)
    entries, evaluations = {}, []

    def base(key, kind, split):
        return {'id': f'dataset:{dataset}:{key}', 'kind': kind, 'dataset': dataset,
                'dataset_name': name, 'origin': 'public', 'split': split,
                'question': '', 'answer': '', 'context': '', 'intent': None, 'native_label': None,
                'source_name': name, 'source_url': source_url, 'tags': []}

    if fmt == 'cmrc':
        if partition not in ('train', 'dev', 'test'):
            raise ValueError('CMRC partition 必须是 train/dev/test')
        if not isinstance(value, dict) or not isinstance(value.get('data'), list):
            raise ValueError('CMRC 格式需要 data 数组')
        count = 0
        for article_number, article in enumerate(value['data'], 1):
            if not isinstance(article, dict) or not isinstance(article.get('paragraphs'), list):
                raise ValueError(f'第{article_number}篇需要 paragraphs 数组')
            for paragraph_number, paragraph in enumerate(article['paragraphs'], 1):
                location = f'第{article_number}篇/第{paragraph_number}段'
                if not isinstance(paragraph, dict) or not isinstance(paragraph.get('qas'), list):
                    raise ValueError(f'{location}需要 qas 数组')
                context = text(paragraph.get('context'), location + ' context', True)
                entry = base('context:' + digest(context), 'qa', 'corpus')
                entry.update(answer=context, context='', title=text(article.get('title', ''), 'title'))
                if partition != 'train':
                    entries[entry['id']] = entry
                if len(entries) > MAX_ROWS:
                    raise ValueError(f'最多导入 {MAX_ROWS} 篇原文')
                for question_number, qa in enumerate(paragraph['qas'], 1):
                    question_location = f'{location}/第{question_number}问'
                    count += 1
                    if count > MAX_ROWS:
                        raise ValueError(f'最多导入 {MAX_ROWS} 个问题')
                    if not isinstance(qa, dict):
                        raise ValueError(f'{question_location}必须是对象')
                    query = text(qa.get('question'), question_location + ' question', True, maximum=2000)
                    if not isinstance(qa.get('answers'), list) or not qa['answers']:
                        raise ValueError(f'{question_location}需要 answers 标准答案')
                    for answer in qa['answers']:
                        if not isinstance(answer, dict):
                            raise ValueError(f'{question_location}标准答案必须是对象')
                        text(answer.get('text'), question_location + ' answer.text', True)
                    supplied_id = qa.get('id')
                    if supplied_id is not None and (type(supplied_id) not in (str, int) or len(str(supplied_id)) > 500):
                        raise ValueError(f'{question_location} id 必须是最多500字符的文本或整数')
                    question_id = str(supplied_id) if supplied_id is not None else digest(json.dumps([query, context], ensure_ascii=False))
                    if partition == 'train':
                        training = base('qa:' + digest(question_id), 'qa', 'train')
                        training.update(question=query, answer=qa['answers'][0]['text'], context=context,
                                        title=entry['title'])
                        if training['id'] in entries and entries[training['id']] != training:
                            raise ValueError('CMRC 训练样例 ID 重复且内容不同')
                        entries[training['id']] = training
                        continue
                    evaluations.append({'id': f'{dataset}:qa:{question_id}',
                                        'task': 'qa', 'dataset': dataset, 'dataset_name': name,
                                        'query': query, 'expected_ids': [entry['id']], 'split': partition})
    elif fmt in ('records', 'massive'):
        if isinstance(value, dict):
            value = value.get('records', [value])
        if not isinstance(value, list) or not value or len(value) > MAX_ROWS:
            raise ValueError(f'需要 1–{MAX_ROWS} 条记录')
        seen_partitions = {}
        for number, row in enumerate(value, 1):
            try:
                if not isinstance(row, dict):
                    raise ValueError('记录必须是对象')
                if fmt == 'massive' and row.get('locale', 'zh-CN') != 'zh-CN':
                    raise ValueError('仅接受 zh-CN 中文样例')
                kind = 'intent' if fmt == 'massive' else row.get('kind', 'qa')
                if kind not in ('intent', 'qa'):
                    raise ValueError('kind 必须是 intent 或 qa')
                split = row.get('partition', row.get('split', 'train'))
                if split not in ('train', 'dev', 'test'):
                    raise ValueError('split 必须是 train/dev/test')
                query = text(row.get('utt') if fmt == 'massive' else row.get('question'), 'question', True, maximum=2000)
                supplied_id = row.get('id')
                if supplied_id is not None and (type(supplied_id) not in (str, int) or len(str(supplied_id)) > 500):
                    raise ValueError('id 必须是最多500字符的文本或整数')
                identity = json.dumps([kind, query, row.get('answer', '')], ensure_ascii=False)
                raw_key = str(supplied_id) if supplied_id is not None else digest(identity)
                entry = base(digest(raw_key), kind, split)
                if entry['id'] in seen_partitions and seen_partitions[entry['id']] != split:
                    raise ValueError('同一 ID 不能同时位于训练与评测分区')
                seen_partitions[entry['id']] = split
                entry['question'] = query
                if kind == 'intent':
                    label = text(row.get('intent'), 'intent', True, maximum=100)
                    intent = MASSIVE_MAPPING.get(label, '未知') if fmt == 'massive' else label
                    if intent not in APP_INTENTS:
                        raise ValueError('intent 不在应用分类列表中')
                    entry.update(intent=intent, native_label=label)
                    if split != 'train':
                        evaluations.append({'id': entry['id'], 'task': 'intent', 'dataset': dataset,
                                            'dataset_name': name, 'query': query, 'expected_intent': intent,
                                            'expected_native_label': label, 'split': split})
                        continue
                else:
                    if split != 'train':
                        raise ValueError('统一问答记录只接受 train；检索评测请导入 CMRC 格式')
                    entry.update(answer=text(row.get('answer'), 'answer', True),
                                 context=text(row.get('context', ''), 'context'))
                if 'source_name' in row:
                    entry['source_name'] = text(row['source_name'], 'source_name', maximum=200)
                if 'source_url' in row:
                    entry['source_url'] = url(row['source_url'])
                if entry['id'] in entries and entries[entry['id']] != entry:
                    raise ValueError('同一 ID 存在不同记录')
                entries[entry['id']] = entry
            except (ValueError, TypeError) as exc:
                raise ValueError(f'第 {number} 条：{exc}') from exc
    else:
        raise ValueError('format 必须是 records/massive/cmrc')
    if not entries and not evaluations:
        raise ValueError('没有可导入的内容')
    ids = [item['id'] for item in evaluations]
    if len(ids) != len(set(ids)):
        raise ValueError('评测问题 ID 重复')
    return dataset, list(entries.values()), evaluations
