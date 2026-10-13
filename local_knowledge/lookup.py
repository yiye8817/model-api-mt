"""Literal document definitions, with quotations tied to indexed chunks."""
import re
import unicodedata
from dataclasses import dataclass, replace
from html import unescape
from .intents import parse_knowledge_question


def excerpt_constraints_supported(request):
    allowed = {'', '中文', '中文回答', '用中文回答', '请用中文回答', '请用中文回复', '简体中文回答'}
    normalize = lambda value: re.sub(r'\s+', '', unicodedata.normalize('NFKC', value)).rstrip('。.!')
    if normalize(request.get('system_constraints', '')) not in allowed:
        return False
    for message in request.get('context', []):
        text = message.get('content', '')
        if message.get('role') == 'system' and normalize(text) not in allowed:
            return False
        if message.get('role') == 'user' and re.search(r'回答|回复|输出|格式|字数|语言|\b(?:answers?|respond|return|output|format|language)\b', text, re.I):
            return False
    return True


def lookup_term(question):
    query=parse_knowledge_question(question)
    return query.topic if query else None


def term_variants(term):
    # A single known homophone substitution, confirmed by the document's
    # own heading/definition. Never change numbers, versions, or other terms.
    yield term
    if len(term) >= 4:
        for index, char in enumerate(term):
            if char in '级极':
                yield term[:index] + ('级' if char == '极' else '极') + term[index+1:]


def plain_text(value):
    value = re.sub(r'<(script|style)\b[^>]*>.*?</\1\s*>', '', value, flags=re.I|re.S)
    value = re.sub(r'<sup\b[^>]*>(.*?)</sup>', r'^(\1)', value, flags=re.I|re.S)
    value = re.sub(r'</?(?:h[1-6]|p|div|li|ul|ol|blockquote|br)\b[^>]*>', '\n', value, flags=re.I)
    value = unescape(re.sub(r'<[^>]*>', '', value))
    return re.sub(r'\n\s*\n+', '\n\n', re.sub(r'[^\S\n]+', ' ', value)).strip()


def heading_labels(value):
    value = plain_text(value).strip().strip('#').strip()
    short = re.sub(r'^\d+(?:\.\d+)*[.、\s]+', '', value).strip()
    return {value.casefold(), short.casefold()}


@dataclass
class Excerpt:
    answer: str
    quotes: list
    quality: int = 1


def document_excerpt(chunks, term):
    """Read a heading's body, including at most two following chunks."""
    raw, spans, last_end = '', [], None
    for chunk in chunks:
        overlap = max(0, (last_end or chunk.position.start_char) - chunk.position.start_char)
        offset = min(len(chunk.text), overlap)
        if raw and last_end is not None and chunk.position.start_char > last_end:
            raw += '\n'
        begin = len(raw)
        raw += chunk.text[offset:]
        spans.append((chunk, begin, len(raw), offset))
        last_end = chunk.position.end_char
    headings = [(m.start(), m.end(), heading_labels(m[1])) for m in re.finditer(r'<h[1-6]\b[^>]*>(.*?)</h[1-6]\s*>', raw, re.I|re.S)]
    headings += [(m.start(), m.end(), heading_labels(m[1])) for m in re.finditer(r'^#{1,6}\s+([^\n]+)', raw, re.M)]
    headings.sort(key=lambda h:h[:2])
    selected = next((h for h in headings if term.casefold() in h[2]), None)
    quality=4 if selected else 1
    if selected:
        start, body_start, _ = selected
    else:
        alias=re.search(r'(?:^|[\n。!?！？])\s*([^\n。]{0,150}(?:称为|叫做|称作|又称)[^\n。]{0,100}[（(]\s*'+re.escape(term)+r'\s*[）)])',raw,re.I)
        definition = alias or re.search(r'(?:^|[\n。!?！？])\s*(' + re.escape(term) + r'\s*(?:是|指|就是|用于|通过|采用|由|：|:))', raw, re.I)
        if not definition:
            return None
        if alias:quality=3
        start, body_start = definition.start(1), definition.start(1)
    end = min(next((h[0] for h in headings if h[0] > body_start), len(raw)), start+3200)
    # A title/link in a contents page is not a definition.
    body = re.sub(r'<a\b[^>]*>.*?</a\s*>', '', raw[body_start:end], flags=re.I|re.S)
    if len(re.sub(r'\s', '', plain_text(body))) < 24:
        return None
    quotes = []
    for chunk, begin, finish, offset in spans:
        left, right = max(start, begin), min(end, finish)
        if left >= right:
            continue
        first, last = offset+left-begin, offset+right-begin
        quote = chunk.text[first:last]
        position = replace(chunk.position, start_char=chunk.position.start_char+first,
                           end_char=chunk.position.start_char+last)
        if position.kind == 'lines':
            position.start_line = chunk.position.start_line+chunk.text[:first].count('\n')
            position.end_line = position.start_line+quote.rstrip('\n').count('\n')
        quotes.append((chunk, quote, position))
    return Excerpt(plain_text(raw[start:end])[:2400], quotes, quality)
