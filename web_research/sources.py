import hashlib
import ipaddress
import re
import socket
from contextlib import contextmanager
from html.parser import HTMLParser
from urllib.parse import urljoin, urlsplit, urlunsplit

import requests


class _PinnedTLS(requests.adapters.HTTPAdapter):
    def __init__(self, hostname):
        self.hostname = hostname
        super().__init__()

    def init_poolmanager(self, connections, maxsize, block=False, **kwargs):
        # The socket connects to an IP literal; TLS still verifies the origin.
        kwargs.update(server_hostname=self.hostname, assert_hostname=self.hostname)
        super().init_poolmanager(connections, maxsize, block=block, **kwargs)


@contextmanager
def _public_get(url, address, **kwargs):
    parts = urlsplit(url)
    literal = f'[{address}]' if ':' in address else address
    authority = literal + (f':{parts.port}' if parts.port else '')
    pinned = urlunsplit((parts.scheme, authority, parts.path, parts.query, ''))
    headers = {**kwargs.pop('headers', {}), 'Host': parts.netloc}
    with requests.Session() as session:
        session.trust_env = False
        if parts.scheme == 'https':
            session.mount('https://', _PinnedTLS(parts.hostname))
        with session.get(pinned, headers=headers, **kwargs) as response:
            yield response


def public_url(value):
    try:
        parts = urlsplit(str(value))
        if parts.scheme not in ('http', 'https') or not parts.hostname or parts.username or parts.password:
            return ''
        host = parts.hostname.lower()
        host = host.rstrip('.')
        if host == 'localhost' or host.endswith(('.localhost', '.local')):
            return ''
        try:
            if not ipaddress.ip_address(host).is_global:
                return ''
        except ValueError:
            # inet_aton also accepts shortened, integer and hexadecimal IPv4.
            try:
                address = ipaddress.ip_address(socket.inet_aton(host))
                if not address.is_global:
                    return ''
            except OSError:
                pass
        return urlunsplit((parts.scheme, parts.netloc, parts.path or '/', parts.query, ''))
    except ValueError:
        return ''


def fetch_page(url, cancel, max_chars=2500):
    """Read a bounded public page, validating DNS and every redirect target."""
    from .opencli import SearchFailure
    current = url
    for _ in range(4):
        if cancel.is_set():
            raise SearchFailure('CANCELLED', '已停止')
        current = public_url(current)
        if not current:
            raise SearchFailure('INVALID_URL', '网页地址不是公网 HTTP 链接')
        parts = urlsplit(current)
        try:
            addresses = socket.getaddrinfo(parts.hostname, parts.port or (443 if parts.scheme == 'https' else 80), type=socket.SOCK_STREAM)
            if not addresses or any(not ipaddress.ip_address(item[4][0]).is_global or
                                    ipaddress.ip_address(item[4][0]).is_multicast for item in addresses):
                raise SearchFailure('INVALID_URL', '网页地址解析到非公网网络')
        except (OSError, ValueError) as exc:
            raise SearchFailure('PAGE_UNAVAILABLE', '网页地址无法解析') from exc
        # Use a verified IP literal so the HTTP library cannot resolve the
        # hostname again to a different address between validation and connect.
        address = sorted({item[4][0] for item in addresses}, key=lambda ip: ipaddress.ip_address(ip).version)[0]
        with _public_get(current, address, allow_redirects=False, stream=True, timeout=(5, 8),
                         headers={'User-Agent': 'Mozilla/5.0 (compatible; WebResearch/1.0)'}) as response:
            if response.status_code in (301, 302, 303, 307, 308):
                location = response.headers.get('Location')
                if not location:
                    raise SearchFailure('PAGE_UNAVAILABLE', '网页重定向没有目标地址')
                current = urljoin(current, location)
                continue
            if response.status_code >= 400:
                raise SearchFailure('PAGE_UNAVAILABLE', f'网页读取失败（HTTP {response.status_code}）')
            content_type = response.headers.get('Content-Type', '').lower()
            if content_type and not any(kind in content_type for kind in ('text/', 'html', 'xml')):
                raise SearchFailure('PAGE_UNAVAILABLE', '链接没有可解析的网页正文')
            body = bytearray()
            for chunk in response.iter_content(16384):
                if cancel.is_set():
                    raise SearchFailure('CANCELLED', '已停止')
                body.extend(chunk[:max(0, 512000 - len(body))])
                if len(body) >= 512000:
                    break
            html = bytes(body).decode(response.encoding or 'utf-8', 'replace')
        parser = _PageText()
        parser.feed(html)
        text = re.sub(r'\s+', ' ', ' '.join(parser.text)).strip()[:max_chars]
        return {'url': current, 'title': ''.join(parser.title).strip()[:300], 'text': text,
                'html': html, 'published_at': parser.published_at}
    raise SearchFailure('PAGE_UNAVAILABLE', '网页重定向次数过多')


