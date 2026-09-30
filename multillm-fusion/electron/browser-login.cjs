'use strict';

// Session material stays in the main process and the selected provider's sandbox.
// This module deliberately has no Electron import so fake sessions can test it.
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const SITES = require('../browser-login-sites.json');
const MAX_OUTPUT = 16 * 1024 * 1024;
const MAX_SNAPSHOT = 2 * 1024 * 1024;
const MAX_STORAGE = 512 * 1024;
const STORAGE_WORLD = 998;
const MESSAGES = {
  INVALID_REQUEST: '登录导入请求无效。', INVALID_PROVIDER: '请选择已启用、网址属于该模型官方域名的模型。',
  PROFILE_NOT_FOUND: '浏览器配置已不存在，请重新检测。', SOURCE_UNAVAILABLE: '无法读取选定的浏览器配置，请检查文件权限或改用扩展导出。',
  DATABASE_BUSY: '浏览器数据库忙，请正常退出源浏览器后重试，或使用扩展导出登录文件。',
  DATABASE_FORMAT: '无法识别浏览器数据库格式，请使用扩展导出登录文件。', SOURCE_TOO_LARGE: '浏览器数据过大，请使用扩展导出登录文件。',
  DEPENDENCY_MISSING: '缺少 Chromium 解密依赖，请运行 ./run.sh 安装，或使用扩展导出登录文件。',
  DECRYPTION_FAILED: '部分 Cookie 无法解密；可允许系统密钥环提示，或使用扩展导出登录文件。',
  UNSUPPORTED_PLATFORM: '此登录导入功能仅支持 Linux。', INTERNAL_ERROR: '登录数据读取失败，请使用扩展导出登录文件。',
  PERSISTED_STATE_ONLY: '数据库导入仅包含已持久化的 Cookie；源浏览器未写入的数据可能缺失。',
  ISOLATED_COOKIES_SKIPPED: '已跳过容器、隐私窗口或其他隔离上下文的 Cookie。',
  PARTITIONED_COOKIES_SKIPPED: '已跳过无法保持分区隔离的 Cookie。', EXPIRED_COOKIES_SKIPPED: '已跳过过期 Cookie。',
  INVALID_COOKIES_SKIPPED: '已跳过无效或不属于该模型域名的 Cookie。',
  UNSUPPORTED_ENCRYPTION: '部分 Cookie 使用当前不支持的加密格式，请使用扩展导出登录文件。',
  PROFILE_DISCOVERY_PARTIAL: '部分浏览器配置不可读取，检测结果可能不完整。',
  BUSY: '正在生成、修改配置或导入登录信息，请完成后重试。', BRIDGE_UNAVAILABLE: '网页桥接尚未连接，请连接后重试。',
  IMPORT_ABORTED: '桥接中断或导入超时，已停止安排新的写入；已提交的浏览器操作可能完成，已导入的数据会保留，请确认网页状态后重试。',
  HELPER_FAILED: '浏览器登录读取程序未正常完成，请检查 Python 环境或使用扩展导出登录文件。',
  INVALID_SNAPSHOT: '登录文件格式不正确，或目标模型不匹配；请使用随附扩展重新导出。',
  SNAPSHOT_TOO_LARGE: '登录文件超过 2 MiB 或网页存储超过 512 KiB，请重新导出较小的登录文件。',
  SNAPSHOT_UNAVAILABLE: '无法读取选定的登录文件。', COOKIE_SET_FAILED: '部分 Cookie 被目标浏览器拒绝，已保留其他导入结果。',
  STORAGE_ORIGIN_SKIPPED: '网页存储的来源与配置网址不一致，或登录跳转到了其他来源；已跳过网页存储。',
  STORAGE_IMPORT_FAILED: '部分网页存储无法导入，请在目标网页手动登录。',
  PAGE_LOAD_FAILED: '登录信息已写入，但模型网页加载失败，请检查网络并刷新。',
  PAGE_PREPARE_FAILED: '无法暂停目标模型网页，尚未导入登录信息。',
  COOKIE_FLUSH_FAILED: 'Cookie 已导入，但写入磁盘失败；本次登录可能无法在重启后保留。',
  MAINTENANCE_FAILED: '暂时无法锁定网页会话，请等待当前任务完成并确认桥接连接。',
  MAINTENANCE_RELEASE_FAILED: '导入已结束，但后端锁释放失败；桥接将重新连接以恢复。',
  SOURCE_WARNING: '源浏览器或导出文件报告部分登录状态无法复制，请在网页确认登录。',
  EXT_PARTITIONED_SKIPPED: '导出时已跳过分区 Cookie。', EXT_COOKIE_CONTEXT_SKIPPED: '导出时已跳过容器或其他隔离上下文的 Cookie。',
  EXT_COOKIE_INVALID_SKIPPED: '导出时已跳过无效 Cookie。', EXT_COOKIE_READ_FAILED: '扩展未能读取部分 Cookie，请在网页确认登录。',
  EXT_STORAGE_UNAVAILABLE: '扩展无法读取该页的网页存储；仅导入可用的 Cookie。', EXT_STORAGE_TOO_LARGE: '导出时网页存储超过大小限制，未包含在登录文件中。',
};

