import re
import threading
from html.parser import HTMLParser

import requests

from .opencli import SearchFailure
from .sources import fetch_page, public_url


class _Article(HTMLParser):
    ignored = {'script', 'style', 'noscript', 'nav', 'header', 'footer', 'aside', 'form'}
    void = {'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'}
    blocks = {'p', 'div', 'section', 'article', 'main', 'li', 'tr', 'td', 'th', 'h1', 'h2', 'h3', 'pre'}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack, self.primary, self.body, self.title = [], [], [], []

    def handle_starttag(self, tag, attrs):
        values = dict(attrs)
        hidden = tag in self.ignored or (self.stack and self.stack[-1][1])
        main = (tag in ('main', 'article') or values.get('role') == 'main' or
                re.search(r'entry-content|post-content|article-body|markdown-body|main-content', (values.get('class') or '') + ' ' + (values.get('id') or '')) or
                (self.stack and self.stack[-1][2]))
        if tag in self.blocks or tag == 'br':
            self.body.append('\n'); self.primary.append('\n')
        if tag not in self.void:
            self.stack.append((tag, bool(hidden), bool(main)))

    def handle_endtag(self, tag):
        for index in range(len(self.stack) - 1, -1, -1):
            if self.stack[index][0] == tag:
                del self.stack[index:]
                break
        if tag in self.blocks:
            self.body.append('\n'); self.primary.append('\n')

    def handle_data(self, value):
        if self.stack and self.stack[-1][0] == 'title':
            self.title.append(value)
        elif not self.stack or not self.stack[-1][1]:
            self.body.append(value)
            if self.stack and self.stack[-1][2]:
                self.primary.append(value)


def _clean(text):
    return '\n'.join(re.sub(r'\s+', ' ', line).strip() for line in text.splitlines() if line.strip()).strip()


def _extract(document):
    html = document.get('html') or ''
    if not html:
        return _clean(document.get('text') or ''), document.get('title') or '', 'text'
    parser = _Article()
    parser.feed(html)
    primary, body = _clean(''.join(parser.primary)), _clean(''.join(parser.body))
    text, method = (primary, 'html_article') if len(primary) >= 40 else (body, 'html_text')
    return text[:18000], ''.join(parser.title).strip() or document.get('title') or '', method


def summarize(text, data, maximum=1200):
    """Select actual sentences; summaries introduce no new model claims."""
    queries = data.get('search_queries') or [{'query': data.get('query', '')}]
    query = ' '.join(row.get('query', '') for row in queries)[:1200].casefold()
    terms = set(re.findall(r'[a-z0-9_]{2,}', query))
    for chunk in re.findall(r'[\u3400-\u9fff]+', query):
        terms.update(chunk[index:index + 2] for index in range(max(1, len(chunk) - 1)))
    terms = sorted(terms, key=lambda term: (-len(term), term))[:128]
    sentences = [value.strip() for value in re.split(r'(?<=[。！？!?])\s*|(?<=\.)\s+|\n+', text) if value.strip()]
    ranked = sorted(range(len(sentences)), key=lambda index: (-sum(term in sentences[index].casefold() for term in terms), index))
    selected, length = set(), 0
    for index in ranked:
        if length >= maximum:
            break
        if selected and length + len(sentences[index]) + 1 > maximum:
            continue
        selected.add(index); length += len(sentences[index]) + 1
    result = '\n'.join(sentences[index] for index in sorted(selected))
    return result if len(result) <= maximum else result[:max(0, maximum - 1)].rstrip() + '…'


class PageParser:
    def __init__(self, fetch=None):
        self.fetch = fetch or fetch_page
        self.lock = threading.Lock()
        self.documents = {}

    def read(self, url, cancel):
        url = public_url(url)
        if not url:
            raise SearchFailure('INVALID_URL', '网页地址不是公网 HTTP 链接')
        if cancel.is_set():
            raise SearchFailure('CANCELLED', '已停止')
        with self.lock:
            leader = url not in self.documents
            entry = self.documents.setdefault(url, {'done': threading.Event(), 'document': None, 'error': None})
        if leader:
            try:
                for attempt in range(2):
                    try:
                        entry['document'] = self.fetch(url, cancel, 18000)
                        break
                    except (requests.Timeout, requests.ConnectionError):
                        if attempt or cancel.wait(.2):
                            raise
            except Exception as exc:
                entry['error'] = exc
            finally:
                entry['done'].set()
        while not entry['done'].wait(.1):
            if cancel.is_set():
                raise SearchFailure('CANCELLED', '已停止')
        if cancel.is_set():
            raise SearchFailure('CANCELLED', '已停止')
        if entry['error']:
            raise entry['error']
        return entry['document']

    def parse(self, source, data, cancel):
        result = {**source, 'content': '', 'summary': '', 'parse_error': '', 'parsed_chars': 0}
        try:
            if not public_url(source.get('url', '')):
                raise SearchFailure('INVALID_URL', '网页链接无效')
            if cancel.is_set():
                raise SearchFailure('CANCELLED', '已停止')
            if source.get('channel') in ('x', 'reddit') and len(source.get('content') or '') >= 40:
                text, title, method = _clean(source['content']), source.get('title', ''), 'opencli_content'
                document = {'url': source['url']}
            else:
                document = self.read(source['url'], cancel)
                text, title, method = _extract(document)
            access_prompt = re.search(
                r'please sign in|sign in to continue|enable javascript (?:to (?:continue|view|use|access)|and cookies)|verify you are human|access denied|请(?:先)?登录(?:后|以)|请.{0,12}启用\s*javascript', text, re.I)
            access_title = re.search(r'^(?:sign[ -]?in|log[ -]?in|just a moment|access denied|attention required|verify you are human|security (?:check|verification)|请?登录|安全验证|人机验证|访问受限|访问被拒绝)(?:[\s.…:：|—-]|$)', title, re.I)
            password_form = re.search(r'<input\b[^>]*\btype\s*=\s*[\'"]?password\b', document.get('html', ''), re.I)
            blocked = (len(text) < 1200 and access_prompt) or (access_title and (access_prompt or password_form))
            if len(text) < 40 or blocked:
                raise SearchFailure('EMPTY_PAGE', '网页未提供可读取正文，可能需要登录或启用页面脚本')
            result.update(parse_status='success', parse_method=method, parsed_chars=len(text), reference_only=False,
                          content=text[:8000], summary=summarize(text, data), title=title or source.get('title', ''),
                          resolved_url=document.get('url') or source['url'], published_at=document.get('published_at') or source.get('published_at', ''))
        except Exception as exc:
            if cancel.is_set():
                raise SearchFailure('CANCELLED', '已停止') from exc
            result.update(parse_status='error', parse_error=str(exc)[:500], parse_method='', reference_only=True)
        return result
