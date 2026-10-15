import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import Sidebar from './components/Sidebar';
import ChatArea from './components/ChatArea';
import ClaudeChat from './components/ClaudeChat';
import HermesChat from './components/HermesChat';
import ConfigModal from './components/ConfigModal';
import TerminalDock from './components/TerminalDock';
import LocalHubModal from './components/LocalHubModal';
import SettingsModal from './components/SettingsModal';
import FileTree from './components/FileTree';
import FileViewer from './components/FileViewer';
import WebViewer from './components/WebViewer';
import WorkbenchPanel from './components/WorkbenchPanel';
import ClaudeTerminal from './components/ClaudeTerminal';
import HermesTerminal from './components/HermesTerminal';
import DesktopAgentPanel from './components/DesktopAgentPanel';
import CodexTerminalPanel from './components/CodexTerminalPanel';
import AgentDialog from './components/AgentDialog';
import { useBackendState } from './hooks/useBackendState';
import { useKnowledgeJobs } from './hooks/useKnowledgeJobs';
import { hostOfUrl, isLikelyFrameBlocked, normalizeHttpUrl } from './lib/webFrame';
import { browserFileUrl, fileTargetName, isBrowserOpenableFile, resolveFileTarget } from './lib/fileTargets';
import { DEFAULT_MODEL_CHAT_SITES } from './lib/modelChatSites';
import { cancelKnowledge, recordKnowledge, recordKnowledgeOnlineCall, turnHash } from './lib/knowledgeApi';
import { checkLocalFirst, createRequestGuard, knowledgeReasons } from './lib/knowledgeRouting';
import { isCurrentInformationQuery, searchTimeLimit } from './lib/webResearch';
import { consumeResearchStream, researchChannels } from './lib/researchStream';
import type { Completion, KnowledgeQueryRequest } from './lib/knowledgeTypes';
import type { Citation } from './lib/knowledgeTypes';
import KnowledgePanel from './components/KnowledgePanel';
import ContentLibraryPanel from './components/ContentLibraryPanel';
import KnowledgeSourceViewer from './components/KnowledgeSourceViewer';
import {
  acquireDesktopOverlay,
  detectWebChatSite,
  getDesktop,
  installDesktopChromeGuard,
  releaseDesktopOverlay,
  type WebChatProgressEvent,
  type WebChatResult,
  type WebChatTarget,
  type WebSelectionTranslateEvent,
} from './lib/desktopBridge';
import type {
  APIProvider, Conversation, ChatMessage, AppState, FileAttachment, PluginResult,
  PluginProgressEvent, AppSettings, ChatSource, AutoRouteResult, AutoInputRule,
} from './types';
import {
  Loader2, ServerOff, Server, Plus, X as XIcon, Sparkles, MessageSquare,
  FileText, FolderTree, ChevronLeft, PanelRightClose, PanelRightOpen,
  Terminal as TerminalIcon, ChevronRight, Bot, Globe, Trash2, ExternalLink, Hammer,
} from 'lucide-react';

const DEFAULT_STATE: AppState = {
  providers: [],
  conversations: [],
  activeConversationId: null,
  activeProviderId: null,
};

type SavedWebPage = {
  id: string;
  url: string;
  title: string;
  savedAt: number;
};

const SAVED_WEB_PAGES_KEY = 'workbench/savedWebPages';

function loadSavedWebPages(): SavedWebPage[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(SAVED_WEB_PAGES_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is SavedWebPage => (
      !!item && typeof item.id === 'string' && typeof item.url === 'string'
      && typeof item.title === 'string' && typeof item.savedAt === 'number'
    )).slice(0, 50);
  } catch {
    return [];
  }
}

