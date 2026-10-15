"""Scope every evidence lookup to an explicit document revision snapshot."""
import json
import re

from local_knowledge.text import keyword_tokens
from knowledge.matching import tokens
from .contracts import LearningError
from .evidence import validate_citations


class Retriever:
    def __init__(self, store, semantic_lookup=None):
        self.store, self.semantic_lookup = store, semantic_lookup

    def search(self, question, revisions, limit=12):
        if not self.store.revisions_current(revisions):
            raise LearningError('资料已更新，请重新提问', 409)
        if re.search(r'概括|总结|主要内容|全文|(?:文档|资料|文章).{0,8}(?:讲|内容|结构)',question):
            groups=[];per_document=max(1,limit//max(1,len(revisions)))
            for doc_id,revision in revisions.items():
                chunks=[c for c in self.store.get_chunks(doc_id,revision) if c['text'].strip()]
                count=min(per_document,len(chunks))
                groups.append([chunks[round(i*(len(chunks)-1)/max(1,count-1))] for i in range(count)])
            return [group[i] for i in range(per_document) for group in groups if i<len(group)][:limit]
        lexical_question = re.sub(r'是多少|是什么|多少|什么|多久|如何|怎么|是否|请问|请解释|解释一下|告诉我', ' ', question)
        terms = list(dict.fromkeys(tokens(lexical_question)))[:100]
        if not terms or not revisions:
            return []
        query = ' OR '.join('"'+term.replace('"','""')+'"' for term in terms)
        args, conditions = [query], []
        for document_id, revision in revisions.items():
            conditions.append('(c.document_id=? AND c.revision=?)')
            args.extend((document_id,revision))
        with self.store.connection() as db:
            rows = db.execute('SELECT c.body FROM chunks_fts f JOIN chunks c ON c.id=f.id WHERE chunks_fts MATCH ? AND ('+
                ' OR '.join(conditions)+') ORDER BY bm25(chunks_fts) LIMIT ?', (*args,limit)).fetchall()
        result = [json.loads(row['body']) for row in rows]
        if self.semantic_lookup:
            try:
                extra = self.semantic_lookup(question,revisions,limit)
                for hit in extra:
                    if hit.get('document_id') in revisions and hit.get('revision') == revisions[hit['document_id']]:
                        valid = next((c for c in self.store.get_chunks(hit['document_id'],hit['revision']) if c['id'] == hit.get('id')), None)
                        if valid and all(c['id'] != valid['id'] for c in result):
                            result.append(valid)
            except Exception:
                pass
        return result[:limit]
