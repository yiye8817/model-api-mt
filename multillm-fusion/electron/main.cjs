'use strict';

const { app, BrowserWindow, BaseWindow, WebContentsView, webContents, session, ipcMain, dialog, clipboard, shell } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { spawn, execFileSync } = require('node:child_process');
const https = require('node:https');
const WebSocket = require('ws');
const { WebsiteAdapter } = require('./adapter.cjs');
const { BrowserLoginController, LoginError, runPythonHelper } = require('./browser-login.cjs');
const { createLogger, diskSecrets, lineSink } = require('./diagnostics.cjs');
const { ProviderLayout } = require('./provider-layout.cjs');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.resolve(process.env.FUSION_DATA_DIR || path.join(os.homedir(), '.local/share/multillm-fusion'));
const PORT = Number(process.env.FUSION_PORT || 8765);
if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65535) throw new Error('FUSION_PORT must be an integer from 1024 to 65535.');
const BASE = `http://127.0.0.1:${PORT}`;
const UI_PATH = path.join(ROOT, 'ui/index.html');
const UI_URL = pathToFileURL(UI_PATH).href;
const PROVIDER_ID = /^[a-z][a-z0-9_-]{0,39}$/;
const JOB_ID = /^[A-Za-z0-9_-]{1,100}$/;
const providers = new Map();
const runningJobs = new Map();
const seenJobs = new Set();
const cancelledJobs = new Set();
let win, socket, child, reconnectTimer, pingTimer, token, config, providerLayout, workbenchWebView;
const workbenchTerminals = new Map();
let workbenchTerminalSerial = 0;
let closing = false, shutdownComplete = false, backendExited = false, reconnectAttempt = 0;
let appliedConfigSerial = 0;
let configuration = Promise.resolve();
let browserLogin, pendingConfigRequests = 0, pendingConfigurations = 0;
const startupSecrets = diskSecrets();
const log = createLogger({ component: 'electron', getSecrets: () => [...startupSecrets, token, config?.fusion?.api_key] });
process.env.FUSION_LOG_DIR = log.directory;

// Match the host workbench's Linux GPU fallback. Some Mesa/remote-display
// environments cannot start Electron's GPU process; that must not prevent the
// independent Fusion window from opening.
if (process.platform === 'linux' && process.env.ELECTRON_DISABLE_GPU !== '0') {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu-compositing');
}

fs.mkdirSync(DATA, { recursive: true, mode: 0o700 });
app.setPath('userData', path.join(DATA, 'chromium'));

function notify(payload) {
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('fusion:status', payload);
}
function send(packet, expectedSocket = socket) {
  if (expectedSocket && expectedSocket === socket && expectedSocket.readyState === WebSocket.OPEN) expectedSocket.send(JSON.stringify(packet));
}
function providerStatus(id, state, message) {
  const provider = providers.get(id);
  if (provider?.status?.state !== state) log('provider_state', { provider_id: id, state });
  if (provider) provider.status = { state, message };
  notify({ type: 'provider', provider_id: id, state, message });
  send({ type: 'status', provider_id: id, state, message });
}
function bridgeStatus(state, message) { log('bridge_state', { state }); notify({ type: 'bridge', state, message }); }

function initializeFiles() {
  const configFile = path.join(DATA, 'config.json');
  try { fs.copyFileSync(path.join(ROOT, 'config.example.json'), configFile, fs.constants.COPYFILE_EXCL); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  fs.chmodSync(configFile, 0o600);
  const tokenFile = path.join(DATA, 'api-key.txt');
  if (!process.env.FUSION_TOKEN) {
    try { fs.writeFileSync(tokenFile, crypto.randomBytes(32).toString('hex') + '\n', { flag: 'wx', mode: 0o600 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    fs.chmodSync(tokenFile, 0o600);
  }
  token = (process.env.FUSION_TOKEN || fs.readFileSync(tokenFile, 'utf8')).trim();
  if (token.length < 16 || /[\r\n]/.test(token)) throw new Error('API token must be at least 16 characters, without newlines.');
}

function requestLocal(method, route, body, timeout = 15000, authenticated = true, progressId = undefined, requestSource = undefined) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = { Accept: 'application/json' };
    if (authenticated) headers.Authorization = `Bearer ${token}`;
    if (progressId) headers['X-Fusion-Progress-ID'] = progressId;
    if (requestSource) headers['X-Fusion-Request-Source'] = requestSource;
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = payload.length; }
    const req = http.request({ hostname: '127.0.0.1', port: PORT, method, path: route, headers }, res => {
      const chunks = []; let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > 32 * 1024 * 1024) { req.destroy(new Error('Backend response exceeds 32 MiB.')); return; }
        chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => {
        let value;
        try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return reject(new Error(`Backend returned non-JSON HTTP ${res.statusCode}.`)); }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const detail = value.error?.message || value.detail || value.message || `HTTP ${res.statusCode}`;
          return reject(new Error(typeof detail === 'string' ? detail : JSON.stringify(detail)));
        }
        resolve(value);
      });
    });
    req.setTimeout(timeout, () => req.destroy(new Error('本地接口请求超时，请检查后端日志。')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function startBackend() {
  let existing = false;
  try { await requestLocal('GET', '/health', undefined, 1200, false); existing = true; } catch {}
  if (existing) {
    config = await requestLocal('GET', '/internal/config');
    log('backend_reused');
    return;
  }
  // When Fusion is launched from the host workbench, the shared virtualenv is
  // one directory above this vendored runtime. Keep the standalone layout
  // working too by falling back to the local .venv first.
  const localPython = path.join(ROOT, '.venv/bin/python');
  const sharedPython = path.join(ROOT, '..', '.venv/bin/python');
  const python = process.env.FUSION_PYTHON || (fs.existsSync(localPython) ? localPython : sharedPython);
  if (!fs.existsSync(python) && python.includes('/')) throw new Error(`找不到 Python 环境：${python}\n请先运行 ./run.sh 安装依赖。`);
  child = spawn(python, ['-m', 'uvicorn', 'backend.app:app', '--host', '127.0.0.1', '--port', String(PORT), '--no-access-log'], {
    cwd: ROOT, env: { ...process.env, FUSION_DATA_DIR: DATA, FUSION_TOKEN: token }, stdio: ['ignore', 'ignore', 'pipe'],
  });
  // Python writes its structured events to backend.log itself. Mirror them to the
  // terminal once; capture non-structured startup errors in electron.log.
  const stderr = lineSink(line => {
    try { const record = JSON.parse(line); if (record.component === 'backend' && record.event) { log.forward(line); return; } } catch {}
    if (line.trim()) log('backend_stderr', { detail: line }, 'warn');
  });
  child.stderr.on('data', stderr.write);
  child.stderr.on('end', stderr.end);
  log('backend_spawn', { pid: child.pid, port: PORT });
  let startupError;
  child.on('error', error => { startupError = error; backendExited = true; log('backend_spawn_failed', { code: error.code || 'unknown' }); });
  child.on('exit', (code, signal) => {
    backendExited = true; log('backend_exit', { code, signal });
    if (!closing) bridgeStatus('error', 'Python 后端已退出，请在终端运行 ./run.sh --backend 检查错误后重启。');
  });
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline && !backendExited) {
    try {
      await requestLocal('GET', '/health', undefined, 800, false);
      config = await requestLocal('GET', '/internal/config');
      log('backend_ready');
      return;
    } catch { await new Promise(resolve => setTimeout(resolve, 250)); }
  }
  if (startupError) throw new Error(`Python 启动失败 (${startupError.code || 'unknown'})。请运行 ./run.sh。`);
  throw new Error(`Python 后端未就绪。请确认端口 ${PORT} 未占用，并在终端运行 ./run.sh --backend 查看详细错误。`);
}

function safeWebURL(value) {
  try { const url = new URL(value); return !url.username && !url.password && (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))); } catch { return false; }
}

function safeWebNavigation(value) {
  return value === 'about:blank' || safeWebURL(value);
}

function jwtEmail(token) {
  if (typeof token !== 'string' || !token) return '';
  try {
    const part = token.split('.')[1];
    if (!part) return '';
    const payload = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return typeof payload?.email === 'string' ? payload.email : '';
  } catch { return ''; }
}

function installGLMAuthRefresh(item) {
  if (item.provider.id !== 'glm') return;
  let previousToken = null;
  let authenticatedToken = '';
  let recoveryDeadline = 0;
  let recoveryUsed = false;
  const check = async () => {
    const wc = item.view.webContents;
    if (wc.isDestroyed()) return;
    let state;
    try {
      state = await wc.executeJavaScript(`(() => {
        try { return { token: localStorage.getItem('token') || '', href: location.href }; }
        catch { return { token: '', href: location.href }; }
      })()`, true);
    } catch { return; }
    const token = typeof state?.token === 'string' ? state.token : '';
    const email = jwtEmail(token);
    const wasGuest = previousToken === null || /@guest\\.com$/i.test(jwtEmail(previousToken));
    const wasAuthenticated = !!jwtEmail(previousToken) && !/@guest\\.com$/i.test(jwtEmail(previousToken));
    previousToken = token;
    // z.ai changes its local token after phone verification but can leave the
    // pre-login Svelte state mounted. Keep the authenticated token on the
    // provider session so a reload's server-side session bootstrap does not
    // replace it with a guest token. Never log the token.
    if (email && !/@guest\\.com$/i.test(email) && wasGuest) {
      authenticatedToken = token;
      item.glmAuthToken = token;
      recoveryDeadline = Date.now() + 15000;
      recoveryUsed = false;
      log('glm_auth_state_changed', { reason: 'authenticated_token_detected', href: state?.href || '' });
      providerStatus('glm', 'loading', '已检测到登录账号，正在刷新 GLM 会话…');
      try { await wc.reload(); } catch {}
    } else if (/@guest\\.com$/i.test(email) && wasAuthenticated && authenticatedToken && !recoveryUsed && Date.now() < recoveryDeadline) {
      // A z.ai reload can briefly bootstrap a guest token before the bearer
      // header is observed by its server-side session. Restore the verified
      // token once inside this short recovery window, then reload again.
      try {
        recoveryUsed = true;
        const restored = JSON.stringify(authenticatedToken);
        await wc.executeJavaScript(`localStorage.setItem('token', ${restored});`, true);
        previousToken = authenticatedToken;
        try { await wc.reload(); } catch {}
      } catch {}
    }
  };
  item.authRefreshTimer = setInterval(() => { void check(); }, 1000);
  void check();
}

