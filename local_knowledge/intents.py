"""Parse self-contained definition/purpose questions without losing qualifiers."""
import re
import unicodedata
from dataclasses import dataclass


@dataclass(frozen=True)
class KnowledgeQuestion:
    topic: str
    facets: frozenset


def topic_key(value):
    return re.sub(r'\s+', ' ', unicodedata.normalize('NFKC', value)).strip().casefold()


def parse_knowledge_question(question):
    value=unicodedata.normalize('NFKC',question).strip().rstrip('?!。').strip()
    value=re.sub(r'^请问\s*','',value)
    if re.search(r'区别|比较|对比|能否|是否|为什么|如何|怎么|最新|当前|现在|今日|今天|实时|^(?:执行|删除|生成|安装|修改|配置|帮我)|\b(?:why|how|compare|run|delete|latest|currently)\b',value,re.I):
        return None
    topic=None;facets=set()
    parts=re.split(r'[,，;；、]',value)
    for part in parts:
        part=part.strip()
        match=re.fullmatch(r'(?:什么是|什么叫|何为|(?:请)?解释(?:一下)?|(?:请)?介绍一下)\s*(.+)',part)
        suffix=re.fullmatch(r'(.+?)(?:是什么意思|是什么|是啥|的定义|的含义)',part)
        english=re.fullmatch(r'(?:what (?:is|are)|define)\s+(.+)',part,re.I)
        purpose=re.fullmatch(r'(.+?)(?:有什么用(?:处)?|有什么作用|有哪些作用|有什么用途|有何作用|的作用(?:是什么)?|的用途(?:是什么)?|用来做什么)',part)
        if purpose:
            current=purpose[1].strip();facet='purpose'
        elif match or suffix or english:
            current=(match or suffix or english)[1].strip();facet='definition'
        elif topic and re.fullmatch(r'有什么用(?:处)?|有什么作用|有哪些作用|有什么用途',part):
            current=topic;facet='purpose'
        elif len(parts)==1:
            current=part;facet='definition'
        else:return None
        if not re.fullmatch(r'[\w .+/\-]{2,80}',current) or current in ('这个','那个','上述','之前') or re.search(r'有什么|有何|多久|哪些|多少',current):return None
        if topic is not None and topic_key(current)!=topic_key(topic):return None
        topic=current;facets.add(facet)
    return KnowledgeQuestion(topic,frozenset(facets)) if topic and facets else None


def covers(query,saved):
    return bool(query and saved and topic_key(query.topic)==topic_key(saved.topic) and query.facets<=saved.facets)
