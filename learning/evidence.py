"""Never accept a model supplied source or quote without the saved evidence."""
from .contracts import LearningError


def validate_citations(citations, evidence):
    if not isinstance(citations, list):
        raise LearningError('引用必须为数组')
    by_id = {c['id']: c for c in evidence}
    result = []
    for citation in citations:
        if not isinstance(citation, dict):
            raise LearningError('引用格式无效')
        chunk = by_id.get(citation.get('chunk_id'))
        quote = citation.get('quote')
        if not chunk or not isinstance(quote, str) or not quote.strip() or quote not in chunk['text']:
            raise LearningError('引用不属于提供的原文片段')
        if citation.get('document_id', chunk['document_id']) != chunk['document_id'] or citation.get('revision', chunk['revision']) != chunk['revision']:
            raise LearningError('引用文档或修订不匹配')
        result.append({'document_id': chunk['document_id'], 'revision': chunk['revision'], 'chunk_id':chunk['id'],
                       'quote':quote, 'position':chunk.get('position', {}), 'title':chunk.get('title', '')})
    return result