function uninstallProviderAuthRefresh(item) {
  if (item?.authRefreshTimer) clearInterval(item.authRefreshTimer);
  if (item) item.authRefreshTimer = null;
}

function initializeBrowserLogin() {
  browserLogin = new BrowserLoginController({
    getProvider: id => providers.get(id),
    getConnection: () => socket,
    isConnectionCurrent: connection => !!connection && connection === socket && connection.readyState === WebSocket.OPEN && !closing,
    canStart: () => !closing && !runningJobs.size && !pendingConfigRequests && !pendingConfigurations && ![...providers.values()].some(item => item.adapter.active),
    acquire: () => requestLocal('POST', '/internal/browser-maintenance', { active: true }),
    release: lease_id => requestLocal('POST', '/internal/browser-maintenance', { active: false, lease_id }),
    runHelper: (payload, signal) => runPythonHelper({ python: process.env.FUSION_PYTHON || path.join(ROOT, '.venv/bin/python'), root: ROOT, payload, signal }),
    chooseFile: async () => {
      const result = await dialog.showOpenDialog(win, { title: '导入模型登录文件', properties: ['openFile'], filters: [{ name: '模型登录 JSON', extensions: ['json'] }] });
      return result.canceled ? null : result.filePaths[0];
    },
    onBusy: active => notify({ type: 'browser-maintenance', active }),
    // Backend disconnect releases any matching lease. Do not leave a failed release
    // blocking API clients indefinitely or pretend it succeeded in the renderer.
    onReleaseFailure: connection => { if (connection === socket) socket.terminate(); },
  });
}

function layoutProviders() {
  providerLayout?.render();
}

function canOpenRecoveryProvider(id) {
  if (closing || browserLogin?.busy || pendingConfigurations || pendingConfigRequests || !providers.get(id)?.adapter.active) return false;
  return [...runningJobs.values()].some(job => job.provider_id === id && job.manualRecovery === true && !job.controller.signal.aborted);
}

async function createProvider(provider) {
  if (!PROVIDER_ID.test(provider.id) || !safeWebURL(provider.url)) throw new Error('无效的模型 ID 或 URL。');
  const ses = session.fromPartition(`persist:fusion-${provider.id}`);
  await ses.setProxy(provider.proxy ? { mode: 'fixed_servers', proxyRules: provider.proxy } : { mode: 'system' });
  await ses.closeAllConnections();
  ses.on('will-download', event => event.preventDefault());
  const view = new WebContentsView({ webPreferences: {
    session: ses, nodeIntegration: false, nodeIntegrationInSubFrames: false,
    contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false,
    backgroundThrottling: false, spellcheck: false, navigateOnDragDrop: false,
  } });
  view.setVisible(false);
  const wc = view.webContents;
  installWebClipboardSupport(wc);
  const item = { view, provider, status: { state: 'loading', message: '正在打开网页…' }, pendingLoad: null, glmAuthToken: '' };
  if (provider.id === 'glm') {
    const sessionHosts = ['https://z.ai/*', 'https://*.z.ai/*'];
    ses.webRequest.onBeforeSendHeaders({ urls: sessionHosts }, (details, callback) => {
      const authenticatedToken = item.glmAuthToken;
      if (authenticatedToken) details.requestHeaders.Authorization = `Bearer ${authenticatedToken}`;
      callback({ requestHeaders: details.requestHeaders });
    });
  }
  try { wc.setUserAgent(wc.getUserAgent().replace(/\sElectron\/[^\s]+/i, '')); } catch {}
  // Google and other OAuth providers finish sign-in in a popup. Let only
  // approved web destinations open there; the popup inherits this provider's
  // persistent session so its callback can return to the model page.
  wc.setWindowOpenHandler(({url}) => {
    if (!safeWebNavigation(url) || browserLogin?.busy || providers.get(provider.id)?.adapter.active) return {action: 'deny'};
    return {action: 'allow', overrideBrowserWindowOptions: {parent: win, width: 520, height: 720, autoHideMenuBar: true}};
  });
  wc.on('did-create-window', popup => {
    popup.setMenuBarVisibility(false);
    popup.webContents.setWindowOpenHandler(({url}) => safeWebNavigation(url) ? {action: 'allow'} : {action: 'deny'});
    popup.webContents.on('will-navigate', (event, url) => { if (!safeWebNavigation(url)) event.preventDefault(); });
    popup.webContents.on('will-redirect', (event, url) => { if (!safeWebNavigation(url)) event.preventDefault(); });
  });
  wc.on('will-navigate', (event, url) => { if (!safeWebURL(url)) event.preventDefault(); });
  wc.on('will-redirect', (event, url) => { if (!safeWebURL(url)) event.preventDefault(); });
  wc.on('will-attach-webview', event => event.preventDefault());
  wc.on('did-finish-load', () => {
    log('provider_loaded', { provider_id: provider.id });
    if (!browserLogin?.busy && !providers.get(provider.id)?.adapter.active) providerStatus(provider.id, 'ready', '网页已打开，请确认已登录。');
  });
  wc.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) { log('provider_load_failed', { provider_id: provider.id, code }); providerStatus(provider.id, 'error', `网页加载失败 (${code})，请检查代理与网络并刷新。`); }
  });
  wc.on('render-process-gone', (_event, details) => {
    log('provider_renderer_gone', { provider_id: provider.id, reason: details.reason });
    for (const job of runningJobs.values()) if (job.provider_id === provider.id) job.controller.abort();
    providerStatus(provider.id, 'error', '网页进程已退出，请刷新该标签。');
  });
  wc.on('unresponsive', () => log('provider_unresponsive', { provider_id: provider.id }));
  wc.on('responsive', () => log('provider_responsive', { provider_id: provider.id }));
  item.adapter = new WebsiteAdapter(wc, provider, (state, message) => {
    for (const job of runningJobs.values()) if (job.provider_id === provider.id) job.manualRecovery = ['manual_retry_required', 'verification_required'].includes(state);
    providerStatus(provider.id, state, message);
  },
    (event, fields) => log(event, { ...fields, provider_id: provider.id }),
    { acquireInput: request => providerLayout.acquireInput(request),
      // Structured-reply copy fallbacks read only the current system clipboard
      // after a trusted page gesture; no clipboard contents are logged here.
      readClipboard: () => clipboard.readText() });
  providers.set(provider.id, item);
  providerLayout.add(provider.id, view, provider.name);
  installGLMAuthRefresh(item);
  layoutProviders();
  // Keep the initial navigation promise so a request cannot start a second
  // navigation while this page is still loading. The result is normalized to
  // avoid an unhandled rejection; adapter.run will retry a failed navigation.
  item.pendingLoad = wc.loadURL(provider.url).then(
    () => ({ ok: true }),
    error => ({ ok: false, error }),
  );
  return item;
}

async function waitForProviderLoad(item, timeoutMs = 45000) {
  const pending = item?.pendingLoad;
  if (!pending) return;
  item.pendingLoad = null;
  let timer;
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => resolve({ ok: false, timedOut: true }), timeoutMs);
  });
  const result = await Promise.race([pending, timeout]);
  clearTimeout(timer);
  if (result?.timedOut) {
    try { item.view.webContents.stop(); } catch {}
    log('provider_load_wait_timeout', { provider_id: item.provider.id, timeout_ms: timeoutMs });
  } else if (result && result.ok === false) {
    log('provider_load_wait_failed', { provider_id: item.provider.id, error: result.error?.message || 'navigation_failed' });
  }
}

async function applyConfig(next) {
  if (browserLogin?.busy) throw new LoginError('BUSY');
  if (!next || !Array.isArray(next.providers)) throw new Error('Backend configuration is invalid.');
  if (runningJobs.size) throw new Error('Cannot reconfigure while website jobs are running.');
  const enabled = next.providers.filter(provider => provider.enabled);
  const ids = new Set(enabled.map(provider => provider.id));
  for (const [id, item] of providers) {
    if (!ids.has(id)) { uninstallProviderAuthRefresh(item); providerLayout.remove(id); providers.delete(id); }
  }
  for (const provider of enabled) {
    if (!PROVIDER_ID.test(provider.id) || !safeWebURL(provider.url)) throw new Error('Invalid provider configuration.');
    const existing = providers.get(provider.id);
    if (!existing) await createProvider(provider);
    else {
      const networkChanged = existing.provider.url !== provider.url || existing.provider.proxy !== provider.proxy;
      if (networkChanged) {
        const ses = existing.view.webContents.session;
        await ses.setProxy(provider.proxy ? { mode: 'fixed_servers', proxyRules: provider.proxy } : { mode: 'system' });
        await ses.closeAllConnections();
      }
      existing.provider = provider;
      existing.adapter.provider = provider;
      providerLayout.setTitle(provider.id, provider.name);
      if (networkChanged) {
        existing.pendingLoad = existing.view.webContents.loadURL(provider.url).then(
          () => ({ ok: true }),
          error => ({ ok: false, error }),
        );
      }
    }
  }
  config = next;
  log('config_applied', { providers: enabled.map(item => item.id), fusion_mode: next.fusion?.mode, fusion_provider: next.fusion?.provider });
  appliedConfigSerial++;
  layoutProviders();
}

