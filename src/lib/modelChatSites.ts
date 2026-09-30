/**
 * 常用模型的官方聊天网页入口。
 *
 * 这些地址只用于在“+ -> 浏览器网页”中快速打开网页，不代表网页端
 * 自动化适配器已经支持对应站点。用户仍然可以像普通浏览器标签一样
 * 登录并使用它们。
 */
export type ModelChatSite = {
  id: string;
  name: string;
  url: string;
};

export const DEFAULT_MODEL_CHAT_SITES: readonly ModelChatSite[] = [
  { id: 'chatgpt', name: 'ChatGPT', url: 'https://chatgpt.com/' },
  { id: 'deepseek', name: 'DeepSeek', url: 'https://chat.deepseek.com/' },
  { id: 'qwen', name: '通义千问', url: 'https://chat.qwen.ai/' },
  { id: 'doubao', name: '豆包', url: 'https://www.doubao.com/chat/' },
  { id: 'yuanbao', name: '腾讯元宝', url: 'https://yuanbao.tencent.com/' },
  { id: 'kimi', name: 'Kimi', url: 'https://www.kimi.com/' },
  { id: 'glm', name: '智谱 GLM', url: 'https://chat.z.ai/' },
  { id: 'mimo', name: '小米 MiMo', url: 'https://mimo.mi.com/' },
  { id: 'wenxin', name: '百度文心', url: 'https://wenxin.baidu.com/' },
  { id: 'spark', name: '讯飞星火', url: 'https://spark.xfyun.cn/' },
  { id: 'stepfun', name: '阶跃星辰', url: 'https://chat.stepfun.com/' },
  { id: 'claude', name: 'Claude', url: 'https://claude.ai/new' },
  { id: 'gemini', name: 'Gemini', url: 'https://gemini.google.com/' },
  { id: 'grok', name: 'Grok', url: 'https://grok.com/' },
  { id: 'poe', name: 'Poe', url: 'https://poe.com/' },
];
