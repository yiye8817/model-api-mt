/**
 * Claude Code 内置 slash 命令完整列表（按使用频率排序，最常用的在最前）。
 * 参考：https://code.claude.com/docs/en/commands
 */

export interface ClaudeCommandDef {
  cmd: string;
  desc: string;
}

/** 完整内置命令：顺序即优先级（补全、右侧面板、/help 均按此排序）。 */
export const CLAUDE_COMMANDS: ClaudeCommandDef[] = [
  // —— 每日必用 ——
  { cmd: 'help', desc: '查看所有可用命令' },
  { cmd: 'clear', desc: '清空对话，开始新任务' },
  { cmd: 'compact', desc: '压缩上下文以节省 token' },
  { cmd: 'model', desc: '查看/切换模型' },
  { cmd: 'plan', desc: '进入计划模式（大改动前先规划）' },
  { cmd: 'context', desc: '查看上下文窗口占用' },
  { cmd: 'usage', desc: '查看用量、费用与限额（/cost、/stats 同义）' },
  { cmd: 'resume', desc: '恢复历史会话（/continue 同义）' },
  { cmd: 'rewind', desc: '回退到检查点（/checkpoint、/undo 同义）' },
  { cmd: 'review', desc: '审查 GitHub PR' },
  { cmd: 'code-review', desc: '审查当前 diff，可加 --fix 自动修复' },
  { cmd: 'init', desc: '生成/更新 CLAUDE.md 项目指南' },
  { cmd: 'memory', desc: '编辑 CLAUDE.md 记忆与 auto-memory' },
  { cmd: 'permissions', desc: '管理工具权限规则（/allowed-tools 同义）' },
  { cmd: 'config', desc: '打开设置（/settings 同义）' },
  { cmd: 'status', desc: '查看版本、模型、账号与连接状态' },
  { cmd: 'doctor', desc: '诊断安装与配置，可按 f 自动修复' },
  { cmd: 'diff', desc: '交互式查看未提交改动与每轮 diff' },

  // —— 项目与工具 ——
  { cmd: 'mcp', desc: '管理 MCP 服务器连接' },
  { cmd: 'skills', desc: '列出可用 Skills' },
  { cmd: 'agents', desc: '管理子代理（subagents）' },
  { cmd: 'workflows', desc: '查看运行中的工作流' },
  { cmd: 'tasks', desc: '查看后台任务（/bashes 同义）' },
  { cmd: 'add-dir', desc: '添加额外工作目录' },
  { cmd: 'cd', desc: '切换当前会话工作目录' },
  { cmd: 'hooks', desc: '查看 hook 配置' },
  { cmd: 'export', desc: '导出当前对话' },
  { cmd: 'plugin', desc: '管理插件（/plugins 同义）' },
  { cmd: 'reload-plugins', desc: '重载插件使变更生效' },
  { cmd: 'reload-skills', desc: '重新扫描 Skills 目录' },

  // —— 会话控制 ——
  { cmd: 'branch', desc: '分支对话尝试不同方向（/fork 旧版同义）' },
  { cmd: 'fork', desc: '派生子代理在后台执行任务' },
  { cmd: 'background', desc: '将会话转为后台运行（/bg 同义）' },
  { cmd: 'btw', desc: '旁路提问，不写入主对话历史' },
  { cmd: 'rename', desc: '重命名当前会话' },
  { cmd: 'goal', desc: '设置持续目标直到条件满足' },
  { cmd: 'stop', desc: '停止当前后台会话' },
  { cmd: 'exit', desc: '退出 CLI（/quit 同义）' },

  // —— 模型与性能 ——
  { cmd: 'effort', desc: '调整推理深度（low/medium/high/max 等）' },
  { cmd: 'fast', desc: '切换快速模式' },
  { cmd: 'advisor', desc: '启用/禁用顾问模型' },

  // —— 代码质量 ——
  { cmd: 'security-review', desc: '安全审查当前分支改动' },
  { cmd: 'simplify', desc: '简化与清理最近改动代码' },
  { cmd: 'ultrareview', desc: '云端多代理深度代码审查' },
  { cmd: 'ultraplan', desc: '云端起草高级计划' },
  { cmd: 'autofix-pr', desc: '监控 PR 并自动修复 CI/评论' },
  { cmd: 'run', desc: '启动并驱动应用验证改动' },
  { cmd: 'verify', desc: '构建运行应用确认改动有效' },
  { cmd: 'batch', desc: '大规模并行改动（多 worktree）' },

  // —— 自动化 ——
  { cmd: 'loop', desc: '定时重复执行提示（/proactive 同义）' },
  { cmd: 'schedule', desc: '创建云端定时任务（/routines 同义）' },

  // —— 诊断与信息 ——
  { cmd: 'debug', desc: '开启调试日志并分析会话' },
  { cmd: 'copy', desc: '复制最近一条回复到剪贴板' },
  { cmd: 'insights', desc: '生成使用分析报告' },
  { cmd: 'release-notes', desc: '查看版本更新说明' },
  { cmd: 'feedback', desc: '提交反馈或 bug（/bug 同义）' },
  { cmd: 'recap', desc: '生成当前会话一句话摘要' },
  { cmd: 'powerup', desc: '交互式功能教程' },

  // —— 界面与集成 ——
  { cmd: 'theme', desc: '切换颜色主题' },
  { cmd: 'color', desc: '设置提示栏颜色' },
  { cmd: 'focus', desc: '切换专注视图' },
  { cmd: 'tui', desc: '切换终端 UI 渲染模式' },
  { cmd: 'keybindings', desc: '编辑快捷键配置' },
  { cmd: 'terminal-setup', desc: '配置 Shift+Enter 等终端快捷键' },
  { cmd: 'statusline', desc: '配置状态栏' },
  { cmd: 'ide', desc: '管理 IDE 集成' },
  { cmd: 'chrome', desc: 'Claude in Chrome 设置' },
  { cmd: 'sandbox', desc: '切换沙箱模式' },

  // —— 远程与云 ——
  { cmd: 'remote-control', desc: '允许从 claude.ai 远程控制（/rc 同义）' },
  { cmd: 'teleport', desc: '将 Web 会话拉入本终端（/tp 同义）' },
  { cmd: 'desktop', desc: '在 Desktop 应用中继续（/app 同义）' },
  { cmd: 'mobile', desc: '显示移动端下载二维码（/ios、/android 同义）' },
  { cmd: 'web-setup', desc: '配置 Claude Code on the web' },

  // —— 账号与安装 ——
  { cmd: 'login', desc: '登录 Anthropic 账号' },
  { cmd: 'logout', desc: '退出登录' },
  { cmd: 'upgrade', desc: '升级订阅计划' },
  { cmd: 'privacy-settings', desc: '隐私设置（Pro/Max）' },
  { cmd: 'usage-credits', desc: '配置超额用量额度' },
  { cmd: 'passes', desc: '分享 Claude Code 体验周' },
  { cmd: 'install-github-app', desc: '安装 GitHub App 集成' },
  { cmd: 'install-slack-app', desc: '安装 Slack 应用' },
  { cmd: 'team-onboarding', desc: '生成团队上手指南' },
  { cmd: 'voice', desc: '切换语音输入' },

  // —— Skills / API ——
  { cmd: 'claude-api', desc: '加载 Claude API 参考文档' },
  { cmd: 'dataviz', desc: '图表与可视化设计指导' },
  { cmd: 'design-sync', desc: '同步设计系统到 Claude Design' },
  { cmd: 'design-login', desc: '授权设计系统访问' },
  { cmd: 'fewer-permission-prompts', desc: '分析并生成权限白名单' },
  { cmd: 'run-skill-generator', desc: '为 /run 生成项目专属 skill' },
];