function validJob(job) {
  return JOB_ID.test(job.job_id || '') && PROVIDER_ID.test(job.provider_id || '') && typeof job.prompt === 'string' && job.prompt.length > 0 && job.prompt.length <= 4000000 && Buffer.byteLength(job.prompt, 'utf8') <= 8000000 &&
    (job.request_source === undefined || ['fusion_chat','api','desktop-top'].includes(job.request_source)) &&
    ['candidate', 'fusion'].includes(job.purpose) && Number.isFinite(job.timeout_seconds) && job.timeout_seconds >= 1 && job.timeout_seconds <= 1800 &&
    (job.submission_timeout_seconds === undefined || (Number.isFinite(job.submission_timeout_seconds) && job.submission_timeout_seconds >= 15 && job.submission_timeout_seconds <= 600)) &&
    (job.recovery_timeout_seconds === undefined || (Number.isFinite(job.recovery_timeout_seconds) && job.recovery_timeout_seconds >= 0 && job.recovery_timeout_seconds <= 600)) &&
    (job.input_chunk_chars === undefined || (Number.isInteger(job.input_chunk_chars) && job.input_chunk_chars >= 256 && job.input_chunk_chars <= 16384)) &&
    (job.input_chunk_delay_ms === undefined || (Number.isInteger(job.input_chunk_delay_ms) && job.input_chunk_delay_ms >= 0 && job.input_chunk_delay_ms <= 1000)) &&
    (job.submit_settle_seconds === undefined || (Number.isFinite(job.submit_settle_seconds) && job.submit_settle_seconds >= 0 && job.submit_settle_seconds <= 10)) &&
    (job.access_interval_seconds === undefined || (Number.isFinite(job.access_interval_seconds) && job.access_interval_seconds >= 0 && job.access_interval_seconds <= 3600)) &&
    (job.total_timeout_seconds === undefined || (Number.isFinite(job.total_timeout_seconds) && job.total_timeout_seconds > 0 && job.total_timeout_seconds <= 1200)) &&
    Number.isFinite(job.stable_seconds) && job.stable_seconds >= 1 && job.stable_seconds <= 120 && Number.isFinite(job.min_wait_seconds) && job.min_wait_seconds >= 0 && job.min_wait_seconds <= 300;
}

async function generate(job, connectedSocket) {
  await configuration;
  if (connectedSocket !== socket || connectedSocket.readyState !== WebSocket.OPEN) return;
  if (cancelledJobs.delete(job.job_id)) return;
  if (!validJob(job)) { send({ type: 'error', job_id: job.job_id, provider_id: job.provider_id, error: { code: 'invalid_job', message: '无效的网页生成任务。' } }, connectedSocket); return; }
  if (browserLogin?.busy) { send({ type: 'error', job_id: job.job_id, provider_id: job.provider_id, error: { code: 'browser_maintenance', message: '正在导入浏览器登录，请稍后重试。' } }, connectedSocket); return; }
  if (seenJobs.has(job.job_id)) { log('duplicate_job_ignored', { job_id: job.job_id }); return; }
  seenJobs.add(job.job_id);
  if (seenJobs.size > 10000) { log('job_limit'); connectedSocket.close(1012, 'Restart bridge after 10000 jobs'); return; }
  const item = providers.get(job.provider_id);
  if (!item || item.adapter.active) { send({ type: 'error', job_id: job.job_id, provider_id: job.provider_id, error: { code: 'provider_unavailable', message: '模型未启用或已有任务。' } }, connectedSocket); return; }
  const controller = new AbortController();
  runningJobs.set(job.job_id, { controller, provider_id: job.provider_id, manualRecovery: false });
  const started = Date.now();
  log('job_start', { job_id: job.job_id, request_id: job.request_id, provider_id: job.provider_id, purpose: job.purpose, request_source: job.request_source || 'unknown', retry_stages: job.qwen_retry_stages !== false, recovery_seconds: job.recovery_timeout_seconds, total_timeout_seconds: job.total_timeout_seconds, prompt_chars: job.prompt.length, timeout_seconds: job.timeout_seconds });
  try {
    // applyConfig can finish before the hidden provider view's first load.
    // Wait for that navigation before adapter.run performs its deliberate
    // task navigation; otherwise two loadURL calls can cancel each other and
    // surface as a misleading candidate_generation_failed/502.
    await waitForProviderLoad(item);
    const markdown = await item.adapter.run(job, controller.signal, progress => {
      send({ type: 'progress', job_id: job.job_id, provider_id: job.provider_id, ...progress }, connectedSocket);
    });
    send({ type: 'result', job_id: job.job_id, provider_id: job.provider_id, markdown }, connectedSocket);
    log('job_complete', { job_id: job.job_id, request_id: job.request_id, provider_id: job.provider_id, markdown_chars: markdown.length, elapsed_ms: Date.now() - started });
  } catch (error) {
    send({ type: 'error', job_id: job.job_id, provider_id: job.provider_id, error: { code: String(error.code || 'webpage_error'), message: error.message || '网页生成失败。', ...(error.details ? { details: error.details } : {}) } }, connectedSocket);
    log('job_error', { job_id: job.job_id, request_id: job.request_id, provider_id: job.provider_id, code: String(error.code || 'webpage_error'), elapsed_ms: Date.now() - started, payload: { error: error.message || '网页生成失败。', ...(error.details ? { details: error.details } : {}) } });
  } finally { runningJobs.delete(job.job_id); }
}

