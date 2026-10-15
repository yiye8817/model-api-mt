/** Keep aligned with knowledge/freshness.py; model-classified 讯息 also enables search. */
export function isCurrentInformationQuery(question: string): boolean {
  if (/^\s*(?:请|帮我|请帮我)?\s*(?:翻译|润色|改写|校对|格式化)\s*(?:这句话|以下|如下|这段|[“"「『]|[^:：\n]{0,12}[:：])/.test(question)) return false;
  const subject = question.replace(/最近最少使用|最近最久未使用|当前(?:的)?(?:函数|方法|代码|目录|文件|进程|系统|程序|对象|线程|工作区|会话)/g, '');
  return /最新|近期|最近|新发布|新推出|刚发布|当前|现在|今日|今天|本周|这周|本月|这个月|今年|现任|现阶段|此刻|实时(?!操作系统|系统|计算|性|处理|线程|调度)|\b(?:latest|newest|recent(?:ly)?|current(?:ly)?|today|now|this\s+(?:week|month|year)|up.to.date)\b|(?:天气|汇率|股价|行情|油价|金价|票价|比分).{0,12}(?:多少|怎样|怎么样|如何|预报|查询)/i.test(subject);
}

export function searchTimeLimit(question: string): 'd' | 'w' | 'm' | 'y' {
  if (/今日|今天|此刻|实时|\b(?:today|now)\b/i.test(question)) return 'd';
  if (/本周|这周|\bthis\s+week\b/i.test(question)) return 'w';
  if (/今年|\bthis\s+year\b/i.test(question)) return 'y';
  return 'm';
}
