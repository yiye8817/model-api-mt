'use strict';

const MODES = new Set(['tabs', 'split', 'windows']);
const KEYS = ['x', 'y', 'width', 'height'];

class LayoutError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function normalizeBounds(bounds) {
  if (!bounds || Array.isArray(bounds) || !KEYS.every(key => Number.isFinite(bounds[key]) && bounds[key] >= 0 && bounds[key] <= 20000)) {
    throw new LayoutError('invalid_layout', '无效的网页区域尺寸。');
  }
  return Object.fromEntries(KEYS.map(key => [key, Math.round(bounds[key])]));
}

function clampBounds(bounds, size) {
  const width = Math.max(1, size[0]); const height = Math.max(1, size[1]);
  const x = Math.min(bounds.x, width - 1); const y = Math.min(bounds.y, height - 1);
  return { x, y, width: Math.max(1, Math.min(bounds.width, width - x)), height: Math.max(1, Math.min(bounds.height, height - y)) };
}

function overlaps(a, b) { return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height; }

// Owns the native views independently of the renderer. Reparenting always moves
// the existing WebContentsView: login state, DOM, and in-flight generation stay put.
class ProviderLayout {
  constructor({ mainWindow, createWindow, isBusy = () => false, isMaintenance = () => false, canRecover = () => false, onStatus = () => {}, onInputInterrupted = () => {}, log = () => {}, getFocusedWebContents = () => null }) {
    this.main = mainWindow;
    this.createWindow = createWindow;
    this.isBusy = isBusy;
    this.isMaintenance = isMaintenance;
    this.canRecover = canRecover;
    this.onStatus = onStatus;
    this.onInputInterrupted = onInputInterrupted;
    this.log = log;
    this.getFocusedWebContents = getFocusedWebContents;
    this.entries = new Map();
    this.state = { mode: 'tabs', panes: [], active_provider: undefined, hidden: true };
    this.lastBounds = null;
    this.queue = [];
    this.lease = null;
    this.disposed = false;
  }

  add(id, view, title) {
    if (this.disposed || this.entries.has(id)) throw new LayoutError('invalid_layout', '网页已存在或宿主已经关闭。');
    const item = { id, view, title, host: null, window: null, userHidden: false };
    this.entries.set(id, item);
    if (!this.state.active_provider) this.state.active_provider = id;
    this._move(item, this.state.mode === 'windows' ? this._window(item) : this.main);
    this.render();
  }

  setTitle(id, title) {
    const item = this.entries.get(id);
    if (item) { item.title = title; item.window?.setTitle(`${title} · MultiLLM Fusion`); }
  }