function connectBridge() {
  if (closing) return;
  // A synthesis prompt permits 1.5M Unicode characters; UTF-8 and JSON escaping
  // exceed 4MB. Match uvicorn's frame cap while still checking prompt bytes above.
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/internal/bridge`, { headers: { Authorization: `Bearer ${token}` }, handshakeTimeout: 10000, maxPayload: 16 * 1024 * 1024 });
  socket = ws;
  let alive = true;
  ws.on('open', () => {
    reconnectAttempt = 0;
    bridgeStatus('connecting', '正在应用网页配置…');
    pingTimer = setInterval(() => { if (!alive) return ws.terminate(); alive = false; ws.ping(); }, 15000);
  });
  ws.on('pong', () => { alive = true; });
  ws.on('message', data => {
    let packet;
    try { packet = JSON.parse(data.toString('utf8')); } catch { log('invalid_bridge_packet'); return; }
    if (packet.type === 'config') {
      pendingConfigurations++;
      configuration = configuration.catch(() => {}).then(async () => {
        try {
          // A reconnect can arrive while an aborted helper is winding down. Finish
          // its local cleanup before applying the backend's fresh configuration.
          const deadline = Date.now() + 20000;
          while (browserLogin?.busy && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
          await applyConfig(packet.config);
          // Python pauses dispatch while settings change. Acknowledge only after sessions,
          // proxies and adapter definitions are ready, on initial connect and every update.
          send({ type: 'ready' }, ws);
          for (const [id, item] of providers) send({ type: 'status', provider_id: id, ...item.status }, ws);
          bridgeStatus('connected', '网页桥接已连接。');
        } finally { pendingConfigurations--; }
      });
      configuration.catch(() => bridgeStatus('error', '模型配置应用失败，请完成当前任务后重新保存配置。'));
    } else if (packet.type === 'generate') {
      void generate(packet, ws).catch(() => send({ type: 'error', job_id: packet.job_id, provider_id: packet.provider_id, error: { code: 'configuration_error', message: '网页配置未就绪。' } }, ws));
    } else if (packet.type === 'cancel') {
      const running = runningJobs.get(packet.job_id);
      if (running) running.controller.abort();
      else if (JOB_ID.test(packet.job_id || '')) {
        cancelledJobs.add(packet.job_id);
        if (cancelledJobs.size > 10000) cancelledJobs.delete(cancelledJobs.values().next().value);
      }
    }
  });
  ws.on('error', () => log('bridge_connection_error'));
  ws.on('close', () => {
    clearInterval(pingTimer);
    if (socket !== ws) return;
    browserLogin?.cancel();
    socket = undefined;
    for (const job of runningJobs.values()) job.controller.abort();
    if (!closing) {
      bridgeStatus('disconnected', '桥接连接中断，正在重连；进行中的请求不会自动重发。');
      const delay = Math.min(15000, 500 * 2 ** reconnectAttempt++) + Math.random() * 250;
      reconnectTimer = setTimeout(connectBridge, delay);
    }
  });
}

function verifySender(event) {
  if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || event.senderFrame.url !== UI_URL) throw new Error('Untrusted IPC sender.');
}

function launchDesktopAgent(payload = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Desktop Agent 参数无效。');
  const mode = payload.mode === 'run' ? 'run' : payload.mode === 'help' ? 'help' : 'chat';
  const task = typeof payload.task === 'string' ? payload.task.trim() : '';
  const workspace = typeof payload.workspace === 'string' ? payload.workspace.trim() : '';
  const model = typeof payload.model === 'string' ? payload.model.trim() : '';
  const allowedModels = new Set(['chatgpt', 'deepseek', 'qwen', 'glm', 'kimi']);
  const allowedCapabilities = new Set(['shell', 'browser', 'desktop']);
  const allow = Array.isArray(payload.allow) ? [...new Set(payload.allow.filter(item => typeof item === 'string' && allowedCapabilities.has(item)))] : [];
  if (task.length > 100000) throw new Error('Desktop Agent 任务不能超过 100000 个字符。');
  if (workspace.length > 4096 || /[\0\r\n]/.test(workspace)) throw new Error('工作目录参数无效。');
  if (model && !allowedModels.has(model)) throw new Error('Desktop Agent 模型参数无效。');
  if (mode === 'run' && !task) throw new Error('请提供 Desktop Agent 任务。');
  const agentRoot = path.join(ROOT, 'desktop-agent');
  const script = path.join(agentRoot, 'run.sh');
  if (!fs.existsSync(script)) throw new Error('找不到项目内的 desktop-agent/run.sh。');
  const agentOptions = [...(model ? ['--model', model] : []), ...(workspace ? ['--workspace', workspace] : []), ...(allow.length ? ['--allow', allow.join(',')] : [])];
  const commandArgs = mode === 'help'
    ? ['--help']
    : mode === 'run'
      ? ['run', task, ...agentOptions, '--verbose']
      : ['chat', ...agentOptions];
  if (payload.embedded === true) {
    return launchEmbeddedWorkbenchTerminal({
      kind: 'agent', cwd: agentRoot, command: 'bash', args: [script, ...commandArgs],
      env: {...process.env}, tabId: payload.tab_id,
    });
  }
  const candidates = [
    ['gnome-terminal', ['--working-directory', agentRoot, '--', 'bash', script, ...commandArgs]],
    ['konsole', ['--workdir', agentRoot, '-e', 'bash', script, ...commandArgs]],
    ['x-terminal-emulator', ['-e', 'bash', script, ...commandArgs]],
    ['xterm', ['-e', 'bash', script, ...commandArgs]],
  ];
  let lastError = null;
  for (const [terminal, args] of candidates) {
    try { execFileSync('which', [terminal], { stdio: 'ignore' }); } catch { continue; }
    try {
      const child = spawn(terminal, args, {cwd: agentRoot, detached: true, stdio: 'ignore', env: {...process.env}});
      child.unref();
      return {ok: true, terminal, mode};
    } catch (error) { lastError = error; }
  }
  throw new Error(lastError ? `未能启动终端：${lastError.message}` : '未找到可用的终端模拟器，请手动运行 desktop-agent/run.sh。');
}

const WORKBENCH_PROVIDER_ID = /^[a-z][a-z0-9_-]{0,39}$/;
const WORKBENCH_CAP = 20;
const workbenchProvidersPath = () => path.join(DATA, 'workbench-providers.json');

function workbenchProviderUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\r\n]/.test(value)) throw new Error('大模型 API 地址无效。');
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error('大模型 API 地址无效。'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('大模型 API 地址必须是无凭据的 HTTP(S) 地址。');
  }
  return value.replace(/\/+$/, '');
}

function normalizeWorkbenchProvider(value, index = 0) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('大模型配置格式无效。');
  const id = typeof value.id === 'string' ? value.id.trim() : '';
  if (!WORKBENCH_PROVIDER_ID.test(id)) throw new Error(`大模型配置 ${index + 1} 的 ID 无效。`);
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  if (!name || name.length > 80) throw new Error(`大模型配置 ${id} 的名称无效。`);
  const apiType = value.apiType === 'anthropic' ? 'anthropic' : 'openai';
  const baseUrl = workbenchProviderUrl(value.baseUrl);
  const apiKey = typeof value.apiKey === 'string' ? value.apiKey : '';
  const model = typeof value.model === 'string' ? value.model.trim() : '';
  if (apiKey.length > 8192 || /[\0\r\n]/.test(apiKey) || model.length > 200 || /[\0\r\n]/.test(model)) throw new Error(`大模型配置 ${id} 超出长度限制。`);
  const models = Array.isArray(value.models)
    ? [...new Set(value.models.filter(item => typeof item === 'string').map(item => item.trim()).filter(Boolean))].slice(0, 200)
    : [];
  const rawContexts = value.modelContexts && typeof value.modelContexts === 'object' && !Array.isArray(value.modelContexts) ? value.modelContexts : {};
  const modelContexts = {};
  for (const modelName of models) {
    const context = Number(rawContexts[modelName]);
    if (Number.isInteger(context) && context >= 512 && context <= 10000000) modelContexts[modelName] = context;
  }
  const contextSize = Number(value.contextSize);
  const testedAt = Number(value.testedAt);
  const testLatencyMs = Number(value.testLatencyMs);
  return {id, name, apiType, baseUrl, apiKey, model, models, modelContexts,
    ...(Number.isInteger(contextSize) && contextSize >= 512 && contextSize <= 10000000 ? {contextSize} : {}),
    ...(Number.isFinite(testedAt) && testedAt > 0 ? {testedAt} : {}),
    ...(Number.isFinite(testLatencyMs) && testLatencyMs >= 0 ? {testLatencyMs} : {})};
}

function readWorkbenchProviders() {
  try {
    const raw = JSON.parse(fs.readFileSync(workbenchProvidersPath(), 'utf8'));
    if (!Array.isArray(raw)) return [];
    return raw.slice(0, WORKBENCH_CAP).map((item, index) => normalizeWorkbenchProvider(item, index));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    log('workbench_provider_read_failed', {error_type: error?.constructor?.name || 'Error'}, 'warn');
    return [];
  }
}

function writeWorkbenchProviders(values) {
  if (!Array.isArray(values) || values.length > WORKBENCH_CAP) throw new Error(`最多保存 ${WORKBENCH_CAP} 个大模型配置。`);
  const providers = values.map((item, index) => normalizeWorkbenchProvider(item, index));
  if (new Set(providers.map(item => item.id)).size !== providers.length) throw new Error('大模型配置 ID 不能重复。');
  const file = workbenchProvidersPath();
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(providers, null, 2) + '\n', {mode: 0o600});
  fs.renameSync(temporary, file);
  try { fs.chmodSync(file, 0o600); } catch {}
  return providers;
}

function workbenchHttpRequest(method, urlValue, headers = {}, body = undefined, timeout = 120000) {
  const target = new URL(urlValue);
  const transport = target.protocol === 'https:' ? https : http;
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const request = transport.request({hostname: target.hostname, port: target.port || undefined, method,
      path: `${target.pathname || '/'}${target.search}`, headers: {...headers, ...(payload ? {'Content-Type': 'application/json', 'Content-Length': payload.length} : {})}}, response => {
      const chunks = []; let size = 0;
      response.on('data', chunk => { size += chunk.length; if (size > 16 * 1024 * 1024) request.destroy(new Error('大模型响应超过 16 MiB。')); else chunks.push(chunk); });
      response.on('error', reject);
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let value;
        try { value = text ? JSON.parse(text) : {}; } catch { value = {raw: text.slice(0, 2000)}; }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          const detail = value?.error?.message || value?.message || value?.raw || `HTTP ${response.statusCode}`;
          reject(new Error(String(detail).slice(0, 1000))); return;
        }
        resolve(value);
      });
    });
    request.setTimeout(timeout, () => request.destroy(new Error('大模型请求超时。')));
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

function workbenchApiUrl(baseUrl, suffix) {
  const root = workbenchProviderUrl(baseUrl);
  return `${root}${root.endsWith('/v1') ? '' : '/v1'}${suffix}`;
}

function workbenchHeaders(apiType, apiKey) {
  return {
    Accept: 'application/json',
    ...(apiKey ? (apiType === 'anthropic' ? {'x-api-key': apiKey, 'anthropic-version': '2023-06-01'} : {Authorization: `Bearer ${apiKey}`}) : {}),
  };
}

function readWorkbenchContext(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 4) return 0;
  const keys = ['context_length', 'contextLength', 'max_context_length', 'maxContextLength', 'max_model_len', 'maxModelLen', 'context_window', 'contextWindow', 'num_ctx', 'n_ctx', 'model_context_window'];
  for (const key of keys) {
    const candidate = Number(value[key]);
    if (Number.isInteger(candidate) && candidate >= 512 && candidate <= 10000000) return candidate;
  }
  for (const nested of Object.values(value)) {
    const candidate = readWorkbenchContext(nested, depth + 1);
    if (candidate) return candidate;
  }
  return 0;
}

async function workbenchModelContext(baseUrl, apiKey, apiType, model) {
  if (!model) return 0;
  const headers = workbenchHeaders(apiType, apiKey);
  try {
    const result = await workbenchHttpRequest('GET', `${workbenchApiUrl(baseUrl, '/models')}/${encodeURIComponent(model)}`, headers, undefined, 12000);
    const context = readWorkbenchContext(result);
    if (context) return context;
  } catch {}
  // Ollama exposes context metadata on its native endpoint, even when the
  // OpenAI-compatible /v1/models response does not include it.
  try {
    const parsed = new URL(baseUrl);
    if (['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) {
      const native = await workbenchHttpRequest('POST', `${parsed.protocol}//${parsed.host}/api/show`, {'Content-Type': 'application/json', ...headers}, {model}, 12000);
      return readWorkbenchContext(native);
    }
  } catch {}
  return 0;
}