class LoginError extends Error {
  constructor(code) { super(MESSAGES[code] || MESSAGES.INTERNAL_ERROR); this.name = 'LoginError'; this.code = code; }
}
const warning = code => ({ code: MESSAGES[code] ? code : 'SOURCE_WARNING', message: MESSAGES[code] || MESSAGES.SOURCE_WARNING });
function safeWarnings(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.slice(0, 50).map(item => typeof item?.code === 'string' && MESSAGES[item.code.toUpperCase()] ? item.code.toUpperCase() : 'SOURCE_WARNING'))].map(warning);
}
function addWarning(report, code) { if (!report.warnings.some(item => item.code === code)) report.warnings.push(warning(code)); }
function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function untilAbort(promise, signal) {
  return new Promise((resolve, reject) => {
    const aborted = () => { signal.removeEventListener('abort', aborted); reject(new LoginError('IMPORT_ABORTED')); };
    Promise.resolve(promise).then(value => { signal.removeEventListener('abort', aborted); resolve(value); }, error => { signal.removeEventListener('abort', aborted); reject(error); });
    if (signal.aborted) aborted(); else signal.addEventListener('abort', aborted, { once: true });
  });
}
function domainAllowed(domain, providerId) {
  if (typeof domain !== 'string' || !SITES[providerId]) return false;
  const host = domain.replace(/^\./, '').toLowerCase();
  // Do not silently repair trailing dots, whitespace or more than one leading dot.
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host) || host.includes('..')) return false;
  return SITES[providerId].domains.some(root => host === root || host.endsWith(`.${root}`));
}
function targetURL(provider) {
  if (!provider?.enabled || !SITES[provider.id]) throw new LoginError('INVALID_PROVIDER');
  let url;
  try { url = new URL(provider.url); } catch { throw new LoginError('INVALID_PROVIDER'); }
  if (url.protocol !== 'https:' || url.username || url.password || !domainAllowed(url.hostname, provider.id)) throw new LoginError('INVALID_PROVIDER');
  return url;
}

