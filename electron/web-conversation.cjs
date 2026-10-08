'use strict';

function extractInPage(site) {
  const visible = el => {
    const style = getComputedStyle(el), rect = el.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0 && el.getAttribute('aria-hidden') !== 'true';
  };
  const root = document.querySelector('main,[role="main"]') || document.body;
  const rules = [
    ['[data-message-author-role="user"],[data-role="user"]', 'user'],
    ['[data-message-author-role="assistant"],[data-role="assistant"]', 'assistant'],
  ];
  if (site === 'claude') rules.push(['[data-testid="user-message"]', 'user'], ['[data-testid="assistant-message"],[data-is-streaming]', 'assistant']);
  if (site === 'gemini') rules.push(['user-query', 'user'], ['model-response', 'assistant']);
  const entries = new Map();
  for (const [selector, role] of rules) {
    for (const node of root.querySelectorAll(selector)) {
      if (!visible(node)) continue;
      const text = (node.innerText || node.textContent || '').trim();
      if (text) entries.set(node, { role, text });
    }
  }
  const nodes = [...entries.keys()].filter(node => ![...entries.keys()].some(parent => parent !== node && parent.contains(node)));
  nodes.sort((a, b) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
  const busy = [...root.querySelectorAll('button')].filter(visible).some(button =>
    button.dataset.testid === 'stop-button' || /^(stop generating|stop response|停止生成|停止回答)$/i.test((button.getAttribute('aria-label') || button.textContent || '').trim()));
  const hash = text => { let h = 2166136261; for (const c of text) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return (h >>> 0).toString(16); };
  let stableIds = true;
  const messages = nodes.map((node, index) => {
    const { role, text } = entries.get(node);
    const stable = node.getAttribute('data-message-id') || node.id || node.closest('[data-message-id]')?.getAttribute('data-message-id');
    if (!stable) stableIds = false;
    return { id: stable || `visible-${index}-${hash(role + text)}`, role, content: text,
      complete: !(role === 'assistant' && (node.getAttribute('data-is-streaming') === 'true' || busy && index === nodes.length - 1)),
      position: { kind: 'message', message_id: stable || `visible-${index}-${hash(role + text)}` } };
  });
  const turns = [...root.querySelectorAll('article[data-testid^="conversation-turn-"]')];
  const indices = turns.map(turn => Number(turn.dataset.testid.match(/(\d+)$/)?.[1])).filter(Number.isFinite);
  const completeRange = indices.length > 0 && indices[0] === 0 && indices.every((n, i) => n === i);
  const modelNode = document.querySelector('[data-testid="model-switcher-dropdown-button"],[data-testid="model-selector"]');
  return { messages, model: modelNode?.textContent?.trim() || null,
    context_complete: completeRange && stableIds && messages.length > 0 && messages.every(m => m.complete),
    coverage: { scope: 'visible', count: messages.length, from_start: completeRange, stable_ids: stableIds },
    skipped: messages.length ? [] : [{ reason: '没有识别到明确角色的可见消息' }],
    conversation_id: location.pathname.match(/\/(?:c|chat|conversation)\/([^/]+)/)?.[1] || null };
}

async function extractVisibleConversation(view, options = {}) {
  const webContents = view?.webContents || view;
  if (!webContents || webContents.isDestroyed()) return { ok: false, messages: [], context_complete: false, error: '网页已关闭' };
  const { detectSite } = require('./web-chat.cjs');
  const site = options.site || detectSite(webContents.getURL());
  try {
    const snapshot = await webContents.executeJavaScript(`(${extractInPage.toString()})(${JSON.stringify(site)})`, true);
    return { ok: true, site, url: webContents.getURL(), title: webContents.getTitle(), ...snapshot };
  } catch (error) { return { ok: false, site, messages: [], context_complete: false, error: String(error?.message || error) }; }
}

class WebChatRequests {
  constructor() { this.active = new Map(); this.cancelled = new Map(); }
  key(senderId, tabId, requestId) { return JSON.stringify([senderId, tabId, requestId]); }
  begin(senderId, tabId, requestId) {
    if ([...this.active.values()].some(item => item.tabId === tabId)) throw new Error('网页正在处理其他请求（busy）');
    const key = this.key(senderId, tabId, requestId), controller = new AbortController();
    const when = this.cancelled.get(key);
    if (when && Date.now() - when < 60000) controller.abort();
    this.cancelled.delete(key);
    this.active.set(key, { tabId, controller });
    for (const [id, ts] of this.cancelled) if (Date.now() - ts >= 60000) this.cancelled.delete(id);
    return controller;
  }
  cancel(senderId, tabId, requestId) {
    const key = this.key(senderId, tabId, requestId), item = this.active.get(key);
    if (item) { item.controller.abort(); return true; }
    this.cancelled.set(key, Date.now());
    return false;
  }
  finish(senderId, tabId, requestId) { this.active.delete(this.key(senderId, tabId, requestId)); }
  cancelTab(tabId) { for (const item of this.active.values()) if (item.tabId === tabId) item.controller.abort(); }
}

function stopGenerationInPage() {
  const buttons = [...document.querySelectorAll('main button,[role="main"] button')];
  const stop = buttons.find(button => button.dataset.testid === 'stop-button' || /^(stop generating|stop response|停止生成|停止回答)$/i.test((button.getAttribute('aria-label') || button.textContent || '').trim()));
  if (stop) stop.click();
  return !!stop;
}

module.exports = { extractVisibleConversation, WebChatRequests, stopGenerationInPage };
