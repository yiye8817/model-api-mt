"""Derived graph views keep every active document's supporting evidence."""
import copy

from .contracts import LearningError, digest, paginate


class GraphService:
    def __init__(self, store):
        self.store = store

    def _collect(self, filters):
        analyses = self.store.active_analyses()
        docs = self.store.list_documents({}, page_size=100)['items']
        # Coverage and filtering must include all pages of the corpus.
        with self.store.connection() as db:
            docs = [self.store._document(db,r['id']) for r in db.execute('SELECT id FROM documents WHERE deleted=0')]
        by_doc = {d['id']:d for d in docs}
        selected = filters.get('document_ids') or []
        if isinstance(selected, str):
            selected = [selected]
        subset = [a for a in analyses if (not selected or a['document_id'] in selected) and
                  (not filters.get('category') or by_doc[a['document_id']]['category'] == filters['category'])]
        concepts, edges = {}, {}
        for a in subset:
            for c in a['concepts']:
                if c['id'] not in concepts:
                    concepts[c['id']] = copy.deepcopy(c)
                    concepts[c['id']]['definitions'] = []
                else:
                    concepts[c['id']]['citations'].extend(c['citations'])
                    concepts[c['id']]['document_ids'] = list(dict.fromkeys(concepts[c['id']]['document_ids']+[a['document_id']]))
                concepts[c['id']]['definitions'].append({'document_id':a['document_id'], 'description':c['description'], 'citations':c['citations']})
                edge_id = digest(a['document_id']+c['id'])[:32]
                edges[edge_id] = {'id':edge_id,'source':'document:'+a['document_id'],'target':c['id'],'type':'包含','citations':c['citations']}
            for edge in a['relations']:
                if edge['id'] not in edges:
                    edges[edge['id']] = copy.deepcopy(edge)
                else:
                    edges[edge['id']]['citations'].extend(edge['citations'])
        return concepts, edges, subset, by_doc, {'analyzed':len(analyses),'total':len(docs)}

    def list_concepts(self, filters, page=1, page_size=30):
        concepts, _, _, _, _ = self._collect(filters)
        q = str(filters.get('q', '')).casefold()
        items = [c for c in concepts.values() if not q or q in (' '.join([c['name'],c['domain'],c['description']]+c['aliases'])).casefold()]
        return paginate(sorted(items,key=lambda c:c['name']), page, page_size)

    def get_concept(self, concept_id, filters=None):
        concepts, edges, _, _, _ = self._collect(filters or {})
        if concept_id not in concepts:
            raise LearningError('知识点不存在或分析已过期', 404)
        return {**concepts[concept_id], 'relations':[e for e in edges.values() if concept_id in (e['source'],e['target'])]}

    def graph(self, filters, page=1, page_size=100):
        concepts, edges, analyses, docs, coverage = self._collect(filters)
        nodes = {i:{'id':i,'label':c['name'],'type':'concept','concept_id':i,'document_id':None} for i,c in concepts.items()}
        for a in analyses:
            i = a['document_id']
            nodes['document:'+i] = {'id':'document:'+i,'label':docs[i]['title'],'type':'document','document_id':i,'concept_id':None}
        focus, q = filters.get('concept_id'), str(filters.get('q', '')).casefold()
        if focus or q:
            wanted = {i for i,n in nodes.items() if (not focus or i == focus) and (not q or q in n['label'].casefold())}
            edges = {i:e for i,e in edges.items() if e['source'] in wanted or e['target'] in wanted}
            wanted |= {end for e in edges.values() for end in (e['source'],e['target'])}
            nodes = {i:n for i,n in nodes.items() if i in wanted}
        node_page = paginate(list(nodes.values()),page,page_size)
        edge_page = paginate(list(edges.values()),page,page_size)
        visible = {n['id'] for n in node_page['items']} | {end for e in edge_page['items'] for end in (e['source'],e['target'])}
        return {'nodes':[n for i,n in nodes.items() if i in visible], 'edges':edge_page['items'], 'total_nodes':len(nodes),
                'total_edges':len(edges), 'page':page,'page_size':page_size,'coverage':coverage}