function normalizedCookie(cookie, providerId, now = Date.now() / 1000) {
  if (!plain(cookie) || !domainAllowed(cookie.domain, providerId) || typeof cookie.name !== 'string' || typeof cookie.value !== 'string' ||
      typeof cookie.path !== 'string' || !cookie.path.startsWith('/') || /[\r\n\0]/.test(cookie.name + cookie.value + cookie.path) ||
      Buffer.byteLength(cookie.name + cookie.value + cookie.path, 'utf8') > 65536 ||
      !['secure', 'httpOnly', 'hostOnly', 'session'].every(key => typeof cookie[key] === 'boolean') ||
      !['unspecified', 'no_restriction', 'lax', 'strict'].includes(cookie.sameSite)) return { reason: 'INVALID_COOKIES_SKIPPED' };
  if (cookie.partitionKey || cookie.partitioned || cookie.top_frame_site_key || cookie.firstPartyDomain || cookie.originAttributes ||
      (cookie.storeId && !['0', 'firefox-default'].includes(cookie.storeId))) return { reason: 'PARTITIONED_COOKIES_SKIPPED' };
  if (!cookie.session && (!Number.isFinite(cookie.expirationDate) || cookie.expirationDate <= now)) return { reason: 'EXPIRED_COOKIES_SKIPPED' };
  if (cookie.sameSite === 'no_restriction' && !cookie.secure) return { reason: 'INVALID_COOKIES_SKIPPED' };
  if (cookie.name.startsWith('__Secure-') && !cookie.secure) return { reason: 'INVALID_COOKIES_SKIPPED' };
  if (cookie.name.startsWith('__Host-') && (!cookie.secure || !cookie.hostOnly || cookie.path !== '/')) return { reason: 'INVALID_COOKIES_SKIPPED' };
  const host = cookie.domain.replace(/^\./, '').toLowerCase();
  // URL path is not cookie path: a fixed URL avoids interpreting '?' and '#' in paths.
  const details = { url: `${cookie.secure ? 'https' : 'http'}://${host}/`, name: cookie.name, value: cookie.value,
    path: cookie.path, secure: cookie.secure, httpOnly: cookie.httpOnly, sameSite: cookie.sameSite };
  if (!cookie.hostOnly) details.domain = `.${host}`;
  if (!cookie.session) details.expirationDate = cookie.expirationDate;
  return { details };
}

function validateSnapshot(input, providerId) {
  if (!(typeof input === 'string' || Buffer.isBuffer(input)) || Buffer.byteLength(input) > MAX_SNAPSHOT) throw new LoginError('SNAPSHOT_TOO_LARGE');
  let data;
  try { data = JSON.parse(input.toString()); } catch { throw new LoginError('INVALID_SNAPSHOT'); }
  if (!plain(data) || data.format !== 'multillm-fusion-login' || data.version !== 1 || data.provider_id !== providerId ||
      !Array.isArray(data.cookies) || data.cookies.length > 10000 || (data.storage !== undefined && !Array.isArray(data.storage))) throw new LoginError('INVALID_SNAPSHOT');
  const storage = data.storage || [];
  if (Buffer.byteLength(JSON.stringify(storage), 'utf8') > MAX_STORAGE) throw new LoginError('SNAPSHOT_TOO_LARGE');
  for (const item of storage) {
    if (!plain(item) || typeof item.origin !== 'string' || !plain(item.localStorage) ||
        !Object.entries(item.localStorage).every(([key, value]) => typeof key === 'string' && typeof value === 'string')) throw new LoginError('INVALID_SNAPSHOT');
  }
  return { cookies: data.cookies, storage, warnings: safeWarnings(data.warnings), skipped: 0 };
}

async function readSnapshot(file) {
  let handle;
  try {
    handle = await fs.open(file, require('node:fs').constants.O_RDONLY | require('node:fs').constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile()) throw new LoginError('SNAPSHOT_UNAVAILABLE');
    if (stat.size > MAX_SNAPSHOT) throw new LoginError('SNAPSHOT_TOO_LARGE');
    // Bound the read even if a writer grows the file after fstat.
    const buffer = Buffer.alloc(MAX_SNAPSHOT + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > MAX_SNAPSHOT) throw new LoginError('SNAPSHOT_TOO_LARGE');
    return buffer.subarray(0, size);
  } catch (error) { throw error instanceof LoginError ? error : new LoginError('SNAPSHOT_UNAVAILABLE'); }
  finally { if (handle) await handle.close().catch(() => {}); }
}

