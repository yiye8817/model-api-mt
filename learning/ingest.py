"""Bounded parsing and position-preserving chunks for learning documents."""
from dataclasses import asdict
from pathlib import Path
import re

from local_knowledge.parsers import parse_file, ParseError
from local_knowledge.text import text_units
from web_research.sources import fetch_page, public_url
from web_research.pages import extract_article
from .contracts import LearningError, digest, now
from .ocr import recognize_pdf, validate_pages, page_units, MAX_TEXT

SUFFIXES = {'.txt', '.md', '.markdown', '.pdf', '.docx'}


def parse_upload(path, cancel, hermes=None, progress=None, options=None):
    path = Path(path)
    if path.suffix.lower() not in SUFFIXES:
        raise LearningError('支持的文件格式为 TXT、Markdown、PDF 和 DOCX')
    if path.stat().st_size > 20*1024*1024:
        raise LearningError('单文件不能超过 20 MiB')
    try:
        parsed = parse_file(path, cancel_event=cancel, allow_scan_placeholders=path.suffix.lower()=='.pdf')
    except ParseError as exc:
        messages = {'scanned_or_empty_pdf': 'PDF 没有正文或可识别的扫描图像', 'encrypted_pdf': '无法读取加密 PDF',
                    'empty_document': '文档没有正文', 'unsupported_encoding': '请上传 UTF-8 编码文本', 'cancelled': '任务已取消'}
        reason = str(exc)
        if 'No module named' in reason:
            reason = '缺少 PDF 或 DOCX 解析依赖，请安装 requirements-knowledge.txt'
        raise LearningError(messages.get(reason, '文档解析失败：'+reason)) from exc
    units=[asdict(u) for u in parsed.units]
    scans=[u.position.page for u in parsed.units if u.kind=='scan']
    if scans:
        recognized=validate_pages(recognize_pdf(path,scans,cancel,hermes=hermes,progress=progress,options=options),scans)
        by_page={page['page']:page for page in recognized}
        expanded=[]
        for unit in units:
            if unit['kind']!='scan':
                expanded.append(unit);continue
            recognized_units=page_units(by_page[unit['position']['page']])
            native=''.join(unit['text'].split())
            if not recognized_units or native and native not in ''.join(''.join(part['text'].split()) for part in recognized_units):
                expanded.append({**unit,'kind':'paragraph'})
            expanded.extend(recognized_units)
        units=expanded
        offset=0
        for unit in units:
            unit['position'].update(start_char=offset,end_char=offset+len(unit['text']))
            offset+=len(unit['text'])+1
            if offset>MAX_TEXT:raise LearningError('OCR 后文档文字超过解析上限')
        if not any(unit['text'].strip() for unit in units):
            raise LearningError('OCR 未识别到可用文字，请检查扫描清晰度')
        if any(page['lines'] for page in recognized):
            parsed.warnings.append('扫描页已通过 OCR 转为文字，保留页码和文字位置；识别结果请对照原页核对。')
        for page in recognized:
            if not page['lines']:
                parsed.warnings.append(f'第 {page["page"]} 页 OCR 未识别到文字，可能为空白扫描页，请对照原页核对。')
    if cancel.is_set():raise LearningError('任务已取消')
    return {'title': path.name, 'units': units, 'warnings': parsed.warnings,
            'source': {'origin': 'learning', 'locator': {'kind': 'upload', 'filename': path.name,
                **({'pdf_ocr_version':1} if path.suffix.lower()=='.pdf' else {})}}}


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