export default function App() {
  const [state, setState, loading, backendError] = useBackendState<AppState>(DEFAULT_STATE);
  const [showConfigModal, setShowConfigModal] = useState(false);
  const [editingProvider, setEditingProvider] = useState<APIProvider | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [streamingContent, setStreamingContent] = useState('');
  /** 与 streamingContent 同步的 ref，用于在异步回调里随时读取最新值（停止时固化部分输出）。 */
  const streamingContentRef = useRef('');
  streamingContentRef.current = streamingContent;
  /** 插件「运行 / 修改」按钮触发的请求是否在飞行中（用于全局停止 + 按钮 disable）。 */
  const [pluginActionBusy, setPluginActionBusy] = useState(false);
  /** 当前正在运行的请求的 AbortController；点击「停止」会调用它的 abort()。 */
  const abortControllerRef = useRef<AbortController | null>(null);
  const requestGuardRef = useRef(createRequestGuard());
  const activeRequestRef = useRef<{id:string;targets:string[];knowledge:boolean}|null>(null);
  const [knowledgeProgress, setKnowledgeProgress] = useState('');
  const [knowledgeJobNotice, setKnowledgeJobNotice] = useState('');
  useKnowledgeJobs(null, { notify: true });
  useEffect(() => {
    const onTerminal = (event: Event) => {
      const job = (event as CustomEvent).detail as { status?: string; config?: { name?: string }; succeeded?: number; failed?: number };
      const name = job?.config?.name || '本地知识索引任务';
      const message = job?.status === 'done'
        ? `${name}已完成，成功 ${job.succeeded ?? 0} 项。`
        : job?.status === 'cancelled' ? `${name}已取消。` : `${name}失败，失败 ${job?.failed ?? 0} 项。`;
      setKnowledgeJobNotice(message);
      window.setTimeout(() => setKnowledgeJobNotice(current => current === message ? '' : current), 7000);
      if ('Notification' in window && Notification.permission === 'granted') new Notification('本地知识任务更新', { body: message });
    };
    window.addEventListener('knowledge-job-terminal', onTerminal);
    return () => window.removeEventListener('knowledge-job-terminal', onTerminal);
  }, []);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [terminalVisible, setTerminalVisible] = useState(false);
  const [showProjectRunner, setShowProjectRunner] = useState(false);
  const [injectedForInput, setInjectedForInput] = useState<{ content: string; attachments?: FileAttachment[] } | null>(null);
  const [pendingResend, setPendingResend] = useState<{ convId: string; userMsg: ChatMessage } | null>(null);
  const [pluginEnabled, setPluginEnabled] = useState(false);
  const [showLocalHub, setShowLocalHub] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [contentLibraryRequest, setContentLibraryRequest] = useState<{ query: string; entryId?: string } | null>(null);
  const openContentLibrary = useCallback((query = '', entryId?: string) => setContentLibraryRequest({ query, entryId }), []);
  const closeContentLibrary = useCallback(() => setContentLibraryRequest(null), []);
  const [showKnowledge,setShowKnowledge]=useState(false);
  const [knowledgeCitation,setKnowledgeCitation]=useState<Citation|null>(null);
  const [settingsInitialTab,setSettingsInitialTab]=useState<'model'|'knowledge'>('model');
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const settingsRef = useRef<AppSettings | null>(null);
  settingsRef.current = settings;
  const [savedWebPages, setSavedWebPages] = useState<SavedWebPage[]>(loadSavedWebPages);
  useEffect(() => {
    try { localStorage.setItem(SAVED_WEB_PAGES_KEY, JSON.stringify(savedWebPages)); } catch { /* noop */ }
  }, [savedWebPages]);

  // ===== 中部多 Tab：默认 Claude Code 工作台 + 原有 Provider 对话 + 文件查看 + 交互式终端 =====
  type CenterTab = {
    id: string;
    kind: 'claude' | 'claude-term' | 'hermes' | 'hermes-term' | 'desktop-agent' | 'codex-term' | 'provider' | 'file' | 'web';
    title: string;
    path?: string;
    url?: string;
  };
  const [centerTabs, setCenterTabs] = useState<CenterTab[]>([
    { id: 'claude-1', kind: 'claude', title: 'Claude Code' },
    { id: 'provider', kind: 'provider', title: '对话' },
  ]);
  const [activeCenterTab, setActiveCenterTab] = useState('claude-1');
  const [claudeMeta, setClaudeMeta] = useState<{ available: boolean; defaultCwd: string; repoDir: string; version: string }>(
    { available: false, defaultCwd: '', repoDir: '', version: '' }
  );
  const [hermesMeta, setHermesMeta] = useState<{ available: boolean; cli: boolean; ws: boolean; defaultCwd: string; repoDir: string; version: string }>(
    { available: false, cli: false, ws: false, defaultCwd: '', repoDir: '', version: '' }
  );
  const claudeTabSeq = useRef(1);

  // ===== 左侧文件管理器（SP2） & 右侧命令/Skill/自动面板（SP4/5/6）=====
  const [filesPanelOpen, setFilesPanelOpen] = useState(false);
  const [rightPanelOpen, setRightPanelOpen] = useState(false);
  /** 文件管理器当前浏览目录（独立于活动标签，打开文件时不跳回默认路径） */
  const [filesPanelCwd, setFilesPanelCwd] = useState<string | null>(null);
  const [filesPanelNav, setFilesPanelNav] = useState<{ dir: string; nonce: number } | null>(null);
  /** 各 Claude 标签页的会话命令/skills（来自 system/init），供右侧命令面板使用。 */
  const [claudeSessions, setClaudeSessions] = useState<Record<string, { slashCommands: string[]; skills: string[] }>>({});
  const [hermesSessions, setHermesSessions] = useState<Record<string, { slashCommands: string[]; skills: string[] }>>({});
  /** 各 Claude / 交互终端标签页当前选定的工作目录，供左侧文件管理器跟随。 */
  const [claudeCwds, setClaudeCwds] = useState<Record<string, string>>({});
  /** 注入到当前 Claude 标签输入框的内容（命令面板 / Skill 触发）。 */
  const [claudeInject, setClaudeInject] = useState<{ tabId: string; text: string; send: boolean; nonce: number } | null>(null);
  /** 注入到当前交互式终端 PTY 的内容（命令面板 / Skill 触发，send=true 时回车执行）。 */
  const [termInject, setTermInject] = useState<{ tabId: string; text: string; send: boolean; nonce: number } | null>(null);
  const [hermesInject, setHermesInject] = useState<{ tabId: string; text: string; send: boolean; nonce: number } | null>(null);
  const [hermesTermInject, setHermesTermInject] = useState<{ tabId: string; text: string; send: boolean; nonce: number } | null>(null);
  /** SP6：输出自动应答规则（持久化）。 */
  const [autoRules, setAutoRules] = useState<AutoInputRule[]>(() => {
    try { return JSON.parse(localStorage.getItem('workbench/autoRules') || '[]'); } catch { return []; }
  });
  const [autoRulesEnabled, setAutoRulesEnabled] = useState<boolean>(() => {
    try { return localStorage.getItem('workbench/autoRulesEnabled') === '1'; } catch { return false; }
  });
  useEffect(() => { try { localStorage.setItem('workbench/autoRules', JSON.stringify(autoRules)); } catch { /* noop */ } }, [autoRules]);
  useEffect(() => { try { localStorage.setItem('workbench/autoRulesEnabled', autoRulesEnabled ? '1' : '0'); } catch { /* noop */ } }, [autoRulesEnabled]);

  const webTabSeq = useRef(0);
  const [webSelectionRequest, setWebSelectionRequest] = useState<(WebSelectionTranslateEvent & { nonce: number }) | null>(null);
  const openWebTab = useCallback((url: string, title?: string) => {
    const href = normalizeHttpUrl(url);
    if (!href) return;
    let tabTitle = title?.trim() || '';
    if (!tabTitle) tabTitle = hostOfUrl(href) || href;
    // 普通浏览器无法在 iframe 中显示这些站点，直接交给浏览器新标签页，
    // 避免同时留下一个无法显示内容的工作台 Tab。Electron 用 WebContentsView。
    if (!getDesktop() && isLikelyFrameBlocked(href)) {
      window.open(href, '_blank', 'noopener,noreferrer');
      return;
    }
    setCenterTabs(prev => {
      const existing = prev.find(t => t.kind === 'web' && t.url === href);
      if (existing) { setActiveCenterTab(existing.id); return prev; }
      webTabSeq.current += 1;
      const id = `web-${webTabSeq.current}`;
      setActiveCenterTab(id);
      return [...prev, { id, kind: 'web', title: tabTitle, url: href }];
    });
  }, []);

  /**
   * Open a local target according to its capabilities. Browser-renderable
   * files use the same web tab as HTTP links; everything else goes straight
   * to the operating system's default handler.
   */
  const openPath = useCallback((path: string, name?: string, cwd?: string) => {
    const resolved = resolveFileTarget(path, cwd);
    if (!resolved) return;
    if (isBrowserOpenableFile(resolved)) {
      openWebTab(browserFileUrl(resolved), name?.trim() || fileTargetName(resolved));
      return;
    }
    const desktop = getDesktop();
    if (desktop) {
      void desktop.openTarget({ target: path, cwd: cwd || undefined }).catch(error => {
        console.error('无法用默认应用打开路径', path, error);
      });
      return;
    }
    // A regular browser cannot invoke the host OS file association. Keep the
    // target out of the workbench tabs and leave the failure visible in devtools.
    console.warn('当前浏览器无法调用系统默认应用打开路径', path);
  }, [openWebTab]);

  const openFileTab = useCallback((path: string, name: string) => {
    openPath(path, name);
  }, [openPath]);

  const openDesktopAgentPath = useCallback((path: string, cwd?: string) => {
    openPath(path, undefined, cwd);
  }, [openPath]);

  const saveWebPage = useCallback((url: string, title?: string) => {
    const href = normalizeHttpUrl(url);
    if (!href) return;
    const requestedTitle = (title || '').trim();
    const fallbackTitle = hostOfUrl(href) || href;
    const pageTitle = requestedTitle && !/^浏览器 \d+$/.test(requestedTitle)
      ? requestedTitle
      : fallbackTitle;
    setSavedWebPages(prev => {
      const existing = prev.find(item => item.url === href);
      const saved: SavedWebPage = {
        id: existing?.id || crypto.randomUUID(),
        url: href,
        title: pageTitle,
        savedAt: Date.now(),
      };
      return [saved, ...prev.filter(item => item.url !== href)].slice(0, 50);
    });
  }, []);

  const deleteSavedWebPage = useCallback((id: string) => {
    setSavedWebPages(prev => prev.filter(item => item.id !== id));
  }, []);

  const handleSessionInfo = useCallback((tid: string, info: { slashCommands: string[]; skills: string[] }) => {
    setClaudeSessions(prev => ({ ...prev, [tid]: info }));
  }, []);

  const handleHermesSessionInfo = useCallback((tid: string, info: { slashCommands: string[]; skills: string[] }) => {
    setHermesSessions(prev => ({ ...prev, [tid]: info }));
  }, []);

  const handleClaudeCwdChange = useCallback((tid: string, cwd: string) => {
    const next = cwd.trim();
    if (!next) return;
    setClaudeCwds(prev => (prev[tid] === next ? prev : { ...prev, [tid]: next }));
  }, []);

  const handleWorkbenchInsert = useCallback((text: string, send: boolean) => {
    const cur = activeCenterTab;
    const kind = centerTabs.find(t => t.id === cur)?.kind;
    const payload = { tabId: cur, text, send, nonce: Date.now() };
    if (kind === 'claude-term') setTermInject(payload);
    else if (kind === 'hermes') setHermesInject(payload);
    else if (kind === 'hermes-term') setHermesTermInject(payload);
    else setClaudeInject(payload);
  }, [activeCenterTab, centerTabs]);

  const handleRuleConsumed = useCallback((ruleId: string) => {
    setAutoRules(prev => prev.map(r => (r.id === ruleId ? { ...r, enabled: false } : r)));
  }, []);

  useEffect(() => {
    fetch('/api/claude/available')
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (d) setClaudeMeta({ available: !!d.available, defaultCwd: d.default_cwd || '', repoDir: d.repo_dir || '', version: d.version || '' });
      })
      .catch(() => {});
    fetch('/api/hermes/available')
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (d) setHermesMeta({
          available: !!d.available,
          cli: !!d.cli,
          ws: !!d.ws,
          defaultCwd: d.default_cwd || '',
          repoDir: d.repo_dir || '',
          version: d.version || '',
        });
      })
      .catch(() => {});
  }, []);

  const addClaudeTab = useCallback(() => {
    claudeTabSeq.current += 1;
    const id = `claude-${claudeTabSeq.current}`;
    setCenterTabs(prev => [...prev, { id, kind: 'claude', title: `Claude Code ${claudeTabSeq.current}` }]);
    setActiveCenterTab(id);
  }, []);

  const claudeTermSeq = useRef(0);
  const addClaudeTermTab = useCallback(() => {
    claudeTermSeq.current += 1;
    const id = `claude-term-${claudeTermSeq.current}`;
    setCenterTabs(prev => [...prev, { id, kind: 'claude-term', title: `交互终端 ${claudeTermSeq.current}` }]);
    setActiveCenterTab(id);
  }, []);

  const hermesTabSeq = useRef(0);
  const addHermesTab = useCallback(() => {
    hermesTabSeq.current += 1;
    const id = `hermes-${hermesTabSeq.current}`;
    setCenterTabs(prev => [...prev, { id, kind: 'hermes', title: `Hermes ${hermesTabSeq.current}` }]);
    setActiveCenterTab(id);
  }, []);

  const hermesTermSeq = useRef(0);
  const addHermesTermTab = useCallback(() => {
    hermesTermSeq.current += 1;
    const id = `hermes-term-${hermesTermSeq.current}`;
    setCenterTabs(prev => [...prev, { id, kind: 'hermes-term', title: `Hermes 终端 ${hermesTermSeq.current}` }]);
    setActiveCenterTab(id);
  }, []);

  const codexTermSeq = useRef(0);
  const addCodexTermTab = useCallback(() => {
    codexTermSeq.current += 1;
    const id = `codex-term-${codexTermSeq.current}`;
    setCenterTabs(prev => [...prev, { id, kind: 'codex-term', title: `Codex 终端 ${codexTermSeq.current}` }]);
    setActiveCenterTab(id);
    setShowAddMenu(false);
  }, []);

  const addDesktopAgentTab = useCallback(() => {
    const existing = centerTabs.find(tab => tab.kind === 'desktop-agent');
    if (existing) {
      setActiveCenterTab(existing.id);
      setShowAddMenu(false);
      return;
    }
    const id = 'desktop-agent';
    setCenterTabs(prev => [...prev, { id, kind: 'desktop-agent', title: 'Desktop Agent' }]);
    setActiveCenterTab(id);
    setShowAddMenu(false);
  }, [centerTabs]);

  const openFusionWindow = useCallback(async () => {
    const desktop = getDesktop();
    if (!desktop) {
      window.alert('Fusion 对话需要 Electron 桌面模式，将在独立窗口中打开。');
      return;
    }
    try {
      const result = await desktop.openFusion();
      if (!result.ok) window.alert(result.error || 'Fusion 窗口启动失败');
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error));
    }
  }, []);
  const [showAddMenu, setShowAddMenu] = useState(false);
  const addBtnRef = useRef<HTMLButtonElement>(null);
  const [addMenuPos, setAddMenuPos] = useState<{ left: number; top: number } | null>(null);
  const toggleAddMenu = useCallback(() => {
    if (showAddMenu) {
      setShowAddMenu(false);
      setAddMenuPos(null);
      return;
    }
    const button = addBtnRef.current;
    if (!button) return;
    const rect = button.getBoundingClientRect();
    const menuWidth = 208;
    const menuHeight = 460;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - menuWidth - 8));
    const below = rect.bottom + 4;
    const top = below + menuHeight <= window.innerHeight
      ? below
      : Math.max(8, rect.top - menuHeight - 4);
    setAddMenuPos({ left, top });
    setShowAddMenu(true);
  }, [showAddMenu]);
  const addBrowserTab = useCallback(() => {
    webTabSeq.current += 1;
    const id = `web-${webTabSeq.current}`;
    setCenterTabs(prev => [...prev, {
      id,
      kind: 'web',
      title: `浏览器 ${webTabSeq.current}`,
      url: 'https://duckduckgo.com',
    }]);
    setActiveCenterTab(id);
    setShowAddMenu(false);
  }, []);
  const closeCenterTab = useCallback((id: string) => {
    setCenterTabs(prev => {
      const closing = prev.find(t => t.id === id);
      if (closing?.kind === 'web') {
        void getDesktop()?.closeWeb(id);
      }
      const next = prev.filter(t => t.id !== id);
      setActiveCenterTab(cur => (cur === id ? (next[next.length - 1]?.id || '') : cur));
      return next;
    });
  }, []);

  // Electron：点击标签栏/侧栏等非网页区时卸下 WebContentsView，避免挡住菜单
  useEffect(() => installDesktopChromeGuard(), []);

  // 网页内的普通链接、target=_blank 链接都由 Electron 转回 React，
  // 统一新建工作台网页 Tab。
  useEffect(() => {
    const desktop = getDesktop();
    if (!desktop) return;
    return desktop.onWebLink(event => {
      if (event?.url) openWebTab(event.url);
    });
  }, [openWebTab]);

  // 网页右键菜单把选中文本交给当前网页助手，用当前 Provider 翻译并显示结果。
  useEffect(() => {
    const desktop = getDesktop();
    if (!desktop) return;
    return desktop.onWebSelectionTranslate(event => {
      const text = String(event?.text || '').trim();
      if (!event?.id || !text) return;
      setActiveCenterTab(event.id);
      setWebSelectionRequest({ id: event.id, text, nonce: Date.now() });
    });
  }, []);

  // Electron：各类弹层打开期间保持 WebContentsView 隐藏（+ 菜单 / 配置 / 设置等）
  useEffect(() => {
    if (!getDesktop()) return;
    const overlayOpen = showConfigModal || showLocalHub || showSettings || showKnowledge || !!knowledgeCitation || terminalVisible || showAddMenu || showProjectRunner || !!contentLibraryRequest;
    if (!overlayOpen) return;
    acquireDesktopOverlay();
    return () => releaseDesktopOverlay();
  }, [showConfigModal, showLocalHub, showSettings, showKnowledge, knowledgeCitation, terminalVisible, showAddMenu, showProjectRunner, contentLibraryRequest]);

  // Electron：离开网页标签时卸下 WebContentsView
  useEffect(() => {
    const desktop = getDesktop();
    if (!desktop) return;
    const tab = centerTabs.find(t => t.id === activeCenterTab);
    if (tab?.kind !== 'web') void desktop.hideWeb();
  }, [activeCenterTab, centerTabs]);

  // 加载通用设置（model_params + web_search）
  useEffect(() => {
    fetch('/api/settings')
      .then(r => r.ok ? r.json() : null)
      .then(s => { if (s) setSettings(s); })
      .catch(() => {});
  }, []);

  const activeConversation = state.conversations.find(c => c.id === state.activeConversationId) || null;
  const activeProvider = state.providers.find(p => p.id === state.activeProviderId) || null;
  const defaultProvider = state.providers.find(p => p.isDefault) || activeProvider || state.providers[0] || null;
  const webChatTargets: WebChatTarget[] = useMemo(() => centerTabs.flatMap(tab => {
    if (tab.kind !== 'web' || !tab.url) return [];
    const site = detectWebChatSite(tab.url);
    return site ? [{ id: tab.id, title: tab.title, url: tab.url, site }] : [];
  }), [centerTabs]);
  const configuredWebChatAggregator = useMemo(() => {
    const binding = settings?.model_roles?.chat_basic;
    if (!binding?.providerId || !binding.model) return null;
    const boundProvider = state.providers.find(provider => provider.id === binding.providerId);
    return boundProvider ? { ...boundProvider, selectedModel: binding.model } : null;
  }, [settings?.model_roles?.chat_basic, state.providers]);
  const webChatAggregator = configuredWebChatAggregator || activeProvider;
  const webChatAggregatorInfo = webChatAggregator ? {
    providerName: webChatAggregator.name,
    model: webChatAggregator.selectedModel,
    usesBasicModel: !!configuredWebChatAggregator,
  } : null;
  const webChatSelectionRef = useRef<{ enabled: boolean; ids: string[] }>({ enabled: false, ids: [] });
  const handleWebChatSelectionChange = useCallback((enabled: boolean, ids: string[]) => {
    webChatSelectionRef.current = { enabled, ids };
  }, []);
  const activeProviderRef = useRef(activeProvider);
  activeProviderRef.current = activeProvider;
  const stateRef = useRef(state);
  stateRef.current = state;
  /** 「讯息」检索工作流：按会话保留上一次检索到的来源（含正文），供后续提示词调整时免重搜复用。 */
  const lastResearchRef = useRef<Record<string, { query: string; rawSources: any[] }>>({});
  /** auto-route 命中「代码编写」时，请求 ChatArea 打开 AI 工作流（多文件工程、自动开跑）。 */
  const [agentRequest, setAgentRequest] = useState<{ goal: string; nonce: number } | null>(null);
  /** "自动选模型"开关（持久化到 localStorage）。 */
  const [autoRouteEnabled, setAutoRouteEnabled] = useState<boolean>(() => {
    try { return localStorage.getItem('autoRouteEnabled') === '1'; }
    catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem('autoRouteEnabled', autoRouteEnabled ? '1' : '0'); }
    catch { /* ignore */ }
  }, [autoRouteEnabled]);

  // Provider management
  const handleSaveProvider = useCallback((provider: APIProvider) => {
    setState(prev => {
      const existing = prev.providers.findIndex(p => p.id === provider.id);
      const providers = existing >= 0
        ? prev.providers.map(p => p.id === provider.id ? provider : (provider.isDefault ? { ...p, isDefault: false } : p))
        : [...prev.providers, provider];
      const normalized = providers.some(p => p.isDefault)
        ? providers
        : providers.map((p, index) => ({ ...p, isDefault: index === 0 }));
      return { ...prev, providers: normalized, activeProviderId: provider.id };
    });
    setShowConfigModal(false);
    setEditingProvider(null);
  }, [setState]);

  const handleDeleteProvider = useCallback((id: string) => {
    setState(prev => ({
      ...prev,
      providers: prev.providers.filter(p => p.id !== id),
      activeProviderId: prev.activeProviderId === id
        ? (prev.providers.find(p => p.id !== id)?.id || null)
        : prev.activeProviderId,
    }));
  }, [setState]);

  const handleSelectProvider = useCallback((id: string) => {
    setState(prev => ({ ...prev, activeProviderId: id }));
  }, [setState]);

  // 一键添加"本地/远端 LLM" provider（OpenAI 兼容：llama-server / ollama / lm-studio 等）
  // host 留空时默认 127.0.0.1；远端 hub 模式下应传远端 IP/域名
  const handleAddLocalProvider = useCallback(async (rawPort?: string, rawHost?: string) => {
    const port = parseInt((rawPort || '').trim(), 10) || 8080;
    const host = (rawHost || '').trim() || '127.0.0.1';
    const baseUrl = `http://${host}:${port}/v1`;
    const id = `local-${host.replace(/\W/g, '_')}-${port}-${Date.now()}`;
    const isLocal = host === '127.0.0.1' || host === 'localhost';
    const name = isLocal ? `Local LLM :${port}` : `LLM @ ${host}:${port}`;
    let models: string[] = [];
    let selectedModel = '';
    let warn = '';
    try {
      const r = await fetch('/api/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl, apiKey: '' }),
      });
      const j = await r.json();
      if (Array.isArray(j?.models)) {
        models = j.models;
        selectedModel = j.models[0] || '';
      } else {
        warn = j?.error || `(${host}:${port} 上没拿到模型列表，请确保 LLM 服务可达)`;
      }
    } catch (e: any) {
      warn = e?.message || '无法连接 LLM 服务';
    }
    const provider: APIProvider = { id, name, baseUrl, apiKey: '', models, selectedModel, isDefault: state.providers.length === 0 };
    setState(prev => ({ ...prev, providers: [...prev.providers, provider], activeProviderId: id }));
    if (warn) console.warn('[Local LLM]', warn);
  }, [setState, state.providers.length]);

  const handleSelectModel = useCallback((providerId: string, model: string) => {
    setState(prev => ({
      ...prev,
      providers: prev.providers.map(p =>
        p.id === providerId ? { ...p, selectedModel: model } : p
      ),
    }));
  }, [setState]);

  // Conversation management
  const handleNewConversation = useCallback(() => {
    const webSelection = webChatSelectionRef.current;
    const desktop = getDesktop();
    if (webSelection.enabled && webSelection.ids.length > 0 && desktop?.newWebChat) {
      void Promise.all(webSelection.ids.map(id => desktop.newWebChat(id))).then(results => {
        const nextUrls = new Map<string, string>();
        results.forEach((result, index) => {
          const id = webSelection.ids[index];
          if (!result.ok) console.warn('网页 AI 新建对话失败', id, result.error);
          else if (result.url) nextUrls.set(id, result.url);
        });
        if (nextUrls.size > 0) {
          setCenterTabs(previous => previous.map(tab => {
            const nextUrl = nextUrls.get(tab.id);
            return nextUrl ? { ...tab, url: nextUrl } : tab;
          }));
        }
      }).catch(error => console.warn('网页 AI 新建对话失败', error));
    }
    const provider = state.providers.find(p => p.isDefault)
      || state.providers.find(p => p.id === state.activeProviderId)
      || state.providers[0];
    if (!provider && !settingsRef.current?.local_knowledge?.enabled) return;

    const newConv: Conversation = {
      id: crypto.randomUUID(),
      title: 'New Chat',
      messages: [],
      providerId: provider?.id || '',
      model: provider?.selectedModel || '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    setState(prev => ({
      ...prev,
      conversations: [newConv, ...prev.conversations],
      activeConversationId: newConv.id,
      activeProviderId: provider?.id || prev.activeProviderId,
    }));
  }, [state.activeProviderId, state.providers, setState]);

  const handleSelectConversation = useCallback((id: string) => {
    setState(prev => ({ ...prev, activeConversationId: id }));
  }, [setState]);

  const openKnowledgeCitation=useCallback((citation:Citation)=>{
    if(citation.locator.kind==='web'&&typeof citation.locator.url==='string'){
      setShowKnowledge(false);setKnowledgeCitation(null);openWebTab(citation.locator.url,citation.title);return;
    }
    const conversationId=String(citation.locator.conversation_id||'');
    if(conversationId&&stateRef.current.conversations.some(c=>c.id===conversationId)){
      setShowKnowledge(false);setKnowledgeCitation(null);setActiveCenterTab('provider');handleSelectConversation(conversationId);
      const messageId=String(citation.locator.assistant_message_id||citation.position.message_id||'');
      requestAnimationFrame(()=>document.getElementById(`chat-message-${conversationId}-${messageId}`)?.scrollIntoView({block:'center'}));return;
    }
    setKnowledgeCitation(citation);
  },[openWebTab,handleSelectConversation]);
  useEffect(()=>{
    const refresh=()=>{void fetch('/api/settings').then(r=>r.json()).then(setSettings).catch(()=>{});};
    window.addEventListener('knowledge-settings-updated',refresh);return()=>window.removeEventListener('knowledge-settings-updated',refresh);
  },[]);

  const handleDeleteConversation = useCallback((id: string) => {
    setState(prev => ({
      ...prev,
      conversations: prev.conversations.filter(c => c.id !== id),
      activeConversationId: prev.activeConversationId === id ? null : prev.activeConversationId,
    }));
  }, [setState]);

  const buildApiMessages = useCallback((messages: ChatMessage[], supportsVision: boolean): any[] => {
    return messages.map(m => {
      const hasImages = m.attachments?.some(a => a.type.startsWith('image/') && a.dataUrl);
      if (hasImages && supportsVision) {
        const contentParts: any[] = [];
        if (m.content) contentParts.push({ type: 'text', text: m.content });
        m.attachments?.forEach(att => {
          if (att.content) contentParts.push({ type: 'text', text: `\n📎 File: ${att.name}\n\`\`\`\n${att.content}\n\`\`\`` });
        });
        m.attachments?.forEach(att => {
          if (att.type.startsWith('image/') && att.dataUrl) {
            contentParts.push({ type: 'image_url', image_url: { url: att.dataUrl } });
          }
        });
        return { role: m.role, content: contentParts };
      }
      let content = m.content;
      m.attachments?.forEach(att => {
        if (att.content) content += `\n\n📎 File: ${att.name}\n\`\`\`\n${att.content}\n\`\`\``;
        if (att.type.startsWith('image/')) content += `\n\n[Image: ${att.name}]`;
      });
      return { role: m.role, content };
    });
  }, []);


  // Chat
  const handleSendMessage = useCallback(async (content: string, attachments?: FileAttachment[], options?: { webSearch?: boolean; webChatTargets?: string[]; resendUserId?: string }) => {
    if (!activeConversation) return;
    const conversationSnapshot = {...activeConversation,messages:activeConversation.messages.filter(m=>m.id!==options?.resendUserId)};
    const requestId=crypto.randomUUID(), controller=new AbortController();
    requestGuardRef.current.start(requestId);abortControllerRef.current=controller;
    const localSettings=settingsRef.current?.local_knowledge;
    const attemptKnowledge=!!localSettings?.enabled&&!!content.trim()&&!pluginEnabled&&!attachments?.length;
    activeRequestRef.current={id:requestId,targets:options?.webChatTargets||[],knowledge:attemptKnowledge};
    setIsLoading(true);setStreamingContent('');setKnowledgeProgress(attemptKnowledge?'检查本地资料':'');
    const userMsg:ChatMessage={id:options?.resendUserId||crypto.randomUUID(),role:'user',content:content||'(file upload)',timestamp:Date.now(),attachments};
    setState(prev=>({...prev,conversations:prev.conversations.map(c=>c.id===conversationSnapshot.id?{...c,
      messages:[...c.messages.filter(m=>m.id!==userMsg.id),userMsg],
      title:conversationSnapshot.messages.length?c.title:(content||attachments?.[0]?.name||'New Chat').slice(0,40),updatedAt:Date.now()}:c)}));
    const history=conversationSnapshot.messages.map(m=>({role:m.role,content:m.content}));
    const globalSystem=settingsRef.current?.model_params.system_prompt||'';
    const styleConstraints=[...(conversationSnapshot.messages[0]?.role==='system'?[]:[globalSystem]),...history.filter(m=>m.role==='system').map(m=>m.content)].filter(Boolean).join('\n');
    let preflightRoute: AutoRouteResult | undefined;
    if (autoRouteEnabled && content.trim() && !options?.webChatTargets?.length
      && (!attemptKnowledge || localSettings?.online_fallback !== false)) {
      setKnowledgeProgress('判断是否需要最新资料');
      try {
        const response = await fetch('/api/auto-route', {
          method: 'POST', signal: controller.signal,
          headers: { 'Content-Type': 'application/json', 'X-Request-ID': requestId },
          body: JSON.stringify({ message: content, recent_messages: history.slice(-6) }),
        });
        if (response.ok) preflightRoute = await response.json() as AutoRouteResult;
      } catch (error) {
        if (!controller.signal.aborted) console.warn('auto-route preflight failed', error);
      }
    }
    const requiresWebSearch = options?.webSearch || preflightRoute?.requires_web_search || preflightRoute?.intent === '讯息' || preflightRoute?.role === 'web_search';
    const query:KnowledgeQueryRequest={request_id:requestId,question:content,context:history,system_constraints:styleConstraints,
      source_ids:localSettings?.selected_source_ids||[],mode:options?.webChatTargets?.length?'web':'api',
      online_target:options?.webChatTargets?.length?{kind:'web',target_ids:options.webChatTargets}:activeProvider?{kind:'api',provider_id:activeProvider.id,model:activeProvider.selectedModel}:null,
      parameters:{...settingsRef.current?.model_params},conversation_id:conversationSnapshot.id,user_message_id:userMsg.id};
    query.bypass_saved_reuse=!!options?.resendUserId;
    const progressLabels:Record<string,string>={prepare:'理解问题',retrieval:'检索本地资料',matching:'筛选匹配内容',generate:'生成本地回答',verify:'核对证据',miss:'转在线',hit:'本地回答'};
    const poll=attemptKnowledge?window.setInterval(()=>{
      if(controller.signal.aborted||!requestGuardRef.current.isCurrent(requestId))return;
      fetch(`/api/knowledge/requests/${requestId}`).then(r=>r.ok?r.json():null).then(data=>{
        if(data&&requestGuardRef.current.isCurrent(requestId)&&progressLabels[data.stage])setKnowledgeProgress(progressLabels[data.stage]);
      }).catch(()=>{});
    },500):null;
    const localRoute=await checkLocalFirst(query,{enabled:attemptKnowledge,onlineFallback:localSettings?.online_fallback!==false,signal:controller.signal,requiresWebSearch});
    if(poll!==null)window.clearInterval(poll);
    const finish=()=>requestGuardRef.current.finishRequest(requestId,()=>{
      activeRequestRef.current=null;if(abortControllerRef.current===controller)abortControllerRef.current=null;
      setIsLoading(false);setStreamingContent('');setKnowledgeProgress('');
    });
    if(localRoute.decision==='hit'||localRoute.decision==='cancelled'||localRoute.decision==='blocked'||controller.signal.aborted||!activeProvider){
      const hit=localRoute.decision==='hit'?localRoute.result:null;
      const cancelled=localRoute.decision==='cancelled'||controller.signal.aborted;
      const reason=localRoute.decision==='hit'?'':localRoute.reason;
      const message:ChatMessage={id:crypto.randomUUID(),role:'assistant',timestamp:Date.now(),
        content:cancelled?'⏹️ 已停止':hit?.answer||`本地资料未能回答：${knowledgeReasons[reason]||reason}。${!activeProvider?'请配置在线模型以使用兜底。':'在线兜底未开启。'}`,
        model:hit?.local_model,completion:{status:cancelled?'stopped':hit?'complete':'error',kind:'local',request_id:requestId,finished_at:Date.now(),effective_constraints:styleConstraints},
        knowledge:hit?{request_id:requestId,origin:hit.answer_origin||'local_generated',citations:hit.citations,trace:hit.trace,local_model:hit.local_model,duration_ms:hit.duration_ms,saved_entry:hit.saved_entry}:undefined};
      setState(prev=>({...prev,conversations:prev.conversations.map(c=>c.id===conversationSnapshot.id?{...c,messages:[...c.messages,message],updatedAt:Date.now()}:c)}));
      finish();return;
    }
    setKnowledgeProgress('');
    const missReason=localRoute.reason;
    const completeMetadata=async(answer:string,kind:Completion['kind'],status:Completion['status']='complete',context=history,systemConstraints=styleConstraints)=>({
      completion:{status,kind,request_id:requestId,finished_at:Date.now(),effective_constraints:systemConstraints,context,
        origin_hash:await turnHash(content,answer,context,systemConstraints)} satisfies Completion,
      knowledge:{request_id:requestId,origin:'online' as const,reason:missReason,citations:[],trace:localRoute.result?.trace||[]},
    });
    const collect=async(message:ChatMessage,sourceKind:'api_chat'|'web_chat'|'web_synthesis'='api_chat',locator?:Record<string,unknown>,context=history,contextComplete=true)=>{
      if(!localSettings?.enabled||!message.completion||controller.signal.aborted)return;
      if(sourceKind==='api_chat'&&!localSettings.collect_api_chats||sourceKind!=='api_chat'&&!localSettings.collect_web_chats)return;
      await recordKnowledge({conversation_id:effectiveConversation.id,user_message_id:userMsg.id,assistant_message_id:message.id,
        question:content,answer:message.content,context,system_constraints:message.completion.effective_constraints||'',
        completion:message.completion,provider_id:message.providerId,model:message.model,source_kind:sourceKind,locator,context_complete:contextComplete}).catch(()=>{});
    };
    let streamedForRequest='';

    // ---------- 自动路由：意图分析 + 上下文话题判定 + 角色路由 ----------
    let effectiveConversation: Conversation = conversationSnapshot;
    let effectiveProvider: APIProvider = activeProvider;
    let autoRouteInfo: ChatMessage['autoRoute'] | undefined;
    let autoRouteData: AutoRouteResult | undefined;
    let latestInformation = isCurrentInformationQuery(content);
    const sendOptions: { webSearch?: boolean } = { ...(options || {}) };
    const desktopForWebChat = getDesktop();
    const selectedWebChatTargets = (options?.webChatTargets || [])
      .map(id => webChatTargets.find(target => target.id === id))
      .filter((target): target is WebChatTarget => !!target);
    const webChatMode = !!desktopForWebChat && selectedWebChatTargets.length > 0 && !!content.trim();
    let createdNewConv = false;

    if (preflightRoute && !webChatMode) {
      const data = preflightRoute;
      autoRouteData = data;
      // 1) 是否新建对话
      if (!data.same_topic && activeConversation.messages.length > 0) {
        const newConv: Conversation = {
          id: crypto.randomUUID(),
          title: (content || 'New Chat').slice(0, 40) + ((content || '').length > 40 ? '...' : ''),
          messages: [],
          providerId: activeProvider.id,
          model: activeProvider.selectedModel,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        setState(prev => ({
          ...prev,
          conversations: [newConv, ...prev.conversations],
          activeConversationId: newConv.id,
        }));
        effectiveConversation = newConv;
        createdNewConv = true;
      }
      // 2) 选用角色对应的 provider/model
      if (data.target?.kind === 'role' && data.target.providerId && data.target.model) {
        const p = stateRef.current.providers.find(x => x.id === data.target.providerId);
        if (p) {
          effectiveProvider = { ...p, selectedModel: data.target.model || p.selectedModel };
          if (createdNewConv) {
            effectiveConversation = { ...effectiveConversation, providerId: p.id, model: effectiveProvider.selectedModel };
          }
        }
      }
      // 3) "讯息" 类自动开启联网搜索
      if (data.role === 'web_search' || data.requires_web_search || data.intent === '讯息') {
        latestInformation = true;
        sendOptions.webSearch = true;
      }
      autoRouteInfo = {
        intent: data.intent,
        complexity: data.complexity,
        role: data.role,
        providerName: data.target?.providerName || effectiveProvider.name,
        model: data.target?.model || effectiveProvider.selectedModel,
        sameTopic: data.same_topic,
        fallbackFrom: data.target?.fallback_from,
        keywords: data.keywords,
        reason: data.reason,
        trace: data.trace,
      };
    }

    if ((latestInformation || sendOptions.webSearch) && !webChatMode && !pluginEnabled) {
      sendOptions.webSearch = true;
      effectiveProvider = activeProvider;
      if (autoRouteInfo) autoRouteInfo = { ...autoRouteInfo, role: 'web_search',
        providerName: effectiveProvider.name, model: effectiveProvider.selectedModel };
    }

    if(controller.signal.aborted){
      const stopped:ChatMessage={id:crypto.randomUUID(),role:'assistant',content:'⏹️ 已停止',timestamp:Date.now(),completion:{status:'stopped',kind:'api',request_id:requestId,finished_at:Date.now()}};
      setState(prev=>({...prev,conversations:prev.conversations.map(c=>c.id===conversationSnapshot.id?{...c,messages:[...c.messages,stopped]}:c)}));finish();return;
    }

    // 决定是否进入「讯息」检索研究工作流：讯息意图 → 全量检索；同话题的格式/内容微调 → 复用上次来源
    const ADJUSTABLE_INTENTS = new Set(['文字润色', '问答', '数据分析', '未知']);
    let researchMode: 'full' | 'adjust' | null = null;
    if ((latestInformation || sendOptions.webSearch) && !webChatMode && !pluginEnabled && !attachments?.length) {
      researchMode = 'full';
    } else if (autoRouteEnabled && content.trim() && autoRouteData && !pluginEnabled && (!attachments || attachments.length === 0)) {
      if (autoRouteData.intent === '讯息') {
        researchMode = 'full';
      } else if (
        autoRouteData.same_topic &&
        lastResearchRef.current[effectiveConversation.id] &&
        ADJUSTABLE_INTENTS.has(autoRouteData.intent)
      ) {
        researchMode = 'adjust';
      }
    }

    // 决定是否进入「代码编写」工程化工作流：自动打开 AI 工作流弹窗并自动开跑
    const codeWorkflow = !!(
      autoRouteEnabled && content.trim() && autoRouteData && !pluginEnabled &&
      !researchMode && (!attachments || attachments.length === 0) &&
      autoRouteData.intent === '代码编写'
    );

    const isFirstMessage = effectiveConversation.messages.length === 0;
    const title = isFirstMessage
      ? (content || attachments?.[0]?.name || 'New Chat').slice(0, 40) + ((content || '').length > 40 ? '...' : '')
      : effectiveConversation.title;

    setState(prev => ({
      ...prev,
      conversations: prev.conversations.map(c =>
        c.id === effectiveConversation.id
          ? { ...c, messages: [...c.messages.filter(m=>m.id!==userMsg.id), userMsg], title, updatedAt: Date.now() }
          : createdNewConv && c.id===conversationSnapshot.id ? {...c,messages:c.messages.filter(m=>m.id!==userMsg.id)} : c
      ),
    }));

    setIsLoading(true);
    setStreamingContent('');
    let aborted = false;
    let inlineAssistantId: string | null = null;

    try {
      // ---------- 网页 AI 群聊：并行询问已打开网页 → 基本对话模型综合 ----------
      if(controller.signal.aborted)throw new DOMException('Aborted','AbortError');
      if (webChatMode && desktopForWebChat) {
        const assistantId = crypto.randomUUID();
        inlineAssistantId = assistantId;
        const aggregationProvider = webChatAggregator || effectiveProvider;
        const aggregator = {
          providerName: aggregationProvider.name,
          model: aggregationProvider.selectedModel,
          usesBasicModel: !!configuredWebChatAggregator,
        };
        const siteLabels: Record<string, string> = {
          deepseek: 'DeepSeek', qwen: 'Qwen', chatgpt: 'ChatGPT', claude: 'Claude',
          gemini: 'Gemini', grok: 'Grok', poe: 'Poe', generic: '网页 AI',
        };
        type WebChatState = {
          state: 'waiting' | 'done' | 'error';
          result?: WebChatResult;
          events: WebChatProgressEvent[];
        };
        const progress = new Map<string, WebChatState>(
          selectedWebChatTargets.map(target => [target.id, { state: 'waiting', events: [] }]),
        );
        const targetLabel = (target: WebChatTarget, result?: WebChatResult) =>
          siteLabels[result?.site || target.site] || target.title || target.site;
        const structuredAnswers = () => selectedWebChatTargets.map(target => {
          const item = progress.get(target.id);
          const result = item?.result;
          return {
            tabId: target.id,
            title: targetLabel(target, result),
            site: result?.site || target.site,
            model: result?.model,
            url: result?.url || target.url,
            content: result?.content,
            error: result?.error,
            warning: result?.warning,
            partial: result?.partial,
            durationMs: result?.durationMs,
            dumpPath: result?.dumpPath,
            pagePath: result?.pagePath,
            pageSaveError: result?.pageSaveError,
            events: item?.events || result?.progressEvents || [],
            extraction: result?.extraction,
            validation: result?.validation,
            status: item?.state || 'waiting',
          } as const;
        });
        const progressMarkdown = () => [
          '🌐 **网页 AI 群聊进行中**',
          '',
          `综合模型：**${aggregator.providerName} / ${aggregator.model}**（${aggregator.usesBasicModel ? '基本对话模型' : '当前选择模型'}）`,
          '',
          ...selectedWebChatTargets.map(target => {
            const item = progress.get(target.id);
            const label = targetLabel(target, item?.result);
            if (item?.state === 'done') return `- ✅ ${label}：已收到回答`;
            if (item?.state === 'error') return `- ❌ ${label}：${item.result?.error || '请求失败'}`;
            const latestEvent = item?.events[item.events.length - 1];
            return `- ⏳ ${label}：${latestEvent?.message || '正在回答…'}`;
          }),
        ].join('\n');
        const placeholder: ChatMessage = {
          id: assistantId,
          role: 'assistant',
          content: progressMarkdown(),
          timestamp: Date.now(),
          providerId: aggregationProvider.id,
          model: aggregationProvider.selectedModel,
          webChat: { status: 'running', aggregator, answers: structuredAnswers() },
        };
        setState(prev => ({
          ...prev,
          conversations: prev.conversations.map(c =>
            c.id === effectiveConversation.id
              ? { ...c, messages: [...c.messages, placeholder], updatedAt: Date.now() }
              : c
          ),
        }));
        const updateWebAssistant = (patch: Partial<ChatMessage>) => {
          if (controller.signal.aborted) return;
          setState(prev => ({
            ...prev,
            conversations: prev.conversations.map(c => c.id !== effectiveConversation.id ? c : {
              ...c,
              messages: c.messages.map(m => m.id === assistantId ? { ...m, ...patch } : m),
              updatedAt: Date.now(),
            }),
          }));
        };

        if (typeof desktopForWebChat.webChat !== 'function') {
          throw new Error('桌面桥接尚未加载网页群聊功能，请完全退出并重新启动桌面应用');
        }

        let removeWebChatProgress: (() => void) | undefined;
        const countedWebSends=new Set<string>();
        const countWebSend=(tabId:string,model?:string)=>{
          if(countedWebSends.has(tabId))return;countedWebSends.add(tabId);
          void recordKnowledgeOnlineCall(requestId,`${requestId}:web:${tabId}`,model).catch(()=>{});
        };
        if (typeof desktopForWebChat.onWebChatProgress === 'function') {
          removeWebChatProgress = desktopForWebChat.onWebChatProgress(event => {
            if(event.requestId!==requestId)return;
            if(event.event==='prompt-sent')countWebSend(event.id);
            if(controller.signal.aborted)return;
            const current = progress.get(event.id);
            if (!current) return;
            progress.set(event.id, {
              ...current,
              events: [...current.events, event].slice(-50),
            });
            updateWebAssistant({
              content: progressMarkdown(),
              timestamp: Date.now(),
              webChat: { status: 'running', aggregator, answers: structuredAnswers() },
            });
          });
        }
        const cleanupWebChatProgress = () => {
          removeWebChatProgress?.();
          removeWebChatProgress = undefined;
        };
        controller.signal.addEventListener('abort', cleanupWebChatProgress, { once: true });

        const allWebChats = Promise.all(selectedWebChatTargets.map(async target => {
          let result: WebChatResult;
          try {
            if(controller.signal.aborted)throw new DOMException('Aborted','AbortError');
            result = await desktopForWebChat.webChat(target.id, content.trim(), 300000, requestId);
          } catch (error: any) {
            result = { ok: false, error: error?.message || String(error) };
          }
          const current = progress.get(target.id);
          if(result.progressEvents?.some(event=>event.event==='prompt-sent'))countWebSend(target.id,result.model);
          if(controller.signal.aborted)return {target,result:{ok:false,cancelled:true} as WebChatResult};
          const combinedEvents = [...(current?.events || []), ...(result.progressEvents || [])];
          const seenEvents = new Set<string>();
          const events = combinedEvents.filter(event => {
            const key = `${event.timestamp}:${event.event}:${event.message}`;
            if (seenEvents.has(key)) return false;
            seenEvents.add(key);
            return true;
          }).slice(-50);
          progress.set(target.id, { state: result.ok ? 'done' : 'error', result, events });
          updateWebAssistant({
            content: progressMarkdown(),
            timestamp: Date.now(),
            webChat: { status: 'running', aggregator, answers: structuredAnswers() },
          });
          return { target, result };
        }));
        let rejectOnAbort: (() => void) | null = null;
        const abortedRequest = new Promise<never>((_resolve, reject) => {
          rejectOnAbort = () => reject(new DOMException('Aborted', 'AbortError'));
          controller.signal.addEventListener('abort', rejectOnAbort, { once: true });
        });
        const collected = await Promise.race([allWebChats, abortedRequest]);
        cleanupWebChatProgress();
        controller.signal.removeEventListener('abort', cleanupWebChatProgress);
        if (rejectOnAbort) controller.signal.removeEventListener('abort', rejectOnAbort);

        const successes = collected.filter(item => item.result.ok && item.result.content);
        const failures = collected.filter(item => !item.result.ok);
        const failureSummary = failures.length
          ? '\n\n未完成：' + failures.map(({ target, result }) =>
              `${targetLabel(target, result)}（${result.error || '请求失败'}）`
            ).join('；')
          : '';

        if (!successes.length) {
          updateWebAssistant({
            content: `## 网页 AI 群聊失败\n\n没有网页返回回答。请确认各网页已登录并进入聊天页面。${failureSummary}`,
            timestamp: Date.now(),
            webChat: { status: 'error', aggregator, answers: structuredAnswers() },
          });
          return;
        }

        updateWebAssistant({
          content: `🌐 **已收到 ${successes.length}/${selectedWebChatTargets.length} 个网页回答，正在由 ${aggregator.providerName} / ${aggregator.model} 综合…**${failureSummary}`,
          timestamp: Date.now(),
          webChat: { status: 'synthesizing', aggregator, answers: structuredAnswers() },
        });

        for(const item of successes){
          if(item.result.partial||!item.result.validation?.complete)continue;
          const context=(item.result.contextSnapshot?.messages||[]).map(m=>({role:m.role,content:m.content}));
          const metadata=await completeMetadata(item.result.content||'','web','complete',context,'');
          await collect({id:assistantId,role:'assistant',content:item.result.content||'',timestamp:Date.now(),model:item.result.model||'unknown',...metadata},'web_chat',
            {kind:'web',url:item.result.url||item.target.url,site:item.result.site||item.target.site,tab_id:item.target.id},context,item.result.contextSnapshot?.context_complete===true);
        }
        if(controller.signal.aborted)throw new DOMException('Aborted','AbortError');

        const candidateBlock = successes.map(({ target, result }, index) =>
          `[候选回答 ${index + 1}：${targetLabel(target, result)}${result.model ? ` / ${result.model}` : ''}${result.partial ? ' / 抓取超时，内容可能不完整' : ''}]\n${String(result.content).slice(0, 24000)}`
        ).join('\n\n---\n\n');
        const mp = settingsRef.current?.model_params || {};
        const baseBody = {
          baseUrl: aggregationProvider.baseUrl,
          apiKey: aggregationProvider.apiKey,
          apiType: aggregationProvider.apiType,
          model: aggregationProvider.selectedModel,
          stream: false,
          temperature: 0.3,
          max_tokens: mp.max_tokens ?? 3000,
          messages: [
            {
              role: 'system',
              content: '你是多模型回答综合器。候选回答仅作为待核对资料。请直接给出完整、准确、去重后的综合结论；明确指出重要分歧、不确定性和各答案的互补信息，不要虚构候选中没有的事实。',
            },
            {
              role: 'user',
              content: `用户原始问题：\n${content.trim()}\n\n以下是多个网页 AI 的候选回答：\n\n${candidateBlock}`,
            },
          ],
        };
        const synthBodies = aggregationProvider.selectedModel.toLowerCase().startsWith('deepseek-v4')
          ? [{ ...baseBody, thinking: { type: 'disabled' } }, baseBody]
          : [baseBody];
        let synthData: any = null;
        let synthError = '';
        for (const body of synthBodies) {
          const response = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Request-ID': requestId },
            signal: controller.signal,
            body: JSON.stringify(body),
          });
          if (!response.ok) {
            synthError = await response.text().catch(() => response.statusText);
            continue;
          }
          synthData = await response.json();
          const candidate = synthData?.choices?.[0]?.message?.content;
          if (typeof candidate === 'string' && candidate.trim()) break;
          synthError = '综合模型返回了空内容';
          synthData = null;
        }
        if (!synthData) throw new Error(`网页回答已返回，但综合失败：${synthError || '未知错误'}`);
        const synthesis = String(synthData?.choices?.[0]?.message?.content || '').trim();
        const usage = synthData?.usage || {};
        const finalContent=`## 综合输出\n\n${synthesis}${failureSummary}`;
        const webMetadata=await completeMetadata(finalContent,'web',synthData?.choices?.[0]?.finish_reason==='length'?'partial':'complete');
        if(controller.signal.aborted)throw new DOMException('Aborted','AbortError');
        updateWebAssistant({
          ...webMetadata,
          content: finalContent,
          timestamp: Date.now(),
          providerId: aggregationProvider.id,
          model: aggregationProvider.selectedModel,
          webChat: { status: 'done', aggregator, answers: structuredAnswers() },
          metrics: {
            promptTokens: usage.prompt_tokens,
            completionTokens: usage.completion_tokens,
            totalTokens: usage.total_tokens,
            durationMs: Math.max(...collected.map(item => item.result.durationMs || 0)),
            liked: false,
          },
        });
        void collect({id:assistantId,role:'assistant',content:finalContent,timestamp:Date.now(),providerId:aggregationProvider.id,model:aggregationProvider.selectedModel,...webMetadata},'web_synthesis',undefined,history,
          successes.every(item=>item.result.contextSnapshot?.context_complete===true));
        return;
      }

      // ---------- 「代码编写」：打开 AI 工作流（多文件工程）并自动开跑 ----------
      if (codeWorkflow) {
        const note: ChatMessage = {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: '🛠 已识别为「代码编写」，正在打开 **AI 工作流（多文件工程）** 并自动开始：规划 → 生成工程代码 → 编译运行（失败自动修复，最多 3 次）。\n\n> 可在弹窗底部用提示词继续纠正开发计划与代码。',
          timestamp: Date.now(),
          providerId: effectiveProvider.id,
          model: effectiveProvider.selectedModel,
          autoRoute: autoRouteInfo,
        };
        setState(prev => ({
          ...prev,
          conversations: prev.conversations.map(c =>
            c.id === effectiveConversation.id
              ? { ...c, messages: [...c.messages, note], updatedAt: Date.now() }
              : c
          ),
        }));
        setAgentRequest({ goal: content.trim(), nonce: Date.now() });
        return;
      }

      // ---------- 「讯息」检索研究工作流（内联）：规划检索 → 联网搜索抓正文 → 结构化整理 ----------
      if (researchMode) {
        const synthesisProvider = stateRef.current.providers.find(p => p.isDefault && p.baseUrl.trim() &&
          (p.selectedModel || p.models[0] || '').trim()) || activeProvider;
        const synthesisModel = (synthesisProvider.selectedModel || synthesisProvider.models[0] || '').trim();
        const assistantId = crypto.randomUUID();
        const placeholder: ChatMessage = {
          id: assistantId,
          role: 'assistant',
          content: researchMode === 'adjust' ? '🔁 正在按新的要求重新整理…' : '🔎 正在检索…',
          timestamp: Date.now(),
          providerId: synthesisProvider.id,
          model: synthesisModel,
          autoRoute: autoRouteInfo,
          research: { steps: [] },
        };
        setState(prev => ({
          ...prev,
          conversations: prev.conversations.map(c =>
            c.id === effectiveConversation.id
              ? { ...c, messages: [...c.messages, placeholder], updatedAt: Date.now() }
              : c
          ),
        }));
        const updateA = (mut: (m: ChatMessage) => ChatMessage) =>
          setState(prev => ({
            ...prev,
            conversations: prev.conversations.map(c =>
              c.id !== effectiveConversation.id
                ? c
                : { ...c, messages: c.messages.map(m => (m.id === assistantId ? mut(m) : m)) }
            ),
          }));
        const t0r = Date.now();
        const addStep = (step: string, detail = '', status: 'done' | 'warn' | 'error' = 'done') =>
          updateA(m => ({
            ...m,
            research: {
              ...(m.research || { steps: [] }),
              steps: [...(m.research?.steps || []), { step, detail, status, ms: Date.now() - t0r }],
            },
          }));

        try {
          const researchModel = { baseUrl: activeProvider.baseUrl, apiKey: activeProvider.apiKey,
            apiType: activeProvider.apiType, model: activeProvider.selectedModel, providerId: activeProvider.id };
          const synthesisRequest = { baseUrl: synthesisProvider.baseUrl, apiKey: synthesisProvider.apiKey,
            apiType: synthesisProvider.apiType, model: synthesisModel, providerId: synthesisProvider.id };
          let answerProviderId = synthesisProvider.id;
          let answerModel = synthesisModel;
          let answer = '';
          let finishReason = '';
          let rawSources: any[] = [];
          if (researchMode === 'adjust') {
            const previous = lastResearchRef.current[effectiveConversation.id];
            rawSources = previous?.rawSources || [];
            addStep('复用已检索来源', `${rawSources.length} 个来源，按新要求重新整理`);
            const response = await fetch('/api/research/synthesize', {
              method: 'POST', signal: controller.signal,
              headers: { 'Content-Type': 'application/json', 'X-Request-ID': requestId },
              body: JSON.stringify({ ...synthesisRequest, query: previous?.query || content.trim(),
                instruction: content.trim(), sources: rawSources.map(source => ({...source,
                  content: source.summary || source.content || '', snippet: source.summary || source.snippet || ''})),
                context: history, system_constraints: styleConstraints }),
            });
            if (!response.ok) throw new Error(`整理失败 (${response.status})`);
            const result = await response.json();answer = result.answer;finishReason = result.finish_reason;
            answerProviderId = result.provider_id || synthesisProvider.id;
            answerModel = result.model || synthesisModel;
          } else {
            addStep('综合搜索', '当前 Provider、OpenCLI 各站点与 DDGS 正在检索…');
            const response = await fetch('/api/research/stream', {
              method: 'POST', signal: controller.signal,
              headers: { 'Content-Type': 'application/json', 'X-Request-ID': requestId },
              body: JSON.stringify({ ...researchModel, providerName: activeProvider.name, query: content.trim(),
                web_search: true, latest: latestInformation, context: history, system_constraints: styleConstraints }),
            });
            const result = await consumeResearchStream(response, controller.signal, event => {
              if (controller.signal.aborted || !requestGuardRef.current.isCurrent(requestId)) return;
              if (event.type === 'status') {
                const channel = researchChannels[event.channel || ''] || event.channel || '检索';
                const language = event.query_language === 'zh' ? ' · 中文' : event.query_language === 'en' ? ' · 英文' : '';
                const running = event.channel === 'parsing' ? '解析中' : event.channel === 'synthesis' ? '整合中' : event.channel === 'keywords' ? '提取中' : '检索中';
                const state = { running, retrying: '重试中', done: '完成', error: '失败' }[event.status || 'running'];
                addStep(`${channel}${language} · ${state}`, event.detail || event.search_query || '', event.status === 'error' ? 'warn' : 'done');
              }
              if (event.type === 'plan') {
                updateA(message => ({ ...message, research: { ...(message.research || { steps: [] }),
                  keywords: [...new Set(Object.values(event.keywords || {}).flat())],
                  queries: event.queries, keywordModel: event.keyword_model } }));
              }
              if (event.type === 'result' && event.result) {
                const source = event.result;
                updateA(message => {
                  const previous = message.research?.results || [];
                  const index = previous.findIndex(item => item.id === source.id);
                  const results = [...previous];
                  if (index < 0) results.push(source);else results[index] = source;
                  return { ...message, research: { ...(message.research || { steps: [] }), results } };
                });
              }
            });
            answer = result.answer || '';finishReason = result.finish_reason || '';
            answerProviderId = result.provider_id || synthesisProvider.id;
            answerModel = result.model || synthesisModel;
            rawSources = result.sources || [];
            lastResearchRef.current[effectiveConversation.id] = { query: content.trim(), rawSources };
          }
          if (!answer.trim()) throw new Error('综合模型返回空回答');
          const metadata = await completeMetadata(answer, 'api', finishReason === 'length' ? 'partial' : 'complete');
          if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
          const usedSources: ChatSource[] = rawSources.map(source => ({ title: source.title || '', url: source.url || '',
            snippet: source.summary || source.snippet || (source.content ? source.content.slice(0, 160) : '') })).filter(source => source.url);
          addStep('完成');
          updateA(message => ({ ...message, ...metadata, content: answer, providerId: answerProviderId,
            model: answerModel, sources: usedSources.length ? usedSources : undefined, timestamp: Date.now() }));
          void collect({ id: assistantId, role: 'assistant', content: answer, timestamp: Date.now(),
            providerId: answerProviderId, model: answerModel, ...metadata });
        } catch (e: any) {
          if (e?.name === 'AbortError' || controller.signal.aborted) {
            aborted = true;
            updateA(m => ({ ...m, content: '⏹️ 已停止' }));
          } else {
            addStep('出错', e?.message || String(e), 'error');
            updateA(m => ({ ...m, content: `❌ 检索失败: ${e?.message || String(e)}` }));
          }
        }
        return;
      }

      if (pluginEnabled) {
        // ---------- 插件模式：使用 SSE 把"生成代码 / 创建插件 / 执行 / 修复"等关键过程实时回传到对话气泡 ----------
        // 先插入一条占位的 assistant 消息，后面随事件流逐步填充 pluginProgress / pluginResult。
        const assistantId = crypto.randomUUID();
        const placeholder: ChatMessage = {
          id: assistantId,
          role: 'assistant',
          content: '⏳ 正在运行插件流水线...',
          timestamp: Date.now(),
          providerId: effectiveProvider.id,
          model: effectiveProvider.selectedModel,
          pluginProgress: [],
          autoRoute: autoRouteInfo,
        };
        setState(prev => ({
          ...prev,
          conversations: prev.conversations.map(c =>
            c.id === effectiveConversation.id
              ? { ...c, messages: [...c.messages, placeholder], updatedAt: Date.now() }
              : c
          ),
        }));

        const updateAssistant = (mutator: (m: ChatMessage) => ChatMessage) => {
          setState(prev => ({
            ...prev,
            conversations: prev.conversations.map(c => {
              if (c.id !== effectiveConversation.id) return c;
              return {
                ...c,
                messages: c.messages.map(m => (m.id === assistantId ? mutator(m) : m)),
              };
            }),
          }));
        };

        const appendProgress = (ev: PluginProgressEvent) => {
          updateAssistant(m => ({
            ...m,
            pluginProgress: [...(m.pluginProgress ?? []), ev],
          }));
        };

        try {
          const res = await fetch('/api/chat-with-plugin/stream', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Request-ID': requestId },
            signal: controller.signal,
            body: JSON.stringify({
              message: content || '(file upload)',
              baseUrl: effectiveProvider.baseUrl,
              apiKey: effectiveProvider.apiKey,
              model: effectiveProvider.selectedModel,
            }),
          });

          if (!res.ok || !res.body) {
            const errText = await res.text().catch(() => '');
            throw new Error(`API Error (${res.status}): ${errText || res.statusText}`);
          }

          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          let finalResponse = '';
          let finalResult: PluginResult | null = null;

          const handleFrame = (raw: string) => {
            const line = raw.trim();
            if (!line || !line.startsWith('data: ')) return;
            const payload = line.slice(6);
            if (payload === '[DONE]') return;
            let json: any;
            try { json = JSON.parse(payload); } catch { return; }
            if (json?.type === 'step') {
              appendProgress(json as PluginProgressEvent);
            } else if (json?.type === 'final') {
              finalResponse = json.response ?? '';
              finalResult = json.plugin_result ?? null;
            }
          };

          while (true) {
            const { done, value } = await reader.read();
            if (value) buffer += decoder.decode(value, { stream: true });
            let nl: number;
            while ((nl = buffer.indexOf('\n\n')) !== -1) {
              const frame = buffer.slice(0, nl);
              buffer = buffer.slice(nl + 2);
              for (const part of frame.split('\n')) handleFrame(part);
            }
            if (done) {
              if (buffer.trim()) for (const part of buffer.split('\n')) handleFrame(part);
              break;
            }
          }

          const pluginResult: PluginResult = finalResult ?? {
            success: false,
            result: { type: 'text', content: '无插件结果' },
          };
          const finalContent = finalResponse
            || (pluginResult.success ? '✅ 插件执行成功' : '❌ 插件执行失败');
          updateAssistant(m => ({ ...m, content: finalContent, pluginResult, timestamp: Date.now() }));
        } catch (err: any) {
          if (err?.name === 'AbortError' || controller.signal.aborted) {
            aborted = true;
            updateAssistant(m => ({
              ...m,
              content: '⏹️ 已停止',
              pluginProgress: [
                ...(m.pluginProgress ?? []),
                { phase: 'error', status: 'info', message: '用户已停止' },
              ],
            }));
          } else {
            updateAssistant(m => ({
              ...m,
              content: `❌ **插件请求失败**: ${err?.message || String(err)}`,
              pluginProgress: [
                ...(m.pluginProgress ?? []),
                { phase: 'error', status: 'error', message: err?.message || String(err) },
              ],
            }));
          }
        }
        return;
      }

      const allMessages = [...effectiveConversation.messages, userMsg];
      let apiMessages = buildApiMessages(allMessages, !!effectiveProvider.supportsVision);

      // 收集本次响应要附在 assistant 消息上的引用
      let collectedSources: ChatSource[] = [];

      if (sendOptions.webSearch && content.trim()) {
        try {
          const wsCfg = settingsRef.current?.web_search;
          const searchRes = await fetch('/api/web-search', {
            method: 'POST',
            signal: controller.signal,
            headers: { 'Content-Type': 'application/json', 'X-Request-ID': requestId },
            body: JSON.stringify({
              query: content.trim(),
              provider: latestInformation ? 'duckduckgo' : wsCfg?.provider,
              latest: latestInformation,
              timelimit: latestInformation ? searchTimeLimit(content) : undefined,
              max_results: wsCfg?.max_results ?? 6,
              topic: wsCfg?.topic,
              preferred_sites: wsCfg?.preferred_sites,
              fetch_full_content: latestInformation || (wsCfg?.fetch_full_content ?? true),
              max_content_chars: wsCfg?.max_content_chars ?? 4000,
              keys: wsCfg?.keys,
            }),
          });
          const searchData = await searchRes.json();
          if (!searchRes.ok) throw new Error(searchData.error || '联网搜索失败');
          const results: Array<{ title?: string; snippet?: string; url?: string; link?: string; content?: string }> = searchData.results || [];
          if (results.length > 0) {
            collectedSources = results.map(r => ({
              title: r.title || '',
              url: r.url || r.link || '',
              snippet: r.snippet || '',
            })).filter(s => s.url);
            const searchBlock =
              `以下为针对用户问题的网络搜索结果（${searchData.provider || 'web'}），请结合最新信息回答；`
              + `回答末尾请用 [n] 标注引用，与下面的编号对应。\n\n`
              + results.map((r, i) => {
                const url = r.url || r.link || '';
                const body = (r.content || r.snippet || '').trim();
                return `[${i + 1}] ${r.title || url}\n${url}\n${body}`;
              }).join('\n\n---\n\n');
            apiMessages = [{ role: 'system', content: searchBlock }, ...apiMessages];
          }
          if (latestInformation && !results.length) throw new Error('未获取到有效网页资料，无法确认最新信息');
        } catch (error) {
          if (latestInformation || controller.signal.aborted) throw error;
          // 搜索失败时仍按原消息发送
        }
      }

      const t0 = Date.now();
      // 把通用模型参数透传给后端（后端也会以 settings 的默认值兜底）
      const mp = settingsRef.current?.model_params || {};
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Request-ID': requestId },
        signal: controller.signal,
        body: JSON.stringify({
          baseUrl: effectiveProvider.baseUrl,
          apiKey: effectiveProvider.apiKey,
          apiType: effectiveProvider.apiType,
          model: effectiveProvider.selectedModel,
          messages: apiMessages,
          stream: true,
          // 透传当前生效的通用参数（None/空字段在后端会被忽略）
          temperature: mp.temperature,
          top_p: mp.top_p,
          max_tokens: mp.max_tokens ?? undefined,
          presence_penalty: mp.presence_penalty,
          frequency_penalty: mp.frequency_penalty,
          seed: mp.seed ?? undefined,
          stop: mp.stop,
          system_prompt: mp.system_prompt,
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`API Error (${response.status}): ${errText}`);
      }

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let fullContent = '';
      let buffer = '';
      let usagePrompt: number | undefined;
      let usageCompletion: number | undefined;
      let usageTotal: number | undefined;
      let sawDone=false;
      let finishReason:string|undefined;

      const consumeFrame = (json: any) => {
        if (json?.error) throw new Error(json.error);
        const delta = json?.choices?.[0]?.delta?.content;
        if(json?.choices?.[0]?.finish_reason)finishReason=json.choices[0].finish_reason;
        if (delta) {
          fullContent += delta;
          streamedForRequest=fullContent;
          if(requestGuardRef.current.isCurrent(requestId))setStreamingContent(fullContent);
        }
        // OpenAI 兼容：开启 stream_options.include_usage 后末帧含 usage
        if (json?.usage && typeof json.usage === 'object') {
          if (typeof json.usage.prompt_tokens === 'number') usagePrompt = json.usage.prompt_tokens;
          if (typeof json.usage.completion_tokens === 'number') usageCompletion = json.usage.completion_tokens;
          if (typeof json.usage.total_tokens === 'number') usageTotal = json.usage.total_tokens;
        }
      };

      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (value) buffer += decoder.decode(value, { stream: true });
          let lineEnd: number;
          while ((lineEnd = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, lineEnd).trim();
            buffer = buffer.slice(lineEnd + 1);
            if(line==='data: [DONE]')sawDone=true;
            if (!line || line === 'data: [DONE]') continue;
            if (!line.startsWith('data: ')) continue;
            try {
              consumeFrame(JSON.parse(line.slice(6)));
            } catch (e) {
              if (e instanceof Error && e.message) throw e;
            }
          }
          if (done) {
            if (buffer.trim()) {
              const line = buffer.trim();
              if (line.startsWith('data: ') && line !== 'data: [DONE]') {
                try {
                  consumeFrame(JSON.parse(line.slice(6)));
                } catch (e) {
                  if (e instanceof Error && e.message) throw e;
                }
              }
            }
            break;
          }
        }
      }

      if (!fullContent) {
        fullContent = 'No response received.';
      }

      const durationMs = Date.now() - t0;
      const totalTokens = usageTotal ?? (((usagePrompt ?? 0) + (usageCompletion ?? 0)) || undefined);
      const responseStatus:Completion['status']=(sawDone||finishReason==='stop')&&(!finishReason||finishReason==='stop')&&fullContent!=='No response received.'?'complete':'partial';
      const metadata=await completeMetadata(fullContent,'api',responseStatus);
      if(controller.signal.aborted)throw new DOMException('Aborted','AbortError');

      const assistantMsg: ChatMessage = {
        ...metadata,
        id: crypto.randomUUID(),
        role: 'assistant',
        content: fullContent,
        timestamp: Date.now(),
        providerId: effectiveProvider.id,
        model: effectiveProvider.selectedModel,
        metrics: {
          promptTokens: usagePrompt,
          completionTokens: usageCompletion,
          totalTokens,
          durationMs,
          liked: false,
        },
        sources: collectedSources.length ? collectedSources : undefined,
        autoRoute: autoRouteInfo,
      };

      setState(prev => ({
        ...prev,
        conversations: prev.conversations.map(c =>
          c.id === effectiveConversation.id
            ? { ...c, messages: [...c.messages.filter(m => m.role === 'user' || m.id !== userMsg.id), assistantMsg], updatedAt: Date.now() }
            : c
        ),
      }));
      void collect(assistantMsg);

      // 后台上报模型统计（失败不影响 UI）
      fetch('/api/model-stats/record', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Request-ID': requestId },
        body: JSON.stringify({
          providerId: effectiveProvider.id,
          model: effectiveProvider.selectedModel,
          durationMs,
          tokens: totalTokens ?? 0,
          promptTokens: usagePrompt ?? 0,
          completionTokens: usageCompletion ?? 0,
        }),
      }).catch(() => {});
    } catch (err: any) {
      if (err?.name === 'AbortError' || controller.signal.aborted) {
        aborted = true;
        // 把当前已经收到的流式内容固化为一条 assistant 消息（如有），并加"已停止"标记
        setState(prev => ({
          ...prev,
          conversations: prev.conversations.map(c => {
            if (c.id !== effectiveConversation.id) return c;
            const partial = streamedForRequest.trim();
            const stoppedMsg: ChatMessage = {
              completion:{status:'stopped',kind:webChatMode?'web':'api',request_id:requestId,finished_at:Date.now()},
              id: crypto.randomUUID(),
              role: 'assistant',
              content: partial ? `${partial}\n\n⏹️ _已停止_` : '⏹️ 已停止',
              timestamp: Date.now(),
              providerId: effectiveProvider.id,
              model: effectiveProvider.selectedModel,
              autoRoute: autoRouteInfo,
            };
            if (inlineAssistantId) {
              return {
                ...c,
                messages: c.messages.map(m => m.id === inlineAssistantId
                  ? {
                    ...m,
                    content: `${m.content}\n\n---\n\n⏹️ _网页群聊已停止_`,
                    timestamp: Date.now(),
                    webChat: m.webChat ? { ...m.webChat, status: 'stopped' } : undefined,
                  }
                  : m),
                updatedAt: Date.now(),
              };
            }
            return { ...c, messages: [...c.messages, stoppedMsg], updatedAt: Date.now() };
          }),
        }));
      } else {
        const errorMsg: ChatMessage = {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: `❌ **Error**: ${err.message}\n\n> Make sure the Python backend is running:\n\n\`\`\`bash\npip install flask requests\npython server.py\n\`\`\``,
          timestamp: Date.now(),
          autoRoute: autoRouteInfo,
        };

        setState(prev => ({
          ...prev,
          conversations: prev.conversations.map(c => {
            if (c.id !== effectiveConversation.id) return c;
            if (inlineAssistantId) {
              return {
                ...c,
                messages: c.messages.map(m => m.id === inlineAssistantId
                  ? {
                    ...m,
                    content: `${m.content}\n\n---\n\n❌ **网页群聊失败**：${err.message}`,
                    timestamp: Date.now(),
                    webChat: m.webChat ? { ...m.webChat, status: 'error' } : undefined,
                  }
                  : m),
                updatedAt: Date.now(),
              };
            }
            return { ...c, messages: [...c.messages, errorMsg], updatedAt: Date.now() };
          }),
        }));
      }
    } finally {
      // 防止 lint 抱怨未使用变量；同时它本身用于清理逻辑分支
      void aborted;
      if (abortControllerRef.current === controller) abortControllerRef.current = null;
      finish();
    }
  }, [activeConversation, activeProvider, pluginEnabled, autoRouteEnabled, setState, webChatTargets, webChatAggregator, configuredWebChatAggregator]);

  const handlePluginRun = useCallback((convId: string, messageId: string, pluginName: string) => {
    const p = activeProviderRef.current;
    const controller = new AbortController();
    abortControllerRef.current = controller;
    setPluginActionBusy(true);
    fetch(`/api/plugins/${encodeURIComponent(pluginName)}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        auto_fix: true,
        max_attempts: 3,
        baseUrl: p?.baseUrl,
        apiKey: p?.apiKey,
        model: p?.selectedModel,
      }),
    })
      .then(r => r.json())
      .then((r: Partial<PluginResult>) => {
        setState(prev => ({
          ...prev,
          conversations: prev.conversations.map(c => {
            if (c.id !== convId) return c;
            return {
              ...c,
              messages: c.messages.map(m =>
                m.id === messageId && m.pluginResult
                  ? {
                      ...m,
                      pluginResult: {
                        ...m.pluginResult,
                        ...r,
                        result: r.result ?? m.pluginResult.result,
                      } as PluginResult,
                    }
                  : m
              ),
              updatedAt: Date.now(),
            };
          }),
        }));
      })
      .catch((err) => {
        if (err?.name === 'AbortError' || controller.signal.aborted) return;
        // 其它错误静默
      })
      .finally(() => {
        if (abortControllerRef.current === controller) abortControllerRef.current = null;
        setPluginActionBusy(false);
      });
  }, [setState]);

  const handlePluginChat = useCallback((
    convId: string,
    messageId: string,
    pluginName: string,
    userMessage: string,
    currentCode: string,
    context?: string,
  ) => {
    const p = activeProviderRef.current;
    if (!p) return;
    const controller = new AbortController();
    abortControllerRef.current = controller;
    setPluginActionBusy(true);
    fetch(`/api/plugins/${encodeURIComponent(pluginName)}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        message: userMessage,
        current_code: currentCode,
        context: context || '',
        auto_fix: true,
        max_attempts: 3,
        baseUrl: p.baseUrl,
        apiKey: p.apiKey,
        model: p.selectedModel,
      }),
    })
      .then(r => r.json())
      .then((data: { success?: boolean; code?: string; language?: string; exec_result?: Partial<PluginResult> }) => {
        setState(prev => ({
          ...prev,
          conversations: prev.conversations.map(c => {
            if (c.id !== convId) return c;
            return {
              ...c,
              messages: c.messages.map(m => {
                if (m.id !== messageId || !m.pluginResult) return m;
                const pr = data.exec_result || {};
                return {
                  ...m,
                  pluginResult: {
                    ...m.pluginResult,
                    ...pr,
                    code: data.code ?? m.pluginResult.code,
                    language: data.language ?? pr.language ?? m.pluginResult.language,
                    success: pr.success ?? m.pluginResult.success,
                    result: pr.result ?? m.pluginResult.result,
                  } as PluginResult,
                };
              }),
              updatedAt: Date.now(),
            };
          }),
        }));
      })
      .catch((err) => {
        if (err?.name === 'AbortError' || controller.signal.aborted) return;
        // 其它错误静默
      })
      .finally(() => {
        if (abortControllerRef.current === controller) abortControllerRef.current = null;
        setPluginActionBusy(false);
      });
  }, [setState]);

  const handlePluginReloadCode = useCallback((pluginName: string): Promise<string | null> => {
    return fetch(`/api/plugins/${encodeURIComponent(pluginName)}`)
      .then(r => r.json())
      .then((d: { code?: string }) => d.code ?? null)
      .catch(() => null);
  }, []);

  /** 终止当前进行中的对话 / 插件流水线 / 插件运行修改请求。 */
  const handleStop = useCallback(() => {
    const request=activeRequestRef.current;
    if(request?.knowledge)void cancelKnowledge(request.id).catch(()=>{});
    if(request){const desktop=getDesktop();for(const target of request.targets)if(desktop?.cancelWebChat)void desktop.cancelWebChat(target,request.id).catch(()=>{});}
    const ctl = abortControllerRef.current;
    if (ctl) {
      try { ctl.abort(); } catch { /* noop */ }
      abortControllerRef.current = null;
    }
    // 立即清掉 UI 上的"加载中"标记，让发送按钮恢复可用
    setIsLoading(false);
    setStreamingContent('');
    setPluginActionBusy(false);
  }, []);

  const handleResend = useCallback((convId: string, userMsg: ChatMessage, errorMsgId: string) => {
    setState(prev => ({
      ...prev,
      conversations: prev.conversations.map(c =>
        c.id === convId ? { ...c, messages: c.messages.filter(m => m.id !== errorMsgId), updatedAt: Date.now() } : c
      ),
    }));
    setTimeout(() => setPendingResend({ convId, userMsg }), 0);
  }, [setState]);

  const handleEditUserMessage = useCallback((convId: string, msgId: string, content: string, attachments?: FileAttachment[]) => {
    setState(prev => ({
      ...prev,
      conversations: prev.conversations.map(c => {
        if (c.id !== convId) return c;
        const idx = c.messages.findIndex(m => m.id === msgId);
        if (idx < 0) return c;
        return { ...c, messages: c.messages.slice(0, idx), updatedAt: Date.now() };
      }),
    }));
    setInjectedForInput({ content, attachments });
  }, [setState]);

  // 点赞 / 取消点赞 一条助手消息（更新本地状态 + 后台上报模型统计）
  const handleLikeMessage = useCallback((convId: string, msgId: string) => {
    let providerId: string | undefined;
    let model: string | undefined;
    let nextLiked = false;
    setState(prev => ({
      ...prev,
      conversations: prev.conversations.map(c => {
        if (c.id !== convId) return c;
        return {
          ...c,
          messages: c.messages.map(m => {
            if (m.id !== msgId) return m;
            const cur = !!m.metrics?.liked;
            nextLiked = !cur;
            providerId = m.providerId;
            model = m.model;
            return { ...m, metrics: { ...(m.metrics || {}), liked: nextLiked } };
          }),
          updatedAt: Date.now(),
        };
      }),
    }));
    if (providerId && model) {
      fetch('/api/model-stats/like', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerId, model, liked: nextLiked }),
      }).catch(() => {});
    }
  }, [setState]);

  // 刷新某个 Provider 的模型列表（点击 Provider 卡片上的刷新按钮触发）
  const handleRefreshProviderModels = useCallback(async (providerId: string) => {
    const p = state.providers.find(pp => pp.id === providerId);
    if (!p) return;
    try {
      const res = await fetch('/api/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl: p.baseUrl, apiKey: p.apiKey, apiType: p.apiType }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(data?.error || `获取模型失败 (${res.status})`);
        return;
      }
      const models: string[] = Array.isArray(data?.models) ? data.models : [];
      setState(prev => ({
        ...prev,
        providers: prev.providers.map(pp =>
          pp.id === providerId
            ? { ...pp, models, selectedModel: models.includes(pp.selectedModel) ? pp.selectedModel : (models[0] || '') }
            : pp
        ),
      }));
    } catch (e: any) {
      alert(e?.message || '刷新模型失败');
    }
  }, [state.providers, setState]);

  useEffect(() => {
    if(!pendingResend)return;
    const {convId,userMsg}=pendingResend;
    const conv=state.conversations.find(c=>c.id===convId);
    if(!conv||conv.messages.at(-1)?.id!==userMsg.id){setPendingResend(null);return;}
    if(activeConversation?.id!==convId){setState(prev=>({...prev,activeConversationId:convId}));return;}
    setPendingResend(null);
    void handleSendMessage(userMsg.content,userMsg.attachments,{resendUserId:userMsg.id});
  },[pendingResend,state.conversations,activeConversation,handleSendMessage,setState]);

  // Loading screen
  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center bg-gray-900">
        <div className="text-center space-y-4">
          <Loader2 size={48} className="animate-spin text-blue-500 mx-auto" />
          <div>
            <h2 className="text-xl font-semibold text-white">Loading LLM Manager</h2>
            <p className="text-gray-400 mt-1">Connecting to backend...</p>
          </div>
        </div>
      </div>
    );
  }

  const activeCenterTabMeta = centerTabs.find(t => t.id === activeCenterTab);
  const fileManagerDir = (() => {
    const workdirKinds = ['claude', 'claude-term', 'hermes', 'hermes-term', 'desktop-agent', 'codex-term'] as const;
    if (activeCenterTabMeta && workdirKinds.includes(activeCenterTabMeta.kind as typeof workdirKinds[number])) {
      const cwd = claudeCwds[activeCenterTabMeta.id];
      if (cwd) return cwd;
      if (activeCenterTabMeta.kind === 'desktop-agent' || activeCenterTabMeta.kind === 'codex-term') {
        return claudeMeta.defaultCwd || hermesMeta.defaultCwd || '';
      }
    }
    if (activeCenterTabMeta?.kind === 'file' && activeCenterTabMeta.path) {
      const path = activeCenterTabMeta.path.replace(/[\\/]$/, '');
      const separator = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
      if (separator > 0) return path.slice(0, separator);
    }
    const anyAgent = centerTabs.find(t => workdirKinds.includes(t.kind as typeof workdirKinds[number]) && claudeCwds[t.id]);
    if (anyAgent) return claudeCwds[anyAgent.id];
    return hermesMeta.repoDir || hermesMeta.defaultCwd || claudeMeta.repoDir || claudeMeta.defaultCwd || '';
  })();

  const activeAgentTabKind = centerTabs.find(t => t.id === activeCenterTab)?.kind;
  const isAgentWorkbenchTab = ['claude', 'claude-term', 'hermes', 'hermes-term'].includes(activeAgentTabKind || '');
  const workbenchVariant: 'claude' | 'hermes' = (activeAgentTabKind === 'hermes' || activeAgentTabKind === 'hermes-term') ? 'hermes' : 'claude';
  const workbenchCommands = workbenchVariant === 'hermes'
    ? (hermesSessions[activeCenterTab]?.slashCommands || [])
    : (claudeSessions[activeCenterTab]?.slashCommands || []);
  const workbenchSkills = workbenchVariant === 'hermes'
    ? (hermesSessions[activeCenterTab]?.skills || [])
    : (claudeSessions[activeCenterTab]?.skills || []);

  const activeProviderPayload = activeProvider ? {
    name: activeProvider.name,
    baseUrl: activeProvider.baseUrl,
    apiKey: activeProvider.apiKey,
    model: activeProvider.selectedModel,
    apiType: activeProvider.apiType,
  } : null;

  return (
    <div className="h-screen flex flex-col bg-gray-850 text-white overflow-hidden">
      {/* Backend status banner */}
      {backendError && (
        <div className="bg-amber-900/60 border-b border-amber-700 px-4 py-2 flex items-center gap-2 text-amber-200 text-sm shrink-0">
          <ServerOff size={16} className="shrink-0" />
          <span>{backendError}</span>
        </div>
      )}
      {!backendError && (
        <div className="bg-emerald-900/30 border-b border-emerald-800/50 px-4 py-1.5 flex items-center gap-2 text-emerald-400 text-xs shrink-0">
          <Server size={12} className="shrink-0" />
          <span>Connected to backend — data saved on server ({state.providers.length} providers, {state.conversations.length} conversations)</span>
        </div>
      )}

      <div className="flex flex-1 min-h-0">
        <Sidebar
          providers={state.providers}
          conversations={state.conversations}
          activeConversationId={state.activeConversationId}
          activeProviderId={state.activeProviderId}
          collapsed={sidebarCollapsed}
          terminalVisible={terminalVisible}
          onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
          onToggleTerminal={() => setTerminalVisible(!terminalVisible)}
          onNewConversation={handleNewConversation}
          onSelectConversation={handleSelectConversation}
          onDeleteConversation={handleDeleteConversation}
          onOpenConfig={(p) => { setEditingProvider(p || null); setShowConfigModal(true); }}
          onDeleteProvider={handleDeleteProvider}
          onSelectProvider={handleSelectProvider}
          onSelectModel={handleSelectModel}
          onRefreshProviderModels={handleRefreshProviderModels}
          onAddLocalProvider={handleAddLocalProvider}
          onOpenLocalHub={() => setShowLocalHub(true)}
          onOpenContentLibrary={() => openContentLibrary()}
          onOpenProviderSource={(url, name) => openWebTab(url, name)}
        />

        {/* 左侧文件管理器（SP2，可折叠） */}
        {filesPanelOpen && (
          <div className="w-64 shrink-0 flex flex-col bg-gray-900 border-r border-gray-700">
            <div className="shrink-0 h-9 flex items-center gap-2 px-3 border-b border-gray-700 text-xs text-gray-300">
              <FolderTree size={14} className="text-sky-400" />
              <span className="flex-1 font-medium">文件管理器</span>
              <button
                onClick={() => setFilesPanelNav({ dir: fileManagerDir, nonce: Date.now() })}
                className="px-1.5 py-0.5 rounded hover:bg-gray-700 text-gray-400 hover:text-sky-300 text-[10px]"
                title="跳转到当前 Agent 工作目录"
              >
                跟随工作区
              </button>
              <button onClick={() => setFilesPanelOpen(false)} className="p-0.5 rounded hover:bg-gray-700 text-gray-400 hover:text-white" title="折叠">
                <ChevronLeft size={15} />
              </button>
            </div>
            <div className="flex-1 min-h-0">
              <FileTree
                initialDir={filesPanelCwd || fileManagerDir}
                navigateTo={filesPanelNav?.dir}
                navigateNonce={filesPanelNav?.nonce}
                onCwdChange={setFilesPanelCwd}
                onOpenFile={openFileTab}
              />
            </div>
          </div>
        )}

        <div className="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden">
          {/* 中部 Tab 栏 */}
          <div className="shrink-0 flex items-center gap-1 bg-gray-900 border-b border-gray-700 px-2 h-9 overflow-x-auto">
            {centerTabs.map(tab => {
              const isActive = tab.id === activeCenterTab;
              const closable = tab.kind === 'claude' || tab.kind === 'claude-term' || tab.kind === 'hermes' || tab.kind === 'hermes-term' || tab.kind === 'desktop-agent' || tab.kind === 'codex-term' || tab.kind === 'file' || tab.kind === 'web';
              return (
                <div
                  key={tab.id}
                  onClick={() => setActiveCenterTab(tab.id)}
                  title={tab.url || tab.path || tab.title}
                  className={`group flex items-center gap-1.5 px-3 h-7 rounded-t cursor-pointer text-xs shrink-0 border-b-2 ${
                    isActive ? 'bg-gray-850 text-white border-purple-500' : 'text-gray-400 border-transparent hover:text-gray-200 hover:bg-gray-800'
                  }`}
                >
                  {tab.kind === 'claude' ? <Sparkles size={12} className="text-purple-400 shrink-0" />
                    : tab.kind === 'claude-term' ? <TerminalIcon size={12} className="text-purple-300 shrink-0" />
                    : tab.kind === 'hermes' ? <Bot size={12} className="text-amber-400 shrink-0" />
                    : tab.kind === 'hermes-term' ? <TerminalIcon size={12} className="text-amber-300 shrink-0" />
                    : tab.kind === 'desktop-agent' ? <Bot size={12} className="text-amber-300 shrink-0" />
                    : tab.kind === 'codex-term' ? <TerminalIcon size={12} className="text-cyan-300 shrink-0" />
                    : tab.kind === 'file' ? <FileText size={12} className="text-sky-400 shrink-0" />
                    : tab.kind === 'web' ? <Globe size={12} className="text-amber-400 shrink-0" />
                    : <MessageSquare size={12} className="shrink-0" />}
                  <span className="whitespace-nowrap max-w-[160px] truncate">{tab.title}</span>
                  {closable && (
                    <button
                      onClick={(e) => { e.stopPropagation(); closeCenterTab(tab.id); }}
                      className="opacity-60 group-hover:opacity-100 hover:text-red-400 rounded focus:opacity-100"
                      title="关闭"
                    >
                      <XIcon size={11} />
                    </button>
                  )}
                </div>
              );
            })}
            <div className="ml-1 flex items-center shrink-0">
              <button
                ref={addBtnRef}
                onClick={toggleAddMenu}
                className="p-1 rounded text-gray-400 hover:text-white hover:bg-gray-800"
                title="新建标签"
                aria-label="新建标签"
                aria-expanded={showAddMenu}
              >
                <Plus size={14} />
              </button>
              <button
                onClick={() => void openFusionWindow()}
                className="ml-1 p-1 rounded text-gray-500 hover:text-purple-300 hover:bg-gray-800"
                title="打开独立 Fusion 融合对话窗口"
                aria-label="打开独立 Fusion 融合对话窗口"
              >
                <ExternalLink size={13} />
              </button>
              <button
                data-electron-web-host=""
                onClick={() => {
                  const desktop = getDesktop();
                  const tab = centerTabs.find(item => item.id === activeCenterTab);
                  if (desktop && tab?.kind === 'web') {
                    if (typeof desktop.openWebProjectWizard !== 'function') {
                      alert('网页项目向导需要重启桌面应用后使用。');
                      return;
                    }
                    void desktop.openWebProjectWizard(tab.id).then(result => {
                      if (!result.ok) alert(result.error || '无法打开网页项目向导');
                    }).catch(error => alert(String(error?.message || error)));
                    return;
                  }
                  setShowProjectRunner(true);
                }}
                disabled={!activeProvider && centerTabs.find(item => item.id === activeCenterTab)?.kind !== 'web'}
                className="ml-1 p-1 rounded text-gray-500 hover:text-emerald-300 hover:bg-gray-800 disabled:opacity-30 disabled:cursor-not-allowed"
                title="项目运行向导：选择环境和语言，生成、编译、运行并自动修复工程"
                aria-label="项目运行向导"
              >
                <Hammer size={13} />
              </button>
            </div>
            <div className="ml-auto flex items-center gap-1 shrink-0">
              <button onClick={()=>setShowKnowledge(true)} className="px-2 py-1 text-xs text-emerald-300 hover:bg-gray-700 rounded" aria-label="本地知识管理">本地知识</button>
              <button
                onClick={() => {
                  setFilesPanelOpen(current => {
                    const next = !current;
                    if (next && fileManagerDir) {
                      setFilesPanelCwd(fileManagerDir);
                      setFilesPanelNav({ dir: fileManagerDir, nonce: Date.now() });
                    }
                    return next;
                  });
                }}
                className={`p-1 rounded hover:bg-gray-800 ${filesPanelOpen ? 'text-sky-400' : 'text-gray-400 hover:text-white'}`}
                title={filesPanelOpen ? '隐藏文件管理器' : '显示文件管理器'}
              >
                <FolderTree size={15} />
              </button>
              <button
                onClick={() => setRightPanelOpen(v => !v)}
                className={`p-1 rounded hover:bg-gray-800 ${rightPanelOpen ? 'text-purple-400' : 'text-gray-400 hover:text-white'}`}
                title={rightPanelOpen ? '隐藏命令面板' : '显示命令/Skill/自动面板'}
              >
                {rightPanelOpen ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}
              </button>
            </div>
          </div>

          {/* 中部 Tab 内容 */}
          <div className="flex-1 min-h-0 relative">
            {/* Provider 对话（保持挂载以保留状态） */}
            <div className={`absolute inset-0 flex flex-col ${activeCenterTab === 'provider' ? '' : 'hidden'}`}>
              <ChatArea
                conversation={activeConversation}
                provider={activeProvider}
                onSendMessage={handleSendMessage}
                isLoading={isLoading}
                localKnowledgeEnabled={settings?.local_knowledge?.enabled}
                knowledgeProgress={knowledgeProgress}
                onOpenKnowledge={()=>setShowKnowledge(true)}
                onOpenContentLibrary={openContentLibrary}
                onOpenCitation={openKnowledgeCitation}
                streamingContent={streamingContent}
                injectedInput={injectedForInput?.content ?? null}
                injectedAttachments={injectedForInput?.attachments}
                onInjectedInputConsumed={() => setInjectedForInput(null)}
                onResend={handleResend}
                onEditUserMessage={handleEditUserMessage}
                onLikeMessage={handleLikeMessage}
                pluginEnabled={pluginEnabled}
                onPluginEnabledChange={setPluginEnabled}
                onPluginRun={handlePluginRun}
                onPluginChat={handlePluginChat}
                onPluginReloadCode={handlePluginReloadCode}
                onOpenSettings={() => {setSettingsInitialTab('model');setShowSettings(true);}}
                isBusy={isLoading || pluginActionBusy}
                onStop={handleStop}
                autoRouteEnabled={autoRouteEnabled}
                onAutoRouteEnabledChange={setAutoRouteEnabled}
                agentRequest={agentRequest}
                onAgentRequestConsumed={() => setAgentRequest(null)}
                webChatTargets={webChatTargets}
                webChatAggregator={webChatAggregatorInfo}
                onWebChatSelectionChange={handleWebChatSelectionChange}
                onOpenWebChatSite={openWebTab}
                onOpenUrl={openWebTab}
              />
            </div>

            {/* Claude Code 标签页（各自保持挂载，保留 WS 会话） */}
            {centerTabs.filter(t => t.kind === 'claude').map(tab => (
              <div key={tab.id} className={`absolute inset-0 ${activeCenterTab === tab.id ? '' : 'hidden'}`}>
                {claudeMeta.available ? (
                  <ClaudeChat
                    active={activeCenterTab === tab.id}
                    defaultCwd={claudeMeta.defaultCwd}
                    repoDir={claudeMeta.repoDir}
                    onOpenUrl={openWebTab}
                    tabId={tab.id}
                    onSessionInfo={handleSessionInfo}
                    onCwdChange={handleClaudeCwdChange}
                    injected={claudeInject && claudeInject.tabId === tab.id ? claudeInject : null}
                    onInjectedConsumed={() => setClaudeInject(null)}
                    autoRules={autoRules}
                    autoRulesEnabled={autoRulesEnabled}
                    onRuleConsumed={handleRuleConsumed}
                    provider={activeProviderPayload}
                  />
                ) : (
                  <div className="h-full flex flex-col items-center justify-center text-gray-400 text-sm gap-2 p-8 text-center">
                    <Sparkles size={28} className="text-purple-400" />
                    <div>Claude Code 后端不可用。</div>
                    <div className="text-xs text-gray-500">请确认已安装 <code className="bg-gray-800 px-1 rounded">claude</code> CLI，且后端启用了 flask-sock(WebSocket)。</div>
                  </div>
                )}
              </div>
            ))}

            {/* Hermes 结构化对话标签页 */}
            {centerTabs.filter(t => t.kind === 'hermes').map(tab => (
              <div key={tab.id} className={`absolute inset-0 ${activeCenterTab === tab.id ? '' : 'hidden'}`}>
                {hermesMeta.available ? (
                  <HermesChat
                    active={activeCenterTab === tab.id}
                    defaultCwd={hermesMeta.defaultCwd}
                    repoDir={hermesMeta.repoDir}
                    tabId={tab.id}
                    onSessionInfo={handleHermesSessionInfo}
                    onCwdChange={handleClaudeCwdChange}
                    injected={hermesInject && hermesInject.tabId === tab.id ? hermesInject : null}
                    onInjectedConsumed={() => setHermesInject(null)}
                    autoRules={autoRules}
                    autoRulesEnabled={autoRulesEnabled}
                    onRuleConsumed={handleRuleConsumed}
                    provider={activeProviderPayload}
                    onOpenUrl={openWebTab}
                  />
                ) : (
                  <div className="h-full flex flex-col items-center justify-center text-gray-400 text-sm gap-2 p-8 text-center">
                    <Bot size={28} className="text-amber-400" />
                    <div>Hermes Agent 后端不可用。</div>
                    {!hermesMeta.cli && (
                      <div className="text-xs text-gray-500">未检测到 <code className="bg-gray-800 px-1 rounded">hermes</code> CLI。请执行 <code className="bg-gray-800 px-1 rounded">./run.sh tools</code> 或 <code className="bg-gray-800 px-1 rounded">pip install hermes-agent</code></div>
                    )}
                    {hermesMeta.cli && !hermesMeta.ws && (
                      <div className="text-xs text-gray-500">缺少 <code className="bg-gray-800 px-1 rounded">flask-sock</code>。请在项目目录执行 <code className="bg-gray-800 px-1 rounded">pip install flask-sock</code> 后重启 <code className="bg-gray-800 px-1 rounded">./run.sh</code></div>
                    )}
                    {hermesMeta.cli && hermesMeta.ws && (
                      <div className="text-xs text-gray-500">请刷新页面或重启后端服务。</div>
                    )}
                  </div>
                )}
              </div>
            ))}

            {/* 文件查看标签页（SP3） */}
            {centerTabs.filter(t => t.kind === 'file').map(tab => (
              <div key={tab.id} className={`absolute inset-0 ${activeCenterTab === tab.id ? '' : 'hidden'}`}>
                <FileViewer path={tab.path || ''} active={activeCenterTab === tab.id} onOpenUrl={openWebTab} />
              </div>
            ))}

            {/* Provider 来源等内嵌网页标签页 */}
            {centerTabs.filter(t => t.kind === 'web').map(tab => (
              <div key={tab.id} className={`absolute inset-0 ${activeCenterTab === tab.id ? '' : 'hidden'}`}>
                <WebViewer
                  tabId={tab.id}
                  url={tab.url || ''}
                  title={tab.title}
                  active={activeCenterTab === tab.id}
                  selectionRequest={webSelectionRequest?.id === tab.id ? webSelectionRequest : null}
                  onTitleChange={(title) => setCenterTabs(previous => previous.map(item =>
                    item.id === tab.id && title.trim() ? { ...item, title: title.trim() } : item
                  ))}
                  onOpenUrl={openWebTab}
                  providers={state.providers}
                  defaultProviderId={activeProvider?.id || null}
                  onSavePage={saveWebPage}
                  onUrlChange={(url) => setCenterTabs(previous => previous.map(item =>
                    item.id === tab.id ? { ...item, url } : item
                  ))}
                />
              </div>
            ))}

            {/* 交互式终端标签页（PTY 原生 claude，保持挂载保留会话） */}
            {centerTabs.filter(t => t.kind === 'claude-term').map(tab => (
              <div key={tab.id} className={`absolute inset-0 ${activeCenterTab === tab.id ? '' : 'hidden'}`}>
                {claudeMeta.available ? (
                    <ClaudeTerminal
                    active={activeCenterTab === tab.id}
                    defaultCwd={claudeMeta.defaultCwd}
                    repoDir={claudeMeta.repoDir}
                    onOpenUrl={openWebTab}
                    onOpenPath={openDesktopAgentPath}
                    tabId={tab.id}
                    onCwdChange={handleClaudeCwdChange}
                    injected={termInject && termInject.tabId === tab.id ? termInject : null}
                    onInjectedConsumed={() => setTermInject(null)}
                    provider={activeProvider ? {
                      name: activeProvider.name,
                      baseUrl: activeProvider.baseUrl,
                      apiKey: activeProvider.apiKey,
                      model: activeProvider.selectedModel,
                      apiType: activeProvider.apiType,
                    } : null}
                    providerOptions={state.providers.map(p => ({
                      id: p.id,
                      name: p.name,
                      baseUrl: p.baseUrl,
                      apiKey: p.apiKey,
                      apiType: p.apiType,
                      models: p.models,
                      selectedModel: p.selectedModel,
                    }))}
                  />
                ) : (
                  <div className="h-full flex flex-col items-center justify-center text-gray-400 text-sm gap-2 p-8 text-center">
                    <TerminalIcon size={28} className="text-purple-400" />
                    <div>Claude Code 后端不可用。</div>
                    <div className="text-xs text-gray-500">请确认已安装 <code className="bg-gray-800 px-1 rounded">claude</code> CLI,且后端启用了 flask-sock(WebSocket)。</div>
                  </div>
                )}
              </div>
            ))}

            {/* Hermes 交互式终端标签页 */}
            {centerTabs.filter(t => t.kind === 'hermes-term').map(tab => (
              <div key={tab.id} className={`absolute inset-0 ${activeCenterTab === tab.id ? '' : 'hidden'}`}>
                {hermesMeta.available ? (
                  <HermesTerminal
                    active={activeCenterTab === tab.id}
                    defaultCwd={hermesMeta.defaultCwd}
                    repoDir={hermesMeta.repoDir}
                    onOpenUrl={openWebTab}
                    onOpenPath={openDesktopAgentPath}
                    tabId={tab.id}
                    onCwdChange={handleClaudeCwdChange}
                    injected={hermesTermInject && hermesTermInject.tabId === tab.id ? hermesTermInject : null}
                    onInjectedConsumed={() => setHermesTermInject(null)}
                    provider={activeProviderPayload}
                  />
                ) : (
                  <div className="h-full flex flex-col items-center justify-center text-gray-400 text-sm gap-2 p-8 text-center">
                    <TerminalIcon size={28} className="text-amber-400" />
                    <div>Hermes Agent 后端不可用。</div>
                    {!hermesMeta.cli && (
                      <div className="text-xs text-gray-500">未检测到 <code className="bg-gray-800 px-1 rounded">hermes</code> CLI。请执行 <code className="bg-gray-800 px-1 rounded">./run.sh tools</code> 或 <code className="bg-gray-800 px-1 rounded">pip install hermes-agent</code></div>
                    )}
                    {hermesMeta.cli && !hermesMeta.ws && (
                      <div className="text-xs text-gray-500">缺少 <code className="bg-gray-800 px-1 rounded">flask-sock</code>。请在项目目录执行 <code className="bg-gray-800 px-1 rounded">pip install flask-sock</code> 后重启 <code className="bg-gray-800 px-1 rounded">./run.sh</code></div>
                    )}
                    {hermesMeta.cli && hermesMeta.ws && (
                      <div className="text-xs text-gray-500">请刷新页面或重启后端服务。</div>
                    )}
                  </div>
                )}
              </div>
            ))}

            {/* Desktop Agent 标签页：控制台本身留在 React 工作台，实际 Agent
                进程由 Electron 在独立终端启动。 */}
            {centerTabs.filter(t => t.kind === 'desktop-agent').map(tab => (
              <div key={tab.id} className={`absolute inset-0 ${activeCenterTab === tab.id ? '' : 'hidden'}`}>
                <DesktopAgentPanel onOpenPath={openDesktopAgentPath} onOpenUrl={openWebTab} defaultProvider={defaultProvider} />
              </div>
            ))}

            {centerTabs.filter(t => t.kind === 'codex-term').map(tab => (
              <div key={tab.id} className={`absolute inset-0 ${activeCenterTab === tab.id ? '' : 'hidden'}`}>
                <CodexTerminalPanel
                  tabId={tab.id}
                  defaultCwd={claudeMeta.defaultCwd || hermesMeta.defaultCwd || ''}
                  onCwdChange={handleClaudeCwdChange}
                  onOpenPath={openDesktopAgentPath}
                  onOpenUrl={openWebTab}
                />
              </div>
            ))}
          </div>
        </div>

        {/* 右侧命令 / Skill / 自动面板（SP4/5/6，可折叠） */}
        {rightPanelOpen && (
          <div className="w-80 shrink-0">
            <WorkbenchPanel
              activeClaudeTabId={isAgentWorkbenchTab ? activeCenterTab : null}
              variant={workbenchVariant}
              commands={workbenchCommands}
              skills={workbenchSkills}
              onInsert={handleWorkbenchInsert}
              rules={autoRules}
              rulesEnabled={autoRulesEnabled}
              onRulesChange={setAutoRules}
              onRulesEnabledChange={setAutoRulesEnabled}
            />
          </div>
        )}
      </div>

      {/* 新建标签下拉（fixed，避免被 Tab 栏 overflow 裁剪 / 被内容遮挡） */}
      {showAddMenu && addMenuPos && (
        <div
          className="fixed w-52 bg-gray-800 border border-gray-600 rounded-lg shadow-xl z-[60] py-1 text-xs"
          style={{ left: addMenuPos.left, top: addMenuPos.top }}
        >
          <div className="relative group">
          <button
            onMouseDown={(e) => { e.preventDefault(); addBrowserTab(); }}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-gray-200 hover:bg-gray-700"
            >
              <Globe size={13} className="text-amber-400" />
              <span className="flex-1">浏览器网页</span>
              <ChevronRight size={12} className="text-gray-500" />
            </button>
            <div className="invisible opacity-0 group-hover:visible group-hover:opacity-100 absolute left-full top-0 w-72 max-h-[70vh] overflow-y-auto bg-gray-800 border border-gray-600 rounded-lg shadow-xl py-1 transition-opacity">
              <button
                onMouseDown={(e) => { e.preventDefault(); addBrowserTab(); }}
                className="w-full flex items-center gap-2 px-3 py-2 text-left text-gray-200 hover:bg-gray-700"
              >
                <Plus size={13} className="text-amber-400" /> 新建浏览器网页
              </button>
              <div className="my-1 border-t border-gray-700" />
              <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-gray-500">
                常用模型聊天网页（默认地址）
              </div>
              <div className="max-h-64 overflow-y-auto">
                {DEFAULT_MODEL_CHAT_SITES.map(site => (
                  <button
                    key={site.id}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      openWebTab(site.url, site.name);
                      setShowAddMenu(false);
                    }}
                    className="w-full px-3 py-2 text-left hover:bg-gray-700"
                    title={site.url}
                  >
                    <div className="truncate text-gray-200">{site.name}</div>
                    <div className="truncate text-[10px] font-mono text-gray-500">{site.url}</div>
                  </button>
                ))}
              </div>
              <div className="my-1 border-t border-gray-700" />
              <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-gray-500">
                已保存网页（{savedWebPages.length}）
              </div>
              <div className="max-h-72 overflow-y-auto">
                {savedWebPages.length === 0 ? (
                  <div className="px-3 py-3 text-xs text-gray-500">暂无保存网页</div>
                ) : savedWebPages.map(page => (
                  <div key={page.id} className="flex items-center hover:bg-gray-700">
                    <button
                      onMouseDown={(e) => {
                        e.preventDefault();
                        openWebTab(page.url, page.title);
                        setShowAddMenu(false);
                      }}
                      className="flex-1 min-w-0 px-3 py-2 text-left"
                      title={page.url}
                    >
                      <div className="truncate text-gray-200">{page.title}</div>
                      <div className="truncate text-[10px] font-mono text-gray-500">{page.url}</div>
                    </button>
                    <button
                      onMouseDown={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        deleteSavedWebPage(page.id);
                      }}
                      className="mr-2 p-1.5 rounded text-gray-500 hover:text-red-400 hover:bg-gray-800"
                      title="删除保存状态"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div className="my-1 border-t border-gray-700" />
          <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-gray-500">MultiLLM Fusion</div>
          <button
            onMouseDown={(e) => { e.preventDefault(); addDesktopAgentTab(); }}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-gray-200 hover:bg-gray-700"
          >
            <Bot size={13} className="text-amber-300" /> Desktop Agent（标签页）
          </button>
          <button
            onMouseDown={(e) => { e.preventDefault(); void openFusionWindow(); setShowAddMenu(false); }}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-gray-200 hover:bg-gray-700"
            title="仅以独立 Electron 窗口打开"
          >
            <ExternalLink size={13} className="text-purple-300" /> 融合对话（独立窗口）
          </button>
          <div className="my-1 border-t border-gray-700" />
          <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-gray-500">Claude Code</div>
          <button
            onMouseDown={(e) => { e.preventDefault(); addClaudeTab(); setShowAddMenu(false); }}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-gray-200 hover:bg-gray-700"
          >
            <Sparkles size={13} className="text-purple-400" /> 结构化对话
          </button>
          <button
            onMouseDown={(e) => { e.preventDefault(); addClaudeTermTab(); setShowAddMenu(false); }}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-gray-200 hover:bg-gray-700"
          >
            <TerminalIcon size={13} className="text-purple-300" /> 交互式终端
          </button>
          <div className="my-1 border-t border-gray-700" />
          <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-gray-500">Hermes</div>
          <button
            onMouseDown={(e) => { e.preventDefault(); addHermesTab(); setShowAddMenu(false); }}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-gray-200 hover:bg-gray-700"
          >
            <Bot size={13} className="text-amber-400" /> 结构化对话
          </button>
          <button
            onMouseDown={(e) => { e.preventDefault(); addHermesTermTab(); setShowAddMenu(false); }}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-gray-200 hover:bg-gray-700"
          >
            <TerminalIcon size={13} className="text-amber-300" /> 交互式终端
          </button>
          <div className="my-1 border-t border-gray-700" />
          <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-gray-500">Codex</div>
          <button
            onMouseDown={(e) => { e.preventDefault(); addCodexTermTab(); }}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-gray-200 hover:bg-gray-700"
          >
            <TerminalIcon size={13} className="text-cyan-300" /> Codex 虚拟终端
          </button>
        </div>
      )}

      {/* Terminal Panel（支持多标签，每个标签独立 shell） */}
      <TerminalDock visible={terminalVisible} onClose={() => setTerminalVisible(false)} onSendToChat={(text) => setInjectedForInput({ content: text })} onOpenPath={openDesktopAgentPath} onOpenUrl={openWebTab} />

      {showConfigModal && (
        <ConfigModal
          provider={editingProvider}
          onSave={handleSaveProvider}
          onClose={() => { setShowConfigModal(false); setEditingProvider(null); }}
        />
      )}

      <LocalHubModal
        visible={showLocalHub}
        onClose={() => setShowLocalHub(false)}
        onAddLocalProvider={handleAddLocalProvider}
      />

      <SettingsModal
        visible={showSettings}
        initialTab={settingsInitialTab}
        onClose={() => setShowSettings(false)}
        onSaved={(s) => setSettings(s)}
      />

      {contentLibraryRequest && <ContentLibraryPanel initialQuery={contentLibraryRequest.query} initialEntryId={contentLibraryRequest.entryId} onClose={closeContentLibrary} />}
      {showKnowledge&&<div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-6"><div role="dialog" aria-label="本地资料管理" className="w-full max-w-4xl max-h-[90vh] overflow-auto bg-gray-900 border border-gray-700 rounded-xl p-5">
        <div className="flex items-center gap-3 mb-4 text-white"><h2 className="flex-1">本地资料管理</h2><button className="text-xs text-emerald-300" onClick={()=>{setShowKnowledge(false);setSettingsInitialTab('knowledge');setShowSettings(true);}}>连接设置</button><button aria-label="关闭资料管理" onClick={()=>setShowKnowledge(false)}>关闭</button></div>
        <KnowledgePanel onOpenCitation={openKnowledgeCitation}/>
      </div></div>}
      {knowledgeCitation&&<div className="fixed inset-0 z-[60] bg-black/70 flex items-center justify-center p-6"><div role="dialog" aria-label="查看引用来源" className="max-w-4xl w-full max-h-[90vh] overflow-auto rounded-xl border border-gray-700 bg-gray-900 p-5">
        <div className="flex mb-4 text-white"><h2 className="flex-1">{knowledgeCitation.title}</h2><button aria-label="关闭引用来源" onClick={()=>setKnowledgeCitation(null)}>关闭</button></div>
        <KnowledgeSourceViewer sourceId={knowledgeCitation.source_id} revision={knowledgeCitation.revision} position={knowledgeCitation.position}/>
      </div></div>}
      {knowledgeJobNotice&&<div role="status" className="fixed right-5 bottom-5 z-[120] max-w-sm rounded-lg border border-emerald-700 bg-gray-900 px-4 py-3 text-sm text-emerald-200 shadow-xl">{knowledgeJobNotice}</div>}

      <AgentDialog
        visible={showProjectRunner}
        provider={activeProvider}
        mode="project"
        initialGoal=""
        onInsertPrompt={(prompt) => setInjectedForInput({ content: prompt })}
        onClose={() => setShowProjectRunner(false)}
      />
    </div>
  );
}