function helperEnvironment(env = process.env) {
  // No app API token, model key, browser secret or arbitrary inherited environment.
  const names = ['PATH', 'HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_RUNTIME_DIR', 'XDG_CURRENT_DESKTOP', 'XDG_SESSION_DESKTOP', 'DESKTOP_SESSION',
    'KDE_SESSION_VERSION', 'KDE_FULL_SESSION', 'DBUS_SESSION_BUS_ADDRESS', 'DISPLAY', 'WAYLAND_DISPLAY', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR'];
  return { ...Object.fromEntries(names.filter(key => typeof env[key] === 'string').map(key => [key, env[key]])), PYTHONUNBUFFERED: '1', PYTHONUTF8: '1' };
}
function runPythonHelper({ python, root, payload, signal, timeout = payload.action === 'list' ? 10000 : 90000, spawnProcess = spawn }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new LoginError('IMPORT_ABORTED'));
    let child, timer, killTimer, done = false, outputBytes = 0, errorBytes = 0, failure;
    const chunks = [];
    const finish = (error, value) => {
      if (done) return;
      done = true; clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', abort);
      chunks.length = 0;
      error ? reject(error) : resolve(value);
    };
    const stop = code => {
      if (done || failure) return;
      failure = new LoginError(code);
      killTimer = setTimeout(() => { child?.kill('SIGKILL'); finish(failure); }, 1000);
      child?.kill('SIGTERM');
    };
    const abort = () => stop('IMPORT_ABORTED');
    try { child = spawnProcess(python, ['-m', 'backend.browser_login'], { cwd: root, env: helperEnvironment(), stdio: ['pipe', 'pipe', 'pipe'], shell: false }); }
    catch { return finish(new LoginError('HELPER_FAILED')); }
    timer = setTimeout(() => stop('IMPORT_ABORTED'), timeout);
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', chunk => { if (done || failure) return; outputBytes += chunk.length; if (outputBytes > MAX_OUTPUT) stop('HELPER_FAILED'); else chunks.push(Buffer.from(chunk)); });
    // stderr is intentionally consumed and discarded, never forwarded to logs or UI.
    child.stderr.on('data', chunk => { errorBytes += chunk.length; if (errorBytes > MAX_OUTPUT) stop('HELPER_FAILED'); });
    child.on('error', () => finish(new LoginError('HELPER_FAILED')));
    child.on('close', code => {
      if (failure) return finish(failure);
      if (code !== 0) return finish(new LoginError('HELPER_FAILED'));
      let response;
      try { response = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return finish(new LoginError('HELPER_FAILED')); }
      if (!plain(response) || response.ok !== true) return finish(new LoginError(MESSAGES[response?.error?.code] ? response.error.code : 'HELPER_FAILED'));
      finish(null, response);
    });
    child.stdin.on('error', () => stop('HELPER_FAILED'));
    child.stdin.end(JSON.stringify(payload) + '\n');
  });
}

// Runs in a dedicated isolated world. Each stage is origin-bound and operation-bound;
// the application never trusts a redirect or reuses an earlier import's marker.
// Revocation prevents future stages. Already submitted native/renderer operations
// cannot be rolled back; callers await them under the local lock before releasing it.
function storageAction(action, args) {
  const key = '__fusionLoginImport';
  if (action === 'revoke') {
    if (globalThis[key]?.id === args.id) delete globalThis[key];
    return { revoked: true };
  }
  if (location.origin !== args.origin || location.protocol !== 'https:' || Date.now() >= args.deadline) return { skipped: true, imported: 0, failed: 0 };
  if (action === 'prepare') { globalThis[key] = { id: args.id, deadline: args.deadline }; return { prepared: true }; }
  const marker = globalThis[key];
  if (!marker || marker.id !== args.id || marker.deadline !== args.deadline) return { skipped: true, imported: 0, failed: 0 };
  let imported = 0, failed = 0;
  for (const [name, value] of args.entries) {
    if (globalThis[key] !== marker || Date.now() >= marker.deadline || location.origin !== args.origin) break;
    try { localStorage.setItem(name, value); imported++; } catch { failed++; }
  }
  delete globalThis[key];
  return { imported, failed };
}

