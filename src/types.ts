/** 接口对接方式：openai = OpenAI 兼容 (/chat/completions)；anthropic = Claude 原生 (/v1/messages)。 */
export type ApiType = 'openai' | 'anthropic';

export interface APIProvider {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  source?: string;
  supportsVision?: boolean;
  /** 接口对接方式，缺省按 'openai' 处理。 */
  apiType?: ApiType;
  /** Default provider used by new conversations and terminal context actions. */
  isDefault?: boolean;
  models: string[];
  selectedModel: string;
}

export interface FileAttachment {
  id: string;
  name: string;
  type: string;
  size: number;
  dataUrl?: string;
  content?: string;
}

export interface PluginResult {
  success: boolean;
  result: RichContent;
  plugin_name?: string;
  plugin_path?: string;
  code?: string;
  language?: 'python' | 'bash' | string;
  stdout?: string;
  stderr?: string;
  returncode?: number;
  needs_sudo?: boolean;
  sudo_injected?: boolean;
  attempts?: PluginAttempt[];
}

export interface PluginAttempt {
  attempt: number;
  success: boolean;
  language?: string;
  returncode?: number | null;
  error?: string;
}

/**
 * 插件流水线运行过程中的关键事件，用于在对话界面里实时呈现
 * “生成代码 → 创建插件 → 执行 → 失败 → 修复 → 再执行”的过程。
 * 与后端 SSE /api/chat-with-plugin/stream 的事件结构一一对应。
 */
export interface PluginProgressEvent {
  /** 步骤所属阶段。
   * - 'validate' 是生成代码后、创建插件前的语法检查阶段；不通过时会尝试自动修复一轮。 */
  phase: 'gen' | 'validate' | 'create' | 'exec' | 'fix' | 'error';
  /** 该步骤的状态。
   * - 'output' 表示这是插件子进程的行级 stdout/stderr 增量输出，
   *   会带上 attempt + stream + text 字段，前端聚合渲染为实时控制台。 */
  status: 'running' | 'done' | 'error' | 'info' | 'output';
  /** 给用户看的简短中文描述。output 事件可为空。 */
  message: string;
  /** 服务器时间戳（秒，浮点）。 */
  ts?: number;
  /** 第几次执行 / 修复（从 1 起）。 */
  attempt?: number;
  /** 该次尝试是否成功（仅 exec 阶段）。 */
  success?: boolean;
  /** 进程退出码（仅 exec 阶段）。 */
  returncode?: number | null;
  /** 当前代码语言。 */
  language?: string;
  /** 代码行数。 */
  code_lines?: number;
  /** 代码截断后的预览，用于折叠展示。 */
  code_preview?: string;
  /** 失败日志的最后片段（修复前），用于折叠展示。 */
  failure_preview?: string;
  /** 创建出来的插件名（仅 create 阶段）。 */
  plugin_name?: string;
  /** 仅 status='output' 时使用。 */
  stream?: 'stdout' | 'stderr';
  /** 仅 status='output' 时使用：一行原始日志文本（含换行）。 */
  text?: string;
  /** 多文件项目工程化生成时，列出 LLM 生成的所有文件（相对路径 + 语言）。 */
  files?: { path: string; language?: string }[];
  /** 语法检查失败时的错误报告（限长）。 */
  validation_error?: string;
}

export interface RichContent {
  type: 'text' | 'mixed';
  content?: string | RichContentItem[];
}

export interface RichContentItem {
  type: 'text' | 'status' | 'table' | 'list' | 'info' | 'code' | 'image';
  data?: string | Record<string, unknown>;
  title?: string;
  headers?: string[];
  rows?: string[][];
  items?: string[];
  status?: 'success' | 'warning' | 'error' | 'info';
  message?: string;
  language?: string;
}

export interface MessageMetrics {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  durationMs?: number;
  liked?: boolean;
}

/** 一次 web 搜索得到的引用条目（保存在 assistant 消息上）。 */
export interface ChatSource {
  title: string;
  url: string;
  snippet?: string;
  /** 整页正文（前端不必直接显示，仅用于 LLM 上下文）。 */
  content?: string;
  fetched_title?: string;
}

export interface WebChatProgressEvent {
  id: string;
  event: string;
  message: string;
  timestamp: number;
  details?: Record<string, unknown>;
}

export interface WebChatAnswer {
  tabId: string;
  title: string;
  site: string;
  model?: string;
  url: string;
  content?: string;
  error?: string;
  warning?: string;
  partial?: boolean;
  durationMs?: number;
  dumpPath?: string;
  pagePath?: string;
  pageSaveError?: string;
  events?: WebChatProgressEvent[];
  extraction?: {
    ok: boolean;
    source: 'copy-button' | 'dom';
    copiedChars: number;
    buttonLabel?: string;
    error?: string;
  };
  validation?: {
    complete: boolean;
    selectedChars: number;
    dumpMaxCandidateChars: number;
    busyAfterDump: boolean;
    copiedMarkdown: boolean;
    reason: string;
  };
  status: 'waiting' | 'done' | 'error';
}

export interface WebChatMessageState {
  status: 'running' | 'synthesizing' | 'done' | 'error' | 'stopped';
  aggregator: {
    providerName: string;
    model: string;
    usesBasicModel: boolean;
  };
  answers: WebChatAnswer[];
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  providerId?: string;
  model?: string;
  attachments?: FileAttachment[];
  pluginResult?: PluginResult;
  /** 插件流水线的关键过程事件（流式插件对话独有）。 */
  pluginProgress?: PluginProgressEvent[];
  metrics?: MessageMetrics;
  /** 联网搜索时的引用列表，渲染在消息底部。 */
  sources?: ChatSource[];
  /** 网页 AI 群聊的结构化过程与原始回答。 */
  webChat?: WebChatMessageState;
  /** 自动路由命中时附带的意图信息，展示在消息头部。 */
  autoRoute?: {
    intent: string;
    complexity?: '简单' | '复杂' | null;
    role: string;
    providerName?: string;
    model?: string;
    sameTopic?: boolean;
    fallbackFrom?: string;
    keywords?: string[];
    reason?: string;
    trace?: AutoRouteTraceStep[];
  };
  /** 「讯息」检索研究工作流的过程日志（检索过程面板）。 */
  research?: {
    steps: AutoRouteTraceStep[];
    keywords?: string[];
    sites?: string[];
  };
}

