'use strict';

(() => {
  const $ = (id) => (typeof document === 'undefined' ? null : document.getElementById(id));
  const api = window.fusion;
  const state = {config: null, status: null, runtime: null, messages: [], history: [], turns: new Map(), conversationId: null,
    activeProvider: null, appTab: 'fusion', tabs: [{id: 'fusion', kind: 'fusion', title: '融合对话'}], workbenchSessions: new Map(), busy: false, settings: false, settingsSection: 'models', dirty: false,
    workbench: {tab: 'chat', providers: [], activeProviderId: null, messages: [], busy: false, loaded: false, webUrl: 'https://claude.ai/new', webVisible: false, inPlace: false, returnTab: 'fusion', terminals: {}},
    webFavorites: [],
    agentInPlace: false, agentReturnTab: 'fusion',
    started: 0, loadingHistory: false, saving: false, pollPending: false, statusErrors: 0,
    browserProfiles: [], browserDetecting: false, browserImporting: false, browserMaintenance: false,
    layout: {mode: 'split', providers: [], chatShare: 36, paneShare: 50}, layoutUpdating: false, dragging: null,
    run: null,
    diagnosticPending: false, diagnosticOpen: false, diagnostic: null, focusedPane: 0, inputLeaseActive: false, recoveryOpening: false};
  const layoutStorageKey = 'multillm-fusion.layout.v2';
  const webFavoritesStorageKey = 'multillm-fusion.web-favorites.v1';
  let layoutTail = Promise.resolve();
  try {
    const current = JSON.parse(localStorage.getItem(layoutStorageKey));
    const saved = current || JSON.parse(localStorage.getItem('multillm-fusion.layout.v1'));
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
      // Start this upgrade side by side once; retain pane choices and sizes.
      // Subsequent explicit layout choices use v2 and remain unchanged on restart.
      if (current && ['tabs', 'split', 'windows'].includes(current.mode)) state.layout.mode = current.mode;
      state.layout.providers = Array.isArray(saved.providers) ? saved.providers.filter((id) => typeof id === 'string').slice(0, 2) : [];
      for (const key of ['chatShare', 'paneShare']) if (Number.isFinite(saved[key])) state.layout[key] = Math.max(20, Math.min(80, saved[key]));
      if (typeof saved.activeProvider === 'string') state.activeProvider = saved.activeProvider;
    }
  } catch {}
  try {
    const savedFavorites = JSON.parse(localStorage.getItem(webFavoritesStorageKey) || '[]');
    if (Array.isArray(savedFavorites)) state.webFavorites = savedFavorites
      .filter(item => item && typeof item.url === 'string' && /^https?:\/\//i.test(item.url))
      .map(item => ({url: item.url.slice(0, 4096), title: typeof item.title === 'string' ? item.title.slice(0, 120) : item.url}))
      .slice(0, 30);
  } catch {}
  let boundsFrame = null;
  let toastTimer = null;
  let statusTimer = null;
  let progressTimer = null;
  let workbenchProvidersLoad = null;
  const providerStates = {};
  const stateNames = {ready: '就绪', idle: '待命', loading: '加载中', generating: '生成中', submitting: '正在提交',
    verification_required: '等待人工验证', verification_cleared: '验证已解除', rate_limited: '访问间隔等待',
    extracting: '提取中', waiting: '等待中', busy: '工作中', retrying: '网页重试中', manual_retry_required: '请在网页重试', recovering: '恢复采集中', error: '需要处理', disconnected: '连接中断',
    login_required: '请先登录', logged_out: '请先登录', connected: '已连接', unknown: '待确认'};
  const activeStates = new Set(['loading', 'generating', 'submitting', 'extracting', 'waiting', 'busy', 'retrying', 'manual_retry_required', 'recovering', 'verification_required', 'rate_limited']);
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const text = (tag, content, className) => {const el = document.createElement(tag); if (content !== undefined) el.textContent = content; if (className) el.className = className; return el;};
  const providerName = (id) => state.config?.providers.find((p) => p.id === id)?.name || id;
  const enabledProviders = () => state.config?.providers.filter((p) => p.enabled) || [];
  const errorMessage = (error) => error?.message || String(error || '发生未知错误');
  const loginProviders = new Set(['chatgpt', 'deepseek', 'qwen', 'claude', 'grok', 'glm', 'kimi']);
  const isImporting = () => state.browserImporting || state.browserMaintenance || !!state.status?.browser_maintenance;
  const inspectedProvider = () => state.layout.mode === 'split' ? state.layout.providers[state.focusedPane] || state.activeProvider : state.activeProvider;
  const canReopenWindows = () => !!state.config && state.layout.mode === 'windows' && !state.settings && !isImporting() && !state.layoutUpdating && !state.diagnosticPending && !state.diagnosticOpen && !state.dragging && !state.saving;
  const isLocked = () => state.busy || state.loadingHistory || state.saving || state.layoutUpdating || state.diagnosticPending || state.diagnosticOpen || !!state.dragging || isImporting() || !!state.status?.busy;
  const canOpenRecovery = () => !!api?.openRecoveryProvider && !!state.config && !state.settings && !isImporting() && !state.inputLeaseActive &&
    !state.layoutUpdating && !state.recoveryOpening && !state.saving && !state.loadingHistory && !state.diagnosticPending && !state.diagnosticOpen && !state.dragging;

  function toast(message) {clearTimeout(toastTimer); $('toast').textContent = message; $('toast').hidden = false; toastTimer = setTimeout(() => {$('toast').hidden = true;}, 3600);}
  function setError(id, message) {$(id).textContent = message || ''; $(id).hidden = !message;}

  const workbenchKindMeta = {
    providers: {title: 'Provider 配置'}, chat: {title: 'Provider 对话'}, claude: {title: 'Claude Code'},
    hermes: {title: 'Hermes'}, codex: {title: 'Codex'}, agent: {title: 'Desktop Agent'}, web: {title: '网页'},
  };
  const workbenchTitle = kind => workbenchKindMeta[kind]?.title || '工具';
  const isWorkbenchTab = id => state.tabs.some(tab => tab.id === id && !['fusion', 'desktop-agent'].includes(tab.kind));
  const activeWorkbenchTab = () => state.tabs.find(tab => tab.id === state.appTab && isWorkbenchTab(tab.id));
  function setWorkbenchTabStatus(status, id = state.appTab) {
    const tab = state.tabs.find(item => item.id === id);
    if (!tab || ['fusion', 'desktop-agent'].includes(tab.kind)) return;
    tab.status = String(status || '');
    if (id === state.appTab) updateAppTabs();
  }

  function renderAppTabs() {
    const container = $('app-tab-dynamic');
    if (!container) return;
    container.replaceChildren();
    state.tabs.filter(tab => !['fusion', 'desktop-agent'].includes(tab.kind)).forEach(tab => {
      const wrap = text('span', undefined, 'app-tab-dynamic-item');
      const button = text('button', undefined, `app-tab dynamic${tab.id === state.appTab ? ' active' : ''}`);
      button.type = 'button'; button.dataset.appTab = tab.id; button.setAttribute('role', 'tab'); button.setAttribute('aria-selected', String(tab.id === state.appTab));
      button.append(text('strong', tab.title));
      if (tab.status) button.append(text('small', tab.status, 'app-tab-status'));
      button.addEventListener('click', () => { void switchAppTab(tab.id); });
      const close = text('button', '×', 'app-tab-close'); close.type = 'button'; close.title = `关闭 ${tab.title}`; close.setAttribute('aria-label', `关闭 ${tab.title}`);
      close.addEventListener('click', event => { event.stopPropagation(); void closeWorkbenchTab(tab.id); });
      wrap.append(button, close); container.append(wrap);
    });
  }

  function updateAppTabs() {
    if (typeof document === 'undefined' || !document.querySelectorAll) return;
    renderAppTabs();
    document.querySelectorAll('[data-app-tab]').forEach((tab) => {
      const active = tab.dataset.appTab === state.appTab;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', String(active));
    });
    document.body.dataset.appTab = state.appTab;
    renderFusionSidebar();
  }

  function newWorkbenchSession(kind) {
    return {tab: kind, messages: [], busy: false, webUrl: 'https://claude.ai/new', webVisible: false, terminals: {}};
  }

  function saveWorkbenchSession(id = state.appTab) {
    if (!isWorkbenchTab(id)) return;
    state.workbenchSessions.set(id, {tab: state.workbench.tab, messages: clone(state.workbench.messages), busy: false, webUrl: state.workbench.webUrl, webVisible: false, terminals: clone(state.workbench.terminals || {})});
  }

  function loadWorkbenchSession(id) {
    const saved = state.workbenchSessions.get(id) || newWorkbenchSession(state.tabs.find(tab => tab.id === id)?.kind || 'chat');
    state.workbench.tab = saved.tab;
    state.workbench.messages = Array.isArray(saved.messages) ? saved.messages : [];
    state.workbench.busy = false;
    state.workbench.webUrl = saved.webUrl || 'https://claude.ai/new';
    state.workbench.webVisible = false;
    state.workbench.terminals = saved.terminals && typeof saved.terminals === 'object' ? saved.terminals : {};
    state.workbenchSessions.set(id, saved);
  }

  async function closeWorkbenchTab(id = state.appTab) {
    const index = state.tabs.findIndex(tab => tab.id === id && !['fusion', 'desktop-agent'].includes(tab.kind));
    if (index < 0) return;
    const wasActive = state.appTab === id;
    saveWorkbenchSession(id);
    const session = state.workbenchSessions.get(id);
    for (const terminal of Object.values(session?.terminals || {})) if (terminal?.sessionId) void api?.stopWorkbenchTerminal?.({session_id: terminal.sessionId});
    if (wasActive) hideWorkbenchWeb();
    state.workbenchSessions.delete(id); state.tabs.splice(index, 1);
    if (wasActive) {
      const nextId = state.tabs.slice(0, index).reverse().find(tab => !['fusion', 'desktop-agent'].includes(tab.kind))?.id || 'fusion';
      await switchAppTab(nextId);
    } else updateAppTabs();
  }

  async function closeWorkbenchInPlace() { await closeWorkbenchTab(state.appTab); }

  async function openWorkbenchInPlace(tab) { await createWorkbenchTab(tab); }

  async function openDesktopAgentInPlace() {
    state.agentReturnTab = state.appTab === 'workbench' ? 'fusion' : state.appTab;
    state.agentInPlace = true;
    state.settings = false;
    $('settings-view').hidden = true;
    $('workspace').hidden = true;
    $('workbench-view').hidden = true;
    $('desktop-agent-view').classList.add('in-place');
    $('desktop-agent-view').hidden = false;
    $('agent-close-inplace').hidden = false;
    hideWorkbenchWeb();
    updateAppTabs();
    try { await publishLayout({hidden: true}); } catch (error) { console.warn('隐藏模型网页失败', errorMessage(error)); }
    updateAgentStatus('ready');
  }

  async function closeDesktopAgentInPlace() {
    if (!state.agentInPlace) return;
    state.agentInPlace = false;
    $('desktop-agent-view').classList.remove('in-place');
    $('desktop-agent-view').hidden = true;
    $('agent-close-inplace').hidden = true;
    state.appTab = state.agentReturnTab === 'desktop-agent' ? 'desktop-agent' : 'fusion';
    $('workspace').hidden = state.appTab !== 'fusion' || state.settings;
    if (state.appTab === 'desktop-agent') $('desktop-agent-view').hidden = false;
    updateAppTabs();
    scheduleBounds();
  }

  async function switchAppTab(tab) {
    if (!state.tabs.some(item => item.id === tab)) return;
    if (tab === 'desktop-agent') {
      const existing = state.tabs.find(item => item.kind === 'agent');
      if (existing) { await switchAppTab(existing.id); return; }
      await createWorkbenchTab('agent');
      return;
    }
    if (state.appTab === tab) return;
    if (isWorkbenchTab(state.appTab)) saveWorkbenchSession(state.appTab);
    if (state.agentInPlace) await closeDesktopAgentInPlace();
    if (tab === state.appTab && state.settings) state.settings = false;
    state.appTab = tab;
    state.settings = false;
    $('settings-view').hidden = true;
    if (isWorkbenchTab(tab)) {
      loadWorkbenchSession(tab);
      $('workspace').hidden = true; $('desktop-agent-view').hidden = true; $('workbench-view').classList.remove('in-place'); $('workbench-view').hidden = false;
      updateAppTabs();
      await loadWorkbenchProviders();
      renderWorkbenchTabs();
      try { await publishLayout({hidden: true}); } catch (error) { console.warn('隐藏模型网页失败', errorMessage(error)); }
      if (state.workbench.tab === 'web') { state.workbench.webVisible = true; $('workbench-web-url')?.focus(); requestAnimationFrame(() => { void syncWorkbenchWeb(); }); }
      return;
    }
    $('desktop-agent-view').hidden = true;
    $('desktop-agent-view').classList.remove('in-place');
    $('workbench-view').hidden = true;
    $('workbench-view').classList.remove('in-place');
    hideWorkbenchWeb();
    $('workspace').hidden = state.settings;
    $('settings-view').hidden = !state.settings;
    updateAppTabs();
    updateAgentStatus('idle');
    scheduleBounds();
  }

  function updateAgentStatus(status, message) {
    const dot = $('agent-health-dot'), label = $('agent-health-label'), parentDot = $('agent-parent-dot'), parentLabel = $('agent-parent-label');
    if (!dot || !label) return;
    const labels = {idle: '等待启动', ready: '工作区已就绪', launching: '正在打开终端', error: '启动失败'};
    dot.className = `agent-health-dot ${status === 'ready' || status === 'launching' ? 'ready' : status === 'error' ? 'error' : ''}`;
    label.textContent = message || labels[status] || labels.idle;
    if (parentDot && parentLabel && state.status) {
      const connected = state.status.bridge_connected === true;
      parentDot.className = `status-dot ${connected ? 'ready' : 'error'}`;
      parentLabel.textContent = connected ? '父服务已连接' : '父服务尚未连接';
    }
  }

  function agentAllowList() {
    return ['shell', 'browser', 'desktop'].filter((name) => $(`agent-allow-${name}`)?.checked);
  }

  function renderSidebarProviderList() {
    const container = $('sidebar-provider-list');
    if (!container) return;
    const providers = enabledProviders();
    $('sidebar-model-count').textContent = String(providers.length);
    container.replaceChildren();
    if (!providers.length) {
      container.append(text('div', '暂无启用模型', 'sidebar-empty'));
      return;
    }
    providers.forEach((provider) => {
      const button = text('button', undefined, `sidebar-provider${provider.id === state.activeProvider ? ' active' : ''}`);
      button.type = 'button'; button.dataset.provider = provider.id; button.disabled = isLocked() || state.settings;
      const status = providerStates[provider.id] || {};
      button.append(text('span', provider.name.slice(0, 1).toUpperCase(), `sidebar-provider-initial provider-${provider.id}`));
      const copy = text('span', undefined, 'sidebar-provider-copy');
      copy.append(text('strong', provider.name), text('small', stateNames[status.state] || '待确认'));
      button.append(copy, text('span', undefined, dotClass(status.state)));
      button.title = status.message || provider.url;
      button.addEventListener('click', () => selectProvider(provider.id));
      container.append(button);
    });
  }

  function renderSidebarHistory() {
    const container = $('sidebar-history-list');
    if (!container) return;
    container.replaceChildren();
    const items = (state.history || []).slice(0, 8);
    if (!items.length) {
      container.append(text('div', '暂无历史对话', 'sidebar-empty'));
      return;
    }
    items.forEach((conversation) => {
      const button = text('button', undefined, `sidebar-history-item${conversation.id === state.conversationId ? ' active' : ''}`);
      button.type = 'button'; button.dataset.conversation = conversation.id; button.disabled = isLocked();
      button.append(text('span', '·', 'sidebar-history-dot'), text('span', conversation.title || '未命名对话'));
      button.title = conversation.title || '未命名对话';
      button.addEventListener('click', () => openConversation(conversation.id));
      container.append(button);
    });
  }

  function renderFusionSidebar() {
    if (typeof document === 'undefined' || !document.querySelectorAll) return;
    renderSidebarProviderList();
    renderSidebarHistory();
    document.querySelectorAll('.sidebar-workspace[data-app-tab]').forEach((button) => {
      button.classList.toggle('active', button.dataset.appTab === state.appTab);
    });
  }

  async function launchDesktopAgent(mode = 'chat') {
    if (!api?.launchDesktopAgent) {
      toast('请通过 Electron 应用启动；普通浏览器无法打开 Desktop Agent 终端。');
      return;
    }
    const task = $('agent-task')?.value.trim() || '';
    const workspace = $('agent-workspace')?.value.trim() || '';
    const model = $('agent-model')?.value || '';
    if (mode === 'run' && !task) {
      $('agent-task')?.focus();
      toast('请先填写任务目标。');
      return;
    }
    updateAgentStatus('launching', '正在打开终端');
    $('agent-run-task').disabled = true; $('agent-open-terminal').disabled = true;
    try {
      const result = await api.launchDesktopAgent({mode, task, workspace, model, allow: agentAllowList()});
      if (!result?.ok) throw new Error(result?.message || '终端启动失败');
      $('agent-console-state').textContent = mode === 'run' ? '任务已发送' : '交互终端已打开';
      $('agent-console').innerHTML = `<div class="agent-console-placeholder"><span aria-hidden="true">✓</span><strong>${mode === 'run' ? '任务已在新终端中启动' : '交互终端已打开'}</strong><p>${result.terminal ? `终端：${result.terminal} · ` : ''}返回终端可继续查看实时输出。</p></div>`;
      updateAgentStatus('ready', mode === 'run' ? '任务运行中' : '终端已打开');
      toast(mode === 'run' ? 'Desktop Agent 任务已在新终端启动' : 'Desktop Agent 交互终端已打开');
    } catch (error) {
      updateAgentStatus('error', errorMessage(error));
      toast(`无法打开 Desktop Agent：${errorMessage(error)}`);
    } finally {
      $('agent-run-task').disabled = false; $('agent-open-terminal').disabled = false;
    }
  }

  function workbenchProvider() {
    return state.workbench.providers.find(provider => provider.id === state.workbench.activeProviderId) || null;
  }

  function workbenchLocalKey() { return 'multillm-fusion.workbench.providers'; }

  function workbenchDefaultProvider() {
    return {id: 'local-model', name: '本地大模型', apiType: 'openai', baseUrl: 'http://127.0.0.1:11434/v1', apiKey: '', model: '', models: [], modelContexts: {}};
  }

  function workbenchContextLabel(provider, model = provider?.model) {
    const size = Number(provider?.modelContexts?.[model] || (model === provider?.model ? provider?.contextSize : 0));
    if (!Number.isInteger(size) || size < 512) return '上下文未知';
    return size >= 1048576 ? `${(size / 1048576).toFixed(1).replace(/\.0$/, '')}M` : size >= 1024 ? `${Math.round(size / 1024)}K` : String(size);
  }

  function workbenchProviderOptionValue(provider, model = provider.model) { return `${provider.id}::${model || ''}`; }

  function workbenchProviderFromOption(value) {
    const [id, ...parts] = String(value || '').split('::');
    const provider = state.workbench.providers.find(item => item.id === id);
    return provider ? {provider, model: parts.join('::') || provider.model} : {provider: null, model: ''};
  }

  function renderWorkbenchToolProviderSelects() {
    const providers = state.workbench.providers.filter(provider => provider.model || provider.models.length);
    for (const id of ['workbench-chat-provider', 'workbench-claude-provider', 'workbench-hermes-provider']) {
      const select = $(id); if (!select) continue;
      const previous = select.value;
      const own = id === 'workbench-chat-provider' ? '选择 Provider' : id === 'workbench-claude-provider' ? '使用 Claude Code 自身配置' : '使用 Hermes 自身配置';
      select.replaceChildren(new Option(own, ''));
      providers.forEach(provider => {
        const models = provider.models.length ? provider.models : [provider.model];
        models.filter(Boolean).forEach(model => {
          const suffix = `${provider.apiType === 'anthropic' ? 'Anthropic' : 'OpenAI'} · ${workbenchContextLabel(provider, model)}`;
          select.add(new Option(`${provider.name} · ${model} · ${suffix}`, workbenchProviderOptionValue(provider, model)));
        });
      });
      if (id === 'workbench-chat-provider' && workbenchProvider()) select.value = workbenchProviderOptionValue(workbenchProvider());
      else if ([...select.options].some(option => option.value === previous)) select.value = previous;
    }
  }

  function renderWorkbenchProviderForm() {
    const provider = workbenchProvider() || workbenchDefaultProvider();
    $('workbench-provider-name').value = provider.name || '';
    $('workbench-provider-type').value = provider.apiType || 'openai';
    $('workbench-provider-url').value = provider.baseUrl || '';
    $('workbench-provider-key').value = provider.apiKey || '';
    const select = $('workbench-provider-model');
    const models = Array.isArray(provider.models) ? provider.models : [];
    select.replaceChildren(new Option(models.length ? '选择模型' : '先获取模型列表', ''));
    models.forEach(model => select.add(new Option(model, model)));
    if (provider.model && !models.includes(provider.model)) select.add(new Option(provider.model, provider.model));
    select.value = provider.model || '';
    $('workbench-provider-context').value = provider.modelContexts?.[provider.model] || provider.contextSize || '';
    $('workbench-provider-model-count').textContent = String(models.length);
    $('workbench-provider-context-value').textContent = workbenchContextLabel(provider);
    $('workbench-provider-connectivity').textContent = provider.testedAt ? '已测试' : '未测试';
    $('workbench-provider-latency').textContent = Number.isFinite(provider.testLatencyMs) ? `${provider.testLatencyMs} ms` : '—';
    $('workbench-provider-test-status').textContent = provider.testedAt
      ? `连接正常${Number.isFinite(provider.testLatencyMs) ? ` · ${provider.testLatencyMs} ms` : ''}`
      : '等待检测';
    $('workbench-delete-provider').disabled = !workbenchProvider();
    $('workbench-chat-input').disabled = !workbenchProvider() || !provider.model || state.workbench.busy;
    renderWorkbenchToolProviderSelects();
  }

  function renderWorkbenchProviderList() {
    const container = $('workbench-provider-list');
    if (!container) return;
    container.replaceChildren();
    if (!state.workbench.providers.length) {
      container.append(text('div', '尚未配置大模型', 'workbench-empty'));
      return;
    }
    state.workbench.providers.forEach(provider => {
      const button = text('button', undefined, `workbench-provider-item${provider.id === state.workbench.activeProviderId ? ' active' : ''}`);
      button.type = 'button'; button.dataset.provider = provider.id;
      button.append(text('span', provider.name.slice(0, 1).toUpperCase(), 'workbench-provider-initial'));
      const copy = text('span', undefined, 'workbench-provider-copy');
      copy.append(text('strong', provider.name), text('small', `${provider.model || '未选择模型'} · ${provider.apiType === 'anthropic' ? 'Anthropic' : 'OpenAI'} · ${workbenchContextLabel(provider)}`));
      button.append(copy);
      button.addEventListener('click', () => {
        state.workbench.activeProviderId = provider.id;
        renderWorkbenchProviderList(); renderWorkbenchProviderForm();
      });
      container.append(button);
    });
  }

  function renderWorkbenchMessages() {
    const container = $('workbench-chat-messages');
    if (!container) return;
    const lines = ['Provider 对话终端已就绪。'];
    if (!state.workbench.messages.length) lines.push('请选择已配置的 Provider，然后输入消息。');
    state.workbench.messages.forEach(message => lines.push(message.role === 'user' ? `\n> ${message.content}` : `\n${message.content}`));
    // The Provider conversation uses the same terminal surface as the tool
    // sessions. Render it through the shared target renderer so paths and
    // URLs behave consistently in every virtual terminal.
    container.dataset.terminalOutput = 'chat';
    renderWorkbenchTerminalOutput(container, lines.join('\n'));
    container.scrollTop = container.scrollHeight;
  }

  function renderWorkbenchTabs() {
    if (typeof document === 'undefined' || !document.querySelectorAll) return;
    const active = state.workbench.tab;
    document.querySelectorAll('[data-workbench-tab]').forEach(tab => tab.classList.toggle('active', tab.dataset.workbenchTab === active));
    document.querySelectorAll('[data-workbench-panel]').forEach(panel => { panel.hidden = panel.dataset.workbenchPanel !== active; });
    if (['claude', 'hermes', 'codex', 'agent'].includes(active)) ensureWorkbenchTerminal(active);
    if (active === 'chat') { renderWorkbenchMessages(); renderWorkbenchProviderForm(); }
    updateAppTabs();
    if (active === 'web' && isWorkbenchTab(state.appTab)) requestAnimationFrame(() => { void syncWorkbenchWeb(); });
    else hideWorkbenchWeb();
  }

  async function loadWorkbenchProviders() {
    if (state.workbench.loaded) { renderWorkbenchProviderList(); renderWorkbenchProviderForm(); renderWorkbenchTabs(); return; }
    if (!workbenchProvidersLoad) {
      workbenchProvidersLoad = (async () => {
        let providers = [];
        try {
          if (api?.listWorkbenchProviders) {
            const result = await api.listWorkbenchProviders(); providers = Array.isArray(result?.providers) ? result.providers : [];
          } else {
            providers = JSON.parse(localStorage.getItem(workbenchLocalKey()) || '[]');
          }
        } catch (error) { toast(`无法读取大模型配置：${errorMessage(error)}`); }
        state.workbench.providers = Array.isArray(providers) ? providers.filter(provider => provider && typeof provider === 'object').map(provider => ({
          ...provider, apiType: provider.apiType === 'anthropic' ? 'anthropic' : 'openai', models: Array.isArray(provider.models) ? provider.models : [], modelContexts: provider.modelContexts && typeof provider.modelContexts === 'object' ? provider.modelContexts : {},
        })) : [];
        state.workbench.activeProviderId = state.workbench.providers[0]?.id || null;
        state.workbench.loaded = true;
      })();
    }
    try { await workbenchProvidersLoad; }
    finally { workbenchProvidersLoad = null; }
    renderWorkbenchProviderList(); renderWorkbenchProviderForm(); renderWorkbenchTabs();
  }

  async function persistWorkbenchProviders() {
    if (api?.saveWorkbenchProviders) await api.saveWorkbenchProviders({providers: state.workbench.providers});
    else localStorage.setItem(workbenchLocalKey(), JSON.stringify(state.workbench.providers));
  }

  function readWorkbenchProviderDraft() {
    const current = workbenchProvider();
    const id = current?.id || `model-${Date.now().toString(36)}`;
    const model = $('workbench-provider-model').value.trim();
    const contextSize = Number($('workbench-provider-context').value);
    const modelContexts = {...(current?.modelContexts || {})};
    if (model && Number.isInteger(contextSize) && contextSize >= 512) modelContexts[model] = contextSize;
    return {id, name: $('workbench-provider-name').value.trim(), apiType: $('workbench-provider-type').value === 'anthropic' ? 'anthropic' : 'openai', baseUrl: $('workbench-provider-url').value.trim(), apiKey: $('workbench-provider-key').value, model, models: current?.models || [], modelContexts, ...(Number.isInteger(contextSize) && contextSize >= 512 ? {contextSize} : {}), ...(current?.testedAt ? {testedAt: current.testedAt} : {}), ...(Number.isFinite(current?.testLatencyMs) ? {testLatencyMs: current.testLatencyMs} : {})};
  }

  async function saveWorkbenchProvider() {
    const draft = readWorkbenchProviderDraft();
    if (!draft.name || !draft.baseUrl || !draft.model) { $('workbench-config-error').textContent = '请填写配置名称、API Base URL 并选择模型。'; $('workbench-config-error').hidden = false; return; }
    $('workbench-config-error').hidden = true;
    const index = state.workbench.providers.findIndex(provider => provider.id === draft.id);
    if (index >= 0) state.workbench.providers[index] = draft; else state.workbench.providers.push(draft);
    state.workbench.activeProviderId = draft.id;
    try { await persistWorkbenchProviders(); renderWorkbenchProviderList(); renderWorkbenchProviderForm(); toast('大模型配置已保存'); }
    catch (error) { toast(`保存大模型配置失败：${errorMessage(error)}`); }
  }

  async function refreshWorkbenchModels() {
    const baseUrl = $('workbench-provider-url').value.trim(), apiKey = $('workbench-provider-key').value, apiType = $('workbench-provider-type').value;
    if (!baseUrl) { toast('请先填写 API Base URL。'); return; }
    $('workbench-refresh-models').disabled = true;
    try {
      if (!api?.listWorkbenchModels) throw new Error('普通浏览器无法安全访问外部 API，请使用 Electron 应用。');
      const result = await api.listWorkbenchModels({baseUrl, apiKey, apiType, model: $('workbench-provider-model').value});
      const current = workbenchProvider() || readWorkbenchProviderDraft();
      current.apiType = apiType === 'anthropic' ? 'anthropic' : 'openai'; current.baseUrl = baseUrl; current.apiKey = apiKey;
      current.models = result.models || [];
      current.modelContexts = result.modelContexts || {};
      if ((!current.model || !current.models.includes(current.model)) && current.models.length) current.model = current.models[0];
      if (!workbenchProvider()) { state.workbench.providers.push(current); state.workbench.activeProviderId = current.id; }
      await persistWorkbenchProviders();
      renderWorkbenchProviderList(); renderWorkbenchProviderForm(); toast(`已获取 ${current.models.length} 个模型和上下文信息`);
    } catch (error) { toast(`获取模型失败：${errorMessage(error)}`); }
    finally { $('workbench-refresh-models').disabled = false; }
  }

  async function testWorkbenchProvider() {
    const draft = readWorkbenchProviderDraft();
    if (!draft.baseUrl || !draft.model) { toast('请先填写地址并选择模型。'); return; }
    $('workbench-test-provider').disabled = true;
    $('workbench-provider-test-status').textContent = '测试中…';
    $('workbench-provider-connectivity').textContent = '测试中';
    try {
      if (!api?.testWorkbenchProvider) throw new Error('请通过 Electron 应用测试 Provider。');
      const result = await api.testWorkbenchProvider({baseUrl: draft.baseUrl, apiKey: draft.apiKey, apiType: draft.apiType, model: draft.model});
      const current = workbenchProvider();
      if (current) {
        current.testedAt = Date.now(); current.testLatencyMs = result.latencyMs;
        if (result.contextSize) { current.contextSize = result.contextSize; current.modelContexts = {...current.modelContexts, [draft.model]: result.contextSize}; }
        await persistWorkbenchProviders();
      }
      $('workbench-provider-test-status').textContent = `连接正常 · ${result.latencyMs} ms`;
      $('workbench-provider-connectivity').textContent = '连接正常';
      $('workbench-provider-latency').textContent = `${result.latencyMs} ms`;
      if (result.contextSize) $('workbench-provider-context-value').textContent = workbenchContextLabel({model: draft.model, contextSize: result.contextSize}, draft.model);
      renderWorkbenchProviderList(); renderWorkbenchToolProviderSelects();
      toast(`Provider 测试成功（${result.latencyMs} ms）`);
    } catch (error) {
      $('workbench-provider-test-status').textContent = '连接失败';
      $('workbench-provider-connectivity').textContent = '连接失败';
      toast(`Provider 测试失败：${errorMessage(error)}`);
    } finally { $('workbench-test-provider').disabled = false; }
  }

  function settingsProviderDraft() {
    const current = workbenchProvider();
    const model = $('settings-provider-model').value.trim();
    const contextSize = Number($('settings-provider-context').value);
    const modelContexts = {...(current?.modelContexts || {})};
    if (model && Number.isInteger(contextSize) && contextSize >= 512) modelContexts[model] = contextSize;
    return {id: current?.id || `model-${Date.now().toString(36)}`, name: $('settings-provider-name').value.trim(),
      apiType: $('settings-provider-type').value === 'anthropic' ? 'anthropic' : 'openai', baseUrl: $('settings-provider-url').value.trim(),
      apiKey: $('settings-provider-key').value, model, models: current?.models || [], modelContexts,
      ...(Number.isInteger(contextSize) && contextSize >= 512 ? {contextSize} : {}), ...(current?.testedAt ? {testedAt: current.testedAt} : {}),
      ...(Number.isFinite(current?.testLatencyMs) ? {testLatencyMs: current.testLatencyMs} : {})};
  }

  function renderSettingsProviderForm() {
    const select = $('settings-provider-select');
    if (!select) return;
    select.replaceChildren();
    state.workbench.providers.forEach(provider => select.add(new Option(`${provider.name} · ${provider.model || '未选择模型'}`, provider.id)));
    if (!state.workbench.providers.length) select.add(new Option('暂无 Provider，请新增', ''));
    select.value = workbenchProvider()?.id || '';
    const provider = workbenchProvider() || workbenchDefaultProvider();
    $('settings-provider-name').value = provider.name || '';
    $('settings-provider-type').value = provider.apiType || 'openai';
    $('settings-provider-url').value = provider.baseUrl || '';
    $('settings-provider-key').value = provider.apiKey || '';
    const model = $('settings-provider-model');
    model.replaceChildren(new Option(provider.models?.length ? '选择模型' : '先自动获取模型', ''));
    (provider.models || []).forEach(item => model.add(new Option(item, item)));
    if (provider.model && !(provider.models || []).includes(provider.model)) model.add(new Option(provider.model, provider.model));
    model.value = provider.model || '';
    $('settings-provider-context').value = provider.modelContexts?.[provider.model] || provider.contextSize || '';
    const disabled = !workbenchProvider();
    ['settings-provider-name', 'settings-provider-type', 'settings-provider-url', 'settings-provider-key', 'settings-provider-model', 'settings-provider-context', 'settings-provider-fetch', 'settings-provider-test', 'settings-provider-save'].forEach(id => { if ($(id)) $(id).disabled = disabled; });
    $('settings-provider-status').textContent = provider.testedAt ? `已测试${Number.isFinite(provider.testLatencyMs) ? ` · ${provider.testLatencyMs} ms` : ''}` : (disabled ? '请选择或新增一个 Provider。' : '可自动获取模型，或直接测试当前模型。');
  }

  async function ensureSettingsProviders() {
    try { await loadWorkbenchProviders(); renderSettingsProviderForm(); }
    catch (error) { $('settings-provider-status').textContent = `读取 Provider 失败：${errorMessage(error)}`; }
  }

  async function addSettingsProvider() {
    await ensureSettingsProviders();
    const draft = workbenchDefaultProvider();
    draft.id = `model-${Date.now().toString(36)}`; draft.name = '新大模型';
    state.workbench.providers.push(draft); state.workbench.activeProviderId = draft.id; state.workbench.loaded = true;
    renderSettingsProviderForm(); $('settings-provider-name').focus();
  }

  async function fetchSettingsProviderModels() {
    const baseUrl = $('settings-provider-url').value.trim(), apiKey = $('settings-provider-key').value, apiType = $('settings-provider-type').value;
    if (!baseUrl) { $('settings-provider-status').textContent = '请先填写 API Base URL。'; return; }
    $('settings-provider-fetch').disabled = true; $('settings-provider-status').textContent = '正在获取模型…';
    try {
      if (!api?.listWorkbenchModels) throw new Error('请通过 Electron 应用获取模型。');
      const result = await api.listWorkbenchModels({baseUrl, apiKey, apiType, model: $('settings-provider-model').value});
      let current = workbenchProvider();
      if (!current) { current = {...workbenchDefaultProvider(), id: `model-${Date.now().toString(36)}`, name: '新大模型'}; state.workbench.providers.push(current); state.workbench.activeProviderId = current.id; }
      current.apiType = apiType === 'anthropic' ? 'anthropic' : 'openai'; current.baseUrl = baseUrl; current.apiKey = apiKey;
      current.models = result.models || []; current.modelContexts = result.modelContexts || {};
      if ((!current.model || !current.models.includes(current.model)) && current.models.length) current.model = current.models[0];
      await persistWorkbenchProviders(); renderSettingsProviderForm(); renderWorkbenchProviderList(); renderWorkbenchProviderForm();
      $('settings-provider-status').textContent = `已获取 ${current.models.length} 个模型，可选择后测试。`;
    } catch (error) { $('settings-provider-status').textContent = `获取模型失败：${errorMessage(error)}`; }
    finally { $('settings-provider-fetch').disabled = !workbenchProvider(); }
  }

  async function testSettingsProvider() {
    const draft = settingsProviderDraft();
    if (!draft.baseUrl || !draft.model) { $('settings-provider-status').textContent = '请先填写地址并选择模型。'; return; }
    $('settings-provider-test').disabled = true; $('settings-provider-status').textContent = '测试中…';
    try {
      if (!api?.testWorkbenchProvider) throw new Error('请通过 Electron 应用测试 Provider。');
      const result = await api.testWorkbenchProvider({baseUrl: draft.baseUrl, apiKey: draft.apiKey, apiType: draft.apiType, model: draft.model});
      const current = workbenchProvider();
      if (current) { current.testedAt = Date.now(); current.testLatencyMs = result.latencyMs; if (result.contextSize) { current.contextSize = result.contextSize; current.modelContexts = {...current.modelContexts, [draft.model]: result.contextSize}; } await persistWorkbenchProviders(); }
      renderSettingsProviderForm(); renderWorkbenchProviderList(); renderWorkbenchProviderForm();
      $('settings-provider-status').textContent = `连接正常 · ${result.latencyMs} ms`;
    } catch (error) { $('settings-provider-status').textContent = `连接失败：${errorMessage(error)}`; }
    finally { $('settings-provider-test').disabled = !workbenchProvider(); }
  }

  async function saveSettingsProvider() {
    const draft = settingsProviderDraft();
    if (!draft.name || !draft.baseUrl || !draft.model) { $('settings-provider-status').textContent = '请填写配置名称、API Base URL 并选择模型。'; return; }
    const index = state.workbench.providers.findIndex(provider => provider.id === draft.id);
    if (index >= 0) state.workbench.providers[index] = draft; else state.workbench.providers.push(draft);
    state.workbench.activeProviderId = draft.id; state.workbench.loaded = true;
    try { await persistWorkbenchProviders(); renderSettingsProviderForm(); renderWorkbenchProviderList(); renderWorkbenchProviderForm(); $('settings-provider-status').textContent = 'Provider 已保存。'; toast('Provider 配置已保存'); }
    catch (error) { $('settings-provider-status').textContent = `保存失败：${errorMessage(error)}`; }
  }

  async function sendWorkbenchChat(event) {
    event?.preventDefault();
    const provider = workbenchProvider(), input = $('workbench-chat-input').value.trim();
    if (!provider || !provider.model) { setWorkbenchTabStatus('需选择 Provider'); toast('请先保存配置并选择模型。'); return; }
    if (!input || state.workbench.busy) return;
    const tabId = state.appTab;
    $('workbench-chat-input').value = '';
    setWorkbenchTabStatus('请求中…', tabId);
    state.workbench.messages.push({role: 'user', content: input}); state.workbench.busy = true; renderWorkbenchMessages(); renderWorkbenchProviderForm();
    try {
      if (!api?.workbenchChat) throw new Error('请通过 Electron 应用使用大模型对话。');
      const result = await api.workbenchChat({provider_id: provider.id, model: provider.model, messages: clone(state.workbench.messages)});
      const owner = tabId === state.appTab ? state.workbench : state.workbenchSessions.get(tabId);
      if (owner) owner.messages.push({role: 'assistant', content: result.content || ''});
      setWorkbenchTabStatus('就绪', tabId);
    } catch (error) {
      const owner = tabId === state.appTab ? state.workbench : state.workbenchSessions.get(tabId);
      if (owner) owner.messages.push({role: 'assistant', content: `请求失败：${errorMessage(error)}`});
      setWorkbenchTabStatus('错误', tabId);
    } finally {
      const owner = tabId === state.appTab ? state.workbench : state.workbenchSessions.get(tabId);
      if (owner) owner.busy = false;
      if (tabId === state.appTab) { renderWorkbenchMessages(); renderWorkbenchProviderForm(); }
    }
  }

  function workbenchToolName(kind) {
    return kind === 'claude' ? 'Claude Code' : kind === 'hermes' ? 'Hermes' : kind === 'agent' ? 'Desktop Agent' : 'Codex';
  }

  // Keep terminal output safe as text while making useful URLs and local paths
  // keyboard-focusable. The renderer never turns arbitrary output into HTML.
  //
  // Relative files are commonly printed as `src/app.ts`, `README.md`, or
  // `a\\b.py`. Match path-shaped tokens directly so Markdown punctuation such
  // as `[file](src/app.ts)` stays outside the link range.
  const terminalTargetPattern = /https?:\/\/[^\s<>"'`()\[\]]+|file:\/\/[^\s<>"'`()\[\]]+|(["'])(?:\\.|(?!\1)[^\\\r\n])*\1|(?:~[\\/]|\.{1,2}[\\/]|[\\/]|[A-Za-z]:[\\/]|\\\\)[^\s<>"'`()\[\]]+|(?:[^\s<>"'`()\[\]\/\\]+\.[A-Za-z][A-Za-z0-9_-]{0,19})(?::\d+(?::\d+)?)?(?=$|[\s.,;:!?)}\]}>])|(?:[^\s<>"'`()\[\]\/\\]+[\\/])[^\s<>"'`()\[\]]+|(?:README|LICENSE|Makefile|Dockerfile|Procfile|Gemfile|Rakefile|justfile|\.env(?:\.[\w-]+)?|(?:go|go\.mod|go\.sum|Cargo\.toml|pyproject\.toml|requirements\.txt))(?=$|[\s.,;:!?)}\]}>])/gi;

  function trimTerminalTarget(value) {
    let target = String(value || '');
    // Quotes are handled here rather than in the regex so quoted paths may
    // contain spaces. Keep the quote character paired before removing it.
    if ((target.startsWith('"') || target.startsWith("'")) && target.endsWith(target[0])) target = target.slice(1, -1);
    target = target.replace(/^[([{<]+/, '');
    target = target.replace(/[.,;:!?)}\]}>]+$/, '');
    return target;
  }

  function isTerminalURL(value) {
    return /^https?:\/\//i.test(String(value || ''));
  }

  function isTerminalPath(value) {
    const target = String(value || '');
    if (!target || isTerminalURL(target)) return false;
    if (/^file:\/\//i.test(target)) return true;
    // Unix, home-relative, dot-relative, Windows drive, and UNC paths.
    if (/^(?:~[\\/]|\.{1,2}[\\/]|[\\/]|[A-Za-z]:[\\/]|\\\\)/.test(target)) return true;
    // Relative paths with a directory component, including `a\\b.py`.
    if (/^[\w@%+=~.-]+[\\/][^\\/]/.test(target)) return true;
    // A relative file name is useful when a CLI prints `README.md` or
    // `package.json`; require a conventional extension to avoid linking prose.
    if (/(?:^|[\\/])[^\\/\s]+\.[A-Za-z][A-Za-z0-9_-]{0,19}$/.test(target)) return true;
    return /^(?:README|LICENSE|Makefile|Dockerfile|Procfile|Gemfile|Rakefile|justfile|\.env(?:\.[\w-]+)?|go(?:\.mod|\.sum)?|Cargo\.toml|pyproject\.toml|requirements\.txt)$/i.test(target);
  }

  function normalizeTerminalPath(value) {
    let target = trimTerminalTarget(value);
    if (!target || isTerminalURL(target)) return target;
    // Compiler and test runners append `:line[:column]` or `#Lline` to paths.
    // Opening that suffix would fail, so retain only the actual path.
    target = target.replace(/:(\d+)(?::\d+)?$/, '');
    target = target.replace(/#L\d+(?:-L\d+)?$/, '');
    return target;
  }

  function terminalTargetMatches(value) {
    const source = String(value || ''), matches = [];
    terminalTargetPattern.lastIndex = 0;
    let match;
    while ((match = terminalTargetPattern.exec(source))) {
      const raw = match[0];
      const quoteWrapped = (raw.startsWith('"') || raw.startsWith("'")) && raw.endsWith(raw[0]);
      const rawInner = quoteWrapped ? raw.slice(1, -1) : raw;
      let target = trimTerminalTarget(rawInner);
      const leadingOffset = rawInner.indexOf(target);
      let start = match.index + (quoteWrapped ? 1 : 0) + Math.max(0, leadingOffset);
      if (!target) continue;
      const kind = isTerminalURL(target) ? 'url' : 'path';
      if (kind === 'path') target = normalizeTerminalPath(target);
      if (!target || (kind === 'path' && !isTerminalPath(target))) continue;
      // A normalized line/column suffix is not part of the link range.
      const end = start + target.length;
      matches.push({target, kind, start, end});
      if (end < match.index + match[0].length) terminalTargetPattern.lastIndex = end;
    }
    return matches;
  }

  function renderWorkbenchTerminalOutput(output, value) {
    if (!output) return;
    // CLI tools often color file names with ANSI SGR sequences. They are not
    // meaningful in a browser terminal, and would otherwise become part of
    // the link target, so remove terminal control sequences before scanning.
    const source = String(value || '').replace(/\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g, '');
    const fragment = document.createDocumentFragment();
    let cursor = 0;
    for (const item of terminalTargetMatches(source)) {
      if (item.start < cursor) continue;
      if (item.start > cursor) fragment.append(document.createTextNode(source.slice(cursor, item.start)));
      const link = document.createElement('a');
      link.className = `workbench-terminal-target ${item.kind}`;
      link.dataset.terminalTarget = item.target;
      link.dataset.terminalTargetKind = item.kind;
      link.href = item.kind === 'url' ? item.target : '#';
      link.title = item.kind === 'url' ? '按住 Ctrl 点击或按 Enter 打开网址' : '按住 Ctrl 点击或按 Enter 打开文件或目录';
      link.setAttribute('aria-label', `${item.target}（按住 Ctrl 点击打开）`);
      link.textContent = item.target;
      link.addEventListener('click', event => {
        event.preventDefault();
        // A normal click should behave like terminal text selection. Ctrl
        // (or Cmd on macOS) is the explicit open gesture requested by the UI.
        if (!event.ctrlKey && !event.metaKey) return;
        void openWorkbenchTerminalTarget(link, output.closest('.workbench-terminal-card'));
      });
      link.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          void openWorkbenchTerminalTarget(link, output.closest('.workbench-terminal-card'));
        }
      });
      fragment.append(link);
      cursor = item.end;
    }
    if (cursor < source.length) fragment.append(document.createTextNode(source.slice(cursor)));
    output.replaceChildren(fragment);
  }

  function terminalSessionForOutput(output) {
    const kind = output?.dataset?.terminalOutput;
    return kind ? state.workbench.terminals[kind] : null;
  }

  async function openWorkbenchTerminalTarget(linkOrTarget, terminal) {
    const link = linkOrTarget?.dataset ? linkOrTarget : null;
    const target = link ? link.dataset.terminalTarget : String(linkOrTarget || '').trim();
    const kind = link?.dataset?.terminalTargetKind || (/^https?:\/\//i.test(target) ? 'url' : 'path');
    const output = terminal?.querySelector?.('[data-terminal-output]');
    const session = terminalSessionForOutput(output);
    if (!target) return;
    try {
      if (!api?.openWorkbenchTarget) throw new Error('当前运行环境不支持打开终端目标。');
      await api.openWorkbenchTarget({target, cwd: session?.cwd || terminal?.dataset?.terminalCwd || ''});
      toast(kind === 'url' ? '已打开网址' : '已打开文件或目录');
    } catch (error) {
      toast(`打开失败：${errorMessage(error)}`);
    }
  }

  function handleWorkbenchTerminalTab(event, input, output) {
    if (event.key !== 'Tab') return;
    const typed = terminalTargetMatches(input.value)[0];
    if (typed) {
      event.preventDefault();
      void openWorkbenchTerminalTarget(typed.target, output.closest('.workbench-terminal-card'));
      return;
    }
    const targets = [...output.querySelectorAll('[data-terminal-target]')];
    if (!targets.length) return;
    event.preventDefault();
    const current = targets.indexOf(document.activeElement);
    const direction = event.shiftKey ? -1 : 1;
    targets[(current + direction + targets.length) % targets.length].focus();
  }

  function ensureWorkbenchTerminal(kind) {
    const panel = $(`workbench-${kind}-panel`);
    if (!panel) return null;
    let terminal = panel.querySelector('.workbench-terminal-card');
    if (terminal) {
      const output = terminal.querySelector(`[data-terminal-output="${kind}"]`);
      if (output) renderWorkbenchTerminalOutput(output, state.workbench.terminals[kind]?.output || '');
      return terminal;
    }
    terminal = text('section', undefined, 'workbench-terminal-card');
    const screen = text('div', undefined, 'workbench-terminal-screen');
    const output = text('pre', undefined, 'workbench-terminal-output');
    output.dataset.terminalOutput = kind;
    output.setAttribute('aria-live', 'polite');
    const form = document.createElement('form');
    form.className = 'workbench-terminal-prompt';
    form.append(text('span', '›', 'workbench-terminal-prompt-symbol'));
    const input = document.createElement('input');
    input.type = 'text'; input.autocomplete = 'off'; input.spellcheck = false;
    input.placeholder = '输入命令或消息，按 Enter 执行；网址/路径按住 Ctrl 点击打开'; input.setAttribute('aria-label', `${workbenchToolName(kind)} 终端输入`);
    input.addEventListener('keydown', event => handleWorkbenchTerminalTab(event, input, output));
    form.append(input);
    form.addEventListener('submit', event => {
      event.preventDefault();
      const session = state.workbench.terminals[kind];
      const value = input.value;
      if (!session?.sessionId || !value) return;
      input.value = '';
      appendWorkbenchTerminal(kind, `\n> ${value}\n`);
      void api?.writeWorkbenchTerminal?.({session_id: session.sessionId, text: `${value}\n`});
    });
    screen.append(output, form);
    terminal.append(screen);
    const slot = $(`workbench-${kind}-terminal-slot`);
    (slot || panel).append(terminal);
    if (!state.workbench.terminals[kind]) state.workbench.terminals[kind] = {output: ''};
    renderWorkbenchTerminalOutput(output, state.workbench.terminals[kind].output || '');
    return terminal;
  }

  function appendWorkbenchTerminal(kind, value, tabId = state.appTab) {
    const owner = tabId === state.appTab ? state.workbench : state.workbenchSessions.get(tabId);
    if (!owner) return;
    owner.terminals = owner.terminals && typeof owner.terminals === 'object' ? owner.terminals : {};
    const session = owner.terminals[kind] || (owner.terminals[kind] = {output: ''});
    session.output = `${session.output || ''}${String(value || '')}`.slice(-200000);
    if (tabId !== state.appTab) return;
    const output = document.querySelector(`[data-terminal-output="${kind}"]`);
    if (!output) return;
    renderWorkbenchTerminalOutput(output, session.output);
    output.scrollTop = output.scrollHeight;
  }

  function updateWorkbenchTerminal(event) {
    const kind = event.kind;
    if (!['claude', 'hermes', 'codex', 'agent'].includes(kind)) return;
    const tabId = typeof event.tab_id === 'string' && isWorkbenchTab(event.tab_id) ? event.tab_id : state.appTab;
    if (tabId !== state.appTab && !state.workbenchSessions.has(tabId)) return;
    if (tabId === state.appTab) ensureWorkbenchTerminal(kind);
    const owner = tabId === state.appTab ? state.workbench : state.workbenchSessions.get(tabId);
    if (owner && event.cwd) {
      owner.terminals = owner.terminals && typeof owner.terminals === 'object' ? owner.terminals : {};
      owner.terminals[kind] = {...(owner.terminals[kind] || {}), cwd: event.cwd};
    }
    if (event.type === 'workbench-terminal-output') appendWorkbenchTerminal(kind, event.data, tabId);
    if (event.type === 'workbench-terminal-state') {
      const terminal = owner?.terminals?.[kind];
      const states = {started: '运行中', closed: '已结束', error: '启动失败'};
      setWorkbenchTabStatus(event.message || states[event.state] || event.state || '运行中', tabId);
      if ((event.state === 'closed' || event.state === 'error') && terminal) terminal.sessionId = null;
    }
  }

  async function launchWorkbenchTool(kind) {
    const tabId = state.appTab;
    const selected = kind === 'agent' ? null : state.workbench.providers.find(provider => kind === 'claude' ? provider.apiType === 'anthropic' : provider.apiType === 'openai') || state.workbench.providers[0] || null;
    const model = selected?.model || '';
    const cwd = '';
    setWorkbenchTabStatus('启动中…');
    ensureWorkbenchTerminal(kind);
    try {
      const previous = state.workbench.terminals[kind];
      if (previous?.sessionId) await api?.stopWorkbenchTerminal?.({session_id: previous.sessionId});
      let result;
      if (kind === 'agent') {
        if (!api?.launchDesktopAgent) throw new Error('请通过 Electron 应用打开页内终端。');
        result = await api.launchDesktopAgent({mode: 'chat', embedded: true, tab_id: tabId});
      } else {
        if (!api?.launchWorkbenchTool) throw new Error('请通过 Electron 应用打开页内终端。');
        result = await api.launchWorkbenchTool({kind, cwd, model, provider_id: selected?.id || '', embedded: true, tab_id: tabId});
      }
      const owner = tabId === state.appTab ? state.workbench : state.workbenchSessions.get(tabId);
      if (owner) owner.terminals[kind] = {...(owner.terminals[kind] || {}), sessionId: result.session_id || null, cwd: result.cwd || owner.terminals[kind]?.cwd || ''};
      appendWorkbenchTerminal(kind, `$ ${kind}${model ? ` --model ${model}` : ''}\n`, tabId);
      setWorkbenchTabStatus(`运行中${result.model ? ` · ${result.model}` : ''}`, tabId);
    } catch (error) {
      setWorkbenchTabStatus('启动失败', tabId);
      toast(`无法启动 ${workbenchToolName(kind)}：${errorMessage(error)}`);
    }
  }

  function workbenchWebBounds() {
    const rect = $('workbench-web-preview')?.getBoundingClientRect();
    const main = document.querySelector('.workbench-main')?.getBoundingClientRect();
    if (!rect || !main) return null;
    const left = Math.max(rect.left, main.left, 0), top = Math.max(rect.top, main.top, 0);
    const right = Math.min(rect.right, main.right, window.innerWidth), bottom = Math.min(rect.bottom, main.bottom, window.innerHeight);
    if (right - left < 120 || bottom - top < 100) return null;
    return {x: Math.round(left), y: Math.round(top), width: Math.round(right - left), height: Math.round(bottom - top)};
  }

  function hideWorkbenchWeb() {
    state.workbench.webVisible = false;
    if (api?.hideWorkbenchWeb) void api.hideWorkbenchWeb().catch(() => {});
  }

  async function syncWorkbenchWeb() {
    if (!state.workbench.webVisible || !isWorkbenchTab(state.appTab) || state.workbench.tab !== 'web') { hideWorkbenchWeb(); return; }
    const bounds = workbenchWebBounds();
    if (!bounds) { if (api?.hideWorkbenchWeb) void api.hideWorkbenchWeb().catch(() => {}); return; }
    try {
      if (api?.setWorkbenchWeb) await api.setWorkbenchWeb({url: state.workbench.webUrl, bounds});
      else window.open(state.workbench.webUrl, '_blank', 'noopener,noreferrer');
    } catch (error) { toast(`网页加载失败：${errorMessage(error)}`); }
  }

  async function showWorkbenchWeb(url) {
    let value = String(url || '').trim();
    if (!value) return;
    if (!/^[a-z][a-z\d+.-]*:\/\//i.test(value)) value = `https://${value}`;
    try {
      $('workbench-web-url').value = value; state.workbench.webUrl = value; state.workbench.webVisible = true;
      updateWorkbenchWebFavoriteButton();
      await syncWorkbenchWeb();
      updateWorkbenchBrowserStatus('loading');
      toast('网页已显示');
    } catch (error) { toast(`无法打开网页：${errorMessage(error)}`); }
  }

  function persistWebFavorites() {
    try { localStorage.setItem(webFavoritesStorageKey, JSON.stringify(state.webFavorites)); } catch {}
  }

  function renderWorkbenchWebFavorites() {
    const container = $('workbench-web-favorites');
    if (!container) return;
    container.replaceChildren();
    state.webFavorites.forEach((favorite, index) => {
      const item = text('span', undefined, 'workbench-favorite-item');
      const open = text('button', favorite.title || favorite.url, 'workbench-favorite');
      open.type = 'button'; open.title = favorite.url;
      open.addEventListener('click', () => { $('workbench-web-url').value = favorite.url; void showWorkbenchWeb(favorite.url); });
      const remove = text('button', '×', 'workbench-favorite-remove');
      remove.type = 'button'; remove.title = '取消收藏'; remove.setAttribute('aria-label', `取消收藏 ${favorite.title || favorite.url}`);
      remove.addEventListener('click', () => {
        state.webFavorites.splice(index, 1);
        persistWebFavorites(); renderWorkbenchWebFavorites(); updateWorkbenchWebFavoriteButton();
      });
      item.append(open, remove); container.append(item);
    });
  }

  function updateWorkbenchWebFavoriteButton() {
    const button = $('workbench-web-favorite');
    if (!button) return;
    const url = String(state.workbench.webUrl || $('workbench-web-url')?.value || '').trim();
    const favorite = state.webFavorites.some(item => item.url === url);
    button.textContent = favorite ? '★' : '☆';
    button.title = favorite ? '取消收藏当前网址' : '收藏当前网址';
    button.setAttribute('aria-label', button.title);
    button.classList.toggle('active', favorite);
  }

  function toggleWorkbenchWebFavorite() {
    let url = String(state.workbench.webUrl || $('workbench-web-url')?.value || '').trim();
    if (!url) return;
    if (!/^[a-z][a-z\d+.-]*:\/\//i.test(url)) url = `https://${url}`;
    if (!/^https?:\/\//i.test(url)) { toast('仅支持收藏 HTTP(S) 网页。'); return; }
    const index = state.webFavorites.findIndex(item => item.url === url);
    if (index >= 0) {
      state.webFavorites.splice(index, 1);
      toast('已取消收藏');
    } else {
      let title = url;
      try { title = new URL(url).hostname || url; } catch {}
      state.webFavorites.unshift({url, title});
      state.webFavorites = state.webFavorites.slice(0, 30);
      toast('网址已收藏');
    }
    state.workbench.webUrl = url;
    $('workbench-web-url').value = url;
    persistWebFavorites(); renderWorkbenchWebFavorites(); updateWorkbenchWebFavoriteButton();
  }

  function updateWorkbenchBrowserStatus(stateName = 'idle', details = {}) {
    const label = $('workbench-web-status'), dot = $('workbench-web-status-dot');
    const labels = {idle: '输入地址后打开网页', loading: '正在加载网页…', ready: '网页已就绪', error: '网页加载失败'};
    if (label) label.textContent = details.url || labels[stateName] || stateName;
    if (dot) dot.className = `status-dot ${stateName === 'ready' ? 'ready' : stateName === 'error' ? 'error' : stateName === 'loading' ? 'busy' : ''}`;
    const tabLabels = {idle: '待打开', loading: '加载中…', ready: '就绪', error: '加载失败'};
    setWorkbenchTabStatus(tabLabels[stateName] || stateName);
    const back = $('workbench-web-back'), forward = $('workbench-web-forward');
    if (back) back.disabled = details.canGoBack === false;
    if (forward) forward.disabled = details.canGoForward === false;
    updateWorkbenchWebFavoriteButton();
  }

  async function controlWorkbenchWeb(action) {
    try {
      if (!api?.controlWorkbenchWeb) return;
      updateWorkbenchBrowserStatus(action === 'reload' ? 'loading' : 'idle');
      const result = await api.controlWorkbenchWeb(action);
      if (result?.url) { state.workbench.webUrl = result.url; $('workbench-web-url').value = result.url; }
      updateWorkbenchBrowserStatus('ready', result || {});
    } catch (error) { updateWorkbenchBrowserStatus('error'); toast(`网页操作失败：${errorMessage(error)}`); }
  }

  async function openWorkbenchWebExternal(url) {
    const value = String(url || '').trim();
    if (!value) return;
    try { if (api?.openWorkbenchWeb) await api.openWorkbenchWeb({url: value}); else window.open(value, '_blank', 'noopener,noreferrer'); toast('网页已在系统浏览器打开'); }
    catch (error) { toast(`无法打开网页：${errorMessage(error)}`); }
  }

  async function createWorkbenchTab(kind) {
    if (!['providers', 'chat', 'claude', 'hermes', 'codex', 'agent', 'web'].includes(kind)) return;
    const id = `workbench-${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    state.tabs.push({id, kind, title: workbenchTitle(kind), status: kind === 'web' ? '待打开' : ['claude', 'hermes', 'codex', 'agent'].includes(kind) ? '启动中…' : '就绪'});
    state.workbenchSessions.set(id, newWorkbenchSession(kind));
    await switchAppTab(id);
    if (kind === 'web') $('workbench-web-url')?.focus();
    if (['claude', 'hermes', 'codex', 'agent'].includes(kind)) requestAnimationFrame(() => { if (state.appTab === id) void launchWorkbenchTool(kind); });
  }

  function closeAppTabMenu() {
    const menu = $('app-tab-menu'), button = $('app-tab-add');
    if (!menu || !button) return;
    menu.hidden = true; button.setAttribute('aria-expanded', 'false');
  }

  async function createAppTab(kind) {
    closeAppTabMenu();
    if (kind === 'desktop-agent') { await switchAppTab('desktop-agent'); return; }
    await createWorkbenchTab(kind);
  }

  function safeMarkdown(markdown) {
    const container = text('div', undefined, 'markdown');
    if (window.marked && window.DOMPurify) {
      container.innerHTML = window.DOMPurify.sanitize(window.marked.parse(String(markdown || ''), {gfm: true, breaks: false}), {
        USE_PROFILES: {html: true}, FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'iframe', 'video', 'audio'],
        FORBID_ATTR: ['style', 'srcset', 'id', 'name'], ALLOW_DATA_ATTR: false
      });
    } else {container.textContent = markdown; container.classList.add('plain-markdown');}
    enhanceRunnableCodeBlocks(container);
    return container;
  }

  const runnableLanguages = new Map([
    ['python', 'python'], ['py', 'python'], ['python3', 'python'], ['bash', 'shell'], ['sh', 'shell'], ['shell', 'shell'],
    ['javascript', 'javascript'], ['js', 'javascript'], ['node', 'javascript'], ['c', 'c'], ['cpp', 'cpp'], ['c++', 'cpp'],
    ['java', 'java'], ['html', 'html'], ['htm', 'html'],
  ]);
  const projectLanguageExtensions = {python: 'py', shell: 'sh', javascript: 'js', c: 'c', cpp: 'cpp', java: 'java', html: 'html'};
  function runnableLanguage(code) {
    const className = [...(code?.classList || [])].find(item => item.startsWith('language-')) || '';
    const explicit = runnableLanguages.get(className.slice('language-'.length).toLowerCase());
    if (explicit) return explicit;
    const source = String(code?.textContent || '');
    if (/^#!.*\b(?:python|python3)\b/m.test(source) || /\bimport\s+(?:os|sys|subprocess|requests)\b/.test(source)) return 'python';
    if (/^#!.*\b(?:ba|z)?sh\b/m.test(source) || /\b(?:echo|fi|then)\b/.test(source) && /\$\w+/.test(source)) return 'shell';
    if (/<(?:!doctype\s+html|html|body)\b/i.test(source)) return 'html';
    if (/#include\s*[<"](?:iostream|vector|string)/.test(source) || /std::(?:cout|cin|vector)/.test(source)) return 'cpp';
    if (/#include\s*[<"](?:stdio|stdlib|string)\.h/.test(source)) return 'c';
    if (/\bpublic\s+(?:static\s+)?class\s+\w+/.test(source) || /public\s+static\s+void\s+main/.test(source)) return 'java';
    if (/\b(?:const|let|var)\s+\w+\s*=|console\.log\s*\(/.test(source)) return 'javascript';
    return '';
  }

  function showCodeResult(pre, message, kind = '') {
    let result = pre.nextElementSibling;
    if (!result?.classList.contains('code-run-result')) { result = text('pre', undefined, 'code-run-result'); pre.after(result); }
    result.className = `code-run-result${kind ? ` ${kind}` : ''}`;
    result.textContent = String(message || '');
    result.hidden = false;
    return result;
  }

  function projectProvider() {
    const selected = $('project-run-provider')?.value || '';
    return state.workbench.providers.find(provider => provider.id === selected) || state.workbench.providers.find(provider => provider.model) || null;
  }

  async function askWorkbenchModel(provider, messages) {
    if (provider?.id && provider.model && api?.workbenchChat) return api.workbenchChat({provider_id: provider.id, model: provider.model, messages});
    if (api?.request && state.config?.providers?.some(item => item.enabled)) {
      const response = await api.request('POST', '/v1/chat/completions', {model: 'web-fusion', messages, stream: false});
      const content = response?.choices?.[0]?.message?.content;
      if (typeof content === 'string') return {content, model: response.model || 'web-fusion'};
    }
    throw new Error('请先在设置中配置可用的大模型。');
  }

  function extractFirstCode(markdown, language) {
    const wanted = String(language || '').toLowerCase();
    const pattern = /```([^\n]*)\n([\s\S]*?)```/g;
    let match;
    while ((match = pattern.exec(String(markdown || '')))) {
      const info = match[1].trim().split(/\s+/)[0].replace(/^language-/, '').toLowerCase();
      if (!wanted || runnableLanguages.get(info) === wanted || info === wanted) return match[2].replace(/^\n+|\n+$/g, '');
    }
    return '';
  }

  async function repairAndRerun({language, content, filename, error, project = false, files = []}) {
    if (!state.workbench.loaded) { try { await loadWorkbenchProviders(); } catch {} }
    const provider = projectProvider();
    const system = project
      ? '你是项目修复工程师。根据运行错误修复项目，保留可运行的项目结构。需要依赖时一并生成 requirements.txt 或 package.json。只输出需要修改或新增的代码文件，使用 ```语言 path/to/file.ext 的代码块，不要解释。'
      : '你是代码修复工程师。根据运行错误修复代码；需要第三方依赖时同时输出 requirements.txt 或 package.json。只输出完整可运行代码文件，不要 Markdown 解释。';
    const context = project ? files.map(file => `文件 ${file.name}:\n${file.content}`).join('\n\n') : content;
    const result = await askWorkbenchModel(provider, [{role: 'system', content: system}, {role: 'user', content: `语言：${language}\n${context}\n\n运行错误：\n${error}`}]);
    if (project) {
      const repaired = extractProjectFiles(result.content, language, files);
      return api.runProject({language, files: repaired, installDependencies: true});
    }
    const repairedFiles = extractProjectFiles(result.content, language);
    if (repairedFiles.length > 1) return api.runProject({language, files: repairedFiles, installDependencies: true});
    const repairedCode = extractFirstCode(result.content, language) || result.content.replace(/^```[^\n]*\n?|```$/g, '').trim();
    return api.runCode({language, content: repairedCode, filename, installDependencies: true});
  }

  async function runCodeSnippet(pre, language, content, filename) {
    const toolbarButton = pre.querySelector('.code-run-toolbar button');
    if (toolbarButton) toolbarButton.disabled = true;
    const result = showCodeResult(pre, '正在保存并执行…');
    try {
      const response = await api.runCode({language, content, filename, installDependencies: true});
      if (!response?.ok) throw new Error(response?.output || '程序退出时返回错误。');
      const output = [response.output || '', response.filePath ? `\n文件：${response.filePath}` : ''].join('').trim() || '执行完成（没有输出）。';
      result.className = 'code-run-result'; result.textContent = output;
      if (response.filePath && language === 'html') { try { await api.openWorkbenchTarget({target: response.filePath}); } catch {} }
    } catch (error) {
      result.className = 'code-run-result error'; result.textContent = `执行失败：${errorMessage(error)}\n正在请求大模型修复…`;
      try {
        const repaired = await repairAndRerun({language, content, filename, error: errorMessage(error)});
        const output = [repaired.output || '', repaired.filePath ? `\n文件：${repaired.filePath}` : ''].join('').trim() || '修复后执行完成。';
        result.className = `code-run-result ${repaired.ok ? 'repair' : 'error'}`; result.textContent = `${repaired.ok ? '大模型已修复并重试：' : '大模型已尝试修复，但仍有错误：'}\n${output}`;
      } catch (repairError) { result.textContent += `\n修复失败：${errorMessage(repairError)}`; }
    } finally { if (toolbarButton) toolbarButton.disabled = false; }
  }

  function extractProjectFiles(markdown, language, existing = []) {
    const files = [];
    const pattern = /```([^\n]*)\n([\s\S]*?)```/g;
    let match, index = 0;
    while ((match = pattern.exec(String(markdown || '')))) {
      const info = match[1].trim();
      const tokens = info.split(/\s+/).filter(Boolean);
      const normalized = runnableLanguages.get((tokens[0] || '').replace(/^language-/, '').toLowerCase()) || language;
      if (normalized !== language && language !== 'html') continue;
      const extension = projectLanguageExtensions[language] || 'txt';
      const candidate = tokens.slice(1).find(item => /[./\\]/.test(item) && /\.[A-Za-z0-9]+$/.test(item)) || '';
      const body = match[2].replace(/^\n+|\n+$/g, '');
      const header = body.match(/^(?:#|\/\/|<!--)\s*(?:filename|file|path)\s*[:=]\s*([^\s>]+).*\n/i);
      const name = candidate || header?.[1] || (index === 0 ? `main.${extension}` : `module-${index}.${extension}`);
      files.push({name: name.replace(/^['"]|['"]$/g, ''), content: header ? body.slice(header[0].length) : body}); index++;
    }
    return files.length ? files : existing;
  }

  async function runProjectFiles(files, language, outputElement, statusElement) {
    if (!files.length) {
      outputElement.hidden = false; outputElement.className = 'project-run-output error';
      outputElement.textContent = '最近的回复中没有可运行代码块。请让模型按“语言 文件名”输出代码文件。';
      statusElement.textContent = '没有找到可运行文件';
      return;
    }
    statusElement.textContent = `已解析 ${files.length} 个文件，正在编译运行…`;
    try {
      const response = await api.runProject({language, files, installDependencies: true});
      outputElement.hidden = false; outputElement.className = `project-run-output${response.ok ? '' : ' error'}`;
      outputElement.textContent = response.output || (response.ok ? '项目运行完成（没有输出）。' : '项目运行失败。');
      statusElement.textContent = response.ok ? `运行完成：${response.selected || files[0].name}` : '运行失败，正在尝试大模型修复…';
      if (!response.ok) {
        const repaired = await repairAndRerun({language, files, error: response.output || '未知运行错误', project: true});
        outputElement.className = `project-run-output${repaired.ok ? '' : ' error'}`; outputElement.textContent = repaired.output || (repaired.ok ? '修复后运行完成。' : '修复后仍未运行成功。');
        statusElement.textContent = repaired.ok ? '大模型已修复项目并完成运行。' : '大模型修复后仍有错误，请查看输出。';
      }
    } catch (error) { outputElement.hidden = false; outputElement.className = 'project-run-output error'; outputElement.textContent = errorMessage(error); statusElement.textContent = '项目运行失败'; }
  }

  function enhanceRunnableCodeBlocks(container) {
    container.querySelectorAll('pre > code').forEach(code => {
      const language = runnableLanguage(code), pre = code.parentElement;
      if (!language || pre.dataset.runnableEnhanced) return;
      pre.dataset.runnableEnhanced = 'true';
      const toolbar = text('div', undefined, 'code-run-toolbar');
      toolbar.append(text('span', language.toUpperCase()));
      const button = text('button', '▶ 运行'); button.type = 'button';
      button.addEventListener('click', () => { void runCodeSnippet(pre, language, code.textContent || '', `main.${projectLanguageExtensions[language] || 'txt'}`); });
      toolbar.append(button); pre.append(toolbar);
    });
  }

  async function openProjectRunner() {
    $('project-run-dialog').hidden = false;
    try { await loadWorkbenchProviders(); } catch {}
    const select = $('project-run-provider'); select.replaceChildren();
    state.workbench.providers.filter(provider => provider.model).forEach(provider => select.add(new Option(`${provider.name} · ${provider.model}`, provider.id)));
    if (!select.options.length) select.add(new Option('请先配置 Provider', ''));
    if (state.workbench.activeProviderId) select.value = state.workbench.activeProviderId;
    $('project-run-requirement').focus();
  }

  function closeProjectRunner() { $('project-run-dialog').hidden = true; }

  async function generateProjectPrompt() {
    const provider = projectProvider(), language = $('project-run-language').value, requirement = $('project-run-requirement').value.trim();
    if (!requirement) { $('project-run-status').textContent = '请先填写项目需求。'; return; }
    $('project-run-status').textContent = '正在让大模型整理项目提示词…';
    try {
      const result = await askWorkbenchModel(provider, [{role: 'system', content: '你是项目提示词设计师。把用户需求改写成给代码模型的清晰任务提示词。要求输出完整可运行项目，明确列出目录结构、每个文件路径和代码块，代码围栏写成 ```语言 文件名。不要直接实现项目。'}, {role: 'user', content: `目标语言：${language}\n项目需求：${requirement}`}]);
      $('project-run-prompt').value = result.content || '';
      $('prompt').value = result.content || '';
      updateControls(); $('project-run-status').textContent = '提示词已填入当前页面输入框；关闭窗口后点击发送即可生成项目。';
    } catch (error) { $('project-run-status').textContent = `生成失败：${errorMessage(error)}`; }
  }

  async function runLatestProject() {
    const language = $('project-run-language').value, latest = [...state.messages].reverse().find(message => message.role === 'assistant');
    const files = extractProjectFiles(latest?.content || '', language);
    await runProjectFiles(files, language, $('project-run-output'), $('project-run-status'));
  }

  async function runAssistantProject(markdown) {
    const first = String(markdown || '').match(/```([^\n]*)\n/);
    const hinted = runnableLanguages.get((first?.[1] || '').trim().split(/\s+/)[0].replace(/^language-/, '').toLowerCase());
    await openProjectRunner();
    if (hinted && $('project-run-language').querySelector(`option[value="${hinted}"]`)) $('project-run-language').value = hinted;
    await runProjectFiles(extractProjectFiles(markdown, $('project-run-language').value), $('project-run-language').value, $('project-run-output'), $('project-run-status'));
  }

  function renderMessages() {
    $('messages').replaceChildren();
    $('empty-state').hidden = state.messages.length > 0 || state.busy;
    state.messages.forEach((message, index) => {
      if (!['user', 'assistant', 'system'].includes(message.role)) return;
      const section = text('article', undefined, `message ${message.role}`);
      const heading = text('div', undefined, 'message-heading');
      heading.append(text('span', message.role === 'assistant' ? '✦' : message.role === 'system' ? 'S' : '你', 'avatar'));
      heading.append(text('span', message.role === 'assistant' ? 'MultiLLM Fusion' : message.role === 'system' ? '系统' : '你'));
      if (message.role === 'assistant') heading.append(text('span', '融合结果', 'message-label-note'));
      section.append(heading);
      const body = text('div', undefined, 'message-body');
      if (message.role === 'assistant') body.append(safeMarkdown(message.content)); else body.textContent = message.content;
      section.append(body);
      if (message.role === 'assistant') {
        const turn = state.turns.get(index);
        const actions = text('div', undefined, 'message-tools');
        const copy = text('button', '复制 Markdown', 'button subtle'); copy.type = 'button';
        copy.addEventListener('click', () => copyText(message.content));
        const save = text('button', '导出 .md ↗', 'button subtle'); save.type = 'button';
        save.addEventListener('click', () => saveMarkdown(`fusion-${turn?.request_id || index}.md`, message.content));
        const runProject = text('button', '▶ 运行项目', 'button subtle'); runProject.type = 'button';
        runProject.addEventListener('click', () => { void runAssistantProject(message.content); });
        actions.append(copy, save, runProject);
        if (turn?.mode) actions.append(text('span', modeName(turn.mode), 'mode-label'));
        section.append(actions);
        if (turn?.sources?.length) {
          const sources = text('div', undefined, 'source-list');
          turn.sources.forEach((source) => {
            const item = text('details', undefined, 'source-item');
            const summary = text('summary'); summary.append(text('strong', providerName(source.provider)), text('span', '查看原始回答'));
            const content = text('div', undefined, 'source-content'); content.append(safeMarkdown(source.markdown));
            const exportButton = text('button', '导出原始 Markdown ↗', 'button subtle'); exportButton.type = 'button';
            exportButton.addEventListener('click', () => saveMarkdown(`${source.provider}-${turn.request_id || index}.md`, source.markdown));
            content.append(exportButton); item.append(summary, content); sources.append(item);
          });
          section.append(sources);
        }
        if (turn?.errors?.length) {
          const errors = turn.errors.map((error) => typeof error === 'string' ? error : `${error.provider ? providerName(error.provider) + '：' : ''}${error.message || error.code || '未能返回结果'}`);
          section.append(text('div', `本轮提示\n${errors.join('\n')}`, 'run-error'));
        }
      }
      $('messages').append(section);
    });
    if (state.busy) {
      const placeholder = text('div', undefined, 'busy-placeholder');
      placeholder.append(text('span', undefined, 'spinner'), text('span', '正在收集回答并整合，请稍候…')); $('messages').append(placeholder);
    }
  }
  function modeName(mode) {return ({web: '网页语义整合', api: 'API 语义整合', single: '单模型结果', passthrough: '单模型结果', partial: '部分结果'})[mode] || mode;}
  function scrollBottom() {requestAnimationFrame(() => {$('conversation-scroll').scrollTop = $('conversation-scroll').scrollHeight;});}
  async function copyText(value) {try {await api.copyText(String(value)); toast('已复制');} catch (error) {toast(`复制失败：${errorMessage(error)}`);}}
  async function saveMarkdown(name, content) {try {const result = await api.saveMarkdown({name: name.replace(/[^a-zA-Z0-9._-]/g, '_'), content: String(content || '')}); if (!result.canceled) toast('Markdown 已导出');} catch (error) {toast(`导出失败：${errorMessage(error)}`);}}

  function saveLayoutPreference() {
    try {localStorage.setItem(layoutStorageKey, JSON.stringify({...state.layout, activeProvider: state.activeProvider}));} catch {}
  }
  function reconcileLayout() {
    const ids = enabledProviders().map((provider) => provider.id);
    if (!ids.includes(state.activeProvider)) state.activeProvider = ids[0] || null;
    state.layout.providers = [...new Set(state.layout.providers.filter((id) => ids.includes(id)))];
    for (const id of ids) if (state.layout.providers.length < 2 && !state.layout.providers.includes(id)) state.layout.providers.push(id);
    if (state.layout.mode === 'split' && ids.length < 2) state.layout.mode = 'tabs';
    if (!api?.setLayout) state.layout.mode = 'tabs';
  }
  function applyRatios() {
    const {chatShare, paneShare} = state.layout;
    $('workspace').style.setProperty('--chat-share', `${chatShare}fr`);
    $('workspace').style.setProperty('--web-share', `${100 - chatShare}fr`);
    $('webview-group').style.setProperty('--left-share', `${paneShare}fr`);
    $('webview-group').style.setProperty('--right-share', `${100 - paneShare}fr`);
    $('workspace-splitter').setAttribute('aria-valuenow', String(Math.round(chatShare)));
    $('panes-splitter').setAttribute('aria-valuenow', String(Math.round(paneShare)));
  }
  function renderLayout() {
    reconcileLayout();
    const split = state.layout.mode === 'split', windows = state.layout.mode === 'windows';
    $('layout-mode').value = state.layout.mode;
    $('layout-mode').querySelector('[value="split"]').disabled = enabledProviders().length < 2 || !api?.setLayout;
    $('layout-mode').querySelector('[value="windows"]').disabled = !api?.setLayout;
    document.querySelector('.browser-panel').dataset.layout = state.layout.mode;
    $('provider-tabs').hidden = split;
    $('pane-heading-0').hidden = !split;
    $('model-pane-1').hidden = !split;
    $('panes-splitter').hidden = !split;
    $('webview-group').hidden = windows;
    $('webview-group').classList.toggle('split', split);
    $('windows-placeholder').hidden = !windows;
    $('show-model-windows').hidden = !windows;
    for (let index = 0; index < 2; index++) {
      const select = $(`pane-provider-${index}`);
      const ids = enabledProviders().map((provider) => provider.id).join(',');
      if (select.dataset.options !== ids) {
        select.replaceChildren(...enabledProviders().map((provider) => new Option(provider.name, provider.id)));
        select.dataset.options = ids;
      }
      select.value = state.layout.providers[index] || '';
      for (const option of select.options) option.disabled = option.value === state.layout.providers[1 - index];
      const status = providerStates[state.layout.providers[index]] || {};
      $(`pane-status-${index}`).textContent = stateNames[status.state] || status.state || '待确认';
      $(`model-pane-${index}`).classList.toggle('active-pane', state.layout.providers[index] === inspectedProvider());
    }
    $('layout-active-provider').textContent = inspectedProvider() ? `当前：${providerName(inspectedProvider())}` : '';
    applyRatios();
  }
  function measuredBounds(id) {
    const rect = $(id).getBoundingClientRect();
    return {x: Math.max(0, Math.round(rect.left + 1)), y: Math.max(0, Math.round(rect.top + 1)),
      width: Math.max(1, Math.round(rect.width - 2)), height: Math.max(1, Math.round(rect.height - 2))};
  }
  function layoutPacket(extra = {}) {
    const mode = state.layout.mode;
    const ids = mode === 'split' ? state.layout.providers.slice(0, 2) : mode === 'tabs' ? [state.activeProvider].filter(Boolean) : [];
    return {mode, active_provider: state.activeProvider || undefined, panes: ids.map((id, index) => ({provider_id: id,
      bounds: measuredBounds(index === 0 ? 'webview-placeholder' : 'webview-placeholder-1')})),
      hidden: state.settings || isImporting() || !!state.dragging || state.diagnosticOpen, ...extra};
  }
  function publishLayout(extra = {}) {
    const packet = layoutPacket(extra);
    const operation = layoutTail.catch(() => {}).then(async () => {
      if (api?.setLayout) {
        const result = await api.setLayout(packet);
        if (result?.ok === false) throw new Error(result.error?.message || result.message || '原生网页布局未被接受');
        return result;
      }
      return api?.setBounds(packet.hidden ? null : packet.panes[0]?.bounds || null);
    });
    layoutTail = operation;
    return operation;
  }
  function scheduleBounds() {
    if (boundsFrame !== null) cancelAnimationFrame(boundsFrame);
    boundsFrame = requestAnimationFrame(() => {
      boundsFrame = null;
      if (api && state.config && !state.recoveryOpening) publishLayout().catch((error) => {console.warn('浏览器区域布局失败', errorMessage(error));});
    });
  }
  function applyRecoveryLayout(layout) {
    if (!layout?.ok || !['tabs', 'split', 'windows'].includes(layout.mode) || !enabledProviders().some(provider => provider.id === layout.active_provider)) return;
    state.layout.mode = layout.mode;
    state.activeProvider = layout.active_provider;
    if (layout.mode === 'split' && Array.isArray(layout.panes)) state.layout.providers = layout.panes.map(pane => pane.provider_id);
    state.focusedPane = Math.max(0, state.layout.providers.indexOf(state.activeProvider));
    renderProviderTabs(); renderLayout(); updateProviderStatus(); saveLayoutPreference();
  }
  async function openRecoveryProvider(id) {
    if (!canOpenRecovery() || !['manual_retry_required', 'verification_required'].includes(providerStates[id]?.state)) return;
    state.recoveryOpening = true; state.layoutUpdating = true; updateControls();
    if (boundsFrame !== null) {cancelAnimationFrame(boundsFrame); boundsFrame = null;}
    const operation = layoutTail.catch(() => {}).then(() => api.openRecoveryProvider(id));
    layoutTail = operation;
    try {
      const result = await operation;
      if (result?.ok !== true) throw new Error(result?.message || '网页重试入口暂不可用');
      applyRecoveryLayout(result);
      toast(providerStates[id]?.state === 'verification_required' ? `已打开 ${providerName(id)} 验证页面，请手动完成验证；程序不会刷新或自动重复发送。` : `已打开 ${providerName(id)} 原会话，请在网页点击重试；程序会继续等待本轮回答。`);
    } catch (error) {toast(`无法处理网页重试：${errorMessage(error)}`);}
    finally {state.recoveryOpening = false; state.layoutUpdating = false; updateControls(); scheduleBounds();}
  }
  function renderRecoveryActions() {
    const container = $('recovery-actions');
    const targets = enabledProviders().filter(provider => ['manual_retry_required', 'verification_required'].includes(providerStates[provider.id]?.state));
    container.hidden = !targets.length || !api?.openRecoveryProvider;
    container.replaceChildren(...targets.map(provider => {
      const button = text('button', `${providerStates[provider.id]?.state === 'verification_required' ? '完成人工验证' : '处理网页重试'} · ${provider.name}`, 'button subtle');
      button.type = 'button'; button.dataset.recoveryProvider = provider.id; button.disabled = !canOpenRecovery();
      button.addEventListener('click', () => openRecoveryProvider(provider.id));
      return button;
    }));
  }
  async function selectProvider(id) {
    if (isLocked() || state.settings) return;
    if (!enabledProviders().some((provider) => provider.id === id)) return;
    const previous = state.activeProvider;
    state.activeProvider = id; state.layoutUpdating = true; renderProviderTabs(); renderLayout(); updateProviderStatus(); updateControls();
    try {
      if (!api.setLayout || state.layout.mode === 'windows') await api.showProvider(id);
      await publishLayout(); saveLayoutPreference();
    } catch (error) {state.activeProvider = previous; renderLayout(); scheduleBounds(); toast(`无法打开模型：${errorMessage(error)}`);}
    finally {state.layoutUpdating = false; renderProviderTabs(); updateProviderStatus(); updateControls();}
  }
  async function changeLayout(mode, index, providerId) {
    if (isLocked() || state.settings) {renderLayout(); return;}
    if (!['tabs', 'split', 'windows'].includes(mode)) return;
    if (mode === 'split' && enabledProviders().length < 2) return;
    const previous = clone(state.layout), previousActive = state.activeProvider, previousFocus = state.focusedPane;
    if (index !== undefined) {
      if (!enabledProviders().some((provider) => provider.id === providerId) || state.layout.providers[1 - index] === providerId) {renderLayout(); return;}
      state.layout.providers[index] = providerId; state.activeProvider = providerId; state.focusedPane = index;
    }
    state.layout.mode = mode;
    if (mode === 'split' && index === undefined) state.focusedPane = Math.max(0, state.layout.providers.indexOf(state.activeProvider));
    renderLayout(); state.layoutUpdating = true; updateControls();
    try {await publishLayout(); saveLayoutPreference();}
    catch (error) {state.layout = previous; state.activeProvider = previousActive; state.focusedPane = previousFocus; renderLayout(); scheduleBounds(); toast(`切换布局失败：${errorMessage(error)}`);}
    finally {state.layoutUpdating = false; renderProviderTabs(); updateProviderStatus(); updateControls();}
  }
  function resizeShare(kind, proposed) {
    const container = $(kind === 'workspace' ? 'workspace' : 'webview-group');
    const rect = container.getBoundingClientRect();
    const padding = kind === 'workspace' ? 40 : 0;
    // The reference-style Fusion sidebar occupies the first grid track. Keep
    // it out of the chat/browser ratio so dragging the splitter remains exact.
    const sidebarWidth = kind === 'workspace' ? ($('fusion-sidebar')?.offsetWidth || 0) : 0;
    const width = Math.max(1, rect.width - padding * 2 - sidebarWidth - 12);
    const minimum = kind === 'workspace' ? 240 : 190;
    const minShare = Math.min(45, Math.max(20, minimum / width * 100));
    const value = Math.max(minShare, Math.min(100 - minShare, proposed));
    state.layout[kind === 'workspace' ? 'chatShare' : 'paneShare'] = value;
    $(kind === 'workspace' ? 'workspace-splitter' : 'panes-splitter').setAttribute('aria-valuemin', String(Math.ceil(minShare)));
    $(kind === 'workspace' ? 'workspace-splitter' : 'panes-splitter').setAttribute('aria-valuemax', String(Math.floor(100 - minShare)));
    applyRatios();
  }
  function finishResize(event) {
    if (!state.dragging || (event?.pointerId !== undefined && event.pointerId !== state.dragging.pointerId)) return;
    state.dragging = null; $('resize-overlay').hidden = true; document.body.classList.remove('resizing');
    saveLayoutPreference(); updateControls(); scheduleBounds();
  }
  function setupSplitter(id, kind) {
    $(id).addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || isLocked() || state.settings) return;
      event.preventDefault();
      state.dragging = {kind, pointerId: event.pointerId};
      $('resize-overlay').hidden = false; document.body.classList.add('resizing'); updateControls();
      // Hide BrowserViews before the pointer moves over them; they live above renderer DOM.
      publishLayout().catch((error) => {finishResize(); toast(`无法开始调整：${errorMessage(error)}`);});
      $(id).focus();
    });
    $(id).addEventListener('keydown', (event) => {
      if (isLocked() || state.settings || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const key = kind === 'workspace' ? 'chatShare' : 'paneShare';
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? 100 : state.layout[key] + (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 10 : 2);
      resizeShare(kind, next); saveLayoutPreference(); scheduleBounds();
    });
  }
  async function diagnoseSend() {
    const providerId = inspectedProvider();
    if (isLocked() || state.settings || !providerId || !api?.diagnoseSend) return;
    state.diagnosticPending = true; updateControls();
    try {
      // Capture the live page first. Hiding it first would falsify visibility and hit tests.
      state.diagnostic = await api.diagnoseSend(providerId);
      $('send-diagnostic-title').textContent = `${providerName(providerId)} 发送按钮检测`;
      const report = state.diagnostic || {}, target = report.sendTarget;
      $('send-diagnostic-summary').textContent = [
        `输入框：${report.input ? '已找到' : '未找到'}`,
        `发送按钮：${target ? '已找到' : '未匹配'}`,
        target ? `禁用：${target.disabled ? '是' : '否'}` : '',
        target ? `遮挡：${target.obscured === null || target.obscured === undefined ? '未判断' : target.obscured ? '是' : '否'}` : '',
        report.page ? `页面：${report.page.visibilityState || '未知'} / 焦点 ${report.page.hasFocus ? '有' : '无'}` : ''
      ].filter(Boolean).join(' · ');
      $('send-diagnostic-json').textContent = JSON.stringify(report, null, 2);
      state.diagnosticOpen = true; await publishLayout(); $('send-diagnostic-dialog').hidden = false;
      $('close-send-diagnostic').focus();
    } catch (error) {state.diagnosticOpen = false; toast(`按钮检测失败：${errorMessage(error)}`); scheduleBounds();}
    finally {state.diagnosticPending = false; updateControls();}
  }
  function closeDiagnostic() {
    state.diagnosticOpen = false; $('send-diagnostic-dialog').hidden = true; scheduleBounds(); updateControls(); $('diagnose-send').focus();
  }
  function renderProviderTabs() {
    const providers = enabledProviders(); $('enabled-count').textContent = providers.length;
    $('provider-tabs').replaceChildren();
    providers.forEach((provider) => {
      const tab = text('button', undefined, `provider-tab${provider.id === state.activeProvider ? ' active' : ''}`);
      tab.type = 'button'; tab.dataset.provider = provider.id; tab.setAttribute('role', 'tab'); tab.setAttribute('aria-selected', String(provider.id === state.activeProvider));
      tab.disabled = isLocked() || state.settings;
      tab.append(text('span', provider.name.slice(0, 1).toUpperCase(), 'provider-initial'), text('span', provider.name), text('span', undefined, dotClass(providerStates[provider.id]?.state)));
      tab.title = providerStates[provider.id]?.message || provider.url;
      tab.addEventListener('click', () => selectProvider(provider.id)); $('provider-tabs').append(tab);
    });
    renderSidebarProviderList();
  }
  function dotClass(value) {return `status-dot ${activeStates.has(value) ? 'busy' : ['ready', 'idle', 'connected'].includes(value) ? 'ready' : ['error', 'login_required', 'logged_out', 'disconnected'].includes(value) ? 'error' : ''}`;}
  function updateProviderStatus() {
    const providerId = inspectedProvider();
    const provider = state.config?.providers.find((item) => item.id === providerId);
    const status = providerStates[providerId] || {};
    $('provider-address').textContent = provider?.url || '尚未选择模型';
    $('provider-state-label').textContent = stateNames[status.state] || status.state || '待确认';
    $('provider-state-dot').className = dotClass(status.state);
    $('provider-message').textContent = status.message || '首次使用请在网页中登录';
    $('provider-message').title = status.message || '';
  }
  const progressNames = {queued: '等待调度', preparing: '准备网页', rate_limited: '等待访问间隔',
    send_dispatched: '已发送，等待接收', accepted: '已接收', server_responded: '服务器已响应',
    waiting_response: '等待回复', generating: '生成中', collecting: '提取并检查完整性',
    provider_completed: '已获取回复，保存原文中', candidate_saved: '完成（原文已保存）',
    provider_failed: '请求失败', candidate_failed: '失败', candidate_timed_out: '超时',
    candidate_cancelled: '已取消', retrying: '恢复重试中', manual_retry_required: '等待网页手动处理',
    retry_unavailable: '未启动重试', recovering: '恢复采集中', verification_required: '等待人工验证', verification_cleared: '验证已解除'};
  function applyRunProgress(run, report) {
    if (state.run !== run || !report || !Array.isArray(report.events)) return;
    const terminalPhase = run.finalized ? run.phase : null;
    for (const row of report.events) {
      if (!Number.isInteger(row.sequence) || row.sequence <= run.sequence) continue;
      run.sequence = row.sequence;
      if (row.stage === 'candidates_started') {run.phase = 'candidates'; run.candidateStarted ||= Date.now();}
      if (row.stage === 'fusion_started') {run.phase = 'fusion'; run.fusionStarted ||= Date.now();}
      if (row.stage === 'fusion_completed') run.phase = 'saving';
      if (['completed', 'failed', 'cancelled'].includes(row.stage)) run.phase = row.stage;
      if (row.purpose === 'candidate' && Object.hasOwn(run.providers, row.provider) && progressNames[row.stage]) {
        // Terminal saved/failed states cannot be replaced by a delayed live stage.
        const prior = run.providers[row.provider];
        if (!['candidate_saved', 'candidate_failed', 'candidate_timed_out', 'candidate_cancelled'].includes(prior)) {
          run.providers[row.provider] = row.stage;
          run.retryDetails ||= {};
          // Body-free progress comes from the local runner, never website prose.
          run.retryDetails[row.provider] = { stage: row.retry_stage || (['retrying','manual_retry_required'].includes(row.stage) ? run.retryDetails[row.provider]?.stage : undefined), remaining: row.remaining_seconds, reason: row.retry_reason };
        }
      }
      if (row.purpose === 'fusion' && row.provider && progressNames[row.stage]) run.fusionStage = `${providerName(row.provider)}：${progressNames[row.stage]}`;
    }
    if (terminalPhase) run.phase = terminalPhase;
    renderRunProgress();
  }
  async function pollRunProgress() {
    const run = state.run;
    if (!run || run.pollPending || !run.progressId) return;
    run.pollPending = true;
    try {
      const report = await api.request('GET', `/v1/progress/${run.progressId}?after=${run.sequence}`);
      applyRunProgress(run, report);
      run.progressError = false;
    } catch {run.progressError = true;} // Never fail/resubmit a chat because a status poll failed.
    finally {run.pollPending = false; if (state.run === run) renderRunProgress();}
  }
  function renderRunProgress() {
    const run = state.run, panel = $('model-progress');
    panel.hidden = !run;
    if (!run) return;
    const entries = Object.entries(run.providers), count = entries.filter(([, stage]) => stage === 'candidate_saved').length;
    const pending = entries.filter(([, stage]) => !['candidate_saved', 'candidate_failed', 'candidate_timed_out', 'candidate_cancelled'].includes(stage));
    let summary;
    if (run.phase === 'fusion' || run.phase === 'saving') summary = `${count}/${entries.length} 个候选已完成 · ${run.phase === 'saving' ? '保存整合结果' : '正在整合'}${run.fusionStage ? ' · ' + run.fusionStage : ''}`;
    else if (run.phase === 'completed') summary = '本轮已完成';
    else if (run.phase === 'failed' || run.phase === 'cancelled') summary = `${count}/${entries.length} 个候选已完成 · 本轮${run.phase === 'failed' ? '失败' : '已取消'}，未返回不完整整合结果`;
    else if (!run.candidateStarted) summary = `等待调度 · 候选阶段限时 ${run.timeout} 秒`;
    else {
      const remaining = Math.max(0, Math.ceil(run.timeout - (Date.now() - run.candidateStarted) / 1000));
      summary = `${count}/${entries.length} 已完成 · ${pending.length ? '等待 ' + pending.map(([id]) => providerName(id)).join('、') : '正在确认候选结果'} · 剩余约 ${remaining} 秒`;
    }
    if (run.progressError && state.busy) summary += ' · 状态同步暂不可用（不会重发请求）';
    const heading = $('model-progress-summary'); if (heading.textContent !== summary) heading.textContent = summary;
    const rows = $('model-progress-rows');
    for (const [id, stage] of entries) {
      let row = Array.from(rows.children).find(node => node.dataset.provider === id);
      if (!row) {row = text('div', undefined, 'model-progress-row'); row.dataset.provider = id; row.append(text('strong', providerName(id)), text('span')); rows.append(row);}
      row.dataset.stage = stage;
      let label = progressNames[stage] || stage;
      const retry = run.retryDetails?.[id];
      const retryLabels = {dom_handler:'第 1/3 级：页面重试', screenshot_click:'第 2/3 级：截图定位并点击', manual:'第 3/3 级：等待人工重试'};
      if (['retrying','manual_retry_required'].includes(stage) && retryLabels[retry?.stage]) {
        label = retryLabels[retry.stage];
        if (retry.stage === 'manual' && Number.isFinite(retry.remaining)) label += ` · 剩余 ${retry.remaining} 秒`;
      }
      if (stage === 'retry_unavailable') label += ' · ' + ({total_deadline_expired:'本轮总时限已耗尽',recovery_disabled:'恢复等待设置为 0',cancelled:'任务已取消',not_submitted:'未提交问题',already_attempted:'本轮已尝试'}[retry?.reason] || '请查看日志');
      if (row.lastElementChild.textContent !== label) row.lastElementChild.textContent = label;
    }
  }
  function updateControls() {
    if (typeof document === 'undefined' || !document.querySelectorAll) return;
    const locked = isLocked();
    ['open-settings', 'open-api', 'new-chat', 'history-select'].forEach((id) => {$(id).disabled = locked || !state.config;});
    $('prompt').disabled = locked;
    $('send-button').disabled = locked || !state.config || !state.status?.bridge_connected || !$('prompt').value.trim();
    $('send-label').textContent = state.busy ? '处理中' : '发送';
    $('reload-provider').disabled = locked || !inspectedProvider();
    $('run-status').hidden = !state.busy;
    if (state.busy) {
      const active = enabledProviders().filter((provider) => activeStates.has(providerStates[provider.id]?.state));
      $('run-status-text').textContent = active.length ? `${active.map((p) => p.name).join('、')} 正在处理…` : '正在等待模型回答与语义整合…';
      $('elapsed-time').textContent = `${Math.floor((Date.now() - state.started) / 1000)} 秒`;
    }
    const importing = isImporting();
    $('composer-note').textContent = importing ? '正在导入浏览器登录信息，请稍候' : state.busy ? (state.config?.allow_partial ? '等待所有候选任务结束，再整合成功回答（已允许部分结果）' : '等待所有候选模型成功完成回答，再进行整合') : !state.status?.bridge_connected ? '正在等待桌面浏览器连接' : state.status?.busy ? '另一个 API 请求正在使用模型网页' : `${enabledProviders().length} 个模型参与 · 请先完成网页登录`;
    $('fusion-description').textContent = state.config?.fusion.mode === 'api' ? 'API 语义整合 · 保留原文' : '网页语义整合 · 保留原文';
    const badge = $('connection-status');
    badge.className = `connection-badge ${state.status?.bridge_connected ? 'connected' : 'disconnected'}`;
    badge.lastElementChild.textContent = state.status?.bridge_connected ? (importing ? '正在导入登录' : state.status?.busy ? '模型正在工作' : '本地服务已连接') : '浏览器尚未连接';
    if (state.status?.queue_size) badge.title = `队列中有 ${state.status.queue_size} 个请求`; else badge.removeAttribute('title');
    $('provider-tabs')?.querySelectorAll('button').forEach((button) => {button.disabled = locked || state.settings;});
    $('settings-form')?.querySelectorAll('input,textarea,select').forEach((input) => {input.disabled = locked;});
    $('save-settings').disabled = locked; $('discard-settings').disabled = locked;
    $('sidebar-new-chat').disabled = locked || !state.config;
    $('sidebar-history-refresh').disabled = locked || !state.config;
    $('sidebar-settings').disabled = locked || !state.config;
    $('sidebar-provider-list')?.querySelectorAll('button').forEach((button) => {button.disabled = locked || state.settings;});
    $('sidebar-history-list')?.querySelectorAll('button').forEach((button) => {button.disabled = locked;});
    $('close-settings').disabled = state.saving || importing;
    document.querySelectorAll('.settings-tab').forEach((button) => {button.disabled = state.saving || importing;});
    ['layout-mode', 'pane-provider-0', 'pane-provider-1'].forEach((id) => {$(id).disabled = locked || state.settings || !state.config;});
    $('show-model-windows').disabled = !canReopenWindows();
    $('diagnose-send').disabled = locked || state.settings || !inspectedProvider() || !api?.diagnoseSend;
    renderRecoveryActions();
    renderRunProgress();
    ['workspace-splitter', 'panes-splitter'].forEach((id) => {$(id).setAttribute('aria-disabled', String(locked || state.settings)); $(id).tabIndex = locked || state.settings ? -1 : 0;});
    updateBrowserLoginControls();
  }
  async function pollStatus() {
    if (state.pollPending || !api) return;
    state.pollPending = true;
    try {
      state.status = await api.request('GET', '/internal/status'); state.statusErrors = 0;
      Object.entries(state.status.providers || {}).forEach(([id, status]) => {providerStates[id] = status;});
      renderProviderTabs(); renderLayout(); updateProviderStatus();
    } catch (error) {
      state.statusErrors += 1;
      if (state.statusErrors >= 2) {state.status = {bridge_connected: false, busy: false}; $('connection-status').title = errorMessage(error);}
    } finally {state.pollPending = false; updateAgentStatus(state.status?.bridge_connected ? 'ready' : 'idle'); updateControls();}
  }
  async function loadHistory() {
    const result = await api.request('GET', '/internal/history');
    state.history = Array.isArray(result.conversations) ? result.conversations : [];
    const select = $('history-select'); select.replaceChildren(new Option('历史对话', ''));
    state.history.forEach((conversation) => select.add(new Option(conversation.title || '未命名对话', conversation.id)));
    select.value = state.conversationId || '';
    renderSidebarHistory();
  }
  async function openConversation(id) {
    if (!id || isLocked()) return;
    state.run = null; $('model-progress-rows').replaceChildren();
    state.loadingHistory = true; updateControls(); setError('chat-error', '');
    try {
      const conversation = await api.request('GET', `/internal/history/${encodeURIComponent(id)}`);
      state.messages = conversation.messages || []; state.conversationId = conversation.id; state.turns = new Map();
      const assistantIndexes = state.messages.map((m, i) => m.role === 'assistant' ? i : -1).filter((i) => i >= 0);
      const runs = conversation.runs || [];
      if (assistantIndexes.length) runs.slice(-assistantIndexes.length).forEach((run, i, arr) => state.turns.set(assistantIndexes[assistantIndexes.length - arr.length + i], run));
      $('conversation-title').textContent = conversation.title || '历史对话'; $('prompt').value = ''; renderMessages(); renderSidebarHistory(); scrollBottom();
    } catch (error) {setError('chat-error', `打开对话失败：${errorMessage(error)}`); $('history-select').value = state.conversationId || '';}
    finally {state.loadingHistory = false; updateControls();}
  }
  function newConversation() {
    if (isLocked()) return;
    state.run = null; $('model-progress-rows').replaceChildren();
    state.conversationId = null; state.messages = []; state.turns = new Map(); $('history-select').value = '';
    $('conversation-title').textContent = '新的对话'; $('prompt').value = ''; setError('chat-error', ''); renderMessages(); renderSidebarHistory(); updateControls(); $('prompt').focus();
  }
  async function send(event) {
    event.preventDefault();
    const draft = $('prompt').value;
    if (!draft.trim() || isLocked()) return;
    if (!state.status?.bridge_connected) {setError('chat-error', '桌面浏览器尚未连接，请等待服务就绪后重试。'); return;}
    const priorMessages = state.messages.slice();
    // DeepSeek sessions are intentionally single-turn in the renderer: the
    // current answer is saved by the local Fusion backend, then older UI
    // messages are discarded after the request completes.
    const compactAfterSend = enabledProviders().some(provider => provider.id === 'deepseek');
    state.messages = [...priorMessages, {role: 'user', content: draft.trim()}];
    state.run = {progressId: crypto.randomUUID(), sequence: 0, pollPending: false, phase: 'queued',
      timeout: state.config.chat?.timeout_seconds ?? 180, candidateStarted: 0,
      providers: Object.fromEntries(enabledProviders().map(provider => [provider.id, 'queued']))};
    $('model-progress-rows').replaceChildren();
    state.busy = true; state.started = Date.now(); setError('chat-error', ''); renderMessages(); updateControls(); scrollBottom();
    try {
      const body = {model: 'web-fusion', messages: state.messages, stream: false, save_current_only: compactAfterSend};
      if (state.conversationId) body.conversation_id = state.conversationId;
      const result = await api.request('POST', '/v1/chat/completions', body, {progressId: state.run.progressId});
      await pollRunProgress();
      const content = result.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim()) throw new Error('服务未返回有效的文本结果。');
      state.run.phase = 'completed'; state.run.finalized = true;
      for (const source of result.fusion?.sources || []) if (Object.hasOwn(state.run.providers, source.provider)) state.run.providers[source.provider] = 'candidate_saved';
      const currentUser = state.messages.at(-1);
      const currentAssistant = {role: 'assistant', content};
      if (compactAfterSend && currentUser?.role === 'user') {
        state.messages = [currentUser, currentAssistant];
        state.turns = new Map();
        if (result.fusion) state.turns.set(1, result.fusion);
      } else {
        state.messages.push(currentAssistant);
        if (result.fusion) state.turns.set(state.messages.length - 1, result.fusion);
      }
      if (result.fusion) state.conversationId = result.fusion.conversation_id || state.conversationId;
      $('prompt').value = ''; $('conversation-title').textContent = state.messages.find((m) => m.role === 'user')?.content.slice(0, 35) || '融合对话';
      try {await loadHistory();} catch (error) {toast(`回答已完成，但历史列表刷新失败：${errorMessage(error)}`);}
    } catch (error) {await pollRunProgress(); state.run.phase = 'failed'; state.run.finalized = true; state.messages = priorMessages; $('prompt').value = draft; setError('chat-error', `${errorMessage(error)}\n问题已保留，可检查右侧网页后重新发送。`);}
    finally {state.busy = false; renderMessages(); await pollStatus(); updateControls(); scrollBottom(); $('prompt').focus();}
  }

  function updateBrowserLoginControls() {
    const locked = isLocked();
    const available = !!state.config && !!state.status?.bridge_connected;
    const selectedProfile = state.browserProfiles.some((profile) => profile.id === $('browser-profile-select').value);
    const selectedProvider = enabledProviders().some((provider) => provider.id === $('browser-login-provider').value && loginProviders.has(provider.id));
    $('detect-browser-profiles').disabled = locked || state.browserDetecting;
    $('browser-profile-select').disabled = locked || state.browserDetecting || !state.browserProfiles.length;
    $('browser-login-provider').disabled = locked || !enabledProviders().some((provider) => loginProviders.has(provider.id));
    $('import-browser-login').disabled = locked || state.browserDetecting || !available || !selectedProfile || !selectedProvider;
    $('import-login-file').disabled = locked || !available || !selectedProvider;
    $('browser-login-progress').hidden = !isImporting();
    $('import-browser-login').textContent = state.browserImporting ? '正在导入…' : '从浏览器导入登录';
  }
  function renderBrowserProviderChoices() {
    const select = $('browser-login-provider'); const selected = select.value || state.activeProvider;
    select.replaceChildren();
    enabledProviders().filter((provider) => loginProviders.has(provider.id)).forEach((provider) => select.add(new Option(provider.name, provider.id)));
    if (Array.from(select.options).some((option) => option.value === selected)) select.value = selected;
    if (!select.options.length) select.add(new Option('请先保存并启用一个常见模型', ''));
  }
  function updateBrowserProfileDetails() {
    const profile = state.browserProfiles.find((item) => item.id === $('browser-profile-select').value);
    $('browser-profile-details').textContent = profile ? `${profile.browser} · ${profile.name}\n${profile.path}` : '';
    updateBrowserLoginControls();
  }
  function renderLoginWarnings(id, warnings) {
    const container = $(id); container.replaceChildren();
    const messages = Array.isArray(warnings) ? warnings.filter((warning) => warning && typeof warning.message === 'string').slice(0, 50) : [];
    if (messages.length) {
      const list = text('ul'); messages.forEach((warning) => list.append(text('li', warning.message.slice(0, 1500)))); container.append(list);
    }
    container.hidden = !messages.length;
  }
  async function detectBrowserProfiles() {
    if (state.browserDetecting || isLocked()) return;
    state.browserDetecting = true; $('browser-profiles-status').textContent = '正在检测浏览器配置目录…';
    setError('browser-login-error', ''); updateBrowserLoginControls();
    const selected = $('browser-profile-select').value;
    try {
      if (typeof api?.listBrowserProfiles !== 'function') throw new Error('当前桌面组件不支持登录导入，请完整更新应用并重新启动。');
      const result = await api.listBrowserProfiles();
      if (result?.ok === false) throw new Error(result.error?.message || '无法检测浏览器配置目录。');
      if (result?.ok !== true || !Array.isArray(result.profiles) || result.profiles.some((profile) => !profile ||
        !['id', 'browser', 'name', 'path'].every((key) => typeof profile[key] === 'string') || !profile.id || !['firefox', 'chromium'].includes(profile.family))) {
        throw new Error('浏览器配置检测返回了无效结果，请重新检测或更新应用。');
      }
      state.browserProfiles = result.profiles;
      const select = $('browser-profile-select'); select.replaceChildren();
      state.browserProfiles.forEach((profile) => select.add(new Option(`${profile.browser} — ${profile.name}`, profile.id)));
      if (state.browserProfiles.some((profile) => profile.id === selected)) select.value = selected;
      if (!state.browserProfiles.length) select.add(new Option('未发现浏览器配置', ''));
      $('browser-profiles-status').textContent = `已检测到 ${state.browserProfiles.length} 个浏览器配置；此步骤只读取目录信息。`;
      $('browser-profiles-empty').hidden = state.browserProfiles.length > 0;
      $('browser-crypto-guidance').hidden = result.capabilities?.chromium_decryption !== false;
      renderLoginWarnings('browser-profiles-warnings', result.warnings);
      updateBrowserProfileDetails();
    } catch (error) {
      state.browserProfiles = []; $('browser-profile-select').replaceChildren(new Option('检测未完成', ''));
      $('browser-profile-details').textContent = ''; $('browser-profiles-empty').hidden = false;
      $('browser-profiles-status').textContent = '无法完成检测，可重新检测或使用扩展导出的登录文件。';
      setError('browser-login-error', `检测失败：${errorMessage(error)}`);
    } finally {state.browserDetecting = false; updateBrowserLoginControls();}
  }
  async function importBrowserLogin(fromFile) {
    if (isLocked() || (!fromFile && state.browserDetecting)) return;
    setError('browser-login-error', ''); $('browser-login-result').hidden = true;
    const providerId = $('browser-login-provider').value;
    const profileId = $('browser-profile-select').value;
    if (!enabledProviders().some((provider) => provider.id === providerId && loginProviders.has(providerId))) {
      setError('browser-login-error', '请先选择已保存并启用的目标模型。'); return;
    }
    if (!fromFile && !state.browserProfiles.some((profile) => profile.id === profileId)) {
      setError('browser-login-error', '请先检测并选择来源浏览器配置。'); return;
    }
    if (!state.status?.bridge_connected) {setError('browser-login-error', '桌面浏览器尚未连接，请等待服务就绪后重试。'); return;}
    state.browserImporting = true; updateControls();
    try {
      await publishLayout({hidden: true});
      const method = fromFile ? 'importLoginFile' : 'importBrowserLogin';
      if (typeof api[method] !== 'function') throw new Error('当前桌面组件不支持登录导入，请完整更新应用并重新启动。');
      const report = await api[method](fromFile ? {provider_id: providerId} : {profile_id: profileId, provider_id: providerId});
      if (fromFile && report?.canceled === true) {toast('已取消选择登录文件'); return;}
      if (report?.ok === false) throw new Error(report.error?.message || '导入未完成，请重试或使用扩展登录文件。');
      if (!report || report.provider_id !== providerId || !['imported', 'skipped', 'storage_imported'].every((key) => Number.isSafeInteger(report[key]) && report[key] >= 0)) {
        throw new Error('导入结果格式异常，无法确认导入数量；请检查模型网页后重试。');
      }
      $('browser-login-summary').textContent = `已导入 ${report.imported} 项 Cookie；请在网页确认登录`;
      $('browser-login-counts').textContent = `目标：${providerName(providerId)} · localStorage：${report.storage_imported} 项 · 跳过：${report.skipped} 项`;
      renderLoginWarnings('browser-login-warnings', report.warnings);
      $('browser-login-result').hidden = false;
    } catch (error) {
      setError('browser-login-error', `导入未完成：${errorMessage(error)}\n数据库或密钥环不可访问时，可使用配套扩展导出登录文件；也可在模型网页直接登录。`);
    } finally {
      await pollStatus(); state.browserImporting = false; updateControls(); scheduleBounds();
    }
  }

  function inputField(label, value, className, placeholder = '') {
    const wrapper = text('label', undefined, 'field'); wrapper.append(text('span', label));
    const input = document.createElement('input'); input.type = 'text'; input.className = className; input.value = value || ''; input.placeholder = placeholder; input.autocomplete = 'off'; input.spellcheck = false; wrapper.append(input); return wrapper;
  }
  function numberField(label, value, className, min, max, help) {
    const wrapper = text('label', undefined, 'field'); wrapper.append(text('span', label));
    const input = document.createElement('input'); input.type = 'number'; input.className = className;
    input.value = String(value ?? 0); input.min = String(min); input.max = String(max); input.step = '0.1';
    wrapper.append(input); if (help) wrapper.append(text('small', help)); return wrapper;
  }
  function renderSettings() {
    const config = state.config; if (!config) return;
    $('provider-settings').replaceChildren();
    config.providers.forEach((provider) => {
      const card = text('div', undefined, 'provider-card'); card.dataset.provider = provider.id;
      const heading = text('div', undefined, 'provider-card-header'); heading.append(text('span', provider.name.slice(0, 1).toUpperCase(), 'provider-initial'), text('strong', provider.name), text('code', provider.id));
      const toggle = text('label', undefined, 'toggle-field'); toggle.append(text('span', '参与回答'));
      const enabled = document.createElement('input'); enabled.type = 'checkbox'; enabled.className = 'provider-enabled'; enabled.checked = provider.enabled; enabled.setAttribute('aria-label', `启用 ${provider.name}`); toggle.append(enabled); heading.append(toggle); card.append(heading);
      const fields = text('div', undefined, 'field-row'); fields.append(inputField('网页地址', provider.url, 'provider-url', 'https://…'), inputField('独立代理', provider.proxy, 'provider-proxy', '留空使用默认代理')); card.append(fields);
      const speed = text('div', undefined, 'field-row'); speed.append(numberField('最小访问间隔（秒）', provider.access_interval_seconds ?? 0, 'provider-access-interval', 0, 3600, '0 表示不限速；访问过快时等待到间隔满足后再操作网页。')); card.append(speed);
      const details = text('details', undefined, 'selector-details'); details.append(text('summary', '高级：网页 CSS 选择器（JSON）'));
      const label = text('label', undefined, 'field'); label.append(text('span', '保留默认规则；网页结构变化时可在这里调整'));
      const selectors = document.createElement('textarea'); selectors.className = 'provider-selectors'; selectors.value = JSON.stringify(provider.selectors || {}, null, 2); selectors.spellcheck = false; selectors.setAttribute('aria-label', `${provider.name} CSS 选择器 JSON`);
      label.append(selectors, text('small', '字段：input、send、user、assistant、stop、new_chat，值为 CSS 选择器字符串数组。user 用于区分网页中的用户消息，可选；启用模型必须配置 input 与 assistant；send 未匹配时补充模型控件识别，Qwen 必须识别发送按钮，其他模型可在表单无歧义时使用 Enter；stop 未匹配时依赖稳定时间判断完成。')); details.append(label); card.append(details); $('provider-settings').append(card);
      enabled.addEventListener('change', updateFusionProviderChoices);
    });
    $('fusion-mode').value = config.fusion.mode; updateFusionProviderChoices(config.fusion.provider);
    $('fusion-base-url').value = config.fusion.base_url || ''; $('fusion-api-key').value = config.fusion.api_key || '';
    $('fusion-model').value = config.fusion.model || ''; $('fusion-timeout').value = config.fusion.timeout_seconds;
    $('chat-timeout').value = config.chat?.timeout_seconds ?? 180;
    $('generation-timeout').value = config.generation.timeout_seconds; $('generation-stable').value = config.generation.stable_seconds;
    $('generation-submission-timeout').value = config.generation.submission_timeout_seconds ?? 120;
    $('input-chunk-chars').value = config.generation.input_chunk_chars ?? 4096;
    $('input-chunk-delay').value = config.generation.input_chunk_delay_ms ?? 35;
    $('submit-settle').value = config.generation.submit_settle_seconds ?? 2;
    $('qwen-retry-stages').checked = config.generation.qwen_retry_stages !== false;
    $('qwen-retry-screenshot').checked = config.generation.qwen_retry_screenshot !== false;
    $('qwen-retry-learning').checked = config.generation.qwen_retry_learning !== false;
    $('qwen-retry-trigger-wait').value = config.generation.qwen_retry_trigger_wait_seconds ?? 3;
    $('qwen-manual-retry-wait').value = config.generation.qwen_manual_retry_wait_seconds ?? 20;
    $('generation-recovery-timeout').value = config.generation.recovery_timeout_seconds ?? 180;
    $('generation-min-wait').value = config.generation.min_wait_seconds; $('allow-partial').checked = config.allow_partial;
    updateFusionFields(); state.dirty = false; $('save-settings').classList.remove('dirty-dot'); setError('settings-error', '');
  }
  function updateFusionProviderChoices(preferred) {
    const selected = typeof preferred === 'string' ? preferred : $('fusion-provider').value || state.config?.fusion.provider;
    $('fusion-provider').replaceChildren();
    document.querySelectorAll('.provider-card').forEach((card) => {
      if (card.querySelector('.provider-enabled').checked) $('fusion-provider').add(new Option(providerName(card.dataset.provider), card.dataset.provider));
    });
    if (Array.from($('fusion-provider').options).some((option) => option.value === selected)) $('fusion-provider').value = selected;
  }
  function updateFusionFields() {$('web-fusion-fields').hidden = $('fusion-mode').value !== 'web'; $('api-fusion-fields').hidden = $('fusion-mode').value !== 'api';}
  function setSettingsSection(section) {
    if (state.saving || isImporting()) return;
    state.settingsSection = section;
    document.querySelectorAll('[data-settings-section]').forEach((el) => {el.hidden = el.dataset.settingsSection !== section;});
    document.querySelectorAll('.settings-tab').forEach((el) => {el.classList.toggle('active', el.dataset.section === section); el.setAttribute('aria-current', el.dataset.section === section ? 'page' : 'false');});
    document.querySelector('.settings-save-actions').hidden = ['api', 'browser-login', 'providers'].includes(section);
    $('settings-save-note').textContent = section === 'api' ? 'API 凭据仅在本机设置页显示。' : section === 'browser-login' ? '手动单向导入，只操作所选模型；不会自动持续同步。' : section === 'providers' ? 'Provider 配置单独保存，不受模型网页设置保存影响。' : '修改后保存生效。网页仍使用各自独立的登录会话。';
    document.querySelector('.settings-scroll').scrollTop = 0;
    if (section === 'api') loadRuntimeInfo();
    if (section === 'browser-login') {renderBrowserProviderChoices(); detectBrowserProfiles();}
    if (section === 'providers') void ensureSettingsProviders();
    updateControls();
  }
  async function openSettings(section = 'models') {
    if (isLocked() || !state.config) return;
    await switchAppTab('fusion');
    state.settings = true;
    try {await publishLayout({hidden: true});} catch (error) {state.settings = false; toast(`无法打开设置：${errorMessage(error)}`); scheduleBounds(); return;}
    $('workspace').hidden = true; $('settings-view').hidden = false;
    if (!state.dirty) renderSettings();
    setSettingsSection(section);
  }
  function closeSettings() {
    if (state.saving || isImporting()) return;
    // Preserve an unfinished settings draft when the user returns to the conversation.
    state.settings = false; $('settings-view').hidden = true; $('workspace').hidden = false; scheduleBounds(); updateControls();
  }
  function numberValue(id, label, min, max) {
    const raw = $(id).value; const value = Number(raw);
    if (!raw.trim() || !Number.isFinite(value) || value < min) throw new Error(`${label}必须是不小于 ${min} 的有效数字。`);
    if (max !== undefined && value > max) throw new Error(`${label}不能超过 ${max} 秒。`);
    return value;
  }
  function collectConfig() {
    const config = clone(state.config);
    config.providers = config.providers.map((provider) => {
      const card = Array.from(document.querySelectorAll('.provider-card')).find((el) => el.dataset.provider === provider.id);
      let selectors;
      try {selectors = JSON.parse(card.querySelector('.provider-selectors').value || '{}');} catch {throw new Error(`${provider.name} 的选择器不是有效 JSON。`);}
      if (!selectors || Array.isArray(selectors) || typeof selectors !== 'object') throw new Error(`${provider.name} 的选择器必须是 JSON 对象。`);
      for (const [key, values] of Object.entries(selectors)) {
        if (!['input', 'send', 'user', 'assistant', 'stop', 'new_chat'].includes(key) || !Array.isArray(values) || values.some((value) => typeof value !== 'string')) throw new Error(`${provider.name} 的选择器字段必须为 input、send、user、assistant、stop、new_chat，值为字符串数组。`);
        if (values.length > 30 || values.some((value) => !value.trim() || value.length > 1000)) throw new Error(`${provider.name} 的每组选择器最多 30 个，每个为 1–1000 字符的非空字符串。`);
      }
      if (card.querySelector('.provider-enabled').checked && (!selectors.input?.length || !selectors.assistant?.length)) throw new Error(`${provider.name} 需要至少一个 input 和 assistant 选择器。`);
      const url = card.querySelector('.provider-url').value.trim();
      try {const parsed = new URL(url); if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname))) throw new Error();} catch {throw new Error(`${provider.name} 的网页地址必须是 HTTPS URL（本地测试地址可使用 HTTP）。`);}
      const intervalRaw = card.querySelector('.provider-access-interval').value;
      const access_interval_seconds = Number(intervalRaw);
      if (!intervalRaw.trim() || !Number.isFinite(access_interval_seconds) || access_interval_seconds < 0 || access_interval_seconds > 3600) throw new Error(`${provider.name} 的最小访问间隔必须是 0–3600 秒。`);
      return {...provider, enabled: card.querySelector('.provider-enabled').checked, url, proxy: card.querySelector('.provider-proxy').value.trim(), access_interval_seconds, selectors};
    });
    const count = config.providers.filter((p) => p.enabled).length;
    if (count < 1 || count > 16) throw new Error('请启用 1–16 个模型网页。');
    config.fusion = {...config.fusion, mode: $('fusion-mode').value, provider: $('fusion-provider').value || config.fusion.provider,
      base_url: $('fusion-base-url').value.trim(), api_key: $('fusion-api-key').value, model: $('fusion-model').value.trim(),
      timeout_seconds: numberValue('fusion-timeout', '整合超时', 15, 1200)};
    if (config.fusion.mode === 'api' && (!config.fusion.base_url || !config.fusion.model)) throw new Error('使用 API 整合时，请填写 API Base URL 和模型名称。');
    config.chat = {...config.chat, timeout_seconds: numberValue('chat-timeout', '多模型候选回答总等待', 15, 1200)};
    config.generation = {...config.generation,
      qwen_retry_stages: $('qwen-retry-stages').checked,
      qwen_retry_screenshot: $('qwen-retry-screenshot').checked,
      qwen_retry_learning: $('qwen-retry-learning').checked,
      qwen_retry_trigger_wait_seconds: numberValue('qwen-retry-trigger-wait', 'Qwen 重试确认等待', 0.5, 15),
      qwen_manual_retry_wait_seconds: numberValue('qwen-manual-retry-wait', 'Qwen 人工重试等待', 1, 120),
      input_chunk_chars: numberValue('input-chunk-chars', '长输入分段字符数', 256, 16384),
      input_chunk_delay_ms: numberValue('input-chunk-delay', '分段输入间隔', 0, 1000),
      submit_settle_seconds: numberValue('submit-settle', '发送后页面保持时间', 0, 10), recovery_timeout_seconds: numberValue('generation-recovery-timeout', '网页恢复等待时间', 0, 600), timeout_seconds: numberValue('generation-timeout', '生成超时', 15, 1200), submission_timeout_seconds: numberValue('generation-submission-timeout', '接收确认等待时间', 15, 600), stable_seconds: numberValue('generation-stable', '内容稳定时间', 2, 60), min_wait_seconds: numberValue('generation-min-wait', '最短等待时间', 2, 120)};
    const minimumDuration = config.generation.stable_seconds + config.generation.min_wait_seconds;
    if (minimumDuration >= config.generation.timeout_seconds) throw new Error('生成超时必须大于内容稳定时间与最短等待时间之和。');
    if (config.fusion.mode === 'web' && minimumDuration >= config.fusion.timeout_seconds) throw new Error('网页整合超时必须大于内容稳定时间与最短等待时间之和。');
    config.allow_partial = $('allow-partial').checked;
    return config;
  }
  async function saveSettings() {
    if (isLocked()) return;
    setError('settings-error', '');
    let config; try {config = collectConfig();} catch (error) {setError('settings-error', errorMessage(error)); return;}
    state.saving = true; $('settings-form').inert = true; $('save-settings').disabled = true; $('save-settings').textContent = '正在保存…'; $('close-settings').disabled = true; $('discard-settings').disabled = true;
    try {
      state.config = await api.request('PUT', '/internal/config', config); state.dirty = false;
      renderApiModelChoices();
      if (!enabledProviders().some((provider) => provider.id === state.activeProvider)) state.activeProvider = enabledProviders()[0].id;
      reconcileLayout(); renderProviderTabs(); renderLayout(); saveLayoutPreference(); updateProviderStatus(); toast('设置已保存');
      if (!api.setLayout) await api.showProvider(state.activeProvider);
      state.saving = false; closeSettings(); await pollStatus();
    } catch (error) {setError('settings-error', `保存失败：${errorMessage(error)}`);}
    finally {state.saving = false; $('settings-form').inert = false; $('save-settings').disabled = false; $('save-settings').textContent = '保存设置'; $('save-settings').classList.toggle('dirty-dot', state.dirty); $('close-settings').disabled = false; $('discard-settings').disabled = false; updateControls();}
  }
  function shellQuote(value) {return `'${String(value).replace(/'/g, `'"'"'`)}'`;}
  function renderApiModelChoices() {
    const select = $('local-api-model');
    const previous = select.value;
    select.replaceChildren(new Option('多模型整合 · web-fusion', 'web-fusion'));
    enabledProviders().forEach((provider) => select.add(new Option(`${provider.name} · web-${provider.id}`, `web-${provider.id}`)));
    select.value = Array.from(select.options).some((option) => option.value === previous) ? previous : 'web-fusion';
    $('curl-example').textContent = curlExample(false);
  }
  function curlExample(withToken = false) {
    const url = (state.runtime?.baseUrl || 'http://127.0.0.1:8765').replace(/\/$/, '').replace(/\/v1$/, '');
    const selected = $('local-api-model').value;
    const model = enabledProviders().some((provider) => `web-${provider.id}` === selected) ? selected : 'web-fusion';
    const body = JSON.stringify({model, messages: [{role: 'user', content: '请分析 Android 内存泄漏的排查思路'}], stream: false});
    return `curl ${shellQuote(url + '/v1/chat/completions')} \\\n  -H ${shellQuote('Authorization: Bearer ' + (withToken ? state.runtime?.token || 'YOUR_API_KEY' : 'YOUR_API_KEY'))} \\\n  -H 'Content-Type: application/json' \\\n  -d ${shellQuote(body)}`;
  }
  async function loadRuntimeInfo() {
    renderApiModelChoices();
    try {
      state.runtime = await api.runtimeInfo();
      $('local-api-url').value = state.runtime.baseUrl.replace(/\/$/, '').replace(/\/v1$/, '') + '/v1';
      $('local-api-token').value = state.runtime.token; $('local-api-token').type = 'password'; $('reveal-api-token').textContent = '显示';
      $('local-api-directory').textContent = `数据与 Markdown 文件目录：${state.runtime.dataDir}`;
      $('curl-example').textContent = curlExample(false);
    } catch (error) {setError('settings-error', `无法读取 API 信息：${errorMessage(error)}`);}
  }

  $('prompt-form').addEventListener('submit', send);
  $('prompt').addEventListener('input', updateControls);
  $('prompt').addEventListener('keydown', (event) => {if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) {event.preventDefault(); $('prompt-form').requestSubmit();}});
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n' && !event.isComposing) {
      event.preventDefault();
      newConversation();
    }
  });
  document.querySelectorAll('.starter').forEach((button) => button.addEventListener('click', () => {if (isLocked()) return; $('prompt').value = button.dataset.prompt; $('prompt').focus(); updateControls();}));
  $('new-chat').addEventListener('click', newConversation);
  $('history-select').addEventListener('change', (event) => openConversation(event.target.value));
  $('brand-home').addEventListener('click', (event) => {event.preventDefault(); if (state.settings) closeSettings(); void switchAppTab('fusion');});
  document.querySelectorAll('[data-app-tab]').forEach((tab) => tab.addEventListener('click', () => { void switchAppTab(tab.dataset.appTab); }));
  $('app-tab-add').addEventListener('click', (event) => {
    event.stopPropagation();
    const menu = $('app-tab-menu'), button = $('app-tab-add');
    menu.hidden = !menu.hidden; button.setAttribute('aria-expanded', String(!menu.hidden));
  });
  document.querySelectorAll('[data-create-tab]').forEach(button => button.addEventListener('click', () => { void createAppTab(button.dataset.createTab); }));
  document.addEventListener('click', event => { if (!event.target.closest?.('.app-tab-add-wrap')) closeAppTabMenu(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') closeAppTabMenu(); });
  document.querySelectorAll('[data-workbench-tab]').forEach((tab) => tab.addEventListener('click', () => {
    state.workbench.tab = tab.dataset.workbenchTab || 'chat';
    if (tab.classList.contains('workbench-new-chat')) state.workbench.messages = [];
    if (state.workbench.tab === 'web') state.workbench.webVisible = true;
    renderWorkbenchTabs();
    if (state.workbench.tab === 'chat') { renderWorkbenchProviderList(); renderWorkbenchProviderForm(); renderWorkbenchMessages(); }
  }));
  $('workbench-close-inplace')?.addEventListener('click', () => { void closeWorkbenchInPlace(); });
  $('agent-close-inplace').addEventListener('click', () => { void closeDesktopAgentInPlace(); });
  $('workbench-add-provider').addEventListener('click', () => {
    const draft = {id: `model-${Date.now().toString(36)}`, name: '新大模型', apiType: 'openai', baseUrl: 'http://127.0.0.1:11434/v1', apiKey: '', model: '', models: [], modelContexts: {}};
    state.workbench.providers.push(draft); state.workbench.activeProviderId = draft.id;
    state.workbench.tab = 'providers'; renderWorkbenchProviderList(); renderWorkbenchProviderForm(); renderWorkbenchTabs(); $('workbench-provider-name').focus();
  });
  $('workbench-save-provider').addEventListener('click', () => { void saveWorkbenchProvider(); });
  $('workbench-refresh-models').addEventListener('click', () => { void refreshWorkbenchModels(); });
  $('workbench-test-provider').addEventListener('click', () => { void testWorkbenchProvider(); });
  $('workbench-provider-model').addEventListener('change', () => {
    const provider = workbenchProvider(), model = $('workbench-provider-model').value;
    const needsContext = !!provider && !provider.modelContexts?.[model];
    if (provider) { provider.model = model; void persistWorkbenchProviders().catch(() => {}); }
    renderWorkbenchProviderList(); renderWorkbenchProviderForm();
    if (needsContext) void refreshWorkbenchModels();
  });
  $('workbench-provider-type').addEventListener('change', () => { $('workbench-provider-test-status').textContent = '等待检测'; });
  $('settings-provider-select').addEventListener('change', event => {
    state.workbench.activeProviderId = event.target.value || null;
    renderSettingsProviderForm(); renderWorkbenchProviderList(); renderWorkbenchProviderForm();
  });
  $('settings-provider-add').addEventListener('click', () => { void addSettingsProvider(); });
  $('settings-provider-fetch').addEventListener('click', () => { void fetchSettingsProviderModels(); });
  $('settings-provider-test').addEventListener('click', () => { void testSettingsProvider(); });
  $('settings-provider-save').addEventListener('click', () => { void saveSettingsProvider(); });
  $('settings-provider-model').addEventListener('change', event => {
    const provider = workbenchProvider();
    if (provider) { provider.model = event.target.value; renderSettingsProviderForm(); }
  });
  $('workbench-chat-provider').addEventListener('change', () => {
    const selected = workbenchProviderFromOption($('workbench-chat-provider').value);
    if (selected.provider) { state.workbench.activeProviderId = selected.provider.id; selected.provider.model = selected.model; }
    renderWorkbenchProviderList(); renderWorkbenchProviderForm(); renderWorkbenchMessages();
  });
  $('workbench-delete-provider').addEventListener('click', async () => {
    if (!workbenchProvider()) return;
    state.workbench.providers = state.workbench.providers.filter(provider => provider.id !== state.workbench.activeProviderId);
    state.workbench.activeProviderId = state.workbench.providers[0]?.id || null;
    try { await persistWorkbenchProviders(); renderWorkbenchProviderList(); renderWorkbenchProviderForm(); toast('大模型配置已删除'); } catch (error) { toast(`删除配置失败：${errorMessage(error)}`); }
  });
  $('workbench-chat-form').addEventListener('submit', sendWorkbenchChat);
  $('workbench-chat-input').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('workbench-chat-form').requestSubmit(); } });
  $('workbench-launch-claude')?.addEventListener('click', () => { void launchWorkbenchTool('claude'); });
  $('workbench-launch-hermes')?.addEventListener('click', () => { void launchWorkbenchTool('hermes'); });
  $('workbench-launch-codex')?.addEventListener('click', () => { void launchWorkbenchTool('codex'); });
  $('workbench-web-form').addEventListener('submit', event => { event.preventDefault(); void showWorkbenchWeb($('workbench-web-url').value); });
  $('workbench-web-back').addEventListener('click', () => { void controlWorkbenchWeb('back'); });
  $('workbench-web-forward').addEventListener('click', () => { void controlWorkbenchWeb('forward'); });
  $('workbench-web-reload').addEventListener('click', () => { void controlWorkbenchWeb('reload'); });
  $('workbench-web-external')?.addEventListener('click', () => { void openWorkbenchWebExternal($('workbench-web-url').value); });
  $('workbench-web-favorite')?.addEventListener('click', toggleWorkbenchWebFavorite);
  $('workbench-web-copy').addEventListener('click', () => copyText($('workbench-web-url').value));
  document.querySelectorAll('[data-workbench-url]').forEach(button => button.addEventListener('click', () => { $('workbench-web-url').value = button.dataset.workbenchUrl || ''; void showWorkbenchWeb(button.dataset.workbenchUrl); }));
  $('workbench-web-panel').addEventListener('scroll', () => { if (state.workbench.webVisible) void syncWorkbenchWeb(); });
  $('sidebar-new-chat').addEventListener('click', newConversation);
  $('sidebar-settings').addEventListener('click', () => { void openSettings('models'); });
  $('sidebar-history-refresh').addEventListener('click', () => { if (!isLocked() && api) loadHistory().catch((error) => toast(`历史刷新失败：${errorMessage(error)}`)); });
  $('sidebar-toggle').addEventListener('click', () => {
    const collapsed = $('workspace').classList.toggle('sidebar-collapsed');
    $('sidebar-toggle').textContent = collapsed ? '›' : '‹';
    $('sidebar-toggle').setAttribute('aria-label', collapsed ? '展开侧栏' : '收起侧栏');
    $('sidebar-toggle').title = collapsed ? '展开侧栏' : '收起侧栏';
    scheduleBounds();
  });
  $('agent-open-terminal').addEventListener('click', () => { void launchDesktopAgent('chat'); });
  $('agent-task-form').addEventListener('submit', (event) => {event.preventDefault(); void launchDesktopAgent('run');});
  $('agent-clear-task').addEventListener('click', () => { $('agent-task').value = ''; $('agent-workspace').value = ''; $('agent-task').focus(); });
  $('agent-open-readme').addEventListener('click', async () => {
    if (!api?.launchDesktopAgent) { toast('请通过 Electron 应用启动以查看 Desktop Agent 说明。'); return; }
    try {
      const result = await api.launchDesktopAgent({mode: 'help'});
      if (!result?.ok) throw new Error(result?.message || '无法打开说明');
      updateAgentStatus('ready', '使用说明已打开'); toast('Desktop Agent 使用说明已在新终端打开');
    } catch (error) { updateAgentStatus('error', errorMessage(error)); toast(`无法打开使用说明：${errorMessage(error)}`); }
  });
  $('open-settings').addEventListener('click', () => openSettings('models'));
  $('open-api').addEventListener('click', () => openSettings('api'));
  $('project-run').addEventListener('click', () => { void openProjectRunner(); });
  $('close-project-run').addEventListener('click', closeProjectRunner);
  $('project-generate-prompt').addEventListener('click', () => { void generateProjectPrompt(); });
  $('project-run-last').addEventListener('click', () => { void runLatestProject(); });
  $('project-run-provider').addEventListener('change', event => { state.workbench.activeProviderId = event.target.value || null; });
  $('project-run-dialog').addEventListener('click', event => { if (event.target === $('project-run-dialog')) closeProjectRunner(); });
  $('project-run-dialog').addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); closeProjectRunner(); } });
  $('close-settings').addEventListener('click', closeSettings);
  $('discard-settings').addEventListener('click', () => {if (isLocked()) return; renderSettings(); closeSettings();});
  $('save-settings').addEventListener('click', saveSettings);
  $('settings-form').addEventListener('submit', (event) => {event.preventDefault(); saveSettings();});
  $('settings-form').addEventListener('input', (event) => {if (event.target.closest('#browser-login-section') || event.target.id === 'local-api-model' || isLocked()) return; state.dirty = true; $('save-settings').classList.add('dirty-dot');});
  $('detect-browser-profiles').addEventListener('click', detectBrowserProfiles);
  $('browser-profile-select').addEventListener('change', updateBrowserProfileDetails);
  $('browser-login-provider').addEventListener('change', updateBrowserLoginControls);
  $('import-browser-login').addEventListener('click', () => importBrowserLogin(false));
  $('import-login-file').addEventListener('click', () => importBrowserLogin(true));
  $('fusion-mode').addEventListener('change', updateFusionFields);
  document.querySelectorAll('.settings-tab').forEach((button) => button.addEventListener('click', () => setSettingsSection(button.dataset.section)));
  $('dismiss-login-tip').addEventListener('click', () => {$('login-tip').hidden = true; scheduleBounds();});
  $('reload-provider').addEventListener('click', async () => {const providerId = inspectedProvider(); if (isLocked() || !providerId) return; try {await api.reloadProvider(providerId); toast('正在重新加载网页');} catch (error) {toast(errorMessage(error));}});
  $('copy-api-url').addEventListener('click', () => copyText($('local-api-url').value));
  $('copy-api-token').addEventListener('click', () => {if (state.runtime?.token) copyText(state.runtime.token);});
  $('local-api-model').addEventListener('change', () => {$('curl-example').textContent = curlExample(false);});
  $('copy-curl').addEventListener('click', () => {if (state.runtime?.token) copyText(curlExample(true));});
  $('reveal-api-token').addEventListener('click', () => {const visible = $('local-api-token').type === 'password'; $('local-api-token').type = visible ? 'text' : 'password'; $('reveal-api-token').textContent = visible ? '隐藏' : '显示';});
  document.addEventListener('click', (event) => {
    const anchor = event.target.closest?.('.markdown a');
    if (!anchor) return;
    event.preventDefault();
    const href = anchor.getAttribute('href');
    if (href && /^https?:\/\//i.test(href)) api.copyText(href).then(() => toast('链接已复制，可在系统浏览器打开')).catch((error) => toast(errorMessage(error)));
  });
  $('layout-mode').addEventListener('change', () => changeLayout($('layout-mode').value));
  [0, 1].forEach((index) => {
    $(`pane-provider-${index}`).addEventListener('change', () => changeLayout(state.layout.mode, index, $(`pane-provider-${index}`).value));
    $(`pane-provider-${index}`).addEventListener('focus', () => {if (!isLocked()) {state.focusedPane = index; renderLayout(); updateProviderStatus();}});
  });
  $('show-model-windows').addEventListener('click', () => {
    if (!canReopenWindows()) return;
    if (boundsFrame !== null) {cancelAnimationFrame(boundsFrame); boundsFrame = null;}
    publishLayout({reopen_windows: true}).catch((error) => toast(errorMessage(error)));
  });
  $('diagnose-send').addEventListener('click', diagnoseSend);
  $('close-send-diagnostic').addEventListener('click', closeDiagnostic);
  $('copy-send-diagnostic').addEventListener('click', () => copyText($('send-diagnostic-json').textContent));
  $('send-diagnostic-dialog').addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {event.preventDefault(); closeDiagnostic();}
    if (event.key === 'Tab') {
      const first = $('close-send-diagnostic'), last = $('copy-send-diagnostic');
      if (event.shiftKey && document.activeElement === first) {event.preventDefault(); last.focus();}
      else if (!event.shiftKey && document.activeElement === last) {event.preventDefault(); first.focus();}
    }
  });
  setupSplitter('workspace-splitter', 'workspace'); setupSplitter('panes-splitter', 'panes');
  document.addEventListener('pointermove', (event) => {
    if (!state.dragging || event.pointerId !== state.dragging.pointerId) return;
    const kind = state.dragging.kind;
    const rect = $(kind === 'workspace' ? 'workspace' : 'webview-group').getBoundingClientRect();
    const padding = kind === 'workspace' ? 20 : 0;
    const sidebarWidth = kind === 'workspace' ? ($('fusion-sidebar')?.offsetWidth || 0) : 0;
    resizeShare(kind, (event.clientX - rect.left - padding - sidebarWidth - 6) / Math.max(1, rect.width - padding * 2 - sidebarWidth - 12) * 100);
  });
  document.addEventListener('pointerup', finishResize); document.addEventListener('pointercancel', finishResize);
  window.addEventListener('blur', () => finishResize());
  window.addEventListener('resize', () => {resizeShare('workspace', state.layout.chatShare); resizeShare('panes', state.layout.paneShare); scheduleBounds(); void syncWorkbenchWeb();});
  document.addEventListener('visibilitychange', scheduleBounds);
  for (const id of ['webview-placeholder', 'webview-placeholder-1']) new ResizeObserver(scheduleBounds).observe($(id));

  async function initialize() {
    renderWorkbenchWebFavorites(); updateWorkbenchWebFavoriteButton(); updateAppTabs(); updateAgentStatus('idle');
    if (!api) {setError('chat-error', '请通过项目的 run.sh 或 Electron 启动应用；普通浏览器无法连接桌面模型工作区。'); $('connection-status').lastElementChild.textContent = '需要桌面应用'; return;}
    api.onStatus((event) => {
      if (event.type === 'browser-maintenance') {state.browserMaintenance = event.active === true; scheduleBounds();}
      if (event.type === 'provider') {providerStates[event.provider_id] = {state: event.state, message: event.message}; renderProviderTabs(); renderLayout(); updateProviderStatus();}
      if (event.type === 'input-visibility') {state.inputLeaseActive = event.active === true; $('input-visibility-note').hidden = !event.active; $('input-visibility-note').textContent = event.active ? `正在向 ${providerName(event.provider_id)} 发送，确认后恢复布局` : '';}
      if (event.type === 'recovery-provider-opened') {applyRecoveryLayout(event.layout); if (!state.recoveryOpening) scheduleBounds();}
      if (event.type === 'layout-window-closed') toast(`${providerName(event.provider_id)} 窗口已隐藏；可点击“重新显示窗口”恢复。`);
      if (event.type === 'workbench-web-navigate' && state.workbench.tab === 'web') { state.workbench.webUrl = event.url; $('workbench-web-url').value = event.url; updateWorkbenchBrowserStatus('ready', event); }
      if (event.type === 'workbench-web-state' && state.workbench.tab === 'web' && isWorkbenchTab(state.appTab)) { updateWorkbenchBrowserStatus(event.state, event); if (event.state === 'error') toast(event.message || '网页加载失败'); }
      if (event.type === 'workbench-terminal-output' || event.type === 'workbench-terminal-state') updateWorkbenchTerminal(event);
      if (event.type === 'bridge') {if (!state.status) state.status = {}; state.status.bridge_connected = event.state === 'connected' || event.state === 'ready'; updateAgentStatus(state.status.bridge_connected ? 'ready' : 'idle');}
      updateControls();
    });
    try {
      state.config = await api.request('GET', '/internal/config');
      reconcileLayout(); state.focusedPane = Math.max(0, state.layout.providers.indexOf(state.activeProvider)); renderProviderTabs(); renderLayout(); updateProviderStatus();
      if (state.activeProvider) {if (!api.setLayout) await api.showProvider(state.activeProvider); await publishLayout(); saveLayoutPreference();}
      const results = await Promise.allSettled([loadHistory(), pollStatus()]);
      if (results[0].status === 'rejected') toast(`无法加载历史对话：${errorMessage(results[0].reason)}`);
      scheduleBounds(); updateControls();
    } catch (error) {setError('chat-error', `初始化失败：${errorMessage(error)}\n请检查启动终端中的服务日志，然后重新打开应用。`);}
    statusTimer = setInterval(pollStatus, 2000);
    progressTimer = setInterval(() => {if (state.busy) void pollRunProgress();}, 500);
    setInterval(() => {if (state.busy) updateControls();}, 1000);
  }
  window.addEventListener('beforeunload', () => {if (statusTimer) clearInterval(statusTimer); if (progressTimer) clearInterval(progressTimer);});
  initialize();
})();
