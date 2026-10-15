"""Validated JSON contracts shared by storage and HTTP boundaries."""
import hashlib
import json
import time
from typing import TypedDict


class LearningError(ValueError):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


class SourceSnapshot(TypedDict, total=False):
    source_id: str
    origin: str
    title: str
    content_hash: str
    external_revision: int
    locator: dict
    chunks: list[dict]
    status: str


def dumps(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False)


def digest(value):
    return hashlib.sha256(str(value).encode('utf-8')).hexdigest()


def now():
    return time.time()


def text(value, label, maximum=20000, required=True):
    if not isinstance(value, str) or len(value) > maximum or (required and not value.strip()):
        raise LearningError(f'{label} 必须为非空文本，最多 {maximum} 字符')
    return value.strip()


def paginate(items, page=1, page_size=30):
    if type(page) is not int or page < 1 or type(page_size) is not int or not 1 <= page_size <= 100:
        raise LearningError('分页参数无效，每页须为 1–100 项')
    return {'items': items[(page-1)*page_size:page*page_size], 'total': len(items), 'page': page, 'page_size': page_size}