export const CLAUDE_COMMAND_ORDER = CLAUDE_COMMANDS.map((c) => c.cmd);

const ORDER_MAP = new Map(CLAUDE_COMMAND_ORDER.map((c, i) => [c, i]));

const DESC_MAP = new Map(CLAUDE_COMMANDS.map((c) => [c.cmd, c.desc]));

/** 常用命令数量（右侧面板「常用」分区）。 */
export const CLAUDE_COMMON_COUNT = 18;

export function getCommandDesc(cmd: string): string | undefined {
  return DESC_MAP.get(cmd);
}

/** 按内置优先级排序；未知命令排在后面并按字母序。 */
export function sortClaudeCommands(cmds: string[]): string[] {
  return [...cmds].sort((a, b) => {
    const ai = ORDER_MAP.get(a) ?? 10000;
    const bi = ORDER_MAP.get(b) ?? 10000;
    if (ai !== bi) return ai - bi;
    return a.localeCompare(b);
  });
}

/** 合并内置 + 会话下发 + skills，去重并保持常用优先。 */
export function buildAllCommands(sessionSlash: string[] = [], sessionSkills: string[] = []): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (c: string) => {
    const k = c.trim();
    if (!k || seen.has(k)) return;
    seen.add(k);
    out.push(k);
  };
  for (const c of CLAUDE_COMMAND_ORDER) add(c);
  for (const c of sortClaudeCommands(sessionSlash)) add(c);
  for (const c of sortClaudeCommands(sessionSkills)) add(c);
  return out;
}

