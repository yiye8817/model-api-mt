"""Recognize requests whose answers need current external evidence."""
import re


def needs_current_information(question):
    if re.search(r'^\s*(?:请|帮我|请帮我)?\s*(?:翻译|润色|改写|校对|格式化)\s*'
                 r'(?:这句话|以下|如下|这段|[“"「『]|[^:：\n]{0,12}[:：])', question):
        return False
    question = re.sub(r'最近最少使用|最近最久未使用|当前(?:的)?(?:函数|方法|代码|目录|文件|进程|系统|程序|对象|线程|工作区|会话)', '', question)
    return bool(re.search(
        r'最新|近期|最近|新发布|新推出|刚发布|当前|现在|今日|今天|本周|这周|本月|这个月|今年|现任|现阶段|此刻|'
        r'实时(?!操作系统|系统|计算|性|处理|线程|调度)|'
        r'\b(?:latest|newest|recent(?:ly)?|current(?:ly)?|today|now|this\s+(?:week|month|year)|up.to.date)\b|'
        r'(?:天气|汇率|股价|行情|油价|金价|票价|比分).{0,12}(?:多少|怎样|怎么样|如何|预报|查询)',
        question, re.I))


def search_time_limit(question):
    if re.search(r'今日|今天|此刻|实时|\b(?:today|now)\b', question, re.I):
        return 'd'
    if re.search(r'本周|这周|\bthis\s+week\b', question, re.I):
        return 'w'
    if re.search(r'今年|\bthis\s+year\b', question, re.I):
        return 'y'
    return 'm'