  setLayout(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !MODES.has(payload.mode) || !Array.isArray(payload.panes) ||
        payload.panes.length > 2 || (payload.hidden !== undefined && typeof payload.hidden !== 'boolean') ||
        (payload.reopen_windows !== undefined && typeof payload.reopen_windows !== 'boolean')) {
      throw new LayoutError('invalid_layout', '无效的网页布局。');
    }
    const panes = payload.panes.map(pane => {
      if (!pane || !this.entries.has(pane.provider_id)) throw new LayoutError('invalid_layout', '网页布局包含未启用的模型。');
      return { provider_id: pane.provider_id, bounds: normalizeBounds(pane.bounds) };
    });
    if (new Set(panes.map(pane => pane.provider_id)).size !== panes.length || (payload.mode === 'tabs' && panes.length > 1)) {
      throw new LayoutError('invalid_layout', '同一个模型不能同时放入两个区域。');
    }
    const active = payload.active_provider ?? this.state.active_provider ?? this.entries.keys().next().value;
    if (active !== undefined && !this.entries.has(active)) throw new LayoutError('invalid_layout', '模型未启用。');
    const changed = payload.mode !== this.state.mode;
    const membersChanged = JSON.stringify(panes.map(pane => pane.provider_id)) !== JSON.stringify(this.state.panes.map(pane => pane.provider_id));
    if ((changed || membersChanged || active !== this.state.active_provider) && (this.isBusy() || this.lease)) {
      throw new LayoutError('layout_busy', '模型任务或登录导入进行中，请完成后切换显示方式或模型。');
    }
    const hidden = payload.hidden === undefined ? false : payload.hidden;
    const visibilityChanged = hidden !== this.state.hidden;
    this.state = { mode: payload.mode, panes, active_provider: active, hidden };
    for (const pane of panes) if (pane.bounds.width > 0 && pane.bounds.height > 0) this.lastBounds = pane.bounds;
    if (changed || payload.reopen_windows) for (const item of this.entries.values()) item.userHidden = false;
    if (hidden && this.lease) this._interrupt('input_view_hidden');
    this.render();
    // This flag is only sent by the explicit "重新显示窗口" button. Ordinary
    // resize/layout updates and automatic input leases never restore OS windows.
    if (payload.reopen_windows && this.state.mode === 'windows' && !hidden) {
      for (const item of this.entries.values()) if (item.window?.isMinimized()) item.window.restore();
    }
    this._drain();
    if (changed || visibilityChanged || payload.reopen_windows) this.log('provider_layout', {
      mode: this.state.mode, hidden, payload: { panes, active_provider: active, reopen_windows: !!payload.reopen_windows },
    });
    return { ok: true, mode: this.state.mode, active_provider: active };
  }

  // Compatibility for older renderers; selecting a window is explicit user intent.
  showProvider(id) {
    if (!this.entries.has(id)) throw new LayoutError('invalid_layout', '模型未启用。');
    if (id !== this.state.active_provider && (this.isBusy() || this.lease)) throw new LayoutError('layout_busy', '模型任务或登录导入进行中，请完成后切换模型。');
    this.state.active_provider = id;
    if (this.state.mode === 'tabs' && this.state.panes.length) this.state.panes[0].provider_id = id;
    const item = this.entries.get(id);
    item.userHidden = false;
    this.render();
    if (this.state.mode === 'windows' && !this.state.hidden) {
      if (item.window.isMinimized?.()) item.window.restore();
      item.window.show(); item.window.focus(); item.view.webContents.focus();
    }
    this._drain();
    return { ok: true };
  }

  // Explicit user access to a live failed turn. The main process separately
  // authorizes the active job; ordinary tab/layout switching stays locked.
  showRecoveryProvider(id) {
    const item = this.entries.get(id);
    if (this.disposed || !item || item.view.webContents.isDestroyed()) throw new LayoutError('provider_unavailable', '模型网页已关闭。');
    if (this.isMaintenance() || !this.canRecover(id)) throw new LayoutError('recovery_unavailable', '该模型当前没有等待人工重试的任务，或正在维护浏览器。');
    if (this.lease) throw new LayoutError('layout_busy', '正在向模型发送输入，请稍候再处理网页重试。');
    if (this.state.hidden) throw new LayoutError('layout_hidden', '请先关闭设置或诊断面板，再处理网页重试。');
    if (this.state.mode === 'tabs') {
      this.state.panes = [{ provider_id: id, bounds: { ...(this.state.panes[0]?.bounds || this._fallback()) } }];
    } else if (this.state.mode === 'split' && !this.state.panes.some(pane => pane.provider_id === id)) {
      // Retain the left pane and both measured sizes; only reveal this original
      // view in the right slot, without opening/reloading any page.
      if (!this.state.panes.length) throw new LayoutError('layout_hidden', '网页显示区域尚未就绪。');
      const index = this.state.panes.length - 1;
      this.state.panes[index] = { provider_id: id, bounds: { ...this.state.panes[index].bounds } };
    }
    this.state.active_provider = id;
    item.userHidden = false;
    this.render();
    const host = this.state.mode === 'windows' ? item.window : this.main;
    if (host.isMinimized?.()) host.restore();
    host.show(); host.focus(); item.view.webContents.focus();
    const result = { ok: true, mode: this.state.mode, active_provider: id,
      panes: this.state.panes.map(pane => ({ provider_id: pane.provider_id, bounds: { ...pane.bounds } })), hidden: this.state.hidden };
    this.log('provider_recovery_opened', { provider_id: id, mode: this.state.mode });
    this.onStatus({ type: 'recovery-provider-opened', provider_id: id, layout: result });
    return result;
  }

  setBounds(bounds) {
    const next = bounds === null ? null : normalizeBounds(bounds);
    if (next) this.lastBounds = next;
    this.state.hidden = next === null;
    if (next && this.state.active_provider) this.state.panes = [{ provider_id: this.state.active_provider, bounds: next }];
    if (this.state.hidden && this.lease) this._interrupt('input_view_hidden');
    this.render(); this._drain();
    return { ok: true };
  }

  _fallback() {
    if (this.lastBounds) return this.lastBounds;
    const [width, height] = this.main.getContentSize();
    return { x: Math.floor(width / 2), y: Math.min(70, height - 1), width: Math.floor(width / 2), height: Math.max(1, height - 70) };
  }

  _window(item) {
    if (item.window && !item.window.isDestroyed()) return item.window;
    const window = this.createWindow({ width: 900, height: 900, minWidth: 420, minHeight: 360, show: false, title: `${item.title || item.id} · MultiLLM Fusion`, backgroundColor: '#101521' });
    item.window = window;
    window.setMenuBarVisibility?.(false);
    window.on('resize', () => { if (!this.disposed) this.render(); });
    window.on('restore', () => { if (!this.disposed) { this.render(); this._drain(); } });
    window.on('minimize', () => { if (this.lease?.item === item) this._interrupt('input_view_hidden'); });
    window.on('close', event => {
      if (this.disposed) return;
      event.preventDefault();
      item.userHidden = true;
      if (this.lease?.item === item) this._interrupt('input_view_hidden');
      window.hide(); item.view.setVisible(false);
      this.log('provider_window_hidden', { provider_id: item.id });
      this.onStatus({ type: 'layout-window-closed', provider_id: item.id });
    });
    return window;
  }

  _move(item, host) {
    if (item.host === host) return;
    item.view.setVisible(false);
    if (item.host && !item.host.isDestroyed()) item.host.contentView.removeChildView(item.view);
    host.contentView.addChildView(item.view);
    item.host = host;
  }

  render() {
    if (this.disposed || this.main.isDestroyed()) return;
    const normal = new Map(this.state.panes.map(pane => [pane.provider_id, pane.bounds]));
    for (const [id, item] of this.entries) {
      if (item.view.webContents.isDestroyed()) continue;
      if (this.state.mode === 'windows') {
        const window = this._window(item);
        this._move(item, window);
        const target = this.lease?.item === item ? this.lease.bounds : { x: 0, y: 0, width: window.getContentSize()[0], height: window.getContentSize()[1] };
        item.view.setBounds(clampBounds(target, window.getContentSize()));
        const visible = !this.state.hidden && !item.userHidden;
        item.view.setVisible(visible);
        if (visible) { if (!window.isVisible()) window.showInactive(); } else window.hide();
      } else {
        this._move(item, this.main);
        if (item.window && !item.window.isDestroyed()) item.window.hide();
        const isInput = this.lease?.item === item;
        const target = isInput ? this.lease.bounds : normal.get(id) || this._fallback();
        item.view.setBounds(clampBounds(target, this.main.getContentSize()));
        const normalVisible = this.state.mode === 'tabs' ? id === this.state.active_provider && normal.size > 0 : normal.has(id);
        const availablePane = !this.lease || (this.state.mode === 'split' && !overlaps(clampBounds(target, this.main.getContentSize()), clampBounds(this.lease.bounds, this.main.getContentSize())));
        item.view.setVisible(!this.state.hidden && (isInput || (normalVisible && availablePane)));
      }
    }
    // Native views cannot share keyboard focus. Bring only the leased child above
    // its siblings, without activating or raising its operating-system window.
    if (this.lease && !this.state.hidden && !this.lease.item.userHidden) {
      const item = this.lease.item;
      item.host.contentView.addChildView(item.view);
    }
  }

  _available(item) {
    if (this.disposed || this.state.hidden || item.view.webContents.isDestroyed()) return false;
    const host = this.state.mode === 'windows' ? this._window(item) : this.main;
    return !host.isDestroyed() && host.isVisible() && !host.isMinimized?.() && (this.state.mode !== 'windows' || !item.userHidden);
  }

  acquireInput({ job, signal, deadline }) {
    return new Promise((resolve, reject) => {
      const item = this.entries.get(job.provider_id);
      if (!item || this.disposed) return reject(new LayoutError('provider_unavailable', '模型网页已关闭。'));
      const end = Number.isFinite(deadline) ? deadline : Date.now() + 300000;
      const request = { item, job, signal, deadline: end, resolve, reject, timer: null, onAbort: null };
      const remove = () => { const index = this.queue.indexOf(request); if (index >= 0) this.queue.splice(index, 1); this._cleanupRequest(request); };
      request.onAbort = () => { remove(); reject(new LayoutError('cancelled', '网页输入等待已取消。')); this._drain(); };
      if (signal?.aborted) return request.onAbort();
      if (Date.now() >= end) return reject(new LayoutError('input_lease_timeout', '等待网页输入区域超时；请返回网页界面并检查窗口是否关闭或最小化。'));
      request.timer = setTimeout(() => { remove(); reject(new LayoutError('input_lease_timeout', '等待网页输入区域超时；请返回网页界面并检查窗口是否关闭或最小化。')); this._drain(); }, Math.max(1, end - Date.now()));
      signal?.addEventListener('abort', request.onAbort, { once: true });
      this.queue.push(request);
      const host = this.state.mode === 'windows' ? item.window : this.main;
      const reason = this.state.hidden ? 'layout_hidden' : item.userHidden ? 'window_closed' : host?.isMinimized?.() ? 'window_minimized' : this.lease ? 'input_busy' : 'ready';
      this.log('input_lease.queued', { job_id: job.job_id, request_id: job.request_id, provider_id: item.id, mode: this.state.mode, hidden: this.state.hidden, queue_size: this.queue.length, reason });
      this._drain();
    });
  }

  _cleanupRequest(request) {
    clearTimeout(request.timer);
    request.signal?.removeEventListener('abort', request.onAbort);
  }

  _drain() {
    if (this.disposed || this.lease) return;
    // Keep FIFO for runnable requests. A user-closed model window must not block
    // unrelated visible providers indefinitely.
    const index = this.queue.findIndex(request => this._available(request.item));
    if (index < 0) return;
    const request = this.queue.splice(index, 1)[0];
    this._cleanupRequest(request);
    if (request.signal?.aborted || Date.now() >= request.deadline) {
      request.reject(new LayoutError(request.signal?.aborted ? 'cancelled' : 'input_lease_timeout', '等待网页输入已取消或超时。'));
      this._drain(); return;
    }
    const { item, job } = request;
    const host = this.state.mode === 'windows' ? item.window : this.main;
    const pane = this.state.panes.find(pane => pane.provider_id === item.id) || this.state.panes[0];
    const bounds = this.state.mode === 'windows' ? { x: 0, y: 0, width: host.getContentSize()[0], height: host.getContentSize()[1] } : pane?.bounds || this._fallback();
    // Requests arriving through the Desktop/API path must not steal focus back
    // to the Fusion renderer when their background web task completes.  The
    // normal in-app Fusion composer keeps the historical focus restoration.
    const backgroundRequest = job.request_source === 'api' || job.request_source === 'desktop-top';
    const restorePreviousFocus = !backgroundRequest;
    const focusProviderView = !backgroundRequest;
    const lease = { item, job, bounds: { ...bounds }, previousFocus: restorePreviousFocus ? this.getFocusedWebContents() : null,
      restorePreviousFocus, started: Date.now(), interrupted: false };
    this.lease = lease;
    const release = async () => {
      if (this.lease !== lease) return;
      this.lease = null;
      try {
        this.render();
        const previous = lease.previousFocus;
        const previousFocused = typeof previous?.isFocused === 'function' ? previous.isFocused() : previous?.isFocused;
        if (lease.restorePreviousFocus && previous && !previous.isDestroyed() && !previousFocused) previous.focus();
      } catch (error) {
        this.log('input_lease.restore_failed', { job_id: job.job_id, request_id: job.request_id, provider_id: item.id, code: 'layout_restore_failed', payload: { error: error.message } });
      } finally {
        this.log('input_lease.released', { job_id: job.job_id, request_id: job.request_id, provider_id: item.id, elapsed_ms: Date.now() - lease.started, mode: this.state.mode });
        this.onStatus({ type: 'input-visibility', provider_id: item.id, active: false });
        this._drain();
      }
    };
    lease.release = release;
    try {
      this.render();
      if (focusProviderView) item.view.webContents.focus();
      this.log('input_lease.acquired', { job_id: job.job_id, request_id: job.request_id, provider_id: item.id, mode: this.state.mode,
        payload: { bounds: item.view.getBounds(), visible: item.view.getVisible(), focused: item.view.webContents.isFocused(), background: backgroundRequest } });
      this.onStatus({ type: 'input-visibility', provider_id: item.id, active: true });
      request.resolve(release);
    } catch (error) {
      void release();
      request.reject(new LayoutError('input_view_unavailable', `网页输入区域准备失败：${error.message}`));
    }
  }

  _interrupt(reason) {
    const lease = this.lease;
    if (!lease || lease.interrupted) return;
    lease.interrupted = true;
    this.log('input_lease.interrupted', { job_id: lease.job.job_id, request_id: lease.job.request_id, provider_id: lease.item.id, reason });
    this.onInputInterrupted(lease.job, reason);
  }

  remove(id) {
    const item = this.entries.get(id);
    if (!item) return;
    for (const request of this.queue.filter(request => request.item === item)) {
      this.queue.splice(this.queue.indexOf(request), 1); this._cleanupRequest(request);
      request.reject(new LayoutError('provider_unavailable', '模型网页已关闭。'));
    }
    const activeLease = this.lease?.item === item ? this.lease : null;
    if (activeLease) { this._interrupt('provider_unavailable'); this.lease = null; }
    if (item.host && !item.host.isDestroyed()) item.host.contentView.removeChildView(item.view);
    if (item.window && !item.window.isDestroyed()) item.window.destroy();
    if (!item.view.webContents.isDestroyed()) item.view.webContents.close();
    this.entries.delete(id);
    this.state.panes = this.state.panes.filter(pane => pane.provider_id !== id);
    if (this.state.active_provider === id) this.state.active_provider = this.entries.keys().next().value;
    if (activeLease) {
      this.log('input_lease.released', { job_id: activeLease.job.job_id, request_id: activeLease.job.request_id, provider_id: item.id, reason: 'provider_removed', elapsed_ms: Date.now() - activeLease.started });
      this.onStatus({ type: 'input-visibility', provider_id: item.id, active: false });
    }
    this.render(); this._drain();
  }

  resume() { this.render(); this._drain(); }

  suspend() { this._interrupt('input_view_hidden'); }

  shutdown() {
    if (this.disposed) return;
    this.disposed = true;
    this._interrupt('cancelled');
    for (const request of this.queue.splice(0)) {
      this._cleanupRequest(request); request.reject(new LayoutError('cancelled', '应用已关闭。'));
    }
    for (const item of this.entries.values()) {
      if (item.host && !item.host.isDestroyed()) item.host.contentView.removeChildView(item.view);
      if (item.window && !item.window.isDestroyed()) item.window.destroy();
      if (!item.view.webContents.isDestroyed()) item.view.webContents.close();
    }
    this.entries.clear();
  }
}

module.exports = { ProviderLayout, LayoutError, normalizeBounds, clampBounds };
