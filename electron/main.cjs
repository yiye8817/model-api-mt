/**
 * Electron 主进程：窗口加载现有 Flask/React UI，
 * Provider 来源等网页用 WebContentsView 顶层加载（不受 iframe XFO 限制）。
 */
const electron = require('electron');
const { app, BrowserWindow, WebContentsView, session, ipcMain, shell, Menu } = electron;
const path = require('path');
const os = require('os');
const { fileURLToPath } = require('url');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');
const { runWebChat, startNewWebChat } = require('./web-chat.cjs');

if (!app) {
  console.error(
    '[electron] app 不可用。请勿在 ELECTRON_RUN_AS_NODE=1 下直接运行。\n'
    + '  请使用: npm run electron   或   ./run.sh electron',
  );
  process.exit(1);
}

// Linux 某些 Mesa/虚拟显卡环境无法提供稳定的 VSync 参数，会反复输出
// GetVSyncParametersIfAvailable 错误。必须在 ready 之前关闭硬件加速。
// 如确认 GPU 驱动正常，可用 ELECTRON_DISABLE_GPU=0 恢复硬件加速。
if (process.platform === 'linux' && process.env.ELECTRON_DISABLE_GPU !== '0') {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu-compositing');
}

const ROOT = path.join(__dirname, '..');
const PORT = String(process.env.PORT || '8765');
const APP_URL = process.env.ELECTRON_APP_URL || `http://127.0.0.1:${PORT}`;
const START_SERVER = process.env.ELECTRON_START_SERVER !== '0';
// Fusion deliberately lives in its own process/window.  The existing Flask
// workbench remains on PORT; the vendored Fusion FastAPI bridge uses a
// separate port so the two APIs can coexist without recursive proxying.
const FUSION_PORT = String(process.env.FUSION_PORT || '8876');
const FUSION_ROOT = path.join(ROOT, 'multillm-fusion');
const FUSION_DATA_DIR = path.join(ROOT, '.multillm-fusion-data');
const FUSION_LAUNCHER = path.join(FUSION_ROOT, 'scripts', 'launch-electron.cjs');
const AGENT_ROOT = path.join(ROOT, 'desktop-agent');

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {Map<string, { view: WebContentsView, url: string, pendingUrl?: string, loadingUrl?: string, navigationSerial?: number, allowNavigation?: boolean, bounds?: { x: number, y: number, width: number, height: number } }>} */
const webTabs = new Map();
/** @type {string | null} */
let activeWebId = null;
/** @type {import('child_process').ChildProcess | null} */
let serverProc = null;
/** @type {import('child_process').ChildProcess | null} */
let fusionProc = null;
/** @type {import('child_process').ChildProcess | null} */
let fusionBackendProc = null;
let stopping = false;

function log(...args) {
  console.log('[electron]', ...args);
}

/**
 * Start one native page navigation and keep the requested URL visible while
 * Electron is still committing the document.  Reading webContents.getURL()
 * during that window returns the previous page, which used to overwrite a
 * freshly submitted address on the next renderer poll.
 */
function navigateWebEntry(entry, url) {
  const serial = (entry.navigationSerial || 0) + 1;
  entry.navigationSerial = serial;
  entry.url = url;
  entry.pendingUrl = url;
  entry.loadingUrl = url;
  entry.allowNavigation = true;
  entry.view.webContents.loadURL(url).catch(error => {
    if (serial === entry.navigationSerial && error?.code !== 'ERR_ABORTED') {
      log('网页加载失败:', error?.message || error);
    }
  }).finally(() => {
    if (serial !== entry.navigationSerial) return;
    entry.pendingUrl = '';
    entry.loadingUrl = '';
    entry.allowNavigation = false;
  });
}