async function listWorkbenchModels(payload = {}) {
  const baseUrl = workbenchProviderUrl(payload.baseUrl);
  const apiKey = typeof payload.apiKey === 'string' ? payload.apiKey : '';
  const apiType = payload.apiType === 'anthropic' ? 'anthropic' : 'openai';
  if (apiKey.length > 8192 || /[\0\r\n]/.test(apiKey)) throw new Error('API Key 参数无效。');
  const result = await workbenchHttpRequest('GET', workbenchApiUrl(baseUrl, '/models'), workbenchHeaders(apiType, apiKey), undefined, 30000);
  const data = Array.isArray(result?.data) ? result.data : Array.isArray(result?.models) ? result.models : [];
  const models = data.map(item => typeof item === 'string' ? item : item?.id).filter(item => typeof item === 'string').slice(0, 200);
  const modelContexts = {};
  data.forEach(item => {
    const id = typeof item === 'string' ? item : item?.id;
    const context = readWorkbenchContext(item);
    if (id && context) modelContexts[id] = context;
  });
  const preferred = typeof payload.model === 'string' && models.includes(payload.model) ? payload.model : models[0];
  const missing = [...new Set([preferred, ...models].filter(model => model && !modelContexts[model]))].slice(0, 12);
  const details = await Promise.all(missing.map(async model => [model, await workbenchModelContext(baseUrl, apiKey, apiType, model)]));
  details.forEach(([model, context]) => { if (context) modelContexts[model] = context; });
  return {models, modelContexts};
}

async function workbenchChat(payload = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('大模型对话参数无效。');
  const provider = readWorkbenchProviders().find(item => item.id === payload.provider_id);
  if (!provider) throw new Error('请先保存并选择一个大模型配置。');
  const messages = Array.isArray(payload.messages) ? payload.messages.slice(-100) : [];
  if (!messages.length || messages.some(item => !item || !['system', 'user', 'assistant'].includes(item.role) || typeof item.content !== 'string' || item.content.length > 200000)) {
    throw new Error('对话消息格式无效。');
  }
  const model = typeof payload.model === 'string' && payload.model.trim() ? payload.model.trim() : provider.model;
  if (!model || model.length > 200 || /[\0\r\n]/.test(model)) throw new Error('模型参数无效。');
  let result;
  let choice;
  if (provider.apiType === 'anthropic') {
    const system = messages.filter(item => item.role === 'system').map(item => item.content).join('\n\n');
    const conversation = messages.filter(item => item.role !== 'system').map(item => ({role: item.role, content: item.content}));
    result = await workbenchHttpRequest('POST', workbenchApiUrl(provider.baseUrl, '/messages'), workbenchHeaders('anthropic', provider.apiKey), {
      model, ...(system ? {system} : {}), messages: conversation, max_tokens: 4096, stream: false,
    }, 600000);
    choice = Array.isArray(result?.content) ? result.content.filter(item => item?.type === 'text').map(item => item.text).join('') : result?.content;
  } else {
    result = await workbenchHttpRequest('POST', workbenchApiUrl(provider.baseUrl, '/chat/completions'), workbenchHeaders('openai', provider.apiKey), {model, messages, stream: false}, 600000);
    choice = result?.choices?.[0]?.message?.content;
  }
  if (typeof choice !== 'string') throw new Error('大模型返回中没有可显示的回答。');
  return {content: choice, model: result?.model || model, provider_id: provider.id};
}

async function testWorkbenchProvider(payload = {}) {
  const baseUrl = workbenchProviderUrl(payload.baseUrl);
  const apiType = payload.apiType === 'anthropic' ? 'anthropic' : 'openai';
  const apiKey = typeof payload.apiKey === 'string' ? payload.apiKey : '';
  const model = typeof payload.model === 'string' ? payload.model.trim() : '';
  if (apiKey.length > 8192 || /[\0\r\n]/.test(apiKey) || !model || model.length > 200 || /[\0\r\n]/.test(model)) throw new Error('请填写有效的模型参数。');
  const started = Date.now();
  let result;
  let content;
  if (apiType === 'anthropic') {
    result = await workbenchHttpRequest('POST', workbenchApiUrl(baseUrl, '/messages'), workbenchHeaders('anthropic', apiKey), {
      model, max_tokens: 16, messages: [{role: 'user', content: '只回复 OK'}], stream: false,
    }, 120000);
    content = Array.isArray(result?.content) ? result.content[0]?.text : result?.content;
  } else {
    result = await workbenchHttpRequest('POST', workbenchApiUrl(baseUrl, '/chat/completions'), workbenchHeaders('openai', apiKey), {
      model, messages: [{role: 'user', content: '只回复 OK'}], max_tokens: 16, stream: false,
    }, 120000);
    content = result?.choices?.[0]?.message?.content;
  }
  if (typeof content !== 'string') throw new Error('服务返回中没有文本结果。');
  return {ok: true, latencyMs: Date.now() - started, model, contextSize: readWorkbenchContext(result)};
}

const RUN_LANGUAGE_ALIASES = new Map([
  ['py', 'python'], ['python3', 'python'], ['bash', 'shell'], ['sh', 'shell'], ['zsh', 'shell'],
  ['js', 'javascript'], ['node', 'javascript'], ['c++', 'cpp'], ['cc', 'cpp'], ['cxx', 'cpp'],
  ['htm', 'html'],
]);
const RUN_LANGUAGE_CONFIG = {
  python: {extension: 'py', entry: 'main.py'}, shell: {extension: 'sh', entry: 'run.sh'},
  c: {extension: 'c', entry: 'main.c'}, cpp: {extension: 'cpp', entry: 'main.cpp'},
  java: {extension: 'java', entry: 'Main.java'}, javascript: {extension: 'js', entry: 'main.js'},
  html: {extension: 'html', entry: 'index.html'},
};

function normalizeRunLanguage(value) {
  const raw = String(value || '').trim().toLowerCase().replace(/^language-/, '');
  const language = RUN_LANGUAGE_ALIASES.get(raw) || raw;
  if (!RUN_LANGUAGE_CONFIG[language]) throw new Error(`暂不支持 ${raw || '未知'} 运行环境。`);
  return language;
}

function safeRunFilename(value, fallback) {
  const raw = typeof value === 'string' && value.trim() ? value.trim() : fallback;
  if (raw.length > 240 || /[\0\r\n]/.test(raw) || path.isAbsolute(raw)) throw new Error('代码文件名无效。');
  const normalized = path.normalize(raw);
  if (normalized === '.' || normalized.startsWith('..' + path.sep) || normalized === '..' || normalized.includes(path.sep + '..' + path.sep) || normalized.includes('/../') || normalized.startsWith('../')) {
    throw new Error('代码文件名只能位于运行目录内。');
  }
  return normalized;
}

function runChild(command, args, cwd, timeoutMs = 120000) {
  return new Promise(resolve => {
    const child = spawn(command, args, {cwd, env: {...process.env, CI: '1', NO_COLOR: '1'}, shell: false, windowsHide: true});
    const output = [];
    let finished = false;
    const started = Date.now();
    const finish = result => { if (finished) return; finished = true; clearTimeout(timer); resolve({...result, durationMs: Date.now() - started}); };
    const append = chunk => { output.push(String(chunk)); while (output.join('').length > 100000) output.shift(); };
    child.stdout.on('data', append); child.stderr.on('data', append);
    child.on('error', error => finish({ok: false, code: null, signal: null, output: `${output.join('')}\n${error.message}`.trim()}));
    child.on('close', (code, signal) => finish({ok: code === 0, code, signal, output: output.join('').slice(-100000)}));
    const timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch {} finish({ok: false, code: null, signal: 'SIGTERM', timedOut: true, output: `${output.join('')}\n进程超过 ${Math.ceil(timeoutMs / 1000)} 秒，已停止。`.trim()}); }, timeoutMs);
  });
}