class _PageText(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.text, self.title = [], []
        self.hidden, self.in_title, self.published_at = 0, False, ''

    def handle_starttag(self, tag, attrs):
        if tag in ('script', 'style', 'noscript'):
            self.hidden += 1
        if tag == 'title':
            self.in_title = True
        if tag == 'meta':
            values = dict(attrs)
            if values.get('property') in ('article:published_time', 'og:published_time') or values.get('name') in ('date', 'datePublished'):
                self.published_at = values.get('content', '')[:100]

    def handle_endtag(self, tag):
        if tag in ('script', 'style', 'noscript'):
            self.hidden = max(0, self.hidden - 1)
        if tag == 'title':
            self.in_title = False

    def handle_data(self, data):
        if self.in_title:
            self.title.append(data)
        elif not self.hidden:
            self.text.append(data)


def normalize(row, channel):
    if not isinstance(row, dict):
        return None
    url = public_url(row.get('url') or row.get('link') or row.get('href') or '')
    if not url:
        return None
    result = {'id': hashlib.sha256(f'{channel}:{url}'.encode()).hexdigest()[:20], 'channel': channel,
            'kind': 'source', 'url': url, 'title': str(row.get('title') or row.get('author') or url)[:300],
            'snippet': str(row.get('snippet') or row.get('body') or row.get('text') or row.get('selftext') or row.get('title') or '')[:2000],
            'content': str(row.get('content') or row.get('selftext') or row.get('text') or '')[:5000],
            'published_at': str(row.get('published_at') or row.get('date') or row.get('created_at') or row.get('published') or row.get('created_utc') or ''),
            'official_candidate': channel == 'official'}
    return annotate_query(result, {'language': row['query_language'], 'query': row.get('search_query', '')}) if row.get('query_language') else result


def annotate_query(source, query):
    language = query['language']
    row = {**source, 'query_language': language, 'search_query': query['query']}
    if language != 'original':
        row['id'] = hashlib.sha256(f"{row.get('channel', 'web')}:{row.get('url', '')}:{language}".encode()).hexdigest()[:20]
    return row


def official_links(base, html):
    links = []
    base_host = urlsplit(base).hostname
    class Parser(HTMLParser):
        def handle_starttag(self, tag, attrs):
            if tag != 'a':
                return
            href = dict(attrs).get('href', '')
            url = public_url(urljoin(base, href))
            if (url and url != base and urlsplit(url).hostname == base_host
                and re.search(r'docs?|documentation|releases?|changelog|manual|guide|download', urlsplit(url).path, re.I)
                and url not in links):
                links.append(url)
    Parser().feed(html[:1000000])
    return links[:3]


def select_sources(sources, per_channel=2, maximum=16, require_parsed=False):
    """Retain official candidates first, then give every successful channel space."""
    groups = {}
    for source in sources:
        if require_parsed and (source.get('parse_status') != 'success' or not source.get('summary')):
            continue
        if not source.get('reference_only') and public_url(source.get('url', '')) and (source.get('content') or source.get('snippet')):
            groups.setdefault((source.get('channel', 'web'), source.get('query_language', 'original')), []).append(source)
    keys = sorted(groups, key=lambda key: (key[0] != 'official', key))
    selected, seen = [], set()
    for offset in range(per_channel):
        for key in keys:
            rows = [s for s in groups[key] if s['url'] not in seen]
            if rows:
                item = rows[0]; seen.add(item['url']); selected.append(item)
                if len(selected) == maximum:
                    return selected
    return selected
