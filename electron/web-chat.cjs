'use strict';

// Restricted browser-chat automation used by Electron BrowserViews.
// This module intentionally exposes only prompt submission and answer extraction.

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

let systemClipboard = null;
try { systemClipboard = require('electron').clipboard; } catch { /* non-Electron unit context */ }
let clipboardQueue = Promise.resolve();

function withClipboardLock(task) {
  const running = clipboardQueue.then(task, task);
  clipboardQueue = running.then(() => undefined, () => undefined);
  return running;
}

function clampTimeout(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 300000;
  return Math.max(10000, Math.min(600000, Math.round(n)));
}

function detectSite(url) {
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch { /* noop */ }
  if (host === 'chat.deepseek.com' || host.endsWith('.deepseek.com')) return 'deepseek';
  if (host === 'chat.qwen.ai' || host.endsWith('.qwen.ai') || host === 'tongyi.aliyun.com') return 'qwen';
  if (host === 'chatgpt.com' || host === 'chat.openai.com') return 'chatgpt';
  if (host === 'claude.ai' || host.endsWith('.claude.ai')) return 'claude';
  if (host === 'gemini.google.com') return 'gemini';
  if (host === 'grok.com' || host.endsWith('.grok.com')) return 'grok';
  if (host === 'poe.com' || host.endsWith('.poe.com')) return 'poe';
  return 'generic';
}

function scriptCall(fn, ...args) {
  return `(${fn.toString()})(${args.map(arg => JSON.stringify(arg)).join(',')})`;
}

function preparePromptInPage(prompt) {
  const visible = (el) => {
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.visibility !== 'hidden' && style.display !== 'none'
      && Number(style.opacity || 1) > 0 && rect.width > 80 && rect.height > 20;
  };
  const candidates = Array.from(document.querySelectorAll(
    'textarea, [contenteditable="true"], [role="textbox"]',
  )).filter(visible);
  const score = (el) => {
    const rect = el.getBoundingClientRect();
    const label = [
      el.getAttribute('placeholder'), el.getAttribute('aria-label'),
      el.getAttribute('data-placeholder'), el.getAttribute('title'),
    ].filter(Boolean).join(' ').toLowerCase();
    let value = rect.bottom / Math.max(1, innerHeight) * 30;
    value += Math.min(25, rect.width / Math.max(1, innerWidth) * 25);
    if (el.tagName === 'TEXTAREA') value += 20;
    if (el.getAttribute('contenteditable') === 'true') value += 12;
    if (/message|ask|chat|prompt|发送|提问|输入|有什么/.test(label)) value += 30;
    if (/search|搜索|查找|filter/.test(label)) value -= 100;
    if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') value -= 200;
    return value;
  };
  candidates.sort((a, b) => score(b) - score(a));
  const input = candidates[0];
  if (!input || score(input) < -20) {
    return { ok: false, error: '未找到聊天输入框，请先在该网页中登录并进入聊天页面' };
  }

  input.setAttribute('data-llm-manager-chat-input', '1');
  input.focus();
  try {
    if ('value' in input) {
      const proto = input.tagName === 'TEXTAREA'
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(input, prompt);
      else input.value = prompt;
    } else {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(input);
      selection?.removeAllRanges();
      selection?.addRange(range);
      const inserted = document.execCommand?.('insertText', false, prompt);
      if (!inserted) input.textContent = prompt;
      selection?.removeAllRanges();
    }
    let inputEvent;
    try {
      inputEvent = new InputEvent('input', {
        bubbles: true, composed: true, inputType: 'insertText', data: prompt,
      });
    } catch {
      inputEvent = new Event('input', { bubbles: true, composed: true });
    }
    input.dispatchEvent(inputEvent);
    input.dispatchEvent(new Event('change', { bubbles: true }));
  } catch (error) {
    return { ok: false, error: `填写聊天输入框失败: ${String(error?.message || error)}` };
  }
  return {
    ok: true,
    tag: input.tagName.toLowerCase(),
    placeholder: input.getAttribute('placeholder') || input.getAttribute('aria-label') || '',
  };
}

