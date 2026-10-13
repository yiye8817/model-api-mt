import hashlib
import re
from dataclasses import replace

from .contracts import Chunk, Position, TextUnit


def text_units(text):
    units, lines, offset, start, in_code = [], [], 0, 0, False
    def flush():
        nonlocal lines, start
        if lines:
            value=''.join(lines)
            line_no=text[:start].count('\n')+1
            units.append(TextUnit(value,Position(start_line=line_no,end_line=line_no+value.rstrip('\n').count('\n'),start_char=start,end_char=start+len(value)), 'code' if value.lstrip().startswith(('```','~~~')) else 'paragraph'))
            lines=[]
    for line in text.splitlines(keepends=True):
        if not in_code and (line.lstrip().startswith(('#','```','~~~')) or not line.strip()):
            flush()
        if not lines: start=offset
        lines.append(line)
        if line.lstrip().startswith(('```','~~~')):
            in_code=not in_code
            if not in_code: flush()
        elif not in_code and not line.strip(): flush()
        offset+=len(line)
    flush()
    return units


def chunk_document(document, target=800, overlap=120, maximum=1600):
    if not 0 <= overlap < target <= maximum:
        raise ValueError('Invalid chunk limits')
    chunks=[]
    for unit in document.units:
        if not unit.text.strip(): continue
        group=hashlib.sha256(unit.text.encode()).hexdigest()[:20] if len(unit.text)>maximum else unit.continuation_group
        start=0
        while start<len(unit.text):
            end=min(len(unit.text),start+(target if group else maximum))
            content=unit.text[start:end]
            pos=replace(unit.position,start_char=unit.position.start_char+start,end_char=unit.position.start_char+end)
            if pos.kind=='lines':
                pos.start_line=unit.position.start_line+unit.text[:start].count('\n')
                pos.end_line=pos.start_line+content.rstrip('\n').count('\n')
            chunks.append(Chunk(id=str(len(chunks)),text=content,position=pos,continuation_group=group))
            if end==len(unit.text): break
            start=end-overlap
    return chunks


def keyword_tokens(text):
    tokens=[]
    for part in re.findall(r'[\u3400-\u9fff]+|[A-Za-z0-9_./\\-]+',text):
        if re.fullmatch(r'[\u3400-\u9fff]+',part):
            tokens.extend(part)
            tokens.extend(part[i:i+2] for i in range(len(part)-1))
        else:
            tokens.append(part.lower())
            tokens.extend(x.lower() for x in re.findall(r'[A-Za-z0-9_]+',part))
    return list(dict.fromkeys(tokens))