async function runFiles({language, files, entry, installDependencies = false}) {
  const normalizedLanguage = normalizeRunLanguage(language);
  const config = RUN_LANGUAGE_CONFIG[normalizedLanguage];
  if (!Array.isArray(files) || !files.length || files.length > 100) throw new Error('至少需要一个代码文件，最多支持 100 个文件。');
  const workspace = await fsp.mkdtemp(path.join(os.tmpdir(), 'fusion-run-'));
  let keepWorkspace = false;
  try {
    for (const file of files) {
      if (!file || typeof file.content !== 'string' || file.content.length > 1000000) throw new Error('代码文件内容无效或过大。');
      const name = safeRunFilename(file.name, config.entry);
      const target = path.join(workspace, name);
      await fsp.mkdir(path.dirname(target), {recursive: true});
      await fsp.writeFile(target, file.content, {mode: 0o600});
    }
    const names = new Set(files.map(file => safeRunFilename(file.name, config.entry)));
    let selected = typeof entry === 'string' && entry.trim() ? safeRunFilename(entry, config.entry) : config.entry;
    if (!names.has(selected)) selected = [...names].find(name => name.endsWith('.' + config.extension)) || [...names][0];
    const selectedPath = path.join(workspace, selected);
    if (normalizedLanguage === 'html') {
      keepWorkspace = true;
      return {ok: true, language: normalizedLanguage, output: `已保存 HTML 文件：${selected}`, filePath: selectedPath, workspace};
    }
    const run = async (command, args, timeout = 120000) => {
      if (!commandAvailable(command)) throw new Error(`未找到 ${command}，请先安装对应运行环境。`);
      return runChild(command, args, workspace, timeout);
    };
    if (installDependencies && normalizedLanguage === 'python' && names.has('requirements.txt')) {
      const python = commandAvailable('python3') ? 'python3' : 'python';
      const deps = await run(python, ['-m', 'pip', 'install', '-r', 'requirements.txt'], 180000);
      if (!deps.ok) return {ok: false, language: normalizedLanguage, phase: 'install', ...deps, workspace};
    }
    if (installDependencies && normalizedLanguage === 'javascript' && names.has('package.json')) {
      const deps = await run('npm', ['install', '--no-audit', '--no-fund'], 300000);
      if (!deps.ok) return {ok: false, language: normalizedLanguage, phase: 'install', ...deps, workspace};
    }
    let result;
    if (normalizedLanguage === 'python') result = await run(commandAvailable('python3') ? 'python3' : 'python', [selected]);
    else if (normalizedLanguage === 'shell') result = await run('bash', [selected]);
    else if (normalizedLanguage === 'javascript') result = await run('node', [selected]);
    else if (normalizedLanguage === 'c') {
      const build = await run('gcc', [selected, '-o', '.fusion-app']);
      result = build.ok ? await run('./.fusion-app', []) : build;
    } else if (normalizedLanguage === 'cpp') {
      const build = await run('g++', [selected, '-std=c++17', '-o', '.fusion-app']);
      result = build.ok ? await run('./.fusion-app', []) : build;
    } else if (normalizedLanguage === 'java') {
      const build = await run('javac', [...names].filter(name => name.endsWith('.java')));
      if (!build.ok) result = build;
      else {
        const className = path.basename(selected, '.java');
        result = await run('java', ['-cp', path.dirname(selectedPath), className]);
      }
    }
    return {language: normalizedLanguage, selected, workspace, ...result};
  } catch (error) {
    return {ok: false, language: normalizedLanguage, output: error.message, workspace};
  } finally {
    if (!keepWorkspace) {
      try { await fsp.rm(workspace, {recursive: true, force: true}); } catch {}
    }
  }
}

async function runCode(payload = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('代码运行参数无效。');
  const language = normalizeRunLanguage(payload.language);
  const config = RUN_LANGUAGE_CONFIG[language];
  const content = typeof payload.content === 'string' ? payload.content : '';
  if (!content || content.length > 1000000) throw new Error('代码内容为空或过大。');
  const name = safeRunFilename(payload.filename, config.entry);
  return runFiles({language, files: [{name, content}], entry: name, installDependencies: payload.installDependencies === true});
}

async function runProject(payload = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('项目运行参数无效。');
  return runFiles({language: payload.language, files: payload.files, entry: payload.entry, installDependencies: payload.installDependencies === true});
}

function commandAvailable(command) {
  try { execFileSync('which', [command], {stdio: 'ignore'}); return true; } catch { return false; }
}

function launchEmbeddedWorkbenchTerminal({kind, cwd, command, args, env, model, provider, tabId}) {
  const sessionId = `workbench-terminal-${Date.now().toString(36)}-${(++workbenchTerminalSerial).toString(36)}`;
  const process = spawn(command, args, {cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true});
  const item = {process, sessionId, kind, cwd, tabId: typeof tabId === 'string' ? tabId : ''};
  workbenchTerminals.set(sessionId, item);
  const emit = (type, extra = {}) => notify({type, session_id: sessionId, kind, cwd: item.cwd, tab_id: item.tabId, ...extra});
  process.stdout.on('data', chunk => emit('workbench-terminal-output', {stream: 'stdout', data: String(chunk)}));
  process.stderr.on('data', chunk => emit('workbench-terminal-output', {stream: 'stderr', data: String(chunk)}));
  process.stdin.on('error', error => emit('workbench-terminal-state', {state: 'error', message: error.message}));
  process.on('error', error => emit('workbench-terminal-state', {state: 'error', message: error.message}));
  process.on('close', (code, signal) => {
    workbenchTerminals.delete(sessionId);
    emit('workbench-terminal-state', {state: 'closed', code, signal});
  });
  emit('workbench-terminal-state', {state: 'started', command, model: model || null, provider_id: provider?.id || null});
  return {ok: true, embedded: true, session_id: sessionId, kind, cwd, provider_id: provider?.id || null, model: model || null};
}

function writeWorkbenchTerminal(payload = {}) {
  const sessionId = typeof payload.session_id === 'string' ? payload.session_id : '';
  const text = typeof payload.text === 'string' ? payload.text : '';
  if (!sessionId || text.length > 100000 || /[\0]/.test(text)) throw new Error('终端输入无效。');
  const item = workbenchTerminals.get(sessionId);
  if (!item || item.process.killed || !item.process.stdin.writable) return {ok: false};
  item.process.stdin.write(text);
  return {ok: true};
}

function stopWorkbenchTerminal(payload = {}) {
  const sessionId = typeof payload.session_id === 'string' ? payload.session_id : '';
  const item = workbenchTerminals.get(sessionId);
  if (!item) return {ok: false};
  item.process.kill('SIGTERM');
  return {ok: true};
}

function launchWorkbenchTool(payload = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('工作台启动参数无效。');
  const kind = ['claude', 'hermes', 'codex'].includes(payload.kind) ? payload.kind : '';
  if (!kind) throw new Error('未知的工作台工具。');
  if (typeof payload.cwd === 'string' && /[\0\r\n]/.test(payload.cwd)) throw new Error('工作目录参数无效。');
  const cwd = typeof payload.cwd === 'string' && payload.cwd.trim() ? path.resolve(payload.cwd.trim()) : ROOT;
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error('工作目录不存在。');
  const model = typeof payload.model === 'string' ? payload.model.trim() : '';
  if (model.length > 200 || /[\0\r\n]/.test(model)) throw new Error('模型参数无效。');
  const providerId = typeof payload.provider_id === 'string' ? payload.provider_id : '';
  const provider = providerId ? readWorkbenchProviders().find(item => item.id === providerId) : null;
  if (providerId && !provider) throw new Error('所选 Provider 不存在，请重新选择。');
  if (kind === 'claude' && provider && provider.apiType !== 'anthropic') throw new Error('Claude Code 需要 Anthropic 兼容 Provider，请选择对应配置。');
  if (kind === 'hermes' && provider && provider.apiType !== 'openai') throw new Error('Hermes 需要 OpenAI 兼容 Provider，请选择对应配置。');
  const selectedModel = model || provider?.model || '';
  const command = kind === 'claude' ? 'claude' : kind === 'hermes' ? 'hermes' : 'codex';
  if (!commandAvailable(command)) throw new Error(`未找到 ${command} CLI，请先安装后再打开工作台。`);
  const env = {...process.env};
  let hermesHome = null;
  if (kind === 'claude' && provider) {
    env.ANTHROPIC_BASE_URL = provider.baseUrl;
    env.ANTHROPIC_API_KEY = provider.apiKey;
    env.ANTHROPIC_AUTH_TOKEN = provider.apiKey;
  }
  if (kind === 'hermes' && provider) {
    hermesHome = path.join(DATA, 'workbench-hermes', provider.id);
    fs.mkdirSync(hermesHome, {recursive: true, mode: 0o700});
    const quoteYaml = value => JSON.stringify(String(value || ''));
    const hermesBaseUrl = `${provider.baseUrl}${provider.baseUrl.endsWith('/v1') ? '' : '/v1'}`;
    fs.writeFileSync(path.join(hermesHome, 'config.yaml'), [
      'model:', `  default: ${quoteYaml(selectedModel || 'gpt-4o-mini')}`, '  provider: custom',
      `  base_url: ${quoteYaml(hermesBaseUrl)}`,
      `  api_key: ${quoteYaml(provider.apiKey)}`, '',
    ].join('\n'), {mode: 0o600});
    try { fs.chmodSync(path.join(hermesHome, 'config.yaml'), 0o600); } catch {}
    env.HERMES_HOME = hermesHome;
  }
  const args = kind === 'claude'
    ? ['--add-dir', cwd, ...(selectedModel ? ['--model', selectedModel] : [])]
    : kind === 'hermes'
      ? ['chat', '--cli', ...(selectedModel ? ['--model', selectedModel, '--provider', 'custom'] : [])]
      : [...(selectedModel ? ['--model', selectedModel] : [])];
  if (payload.embedded === true) return launchEmbeddedWorkbenchTerminal({kind, cwd, command, args, env, model: selectedModel, provider, tabId: payload.tab_id});
  const candidates = [
    ['gnome-terminal', ['--working-directory', cwd, '--', command, ...args]],
    ['konsole', ['--workdir', cwd, '-e', command, ...args]],
    ['x-terminal-emulator', ['-e', command, ...args]],
    ['xterm', ['-e', command, ...args]],
  ];
  let lastError = null;
  for (const [terminal, terminalArgs] of candidates) {
    if (!commandAvailable(terminal)) continue;
    try {
      const child = spawn(terminal, terminalArgs, {cwd, detached: true, stdio: 'ignore', env});
      child.unref();
      return {ok: true, kind, terminal, provider_id: provider?.id || null, model: selectedModel || null};
    } catch (error) { lastError = error; }
  }
  throw new Error(lastError ? `未能启动终端：${lastError.message}` : '未找到可用的终端模拟器。');
}

