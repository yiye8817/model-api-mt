"""Bounded parsing and position-preserving chunks for learning documents."""
from dataclasses import asdict
from pathlib import Path
import re

from local_knowledge.parsers import parse_file, ParseError
from local_knowledge.text import text_units
from web_research.sources import fetch_page, public_url
from web_research.pages import extract_article
from .contracts import LearningError, digest, now

SUFFIXES = {'.txt', '.md', '.markdown', '.pdf', '.docx'}


def parse_upload(path, cancel):
    path = Path(path)
    if path.suffix.lower() not in SUFFIXES:
        raise LearningError('支持的文件格式为 TXT、Markdown、PDF 和 DOCX')
    if path.stat().st_size > 20*1024*1024:
        raise LearningError('单文件不能超过 20 MiB')
    try:
        parsed = parse_file(path, cancel_event=cancel)
    except ParseError as exc:
        messages = {'scanned_or_empty_pdf': 'PDF 没有可提取文字，扫描件需先转成文字', 'encrypted_pdf': '无法读取加密 PDF',
                    'empty_document': '文档没有正文', 'unsupported_encoding': '请上传 UTF-8 编码文本', 'cancelled': '任务已取消'}
        reason = str(exc)
        if 'No module named' in reason:
            reason = '缺少 PDF 或 DOCX 解析依赖，请安装 requirements-knowledge.txt'
        raise LearningError(messages.get(reason, '文档解析失败：'+reason)) from exc
    return {'title': path.name, 'units': [asdict(u) for u in parsed.units], 'warnings': parsed.warnings,
            'source': {'origin': 'learning', 'locator': {'kind': 'upload', 'filename': path.name}}}


def parse_link(url, cancel):
    url = public_url(url)
    if not url:
        raise LearningError('请输入公开 HTTP 或 HTTPS 网页链接')
    try:
        document = fetch_page(url, cancel, max_chars=512000)
        body, title, _ = extract_article(document, max_chars=None)
    except Exception as exc:
        raise LearningError('网页读取失败：'+str(exc)[:300]) from exc
    blocked = re.search(r'^(?:sign[ -]?in|log[ -]?in|just a moment|access denied|登录|安全验证)', title, re.I)
    if len(body.strip()) < 40 or blocked or (len(body) < 1200 and re.search(r'please sign in|sign in to continue|verify you are human|请.{0,8}登录|enable javascript', body, re.I)):
        raise LearningError('网页未提供可读取正文，可能需要登录或启用页面脚本')
    return {'title': title or url, 'units': [asdict(u) for u in text_units(body)],
            'warnings': ['网页快照达到 512000 bytes 抓取上限，分析仅覆盖已保存正文'] if document.get('truncated') else [],
            'source': {'origin': 'learning', 'locator': {'kind': 'web', 'url': url, 'resolved_url': document.get('url') or url, 'fetched_at': now()}}}


def make_chunks(units, document_id='', revision=1):
    result = []
    for unit in units:
        value = unit['text']
        if not value.strip():
            continue
        for offset in range(0, len(value), 1440):
            part = value[offset:offset+1600]
            position = dict(unit.get('position') or {'kind': 'lines'})
            position['start_char'] = position.get('start_char', 0)+offset
            position['end_char'] = position['start_char']+len(part)
            if position.get('kind') == 'lines':
                position['start_line'] = position.get('start_line', 1)+value[:offset].count('\n')
                position['end_line'] = position['start_line']+part.rstrip('\n').count('\n')
            result.append({'text': part, 'position': position, 'ordinal': len(result)})
            if offset+1600 >= len(value):
                break
    return result