// ============================================================
// 通用设置（与后端 /api/settings 对应）
// ============================================================
export interface ModelParams {
  temperature?: number;
  top_p?: number;
  max_tokens?: number | null;
  presence_penalty?: number;
  frequency_penalty?: number;
  seed?: number | null;
  stop?: string[];
  system_prompt?: string;
}

export type WebSearchProviderId =
  | 'duckduckgo'
  | 'tavily'
  | 'serper'
  | 'brave'
  | 'bing'
  | 'google_cse'
  | 'searxng';

export interface WebSearchKeys {
  tavily?: string;
  serper?: string;
  brave?: string;
  bing?: string;
  google_cse_key?: string;
  google_cse_cx?: string;
  searxng_url?: string;
}

export interface WebSearchSettings {
  provider: WebSearchProviderId;
  topic?: string;
  preferred_sites?: string[];
  max_results?: number;
  fetch_full_content?: boolean;
  max_content_chars?: number;
  keys: WebSearchKeys;
}

/** 由 model_roles 管理的角色：自动路由命中后会用其绑定的 provider+model 跑对话。 */
export type ModelRoleId =
  | 'intent'
  | 'chat_basic'
  | 'chat_advanced'
  | 'image_gen'
  | 'vision'
  | 'code_simple'
  | 'code_advanced'
  | 'web_search';

/** 独立 OpenAI 兼容端点：本期仅保存配置，不参与 chat 流程。 */
export type ModelEndpointId = 'tts' | 'asr' | 'ocr';

export interface ModelRoleBinding {
  /** APIProvider.id；空字符串表示未配置。 */
  providerId: string;
  /** 该 provider 下要使用的模型名。 */
  model: string;
}

export interface ModelEndpointBinding {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface ModelRolesSettings {
  intent: ModelRoleBinding;
  chat_basic: ModelRoleBinding;
  chat_advanced: ModelRoleBinding;
  image_gen: ModelRoleBinding;
  vision: ModelRoleBinding;
  code_simple: ModelRoleBinding;
  code_advanced: ModelRoleBinding;
  web_search: ModelRoleBinding;
}

export interface ModelEndpointsSettings {
  tts: ModelEndpointBinding;
  asr: ModelEndpointBinding;
  ocr: ModelEndpointBinding;
}

export interface AppSettings {
  model_params: ModelParams;
  web_search: WebSearchSettings;
  model_roles: ModelRolesSettings;
  model_endpoints: ModelEndpointsSettings;
}

/** 意图理解过程日志的单步。 */
export interface AutoRouteTraceStep {
  step: string;
  detail?: string;
  status?: 'done' | 'warn' | 'error';
  ms?: number;
}

/** /api/auto-route 的返回值。 */
export interface AutoRouteResult {
  intent: string;
  complexity: '简单' | '复杂' | null;
  keywords: string[];
  reason: string;
  same_topic: boolean;
  trace?: AutoRouteTraceStep[];
  /** 已落到具体 role（已按 complexity 拆分代码编写）。 */
  role: ModelRoleId | ModelEndpointId;
  target: {
    role: string;
    /** role: 普通对话；endpoint: tts/asr/ocr；unbound: 未配置。 */
    kind: 'role' | 'endpoint' | 'unbound';
    providerId?: string;
    providerName?: string;
    model?: string;
    baseUrl?: string;
    apiKey?: string;
    endpoint?: ModelEndpointBinding;
    /** 若原角色未配置，回退到的来源 role。 */
    fallback_from?: string;
  };
  raw?: string;
}

export interface WebSearchProviderInfo {
  id: WebSearchProviderId;
  name: string;
  requires_key: boolean;
  available: boolean;
  website?: string;
  note?: string;
  key_field?: string;
  key_fields?: string[];
}

export interface Conversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  providerId: string;
  model: string;
  createdAt: number;
  updatedAt: number;
}

export interface TerminalLine {
  id: string;
  type: 'input' | 'output' | 'error' | 'system';
  content: string;
  timestamp: number;
}

export interface AppState {
  providers: APIProvider[];
  conversations: Conversation[];
  activeConversationId: string | null;
  activeProviderId: string | null;
}

/** SP6：Claude Code 输出自动应答规则。匹配 Claude 一轮输出（assistant 文本）后自动发送回复。 */
export interface AutoInputRule {
  id: string;
  enabled: boolean;
  /** 触发关键词（在 Claude 输出文本中包含即命中；可填正则，use_regex=true 时按正则匹配）。 */
  keyword: string;
  useRegex?: boolean;
  /** 命中后自动发送给 Claude 的内容。 */
  reply: string;
  /** 仅触发一次（命中后自动关闭）。 */
  once?: boolean;
}

/** Claude 插件市场目录项（来自 `claude plugin list --available --json`）。 */
export interface ClaudePluginEntry {
  pluginId: string;
  name: string;
  description?: string;
  installCount?: number;
  marketplaceName?: string;
  source?: string;
}
export interface ClaudeInstalledPlugin {
  id: string;
  version?: string;
  scope?: string;
  enabled?: boolean;
}