class BrowserLoginController {
  constructor(options) { this.options = options; this.active = null; }
  get busy() { return this.active !== null; }
  cancel() { this.active?.controller.abort(); }
  assertOperation(operation) {
    if (this.active !== operation || Date.now() >= operation.deadline || operation.controller.signal.aborted || !this.options.isConnectionCurrent(operation.connection)) throw new LoginError('IMPORT_ABORTED');
  }
  async listProfiles() {
    let response;
    try { response = await this.options.runHelper({ action: 'list' }); } catch (error) { throw error instanceof LoginError ? error : new LoginError('HELPER_FAILED'); }
    if (!Array.isArray(response.profiles) || response.profiles.length > 1000) throw new LoginError('HELPER_FAILED');
    const profiles = response.profiles.filter(item => plain(item) && typeof item.id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(item.id) &&
      ['chromium', 'firefox'].includes(item.family) && ['browser', 'name', 'path'].every(key => typeof item[key] === 'string' && item[key].length <= 4096))
      .map(({ id, browser, family, name, path }) => ({ id, browser, family, name, path }));
    return { ok: true, profiles, warnings: safeWarnings(response.warnings), capabilities: { chromium_decryption: response.capabilities?.chromium_decryption === true } };
  }
  async withMaintenance(providerId, work) {
    if (typeof providerId !== 'string' || !Object.hasOwn(SITES, providerId)) throw new LoginError('INVALID_PROVIDER');
    if (this.busy || !this.options.canStart()) throw new LoginError('BUSY');
    const item = this.options.getProvider(providerId);
    const url = targetURL(item?.provider);
    const connection = this.options.getConnection();
    if (!this.options.isConnectionCurrent(connection)) throw new LoginError('BRIDGE_UNAVAILABLE');
    const operation = { controller: new AbortController(), connection, item, url, id: crypto.randomUUID(), deadline: Date.now() + (this.options.timeout || 120000), lease: null };
    this.active = operation;
    this.options.onBusy?.(true);
    const timer = setTimeout(() => operation.controller.abort(), this.options.timeout || 120000);
    try {
      let lease;
      try { lease = await this.options.acquire(); } catch { this.assertOperation(operation); throw new LoginError('MAINTENANCE_FAILED'); }
      operation.lease = lease?.lease_id;
      this.assertOperation(operation);
      if (lease?.active !== true || typeof operation.lease !== 'string' || !operation.lease) throw new LoginError('MAINTENANCE_FAILED');
      // Recheck immutable target after the backend lease acknowledges.
      if (this.options.getProvider(providerId) !== item || targetURL(item.provider).href !== url.href || item.adapter?.active) throw new LoginError('BUSY');
      return await work(operation);
    } catch (error) { throw error instanceof LoginError ? error : new LoginError('INTERNAL_ERROR'); }
    finally {
      clearTimeout(timer);
      operation.controller.abort();
      if (operation.lease) {
        try { await this.options.release(operation.lease); }
        catch { this.options.onReleaseFailure?.(operation.connection); }
      }
      if (this.active === operation) { this.active = null; this.options.onBusy?.(false); }
    }
  }
  importBrowser({ profile_id, provider_id } = {}) {
    if (typeof profile_id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(profile_id)) return Promise.reject(new LoginError('INVALID_REQUEST'));
    return this.withMaintenance(provider_id, async operation => {
      const data = await untilAbort(this.options.runHelper({ action: 'extract', profile_id, provider_id }, operation.controller.signal), operation.controller.signal);
      this.assertOperation(operation);
      if (data?.ok !== true || data.provider_id !== provider_id || !Array.isArray(data.cookies) || data.cookies.length > 100000) throw new LoginError('HELPER_FAILED');
      return this.apply(operation, { cookies: data.cookies, storage: [], skipped: Number.isSafeInteger(data.skipped) && data.skipped >= 0 ? data.skipped : 0,
        warnings: safeWarnings(data.warnings) }, 'browser');
    });
  }
  importFile({ provider_id } = {}) {
    return this.withMaintenance(provider_id, async operation => {
      const selected = await untilAbort(this.options.chooseFile(), operation.controller.signal);
      this.assertOperation(operation);
      if (!selected) return { canceled: true };
      const input = await untilAbort((this.options.readSnapshot || readSnapshot)(selected), operation.controller.signal);
      this.assertOperation(operation);
      const data = validateSnapshot(input, provider_id);
      return this.apply(operation, data, 'extension');
    });
  }
  async apply(operation, data, source) {
    const { item, url, id, deadline } = operation;
    const wc = item.view.webContents;
    const report = { provider_id: item.provider.id, imported: 0, skipped: data.skipped || 0, storage_imported: 0, warnings: [...data.warnings], source, authenticated: false };
    const check = () => { this.assertOperation(operation); if (wc.isDestroyed()) throw new LoginError('IMPORT_ABORTED'); };
    const navigate = async target => {
      check();
      // Stop hung network navigations on cancellation. No site storage is injected here.
      const stopped = () => { try { wc.stop(); } catch {} };
      operation.controller.signal.addEventListener('abort', stopped, { once: true });
      try { await untilAbort(wc.loadURL(target), operation.controller.signal); check(); }
      finally { operation.controller.signal.removeEventListener('abort', stopped); }
    };
    check();
    wc.stop();
    try { await navigate('about:blank'); }
    catch (error) { check(); throw new LoginError('PAGE_PREPARE_FAILED'); }
    for (const rawCookie of data.cookies) {
      check();
      const { details, reason } = normalizedCookie(rawCookie, report.provider_id);
      if (!details) { report.skipped++; addWarning(report, reason); continue; }
      // Do not race cancellation here: drain a submitted native mutation while the
      // local lock remains held, then check before scheduling the next mutation.
      try { check(); await wc.session.cookies.set(details); report.imported++; }
      catch (error) { check(); report.skipped++; addWarning(report, 'COOKIE_SET_FAILED'); }
    }
    check();
    try { await wc.session.cookies.flushStore(); }
    catch { check(); addWarning(report, 'COOKIE_FLUSH_FAILED'); }
    check();
    try { await navigate(url.href); }
    catch { check(); addWarning(report, 'PAGE_LOAD_FAILED'); return report; }
    if (data.storage.length) {
      const storage = data.storage.filter(value => value.origin === url.origin && SITES[report.provider_id].origins?.includes(value.origin));
      if (storage.length !== data.storage.length) addWarning(report, 'STORAGE_ORIGIN_SKIPPED');
      for (const snapshot of storage) {
        check();
        let finalOrigin;
        try { finalOrigin = new URL(wc.getURL()).origin; } catch {}
        if (finalOrigin !== url.origin) { addWarning(report, 'STORAGE_ORIGIN_SKIPPED'); continue; }
        const execute = (action, entries = []) => wc.executeJavaScriptInIsolatedWorld(STORAGE_WORLD, [{ code: `(${storageAction.toString()})(${JSON.stringify(action)},${JSON.stringify({ id, origin: url.origin, deadline, entries })})` }], false);
        const revoke = () => { if (!wc.isDestroyed()) void execute('revoke').catch(() => {}); };
        operation.controller.signal.addEventListener('abort', revoke, { once: true });
        try {
          check(); const prepared = await execute('prepare'); check();
          if (prepared?.prepared !== true) { addWarning(report, 'STORAGE_ORIGIN_SKIPPED'); continue; }
          // Recheck after every await; values never leave the isolated target world.
          check(); const result = await execute('apply', Object.entries(snapshot.localStorage)); check();
          if (result?.skipped) addWarning(report, 'STORAGE_ORIGIN_SKIPPED');
          else if (!Number.isSafeInteger(result?.imported) || result.imported < 0 || result.imported > Object.keys(snapshot.localStorage).length) addWarning(report, 'STORAGE_IMPORT_FAILED');
          else { report.storage_imported += result.imported; if (result.failed) addWarning(report, 'STORAGE_IMPORT_FAILED'); }
        } catch { check(); addWarning(report, 'STORAGE_IMPORT_FAILED'); }
        finally { operation.controller.signal.removeEventListener('abort', revoke); revoke(); }
      }
      if (report.storage_imported) {
        check(); wc.session.flushStorageData(); check();
        try { await navigate(url.href); } catch { check(); addWarning(report, 'PAGE_LOAD_FAILED'); }
      }
    }
    return report;
  }
}

module.exports = { BrowserLoginController, LoginError, domainAllowed, normalizedCookie, validateSnapshot, readSnapshot, runPythonHelper, helperEnvironment, storageAction, MAX_SNAPSHOT, MAX_STORAGE };
