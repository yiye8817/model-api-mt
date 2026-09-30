export type DesktopBounds = { x: number; y: number; width: number; height: number };
export type WebTranslationMode = 'replace' | 'bilingual';
export type WebTranslationSegment = { id: string; text: string };
export type WebTranslation = { id: string; translation: string };
export type WebSelectionTranslateEvent = { id: string; text: string };

export type WebChatSite = 'deepseek' | 'qwen' | 'chatgpt' | 'claude' | 'gemini' | 'grok' | 'poe' | 'generic';

export interface WebChatTarget {
  id: string;
  title: string;
  url: string;
  site: WebChatSite;
}

export interface WebChatProgressEvent {
  id: string;
  event: string;
  message: string;
  timestamp: number;
  details?: Record<string, unknown>;
}

export interface WebChatResult {
  ok: boolean;
  site?: WebChatSite;
  title?: string;
  model?: string;
  url?: string;
  content?: string;
  error?: string;
  warning?: string;
  partial?: boolean;
  durationMs?: number;
  dumpPath?: string;
  pagePath?: string;
  pageSaveError?: string;
  progressEvents?: WebChatProgressEvent[];
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
  diagnostics?: {
    candidateCount?: number;
    busySignals?: string[];
    settleMs?: number;
    copyReady?: boolean | null;
    timedOut?: boolean;
  };
}

export interface DesktopBridge {
  isDesktop: true;
  ping: () => Promise<{ ok: boolean; isDesktop: boolean }>;
  openWeb: (id: string, url: string, bounds?: DesktopBounds) => Promise<{ ok: boolean; error?: string }>;
  focusWeb: (id: string, bounds?: DesktopBounds) => Promise<{ ok: boolean }>;
  hideWeb: () => Promise<{ ok: boolean }>;
  closeWeb: (id: string) => Promise<{ ok: boolean }>;
  setBounds: (id: string, bounds: DesktopBounds) => Promise<{ ok: boolean }>;
  reloadWeb: (id: string) => Promise<{ ok: boolean }>;
  goBackWeb: (id: string) => Promise<{ ok: boolean }>;
  goForwardWeb: (id: string) => Promise<{ ok: boolean }>;
  getWebState: (id: string) => Promise<{ ok: boolean; url?: string; title?: string; loading?: boolean; canGoBack?: boolean; canGoForward?: boolean }>;
  /** Extract readable text from the currently loaded WebContentsView document. */
  extractWebContent: (id: string) => Promise<{ ok: boolean; url?: string; title?: string; text?: string; error?: string }>;
  /** Extract translatable block elements while keeping their DOM ids. */
  extractWebSegments: (id: string) => Promise<{ ok: boolean; title?: string; segments?: WebTranslationSegment[]; error?: string }>;
  /** Apply model translations to the loaded page DOM. */
  applyWebTranslations: (id: string, mode: WebTranslationMode, translations: WebTranslation[]) => Promise<{ ok: boolean; applied?: number; error?: string }>;
  webChat: (id: string, prompt: string, timeoutMs?: number) => Promise<WebChatResult>;
  /** Open the project wizard inside the native page without hiding it. */
  openWebProjectWizard: (id: string) => Promise<{ ok: boolean; error?: string }>;
  onWebChatProgress: (callback: (event: WebChatProgressEvent) => void) => () => void;
  onWebLink: (callback: (event: { id: string; url: string }) => void) => () => void;
  onWebSelectionTranslate: (callback: (event: WebSelectionTranslateEvent) => void) => () => void;
  newWebChat: (id: string) => Promise<{ ok: boolean; site?: WebChatSite; method?: 'button' | 'navigate'; url?: string; error?: string }>;
  openExternal: (url: string) => Promise<{ ok: boolean }>;
  /** Open an HTTP URL in the default browser or a local path in its default app/file manager. */
  openTarget: (payload: { target: string; cwd?: string }) => Promise<{ ok: boolean; kind?: 'url' | 'path'; target?: string; error?: string }>;
  /** Launch the vendored MultiLLM Fusion app in its own Electron window. */
  openFusion: () => Promise<{ ok: boolean; alreadyRunning?: boolean; port?: string; error?: string }>;
  /** Start only the Fusion API backend for the embedded Desktop Agent tab. */
  ensureFusion: () => Promise<{ ok: boolean; alreadyRunning?: boolean; port?: string; error?: string }>;
  fusionStatus: () => Promise<{ ok: boolean; running: boolean; port: string }>;
  /** Run the vendored Desktop Agent in a native terminal. */
  launchAgent: (payload: {
    mode?: 'chat' | 'run' | 'help';
    task?: string;
    workspace?: string;
    model?: string;
    allow?: string[];
  }) => Promise<{ ok: boolean; terminal?: string; mode?: string; fusionPort?: string; error?: string }>;
}