async function openWorkbenchWeb(payload = {}) {
  if (typeof payload.url !== 'string' || payload.url.length > 4096 || /[\r\n]/.test(payload.url)) throw new Error('网页地址无效。');
  let parsed;
  try { parsed = new URL(payload.url); } catch { throw new Error('网页地址无效。'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('网页地址必须是 HTTP(S) 地址，且不能包含账号密码。');
  const url = parsed.toString();
  await shell.openExternal(url);
  return {ok: true, url};
}

async function openWorkbenchTarget(payload = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('终端目标无效。');
  const target = typeof payload.target === 'string' ? payload.target.trim() : '';
  if (!target || target.length > 8192 || /[\0\r\n]/.test(target)) throw new Error('终端目标无效。');
  if (/^https?:\/\//i.test(target)) {
    let parsed;
    try { parsed = new URL(target); } catch { throw new Error('网页地址无效。'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('网页地址必须是 HTTP(S) 地址，且不能包含账号密码。');
    const url = parsed.toString();
    await shell.openExternal(url);
    return {ok: true, kind: 'url', target: url};
  }
  if (/^file:\/\//i.test(target)) {
    let parsed;
    try { parsed = new URL(target); } catch { throw new Error('文件地址无效。'); }
    if (parsed.protocol !== 'file:' || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('文件地址无效。');
    let filePath;
    try { filePath = fileURLToPath(parsed); } catch { throw new Error('文件地址无效。'); }
    if (!filePath || /[\0\r\n]/.test(filePath)) throw new Error('文件地址无效。');
    if (!fs.existsSync(filePath)) throw new Error(`文件或目录不存在：${filePath}`);
    const result = await shell.openPath(filePath);
    if (result) throw new Error(`无法打开路径：${result}`);
    return {ok: true, kind: 'path', target: filePath};
  }
  const cwdInput = typeof payload.cwd === 'string' && payload.cwd.trim() ? payload.cwd.trim() : ROOT;
  if (cwdInput.length > 4096 || /[\0\r\n]/.test(cwdInput)) throw new Error('终端工作目录无效。');
  const cwdExpanded = cwdInput === '~' ? os.homedir() : /^~[\\/]/.test(cwdInput) ? path.join(os.homedir(), cwdInput.slice(2)) : cwdInput;
  const cwd = path.resolve(cwdExpanded);
  const expanded = target === '~'
    ? os.homedir()
    : /^~[\\/]/.test(target)
      ? path.join(os.homedir(), target.slice(2))
      : target;
  const filePath = path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(cwd, expanded);
  if (!fs.existsSync(filePath)) throw new Error(`文件或目录不存在：${filePath}`);
  const result = await shell.openPath(filePath);
  if (result) throw new Error(`无法打开路径：${result}`);
  return {ok: true, kind: 'path', target: filePath};
}

function safeWorkbenchWebURL(value) {
  try {
    const parsed = new URL(value);
    return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password && !/[\r\n]/.test(value);
  } catch { return false; }
}

function safeWorkbenchWebNavigation(value) {
  return value === 'about:blank' || safeWorkbenchWebURL(value);
}

/**
 * 网页标签允许用户把应用外复制的文本粘贴到聊天输入框。除了放行
 * Clipboard API 权限，再用 Electron 原生 insertText 兜底，兼容把 Ctrl+V
 * 交给自定义编辑器处理的网页。
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
    if (input?.type !== 'keyDown' || !modifier || key !== 'v' || input?.alt) return;
    let text = '';
    try { text = clipboard.readText(); } catch { return; }
    // 空剪贴板交给网页自己的处理逻辑（例如图片粘贴）。
    if (!text) return;
    event.preventDefault();
    try { contents.insertText(text); } catch { /* 页面刚好关闭时忽略 */ }
  });
}

function workbenchWebBounds(value) {
  if (!value || typeof value !== 'object') throw new Error('网页区域参数无效。');
  const bounds = {};
  for (const key of ['x', 'y', 'width', 'height']) {
    const number = Number(value[key]);
    if (!Number.isFinite(number) || number < 0 || number > 10000) throw new Error('网页区域参数无效。');
    bounds[key] = Math.round(number);
  }
  if (bounds.width < 120 || bounds.height < 100) throw new Error('网页区域太小。');
  return bounds;
}

function createWorkbenchWebView() {
  if (workbenchWebView) return workbenchWebView;
  const ses = session.fromPartition('persist:fusion-workbench-web');
  ses.on('will-download', event => event.preventDefault());
  const view = new WebContentsView({webPreferences: {
    session: ses, nodeIntegration: false, nodeIntegrationInSubFrames: false,
    contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false,
    backgroundThrottling: false, spellcheck: false, navigateOnDragDrop: false,
  }});
  view.setVisible(false);
  const wc = view.webContents;
  installWebClipboardSupport(wc);
  // Claude's Google OAuth flow rejects Electron's default user-agent in some
  // account configurations. Keep the real Chromium version while omitting
  // the Electron token so the sign-in page is treated as a normal browser.
  try { wc.setUserAgent(wc.getUserAgent().replace(/\sElectron\/[^\s]+/i, '')); } catch {}
  // OAuth providers (notably Google) complete authentication in a popup and
  // then close it through window.opener. Denying every popup leaves the main
  // page at a blank intermediate document, so allow only safe web destinations
  // and keep the popup in this persistent session.
  wc.setWindowOpenHandler(({url}) => safeWorkbenchWebNavigation(url) ? {
    action: 'allow',
    overrideBrowserWindowOptions: {parent: win, width: 520, height: 720, autoHideMenuBar: true},
  } : {action: 'deny'});
  wc.on('did-create-window', popup => {
    popup.setMenuBarVisibility(false);
    popup.webContents.setWindowOpenHandler(({url}) => safeWorkbenchWebNavigation(url) ? {action: 'allow'} : {action: 'deny'});
    popup.webContents.on('will-navigate', (event, url) => { if (!safeWorkbenchWebNavigation(url)) event.preventDefault(); });
    popup.webContents.on('will-redirect', (event, url) => { if (!safeWorkbenchWebNavigation(url)) event.preventDefault(); });
  });
  wc.on('will-navigate', (event, url) => { if (!safeWorkbenchWebURL(url)) event.preventDefault(); });
  wc.on('will-redirect', (event, url) => { if (!safeWorkbenchWebURL(url)) event.preventDefault(); });
  wc.on('will-attach-webview', event => event.preventDefault());
  wc.on('did-navigate', (_event, url) => notify({type: 'workbench-web-navigate', url}));
  wc.on('did-finish-load', () => notify({type: 'workbench-web-state', state: 'ready', canGoBack: wc.canGoBack(), canGoForward: wc.canGoForward()}));
  wc.on('did-navigate-in-page', (_event, url, isMainFrame) => { if (isMainFrame) notify({type: 'workbench-web-navigate', url, canGoBack: wc.canGoBack(), canGoForward: wc.canGoForward()}); });
  wc.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) notify({type: 'workbench-web-state', state: 'error', message: `网页加载失败 (${code})`});
  });
  wc.on('render-process-gone', () => notify({type: 'workbench-web-state', state: 'error', message: '网页进程已退出，请重新打开。'}));
  workbenchWebView = {view, webContents: wc, url: ''};
  win.contentView.addChildView(view);
  return workbenchWebView;
}

async function setWorkbenchWeb(payload = {}) {
  if (!payload || typeof payload !== 'object' || !safeWorkbenchWebURL(payload.url)) throw new Error('网页地址必须是无凭据的 HTTP(S) 地址。');
  const bounds = workbenchWebBounds(payload.bounds);
  const item = createWorkbenchWebView();
  item.view.setBounds(bounds);
  item.view.setVisible(true);
  if (item.url !== payload.url) {
    item.url = payload.url;
    await item.webContents.loadURL(payload.url);
  }
  return {ok: true, url: item.url};
}

async function controlWorkbenchWeb(payload = {}) {
  const item = workbenchWebView;
  const action = typeof payload?.action === 'string' ? payload.action : '';
  if (!item || item.webContents.isDestroyed()) return {ok: false, canGoBack: false, canGoForward: false};
  if (action === 'back' && item.webContents.canGoBack()) item.webContents.goBack();
  else if (action === 'forward' && item.webContents.canGoForward()) item.webContents.goForward();
  else if (action === 'reload') item.webContents.reload();
  else if (action !== 'state') throw new Error('不支持的网页操作。');
  return {ok: true, url: item.webContents.getURL(), canGoBack: item.webContents.canGoBack(), canGoForward: item.webContents.canGoForward()};
}

function hideWorkbenchWeb() {
  if (workbenchWebView) workbenchWebView.view.setVisible(false);
  return {ok: true};
}