function ensureFusionProcess() {
  if (fusionProc && !fusionProc.killed) return { ok: true, alreadyRunning: true, port: FUSION_PORT };
  if (!fs.existsSync(FUSION_LAUNCHER)) {
    return { ok: false, error: '项目内未找到 multillm-fusion/scripts/launch-electron.cjs' };
  }
  fs.mkdirSync(FUSION_DATA_DIR, { recursive: true, mode: 0o700 });
  const python = process.env.FUSION_PYTHON || path.join(ROOT, '.venv', 'bin', 'python');
  const env = {
    ...process.env,
    FUSION_PORT,
    FUSION_DATA_DIR,
    ...(fs.existsSync(python) ? { FUSION_PYTHON: python } : {}),
  };
  try {
    // The vendored launcher creates a normal child Electron window.  Passing
    // --no-sandbox mirrors this project's Linux launcher fallback and keeps
    // the Fusion window usable in development environments without setuid.
    fusionProc = spawn(process.env.NODE_BINARY || 'node',
      [FUSION_LAUNCHER, '--no-sandbox'], {
        cwd: FUSION_ROOT,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    fusionProc.stdout?.on('data', data => process.stdout.write(`[fusion] ${data}`));
    fusionProc.stderr?.on('data', data => process.stderr.write(`[fusion] ${data}`));
    fusionProc.on('exit', (code, signal) => {
      log('Fusion 窗口进程退出', code, signal || '');
      fusionProc = null;
    });
    return { ok: true, alreadyRunning: false, port: FUSION_PORT };
  } catch (error) {
    fusionProc = null;
    return { ok: false, error: String(error?.message || error) };
  }
}

// Desktop Agent needs the Fusion API, but opening its tab should not also
// open a second Fusion window. Start only the vendored FastAPI backend here;
// the explicit Fusion button continues to use ensureFusionProcess().
function ensureFusionBackend() {
  if (fusionProc && !fusionProc.killed) return { ok: true, alreadyRunning: true, port: FUSION_PORT };
  if (fusionBackendProc && !fusionBackendProc.killed) return { ok: true, alreadyRunning: true, port: FUSION_PORT };
  const backendDir = path.join(FUSION_ROOT, 'backend');
  if (!fs.existsSync(path.join(backendDir, 'app.py'))) {
    return { ok: false, error: '项目内未找到 multillm-fusion/backend/app.py' };
  }
  fs.mkdirSync(FUSION_DATA_DIR, { recursive: true, mode: 0o700 });
  const configuredPython = process.env.FUSION_PYTHON || path.join(ROOT, '.venv', 'bin', 'python');
  const python = fs.existsSync(configuredPython) ? configuredPython : 'python3';
  const env = { ...process.env, FUSION_PORT, FUSION_DATA_DIR };
  try {
    fusionBackendProc = spawn(python,
      ['-m', 'uvicorn', 'backend.app:app', '--host', '127.0.0.1', '--port', FUSION_PORT, '--no-access-log'],
      { cwd: FUSION_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    fusionBackendProc.stdout?.on('data', data => process.stdout.write(`[fusion-backend] ${data}`));
    fusionBackendProc.stderr?.on('data', data => process.stderr.write(`[fusion-backend] ${data}`));
    fusionBackendProc.on('error', error => log('Fusion 后端启动失败', error.message));
    fusionBackendProc.on('exit', (code, signal) => {
      log('Fusion 后端进程退出', code, signal || '');
      fusionBackendProc = null;
    });
    return { ok: true, alreadyRunning: false, port: FUSION_PORT };
  } catch (error) {
    fusionBackendProc = null;
    return { ok: false, error: String(error?.message || error) };
  }
}

function launchDesktopAgent(payload = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, error: 'Desktop Agent 参数无效。' };
  }
  const mode = payload.mode === 'run' ? 'run' : payload.mode === 'help' ? 'help' : 'chat';
  const task = typeof payload.task === 'string' ? payload.task.trim() : '';
  const workspace = typeof payload.workspace === 'string' ? payload.workspace.trim() : '';
  const model = typeof payload.model === 'string' ? payload.model.trim() : '';
  const allow = Array.isArray(payload.allow)
    ? [...new Set(payload.allow.filter(item => ['shell', 'browser', 'desktop'].includes(item)))]
    : [];
  if (mode === 'run' && !task) return { ok: false, error: '请提供 Desktop Agent 任务。' };
  if (task.length > 100000 || workspace.length > 4096 || /[\0\r\n]/.test(workspace)) {
    return { ok: false, error: 'Desktop Agent 参数过长或包含无效字符。' };
  }
  const script = path.join(AGENT_ROOT, 'run.sh');
  if (!fs.existsSync(script)) return { ok: false, error: '项目内未找到 desktop-agent/run.sh。' };
  const fusion = ensureFusionProcess();
  if (!fusion.ok) return fusion;
  const options = [
    '--base-url', `http://127.0.0.1:${FUSION_PORT}/v1`,
    ...(model ? ['--model', model] : []),
    ...(workspace ? ['--workspace', workspace] : []),
    ...(allow.length ? ['--allow', allow.join(',')] : []),
  ];
  const args = mode === 'help' ? ['--help'] : mode === 'run' ? ['run', task, ...options, '--verbose'] : ['chat', ...options];
  const env = { ...process.env, FUSION_PORT, FUSION_DATA_DIR };
  const candidates = [
    ['gnome-terminal', ['--working-directory', AGENT_ROOT, '--', 'bash', script, ...args]],
    ['konsole', ['--workdir', AGENT_ROOT, '-e', 'bash', script, ...args]],
    ['x-terminal-emulator', ['-e', 'bash', script, ...args]],
    ['xterm', ['-e', 'bash', script, ...args]],
  ];
  let lastError = null;
  for (const [terminal, terminalArgs] of candidates) {
    try { require('child_process').execFileSync('which', [terminal], { stdio: 'ignore' }); } catch { continue; }
    try {
      const child = spawn(terminal, terminalArgs, { cwd: AGENT_ROOT, detached: true, stdio: 'ignore', env });
      child.unref();
      return { ok: true, terminal, mode, fusionPort: FUSION_PORT };
    } catch (error) { lastError = error; }
  }
  return { ok: false, error: lastError ? `未能启动终端：${lastError.message}` : '未找到可用的终端模拟器，请手动运行 desktop-agent/run.sh。' };
}

function createWebChatProgressReporter(sender, id, events) {
  return (event, message, details = {}) => {
    const item = {
      id,
      event: String(event || 'progress'),
      message: String(message || event || '网页 AI 处理中'),
      timestamp: Date.now(),
      details: details && typeof details === 'object' ? details : {},
    };
    events.push(item);
    log('网页 AI 事件:', id, item.event, item.message, item.details);
    try {
      const eventDir = path.join(ROOT, 'logs');
      fs.mkdirSync(eventDir, { recursive: true });
      fs.appendFileSync(
        path.join(eventDir, 'web-chat-events.log'),
        JSON.stringify(item) + '\n',
        'utf8',
      );
    } catch (error) {
      log('网页 AI 事件日志写入失败:', String(error?.message || error));
    }
    try {
      if (sender && !sender.isDestroyed()) sender.send('desktop:web-chat-progress', item);
    } catch (error) {
      log('网页 AI 进度推送失败:', String(error?.message || error));
    }
  };
}

async function persistWebChatDump(id, result, webContents, report) {
  const pageDump = result?.pageDump;
  let dumpDir = '';
  let baseName = '';
  try {
    dumpDir = path.join(ROOT, 'logs', 'web-chat-dumps');
    fs.mkdirSync(dumpDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safeSite = String(result.site || 'web').replace(/[^a-z0-9_-]+/gi, '-');
    const safeId = String(id || 'tab').replace(/[^a-z0-9_-]+/gi, '-');
    baseName = `${stamp}-${safeSite}-${safeId}`;
  } catch (error) {
    report?.('page-save-failed', '无法创建网页存档目录', {
      error: String(error?.message || error),
    });
  }

  // 页面渲染结束后始终尝试保存 MHTML，即使 DOM dump 或复制节点校验失败。
  if (dumpDir && baseName && webContents && !webContents.isDestroyed()) {
    try {
      report?.('page-saving', '正在保存完整网页');
      const pageFile = path.join(dumpDir, `${baseName}.mhtml`);
      await webContents.savePage(pageFile, 'MHTML');
      result.pagePath = path.relative(ROOT, pageFile);
      const size = fs.statSync(pageFile).size;
      report?.('page-saved', '完整网页已保存', { path: result.pagePath, bytes: size });
    } catch (error) {
      result.pageSaveError = String(error?.message || error || '保存完整网页失败');
      report?.('page-save-failed', '完整网页保存失败', { error: result.pageSaveError });
    }
  } else if (!result.pageSaveError) {
    result.pageSaveError = '网页内容已销毁，无法保存完整页面';
    report?.('page-save-failed', '完整网页保存失败', { error: result.pageSaveError });
  }

  if (pageDump && dumpDir && baseName) {
    try {
      const dumpFile = path.join(dumpDir, `${baseName}.json`);
      fs.writeFileSync(dumpFile, JSON.stringify({
        result: {
          ok: result.ok,
          partial: result.partial,
          site: result.site,
          model: result.model,
          url: result.url,
          durationMs: result.durationMs,
          contentChars: String(result.content || '').length,
          warning: result.warning,
          error: result.error,
          extraction: result.extraction,
          validation: result.validation,
          diagnostics: result.diagnostics,
          progressEvents: result.progressEvents,
          pagePath: result.pagePath,
          pageSaveError: result.pageSaveError,
        },
        pageDump,
      }, null, 2), 'utf8');
      result.dumpPath = path.relative(ROOT, dumpFile);
      report?.('dump-saved', '节点校验 dump 已保存', { path: result.dumpPath });
    } catch (error) {
      report?.('dump-save-failed', '节点校验 dump 保存失败', {
        error: String(error?.message || error),
      });
    }
  }

  delete result.pageDump;
  return result;
}

function checkServer() {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${PORT}/api/settings`, (res) => {
      res.resume();
      resolve(res.statusCode && res.statusCode < 500);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1500, () => {
      req.destroy();
      resolve(false);
    });
  });
}

function postJsonToBackend(pathname, payload, timeoutMs = 130000) {
  const body = JSON.stringify(payload || {});
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port: Number(PORT),
      path: pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed = {};
        try { parsed = raw ? JSON.parse(raw) : {}; } catch { parsed = { output: raw }; }
        resolve({ statusCode: response.statusCode || 0, body: parsed });
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('本地代码执行超时')));
    request.on('error', reject);
    request.write(body);
    request.end();
  });
}

function waitForServer(timeoutMs = 90000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      if (await checkServer()) return resolve(true);
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`后端未在 ${timeoutMs}ms 内就绪 (${APP_URL})`));
      }
      setTimeout(tick, 500);
    };
    tick();
  });
}

function startBackend() {
  const runSh = path.join(ROOT, 'run.sh');
  log('启动后端:', runSh, `PORT=${PORT}`);
  serverProc = spawn('bash', [runSh, 'server', '-p', PORT], {
    cwd: ROOT,
    env: { ...process.env, PORT, HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProc.stdout?.on('data', (d) => process.stdout.write(`[server] ${d}`));
  serverProc.stderr?.on('data', (d) => process.stderr.write(`[server] ${d}`));
  serverProc.on('exit', (code) => {
    log('后端退出 code=', code);
    serverProc = null;
    if (!stopping && mainWindow && !mainWindow.isDestroyed()) {
      // 后端意外退出时不强制关窗，便于排查
    }
  });
}

function applyBounds(view, bounds) {
  if (!bounds) return null;
  const next = {
    x: Math.max(0, Math.round(bounds.x || 0)),
    y: Math.max(0, Math.round(bounds.y || 0)),
    width: Math.max(1, Math.round(bounds.width || 1)),
    height: Math.max(1, Math.round(bounds.height || 1)),
  };
  view.setBounds(next);
  // WebContentsView inherits setBounds from View, but unlike the old
  // BrowserView it does not provide setAutoResize.
  if (typeof view.setAutoResize === 'function') {
    view.setAutoResize({ width: false, height: false });
  }
  return next;
}

/**
 * WebContentsView 页面使用独立的 Chromium 渲染进程。部分聊天网页会通过
 * Clipboard API 处理粘贴，而不是依赖 Chromium 默认的 Ctrl+V 行为；
 * 允许剪贴板权限并保留一个原生输入兜底，确保应用外复制的文本也能
 * 粘贴到网页输入框中。
 */
function installWebClipboardSupport(contents) {
  if (!contents || contents.isDestroyed()) return;
  const clipboardPermission = permission => [
    'clipboard-read',
    'clipboard-sanitized-write',
    'deprecated-sync-clipboard-read',
  ].includes(permission);
  const ses = contents.session;
  ses.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(clipboardPermission(permission));
  });
  ses.setPermissionCheckHandler((_webContents, permission) => clipboardPermission(permission));
  contents.on('before-input-event', (event, input) => {
    const key = String(input?.key || '').toLowerCase();
    const modifier = process.platform === 'darwin' ? input?.meta : input?.control;
    if (input?.type !== 'keyDown' || !modifier || input?.alt) return;
    if (key === 'c') {
      event.preventDefault();
      try { contents.copy(); } catch { /* 页面刚好关闭时忽略 */ }
      return;
    }
    if (key === 'x') {
      event.preventDefault();
      try { contents.cut(); } catch { /* 页面刚好关闭时忽略 */ }
      return;
    }
    if (key !== 'v') return;
    let text = '';
    try { text = clipboard.readText(); } catch { return; }
    // 空剪贴板交给网页自己的处理逻辑（例如图片粘贴）。
    if (!text) return;
    event.preventDefault();
    try { contents.insertText(text); } catch { /* 页面刚好关闭时忽略 */ }
  });
}

function focusWeb(id, bounds, shouldFocus = true) {
  const entry = webTabs.get(id);
  if (!entry || !mainWindow || mainWindow.isDestroyed()) return { ok: false };
  activeWebId = id;
  try {
    for (const other of webTabs.values()) {
      if (other !== entry) {
        try { mainWindow.contentView.removeChildView(other.view); } catch { /* 已经卸下 */ }
      }
    }
    mainWindow.contentView.addChildView(entry.view);
    if (shouldFocus) entry.view.webContents.focus();
  } catch { /* noop */ }
  const applied = applyBounds(entry.view, bounds || entry.bounds);
  if (applied) entry.bounds = applied;
  return { ok: true };
}

function hideWeb() {
  activeWebId = null;
  if (!mainWindow || mainWindow.isDestroyed()) return { ok: true };
  // 从窗口卸下，避免盖住 React 弹窗；保留上次 bounds 以便恢复
  for (const entry of webTabs.values()) {
    try { mainWindow.contentView.removeChildView(entry.view); } catch { /* noop */ }
  }
  return { ok: true };
}

function closeWeb(id) {
  const entry = webTabs.get(id);
  if (!entry) return { ok: true };
  if (activeWebId === id) {
    hideWeb();
  }
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.contentView.removeChildView(entry.view);
    }
  } catch { /* noop */ }
  try {
    entry.view.webContents.destroy();
  } catch { /* noop */ }
  webTabs.delete(id);
  return { ok: true };
}

function isGoogleAuthUrl(value) {
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    const host = parsed.hostname.toLowerCase();
    if (host === 'accounts.google.com' || host.endsWith('.accounts.google.com')) return true;
    if (host === 'oauth.googleusercontent.com' || host === 'accounts.youtube.com') return true;
    return (host === 'google.com' || host === 'www.google.com')
      && /\/(accounts|signin|oauth)(?:\/|$)/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function isXOrTwitterUrl(value) {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === 'x.com' || host.endsWith('.x.com') || host === 'twitter.com' || host.endsWith('.twitter.com');
  } catch {
    return false;
  }
}

function shouldAllowOAuthNavigation(nextUrl, currentUrl) {
  // Keep the Google sign-in document in the same WebContentsView. X uses a
  // same-tab redirect for the callback, so allow the return to X/Twitter while
  // the current document is still an OAuth provider page.
  return isGoogleAuthUrl(nextUrl) || (isGoogleAuthUrl(currentUrl) && isXOrTwitterUrl(nextUrl));
}

async function cleanupWebPageArtifacts(view) {
  if (!view || view.webContents.isDestroyed()) return;
  try {
    await view.webContents.executeJavaScript(`(() => {
      const looksLikeNoScriptArtifact = value => {
        const text = String(value || '');
        return /msg-noscript|msg-title--noscript|您正在被重定向到/i.test(text)
          || (/<\\s*(meta|link|div|p|a)\\b/i.test(text) && /(noscript|refresh|msg-)/i.test(text));
      };
      document.querySelectorAll('noscript,.msg-noscript,.msg-title--noscript').forEach(node => node.remove());
      if (!document.body) return true;
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const matches = [];
      let node = walker.nextNode();
      while (node) {
        if (looksLikeNoScriptArtifact(node.nodeValue)) matches.push(node);
        node = walker.nextNode();
      }
      matches.forEach(textNode => {
        const parent = textNode.parentElement;
        if (parent && parent !== document.body && parent.textContent.length < 3000) parent.remove();
        else textNode.remove();
      });
      return true;
    })()`, true);
  } catch { /* 页面关闭或跨文档切换时忽略清理 */ }
}

function installWebLinkRouter(view) {
  if (!view || view.webContents.isDestroyed()) return;
  // Capture ordinary same-tab anchors as well as target=_blank anchors. The
  // latter still pass through setWindowOpenHandler; this listener also covers
  // SPA pages that otherwise change history without a navigation event.
  view.webContents.executeJavaScript(`(() => {
    if (window.__workbenchLinkRouterInstalled) return;
    window.__workbenchLinkRouterInstalled = true;
    document.addEventListener('click', event => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
      const href = anchor && anchor.href ? String(anchor.href) : '';
      if (!/^https?:\\/\\//i.test(href) || !anchor || anchor.hasAttribute('download')) return;
      try {
        const parsed = new URL(href);
        const host = parsed.hostname.toLowerCase();
        const isGoogleAuth = host === 'accounts.google.com'
          || host.endsWith('.accounts.google.com')
          || host === 'oauth.googleusercontent.com'
          || host === 'accounts.youtube.com'
          || ((host === 'google.com' || host === 'www.google.com') && /\\/(accounts|signin|oauth)(?:\\/|$)/i.test(parsed.pathname));
        if (isGoogleAuth) return;
      } catch { /* invalid links continue through the normal guard */ }
      event.preventDefault();
      window.open(href, '_blank', 'noopener,noreferrer');
    }, true);
  })()`, true).catch(() => {});
}

/**
 * 给原生网页中的 fenced code block 注入本地执行工具栏。
 * WebContentsView 不经过 React 的 MarkdownRenderer，因此必须在页面自身
 * 的 DOM 中添加按钮；真正的执行仍由本机 Flask runner 完成。
 */
function installWebCodeRunner(view) {
  if (!view || view.webContents.isDestroyed()) return;
  view.webContents.executeJavaScript(String.raw`(() => {
    const aliases = {
      python: 'python', py: 'python', python3: 'python',
      javascript: 'javascript', js: 'javascript', node: 'javascript',
      bash: 'bash', sh: 'bash', shell: 'bash', zsh: 'bash',
      c: 'c', cpp: 'cpp', 'c++': 'cpp', cxx: 'cpp',
      java: 'java', go: 'go', golang: 'go', rust: 'rust', rs: 'rust',
      ruby: 'ruby', rb: 'ruby', php: 'php', html: 'html', htm: 'html',
    };
    const compiled = new Set(['c', 'cpp', 'java', 'go', 'rust']);
    const normalize = value => {
      const raw = String(value || '').trim().toLowerCase().replace(/^language-/, '');
      return aliases[raw] || '';
    };
    const infer = (node, source) => {
      const candidates = [
        node.className,
        node.parentElement && node.parentElement.className,
        node.getAttribute('data-language'),
        node.parentElement && node.parentElement.getAttribute('data-language'),
        node.getAttribute('lang'),
      ].join(' ');
      const marked = candidates.match(/(?:language|lang)[-_ ]?([a-z0-9+#-]+)/i);
      const fromClass = normalize(marked ? marked[1] : candidates);
      if (fromClass) return fromClass;
      const code = String(source || '');
      if (/^#!.*\bpython(?:3)?\b/m.test(code) || /^(?:from\s+[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*\s+import|import\s+[A-Za-z_]\w*)/m.test(code) || /\bdef\s+[A-Za-z_]\w*\s*\([^)]*\)\s*:/m.test(code)) return 'python';
      if (/^#!.*\b(?:ba)?sh\b/m.test(code) || /\b(?:echo|printf)\s+.+\n/.test(code) && /\$[A-Za-z_{]/.test(code)) return 'bash';
      if (/\b(?:console\.log|const|let|var)\s+/.test(code)) return 'javascript';
      if (/<(?:!doctype\s+html|html|head|body)\b/i.test(code)) return 'html';
      if (/^\s*#include\s*[<"](?:iostream|vector|string|cstdio|cstdlib)/m.test(code)) return 'cpp';
      if (/^\s*#include\s*[<"](?:stdio|stdlib|string)\.h[>"]/m.test(code)) return 'c';
      if (/\bpublic\s+(?:final\s+|abstract\s+)?class\s+[A-Z]\w*/.test(code) && /\bstatic\s+void\s+main\s*\(/.test(code)) return 'java';
      if (/^\s*package\s+main\b/m.test(code) && /\bfunc\s+main\s*\(/.test(code)) return 'go';
      if (/\bfn\s+main\s*\(/.test(code) && /(?:println!|use\s+[A-Za-z_])/.test(code)) return 'rust';
      return '';
    };
    const button = (label, color) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.textContent = label;
      item.style.cssText = 'border:1px solid ' + color + ';border-radius:4px;background:rgba(15,23,42,.92);color:' + color + ';padding:3px 8px;margin:0 4px 0 0;font:12px ui-sans-serif,system-ui,sans-serif;cursor:pointer;';
      return item;
    };
    const setBusy = (card, busy) => {
      card.querySelectorAll('[data-workbench-code-action]').forEach(item => {
        item.disabled = !!busy;
        item.style.opacity = busy ? '.55' : '1';
      });
    };
    const showResult = (card, data, action) => {
      const output = card.querySelector('[data-workbench-code-output]');
      if (!output) return;
      const ok = !!data && data.ok !== false && (data.exit_code === undefined || data.exit_code === 0);
      const value = data && data.output ? String(data.output) : (data && data.error ? String(data.error) : '');
      output.style.display = 'block';
      output.style.borderColor = ok ? 'rgba(16,185,129,.45)' : 'rgba(244,63,94,.55)';
      output.style.color = ok ? '#a7f3d0' : '#fecdd3';
      if (ok && action === 'run' && card.__workbenchHtmlCode) {
        output.replaceChildren();
        const frame = document.createElement('iframe');
        frame.title = '本地 HTML 预览';
        frame.sandbox.add('allow-scripts');
        frame.style.cssText = 'display:block;width:100%;height:260px;border:0;background:white;';
        frame.srcdoc = card.__workbenchHtmlCode;
        output.appendChild(frame);
        setBusy(card, false);
        return;
      }
      output.textContent = value.trim() || (action === 'save'
        ? ('已保存：' + String(data && (data.file?.name || data.file?.path) || 'workspace'))
        : (ok ? '执行成功（无输出）' : '执行失败'));
      setBusy(card, false);
    };
    const request = (card, codeNode, action, compileOnly) => {
      const code = String(codeNode.textContent || '').replace(/\n$/, '');
      const language = infer(codeNode, code);
      const requestId = 'web-code-' + Date.now() + '-' + Math.random().toString(36).slice(2);
      const output = card.querySelector('[data-workbench-code-output]');
      card.__workbenchHtmlCode = language === 'html' && action === 'run' ? code : '';
      if (!language) {
        if (output) {
          output.style.display = 'block';
          output.style.color = '#fcd34d';
          output.textContent = '无法识别代码语言，请在代码块标注 language-python、language-bash 等语言。';
        }
        return;
      }
      if (output) {
        output.style.display = 'block';
        output.style.color = '#cbd5e1';
        output.style.borderColor = 'rgba(148,163,184,.35)';
        output.textContent = action === 'save' ? '正在保存到本地 workspace…' : (compileOnly ? '正在本地编译…' : '正在本地执行…');
      }
      setBusy(card, true);
      const bridge = window.__workbenchRunCode;
      if (!bridge || typeof bridge.request !== 'function') {
        showResult(card, { ok: false, error: '本地执行桥不可用，请重启桌面应用。' }, action);
        return;
      }
      bridge.request({ requestId, action, code, language, compileOnly: !!compileOnly })
        .then(result => showResult(card, result || { ok: false, error: '本地执行没有返回结果。' }, action))
        .catch(error => showResult(card, { ok: false, error: String(error?.message || error) }, action));
    };
    const scan = () => {
      document.querySelectorAll('pre code').forEach(codeNode => {
        const pre = codeNode.closest('pre');
        if (!pre || pre.getAttribute('data-workbench-code-pre') === '1') return;
        const source = String(codeNode.textContent || '');
        const language = infer(codeNode, source);
        if (!language) return;
        const parent = pre.parentElement;
        if (!parent) return;
        const card = document.createElement('div');
        card.setAttribute('data-workbench-code-card', '1');
        card.style.cssText = 'margin:8px 0;border:1px solid rgba(148,163,184,.35);border-radius:6px;overflow:hidden;';
        const toolbar = document.createElement('div');
        toolbar.style.cssText = 'display:flex;align-items:center;flex-wrap:wrap;gap:4px;padding:5px 8px;background:rgba(15,23,42,.94);font:12px ui-sans-serif,system-ui,sans-serif;';
        const label = document.createElement('span');
        label.textContent = '本地代码 · ' + language;
        label.style.cssText = 'color:#94a3b8;margin-right:6px;';
        toolbar.appendChild(label);
        const save = button('保存', '#cbd5e1');
        save.setAttribute('data-workbench-code-action', 'save');
        save.title = '保存代码到本地 workspace';
        save.addEventListener('click', () => request(card, codeNode, 'save', false));
        toolbar.appendChild(save);
        const run = button(language === 'html' ? '本地预览/运行' : '本地运行', '#86efac');
        run.setAttribute('data-workbench-code-action', 'run');
        run.title = '在本机运行此代码';
        run.addEventListener('click', () => request(card, codeNode, 'run', false));
        toolbar.appendChild(run);
        if (compiled.has(language)) {
          const compile = button('编译', '#67e8f9');
          compile.setAttribute('data-workbench-code-action', 'compile');
          compile.title = '只在本机编译，不执行';
          compile.addEventListener('click', () => request(card, codeNode, 'compile', true));
          toolbar.appendChild(compile);
        }
        const output = document.createElement('pre');
        output.setAttribute('data-workbench-code-output', '1');
        output.style.cssText = 'display:none;white-space:pre-wrap;max-height:260px;overflow:auto;margin:0;padding:8px;background:rgba(2,6,23,.96);border-top:1px solid rgba(148,163,184,.35);font:12px ui-monospace,SFMono-Regular,Menlo,monospace;';
        pre.setAttribute('data-workbench-code-pre', '1');
        parent.insertBefore(card, pre);
        card.appendChild(toolbar);
        card.appendChild(pre);
        card.appendChild(output);
      });
    };
    if (!window.__workbenchCodeRunnerObserver) {
      const observer = new MutationObserver(() => {
        if (window.__workbenchCodeRunnerScanTimer) return;
        window.__workbenchCodeRunnerScanTimer = setTimeout(() => {
          window.__workbenchCodeRunnerScanTimer = null;
          scan();
        }, 120);
      });
      observer.observe(document.documentElement || document, { childList: true, subtree: true });
      window.__workbenchCodeRunnerObserver = observer;
    }
    scan();
    return true;
  })()`, true).catch(() => {});
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 640,
    title: 'LLM Manager',
    backgroundColor: '#0b1120',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    for (const id of [...webTabs.keys()]) closeWeb(id);
    mainWindow = null;
  });

  log('加载 UI:', APP_URL);
  mainWindow.loadURL(APP_URL);
}

function registerIpc() {
  ipcMain.handle('desktop:ping', () => ({ ok: true, isDesktop: true }));

  ipcMain.handle('desktop:open-fusion', () => ensureFusionProcess());
  ipcMain.handle('desktop:ensure-fusion', () => ensureFusionBackend());
  ipcMain.handle('desktop:fusion-status', () => ({
    ok: true,
    running: (!!fusionProc && !fusionProc.killed) || (!!fusionBackendProc && !fusionBackendProc.killed),
    port: FUSION_PORT,
  }));
  ipcMain.handle('desktop:launch-agent', (_e, payload = {}) => launchDesktopAgent(payload));

  ipcMain.handle('desktop:run-web-code', async (event, payload = {}) => {
    const pageEntry = [...webTabs.values()].find(item => item.view?.webContents?.id === event.sender.id);
    if (!pageEntry) return { ok: false, error: '网页标签已关闭或本地执行桥无效' };
    const code = typeof payload.code === 'string' ? payload.code : '';
    if (!code.trim()) return { ok: false, error: '代码内容为空' };
    if (code.length > 500000) return { ok: false, error: '代码块过大，已拒绝执行' };
    const aliases = {
      python: 'python', py: 'python', python3: 'python',
      javascript: 'javascript', js: 'javascript', node: 'javascript',
      bash: 'bash', sh: 'bash', shell: 'shell', zsh: 'bash',
      c: 'c', cpp: 'cpp', 'c++': 'cpp', cxx: 'cpp', java: 'java',
      go: 'go', golang: 'go', rust: 'rust', rs: 'rust',
      ruby: 'ruby', rb: 'ruby', php: 'php', html: 'html', htm: 'html',
    };
    const language = aliases[String(payload.language || '').trim().toLowerCase()] || '';
    if (!language) return { ok: false, error: '不支持或无法识别的代码语言' };
    const action = payload.action === 'save' ? 'save' : (payload.action === 'compile' ? 'compile' : 'run');
    if (action === 'compile' && !new Set(['c', 'cpp', 'java', 'go', 'rust']).has(language)) {
      return { ok: false, error: `${language} 没有独立编译按钮，请直接运行` };
    }
    const endpoint = action === 'save' ? '/api/save-code' : '/api/run-code';
    const requestBody = action === 'save'
      ? { content: code, language }
      : { code, language, compileOnly: action === 'compile', timeoutSeconds: 120 };
    try {
      const response = await postJsonToBackend(endpoint, requestBody);
      const result = response.body && typeof response.body === 'object' ? response.body : {};
      const ok = response.statusCode >= 200 && response.statusCode < 300;
      return { ...result, ok, statusCode: response.statusCode };
    } catch (error) {
      return { ok: false, error: String(error?.message || error || '本地执行失败') };
    }
  });

  ipcMain.handle('desktop:open-web', (_e, payload = {}) => {
    const id = String(payload.id || '');
    const url = String(payload.url || '').trim();
    if (!id || !url || !mainWindow) return { ok: false, error: 'bad args' };

    let entry = webTabs.get(id);
    if (!entry) {
      const browserSession = session.fromPartition('persist:workbench-browser');
      const view = new WebContentsView({
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          preload: path.join(__dirname, 'webview-preload.cjs'),
          session: browserSession,
          // 多个后台 AI 标签并行回答时，不因 WebContentsView 暂时卸载而节流。
          backgroundThrottling: false,
        },
      });
      view.webContents.setWindowOpenHandler(({ url: u }) => {
        // Google OAuth commonly uses a popup and needs the opener/session to
        // continue the X login flow. Keep that authenticated child window.
        if (isGoogleAuthUrl(u)) return { action: 'allow' };
        if (mainWindow && !mainWindow.isDestroyed() && /^https?:\/\//i.test(u)) {
          mainWindow.webContents.send('desktop:web-link', { id, url: u });
        }
        return { action: 'deny' };
      });
      view.webContents.on('context-menu', (_event, params) => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        const selectionText = String(params.selectionText || '').trim().slice(0, 12000);
        const template = [];
        if (selectionText) template.push({ role: 'copy' });
        if (params.isEditable) template.push({ role: 'paste' });
        if (selectionText) {
          if (template.length) template.push({ type: 'separator' });
          template.push({
            label: '将选中内容翻译为中文',
            click: () => {
              if (!mainWindow || mainWindow.isDestroyed()) return;
              mainWindow.webContents.send('desktop:translate-selection', { id, text: selectionText });
            },
          });
        }
        if (!template.length) return;
        Menu.buildFromTemplate(template).popup({ window: mainWindow });
      });
      const guardNavigation = (event, nextUrl) => {
        if (entry.allowNavigation) return;
        if (!/^https?:\/\//i.test(nextUrl)) return;
        const currentUrl = entry.url || view.webContents.getURL();
        if (shouldAllowOAuthNavigation(nextUrl, currentUrl)) return;
        event.preventDefault();
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('desktop:web-link', { id, url: nextUrl });
        }
      };
      view.webContents.on('will-navigate', guardNavigation);
      view.webContents.on('will-redirect', guardNavigation);
      view.webContents.on('did-navigate', (_event, nextUrl) => {
        if (!entry.pendingUrl || entry.pendingUrl === nextUrl) entry.url = nextUrl;
      });
      view.webContents.on('did-navigate-in-page', (_event, nextUrl, isMainFrame) => {
        if (isMainFrame && (!entry.pendingUrl || entry.pendingUrl === nextUrl)) entry.url = nextUrl;
      });
      view.webContents.on('did-finish-load', () => {
        if (!entry.pendingUrl) entry.allowNavigation = false;
        void cleanupWebPageArtifacts(view).finally(() => installWebCodeRunner(view));
        installWebLinkRouter(view);
      });
      installWebClipboardSupport(view.webContents);
      entry = { view, url: '', allowNavigation: true, pendingUrl: '', loadingUrl: '', navigationSerial: 0 };
      webTabs.set(id, entry);
      navigateWebEntry(entry, url);
    } else if (entry.url !== url && entry.pendingUrl !== url) {
      navigateWebEntry(entry, url);
    }

    // Opening a tab must not steal focus from the React address bar. The
    // native page receives focus when the user clicks its content area.
    focusWeb(id, payload.bounds, false);
    return { ok: true };
  });

  ipcMain.handle('desktop:focus-web', (_e, payload = {}) => {
    return focusWeb(String(payload.id || ''), payload.bounds);
  });

  ipcMain.handle('desktop:hide-web', () => hideWeb());

  ipcMain.handle('desktop:close-web', (_e, payload = {}) => {
    return closeWeb(String(payload.id || ''));
  });

  ipcMain.handle('desktop:set-bounds', (_e, payload = {}) => {
    const id = String(payload.id || '');
    const entry = webTabs.get(id);
    if (!entry) return { ok: false };
    const applied = applyBounds(entry.view, payload.bounds);
    if (applied) entry.bounds = applied;
    return { ok: true };
  });

  ipcMain.handle('desktop:reload-web', (_e, payload = {}) => {
    const entry = webTabs.get(String(payload.id || ''));
    if (!entry) return { ok: false };
    entry.allowNavigation = true;
    entry.view.webContents.reload();
    return { ok: true };
  });

  ipcMain.handle('desktop:go-back-web', (_e, payload = {}) => {
    const entry = webTabs.get(String(payload.id || ''));
    if (!entry) return { ok: false };
    if (entry.view.webContents.navigationHistory.canGoBack()) {
      entry.allowNavigation = true;
      entry.view.webContents.navigationHistory.goBack();
    }
    return { ok: true };
  });

  ipcMain.handle('desktop:go-forward-web', (_e, payload = {}) => {
    const entry = webTabs.get(String(payload.id || ''));
    if (!entry) return { ok: false };
    if (entry.view.webContents.navigationHistory.canGoForward()) {
      entry.allowNavigation = true;
      entry.view.webContents.navigationHistory.goForward();
    }
    return { ok: true };
  });

  ipcMain.handle('desktop:get-web-state', (_e, payload = {}) => {
    const entry = webTabs.get(String(payload.id || ''));
    if (!entry) return { ok: false };
    const currentUrl = entry.pendingUrl || entry.view.webContents.getURL() || entry.url;
    const currentTitle = entry.view.webContents.getTitle() || '';
    return {
      ok: true,
      url: currentUrl,
      title: currentTitle,
      loading: !!entry.pendingUrl || entry.view.webContents.isLoadingMainFrame(),
      canGoBack: entry.view.webContents.navigationHistory.canGoBack(),
      canGoForward: entry.view.webContents.navigationHistory.canGoForward(),
    };
  });

  ipcMain.handle('desktop:extract-web-content', async (_e, payload = {}) => {
    const entry = webTabs.get(String(payload.id || ''));
    if (!entry) return { ok: false, error: '网页标签不存在或已关闭' };
    try {
      // Keep this script fixed and local: the renderer cannot supply arbitrary JS.
      // Removing chrome elements gives the model the article text rather than menus.
      const extracted = await entry.view.webContents.executeJavaScript(`(() => {
        const root = document.body ? document.body.cloneNode(true) : null;
        if (!root) return { title: document.title || '', text: '' };
        root.querySelectorAll('script, style, noscript, iframe, svg, canvas, nav, footer, aside, form').forEach((node) => node.remove());
        const text = String(root.innerText || root.textContent || '')
          .replace(/\\u00a0/g, ' ')
          .replace(/[ \\t]+\\n/g, '\\n')
          .replace(/\\n{3,}/g, '\\n\\n')
          .trim();
        return { title: document.title || '', text: text.slice(0, 50000) };
      })()`, true);
      const currentUrl = entry.view.webContents.getURL() || entry.url;
      return {
        ok: true,
        url: currentUrl,
        title: String(extracted?.title || entry.view.webContents.getTitle() || ''),
        text: String(extracted?.text || ''),
      };
    } catch (error) {
      return { ok: false, error: String(error?.message || error || '网页正文读取失败') };
    }
  });

  ipcMain.handle('desktop:extract-web-segments', async (_e, payload = {}) => {
    const entry = webTabs.get(String(payload.id || ''));
    if (!entry) return { ok: false, error: '网页标签不存在或已关闭' };
    try {
      await cleanupWebPageArtifacts(entry.view);
      const extracted = await entry.view.webContents.executeJavaScript(`(() => {
        const selectors = 'h1,h2,h3,h4,h5,h6,p,li,td,th,blockquote,dt,dd,div,[role="heading"],[role="paragraph"],[data-testid="tweetText"],[data-testid="postText"],div[lang]';
        const skipped = 'nav,header,footer,aside,form,script,style,noscript,button,input,textarea,select,code,pre,a,label,[data-workbench-translation]';
        const normalize = value => String(value || '')
          .replace(/\\u00a0/g, ' ')
          .replace(/[ \\t]+/g, ' ')
          .replace(/\\s*\\n\\s*/g, ' ')
          .trim();
        const segments = [];
        let totalChars = 0;
        let sequence = 0;
        for (const element of document.querySelectorAll(selectors)) {
          if (!(element instanceof HTMLElement) || element.matches(skipped) || element.closest(skipped)) continue;
          if (element.querySelector(selectors)) continue;
          const style = window.getComputedStyle(element);
          if (style.display === 'none' || style.visibility === 'hidden') continue;
          const currentText = normalize(element.innerText || element.textContent || '');
          const originalText = normalize(element.getAttribute('data-workbench-original-text') || currentText);
          if (originalText.length < 3 || originalText.length > 1800 || !/[A-Za-z]{2}/.test(originalText)) continue;
          const id = element.getAttribute('data-workbench-segment-id') || ('workbench-segment-' + sequence++);
          element.setAttribute('data-workbench-segment-id', id);
          element.setAttribute('data-workbench-original-text', originalText);
          if (totalChars + originalText.length > 36000 || segments.length >= 120) break;
          segments.push({ id, text: originalText });
          totalChars += originalText.length;
        }
        return { title: document.title || '', segments };
      })()`, true);
      return {
        ok: true,
        title: String(extracted?.title || entry.view.webContents.getTitle() || ''),
        segments: Array.isArray(extracted?.segments) ? extracted.segments : [],
      };
    } catch (error) {
      return { ok: false, error: String(error?.message || error || '网页正文分段失败') };
    }
  });

  ipcMain.handle('desktop:apply-web-translations', async (_e, payload = {}) => {
    const entry = webTabs.get(String(payload.id || ''));
    if (!entry) return { ok: false, error: '网页标签不存在或已关闭' };
    const mode = payload.mode === 'bilingual' ? 'bilingual' : 'replace';
    const translations = Array.isArray(payload.translations)
      ? payload.translations
        .filter(item => item && typeof item.id === 'string' && typeof item.translation === 'string')
        .map(item => ({ id: item.id.slice(0, 120), translation: item.translation.trim().slice(0, 10000) }))
        .filter(item => item.translation)
        .slice(0, 120)
      : [];
    if (!translations.length) return { ok: false, error: '没有可应用的翻译内容' };
    try {
      const applied = await entry.view.webContents.executeJavaScript(`((payload) => {
        const looksLikeNoScriptArtifact = value => {
          const text = String(value || '');
          return /msg-noscript|msg-title--noscript|您正在被重定向到/i.test(text)
            || (/<\\s*(meta|link|div|p|a)\\b/i.test(text) && /(noscript|refresh|msg-)/i.test(text));
        };
        document.querySelectorAll('noscript,.msg-noscript,.msg-title--noscript').forEach(element => element.remove());
        if (document.body) {
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          const matches = [];
          let node = walker.nextNode();
          while (node) {
            if (looksLikeNoScriptArtifact(node.nodeValue)) matches.push(node);
            node = walker.nextNode();
          }
          matches.forEach(textNode => {
            const parent = textNode.parentElement;
            if (parent && parent !== document.body && parent.textContent.length < 3000) parent.remove();
            else textNode.remove();
          });
        }
        const findSegment = id => Array.from(document.querySelectorAll('[data-workbench-segment-id]'))
          .find(element => element.getAttribute('data-workbench-segment-id') === id);
        document.querySelectorAll('[data-workbench-translation]').forEach(element => element.remove());
        document.querySelectorAll('[data-workbench-original-html]').forEach(element => {
          element.innerHTML = element.getAttribute('data-workbench-original-html') || '';
          element.removeAttribute('data-workbench-original-html');
        });
        let applied = 0;
        for (const item of payload.translations) {
          const element = findSegment(item.id);
          if (!element) continue;
          if (payload.mode === 'bilingual') {
            const line = document.createElement('span');
            line.setAttribute('data-workbench-translation', '');
            line.setAttribute('lang', 'zh-CN');
            line.style.display = 'block';
            line.style.marginTop = '0.35em';
            line.style.color = '#2563eb';
            line.style.fontSize = '0.95em';
            line.textContent = item.translation;
            element.appendChild(line);
          } else {
            element.setAttribute('data-workbench-original-html', element.innerHTML);
            element.textContent = item.translation;
          }
          applied += 1;
        }
        return { applied };
      })(${JSON.stringify({ mode, translations })})`, true);
      return { ok: true, applied: Number(applied?.applied || 0) };
    } catch (error) {
      return { ok: false, error: String(error?.message || error || '网页翻译应用失败') };
    }
  });

  ipcMain.handle('desktop:web-chat', async (_e, payload = {}) => {
    const id = String(payload.id || '');
    const prompt = String(payload.prompt || '').trim();
    const entry = webTabs.get(id);
    if (!entry) return { ok: false, error: '网页标签不存在或已关闭' };
    if (!prompt) return { ok: false, error: '问题不能为空' };
    const progressEvents = [];
    const report = createWebChatProgressReporter(_e.sender, id, progressEvents);
    report('started', '网页大模型处理开始', { url: entry.view.webContents.getURL() });
    const rawResult = await runWebChat(entry.view, prompt, {
      timeoutMs: payload.timeoutMs,
      onProgress: report,
    });
    rawResult.progressEvents = progressEvents;
    const result = await persistWebChatDump(
      id,
      rawResult,
      entry.view.webContents,
      report,
    );
    log(
      '网页 AI 对话结束:',
      id,
      result.ok ? 'ok' : 'error',
      `site=${result.site || 'unknown'}`,
      `model=${result.model || 'unknown'}`,
      `chars=${String(result.content || '').length}`,
      `duration=${result.durationMs || 0}ms`,
      `partial=${!!result.partial}`,
      result.error || result.warning || '',
      result.extraction || '',
      result.validation || '',
      result.diagnostics || '',
      result.dumpPath ? `dump=${result.dumpPath}` : '',
      result.pagePath ? `page=${result.pagePath}` : '',
      result.pageSaveError || '',
    );
    return result;
  });

  ipcMain.handle('desktop:new-web-chat', async (_e, payload = {}) => {
    const id = String(payload.id || '');
    const entry = webTabs.get(id);
    if (!entry) return { ok: false, error: '网页标签不存在或已关闭' };
    const result = await startNewWebChat(entry.view);
    if (result.ok && result.url) entry.url = result.url;
    log('网页 AI 新建对话:', id, result.ok ? result.method : result.error);
    return result;
  });

  ipcMain.handle('desktop:open-external', (_e, payload = {}) => {
    const url = String(payload.url || '').trim();
    if (url) shell.openExternal(url);
    return { ok: true };
  });

  // Open terminal-detected targets with the operating system default handler.
  // Directories are intentionally passed to shell.openPath as well, which
  // opens the user's default file manager on Linux/macOS/Windows. Relative
  // paths are resolved against the PTY's current working directory.
  ipcMain.handle('desktop:open-target', async (_e, payload = {}) => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { ok: false, error: '终端目标无效。' };
    const target = typeof payload.target === 'string' ? payload.target.trim() : '';
    if (!target || target.length > 8192 || /[\0\r\n]/.test(target)) return { ok: false, error: '终端目标无效。' };
    if (/^https?:\/\//i.test(target)) {
      let parsed;
      try { parsed = new URL(target); } catch { return { ok: false, error: '网页地址无效。' }; }
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return { ok: false, error: '网页地址无效。' };
      await shell.openExternal(parsed.toString());
      return { ok: true, kind: 'url', target: parsed.toString() };
    }
    if (/^file:\/\//i.test(target)) {
      let parsed;
      try { parsed = new URL(target); } catch { return { ok: false, error: '文件地址无效。' }; }
      if (parsed.protocol !== 'file:' || parsed.username || parsed.password || parsed.search || parsed.hash) return { ok: false, error: '文件地址无效。' };
      let filePath;
      try { filePath = fileURLToPath(parsed); } catch { return { ok: false, error: '文件地址无效。' }; }
      if (!filePath || /[\0\r\n]/.test(filePath)) return { ok: false, error: '文件地址无效。' };
      if (!fs.existsSync(filePath)) return { ok: false, error: `文件或目录不存在：${filePath}` };
      const error = await shell.openPath(filePath);
      if (error) return { ok: false, error: `无法打开路径：${error}` };
      return { ok: true, kind: 'path', target: filePath };
    }
    const cwdInput = typeof payload.cwd === 'string' && payload.cwd.trim() ? payload.cwd.trim() : ROOT;
    if (cwdInput.length > 4096 || /[\0\r\n]/.test(cwdInput)) return { ok: false, error: '终端工作目录无效。' };
    const home = os.homedir();
    const cwdExpanded = cwdInput === '~' ? home : /^~[\\/]/.test(cwdInput) ? path.join(home, cwdInput.slice(2)) : cwdInput;
    const cwd = path.resolve(cwdExpanded);
    const expanded = target === '~' ? home : /^~[\\/]/.test(target) ? path.join(home, target.slice(2)) : target;
    const filePath = path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(cwd, expanded);
    if (!fs.existsSync(filePath)) return { ok: false, error: `文件或目录不存在：${filePath}` };
    const error = await shell.openPath(filePath);
    if (error) return { ok: false, error: `无法打开路径：${error}` };
    return { ok: true, kind: 'path', target: filePath };
  });
}

app.whenReady().then(async () => {
  // 去掉默认的 File / Edit / View 等系统菜单栏
  Menu.setApplicationMenu(null);

  registerIpc();

  const alreadyUp = await checkServer();
  if (!alreadyUp && START_SERVER) {
    startBackend();
    try {
      await waitForServer();
    } catch (e) {
      log(String(e));
      // 仍打开窗口，便于看到错误页
    }
  } else if (alreadyUp) {
    log('检测到后端已在运行，复用', APP_URL);
  } else {
    log('未启动后端（ELECTRON_START_SERVER=0），直接加载', APP_URL);
  }

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  stopping = true;
  for (const id of [...webTabs.keys()]) closeWeb(id);
  if (serverProc && !serverProc.killed) {
    log('结束后端进程');
    try { serverProc.kill('SIGTERM'); } catch { /* noop */ }
    serverProc = null;
  }
  if (fusionProc && !fusionProc.killed) {
    log('结束 Fusion 窗口进程');
    try { fusionProc.kill('SIGTERM'); } catch { /* noop */ }
    fusionProc = null;
  }
  if (fusionBackendProc && !fusionBackendProc.killed) {
    log('结束 Fusion 后端进程');
    try { fusionBackendProc.kill('SIGTERM'); } catch { /* noop */ }
    fusionBackendProc = null;
  }
});