declare global {
  interface Window {
    desktop?: DesktopBridge;
  }
}

export function getDesktop(): DesktopBridge | null {
  return typeof window !== 'undefined' && window.desktop?.isDesktop ? window.desktop : null;
}

export function isDesktopApp(): boolean {
  return !!getDesktop();
}


/** 识别支持网页群聊的 AI 站点；普通网页返回 null，不会出现在选择列表。 */
export function detectWebChatSite(url: string): WebChatSite | null {
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch { return null; }
  if (host === 'chat.deepseek.com' || host.endsWith('.deepseek.com')) return 'deepseek';
  if (host === 'chat.qwen.ai' || host.endsWith('.qwen.ai') || host === 'tongyi.aliyun.com') return 'qwen';
  if (host === 'chatgpt.com' || host === 'chat.openai.com') return 'chatgpt';
  if (host === 'claude.ai' || host.endsWith('.claude.ai')) return 'claude';
  if (host === 'gemini.google.com') return 'gemini';
  if (host === 'grok.com' || host.endsWith('.grok.com')) return 'grok';
  if (host === 'poe.com' || host.endsWith('.poe.com')) return 'poe';
  return null;
}

/** 将元素的视口矩形转为 WebContentsView 所需的窗口客户区坐标。 */
export function boundsFromElement(el: HTMLElement | null): DesktopBounds | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return null;
  return {
    x: Math.round(r.left),
    y: Math.round(r.top),
    width: Math.round(r.width),
    height: Math.round(r.height),
  };
}

/** 网页内容区标记：点击此区域外的 UI（标签栏/侧栏/菜单）时卸下 WebContentsView。 */
export const ELECTRON_WEB_HOST_ATTR = 'data-electron-web-host';

let overlayDepth = 0;
type OverlayListener = (depth: number) => void;
const overlayListeners = new Set<OverlayListener>();

function emitOverlay() {
  for (const fn of overlayListeners) {
    try { fn(overlayDepth); } catch { /* noop */ }
  }
}

/** 弹层/菜单打开时调用：隐藏 WebContentsView，避免挡住 React 浮层。 */
export function acquireDesktopOverlay(): void {
  overlayDepth += 1;
  void getDesktop()?.hideWeb();
  emitOverlay();
}

/** 弹层/菜单关闭时调用。 */
export function releaseDesktopOverlay(): void {
  overlayDepth = Math.max(0, overlayDepth - 1);
  emitOverlay();
}

export function getDesktopOverlayDepth(): number {
  return overlayDepth;
}

export function subscribeDesktopOverlay(fn: OverlayListener): () => void {
  overlayListeners.add(fn);
  return () => { overlayListeners.delete(fn); };
}

/**
 * 在 Electron 下：点击网页宿主以外的区域时立即 hide WebContentsView，
 * 这样标签栏「+」菜单、侧栏弹窗等不会被盖住。
 */
export function installDesktopChromeGuard(): () => void {
  const desktop = getDesktop();
  if (!desktop) return () => {};

  const onPointerDown = (e: PointerEvent) => {
    const t = e.target;
    if (!(t instanceof Element)) return;
    if (t.closest(`[${ELECTRON_WEB_HOST_ATTR}]`)) return;
    void desktop.hideWeb();
  };

  document.addEventListener('pointerdown', onPointerDown, true);
  return () => document.removeEventListener('pointerdown', onPointerDown, true);
}