function ipc(name, handler) {
  ipcMain.handle(`fusion:${name}`, async (event, payload) => { verifySender(event); return handler(payload); });
}
function registerIPC() {
  ipc('request', async payload => {
    if (!payload || !['GET', 'POST', 'PUT'].includes(payload.method) || typeof payload.path !== 'string') throw new Error('Invalid API request.');
    const routes = {
      GET: /^(?:\/health|\/internal\/(?:config|status|history(?:\/[a-zA-Z0-9_-]{1,100})?)|\/v1\/models|\/v1\/progress\/[0-9a-f-]{36}(?:\?after=\d{1,7})?)$/,
      POST: /^(?:\/v1\/chat\/completions|\/internal\/cancel)$/,
      PUT: /^\/internal\/config$/,
    };
    if (!routes[payload.method].test(payload.path)) throw new Error('This API route is not exposed to the UI.');
    if (payload.progressId !== undefined && (payload.method !== 'POST' || payload.path !== '/v1/chat/completions' ||
        typeof payload.progressId !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(payload.progressId))) throw new Error('Invalid progress correlation ID.');
    if (JSON.stringify(payload.body ?? null).length > 3000000) throw new Error('Request is too large.');
    if (browserLogin?.busy && ((payload.method === 'PUT' && payload.path === '/internal/config') || payload.path === '/v1/chat/completions')) throw new LoginError('BUSY');
    if (payload.path === '/v1/chat/completions' && payload.body?.stream) throw new Error('Desktop renderer uses non-stream responses.');
    const priorConfigSerial = appliedConfigSerial;
    const changingConfig = payload.method === 'PUT' && payload.path === '/internal/config';
    if (changingConfig) pendingConfigRequests++;
    let response;
    try { response = await requestLocal(payload.method, payload.path, payload.body, payload.path === '/v1/chat/completions' ? 3600000 : 15000, payload.path !== '/health', payload.progressId, 'fusion_chat'); }
    finally { if (changingConfig) pendingConfigRequests--; }
    if (payload.method === 'PUT' && payload.path === '/internal/config') {
      // The HTTP response can beat WS configuration delivery. The UI immediately selects
      // newly enabled tabs, so don't resolve until their views and proxies really exist.
      const wanted = JSON.stringify(response);
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        if (appliedConfigSerial > priorConfigSerial && JSON.stringify(config) === wanted) {
          await configuration;
          if (JSON.stringify(config) === wanted) return response;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error('配置已保存，但网页配置尚未应用完成。请等待桥接恢复后重新打开设置。');
    }
    return response;
  });
  ipc('showProvider', id => { if (typeof id !== 'string' || !providers.has(id)) throw new Error('Unknown provider.'); return providerLayout.showProvider(id); });
  ipc('openRecoveryProvider', id => {
    if (typeof id !== 'string' || !providers.has(id) || !canOpenRecoveryProvider(id)) throw new Error('该模型当前没有等待人工重试的活动任务。');
    return providerLayout.showRecoveryProvider(id);
  });
  ipc('setBounds', bounds => providerLayout.setBounds(bounds));
  ipc('setLayout', payload => providerLayout.setLayout(payload));
  ipc('diagnoseSend', async id => {
    if (typeof id !== 'string' || !providers.has(id)) throw new Error('Unknown provider.');
    const item = providers.get(id);
    if (browserLogin?.busy || item.adapter.active) throw new Error('该模型正在执行任务，请结束后检测发送按钮。');
    return item.adapter.diagnoseSend();
  });
  ipc('reloadProvider', async id => {
    if (browserLogin?.busy) throw new LoginError('BUSY');
    if (typeof id !== 'string' || !providers.has(id)) throw new Error('Unknown provider.');
    const item = providers.get(id);
    if (item.adapter.active) throw new Error('该模型正在生成，暂时不能刷新。');
    await item.view.webContents.loadURL(item.provider.url);
    return { ok: true };
  });
  ipc('listBrowserProfiles', () => browserLogin.listProfiles());
  const importLogin = async (method, payload) => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new LoginError('INVALID_REQUEST');
    const report = await browserLogin[method](payload);
    if (!report.canceled) providerStatus(report.provider_id, 'ready', `已导入 ${report.imported} 项 Cookie；请在网页确认登录。`);
    return report;
  };
  ipc('importBrowserLogin', payload => importLogin('importBrowser', payload));
  ipc('importLoginFile', payload => importLogin('importFile', payload));
  ipc('saveMarkdown', async payload => {
    if (!payload || typeof payload.content !== 'string' || payload.content.length > 16000000 || typeof payload.name !== 'string') throw new Error('Invalid Markdown export.');
    const name = path.basename(payload.name).replace(/[^\p{L}\p{N}_. -]/gu, '_').slice(0, 100) || 'reply.md';
    const result = await dialog.showSaveDialog(win, { defaultPath: name.endsWith('.md') ? name : `${name}.md`, filters: [{ name: 'Markdown', extensions: ['md'] }] });
    if (result.canceled || !result.filePath) return { canceled: true };
    await fsp.writeFile(result.filePath, payload.content, { mode: 0o600 });
    return { canceled: false, filePath: result.filePath };
  });
  ipc('copyText', async text => { if (typeof text !== 'string' || text.length > 16000000) throw new Error('Invalid clipboard text.'); await clipboard.writeText(text); });
  ipc('runtimeInfo', () => ({ baseUrl: `${BASE}/v1`, token, dataDir: DATA, version: app.getVersion() }));
  ipc('launchDesktopAgent', launchDesktopAgent);
  ipc('listWorkbenchProviders', () => ({providers: readWorkbenchProviders()}));
  ipc('saveWorkbenchProviders', payload => ({providers: writeWorkbenchProviders(payload?.providers)}));
  ipc('listWorkbenchModels', listWorkbenchModels);
  ipc('testWorkbenchProvider', testWorkbenchProvider);
  ipc('workbenchChat', workbenchChat);
  ipc('runCode', runCode);
  ipc('runProject', runProject);
  ipc('launchWorkbenchTool', launchWorkbenchTool);
  ipc('writeWorkbenchTerminal', writeWorkbenchTerminal);
  ipc('stopWorkbenchTerminal', stopWorkbenchTerminal);
  ipc('openWorkbenchTarget', openWorkbenchTarget);
  ipc('openWorkbenchWeb', openWorkbenchWeb);
  ipc('setWorkbenchWeb', setWorkbenchWeb);
  ipc('controlWorkbenchWeb', controlWorkbenchWeb);
  ipc('hideWorkbenchWeb', hideWorkbenchWeb);
}

async function shutdown() {
  closing = true;
  browserLogin?.cancel();
  clearTimeout(reconnectTimer); clearInterval(pingTimer);
  for (const job of runningJobs.values()) job.controller.abort();
  if (socket) { socket.removeAllListeners('close'); socket.terminate(); socket = undefined; }
  for (const item of providers.values()) {
    try { item.view.webContents.session.flushStorageData(); } catch {}
  }
  providerLayout?.shutdown();
  if (workbenchWebView) {
    try { win?.contentView.removeChildView(workbenchWebView.view); } catch {}
    try { workbenchWebView.webContents.close(); } catch {}
    workbenchWebView = undefined;
  }
  for (const item of workbenchTerminals.values()) {
    try { item.process.kill('SIGTERM'); } catch {}
  }
  workbenchTerminals.clear();
  providers.clear();
  if (child && !backendExited) {
    child.kill('SIGTERM');
    await new Promise(resolve => {
      const timer = setTimeout(() => { if (!backendExited) child.kill('SIGKILL'); resolve(); }, 3000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
  log('shutdown'); shutdownComplete = true;
}

const locked = app.requestSingleInstanceLock();
if (!locked) app.quit();
else {
  app.on('second-instance', () => { if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (shutdownComplete) return;
    event.preventDefault();
    if (!closing) void shutdown().finally(() => app.quit());
  });
  app.whenReady().then(async () => {
    initializeFiles();
    log('app_start', { version: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node, platform: process.platform, arch: process.arch, log_dir: log.directory, data_dir: DATA, no_sandbox: app.commandLine.hasSwitch('no-sandbox') });
    await startBackend();
    initializeBrowserLogin();
    registerIPC();
    win = new BrowserWindow({ width: 1500, height: 980, minWidth: 1000, minHeight: 680, title: 'MultiLLM Fusion', backgroundColor: '#101521',
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, navigateOnDragDrop: false },
    });
    win.setMenuBarVisibility(false);
    providerLayout = new ProviderLayout({ mainWindow: win, createWindow: options => new BaseWindow(options),
      isBusy: () => !!(runningJobs.size || browserLogin?.busy || pendingConfigurations || pendingConfigRequests),
      isMaintenance: () => !!(browserLogin?.busy || pendingConfigurations || pendingConfigRequests),
      canRecover: canOpenRecoveryProvider,
      onStatus: notify, log,
      getFocusedWebContents: () => webContents.getFocusedWebContents(),
      onInputInterrupted: (job, reason) => runningJobs.get(job.job_id)?.controller.abort(reason),
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event, url) => { if (url !== UI_URL) event.preventDefault(); });
    win.webContents.on('will-attach-webview', event => event.preventDefault());
    win.on('resize', layoutProviders);
    win.on('restore', () => providerLayout.resume());
    win.on('minimize', () => { if (providerLayout.state.mode !== 'windows') providerLayout.suspend(); });
    // Auxiliary windows may still exist, so closing the control window explicitly
    // runs the normal shutdown path instead of waiting for window-all-closed.
    win.on('close', event => { if (!closing) { event.preventDefault(); app.quit(); } });
    win.webContents.on('did-finish-load', () => {
      for (const [id, item] of providers) notify({ type: 'provider', provider_id: id, ...item.status });
      bridgeStatus(socket?.readyState === WebSocket.OPEN ? 'connected' : 'connecting', '请先在两个网页标签中手动登录，再发送消息。');
    });
    await applyConfig(config);
    await win.loadFile(UI_PATH);
    connectBridge();
  }).catch(error => {
    log('startup_error', { code: error.code || 'startup_failed' });
    dialog.showErrorBox('MultiLLM Fusion 启动失败', error.message || '未知错误，请从终端启动以检查依赖。');
    app.quit();
  });
}
