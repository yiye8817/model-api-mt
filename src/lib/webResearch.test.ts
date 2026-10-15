import { expect, it } from 'vitest';
import { isCurrentInformationQuery, searchTimeLimit } from './webResearch';

it.each([
  ['近期有哪些内存性能工具', true], ['最近Linux发布了什么版本', true], ['这周有哪些科技新闻', true],
  ['What is the newest kernel release?', true], ['Who is the prime minister now?', true],
  ['现任英国首相是谁', true], ['美元兑人民币汇率是多少', true], ['Linux新发布的版本有哪些', true],
  ['请翻译今天发布的 Linux 内核公告', true], ['翻译并介绍最新版本的新功能', true],
  ['什么是TLB', false], ['内存性能工具有哪些', false], ['多级页表是什么', false], ['解释汇率是什么', false],
  ['解释实时操作系统的原理', false], ['解释最近最少使用算法', false], ['当前函数的作用是什么', false],
  ['编写脚本读取当前目录', false], ['翻译这句话：“今天发布了最新版本”', false],
] as const)('query %s needs fresh external evidence: %s', (question, expected) => {
  expect(isCurrentInformationQuery(question)).toBe(expected);
});

it.each([['今天的新闻', 'd'], ['Who is the prime minister now?', 'd'], ['这周有哪些新闻', 'w'],
  ['今年的发布记录', 'y'], ['最新的Linux内核', 'm']] as const)('query %s sets DDGS window %s', (question, expected) => {
  expect(searchTimeLimit(question)).toBe(expected);
});