/**
 * headless 模式不支持的交互式命令 → 自然语言。
 * 命中后不发 /xxx（会得到 isn't available），而改发等价自然语言。
 */
export const CMD_TO_NL: Record<string, string> = {
  agents: '请列出当前项目可用的子代理（subagents/agents），并简要说明每个的用途。',
  memory: '请读取并总结当前项目根目录及上层的 CLAUDE.md 记忆文件内容；如果不存在请告诉我。',
  workflows: '请列出当前可用的工作流（workflows / 自定义命令）及其用途。',
  mcp: '请列出当前已连接的 MCP 服务器以及它们提供的工具。',
  config: '请显示当前 Claude Code 的相关配置信息。',
  usage: '请汇总本次会话的用量、费用与限额情况。',
  cost: '请汇总本次会话的用量、费用与限额情况。',
  status: '请汇报当前会话状态：使用的模型、工作目录、已加载的工具与 MCP 等。',
  permissions: '请说明当前的工具权限设置。',
  hooks: '请列出当前已配置的 hooks。',
  tasks: '请列出当前后台运行的任务。',
  resume: '请总结当前会话的进展，方便我后续继续。',
  rewind: '请说明如何回退到之前的检查点或撤销最近改动。',
  export: '请把本次会话的关键内容整理导出为 Markdown。',
  'add-dir': '请说明如何把额外目录加入当前工作上下文，并列出建议加入的目录。',
  cd: '请说明如何切换当前工作目录。',
  doctor: '请检查当前运行环境是否正常（依赖、配置、可用工具等）。',
  diff: '请展示当前未提交的代码改动摘要。',
  skills: '请列出当前可用的 Skills 及其用途。',
  plugin: '请列出已安装的插件及其状态。',
  plan: '请先制定详细计划，不要立即修改代码。',
  context: '请分析当前上下文窗口的占用情况。',
  review: '请审查当前代码改动或 PR，指出问题与改进建议。',
  'code-review': '请审查当前 diff，找出 bug 与可改进之处。',
  'security-review': '请对当前分支改动做安全审查。',
  simplify: '请简化并清理最近改动的代码。',
  debug: '请帮助分析当前会话的调试日志与问题。',
  branch: '请说明如何从当前对话分支尝试不同方向。',
  fork: '请派生子任务在后台执行当前指令。',
  background: '请将当前会话转为后台继续运行。',
  effort: '请说明当前推理深度设置及可选级别。',
  fast: '请说明快速模式的状态与切换方式。',
  loop: '请说明如何设置定时重复执行的任务。',
  schedule: '请说明如何创建云端定时任务。',
  batch: '请说明如何并行执行大规模代码改动。',
  ultrareview: '请对当前分支做深度多代理代码审查。',
  ultraplan: '请为当前任务起草详细计划。',
  init: '请为当前项目生成或更新 CLAUDE.md 指南。',
  compact: '请压缩当前对话上下文并保留关键信息摘要。',
};
