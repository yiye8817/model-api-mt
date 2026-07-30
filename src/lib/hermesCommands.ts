/**
 * Hermes Agent 内置 slash 命令（按使用频率排序）。
 * 参考：https://hermes-agent.nousresearch.com/docs/reference/slash-commands
 */

export interface HermesCommandDef {
  cmd: string;
  desc: string;
}

export const HERMES_COMMANDS: HermesCommandDef[] = [
  // —— 每日必用 ——
  { cmd: 'help', desc: '查看所有可用命令' },
  { cmd: 'model', desc: '查看/切换模型' },
  { cmd: 'clear', desc: '清屏并开始新会话' },
  { cmd: 'new', desc: '新建会话（/reset 同义）' },
  { cmd: 'compress', desc: '手动压缩上下文' },
  { cmd: 'usage', desc: '查看 token 用量' },
  { cmd: 'status', desc: '查看会话状态' },
  { cmd: 'resume', desc: '恢复历史会话' },
  { cmd: 'retry', desc: '重发上一条消息' },
  { cmd: 'undo', desc: '撤销上一轮对话' },
  { cmd: 'yolo', desc: '切换自动批准（跳过确认）' },
  { cmd: 'skills', desc: '搜索/安装 Skills' },
  { cmd: 'skill', desc: '加载指定 Skill 到会话' },
  { cmd: 'reload-skills', desc: '重新扫描 Skills 目录' },
  { cmd: 'tools', desc: '管理工具' },
  { cmd: 'mcp', desc: '管理 MCP 服务器（/reload-mcp）' },
  { cmd: 'plan', desc: '进入计划模式' },
  { cmd: 'goal', desc: '设置持续目标直到完成' },

  // —— 会话控制 ——
  { cmd: 'title', desc: '命名当前会话' },
  { cmd: 'branch', desc: '分支对话（/fork 同义）' },
  { cmd: 'background', desc: '后台运行提示' },
  { cmd: 'queue', desc: '排队下一条指令' },
  { cmd: 'steer', desc: '在工具调用后注入消息' },
  { cmd: 'agents', desc: '查看活跃代理/任务（/tasks）' },
  { cmd: 'stop', desc: '停止后台进程' },
  { cmd: 'rollback', desc: '回滚文件系统检查点' },
  { cmd: 'snapshot', desc: '创建/恢复配置快照' },

  // —— 配置 ——
  { cmd: 'config', desc: '查看/修改配置' },
  { cmd: 'personality', desc: '设置人格风格' },
  { cmd: 'reasoning', desc: '设置推理深度' },
  { cmd: 'verbose', desc: '切换详细输出' },
  { cmd: 'fast', desc: '切换快速模式' },
  { cmd: 'voice', desc: '语音模式' },

  // —— 工具与集成 ——
  { cmd: 'toolsets', desc: '列出工具集' },
  { cmd: 'reload', desc: '重载 .env 变量' },
  { cmd: 'reload-mcp', desc: '重载 MCP 服务器' },
  { cmd: 'cron', desc: '管理定时任务' },
  { cmd: 'kanban', desc: '协作看板' },
  { cmd: 'curator', desc: '后台 Skill 维护' },
  { cmd: 'plugins', desc: '列出插件' },
  { cmd: 'browser', desc: '打开 CDP 浏览器连接' },

  // —— 实用 ——
  { cmd: 'history', desc: '查看对话历史' },
  { cmd: 'save', desc: '保存对话到文件' },
  { cmd: 'copy', desc: '复制最近回复到剪贴板' },
  { cmd: 'paste', desc: '附加剪贴板图片' },
  { cmd: 'image', desc: '附加本地图片' },
  { cmd: 'insights', desc: '使用分析报表' },
  { cmd: 'debug', desc: '上传调试报告' },
  { cmd: 'profile', desc: '当前 profile 信息' },

  // —— 退出 ——
  { cmd: 'quit', desc: '退出（/exit、/q 同义）' },
];

export const HERMES_COMMAND_ORDER = HERMES_COMMANDS.map((c) => c.cmd);
export const HERMES_COMMON_COUNT = 18;

const ORDER_MAP = new Map(HERMES_COMMAND_ORDER.map((c, i) => [c, i]));
const DESC_MAP = new Map(HERMES_COMMANDS.map((c) => [c.cmd, c.desc]));

export function getHermesCommandDesc(cmd: string): string | undefined {
  return DESC_MAP.get(cmd);
}

export function sortHermesCommands(cmds: string[]): string[] {
  return [...cmds].sort((a, b) => {
    const ai = ORDER_MAP.get(a) ?? 10000;
    const bi = ORDER_MAP.get(b) ?? 10000;
    if (ai !== bi) return ai - bi;
    return a.localeCompare(b);
  });
}

export function buildAllHermesCommands(sessionSkills: string[] = []): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (c: string) => {
    const k = c.trim();
    if (!k || seen.has(k)) return;
    seen.add(k);
    out.push(k);
  };
  for (const c of HERMES_COMMAND_ORDER) add(c);
  for (const c of sortHermesCommands(sessionSkills)) add(c);
  return out;
}