function submitPromptInPage() {
  const visible = (el) => {
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.visibility !== 'hidden' && style.display !== 'none'
      && Number(style.opacity || 1) > 0 && rect.width > 8 && rect.height > 8;
  };
  let input = document.querySelector('[data-llm-manager-chat-input="1"]');
  // 一些 React 编辑器在 input 事件后会替换节点；此时重新选择底部可见聊天框。
  if (!input) {
    const candidates = Array.from(document.querySelectorAll(
      'textarea, [contenteditable="true"], [role="textbox"]',
    )).filter(visible).sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom);
    input = candidates[0] || null;
  }
  if (!input) return { ok: false, error: '聊天输入框在发送前被页面刷新，请重试' };
  const inputRect = input.getBoundingClientRect();
  const buttons = Array.from(document.querySelectorAll('button, [role="button"]'))
    .filter(el => visible(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true');
  const scored = buttons.map((button) => {
    const rect = button.getBoundingClientRect();
    const label = [
      button.getAttribute('aria-label'), button.getAttribute('title'),
      button.getAttribute('data-testid'), button.textContent,
    ].filter(Boolean).join(' ').trim().toLowerCase();
    let value = 0;
    if (/^(send|发送|提交|send message|发送消息)$/.test(label)) value += 120;
    else if (/send|发送|提交|arrow-up|submit/.test(label)) value += 70;
    if (/stop|停止|取消|语音|voice|录音|upload|上传|附件|attach/.test(label)) value -= 150;
    const dx = Math.abs((rect.left + rect.width / 2) - inputRect.right);
    const dy = Math.abs((rect.top + rect.height / 2) - (inputRect.top + inputRect.height / 2));
    value -= Math.min(80, (dx + dy) / 20);
    if (button.closest('form') && button.closest('form') === input.closest('form')) value += 30;
    return { button, value, label };
  }).sort((a, b) => b.value - a.value);

  if (scored[0] && scored[0].value > 5) {
    scored[0].button.click();
    return { ok: true, method: 'button', label: scored[0].label };
  }
  const form = input.closest('form');
  if (form && typeof form.requestSubmit === 'function') {
    form.requestSubmit();
    return { ok: true, method: 'form' };
  }
  for (const type of ['keydown', 'keypress', 'keyup']) {
    input.dispatchEvent(new KeyboardEvent(type, {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
      bubbles: true, cancelable: true, composed: true,
    }));
  }
  return { ok: true, method: 'enter' };
}

function readChatStateInPage(site, prompt) {
  const visible = (el) => {
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.visibility !== 'hidden' && style.display !== 'none'
      && Number(style.opacity || 1) > 0 && rect.width > 20 && rect.height > 8;
  };
  const normalize = (value) => String(value || '')
    .replace(/\u200b/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
  const selectorSets = {
    deepseek: [
      '[data-message-author-role="assistant"]', '.ds-markdown',
      '[class*="ds-markdown"]', '[class*="markdown"]', '[class*="message-content"]',
    ],
    qwen: [
      '[data-message-author-role="assistant"]', '[data-role="assistant"]',
      '.markdown-body', '[class*="markdown"]', '[class*="response-content"]',
    ],
    chatgpt: [
      '[data-message-author-role="assistant"]',
      'article[data-testid^="conversation-turn-"] [class*="markdown"]',
      'article[data-testid^="conversation-turn-"]',
      '.markdown', '[class*="markdown"]',
    ],
    claude: [
      '[data-is-streaming]', '[data-testid*="assistant"]',
      '[class*="font-claude-response"]', '[class*="font-user-message"] + div',
    ],
    gemini: [
      'message-content', '.model-response-text', '[class*="model-response"]',
      '[data-test-id*="response"]',
    ],
    grok: [
      '[data-testid*="assistant"]', '[data-testid*="message"] [class*="markdown"]',
      '[class*="markdown"]',
    ],
    poe: ['[class*="Message_botMessage"]', '[class*="Markdown_markdownContainer"]'],
    generic: [],
  };
  const fallbackSelectors = [
    '[data-message-author-role="assistant"]', '[data-role="assistant"]',
    '[class*="assistant"] [class*="markdown"]', '[class*="response"] [class*="markdown"]',
    '[class*="markdown"]', 'main article',
  ];
  const selectors = [...(selectorSets[site] || []), ...fallbackSelectors];
  const seenElements = new Set();
  const candidates = [];
  const promptText = normalize(prompt);

  selectors.forEach((selector, priority) => {
    let found = [];
    try { found = Array.from(document.querySelectorAll(selector)).filter(visible); }
    catch { return; }
    found.forEach((el, order) => {
      if (seenElements.has(el)) return;
      seenElements.add(el);
      const rendered = normalize(el.innerText);
      const raw = normalize(el.textContent);
      let value = rendered;
      // ChatGPT 的 textContent 可能提前包含尚未绘制的内容；其进度必须跟随 innerText。
      // 其他站点仍允许使用已进入 DOM 的较完整文本作为兼容路径。
      if (!value || (site !== 'chatgpt' && raw.length > value.length * 1.25)) value = raw;
      if (!value || value === promptText || value.length > 120000) return;
      if (promptText && value.startsWith(promptText)) {
        const afterPrompt = normalize(value.slice(promptText.length));
        if (afterPrompt.length >= 20) value = afterPrompt;
        else return;
      }
      candidates.push({ text: value, priority, order });
    });
  });

  // 站点 DOM 改版的后备路径：从主内容区中“本次用户问题”之后截取回答。
  // 只有找到完整问题文本时才启用，避免把整个网页导航栏误当回答。
  for (const selector of ['main', '[role="main"]', 'body']) {
    let root = null;
    try { root = document.querySelector(selector); } catch { /* noop */ }
    if (!root) continue;
    const pageText = normalize(root.innerText || root.textContent);
    const promptIndex = promptText ? pageText.lastIndexOf(promptText) : -1;
    if (promptIndex < 0) continue;
    const afterPrompt = normalize(pageText.slice(promptIndex + promptText.length));
    if (afterPrompt.length >= 20 && afterPrompt.length <= 120000) {
      candidates.push({ text: afterPrompt, priority: selectors.length + 10, order: 0, fallback: true });
    }
    break;
  }

  const unique = [];
  const seenTexts = new Set();
  for (const candidate of candidates) {
    if (seenTexts.has(candidate.text)) continue;
    seenTexts.add(candidate.text);
    unique.push(candidate);
  }

  const busySignals = [];
  const busySelectors = [
    'button[data-testid="stop-button"]', '[data-testid*="stop-generat"]',
    '[data-testid*="stop-response"]', '[data-is-streaming="true"]',
    '[aria-busy="true"] [data-message-author-role="assistant"]',
    '.result-streaming', '[class*="response"][class*="streaming"]',
    'mat-progress-spinner',
  ];
  for (const selector of busySelectors) {
    try {
      if (Array.from(document.querySelectorAll(selector)).some(visible)) busySignals.push(selector);
    } catch { /* invalid selector */ }
  }
  const busyButton = Array.from(document.querySelectorAll('button, [role="button"]')).some((button) => {
    if (!visible(button)) return false;
    const label = [
      button.getAttribute('aria-label'), button.getAttribute('title'),
      button.getAttribute('data-testid'), button.getAttribute('data-state'), button.textContent,
    ].filter(Boolean).join(' ').trim().toLowerCase();
    return /stop(?: generating| response)?|停止(?:生成|回答)?|中止生成|暂停生成|cancel response/.test(label);
  });
  if (busyButton) busySignals.push('stop-button');

  const modelSelectorSets = {
    chatgpt: ['[data-testid="model-switcher-dropdown-button"]', '[data-testid*="model-switcher"]'],
    deepseek: ['button[aria-haspopup="listbox"]', '[class*="model"] button'],
    qwen: ['[class*="model-selector"]', '[data-testid*="model"]'],
    claude: ['button[data-testid*="model"]'],
    gemini: ['[data-test-id*="model"]', '[class*="model-selector"]'],
    grok: ['button[data-testid*="model"]'],
    poe: ['button[class*="BotHeader"]', '[class*="botName"]'],
    generic: ['[data-testid="model-switcher-dropdown-button"]', '[data-testid*="model-switcher"]'],
  };
  const modelPattern = /(?:gpt[-\s]?\d|deepseek|qwen|claude|sonnet|opus|haiku|gemini|flash|grok|poe|o\d(?:-|\b))/i;
  const rejectModelPattern = /(?:指南|教程|置顶|github|guide|tutorial|prompt|如何|怎么)/i;
  const modelCandidates = [];
  for (const selector of modelSelectorSets[site] || []) {
    try { modelCandidates.push(...Array.from(document.querySelectorAll(selector)).filter(visible)); }
    catch { /* invalid selector */ }
  }
  let model = '';
  for (const el of modelCandidates) {
    const value = normalize([
      el.textContent, el.getAttribute('aria-label'), el.getAttribute('title'),
    ].filter(Boolean).join(' ')).replace(/\s+/g, ' ');
    if (value && value.length <= 80 && modelPattern.test(value) && !rejectModelPattern.test(value)) {
      model = value;
      break;
    }
  }
  // DeepSeek 的回答操作按钮没有 aria-label；ChatGPT 使用“复制回复”区分
  // assistant 回答与 aria-label="复制消息" 的用户消息复制按钮。
  let copyReady = null;
  if (site === 'chatgpt') {
    const replyCopyButtons = Array.from(document.querySelectorAll(
      'button[aria-label="复制回复"][data-testid="copy-turn-action-button"]',
    ));
    const turns = Array.from(document.querySelectorAll(
      'section[data-turn="assistant"], [data-testid^="conversation-turn-"][data-turn="assistant"]',
    ));
    const latestTurn = turns[turns.length - 1];
    const latestMessage = latestTurn?.querySelector('[data-message-author-role="assistant"]');
    const lastReplyCopy = replyCopyButtons[replyCopyButtons.length - 1];
    const exactReady = !!(latestTurn && lastReplyCopy && latestTurn.contains(lastReplyCopy));
    const followsMessage = node => !!(
      latestMessage
      && (latestMessage.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)
    );
    const groups = latestTurn
      ? Array.from(latestTurn.querySelectorAll('[role="group"], div'))
      : [];
    const bottomGroup = groups
      .map(group => ({
        group,
        buttons: Array.from(group.children)
          .filter(child => child.matches?.('button, [role="button"]')),
        bottom: group.getBoundingClientRect().bottom,
      }))
      .filter(item => followsMessage(item.group) && item.buttons.length >= 2)
      .sort((a, b) => b.bottom - a.bottom)[0];
    const followingButtons = latestTurn
      ? Array.from(latestTurn.querySelectorAll('button, [role="button"]')).filter(followsMessage)
      : [];
    copyReady = exactReady || !!bottomGroup || followingButtons.length > 0;
  } else if (site === 'deepseek') {
    const answers = Array.from(document.querySelectorAll('.ds-assistant-message-main-content'));
    const latestAnswer = answers[answers.length - 1];
    const item = latestAnswer?.closest('[data-virtual-list-item-key]') || latestAnswer?.parentElement;
    const groups = item ? Array.from(item.querySelectorAll('.ds-flex')) : [];
    copyReady = groups.some(group => {
      const directButtons = Array.from(group.children)
        .filter(child => child.matches?.('[role="button"].ds-button'));
      return directButtons.length >= 4
        && !!(latestAnswer.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING);
    });
  }

  return {
    texts: unique.map(item => item.text),
    candidates: unique,
    busy: busySignals.length > 0,
    busySignals,
    model,
    copyReady,
  };
}

function dumpChatPageInPage(site, prompt) {
  const normalize = (value) => String(value || '')
    .replace(/\u200b/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
  const truncate = (value, limit) => {
    const text = String(value || '');
    return text.length > limit ? text.slice(0, limit) + '\n...[dump truncated]...' : text;
  };
  const visible = (el) => {
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.visibility !== 'hidden' && style.display !== 'none'
      && Number(style.opacity || 1) > 0 && rect.width > 20 && rect.height > 8;
  };
  const selectorSets = {
    deepseek: ['[data-message-author-role="assistant"]', '.ds-markdown', '[class*="ds-markdown"]', '[class*="markdown"]'],
    qwen: ['[data-message-author-role="assistant"]', '[data-role="assistant"]', '.markdown-body', '[class*="response-content"]'],
    chatgpt: [
      '[data-message-author-role="assistant"]',
      'article[data-testid^="conversation-turn-"] [class*="markdown"]',
      'article[data-testid^="conversation-turn-"]',
      '.markdown',
    ],
    claude: ['[data-is-streaming]', '[data-testid*="assistant"]', '[class*="font-claude-response"]'],
    gemini: ['message-content', '.model-response-text', '[class*="model-response"]', '[data-test-id*="response"]'],
    grok: ['[data-testid*="assistant"]', '[data-testid*="message"] [class*="markdown"]', '[class*="markdown"]'],
    poe: ['[class*="Message_botMessage"]', '[class*="Markdown_markdownContainer"]'],
    generic: ['[data-message-author-role="assistant"]', '[data-role="assistant"]', '[class*="markdown"]'],
  };
  const selectors = selectorSets[site] || selectorSets.generic;
  const seen = new Set();
  const assistantNodes = [];
  selectors.forEach((selector, priority) => {
    let nodes = [];
    try { nodes = Array.from(document.querySelectorAll(selector)).filter(visible); } catch { return; }
    nodes.slice(-20).forEach((el, order) => {
      if (seen.has(el)) return;
      seen.add(el);
      const attributes = {};
      for (const name of ['data-message-author-role', 'data-role', 'data-testid', 'data-is-streaming', 'aria-busy', 'class']) {
        const value = el.getAttribute(name);
        if (value) attributes[name] = truncate(value, 500);
      }
      assistantNodes.push({
        selector,
        priority,
        order,
        tag: el.tagName.toLowerCase(),
        attributes,
        innerText: truncate(normalize(el.innerText), 120000),
        textContent: truncate(normalize(el.textContent), 120000),
        outerHTML: truncate(el.outerHTML, 180000),
      });
    });
  });

  const promptText = normalize(prompt);
  let mainText = '';
  let mainAfterPrompt = '';
  for (const selector of ['main', '[role="main"]', 'body']) {
    const root = document.querySelector(selector);
    if (!root) continue;
    mainText = normalize(root.innerText || root.textContent);
    const promptIndex = promptText ? mainText.lastIndexOf(promptText) : -1;
    if (promptIndex >= 0) mainAfterPrompt = normalize(mainText.slice(promptIndex + promptText.length));
    break;
  }
  const busySelectors = [
    'button[data-testid="stop-button"]', '[data-testid*="stop-generat"]',
    '[data-testid*="stop-response"]', '[data-is-streaming="true"]',
    '[aria-busy="true"] [data-message-author-role="assistant"]',
    '.result-streaming', '[class*="response"][class*="streaming"]', 'mat-progress-spinner',
  ];
  const busySignals = busySelectors.filter(selector => {
    try { return Array.from(document.querySelectorAll(selector)).some(visible); }
    catch { return false; }
  });
  const busyButton = Array.from(document.querySelectorAll('button, [role="button"]')).some(button => {
    if (!visible(button)) return false;
    const label = [
      button.getAttribute('aria-label'), button.getAttribute('title'),
      button.getAttribute('data-testid'), button.textContent,
    ].filter(Boolean).join(' ').trim().toLowerCase();
    return /stop(?: generating| response)?|停止(?:生成|回答)?|中止生成|暂停生成|cancel response/.test(label);
  });
  if (busyButton) busySignals.push('stop-button');

  const candidates = [];
  assistantNodes.forEach(node => {
    const rendered = normalize(node.innerText);
    const raw = normalize(node.textContent);
    let text = !rendered || (site !== 'chatgpt' && raw.length > rendered.length * 1.25)
      ? raw
      : rendered;
    if (!text || text === promptText) return;
    if (promptText && text.startsWith(promptText)) text = normalize(text.slice(promptText.length));
    if (text) candidates.push({ text, priority: node.priority, fallback: false });
  });
  if (mainAfterPrompt.length >= 20 && mainAfterPrompt.length <= 120000) {
    candidates.push({ text: mainAfterPrompt, priority: selectors.length + 10, fallback: true });
  }

  return {
    capturedAt: new Date().toISOString(),
    site,
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    prompt: truncate(promptText, 20000),
    busy: busySignals.length > 0,
    busySignals,
    mainText: truncate(mainText, 200000),
    mainAfterPrompt: truncate(mainAfterPrompt, 120000),
    candidates,
    assistantNodes,
  };
}

async function waitForRenderedAnswerInPage(site, timeoutMs = 10000) {
  const selectors = {
    chatgpt: ['section[data-turn="assistant"]:last-of-type [data-message-author-role="assistant"]', '[data-message-author-role="assistant"]'],
    deepseek: ['.ds-assistant-message-main-content', '.ds-markdown'],
    generic: ['[data-message-author-role="assistant"]', '[data-role="assistant"]', '[class*="markdown"]'],
  };
  const waitForPaint = () => new Promise(resolve => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    setTimeout(finish, 250);
    requestAnimationFrame(() => requestAnimationFrame(finish));
  });
  const started = Date.now();
  let previous = '';
  let stableFrames = 0;
  let stableSince = 0;
  let snapshot = null;
  while (Date.now() - started < timeoutMs) {
    let answer = null;
    for (const selector of selectors[site] || selectors.generic) {
      const nodes = Array.from(document.querySelectorAll(selector));
      if (nodes.length) {
        answer = nodes[nodes.length - 1];
        break;
      }
    }
    if (!answer) {
      await waitForPaint();
      continue;
    }
    answer.scrollIntoView({ block: 'end', behavior: 'instant' });
    await waitForPaint();
    const rect = answer.getBoundingClientRect();
    const rendered = String(answer.innerText || '').trim();
    const signature = [
      rendered.length,
      Math.round(rect.height),
      document.scrollingElement?.scrollHeight || 0,
      document.readyState,
    ].join(':');
    snapshot = {
      renderedChars: rendered.length,
      height: Math.round(rect.height),
      scrollHeight: document.scrollingElement?.scrollHeight || 0,
      readyState: document.readyState,
      stableFrames,
    };
    if (signature === previous && rendered) {
      stableFrames += 1;
      if (!stableSince) stableSince = Date.now();
    } else {
      stableFrames = 0;
      stableSince = 0;
    }
    previous = signature;
    // 至少保持 800ms 不变，避免 DOM 已有文本但页面还没有真正绘制完毕。
    if (stableFrames >= 4 && stableSince && Date.now() - stableSince >= 800) {
      return { ok: true, ...snapshot, stableFrames, stableMs: Date.now() - stableSince };
    }
  }
  return { ok: false, ...(snapshot || {}), stableFrames, timedOut: true };
}

function scrollToLatestAnswerInPage(site) {
  const answerSelectors = {
    chatgpt: ['[data-message-author-role="assistant"]', 'article[data-testid^="conversation-turn-"]'],
    deepseek: ['[data-message-author-role="assistant"]', '.ds-markdown', '[class*="ds-markdown"]'],
    qwen: ['[data-message-author-role="assistant"]', '[data-role="assistant"]', '.markdown-body'],
    claude: ['[data-testid*="assistant"]', '[class*="font-claude-response"]'],
    gemini: ['message-content', '.model-response-text', '[class*="model-response"]'],
    grok: ['[data-testid*="assistant"]', '[data-testid*="message"]'],
    poe: ['[class*="Message_botMessage"]', '[class*="Markdown_markdownContainer"]'],
    generic: ['[data-message-author-role="assistant"]', '[data-role="assistant"]', '[class*="markdown"]'],
  };
  const scrolling = new Set([document.scrollingElement, document.documentElement, document.body]);
  for (const el of document.querySelectorAll('main, [role="main"], [class*="scroll"], [class*="overflow"]')) {
    if (el.scrollHeight > el.clientHeight + 20) scrolling.add(el);
  }
  for (const el of scrolling) {
    if (!el) continue;
    try { el.scrollTop = el.scrollHeight; } catch { /* noop */ }
  }
  window.scrollTo({ top: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight), behavior: 'instant' });
  let latest = null;
  for (const selector of answerSelectors[site] || answerSelectors.generic) {
    let nodes = [];
    try { nodes = Array.from(document.querySelectorAll(selector)); } catch { /* noop */ }
    if (nodes.length) {
      latest = nodes[nodes.length - 1];
      break;
    }
  }
  if (latest) {
    try { latest.scrollIntoView({ block: 'end', behavior: 'instant' }); } catch { /* noop */ }
    for (const type of ['mouseenter', 'mouseover', 'mousemove']) {
      try { latest.dispatchEvent(new MouseEvent(type, { bubbles: true, composed: true })); } catch { /* noop */ }
    }
  }
  return { ok: true, foundAnswer: !!latest };
}

async function clickLatestCopyButtonInPage(site) {
  const prepareButton = async (button, label, chatgptDebug) => {
    button.scrollIntoView({ block: 'end', behavior: 'instant' });
    button.focus?.();
    await new Promise(resolve => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      setTimeout(finish, 250);
      requestAnimationFrame(() => requestAnimationFrame(finish));
    });
    const rect = button.getBoundingClientRect();
    const marker = `llm-copy-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    button.setAttribute('data-llm-manager-copy-target', marker);
    return {
      ok: rect.width > 0 && rect.height > 0,
      error: rect.width > 0 && rect.height > 0 ? '' : '复制按钮当前不可见',
      label,
      method: 'prepared-native-click',
      marker,
      center: {
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
      },
      rect: {
        left: Math.round(rect.left), top: Math.round(rect.top),
        width: Math.round(rect.width), height: Math.round(rect.height),
      },
      chatgptDebug,
    };
  };
  const answerSelectors = {
    chatgpt: ['[data-message-author-role="assistant"]', 'article[data-testid^="conversation-turn-"]'],
    deepseek: ['[data-message-author-role="assistant"]', '.ds-markdown', '[class*="ds-markdown"]'],
    qwen: ['[data-message-author-role="assistant"]', '[data-role="assistant"]', '.markdown-body'],
    claude: ['[data-testid*="assistant"]', '[class*="font-claude-response"]'],
    gemini: ['message-content', '.model-response-text', '[class*="model-response"]'],
    grok: ['[data-testid*="assistant"]', '[data-testid*="message"]'],
    poe: ['[class*="Message_botMessage"]', '[class*="Markdown_markdownContainer"]'],
    generic: ['[data-message-author-role="assistant"]', '[data-role="assistant"]', '[class*="markdown"]'],
  };
  let answer = null;
  for (const selector of answerSelectors[site] || answerSelectors.generic) {
    let nodes = [];
    try { nodes = Array.from(document.querySelectorAll(selector)); } catch { /* noop */ }
    if (nodes.length) {
      answer = nodes[nodes.length - 1];
      break;
    }
  }

  // 先使用经过真实页面 MHTML 验证的站点专用结构。
  let siteButton = null;
  let siteButtonLabel = '';
  let chatgptDebug = null;
  if (site === 'chatgpt') {
    const summarize = (node, index) => {
      const rect = node.getBoundingClientRect();
      return {
        index,
        tag: node.tagName.toLowerCase(),
        ariaLabel: node.getAttribute('aria-label') || '',
        testId: node.getAttribute('data-testid') || '',
        text: String(node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 300),
        rect: {
          left: Math.round(rect.left), top: Math.round(rect.top),
          right: Math.round(rect.right), bottom: Math.round(rect.bottom),
        },
        outerHTML: node.outerHTML.slice(0, 4000),
      };
    };
    const replyCopyButtons = Array.from(document.querySelectorAll(
      'button[aria-label="复制回复"][data-testid="copy-turn-action-button"]',
    ));
    const turns = Array.from(document.querySelectorAll(
      'section[data-turn="assistant"], [data-testid^="conversation-turn-"][data-turn="assistant"]',
    ));
    const latestTurn = turns[turns.length - 1];
    const latestMessage = latestTurn?.querySelector('[data-message-author-role="assistant"]');
    const lastReplyCopy = replyCopyButtons[replyCopyButtons.length - 1];
    const lastReplyBelongsToLatest = !!(
      latestTurn && lastReplyCopy && latestTurn.contains(lastReplyCopy)
    );
    chatgptDebug = {
      selector: 'button[aria-label="复制回复"][data-testid="copy-turn-action-button"]',
      replyCopyNodes: replyCopyButtons.map(summarize),
      lastReplyBelongsToLatest,
      fallback: null,
    };
    siteButton = lastReplyBelongsToLatest ? lastReplyCopy : null;
    siteButtonLabel = 'ChatGPT last aria-label="复制回复" copy-turn-action-button';

    if (!siteButton) {
      const followsMessage = node => !!(
        latestMessage
        && (latestMessage.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)
      );
      const groups = latestTurn
        ? Array.from(latestTurn.querySelectorAll('[role="group"], div'))
        : [];
      const bottomGroup = groups
        .map(group => ({
          group,
          buttons: Array.from(group.children)
            .filter(child => child.matches?.('button, [role="button"]')),
          bottom: group.getBoundingClientRect().bottom,
        }))
        .filter(item => followsMessage(item.group) && item.buttons.length >= 2)
        .sort((a, b) => b.bottom - a.bottom)[0];
      if (bottomGroup) {
        siteButton = bottomGroup.buttons[0];
        siteButtonLabel = 'ChatGPT bottom assistant action row button 1 (fallback)';
        chatgptDebug.fallback = {
          method: 'bottom-group-first',
          candidates: bottomGroup.buttons.map(summarize),
          selected: summarize(siteButton, 0),
        };
      } else {
        const turnButtons = latestTurn
          ? Array.from(latestTurn.querySelectorAll('button, [role="button"]'))
            .filter(followsMessage)
          : [];
        turnButtons.sort((a, b) => {
          const ar = a.getBoundingClientRect();
          const br = b.getBoundingClientRect();
          return (br.top - ar.top) || (ar.left - br.left);
        });
        siteButton = turnButtons[0] || null;
        siteButtonLabel = 'ChatGPT bottom assistant button 1 (fallback)';
        chatgptDebug.fallback = {
          method: 'bottom-button-first',
          candidates: turnButtons.map(summarize),
          selected: siteButton ? summarize(siteButton, 0) : null,
        };
      }
    }
  } else if (site === 'deepseek') {
    const answers = Array.from(document.querySelectorAll('.ds-assistant-message-main-content'));
    const latestAnswer = answers[answers.length - 1];
    const item = latestAnswer?.closest('[data-virtual-list-item-key]') || latestAnswer?.parentElement;
    const groups = item ? Array.from(item.querySelectorAll('.ds-flex')) : [];
    for (const group of groups) {
      const directButtons = Array.from(group.children)
        .filter(child => child.matches?.('[role="button"].ds-button'));
      const followsAnswer = latestAnswer
        && !!(latestAnswer.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING);
      if (followsAnswer && directButtons.length >= 4) {
        siteButton = directButtons[0];
        siteButtonLabel = 'DeepSeek assistant action button 1 (copy)';
        break;
      }
    }
  }
  if (siteButton) {
    try {
      return await prepareButton(siteButton, siteButtonLabel, chatgptDebug);
    } catch (error) {
      return {
        ok: false,
        error: String(error?.message || error || '点击站点复制按钮失败'),
        chatgptDebug,
      };
    }
  }

  const scopes = [];
  if (answer) {
    scopes.push(answer);
    let parent = answer.parentElement;
    for (let depth = 0; parent && depth < 6; depth += 1, parent = parent.parentElement) {
      scopes.push(parent);
      if (parent.matches?.('article, [data-testid^="conversation-turn-"], [data-message-id], [class*="message"]')) break;
    }
  }
  scopes.push(document);

  const seen = new Set();
  const scored = [];
  scopes.forEach((scope, scopeIndex) => {
    let buttons = [];
    try { buttons = Array.from(scope.querySelectorAll('button, [role="button"]')); } catch { return; }
    buttons.forEach((button, order) => {
      if (seen.has(button)) return;
      seen.add(button);
      const label = [
        button.getAttribute('aria-label'), button.getAttribute('title'),
        button.getAttribute('data-testid'), button.textContent,
      ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
      if (!/(?:^|\b)copy(?:\b|$)|复制(?:回答|回复|内容)?/i.test(label)) return;
      if (/copy code|复制代码|copy link|复制链接/i.test(label)) return;
      let score = 100 - scopeIndex * 12 + order / 1000;
      if (/copy-turn-action-button|copy-response|copy-answer/i.test(label)) score += 100;
      if (/^(copy|复制|复制回答|复制回复|copy response|copy answer)$/i.test(label)) score += 60;
      const rect = button.getBoundingClientRect();
      score += Math.max(0, rect.top) / Math.max(1, innerHeight) * 10;
      scored.push({ button, label, score });
    });
  });
  scored.sort((a, b) => b.score - a.score);
  const selected = scored[0];
  if (!selected) {
    return { ok: false, error: '未找到当前回答的复制按钮', chatgptDebug };
  }
  try {
    return await prepareButton(selected.button, selected.label, chatgptDebug);
  } catch (error) {
    return {
      ok: false,
      error: String(error?.message || error || '点击复制按钮失败'),
      chatgptDebug,
    };
  }
}

function clickPreparedCopyButtonInPage(marker) {
  const target = Array.from(document.querySelectorAll('[data-llm-manager-copy-target]'))
    .find(node => node.getAttribute('data-llm-manager-copy-target') === marker);
  if (!target) return { ok: false, error: '准备点击的复制按钮已失效' };
  target.click();
  return { ok: true };
}

async function copyLatestAnswerMarkdown(webContents, site, onProgress) {
  // Callers may hold either a WebContentsView or its webContents. Normalize
  // here so a view cannot produce the misleading "executeJavaScript is not a
  // function" error during manual project imports.
  webContents = webContents?.webContents || webContents;
  const report = (event, message, details = {}) => {
    try { onProgress?.(event, message, details); } catch { /* progress must not break extraction */ }
  };
  if (!webContents || typeof webContents.executeJavaScript !== 'function') {
    report('copy-failed', '网页复制桥不可用');
    return { ok: false, error: '网页复制桥不可用，请重启桌面应用后重试' };
  }
  if (!systemClipboard) {
    report('copy-failed', '系统剪贴板不可用');
    return { ok: false, error: 'Electron 剪贴板不可用' };
  }
  return withClipboardLock(async () => {
    const previousClipboard = systemClipboard.readText();
    const marker = `__LLM_MANAGER_COPY_${Date.now()}_${Math.random().toString(36).slice(2)}__`;
    let captured = '';
    try {
      await webContents.executeJavaScript(scriptCall(scrollToLatestAnswerInPage, site), true);
      report('scrolled-bottom', '已滚动到网页回答底部');
      await sleep(600);
      systemClipboard.writeText(marker);
      const clicked = await webContents.executeJavaScript(
        scriptCall(clickLatestCopyButtonInPage, site),
        true,
      );
      report('copy-nodes-scanned', '复制按钮节点扫描完成', {
        matchedNodes: clicked?.chatgptDebug?.replyCopyNodes?.length,
        usedFallback: !!clicked?.chatgptDebug?.fallback,
        selected: clicked?.label || '',
        rect: clicked?.rect || null,
      });
      if (site === 'chatgpt') {
        console.log(
          '[web-chat] ChatGPT 复制回复节点:',
          JSON.stringify(clicked?.chatgptDebug?.replyCopyNodes || [], null, 2),
        );
        if (clicked?.chatgptDebug?.fallback) {
          console.log(
            '[web-chat] ChatGPT 当前回复未找到可用“复制回复”，底部首按钮回退:',
            JSON.stringify(clicked.chatgptDebug.fallback, null, 2),
          );
        }
      }
      if (!clicked?.ok) {
        report('copy-failed', '未找到或无法点击复制按钮', {
          error: clicked?.error || '复制按钮不可用',
        });
        return {
          ok: false,
          error: clicked?.error || '复制按钮不可用',
          nodeDiagnostics: clicked?.chatgptDebug || null,
        };
      }

      const domFallback = async () => webContents.executeJavaScript(
        scriptCall(clickPreparedCopyButtonInPage, clicked.marker),
        true,
      );
      let clickMethod = 'native-input';
      let fallbackUsed = false;
      const clickStartedAt = Date.now();
      try {
        if (!clicked.center || typeof webContents.sendInputEvent !== 'function') {
          throw new Error('当前 WebContents 不支持原生鼠标事件');
        }
        webContents.focus();
        const point = {
          x: Math.max(0, Math.round(clicked.center.x)),
          y: Math.max(0, Math.round(clicked.center.y)),
        };
        webContents.sendInputEvent({ type: 'mouseMove', ...point });
        webContents.sendInputEvent({
          type: 'mouseDown', ...point, button: 'left', clickCount: 1,
        });
        webContents.sendInputEvent({
          type: 'mouseUp', ...point, button: 'left', clickCount: 1,
        });
      } catch (error) {
        clickMethod = 'dom-click';
        fallbackUsed = true;
        const fallback = await domFallback();
        if (!fallback?.ok) throw new Error(fallback?.error || String(error?.message || error));
      }
      report('copy-clicked', '已通过真实鼠标事件点击网页回答复制按钮', {
        button: clicked.label || '',
        method: clickMethod,
        usedFallback: !!clicked?.chatgptDebug?.fallback,
        point: clicked.center || null,
      });

      for (let attempt = 0; attempt < 64; attempt += 1) {
        await sleep(125);
        const value = systemClipboard.readText();
        const formats = typeof systemClipboard.availableFormats === 'function'
          ? systemClipboard.availableFormats()
          : [];
        if (value && value !== marker) {
          captured = value;
          report('markdown-copied', '已从剪贴板取得 Markdown', {
            chars: value.length,
            method: clickMethod,
            elapsedMs: Date.now() - clickStartedAt,
            formats,
          });
          return {
            ok: true,
            content: value,
            chars: value.length,
            buttonLabel: clicked.label || '',
            source: 'copy-button',
            clickMethod,
            clipboardFormats: formats,
            nodeDiagnostics: clicked?.chatgptDebug || null,
          };
        }
        if (attempt === 15 && clickMethod === 'native-input') {
          const fallback = await domFallback().catch(error => ({
            ok: false,
            error: String(error?.message || error),
          }));
          fallbackUsed = true;
          clickMethod = 'native-input+dom-fallback';
          report('copy-click-fallback', fallback?.ok
            ? '原生点击后剪贴板暂未更新，已补充执行 DOM 点击'
            : '原生点击后剪贴板暂未更新，DOM 点击回退失败', {
            ok: !!fallback?.ok,
            error: fallback?.error || '',
            elapsedMs: Date.now() - clickStartedAt,
            formats,
          });
        }
      }
      const formats = typeof systemClipboard.availableFormats === 'function'
        ? systemClipboard.availableFormats()
        : [];
      report('copy-failed', '点击复制后 8 秒内未读取到 Markdown', {
        method: clickMethod,
        fallbackUsed,
        elapsedMs: Date.now() - clickStartedAt,
        formats,
        clipboardChars: systemClipboard.readText().length,
      });
      return {
        ok: false,
        error: '点击复制按钮后 8 秒内未读取到剪贴板内容',
        buttonLabel: clicked.label || '',
        clickMethod,
        clipboardFormats: formats,
        nodeDiagnostics: clicked?.chatgptDebug || null,
      };
    } catch (error) {
      const message = String(error?.message || error || '复制网页回答失败');
      report('copy-failed', '复制网页回答失败', { error: message });
      return { ok: false, error: message };
    } finally {
      const current = systemClipboard.readText();
      if (current === marker || current === captured) systemClipboard.writeText(previousClipboard);
    }
  });
}
function clickNewChatInPage() {
  const visible = (el) => {
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.visibility !== 'hidden' && style.display !== 'none'
      && Number(style.opacity || 1) > 0 && rect.width > 8 && rect.height > 8;
  };
  const selectors = [
    '[data-testid="create-new-chat-button"]', '[data-testid="new-chat-button"]',
    '[data-test-id="new-chat-button"]', 'a[href="/new"]',
  ];
  for (const selector of selectors) {
    const el = document.querySelector(selector);
    if (el && visible(el)) {
      el.click();
      return { ok: true, method: 'button' };
    }
  }
  const labelPattern = /^(new chat|new conversation|start new chat|新对话|新聊天|开始新对话|开启新对话)$/i;
  const element = Array.from(document.querySelectorAll('button, a, [role="button"]')).find(el => {
    if (!visible(el)) return false;
    const label = [el.textContent, el.getAttribute('aria-label'), el.getAttribute('title')]
      .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    return labelPattern.test(label);
  });
  if (!element) return { ok: false };
  element.click();
  return { ok: true, method: 'button' };
}

async function readState(webContents, site, prompt) {
  return webContents.executeJavaScript(scriptCall(readChatStateInPage, site, prompt), true);
}

async function dumpPage(webContents, site, prompt) {
  return webContents.executeJavaScript(scriptCall(dumpChatPageInPage, site, prompt), true);
}

async function runWebChat(view, prompt, options = {}) {
  const webContents = view?.webContents;
  if (!webContents || webContents.isDestroyed()) {
    return { ok: false, error: '网页标签已关闭' };
  }
  const cleanPrompt = String(prompt || '').trim();
  if (!cleanPrompt) return { ok: false, error: '问题不能为空' };
  if (cleanPrompt.length > 20000) return { ok: false, error: '问题过长（最多 20000 字符）' };

  const startedAt = Date.now();
  const timeoutMs = clampTimeout(options.timeoutMs);
  const url = webContents.getURL() || '';
  const site = detectSite(url);
  const title = webContents.getTitle() || site;
  const emit = (event, message, details = {}) => {
    try { options.onProgress?.(event, message, details); } catch { /* progress is best effort */ }
  };
  const checkAborted = () => {
    if (options.signal?.aborted) throw new Error('网页项目流程已停止');
  };

  try {
    checkAborted();
    const before = await readState(webContents, site, cleanPrompt);
    const prepared = await webContents.executeJavaScript(
      scriptCall(preparePromptInPage, cleanPrompt), true,
    );
    if (!prepared?.ok) {
      return { ok: false, site, title, url, error: prepared?.error || '无法填写问题' };
    }
    await sleep(350);
    checkAborted();
    const submitted = await webContents.executeJavaScript(scriptCall(submitPromptInPage), true);
    if (!submitted?.ok) {
      emit('prompt-failed', '问题发送失败', { error: submitted?.error || '无法发送问题' });
      return { ok: false, site, title, url, error: submitted?.error || '无法发送问题' };
    }
    emit('prompt-sent', '问题已发送到网页大模型', { method: submitted.method || '' });

    const previous = new Set(Array.isArray(before?.texts) ? before.texts : []);
    const forcedStableMs = Number(options.stableMs);
    const pickCandidate = (state) => {
      const rawCandidates = Array.isArray(state?.candidates)
        ? state.candidates
        : (Array.isArray(state?.texts) ? state.texts.map(text => ({ text })) : []);
      const fresh = rawCandidates
        .map(item => ({
          text: String(item?.text || '').trim(),
          priority: Number(item?.priority || 0),
          fallback: !!item?.fallback,
        }))
        .filter(item => item.text && item.text !== cleanPrompt && !previous.has(item.text));
      const longest = items => items.sort((a, b) =>
        (b.text.length - a.text.length) || (a.priority - b.priority))[0];
      const primary = longest(fresh.filter(item => !item.fallback));
      const fallback = longest(fresh.filter(item => item.fallback));
      if (!primary) return fallback?.text || '';
      if (fallback && fallback.text.length > Math.max(primary.text.length * 1.5, primary.text.length + 160)) {
        return fallback.text;
      }
      return primary.text;
    };
    let detectedModel = String(before?.model || '').trim();
    let latest = '';
    let stableSince = 0;
    let lastState = before;
    let pageDump = null;
    let extraction = null;
    let serverReplyNotified = false;
    let completionNotified = false;
    let renderNotified = false;
    const dumpDelayMs = Number.isFinite(Number(options.dumpDelayMs))
      ? Math.max(100, Math.min(5000, Number(options.dumpDelayMs)))
      : 1500;
    const validateDump = (dump, selected, copyResult) => {
      const bestDumpCandidate = dump ? pickCandidate(dump) : '';
      const maxCandidateChars = bestDumpCandidate.length;
      const dumpCovered = !maxCandidateChars || selected.length >= maxCandidateChars * 0.9;
      return {
        complete: !dump?.busy && !!selected && (!!copyResult?.ok || dumpCovered),
        selectedChars: selected.length,
        dumpMaxCandidateChars: maxCandidateChars,
        busyAfterDump: !!dump?.busy,
        copiedMarkdown: !!copyResult?.ok,
        reason: dump?.busy
          ? '网页 dump 仍显示生成中'
          : (copyResult?.ok
            ? '已在页面底部点击当前回答复制按钮，并使用剪贴板 Markdown'
            : (dumpCovered
              ? '复制按钮不可用，DOM 提取内容已覆盖 dump 中的最长候选'
              : '复制按钮不可用且 dump 中存在更长候选内容')),
      };
    };
    while (Date.now() - startedAt < timeoutMs) {
      checkAborted();
      await sleep(500);
      checkAborted();
      const state = await readState(webContents, site, cleanPrompt);
      lastState = state;
      if (state?.model) detectedModel = String(state.model).trim();
      const candidate = pickCandidate(state);
      if (!candidate) continue;
      if (!serverReplyNotified) {
        serverReplyNotified = true;
        emit('server-replied', '服务器已回复，正在渲染内容', { chars: candidate.length });
      }
      if (candidate !== latest) {
        // 页面虚拟化偶尔会暂时只保留末尾片段，不能用短片段覆盖已取得的长回答。
        if (!latest || candidate.length >= latest.length * 0.8) {
          latest = candidate;
          stableSince = Date.now();
        }
      }
      const settleMs = Number.isFinite(forcedStableMs)
        ? Math.max(500, Math.min(30000, forcedStableMs))
        : (latest.length < 120 ? 15000 : 8000);
      if (!state?.busy && latest && Date.now() - stableSince >= settleMs) {
        checkAborted();
        // 对已知站点，复制按钮是回答完成渲染的最终信号。按钮未出现时继续等待。
        if ((site === 'deepseek' || site === 'chatgpt') && state?.copyReady !== true) continue;
        // 回答信号完成后继续等待实际布局与 innerText 跨帧稳定。
        await sleep(dumpDelayMs);
        let renderState = null;
        try {
          webContents.invalidate?.();
          renderState = await webContents.executeJavaScript(
            scriptCall(waitForRenderedAnswerInPage, site, 10000),
            true,
          );
        } catch (error) {
          renderState = { ok: false, error: String(error?.message || error) };
        }
        if (!completionNotified) {
          completionNotified = true;
          emit('response-complete', '服务器回复完成，网页内容已同步', {
            chars: latest.length,
            copyReady: state?.copyReady,
            renderedChars: renderState?.renderedChars || 0,
            renderedStable: !!renderState?.ok,
          });
        }
        if (!renderNotified) {
          renderNotified = true;
          emit(
            'page-rendered',
            renderState?.ok
              ? '网页回答已完成实际渲染，开始查找复制节点'
              : '网页渲染稳定性等待结束，开始查找复制节点',
            renderState || {},
          );
        }
        const copied = await copyLatestAnswerMarkdown(webContents, site, emit);
        checkAborted();
        extraction = {
          ok: !!copied?.ok,
          source: copied?.ok ? 'copy-button' : 'dom',
          copiedChars: copied?.chars || 0,
          buttonLabel: copied?.buttonLabel || '',
          clickMethod: copied?.clickMethod || '',
          clipboardFormats: copied?.clipboardFormats || [],
          error: copied?.ok ? undefined : copied?.error,
        };
        if (copied?.ok && copied.content) latest = String(copied.content).trim();
        const completionDump = await dumpPage(webContents, site, cleanPrompt).catch(() => null);
        if (completionDump) {
          if (copied?.nodeDiagnostics) completionDump.copyNodeDiagnostics = copied.nodeDiagnostics;
          pageDump = completionDump;
          emit('dom-dump-captured', '页面 DOM 与复制节点快照已完成', {
            assistantNodes: completionDump.assistantNodes?.length || 0,
            copyNodes: copied?.nodeDiagnostics?.replyCopyNodes?.length || 0,
          });
          const dumpCandidate = pickCandidate(completionDump);
          if (completionDump.busy) {
            lastState = completionDump;
            continue;
          }
          if (!extraction?.ok && dumpCandidate && dumpCandidate !== latest
              && dumpCandidate.length >= Math.max(latest.length * 1.1, latest.length + 40)) {
            latest = dumpCandidate;
            stableSince = Date.now();
            lastState = completionDump;
            continue;
          }
        }
        const validation = validateDump(pageDump, latest, extraction);
        if (pageDump && !validation.complete) {
          stableSince = Date.now();
          lastState = pageDump;
          continue;
        }
        return {
          ok: true, site, title, model: detectedModel, url: webContents.getURL() || url,
          content: latest, durationMs: Date.now() - startedAt,
          pageDump,
          validation,
          extraction,
          diagnostics: {
            candidateCount: Array.isArray(state?.candidates) ? state.candidates.length : 0,
            busySignals: state?.busySignals || [],
            settleMs,
            copyReady: state?.copyReady,
          },
        };
      }
    }

    // 超时边界再读取一次，避免漏掉恰好在最后一个轮询周期完成的正文。
    checkAborted();
    emit('response-timeout', '等待网页回复完成超时，执行最终页面校验');
    const finalState = await readState(webContents, site, cleanPrompt).catch(() => lastState);
    let finalRenderState = null;
    try {
      webContents.invalidate?.();
      finalRenderState = await webContents.executeJavaScript(
        scriptCall(waitForRenderedAnswerInPage, site, 5000),
        true,
      );
    } catch (error) {
      finalRenderState = { ok: false, error: String(error?.message || error) };
    }
    if (!renderNotified) {
      renderNotified = true;
      emit('page-rendered', '最终页面渲染检查完成，开始查找复制节点', finalRenderState || {});
    }
    const copied = await copyLatestAnswerMarkdown(webContents, site, emit);
    extraction = {
      ok: !!copied?.ok,
      source: copied?.ok ? 'copy-button' : 'dom',
      copiedChars: copied?.chars || 0,
      buttonLabel: copied?.buttonLabel || '',
      clickMethod: copied?.clickMethod || '',
      clipboardFormats: copied?.clipboardFormats || [],
      error: copied?.ok ? undefined : copied?.error,
    };
    if (copied?.ok && copied.content) latest = String(copied.content).trim();
    pageDump = await dumpPage(webContents, site, cleanPrompt).catch(() => null);
    if (pageDump && copied?.nodeDiagnostics) pageDump.copyNodeDiagnostics = copied.nodeDiagnostics;
    if (pageDump) {
      emit('dom-dump-captured', '最终页面 DOM 与复制节点快照已完成', {
        assistantNodes: pageDump.assistantNodes?.length || 0,
        copyNodes: copied?.nodeDiagnostics?.replyCopyNodes?.length || 0,
      });
    }
    const finalCandidate = pickCandidate(pageDump || finalState);
    if (!extraction?.ok && finalCandidate && (!latest || finalCandidate.length >= latest.length * 0.8)) latest = finalCandidate;
    const validation = validateDump(pageDump, latest, extraction);
    if (latest) {
      return {
        ok: true, partial: true, site, title, model: detectedModel, url: webContents.getURL() || url,
        content: latest, durationMs: Date.now() - startedAt,
        warning: validation.busyAfterDump
          ? '等待超时，网页 dump 显示模型仍在生成；已返回当前最长内容'
          : '等待回答结束超时，已返回 dump 校验后的最长内容',
        pageDump,
        validation,
        extraction,
        diagnostics: {
          candidateCount: Array.isArray(finalState?.candidates) ? finalState.candidates.length : 0,
          busySignals: finalState?.busySignals || [],
          timedOut: true,
        },
      };
    }
    return {
      ok: false, site, title, model: detectedModel, url,
      durationMs: Date.now() - startedAt,
      error: `等待网页回答超时（${Math.round(timeoutMs / 1000)} 秒，未检测到回答节点）`,
      pageDump,
      validation,
      extraction,
      diagnostics: {
        candidateCount: Array.isArray(finalState?.candidates) ? finalState.candidates.length : 0,
        busySignals: finalState?.busySignals || [],
        timedOut: true,
      },
    };
  } catch (error) {
    emit('web-chat-error', '网页大模型处理失败', {
      error: String(error?.message || error || '网页聊天失败'),
    });
    return {
      ok: false, site, title, url,
      error: String(error?.message || error || '网页聊天失败'),
      durationMs: Date.now() - startedAt,
    };
  }
}

const NEW_CHAT_URLS = {
  deepseek: 'https://chat.deepseek.com/',
  qwen: 'https://chat.qwen.ai/',
  chatgpt: 'https://chatgpt.com/',
  claude: 'https://claude.ai/new',
  gemini: 'https://gemini.google.com/app',
  grok: 'https://grok.com/',
  poe: 'https://poe.com/',
};

async function startNewWebChat(view) {
  const webContents = view?.webContents;
  if (!webContents || webContents.isDestroyed()) return { ok: false, error: '网页标签已关闭' };
  const oldUrl = webContents.getURL() || '';
  const site = detectSite(oldUrl);
  try {
    const clicked = await webContents.executeJavaScript(scriptCall(clickNewChatInPage), true);
    if (clicked?.ok) {
      await sleep(500);
      return { ok: true, site, method: clicked.method, url: webContents.getURL() || oldUrl };
    }
    const targetUrl = NEW_CHAT_URLS[site];
    if (!targetUrl) return { ok: false, site, error: '该网页暂不支持自动新建对话' };
    await webContents.loadURL(targetUrl);
    return { ok: true, site, method: 'navigate', url: webContents.getURL() || targetUrl };
  } catch (error) {
    return { ok: false, site, error: String(error?.message || error || '新建网页对话失败') };
  }
}

module.exports = {
  detectSite,
  runWebChat,
  copyLatestAnswerMarkdown,
  startNewWebChat,
  __test: { readChatStateInPage, copyLatestAnswerMarkdown },
};
