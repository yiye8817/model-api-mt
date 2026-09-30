'use strict';

// Serialized into an isolated world. Keep all DOM helpers inside this function.
// These are structural fallbacks, not a claim about a particular live website version.
function pageAction(action, args) {
  if (action === 'abort') {
    if (globalThis.__fusionJob?.id === args.id) {
      const job = globalThis.__fusionJob;
      if (job.recovery?.watchHandler) document.removeEventListener('click', job.recovery.watchHandler, true);
      if (job.recovery) job.recovery.watchHandler = null;
      job.cancelled = true;
    }
    return true;
  }
  const provider = args.provider_id || '';
  const defaults = {
    chatgpt: {
      input: ['#prompt-textarea[contenteditable="true"]', '#prompt-textarea', '.ProseMirror[contenteditable="true"]', 'textarea[data-id="root"]', '[contenteditable="true"][role="textbox"]'],
      send: ['#composer-submit-button', 'button[data-testid="send-button"]', 'button[data-testid="composer-submit-button"]'],
      assistant: ['[data-message-author-role="assistant"]'],
      stop: ['button[data-testid="stop-button"]', '#composer-submit-button[data-testid="stop-button"]'],
    },
    qwen: {
      input: ['#chat-input', 'textarea.message-input-textarea', 'textarea', '[contenteditable="true"][role="textbox"]'],
      send: ['#send-message-button', '.chat-prompt-send-button button', 'button.send-button', '.message-input-right-button-send', 'button[data-testid="send-button"]'],
      assistant: ['[data-message-author-role="assistant"]', '[data-message-role="assistant"]', '[data-role="assistant"]', '[data-testid="assistant-message"]', '.chat-assistant', '.assistant-message', '[id^="response-message-"]'],
      stop: ['#stop-response-button', 'button[data-testid="stop-button"]', 'button[aria-label="Stop generating"]', 'button[aria-label="停止生成"]'],
    },
    glm: {
      input: ['#chat-input[contenteditable="true"]', '#chat-input textarea', '#chat-input [contenteditable="true"]', '#prompt-textarea[contenteditable="true"]', '.ProseMirror[contenteditable="true"]', '.tiptap[contenteditable="true"]', 'textarea#chat-input', 'textarea[data-testid="chat-input"]', '[data-testid="chat-input"][contenteditable="true"]', '[data-testid="chat-input"] textarea', '[data-testid="chat-input"] [contenteditable="true"]', 'textarea[placeholder^="Ask anything" i]', 'textarea[placeholder^="Send a message" i]', 'textarea[placeholder^="Message" i]', '[contenteditable="true"][data-placeholder^="Ask anything" i]', '[contenteditable="true"][data-placeholder^="Send a message" i]', 'textarea[placeholder*="发送消息"]', 'textarea[placeholder*="输入"]', '[contenteditable="true"][role="textbox"]'],
      send: ['button#send-message-button', 'button#send-button', '[data-testid="send-message-button"]', 'button.sendMessageButton', 'button[aria-label="Send Message"]', 'button[data-testid="send-button"]', 'button[aria-label="发送消息"]', 'button[aria-label="发送"]', 'button[aria-label="Send message"]', 'button[aria-label="Send"]'],
      user: ['.user-message', '[data-testid="user-message"]', '[data-message-author-role="user"]', '[data-role="user"]', '.chatglm-message.user', '.message-item.user'],
      assistant: ['[data-message-role="assistant"]', '.assistant-message', '[data-testid="assistant-message"]', '[data-message-author-role="assistant"]', '[data-role="assistant"]', '.chatglm-message.assistant', '.message-item.assistant'],
      stop: ['button[data-testid="stop-button"]', 'button[aria-label="停止生成"]', 'button[aria-label="停止回答"]', 'button[aria-label="Stop generating"]'],
      new_chat: ['button[data-testid="new-chat-button"]', 'a[data-testid="new-chat-button"]', '#sidebar-new-chat-button', 'button[aria-label="New chat" i]', 'a[aria-label="New chat" i]', 'button[aria-label="新建对话"]', 'button[aria-label="新对话"]'],
      error: ['[data-testid="generation-error"]', '[data-testid="response-error"]', '.chatglm-message-error', '.chatglm-error'],
      retry: ['button[data-testid="retry-button"]', 'button[data-testid="regenerate-button"]', 'button[aria-label="重试"]', 'button[aria-label="重新生成"]'],
    },
    doubao: {
      // Current Doubao uses a Tiptap editor without role="textbox". Keep the
      // test-id scope first so the hidden guidance textarea is never selected.
      input: ['[data-testid="chat_input_input"] .tiptap[contenteditable="true"]', '[data-testid="chat_input_input"] [contenteditable="true"]', '.tiptap.ProseMirror[contenteditable="true"]', 'textarea[placeholder*="输入"]', 'textarea[placeholder*="问题"]', '[contenteditable="true"][role="textbox"]', 'textarea'],
      send: ['button[aria-label*="发送"]', 'button[aria-label*="Send" i]', 'button[data-testid*="send" i]', 'button[type="submit"]'],
      assistant: ['[data-testid*="assistant" i]', '[data-testid*="message" i] [data-testid*="content" i]', '[data-role="assistant"]', '[class*="assistant" i] [class*="markdown" i]', '[class*="markdown" i]'],
      stop: ['button[aria-label*="停止"]', 'button[aria-label*="Stop" i]'],
      new_chat: ['button[aria-label*="新对话"]', 'button[aria-label*="新建"]', 'a[href*="/chat"]'],
    },
    yuanbao: {
      // Yuanbao currently uses a Quill editor without role="textbox" and an
      // anchor send control. Keep the stable ids/classes first so the login
      // form's phone/code inputs and hidden editor mirror are never selected.
      input: ['.ql-editor[contenteditable="true"]', '#searchbar-editor[contenteditable="true"]', 'div[data-placeholder*="登录后输入"]', 'textarea[placeholder*="输入"]', 'textarea[placeholder*="问题"]', '[contenteditable="true"][role="textbox"]', 'textarea'],
      send: ['#yuanbao-send-btn', 'a[aria-label="Send"]', 'a[aria-label="发送"]', 'button[aria-label*="发送"]', 'button[aria-label*="Send" i]', 'button[data-testid*="send" i]', 'button[type="submit"]'],
      // Current Yuanbao conversation turns use human/ai bubbles instead of
      // generic role/test-id markers. Prefer the speech node to avoid
      // duplicating the enclosing AI bubble in the captured answer.
      user: ['.agent-chat__conv--human', '.agent-chat__conv--human__text-wrap--collapsed'],
      assistant: ['.agent-chat__conv--ai__speech_show', '.agent-chat__bubble--ai', '[data-testid*="assistant" i]', '[data-testid*="message" i] [data-testid*="content" i]', '[data-role="assistant"]', '[class*="assistant" i] [class*="markdown" i]', '[class*="markdown" i]'],
      stop: ['button[aria-label*="停止"]', 'button[aria-label*="Stop" i]'],
      new_chat: ['button[aria-label*="新对话"]', 'button[aria-label*="新建"]', 'a[href*="/chat"]'],
    },
    mimo: {
      input: ['textarea[placeholder*="Ask me anything" i]', 'textarea[placeholder*="输入"]', 'textarea[placeholder*="message" i]', '[contenteditable="true"][role="textbox"]', 'textarea'],
      send: ['button[data-track-name="chat_send"]', 'button[aria-label*="Send message" i]', 'button[aria-label*="发送"]', 'button[aria-label*="Send" i]', 'button[data-testid*="send" i]', 'button[type="submit"]'],
      assistant: ['[data-testid*="assistant" i]', '[data-testid*="message" i] [data-testid*="content" i]', '[data-role="assistant"]', '[class*="assistant" i] [class*="markdown" i]', '[class*="markdown" i]'],
      stop: ['button[aria-label*="停止"]', 'button[aria-label*="Stop" i]'],
      new_chat: ['button[aria-label*="新对话"]', 'button[aria-label*="新建"]', 'a[href*="/chat"]'],
    },
    baidu: {
      input: ['textarea[placeholder*="输入"]', 'textarea[placeholder*="问题"]', '[contenteditable="true"][role="textbox"]', 'textarea'],
      send: ['button[aria-label*="发送"]', 'button[aria-label*="Send" i]', 'button[data-testid*="send" i]', 'button[type="submit"]'],
      assistant: ['[data-testid*="assistant" i]', '[data-testid*="message" i] [data-testid*="content" i]', '[data-role="assistant"]', '[class*="assistant" i] [class*="markdown" i]', '[class*="markdown" i]'],
      stop: ['button[aria-label*="停止"]', 'button[aria-label*="Stop" i]'],
      new_chat: ['button[aria-label*="新对话"]', 'button[aria-label*="新建"]', 'a[href*="/chat"]'],
    },
    spark: {
      input: ['textarea[placeholder*="输入"]', 'textarea[placeholder*="问题"]', '[contenteditable="true"][role="textbox"]', 'textarea'],
      send: ['button[aria-label*="发送"]', 'button[aria-label*="Send" i]', 'button[data-testid*="send" i]', 'button[type="submit"]'],
      assistant: ['[data-testid*="assistant" i]', '[data-testid*="message" i] [data-testid*="content" i]', '[data-role="assistant"]', '[class*="assistant" i] [class*="markdown" i]', '[class*="markdown" i]'],
      stop: ['button[aria-label*="停止"]', 'button[aria-label*="Stop" i]'],
      new_chat: ['button[aria-label*="新对话"]', 'button[aria-label*="新建"]', 'a[href*="/chat"]'],
    },
    stepfun: {
      input: ['textarea[placeholder*="输入"]', 'textarea[placeholder*="message" i]', 'textarea[placeholder*="What do you want to know" i]', '[contenteditable="true"][role="textbox"]', 'textarea'],
      send: ['button[aria-label*="发送"]', 'button[aria-label*="Send" i]', 'button[data-testid*="send" i]', 'button[type="submit"]'],
      assistant: ['[data-testid*="assistant" i]', '[data-testid*="message" i] [data-testid*="content" i]', '[data-role="assistant"]', '[class*="assistant" i] [class*="markdown" i]', '[class*="markdown" i]'],
      stop: ['button[aria-label*="停止"]', 'button[aria-label*="Stop" i]'],
      new_chat: ['button[aria-label*="新对话"]', 'button[aria-label*="新建"]', 'a[href*="/chats"]'],
    },
    kimi: {
      input: ['textarea[data-testid="chat-input"]', '[data-testid="chat-input"][contenteditable="true"]', '.chat-input-editor[contenteditable="true"]', 'textarea[placeholder*="输入"]', '[contenteditable="true"][role="textbox"]'],
      // Kimi currently renders the send affordance as a clickable div
      // (.send-button-container), not a button element.
      send: ['.send-button-container', 'button[data-testid="send-button"]', 'button.send-button', 'button[aria-label="发送消息"]', 'button[aria-label="发送"]', 'button[aria-label="Send message"]'],
      // Kimi's current conversation view wraps user turns in .segment-user;
      // older builds used chat-content-item-user and message-role markers.
      user: ['.segment-user .user-content__text', '.chat-content-item-user .user-content__text', '[data-testid="user-message"]', '[data-message-author-role="user"]', '[data-role="user"]', '.message-item.user'],
      assistant: ['.chat-content-item-assistant', '[data-testid="assistant-message"]', '[data-message-author-role="assistant"]', '[data-role="assistant"]', '.message-item.assistant'],
      stop: ['button[data-testid="stop-button"]', 'button[aria-label="停止生成"]', 'button[aria-label="停止回答"]', 'button[aria-label="Stop generating"]'],
      new_chat: ['button[data-testid="new-chat-button"]', 'a[data-testid="new-chat-button"]', 'button[aria-label="新建会话"]', 'button[aria-label="新建对话"]'],
      error: ['[data-testid="generation-error"]', '[data-testid="response-error"]', '.kimi-message-error', '.chat-content-item-assistant .error-message'],
      retry: ['button[data-testid="retry-button"]', 'button[data-testid="regenerate-button"]', 'button[aria-label="重试"]', 'button[aria-label="重新生成"]'],
    },
    grok: {
      input: ['[data-testid="grokInput"]', 'div.ProseMirror[contenteditable="true"][role="textbox"]', '[contenteditable="true"][role="textbox"]', 'textarea[placeholder*="Ask" i]'],
      // Grok has used English, Chinese and test-id labels across recent UI revisions.
      send: ['[data-testid="grokSendButton"]', '[data-testid="grok-send-button"]', '[data-testid="grokSend"]', 'button[aria-label="Submit"]', 'button[aria-label="提交"]', 'button[aria-label="Send"]', 'button[aria-label="Send message"]', 'button[type="submit"]'],
      assistant: ['[data-testid="grokResponse"]', '[data-testid="grokResponseText"]', '[data-testid="assistant-message"]', '[data-role="assistant"]'],
      stop: ['button[aria-label="Stop"]', 'button[aria-label="Stop generating"]', 'button[aria-label="停止"]', 'button[aria-label="停止生成"]'],
    },
  }[provider] || {};
  let invalidSelectors = 0;
  const query = (root, selector) => {
    try { return Array.from(root.querySelectorAll(selector)); }
    catch { invalidSelectors++; return []; }
  };
  // Some providers keep a zero-width mirror textarea in the DOM next to the
  // real editor. getClientRects() is still non-empty for that mirror, so also
  // require a positive rendered box before treating a control as usable.
  const visible = node => {
    if (!node || !node.getClientRects().length || node.closest('[hidden],[aria-hidden="true"]')) return false;
    const style = getComputedStyle(node), rect = node.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  };
  const enabled = node => !node.disabled && !node.matches(':disabled') && !node.closest('[aria-disabled="true"],[data-disabled="true"],[inert]');
  const accessibleLabel = node => {
    const labelledBy = (node.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)
      .map(id => document.getElementById(id)?.textContent || '').join(' ');
    return String(node.getAttribute('aria-label') || labelledBy || node.getAttribute('title') || node.getAttribute('data-tooltip') || node.textContent || '')
      .replace(/\s+/g, ' ').trim().slice(0, 200);
  };
  const nodeIdentity = node => node ? { tag: node.tagName, id: String(node.id || '').slice(0, 200),
    role: node.getAttribute('role'), label: accessibleLabel(node) } : null;
  const pageState = () => ({ visibilityState: document.visibilityState, hidden: document.hidden,
    hasFocus: document.hasFocus(), activeElement: nodeIdentity(document.activeElement),
    viewport: { width: innerWidth, height: innerHeight } });
  const describeControl = (node, selector, source) => {
    const rect = node.getBoundingClientRect();
    const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
    const inViewport = rect.width > 0 && rect.height > 0 && x >= 0 && y >= 0 && x < innerWidth && y < innerHeight;
    const hit = inViewport && typeof document.elementFromPoint === 'function' ? document.elementFromPoint(x, y) : null;
    return { ...nodeIdentity(node), selector, source, className: String(node.className || '').slice(0, 250),
      visible: visible(node), disabled: !enabled(node) || Boolean(provider === 'qwen' && node.closest('.disabled,.is-disabled,.ant-btn-disabled')),
      ariaDisabled: node.getAttribute('aria-disabled'), pointerEvents: getComputedStyle(node).pointerEvents,
      bounds: { x: rect.left, y: rect.top, width: rect.width, height: rect.height }, inViewport,
      hitTestAvailable: typeof document.elementFromPoint === 'function',
      obscured: typeof document.elementFromPoint === 'function' ? !hit || !(hit === node || node.contains(hit)) : null,
      hitTarget: nodeIdentity(hit) };
  };
  const selectorsFor = key => {
    const choices = [
    ...(args.selectors[key] || []).map(selector => ({ selector, source: 'configured' })),
    ...(defaults[key] || []).filter(selector => !(args.selectors[key] || []).includes(selector)).map(selector => ({ selector, source: 'provider' })),
    ];
    if (['qwen', 'chatgpt', 'glm', 'kimi'].includes(provider) && key === 'input') {
      // A generic textarea in old settings must not hide the identified composer.
      const generic = new Set(['textarea', '[contenteditable="true"][role="textbox"]', "div[contenteditable='true'][role='textbox']", ...(provider === 'chatgpt' ? ['textarea[data-id="root"]', "textarea[data-id='root']"] : [])]);
      return [...choices.filter(item => !generic.has(item.selector)), ...choices.filter(item => generic.has(item.selector))];
    }
    return choices;
  };
  const glmEditor = node => !node.readOnly && node.getAttribute('aria-readonly') !== 'true' &&
    !node.closest('[role="dialog"],[role="search"],.user-message,.assistant-message,.chatglm-message.user,.chatglm-message.assistant,.message-item.user,.message-item.assistant,[data-role="assistant"],[data-role="user"],[data-message-author-role],[data-message-role],[data-testid="user-message"],[data-testid="assistant-message"],pre,code') &&
    !/search|搜索|feedback|反馈/i.test(`${node.getAttribute('placeholder') || ''} ${node.getAttribute('data-placeholder') || ''} ${node.getAttribute('aria-label') || ''} ${node.getAttribute('title') || ''}`);
  const find = (key, requireEnabled = false) => {
    for (const { selector, source } of selectorsFor(key)) {
      let matches = query(document, selector);
      if (key === 'input' && provider === 'glm') {
        matches = matches.filter(node => glmEditor(node) && visible(node) && (!requireEnabled || enabled(node)) &&
          node.matches('textarea,input:not([type]),input[type="text"],[contenteditable="true"]'));
        // Two independent matching composers are ambiguous, even with a named
        // placeholder. Do not let a later generic selector choose the first.
        matches = matches.filter(node => !matches.some(other => other !== node && other.contains(node)));
        if (matches.length > 1) return null;
      }
      for (const node of matches) {
        if (key === 'input' && ['qwen', 'glm', 'chatgpt', 'kimi'].includes(provider) &&
            (!node.matches('textarea,input:not([type]),input[type="text"],[contenteditable="true"]') ||
             node.closest('[role="dialog"],[role="search"],.user-message,.assistant-message,[data-role="assistant"],[data-role="user"],[data-message-author-role],pre,code'))) continue;
        if (visible(node) && (!requireEnabled || enabled(node))) return { node, source, selector };
      }
    }
    if (key === 'input' && provider === 'glm') {
      // Last resort: exactly one enabled, visible plain editor associated with
      // a positively identified send control. Never pick login/search/feedback.
      const candidates = query(document, 'textarea,[contenteditable="true"]').filter(node =>
        visible(node) && glmEditor(node) && (!requireEnabled || enabled(node)) &&
        Boolean(sendControl(node)));
      if (candidates.length === 1) return { node: candidates[0], source: 'semantic', selector: 'textarea,[contenteditable="true"]' };
    }
    return null;
  };
  const canonicalInput = text => String(text || '').replace(/\r\n?/g, '\n');
  const readValue = node => {
    if (!node) return '';
    if ('value' in node) return canonicalInput(node.value);
    // ProseMirror's paragraph blocks are editor line breaks. innerText adds
    // visual paragraph spacing (often two newlines), while textContent removes
    // every break. Neither is the native edit's literal text. Limit this reader
    // to the recognized editor and plain paragraphs/inline content; unknown rich
    // structures keep the conservative existing comparison.
    // Tiptap editors expose each paragraph as a separate <p>. Reading
    // innerText adds layout-dependent blank lines (Doubao currently inserts
    // several visual gaps around the conversation wrapper), so reconstruct the
    // native text from paragraph nodes before the exact-send check.
    if (['chatgpt', 'glm', 'qwen', 'doubao', 'yuanbao'].includes(provider) && node.matches('.ProseMirror[contenteditable="true"],.tiptap[contenteditable="true"],.ql-editor[contenteditable="true"],#prompt-textarea[contenteditable="true"],#chat-input[contenteditable="true"]')) {
      const children = [...node.childNodes].filter(child => child.nodeType !== Node.COMMENT_NODE);
      const paragraphs = children.filter(child => child.nodeType === Node.ELEMENT_NODE && child.tagName === 'P');
      if (paragraphs.length && children.every(child => paragraphs.includes(child) || child.nodeType === Node.TEXT_NODE && !child.textContent.trim()) &&
          !node.querySelector('p div,p p,ul,ol,table,pre,[contenteditable="false"],img')) {
        const inline = current => {
          if (current.nodeType === Node.TEXT_NODE) return current.nodeValue || '';
          if (current.nodeType !== Node.ELEMENT_NODE) return '';
          if (current.tagName === 'BR') return current.classList.contains('ProseMirror-trailingBreak') ? '' : '\n';
          return [...current.childNodes].map(inline).join('');
        };
        return canonicalInput(paragraphs.map(p => p.childNodes.length === 1 && p.firstChild.nodeName === 'BR' ? '' : inline(p)).join('\n'));
      }
    }
    // Grok currently uses a generic contenteditable textbox whose rendered
    // innerText adds extra line breaks around nested block elements. Read the
    // editor structure instead, so the send gate compares the text entered by
    // CDP rather than layout-dependent spacing from the rendered page.
    if (provider === 'grok' && node.matches('[contenteditable="true"]')) {
      const blockTags = new Set(['ADDRESS', 'ARTICLE', 'BLOCKQUOTE', 'DIV', 'DL', 'DT', 'DD',
        'FIGCAPTION', 'FIGURE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'LI', 'P',
        'SECTION', 'TD', 'TH', 'TR']);
      const render = current => {
        if (current.nodeType === Node.TEXT_NODE) return current.nodeValue || '';
        if (current.nodeType !== Node.ELEMENT_NODE) return '';
        if (current.tagName === 'BR') return '\n';
        let value = '';
        for (const child of current.childNodes) {
          const part = render(child);
          if (!part) continue;
          value += part;
          if (child.nodeType === Node.ELEMENT_NODE && blockTags.has(child.tagName) && !value.endsWith('\n')) value += '\n';
        }
        return value;
      };
      return canonicalInput(render(node)).replace(/\n[ \t]+\n/g, '\n\n').trim();
    }
    return canonicalInput(node.innerText || node.textContent);
  };
  const expectedInput = canonicalInput(args.prompt).trim();
  const normalized = text => String(text || '').replace(/\s+/g, ' ').trim();
  // Doubao renders long prompts as Markdown before painting the user bubble:
  // list markers/backticks, escaped quotes and some punctuation spacing can be
  // normalized by the renderer. Keep the exact comparison for ordinary turns;
  // for long Doubao turns require a bounded length plus matching head/tail
  // fingerprints, while the input editor and conversation route remain strict.
  const doubaoComparable = text => normalized(text)
    .replace(/\\(["'`])/g, '$1')
    .replace(/[`*_~]/g, '')
    .replace(/(^| )(?:[-*+]|\d+\.) /g, '$1')
    .replace(/\s*([,.;:!?，。！？：；、])\s*/g, '$1');
  const promptMatches = (actual, expected) => {
    const current = normalized(actual), target = normalized(expected);
    if (current === target) return true;
    if (provider !== 'doubao' || target.length < 512) return false;
    const currentComparable = doubaoComparable(current), targetComparable = doubaoComparable(target);
    if (currentComparable === targetComparable) return true;
    const minLength = Math.max(256, Math.floor(targetComparable.length * 0.6));
    const maxLength = targetComparable.length + Math.max(512, Math.floor(targetComparable.length * 0.12));
    if (currentComparable.length < minLength || currentComparable.length > maxLength) return false;
    const headLength = Math.min(256, targetComparable.length);
    const tailLength = Math.min(128, targetComparable.length);
    return currentComparable.slice(0, headLength) === targetComparable.slice(0, headLength) &&
      currentComparable.slice(-tailLength) === targetComparable.slice(-tailLength);
  };
  const userSelector = [...(args.selectors.user || []), '[data-message-author-role="user"]', '[data-message-role="user"]', '[data-role="user"]', '[data-testid="user-message"]', '.chat-user', '.user-message', '[id^="user-message-"]', ...(defaults.user || [])].join(',');
  const assistantSelector = [...(args.selectors.assistant || []), '[data-message-author-role="assistant"]', '[data-message-role="assistant"]', '[data-role="assistant"]', '[data-testid="assistant-message"]', '.chat-assistant', '.assistant-message', '[id^="response-message-"]', ...(defaults.assistant || [])].join(',');
  const thinkingSelector = '[data-role="reasoning"],[data-role="thinking"],[data-testid*="thinking"],[data-testid*="reasoning"],.ds-think-content,.qwen-thinking,.qwen-thinking-content,.chatglm-thinking,.kimi-thinking,.thinking-content,.think-content,.reasoning-content,.reasoning,.thinking';
  const noiseSelector = 'script,style,button,svg,noscript,iframe,input,textarea,[role="button"],[role="toolbar"],[aria-hidden="true"],[hidden],.message-actions,.message-toolbar,.code-toolbar,.code-header';
  const outermost = nodes => [...new Set(nodes)].filter(node => !nodes.some(other => other !== node && other.contains(node)));
  const documentOrder = nodes => nodes.sort((a, b) => a === b ? 0 : a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
  const allowedAnswer = node => visible(node) && !node.closest(userSelector) && !node.closest(thinkingSelector);
  const clean = node => {
    const clone = node.cloneNode(true);
    // Ignore only explicit hiding, not zero-size boxes: display:contents wrappers
    // and structural table/code elements can have visible descendants without a box.
    const originals = node.querySelectorAll('*');
    const copied = clone.querySelectorAll('*');
    originals.forEach((original, index) => {
      const style = getComputedStyle(original);
      if (original.closest('[hidden],[aria-hidden="true"]') || style.display === 'none' || style.visibility === 'hidden') copied[index]?.remove();
    });
    clone.querySelectorAll(`${noiseSelector},${thinkingSelector},${userSelector}`).forEach(n => n.remove());
    clone.querySelectorAll('pre').forEach(pre => {
      const code = pre.querySelector('code');
      if (code) {
        const replacement = document.createElement('pre');
        if (pre.hasAttribute('class')) replacement.setAttribute('class', pre.getAttribute('class'));
        replacement.append(code.cloneNode(true));
        pre.replaceWith(replacement);
      }
    });
    clone.querySelectorAll('a').forEach(a => {
      try {
        const url = new URL(a.getAttribute('href') || '', location.href);
        if (['https:', 'http:', 'mailto:'].includes(url.protocol)) a.setAttribute('href', url.href);
        else a.removeAttribute('href');
      } catch { a.removeAttribute('href'); }
    });
    for (const n of [clone, ...clone.querySelectorAll('*')]) {
      for (const attr of Array.from(n.attributes)) {
        if (!['href','src','alt','title','class','colspan','rowspan','start','checked','type'].includes(attr.name)) n.removeAttribute(attr.name);
      }
    }
    return clone;
  };
  const plainReplyText = root => {
    // textContent keeps autolink labels intact but loses line breaks between
    // Markdown paragraphs. Walk the already-cleaned clone instead of using
    // innerText, whose result depends on layout/visibility of a detached node.
    const blockTags = new Set(['ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DIV', 'DL', 'DT',
      'FIGCAPTION', 'FIGURE', 'FOOTER', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR',
      'LI', 'MAIN', 'NAV', 'OL', 'P', 'SECTION', 'TABLE', 'TBODY', 'TD', 'TH', 'THEAD', 'TR', 'UL']);
    const read = node => {
      if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || '';
      if (node.nodeType !== Node.ELEMENT_NODE) return '';
      if (node.tagName === 'BR') return '\n';
      if (node.tagName === 'PRE') return `\n${node.textContent}\n`;
      const text = Array.from(node.childNodes, read).join('');
      return blockTags.has(node.tagName) ? `\n${text}\n` : text;
    };
    return read(root).trim();
  };
  const isLosslessJSONText = root => {
    // These elements have Markdown meaning that textContent would silently
    // discard inside a JSON string (including a shell command or file path).
    // PRE content is literal code; syntax styling inside it is not Markdown.
    const semantic = 'em,strong,b,i,s,strike,del,ins,mark,code,kbd,samp,sub,sup,blockquote,ul,ol,li,table,h1,h2,h3,h4,h5,h6,img,hr';
    const formatted = [...(root.matches(semantic) ? [root] : []), ...root.querySelectorAll(semantic)];
    if (formatted.some(node => !node.closest('pre'))) return false;
    const links = [...(root.matches('a') ? [root] : []), ...root.querySelectorAll('a')];
    return links.every(link => {
      if (link.closest('pre')) return true;
      // Browser autolinks may normalize a trailing slash. Preserve the actual
      // visible URL string; named links must keep their Markdown representation.
      try {
        const label = link.textContent;
        if (label !== label.trim()) return false;
        const source = new URL(label);
        const target = new URL(link.getAttribute('href'));
        return ['http:', 'https:'].includes(source.protocol) && source.href === target.href;
      } catch { return false; }
    });
  };
  const composerScope = input => ['qwen', 'chatgpt', 'glm', 'kimi'].includes(provider) ? input?.closest('form') || document : document;
  const actionConflict = node => {
    if (provider !== 'chatgpt') return false;
    const identity = `${accessibleLabel(node)} ${node.getAttribute('data-testid') || ''}`.toLowerCase();
    return /\b(?:voice|speech|dictat\w*|microphone|record\w*|stop|cancel|delete)\b|语音|听写|录音|麦克风|停止|取消|删除/.test(identity);
  };
  const sendControl = input => {
    const scope = composerScope(input);
    const controls = new Set();
    const available = node => enabled(node) && !(provider === 'qwen' && node.closest('.disabled,.is-disabled,.ant-btn-disabled'));
    // Do not let a disabled duplicate mask an enabled match for the same selector.
    // Keep configured selector priority: a recognized disabled control never
    // falls back to Enter or to a differently named action.
    for (const { selector, source } of selectorsFor('send')) {
      const matches = query(scope, selector).map(node => node.closest('button,[role="button"]') || node)
        .filter(node => scope.contains(node) && visible(node) &&
          !node.closest('[role="dialog"],[role="search"],.user-message,.assistant-message,[data-role="assistant"],[data-role="user"],[data-message-author-role],pre,code'));
      if (matches.length) {
        const eligible = matches.filter(node => !actionConflict(node));
        const node = eligible.find(available) || eligible[0] || matches[0];
        return { node, source, selector, isEnabled: available(node), actionConflict: actionConflict(node), candidateCount: matches.length };
      }
    }
    // Semantic fallback is limited to a named send control. Never click an arbitrary
    // submit button elsewhere on a login page or guess from an SVG shape.
    const candidates = query(input.closest('form') || document, 'button,[role="button"]');
    for (const node of candidates) {
      if (!visible(node) || node.closest('[role="dialog"],[role="search"],.user-message,.assistant-message,[data-role="assistant"],[data-role="user"],[data-message-author-role],pre,code')) continue;
      const label = accessibleLabel(node).toLowerCase()
        .replace(/\s*[(（]\s*(?:(?:ctrl|control|cmd|command|⌘|⌃)\s*[+＋]\s*)?(?:enter|return|↵|⏎|回车)\s*[)）]\s*$/, '').trim();
      if (/^(send(?: (?:message|prompt))?|submit(?: (?:message|prompt))?|发送(?:消息|提示)?|提交(?:消息|提示)?)$/.test(label)) controls.add(node);
    }
    if (controls.size) {
      const nodes = [...controls], node = nodes.find(available) || nodes[0];
      return { node, source: 'semantic', selector: 'accessible-send-name', isEnabled: available(node), candidateCount: nodes.length };
    }
    return null;
  };
  const candidateReport = (input, send) => {
    // Record bounded evidence for every configured/provider selector, including
    // hidden/disabled matches, without guessing an action from an SVG icon.
    const candidateNodes = new Set();
    const scope = composerScope(input);
    const selectorChecks = selectorsFor('send').map(({ selector, source }) => {
      const matches = query(scope, selector).map(node => node.closest('button,[role="button"]') || node)
        .filter(node => scope.contains(node));
      return { selector, source, matches: matches.length, candidates: matches.filter(node => {
        if (candidateNodes.has(node) || candidateNodes.size >= 12) return false;
        candidateNodes.add(node); return true;
      }).map(node => describeControl(node, selector, source)) };
    });
    const unmatchedControls = !send ? query(input?.closest('form') || document, 'button,[role="button"]')
      .filter(visible).slice(-12).map(node => describeControl(node, null, 'unmatched')) : [];
    return { selectorChecks, unmatchedControls };

  };
  const verificationState = () => {
    if (provider !== 'glm') return { required: false };
    const selector = '[data-testid="captcha"],[data-testid="verification-challenge"],.geetest_panel,.geetest_holder,.geetest_panel_box,.nc-container,.nc_wrapper,.yidun_popup,.yidun_panel,.yidun_slider,.tc-captcha,#tcaptcha_transform_dy,[role="dialog"],iframe[src*="captcha" i],iframe[title*="captcha" i],iframe[title*="verification" i]';
    const words = /(?:拖动|滑动).{0,25}(?:滑块|拼图|验证|完成)|请完成.{0,15}验证|安全验证|人机验证|验证码|slide.{0,25}(?:verify|verification)|drag.{0,25}(?:slider|puzzle)|verify (?:that )?you are human|complete.{0,15}captcha/i;
    const passed = /验证(?:成功|通过)|verification (?:successful|passed)|verified successfully/i;
    for (const node of query(document, selector)) {
      if (!visible(node) || node.closest(`${assistantSelector},${userSelector},${thinkingSelector},pre,code,textarea,[contenteditable="true"]`)) continue;
      const label = String(node.textContent || '').slice(0, 2000);
      if (passed.test(label)) continue;
      const explicit = node.matches('[data-testid="captcha"],[data-testid="verification-challenge"],iframe[src*="captcha" i],iframe[title*="captcha" i],iframe[title*="verification" i]');
      const widget = !node.matches('[role="dialog"]') && query(node, 'canvas,[role="slider"],.geetest_slider_button,.nc_iconfont.btn_slide,.yidun_slider').some(visible);
      if (!explicit && !widget && !words.test(label)) continue;
      return { required: true, kind: /滑|拖|slider|slide|drag|puzzle/i.test(label) || widget ? 'slider' : 'verification',
        source: node.tagName === 'IFRAME' ? 'visible_verification_frame' : 'visible_verification_widget' };
    }
    return { required: false };
  };
  const snapshot = () => {
    let nodes = [], assistantSource = 'none';
    for (const { selector, source } of selectorsFor('assistant')) {
      const matches = query(document, selector).filter(allowedAnswer);
      if (matches.length) { nodes = matches; assistantSource = source; break; }
    }
    if (provider === 'qwen') {
      // Legacy selectors often match individual markdown fragments. Promote them to
      // their author-owned turn, then add recognized turns so old markup cannot mask
      // a newer answer using a different wrapper.
      nodes = nodes.map(node => node.closest(assistantSelector) || node);
      const identified = query(document, assistantSelector).filter(allowedAnswer);
      if (identified.length) { nodes.push(...identified); assistantSource = nodes.length > identified.length ? `${assistantSource}+provider` : 'provider'; }
    }
    nodes = documentOrder(outermost(nodes)).filter(allowedAnswer);
    let blocks = 0, codeBlocks = 0, tables = 0;
    const answers = nodes.map(node => {
      // Preserve the complete author-owned turn, including sibling markdown pieces.
      const clone = clean(node);
      blocks += clone.querySelectorAll('.qwen-markdown,.markdown,.markdown-body').length;
      codeBlocks += clone.querySelectorAll('pre').length + (clone.matches('pre') ? 1 : 0);
      tables += clone.querySelectorAll('table').length + (clone.matches('table') ? 1 : 0);
      const preNodes = [...(clone.matches('pre') ? [clone] : []), ...clone.querySelectorAll('pre')];
      const codeLanguages = preNodes.map(pre => {
        const code = pre.querySelector('code') || pre;
        const classes = `${code.getAttribute('class') || ''} ${pre.getAttribute('class') || ''}`;
        return (classes.match(/(?:language|lang)-([a-z0-9_+.-]+)/i)?.[1] || '').toLowerCase();
      });
      return { html: clone.outerHTML, text: clone.textContent.trim(), rawText: plainReplyText(clone), codeLanguages,
        jsonTextSafe: isLosslessJSONText(clone) };
    });
    const input = find('input', true);
    const users = documentOrder(outermost(query(document, userSelector).filter(visible)));
    const latest = nodes.at(-1);
    const generating = latest && (latest.matches('[aria-busy="true"],[data-state="streaming"],[data-status="generating"]') || latest.querySelector('[aria-busy="true"],[data-state="streaming"],[data-status="generating"]'));
    const stopping = Boolean(find('stop') || generating);
  return {
      page: pageState(), verification: verificationState(), answers, stopping, inputReady: Boolean(input), inputEmpty: input ? !readValue(input.node).trim() : false,
      userCount: users.length, lastUserMatchesPrompt: Boolean(users.length && promptMatches(recoveryUserSignature(users.at(-1)), expectedInput)),
      summary: { assistantSource, inputSource: input?.source || 'none', turns: nodes.length, blocks, codeBlocks, tables, invalidSelectors, latestTextLength: answers.at(-1)?.text.length || 0, stopping, visibilityState: document.visibilityState, pageHasFocus: document.hasFocus() },
    };
  };
  const assistantNodes = () => {
    let nodes = [];
    for (const { selector } of selectorsFor('assistant')) {
      const matches = query(document, selector).filter(allowedAnswer);
      if (matches.length) { nodes = matches; break; }
    }
    if (provider === 'qwen') nodes = nodes.map(node => node.closest(assistantSelector) || node);
    const identified = query(document, assistantSelector).filter(allowedAnswer);
    if (identified.length) nodes.push(...identified);
    return documentOrder(outermost(nodes)).filter(allowedAnswer);
  };
  const latestAssistant = () => assistantNodes().at(-1) || null;
  const jsonDOMPayload = () => {
    const node = latestAssistant();
    if (!node) return { ready: false, reason: 'assistant_missing', candidates: [] };
    const clone = clean(node);
    const candidates = [plainReplyText(clone), clone.textContent?.trim() || ''];
    for (const pre of [...(clone.matches('pre') ? [clone] : []), ...clone.querySelectorAll('pre')]) {
      candidates.push(pre.querySelector('code')?.textContent?.trim() || pre.textContent?.trim() || '');
    }
    const unique = [...new Set(candidates.filter(text => typeof text === 'string' && text.trim()))]
      .map(text => text.slice(0, 2_000_000));
    return { ready: unique.length > 0, candidates: unique, html: clone.outerHTML.slice(0, 4_000_000),
      signature: String(clone.textContent || '').slice(0, 256) };
  };
  const copyMarkdownTarget = () => {
    const answer = latestAssistant();
    if (!answer) return { ready: false, reason: 'assistant_missing' };
    let controls = query(answer, 'button,[role="button"]')
      .filter(node => visible(node) && enabled(node) && !node.closest('pre,code'));
    // Some Qwen revisions place the action footer beside the marked answer
    // node, inside one message wrapper. Inspect at most that immediate parent,
    // and only when it contains no other recognized turn/user, so an unrelated
    // sidebar or older answer cannot provide a copy target.
    if (!controls.length && answer.parentElement &&
        !answer.parentElement.closest(`${userSelector},${thinkingSelector}`) &&
        query(answer.parentElement, assistantSelector).filter(allowedAnswer).length <= 1) {
      controls = query(answer.parentElement, 'button,[role="button"]')
        .filter(node => visible(node) && enabled(node) && !node.closest('pre,code'));
    }
    const copyName = /(?:copy|clipboard|markdown|\bmd\b|复制|拷贝)/i;
    const rejectName = /(?:delete|remove|share|report|like|dislike|删除|分享|举报|点赞|点踩)/i;
    const candidates = controls.filter(node => {
      const identity = `${accessibleLabel(node)} ${node.getAttribute('title') || ''} ${node.getAttribute('data-testid') || ''} ${String(node.className || '')}`;
      return copyName.test(identity) && !rejectName.test(identity);
    });
    const node = candidates[0];
    if (!node) return { ready: false, reason: 'copy_control_missing' };
    node.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    const target = describeControl(node, 'answer-copy-markdown', 'semantic');
    // A few embedded Chromium revisions do not expose elementFromPoint in the
    // isolated world.  The target is still safe when it is a visible, enabled
    // semantic copy control inside the latest assistant; reject only a proven
    // obstruction.
    if (!target.visible || target.disabled || !target.inViewport || target.obscured)
      return { ready: false, reason: 'copy_control_not_clickable', target };
    return { ready: true, method: 'button', x: target.bounds.x + target.bounds.width / 2,
      y: target.bounds.y + target.bounds.height / 2, target, answer_signature: String(answer.textContent || '').slice(0, 256) };
  };
  const preservedSession = () => {
    const current = snapshot();
    const composer = find('input');
    const usable = node => visible(node) && !node.closest(`${assistantSelector},${userSelector},${thinkingSelector}`);
    const controlNodes = query(document, 'button,[role="button"],a[href]');
    const newChatName = /^(?:new (?:chat|conversation)|start (?:a )?new (?:chat|conversation)|新建(?:聊天|对话)|开启新对话|开始新对话|新对话)(?:\s*[（(].*[)）])?$/i;
    const semantic = controlNodes.filter(node => usable(node) && newChatName.test(accessibleLabel(node)));
    let newChat = semantic.find(enabled) || semantic[0], newChatSelector = 'accessible-new-chat-name', newChatSource = 'semantic';
    if (!newChat) {
      for (const { selector, source } of selectorsFor('new_chat')) {
        const candidates = query(document, selector).map(node => node.closest('button,[role="button"],a[href]') || node).filter(usable);
        newChat = candidates.find(enabled) || candidates[0];
        if (newChat) { newChatSelector = selector; newChatSource = source; break; }
      }
    }
    const modelSelectors = ['[data-testid="model-selector"]', '[data-testid="model-select"]', '[data-testid="model-picker"]',
      'button[data-model-id]', 'button[data-model]', '[role="combobox"][aria-label*="model" i]', '[role="combobox"][aria-label*="模型"]',
      '.model-selector button', 'button.model-selector'];
    let model = null;
    if (provider === 'glm') {
      // Read only the selected control, not a model name in a reply or an open
      // menu. In particular, <select>.textContent includes *all* its options.
      const glmSelectors = ['#model-selector', '#model-selector-button', ...modelSelectors,
        'select[aria-label*="model" i]', 'select[aria-label*="模型"]', 'button[aria-haspopup]',
        'button,[role="button"],[role="combobox"]'];
      const readModel = node => {
        if (!usable(node) || node.closest('[role="menu"],[role="listbox"],[role="dialog"],[role="option"],[role^="menuitem"]') ||
            !node.matches('button,select,[role="button"],[role="combobox"]')) return null;
        const values = node.tagName === 'SELECT'
          ? [node.selectedOptions?.[0]?.textContent, node.value]
          : [node.getAttribute('data-model-id'), node.getAttribute('data-model'), node.textContent, accessibleLabel(node)];
        for (const value of values) {
          // A promotional 'Try GLM...' button is not the selected model.
          if (!/^\s*glm[\s_-]*\d/i.test(String(value || ''))) continue;
          const labels = String(value || '').match(/\bglm[\s_-]*\d+(?:\.\d+)*(?:[-_][a-z0-9]+)*(?:\s+(?:flashx?|airx?|plus|max|turbo|thinking|fast|pro)\b)*/gi) || [];
          const keys = [...new Set(labels.map(label => label.toLowerCase().replace(/[\s_]+/g, '-').replace(/^glm-?/, 'glm-')))];
          if (keys.length === 1) return { label: labels[0], key: keys[0] };
          if (keys.length > 1) return null;
        }
        return null;
      };
      for (const selector of glmSelectors) {
        const candidates = query(document, selector).map(readModel).filter(Boolean);
        // Several different visible model controls are not proof of selection.
        if (new Set(candidates.map(candidate => candidate.key)).size > 1) break;
        if (candidates.length) { model = { ...candidates[0], source: selector }; break; }
      }
    } else {
      for (const selector of modelSelectors) {
        const node = query(document, selector).find(usable);
        const label = node && [node.selectedOptions?.[0]?.textContent, node.value, node.textContent, node.getAttribute('data-model-id'), node.getAttribute('data-model'), accessibleLabel(node)]
          .map(value => String(value || '').replace(/\s+/g, ' ').trim().slice(0, 200)).find(value => /qwen[\s\d.\w-]*/i.test(value));
        if (label) { model = { label, source: selector }; break; }
      }
    }
    const ratingSelectors = '[role="dialog"],[aria-modal="true"],[data-testid*="feedback" i],[data-testid*="rating" i],[data-testid*="survey" i],[id*="feedback" i],[id*="rating" i],[id*="survey" i],.feedback-modal,.rating-modal,.rating-panel,.feedback-panel,.feedback-popup,.rating-popup,.survey-modal,.ant-modal-content,.ant-popover-inner-content,[class*="feedback" i],[class*="rating" i],[class*="survey" i]';
    const ratingWords = /\b(?:rating|feedback|survey)\b|\brate (?:this|your|the|our)\b|评分|评价|满意度|反馈/i;
    const closeName = /^(?:close(?: (?:dialog|popup|feedback|survey|rating))?|dismiss(?: (?:dialog|popup|feedback|survey|rating))?|skip(?: (?:for )?now)?|not now|maybe later|later|关闭(?:弹窗|对话框|反馈|评分)?|跳过(?:评价|评分|反馈)?|稍后(?:再说|评价|提醒我)?|暂不(?:评价|评分|反馈)?|以后再说)$/i;
    const panelMatches = node => {
      if (!usable(node) || node === document.body || node === document.documentElement || node.closest(`${assistantSelector},${userSelector}`)) return false;
      // CSS classes are implementation details and Qwen uses names containing
      // "rating" for unrelated model/mode controls (for example the "自动"
      // selector).  Treating a class token as semantic evidence produces a
      // false feedback panel, blocks new-chat preparation, and forces the
      // request into the manual-retry path.  Trust explicit test/id hooks and
      // the panel's visible copy instead; inferred panels still require an
      // explicit dismiss control below.
      const semanticIdentity = `${node.getAttribute('data-testid') || ''} ${node.id || ''}`;
      const heading = query(node, 'h1,h2,h3,[role="heading"]').map(n => n.textContent).join(' ');
      const content = `${heading} ${node.textContent.slice(0, 1500)}`;
      return ratingWords.test(semanticIdentity) || ratingWords.test(content);
    };
    const explicitRatingPanels = provider !== 'qwen' ? [] : outermost(query(document, ratingSelectors).filter(panelMatches));
    // Some Qwen builds render the bottom feedback bar without dialog/rating
    // classes. Infer only a small ancestor of an explicit dismiss control whose
    // visible text identifies feedback; never treat a star/submit control itself
    // as a close target.
    const inferredRatingPanels = provider !== 'qwen' ? [] : query(document, 'button,[role="button"]').filter(control => {
      if (!visible(control) || !enabled(control) || !closeName.test(accessibleLabel(control))) return false;
      for (let parent = control.parentElement, depth = 0; parent && depth++ < 5; parent = parent.parentElement) {
        if (parent !== document.body && parent !== document.documentElement && !parent.closest(`${userSelector},${assistantSelector}`) && panelMatches(parent) && query(parent, 'button,[role="button"]').length <= 12) return true;
      }
      return false;
    }).map(control => {
      for (let parent = control.parentElement, depth = 0; parent && depth++ < 5; parent = parent.parentElement) {
        if (parent !== document.body && !parent.closest(`${userSelector},${assistantSelector}`) && panelMatches(parent) && query(parent, 'button,[role="button"]').length <= 12) return parent;
      }
      return null;
    }).filter(Boolean);
    const panels = [...new Set([...explicitRatingPanels, ...inferredRatingPanels])];
    const rating = panels.slice(0, 6).map(node => {
      const controls = query(node, 'button,[role="button"]');
      const close = controls.find(control => visible(control) && enabled(control) && closeName.test(accessibleLabel(control)));
      return { identity: `${node.tagName}:${node.id}:${node.getAttribute('data-testid') || ''}:${accessibleLabel(node)}`,
        label: accessibleLabel(node), closeTarget: close ? describeControl(close, 'accessible-rating-dismiss-name', 'semantic') : null,
        node, close };
    });
    return { conversation: location.pathname + location.search + location.hash, answers: current.answers.length,
      userCount: current.userCount, inputEmpty: composer ? !readValue(composer.node).trim() : false, inputReady: current.inputReady, inputPresent: Boolean(composer), stopping: current.stopping,
      model, newChat: newChat ? describeControl(newChat, newChatSelector, newChatSource) : null,
      rating: rating.map(({ node, close, ...item }) => item), _newChat: newChat, _rating: rating };
  };
  const publicSession = session => { const { _newChat, _rating, ...result } = session; return result; };
  const recoveryErrorSelector = ['[role="alert"]', '[data-state="error"]', '[data-status="error"]', '[data-testid="message-error"]', '[data-testid="response-error"]', '.message-error', '.error-message', '.response-error', ...(defaults.error || [])].join(',');
  const recoveryUsers = () => {
    // Doubao wraps the actual prompt in a message container that also owns a
    // rendered timestamp. Read the nested message text node so the timestamp
    // cannot make an accepted first turn look like a different conversation.
    if (provider === 'doubao') {
      const body = query(document, '[data-testid="send_message"][data-message-role="user"] [data-testid="message_text_content"]').filter(visible);
      if (body.length) return documentOrder(outermost(body));
    }
    return documentOrder(outermost(query(document, userSelector).filter(visible)));
  };
  const decodeKimiText = value => {
    if (provider !== 'kimi' || !String(value).includes('&')) return value;
    const node = document.createElement('textarea');
    node.innerHTML = value;
    return node.value;
  };
  const recoverySignature = node => normalized(node.textContent);
  const recoveryUserSignature = node => {
    const clone = node.cloneNode(true);
    clone.querySelectorAll('button,[role="button"],script,style,[aria-hidden="true"]').forEach(control => control.remove());
    // Keep paragraph/BR separators when the site renders a multiline prompt.
    // textContent concatenates them and falsely reports a different user turn.
    return normalized(decodeKimiText(plainReplyText(clone)));
  };
  // Keep actual conversation IDs strict, but do not confuse non-routing
  // display/query changes with a different Qwen conversation.
  const recoveryHref = raw => {
    const u = new URL(raw);
    if (provider !== 'qwen') return u.href;
    for (const key of [...u.searchParams.keys()]) {
      if (/^utm_/i.test(key) || ['model', 'ref', 'source', 'lang'].includes(key)) u.searchParams.delete(key);
    }
    if (!/^#\/?(?:c|chat)\//.test(u.hash)) u.hash = '';
    u.pathname = u.pathname.replace(/\/+$/, '') || '/';
    u.searchParams.sort();
    return u.href;
  };
  // The model label is supplied by the site (not hardcoded to a release).
    // Require the complete Qwen connection-error heading as well as a recognized
    // reason. A "retry" icon or quoted generic network prose alone is not enough.
    const qwenFailureKind = message => {
      if (provider !== 'qwen' || !/^oops[!！]?(?:\s|\u00a0)*there was an issue connecting to(?:\s|\u00a0)*qwen[\w.-]*/i.test(message)) return '';
      if (/(?:当前|目前)服务访问量较大\s*[，,]?\s*请稍后再试/.test(message)) return 'busy';
      if (/\b(?:502|503|504)\b|bad gateway|gateway timeout/i.test(message)) return 'network';
      if (/网络(?:连接)?(?:错误|异常|失败|出错)|network(?:\s+connection)?\s+error|failed\s+to\s+fetch|(?:connection|request)\s+(?:failed|timed out)/i.test(message)) return 'network';
      return '';
    };
    const qwenRetryableFailure = message => Boolean(qwenFailureKind(message));
    const failureText = region => {
      const clone = region.cloneNode(true);
      clone.querySelectorAll('button,[role="button"],script,style,svg,[hidden],[aria-hidden="true"]').forEach(node => node.remove());
      return normalized(plainReplyText(clone));
    };

  // Site error widgets sometimes have neither an assistant role nor role=alert.
  // Recognize only a complete short Qwen failure heading, outside prose/code,
  // after the exact latest user turn. This never scans the document for icons.
  const unmarkedQwenFailures = (lastUser = null) => {
    if (provider !== 'qwen' || !document.body) return [];
    const nodes = [], walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let visited = 0;
    for (let text = walker.nextNode(); text && visited++ < 6000; text = walker.nextNode()) {
      if (!/^\s*oops[!！]?/i.test(text.nodeValue || '')) continue;
      let node = text.parentElement, candidate = null;
      if (!node || node.closest(`${userSelector},${thinkingSelector},pre,code,blockquote,table,ul,ol,nav,aside,form,button,[role="button"],[role="dialog"],[aria-modal="true"]`)) continue;
      for (let depth = 0; node && node !== document.body && depth++ < 5; node = node.parentElement) {
        if (!visible(node) || node.querySelector(`${userSelector},input,textarea,[contenteditable="true"],pre,code,blockquote,table,ul,ol`)) break;
        const message = failureText(node);
        if (message.length > 500) break;
        if (qwenRetryableFailure(message)) candidate = node;
        else if (candidate) break;
      }
      if (candidate && (!lastUser || Boolean(lastUser.compareDocumentPosition(candidate) & Node.DOCUMENT_POSITION_FOLLOWING))) nodes.push(candidate);
    }
    return documentOrder(outermost([...new Set(nodes)]));
  };
  const recoveryBaseline = () => {
    const href = recoveryHref(location.href);
    const url = new URL(href);
    const users = recoveryUsers().map(recoveryUserSignature);
    // Yuanbao redirects its configured site root to an agent landing route
    // (/chat/<agent-id>) before the first turn. Treat that empty landing page
    // as a fresh conversation so the server-assigned /chat/<agent>/<turn>
    // route is accepted while the optimistic human bubble is being rendered.
    const yuanbaoLanding = provider === 'yuanbao' && /^\/chat\/[^/]+$/.test(url.pathname);
    const fresh = !users.length && (/^\/(?:chat\/?)?$/.test(url.pathname) || yuanbaoLanding || args.fresh_session_confirmed === true);
    return { href, origin: url.origin, prompt: expectedInput, allowFirstConversation: fresh, boundHref: null, pendingHref: null,
      users,
      errors: new Map([...query(document, `${recoveryErrorSelector},${assistantSelector}`).filter(visible), ...unmarkedQwenFailures()].map(node => [node, recoverySignature(node)])),
      claimed: false, sequence: 0, reservation: null, grokAccepted: false, grokUserNode: null };
  };
  const recoveryState = job => {
    const baseline = job?.recovery;
    const href = recoveryHref(location.href);
    const result = { contextValid: false, contextChanged: false, currentTurnAccepted: false, reason: 'recovery_context_missing', currentError: false,
      retryAvailable: false, retryRevealable: false, recoveryUsed: Boolean(baseline?.claimed), conversation: location.pathname + location.search + location.hash };
    if (!job || job.id !== args.id || job.cancelled || !baseline || !job.submitted) return result;
    const users = recoveryUsers(), input = find('input');
    const lastUser = users.at(-1), userText = users.map(recoveryUserSignature);
    const value = input ? readValue(input.node).trim() : '';
    Object.assign(result, { userCount: users.length, lastUserMatchesPrompt: Boolean(lastUser && promptMatches(userText.at(-1), expectedInput)),
      inputMatchesPrompt: Boolean(input && value === expectedInput), stopping: Boolean(find('stop')) });
    Object.assign(result, { baselineUserCount: baseline.users.length,
      initialConversation: new URL(baseline.href).pathname,
      boundConversation: baseline.boundHref ? new URL(baseline.boundHref).pathname : null,
      awaitingFirstConversation: baseline.allowFirstConversation && !baseline.boundHref });
    // Grok re-renders the first user bubble when it assigns a conversation and
    // may change its internal text nodes while preserving the same DOM node.
    // Once the exact prompt was accepted, keep that node bound to this turn so
    // a presentation-only rewrite cannot become a false context switch.
    const sameGrokAcceptedTurn = provider === 'grok' && baseline.grokAccepted &&
      baseline.users.length === 0 && users.length === 1 &&
      (!value || lastUser === baseline.grokUserNode);
    if (sameGrokAcceptedTurn && !result.lastUserMatchesPrompt) result.lastUserMatchesPrompt = true;
    // Kimi and Doubao repaint the optimistic user bubble after acceptance
    // (wrapping text, adding metadata, or replacing paragraph text) while
    // keeping the same DOM node. Once that exact node was accepted, tolerate
    // presentation-only signature changes; a different node remains a context
    // change and is still rejected below.
    const sameAcceptedWebTurn = ['kimi', 'doubao'].includes(provider) && baseline.acceptedUserNode &&
      baseline.users.length === 0 && users.length === 1 && lastUser === baseline.acceptedUserNode;
    if (sameAcceptedWebTurn && !result.lastUserMatchesPrompt) result.lastUserMatchesPrompt = true;
    const changed = reason => ({ ...result, reason, contextChanged: true });
    if (expectedInput !== baseline.prompt) return changed('recovery_prompt_changed');
    if (location.origin !== baseline.origin) return changed('recovery_origin_changed');
    // Grok creates a server-side conversation after the first user bubble and
    // may briefly replace that route again while the response stream starts.
    // The exact user message, origin and DOM turn checks below still guard the
    // capture; following this initial Grok route avoids treating a normal
    // router transition as a different user conversation.
    const followsGrokInitialConversation = provider === 'grok' && baseline.allowFirstConversation &&
      baseline.users.length === 0 && users.length === baseline.users.length + 1 && result.lastUserMatchesPrompt;
    // Doubao assigns a temporary /chat/local_* route, then replaces it with
    // the server conversation id after the first response request. If the
    // already-accepted user node is unchanged, this same-origin route swap is
    // part of the same turn rather than a different conversation.
    const followsAcceptedWebRoute = provider === 'doubao' && baseline.users.length === 0 &&
      users.length === 1 && result.lastUserMatchesPrompt && href !== baseline.boundHref;
    if (baseline.boundHref && href !== baseline.boundHref && !followsGrokInitialConversation && !followsAcceptedWebRoute) return changed('recovery_conversation_changed');
    if (!baseline.allowFirstConversation && href !== baseline.href) return changed('recovery_conversation_changed');
    // A fresh Qwen conversation can bounce through the launch route, a hash
    // route and the server-assigned conversation route before its optimistic
    // user bubble is painted. Those same-origin transitions are not acceptance
    // evidence, but rejecting the second one here makes a real send failure
    // look like a context switch and prevents the page Retry button from
    // ever being considered. Keep the latest route only as diagnostic state;
    // once the exact user turn appears, line 560 binds the conversation and
    // all subsequent route changes remain fatal.
    if (baseline.allowFirstConversation && !baseline.boundHref && href !== baseline.href) {
      baseline.pendingHref = href;
    }
    if (users.length < baseline.users.length || users.length > baseline.users.length + 1 ||
        baseline.users.some((text, index) => userText[index] !== text)) return changed('recovery_user_history_changed');
    if (users.length === baseline.users.length + 1 && !result.lastUserMatchesPrompt) return changed('recovery_user_changed');
    if (value && !result.inputMatchesPrompt) return changed('recovery_input_changed');
    const errorWords = /\b(?:502|503|504)\b|bad gateway|gateway timeout|something went wrong|an error (?:has )?occurred|network error|server (?:is )?busy|server error|there was an issue connecting to|(?:temporarily|service) unavailable|(?:request|response|generation|connection) (?:has )?(?:failed|timed out)|服务器[^。.!?]{0,30}(?:繁忙|异常|错误|超时|开小差)|(?:服务|系统)(?:繁忙|异常)|服务(?:暂时)?不可用|(?:当前|目前)服务访问量较大|网络(?:连接)?(?:错误|异常|失败|出错)|请求(?:失败|超时)|响应(?:失败|超时)|生成(?:失败|出错)|出错了|出现错误/i;
    const changedAfterBaseline = region => !baseline.errors.has(region) || baseline.errors.get(region) !== recoverySignature(region);
    const accepted = users.length === baseline.users.length + 1 && result.lastUserMatchesPrompt;
    if (!accepted) {
      // Do not let a newly rendered failure card become a stable Markdown
      // answer merely because this site revision did not expose a user-turn
      // wrapper. It remains unbound and therefore cannot authorize a click.
      const explicitFailure = query(document, recoveryErrorSelector).some(region => {
        if (!visible(region) || !changedAfterBaseline(region) || region.closest(`${userSelector},${thinkingSelector},pre,code,[role="dialog"],form`)) return false;
        const message = failureText(region);
        return message.length <= 2000 && errorWords.test(message);
      });
      // A plain assistant may contain quoted error prose. The only unmarked
      // assistant exception is an exact bilingual Qwen connection-error card in the
      // supplied incident; it still never grants automatic retry authority.
      const exactQwenFailure = [...documentOrder(outermost(query(document, assistantSelector).filter(visible))), ...unmarkedQwenFailures()].some(region =>
        changedAfterBaseline(region) && !region.closest(`${userSelector},${thinkingSelector},pre,code,[role="dialog"],form`) &&
        failureText(region).length <= 500 && qwenRetryableFailure(failureText(region)));
      if (explicitFailure || exactQwenFailure) {
        result.contextValid = false;
        result.currentError = true;
        result.reason = 'recovery_current_error_unbound';
        return result;
      }
      // A cleared editor without a recognized user node is ambiguous, not proof
      // of a different task. It may only be observed while waiting for the user.
      result.contextValid = result.inputMatchesPrompt && href === baseline.href;
      result.reason = result.contextValid ? 'recovery_waiting_acceptance' : 'recovery_acceptance_unknown';
      return result;
    }
    // GLM can render an optimistic user bubble while still on the launch URL.
    // Pinning that URL would reject the very first server-assigned conversation.
    // Bind only the first changed URL plus this exact user turn, or an existing
    // conversation. All later route changes remain fatal; never resend here.
    if (!baseline.boundHref && (!baseline.allowFirstConversation || href !== baseline.href)) {
      baseline.boundHref = href;
    }
    if (accepted && provider === 'grok' && baseline.users.length === 0) {
      baseline.grokAccepted = true;
      baseline.grokUserNode = lastUser;
    }
    if (accepted && ['kimi', 'doubao'].includes(provider) && baseline.users.length === 0) {
      baseline.acceptedUserNode = lastUser;
    }
    if (followsGrokInitialConversation) baseline.boundHref = href;
    if (followsAcceptedWebRoute) baseline.boundHref = href;
    result.boundConversation = baseline.boundHref ? new URL(baseline.boundHref).pathname : null;
    result.awaitingFirstConversation = baseline.allowFirstConversation && !baseline.boundHref;
    result.contextValid = true;
    result.currentTurnAccepted = true;
    result.reason = 'recovery_no_current_error';
    const assistants = documentOrder(outermost(query(document, assistantSelector).filter(visible)));
    const lastAssistant = assistants.at(-1);
    const afterUser = node => Boolean(lastUser.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING);
    let currentAssistant = lastAssistant && afterUser(lastAssistant) ? lastAssistant : null;
    const unmarked = unmarkedQwenFailures(lastUser).filter(changedAfterBaseline);
    // A role-less current error may follow a recognized but empty placeholder.
    const fallback = unmarked.at(-1);
    if (fallback && (!currentAssistant || !currentAssistant.contains(fallback) && afterUser(fallback) &&
        Boolean(currentAssistant.compareDocumentPosition(fallback) & Node.DOCUMENT_POSITION_FOLLOWING))) currentAssistant = fallback;
    result.stopping ||= Boolean(currentAssistant && (currentAssistant.matches('[aria-busy="true"],[data-state="streaming"],[data-status="generating"]') ||
      currentAssistant.querySelector('[aria-busy="true"],[data-state="streaming"],[data-status="generating"]')));
    const errors = query(document, recoveryErrorSelector);
    if (currentAssistant) errors.push(currentAssistant);
    const retryName = /^(?:retry(?: (?:request|response|generation))?|try again|regenerate(?: (?:response|answer))?|重试|重新尝试|重新生成(?:回答|回复)?|重新回答)$/i;
    const qwenFailureControl = (node, region, ownerScope) => {
      // A Qwen error footer can contain a named Retry control or an icon-only
      // button. Bind either to the exact failure, its small current-turn scope
      // and DOM order; never search the whole page for a refresh-like icon.
      const label = node && accessibleLabel(node);
      // A visually icon-only control may still expose an aria-label/title to
      // assistive technology. Accept only an empty name or the same exact
      // retry vocabulary used by explicit recovery buttons.
      if (!node || (label && !retryName.test(label)) || (!label && !node.querySelector('svg')) ||
          node.closest('form,nav,header,aside,[role="navigation"],[role="toolbar"],.message-actions,.message-toolbar,[data-testid*="sidebar" i],[class*="sidebar" i]')) return false;
      const errorText = candidate => {
        const clone = candidate.cloneNode(true);
        clone.querySelectorAll('button,[role="button"],script,style,svg,[hidden],[aria-hidden="true"]').forEach(part => part.remove());
        return normalized(clone.textContent);
      };
      const explicitFailureRegions = [region, ...query(region, recoveryErrorSelector)]
        .filter((candidate, index, all) => all.indexOf(candidate) === index && candidate.matches(recoveryErrorSelector) && qwenRetryableFailure(errorText(candidate)));
      const errorRegion = explicitFailureRegions.find(candidate =>
        !explicitFailureRegions.some(other => other !== candidate && candidate.contains(other))) || region;
      if (!(errorRegion.contains(node) || ownerScope?.contains(errorRegion) && ownerScope.contains(node) &&
          Boolean(errorRegion.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING))) return false;
      if (errorRegion.contains(node)) {
        const textNodes = [], walker = document.createTreeWalker(errorRegion, NodeFilter.SHOW_TEXT);
        for (let textNode = walker.nextNode(); textNode; textNode = walker.nextNode()) {
          if (normalized(textNode.nodeValue) && !textNode.parentElement?.closest('button,[role="button"]')) textNodes.push(textNode);
        }
        const lastMessageText = textNodes.at(-1);
        if (!lastMessageText || !Boolean(lastMessageText.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)) return false;
      }
      if (node.closest(`${userSelector},${thinkingSelector},pre,code,[role="dialog"]`)) return false;
      const clone = node.cloneNode(true);
      clone.querySelectorAll('svg,[hidden],[aria-hidden="true"],script,style').forEach(part => part.remove());
      const visibleName = normalized(clone.textContent);
      if (visibleName && !retryName.test(visibleName)) return false;
      const errorBox = errorRegion.getBoundingClientRect(), controlBox = node.getBoundingClientRect();
      const finite = [errorBox.left, errorBox.top, errorBox.width, errorBox.height, controlBox.left, controlBox.top, controlBox.width, controlBox.height]
        .every(Number.isFinite);
      const errorBottom = errorBox.top + errorBox.height;
      const horizontallyNear = controlBox.left + controlBox.width >= errorBox.left - 96 && controlBox.left <= errorBox.left + errorBox.width + 96;
      const smallAction = controlBox.width > 0 && controlBox.height > 0 && controlBox.width <= 96 && controlBox.height <= 96;
      if (!finite || !smallAction || controlBox.top < errorBox.top - 24 || controlBox.top > errorBottom + 180 || !horizontallyNear) return false;
      return !visibleName && node.querySelector('svg') ? 'icon' : 'name';
    };
    const candidates = [];
    for (const region of [...new Set(errors)]) {
      if (!visible(region) || !afterUser(region) || region.closest(`${userSelector},${thinkingSelector},pre,code,[role="dialog"],form`)) continue;
      if (baseline.errors.has(region) && baseline.errors.get(region) === recoverySignature(region)) continue;
      // A matching word in quoted/model-authored prose is insufficient. Require
      // an explicit error region or a short, otherwise unformatted error turn.
      const explicit = region.matches(recoveryErrorSelector);
      if (!explicit && region.querySelector('pre,code,blockquote,table,ul,ol')) continue;
      const message = failureText(region);
      if (message.length > (explicit ? 2000 : 500) || !errorWords.test(message)) continue;
      let ownsCurrentTurn = Boolean(currentAssistant && (currentAssistant === region || currentAssistant.contains(region)));
      let ownerScope = ownsCurrentTurn ? currentAssistant : null;
      if (!ownsCurrentTurn) {
        // Some sites render the error next to, rather than inside, the assistant.
        // Accept only a local wrapper containing exactly this one user turn and
        // no later/unrelated assistant or composer, never a whole chat document.
        for (let scope = region.parentElement; scope && scope !== document.body; scope = scope.parentElement) {
          if (!scope.contains(lastUser)) continue;
          const scopedUsers = outermost(query(scope, userSelector).filter(visible));
          const scopedAssistants = outermost(query(scope, assistantSelector).filter(visible));
          ownsCurrentTurn = scopedUsers.length === 1 && scopedUsers[0] === lastUser && scopedAssistants.length <= 1 &&
            (!scopedAssistants.length || scopedAssistants[0] === currentAssistant) && (!input || !scope.contains(input.node));
          if (ownsCurrentTurn) ownerScope = scope;
          break;
        }
      }
      if (!ownsCurrentTurn) continue;
      result.currentError = true;
      result._scope ||= currentAssistant || ownerScope;
      result._errorRegion ||= region;
      const failureKind = qwenFailureKind(message);
      if (failureKind) result.errorKind = `qwen_${failureKind}`;
      for (const { selector, source } of selectorsFor('retry')) {
        for (const match of query(region, selector)) {
          const node = match.closest('button,[role="button"]') || match;
          if (!region.contains(node) || !visible(node) || node.closest('pre,code,[role="toolbar"],.message-actions,.message-toolbar')) continue;
          if (!candidates.some(candidate => candidate.node === node)) candidates.push({ node, region, evidence: 'provider-selector', selector, source });
        }
      }
      for (const node of query(region, 'button,[role="button"]')) {
        if (!retryName.test(accessibleLabel(node)) || !visible(node) || node.closest('pre,code,[role="toolbar"],.message-actions,.message-toolbar')) continue;
        if (!candidates.some(candidate => candidate.node === node)) candidates.push({ node, region, evidence: 'accessible-name' });
      }
      if (qwenRetryableFailure(message) && ownerScope) {
        const retryScopes = [ownerScope];
        // Some Qwen revisions keep the error card in the assistant node and its
        // retry footer as a sibling. Widen only through a single-turn container;
        // stop before history, the composer, or the application shell.
        if (currentAssistant && ownerScope === currentAssistant) {
          let depth = 0;
          for (let scope = currentAssistant.parentElement; scope && scope !== document.body && depth++ < 6; scope = scope.parentElement) {
            if (input && scope.contains(input.node)) break;
            const scopedUsers = outermost(query(scope, userSelector).filter(visible));
            const scopedAssistants = outermost(query(scope, assistantSelector).filter(visible));
            if (scopedUsers.length > 1 || scopedUsers.length === 1 && scopedUsers[0] !== lastUser || scopedAssistants.length > 1) break;
            if (!scope.contains(currentAssistant)) continue;
            retryScopes.push(scope);
          }
        }
        for (const scope of retryScopes) {
          for (const node of query(scope, 'button,[role="button"]')) {
            if (!visible(node)) continue;
            const controlKind = qwenFailureControl(node, region, scope);
            if (!controlKind) continue;
            if (!candidates.some(candidate => candidate.node === node)) candidates.push({ node, region,
              evidence: `qwen-${failureKind}-adjacent-${controlKind}` });
          }
        }
      }
    }
    if (!result.currentError) return result;
    // Supplied only by the local network observer, never by page text. A failed
    // latest generation with no request in flight can leave a stale stop widget.
    if (provider === 'qwen' && args.network_terminal_failure === true && result.stopping) {
      result.staleStopIgnored = true;
      result.stopping = false;
    }
    result.reason = result.recoveryUsed ? 'recovery_already_claimed' : result.stopping ? 'recovery_page_busy' : 'recovery_target_missing';
    if (result.stopping || candidates.length !== 1) {
      if (!result.recoveryUsed && !result.stopping && candidates.length > 1) result.reason = 'recovery_target_ambiguous';
      return result;
    }
    const candidate = candidates[0];
    const target = describeControl(candidate.node, candidate.evidence.startsWith('qwen-') ?
      candidate.evidence.replace('qwen-', 'qwen-current-turn-') : candidate.selector || 'current-turn-error-retry-name', candidate.source || 'recovery');
    result.target = target;
    result.retryAvailable = !result.recoveryUsed && target.visible && !target.disabled && target.inViewport && target.hitTestAvailable && !target.obscured && target.pointerEvents !== 'none';
    // Scrolling is a separate, explicit adapter action under its input lease.
    // Read-only inspection neither scrolls nor grants an offscreen click.
    result.retryRevealable = !result.recoveryUsed && provider === 'qwen' && target.visible && !target.disabled && !target.inViewport &&
      target.hitTestAvailable && target.pointerEvents !== 'none';
    // Retain the verified node for read-only screenshot matching after the DOM
    // stage was used. Neither this report nor the visual stage grants a second DOM click.
    result.reason = result.recoveryUsed ? 'recovery_already_claimed' : result.retryAvailable ? 'recovery_ready' : 'recovery_target_not_clickable';
    return { ...result, _node: candidate.node, _region: candidate.region };
  };
  const publicRecovery = state => { const { _node, _region, _scope, _errorRegion, ...result } = state; return result; };
  const retryDescriptor = node => {
    const attr = key => (node.getAttribute(key) || '').slice(0, 160);
    const classes = [...node.classList].filter(c => /^[a-zA-Z_][\w-]{0,60}$/.test(c)).slice(0, 5);
    return { tag: node.tagName.toLowerCase(), id: attr('id'), testid: attr('data-testid'),
      aria: attr('aria-label'), title: attr('title'), role: attr('role'), classes,
      label: accessibleLabel(node).slice(0, 160) };
  };
  const sameRetryDescriptor = (node, d) => {
    if (!d || typeof d !== 'object' || node.tagName.toLowerCase() !== d.tag) return false;
    if (d.id) return node.id === d.id;
    if (d.testid) return node.getAttribute('data-testid') === d.testid;
    if (d.aria) return node.getAttribute('aria-label') === d.aria;
    if (d.title) return node.getAttribute('title') === d.title;
    return Array.isArray(d.classes) && d.classes.length > 0 && d.classes.every(c => node.classList.contains(c)) &&
      (!d.label || accessibleLabel(node) === d.label);
  };
  const retryScope = state => {
    let scope = state._scope || state._region;
    if (!scope) return null;
    const input = find('input'), lastUser = recoveryUsers().at(-1);
    for (let parent = scope.parentElement, depth = 0; parent && parent !== document.body && depth++ < 3; parent = parent.parentElement) {
      if (input && parent.contains(input.node) || parent.matches('body,html,form')) break;
      const users = outermost(query(parent, userSelector).filter(visible));
      const assistants = outermost(query(parent, assistantSelector).filter(visible));
      if (users.length > 1 || users.length === 1 && users[0] !== lastUser || assistants.length > 1) break;
      scope = parent;
    }
    return scope;
  };
  if (['recoveryTrigger', 'recoveryVisual', 'recoveryVisualClaim', 'recoveryWatchStart', 'recoveryWatchPoll', 'recoveryWatchStop'].includes(action)) {
    const job = globalThis.__fusionJob, baseline = job?.id === args.id ? job.recovery : null;
    if (!baseline || provider !== 'qwen') return { ready: false, reason: 'retry_context_missing' };
    if (action === 'recoveryWatchStop') {
      if (baseline.watchHandler) document.removeEventListener('click', baseline.watchHandler, true);
      baseline.watchHandler = null;
      const clicks = baseline.watchClicks || []; baseline.watchClicks = [];
      return { ready: true, clicks };
    }
    const state = recoveryState(job), report = publicRecovery(state);
    if (action === 'recoveryWatchPoll') return { ...report, clicks: baseline.watchClicks || [] };
    const blocked = !state.contextValid || state.contextChanged || !state.currentTurnAccepted || !state.currentError || state.stopping;
    if (Date.now() >= args.deadline || blocked) return { ...report, ready: false };
    const verification = verificationState();
    if (verification.required) return { ...report, ready: false, reason: 'verification_required' };
    if (query(document, '[role="dialog"],[aria-modal="true"]').some(visible)) return { ...report, ready: false, reason: 'retry_overlay_present' };
    const scope = retryScope(state);
    if (!scope) return { ...report, ready: false, reason: 'retry_scope_unknown' };
    baseline.retryStages ||= {};
    if (action === 'recoveryWatchStart') {
      if (baseline.watchHandler) document.removeEventListener('click', baseline.watchHandler, true);
      baseline.watchClicks = [];
      const expires = Math.min(args.deadline, Number(args.expires) || args.deadline);
      baseline.watchHandler = event => {
        if (!event.isTrusted || Date.now() > expires || globalThis.__fusionJob !== job) return;
        const current = recoveryState(job), currentScope = retryScope(current);
        if (!current.contextValid || current.contextChanged || !current.currentError || !currentScope) return;
        const target = event.target instanceof Element ? event.target : null;
        const node = target?.closest('button,[role="button"],[tabindex]') || target?.closest('svg')?.parentElement || target;
        if (!node || !currentScope.contains(node) || node.closest(`${userSelector},pre,code,input,textarea,[contenteditable="true"],a[href]`)) return;
        const rect = node.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0 || rect.width > 320 || rect.height > 120) return;
        const label = accessibleLabel(node);
        if (/copy|delete|remove|share|report|like|复制|删除|分享|举报|赞/i.test(label)) return;
        const clicked = { at: Date.now(), descriptor: retryDescriptor(node),
          bounds: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
          point: { x: event.clientX, y: event.clientY }, viewport: { width: innerWidth, height: innerHeight },
          origin: location.origin, conversation: recoveryHref(location.href), trusted: true };
        baseline.watchClicks.push(clicked);
        if (baseline.watchClicks.length > 20) baseline.watchClicks.shift();
      };
      document.addEventListener('click', baseline.watchHandler, true);
      return { ...report, ready: true, expires };
    }
    if (args.require_interactive && (document.visibilityState !== 'visible' || !document.hasFocus()))
      return { ...report, ready: false, reason: 'recovery_page_not_interactive' };
    if (action === 'recoveryTrigger') {
      if (baseline.retryStages.trigger || baseline.claimed || !state.retryAvailable || !state._node)
        return { ...report, ready: false, reason: 'retry_trigger_unavailable_or_used' };
      baseline.retryStages.trigger = true;
      baseline.claimed = true;
      const descriptor = retryDescriptor(state._node);
      // Dispatch the page's own current-turn retry handler. No HTTP replay,
      // prompt re-entry, React private internals, or forced navigation.
      state._node.click();
      return { ...report, ready: true, dispatched: true, method: 'dom_current_turn_handler', descriptor };
    }
    if (action === 'recoveryVisual') {
      if (baseline.retryStages.visual && !args.capture_only) return { ...report, ready: false, reason: 'retry_visual_already_used' };
      const learned = args.learned && typeof args.learned === 'object' ? args.learned : null;
      const nodes = query(scope, 'button,[role="button"],[tabindex],svg').map(n => n.tagName.toLowerCase() === 'svg' ? n.parentElement : n);
      if (learned) nodes.push(...query(scope, learned.tag && /^[a-z][a-z0-9-]{0,30}$/.test(learned.tag) ? learned.tag : 'button').filter(n => sameRetryDescriptor(n, learned)));
      const candidates = [...new Set(nodes)].filter(node => {
        if (!node || !visible(node) || node.closest(`${userSelector},pre,code,form,[contenteditable="true"],a[href]`)) return false;
        const label = accessibleLabel(node);
        return !/copy|delete|remove|share|report|like|复制|删除|分享|举报|赞/i.test(label);
      }).map(node => ({ node, descriptor: retryDescriptor(node), learned: sameRetryDescriptor(node, learned) }));
      const preferred = candidates.filter(c => c.learned || /^(?:retry(?: (?:request|response|generation))?|try again|regenerate(?: (?:response|answer))?|重试|重新生成(?:回答|回复)?|重新尝试)$/i.test(c.descriptor.label));
      const reveal = preferred.length === 1 ? preferred[0].node : state._node;
      if (reveal) reveal.scrollIntoView?.({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
      const refreshed = recoveryState(job);
      if (!refreshed.contextValid || refreshed.contextChanged) return { ...publicRecovery(refreshed), ready: false };
      baseline.visualReservations = new Map();
      const rows = [];
      for (const candidate of candidates.slice(0, 32)) {
        const target = describeControl(candidate.node, 'screenshot-current-error', 'visual');
        if (!target.visible || target.disabled || !target.inViewport || target.obscured || !target.hitTestAvailable || target.pointerEvents === 'none') continue;
        const b = target.bounds;
        if (b.width < 8 || b.height < 8 || b.width > 320 || b.height > 120) continue;
        const token = `${args.id}:visual:${++baseline.sequence}`;
        baseline.visualReservations.set(token, { node: candidate.node, href: recoveryHref(location.href), descriptor: candidate.descriptor });
        rows.push({ token, descriptor: candidate.descriptor, bounds: b, learned: candidate.learned,
          semantic: refreshed._node === candidate.node || /^(?:retry(?: (?:request|response|generation))?|try again|regenerate(?: (?:response|answer))?|重试|重新生成(?:回答|回复)?|重新尝试)$/i.test(candidate.descriptor.label),
          icon: !candidate.descriptor.label && Boolean(candidate.node.querySelector('svg')) && b.width <= 96 && b.height <= 80 });
      }
      return { ...publicRecovery(refreshed), ready: rows.length > 0, candidates: rows,
        viewport: { width: innerWidth, height: innerHeight, devicePixelRatio }, reason: rows.length ? 'retry_visual_candidates' : 'retry_visual_candidates_missing' };
    }
    const reservation = baseline.visualReservations?.get(args.token);
    baseline.visualReservations?.clear();
    if (!reservation || baseline.retryStages.visual || reservation.href !== recoveryHref(location.href) || !scope.contains(reservation.node))
      return { ...report, ready: false, reason: 'retry_visual_reservation_changed' };
    const target = describeControl(reservation.node, 'screenshot-current-error', 'visual');
    if (!target.visible || target.disabled || !target.inViewport || target.obscured || !target.hitTestAvailable || target.pointerEvents === 'none')
      return { ...report, ready: false, reason: 'retry_visual_target_blocked' };
    const b = target.bounds, expected = args.bounds;
    if (!expected || ['x','y','width','height'].some(k => Math.abs(b[k] - expected[k]) > 2))
      return { ...report, ready: false, reason: 'retry_visual_target_moved' };
    baseline.retryStages.visual = true; baseline.claimed = true;
    return { ...report, ready: true, method: 'button', x: b.x + b.width / 2, y: b.y + b.height / 2, descriptor: reservation.descriptor };
  }
  if (['prepare', 'inputProgress', 'canSubmit', 'claimSubmit', 'recoveryTarget', 'recoveryClaim', 'recoveryReveal', 'glmNewChatTarget'].includes(action)) {
    const verification = verificationState();
    if (verification.required) return { ready: false, reason: 'verification_required', verification, page: pageState() };
  }
  if (['recoveryInspect', 'recoveryTarget', 'recoveryClaim', 'recoveryReveal'].includes(action)) {
    const job = globalThis.__fusionJob;
    const reservation = action === 'recoveryClaim' && job?.id === args.id ? job.recovery?.reservation : null;
    // Every claim attempt, including a stale/blocked target, consumes its token.
    if (action === 'recoveryClaim' && job?.id === args.id && job.recovery) job.recovery.reservation = null;
    if (Date.now() >= args.deadline) return { ready: false, contextValid: false, contextChanged: false, reason: 'recovery_deadline_expired', currentError: false };
    const state = recoveryState(job);
    const report = publicRecovery(state);
    if (action === 'recoveryInspect') return report;
    if (action === 'recoveryReveal') {
      if (provider !== 'qwen' || !state.contextValid || !state.currentError || !state.retryRevealable || state.recoveryUsed || state.stopping)
        return { ...report, ready: false };
      if (args.require_interactive && (document.visibilityState !== 'visible' || !document.hasFocus()))
        return { ...report, ready: false, reason: 'recovery_page_not_interactive' };
      if (query(document, '[role="dialog"],[aria-modal="true"]').some(visible))
        return { ...report, ready: false, reason: 'recovery_overlay_present' };
      const node = state._node, region = state._region;
      node.scrollIntoView?.({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
      const after = recoveryState(job);
      const ready = after.contextValid && !after.contextChanged && after.retryAvailable && after._node === node && after._region === region;
      return { ...publicRecovery(after), ready: Boolean(ready), revealed: Boolean(ready) };
    }

    if (!state.contextValid || !state.retryAvailable) return { ...report, ready: false };
    if (args.require_interactive && (document.visibilityState !== 'visible' || !document.hasFocus())) return { ...report, ready: false, reason: 'recovery_page_not_interactive' };
    if (action === 'recoveryTarget') {
      const nonce = `${args.id}:recovery:${++job.recovery.sequence}`;
      job.recovery.reservation = { nonce, node: state._node, region: state._region, href: location.href };
      return { ...report, ready: true, method: 'button', nonce, x: state.target.bounds.x + state.target.bounds.width / 2,
        y: state.target.bounds.y + state.target.bounds.height / 2 };
    }
    if (!reservation || reservation.nonce !== args.nonce || reservation.node !== state._node || reservation.region !== state._region || reservation.href !== location.href) {
      return { ...report, ready: false, reason: 'recovery_reservation_changed' };
    }
    job.recovery.claimed = true; // Trusted input is owned by the adapter, never DOM.click().
    return { ...report, recoveryUsed: true, ready: true, method: 'button', nonce: args.nonce,
      x: state.target.bounds.x + state.target.bounds.width / 2, y: state.target.bounds.y + state.target.bounds.height / 2 };
  }
  if (action === 'qwenSession' || action === 'glmSession') {
    if (action !== `${provider}Session`) return { ready: false, reason: 'unsupported_provider' };
    return publicSession(preservedSession());
  }
  if (action === 'qwenNewChatTarget' || action === 'glmNewChatTarget' || action === 'qwenDismissTarget') {
    if (Date.now() >= args.deadline) throw new Error('Generation deadline expired before DOM action.');
    if (!['qwen', 'glm'].includes(provider) ||
        (action !== `${provider}NewChatTarget` && !(provider === 'qwen' && action === 'qwenDismissTarget'))) {
      return { ready: false, reason: 'unsupported_provider' };
    }
    const session = preservedSession();
    const dismiss = action === 'qwenDismissTarget';
    const panel = session._rating[0];
    const node = dismiss ? panel?.close : session._newChat;
    const reasonPrefix = dismiss ? 'rating_close' : 'new_chat';
    if (!node) return { ready: false, reason: `${reasonPrefix}_missing`, session: publicSession(session) };
    // Only return a clickable, unobscured control. The main process owns the
    // single trusted gesture; DOM inspection never clicks or removes overlays.
    node.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    const target = describeControl(node, dismiss ? 'accessible-rating-dismiss-name' : session.newChat.selector, dismiss ? 'semantic' : session.newChat.source);
    if (!target.visible || target.disabled || !target.inViewport || !target.hitTestAvailable || target.obscured) {
      return { ready: false, reason: `${reasonPrefix}_not_clickable`, target, session: publicSession(session) };
    }
    if (args.require_interactive && (document.visibilityState !== 'visible' || !document.hasFocus())) return { ready: false, reason: 'page_not_interactive', target };
    return { ready: true, reason: 'ready', method: 'button', x: target.bounds.x + target.bounds.width / 2,
      y: target.bounds.y + target.bounds.height / 2, target, identity: panel?.identity };
  }
  if (action === 'copyMarkdownTarget' || action === 'qwenCopyMarkdownTarget') {
    if (action === 'qwenCopyMarkdownTarget' && provider !== 'qwen') return { ready: false, reason: 'unsupported_provider' };
    if (!['qwen', 'doubao'].includes(provider)) return { ready: false, reason: 'unsupported_provider' };
    return copyMarkdownTarget();
  }
  if (action === 'qwenDOMJSON') {
    if (provider !== 'qwen') return { ready: false, reason: 'unsupported_provider', candidates: [] };
    return jsonDOMPayload();
  }
  if (action === 'inspect') return snapshot();
  if (action === 'diagnoseSend') {
    const input = find('input');
    const send = input ? sendControl(input.node) : null;
    return { provider, page: pageState(), input: input ? { ...nodeIdentity(input.node),
      selector: input.selector, source: input.source, disabled: !enabled(input.node),
      valueLength: readValue(input.node).length, focused: document.activeElement === input.node } : null,
      sendTarget: send ? describeControl(send.node, send.selector, send.source) : null,
      sendActionConflict: Boolean(send?.actionConflict),
      ...candidateReport(input?.node, send), invalidSelectors,
      ...(['qwen', 'glm'].includes(provider) ? { session: publicSession(preservedSession()) } : {}),
      note: 'Read-only detection; does not fill, focus, scroll, reserve, or submit.' };
  }

  if (Date.now() >= args.deadline) throw new Error('Generation deadline expired before DOM action.');
  if (action === 'prepare') {
    const input = find('input', true);
    if (!input) return { ready: false, reason: 'input_missing' };
    const node = input.node;
    if (typeof node.maxLength === 'number' && node.maxLength >= 0 && canonicalInput(args.prompt).length > node.maxLength)
      return { ready: false, reason: 'input_too_long', inputLimit: node.maxLength, expectedLength: canonicalInput(args.prompt).length };
    if (find('stop')) return { ready: false, reason: 'page_busy' };
    if (readValue(node).trim()) return { ready: false, reason: 'input_not_empty' };
    globalThis.__fusionJob = { id: args.id, submitted: false, cancelled: false, input: node, inputSource: input.source, inputSelector: input.selector,
      recovery: recoveryBaseline() };
    node.focus({ preventScroll: true });
    if (args.input_transport === 'cdp') {
      // The main process inserts text once with Input.insertText. This produces
      // browser editing events so controlled inputs receive an actual edit.
      if ('setSelectionRange' in node) node.setSelectionRange(0, node.value.length);
      else {
        const range = document.createRange();
        range.selectNodeContents(node);
        const selection = getSelection();
        selection.removeAllRanges(); selection.addRange(range);
      }
      return { ready: true, inputSource: input.source, inputLength: readValue(node).length, inputMethod: 'cdp_insert_text', inputKind: 'value' in node ? 'plain' : 'rich', inputFocused: document.activeElement === node, page: pageState() };
    }
    if ('value' in node) {
      const proto = node.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(node, args.prompt);
      node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: args.prompt }));
      node.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      const selection = getSelection();
      const range = document.createRange();
      range.selectNodeContents(node);
      selection.removeAllRanges(); selection.addRange(range);
      if (!document.execCommand?.('insertText', false, args.prompt)) {
        node.textContent = args.prompt;
        node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: args.prompt }));
      }
    }
    return { ready: true, inputSource: input.source, inputLength: readValue(node).length, inputMethod: 'dom', inputFocused: document.activeElement === node, page: pageState() };
  }
  const job = globalThis.__fusionJob;
  if (!job || job.id !== args.id || job.cancelled) throw new Error('DOM generation context was cancelled or replaced.');
  if (action === 'confirmManualSubmit') {
    const evidence = String(args.manual_evidence || '');
    const current = snapshot();
    const valid = evidence === 'network_request' || evidence === 'new_user_turn' && current.lastUserMatchesPrompt ||
      evidence === 'generation_indicator' && current.stopping || evidence === 'new_assistant_content' && current.inputEmpty && current.answers.length > 0;
    if (provider !== 'qwen' || job.submitted || !valid) return { ready: false, reason: 'manual_submit_evidence_invalid', evidence };
    job.submitted = true;
    return { ...publicRecovery(recoveryState(job)), ready: true, evidence };
  }
  if (action === 'inputProgress') {
    const expected = canonicalInput(args.prompt);
    const offset = args.input_offset;
    if (!Number.isInteger(offset) || offset < 0 || offset > expected.length || job.submitted)
      return { ready: false, reason: 'invalid_input_offset' };
    if (find('stop')) return { ready: false, reason: 'page_busy' };
    // Doubao replaces its textarea with a contenteditable editor after the
    // first native edit. Keep the lease tied to the current composer instead
    // of treating that normal React/Tiptap rerender as a destructive change.
    let node = job.input;
    const active = document.activeElement;
    const activeEditor = active && active !== node && (active instanceof HTMLElement) &&
      (active.matches('textarea,input:not([type]),input[type="text"],[contenteditable="true"]')) &&
      visible(active) && enabled(active);
    if (activeEditor) {
      // Prefer the focused replacement when the old controlled node is still
      // briefly connected during a framework commit.
      node = active;
      job.input = node;
      job.inputSource = 'active_editor';
      job.inputSelector = '[contenteditable="true"],textarea,input[type="text"]';
    }
    if (!node?.isConnected || !visible(node) || !enabled(node)) {
      const replacement = find('input', true);
      if (replacement?.node) {
        node = replacement.node;
        job.input = node;
        job.inputSource = replacement.source;
        job.inputSelector = replacement.selector;
      }
    }
    const actual = readValue(node);
    const prefixMatches = actual === expected.slice(0, actual.length) && actual.length <= offset;
    const state = { inputLength: actual.length, expectedLength: offset, prefixMatches, page: pageState() };
    if (!node?.isConnected || !visible(node) || !enabled(node)) return { ...state, ready: false, reason: 'input_replaced_or_disabled' };
    if (actual !== expected.slice(0, offset)) return { ...state, ready: false, reason: prefixMatches ? 'input_pending' : 'prefix_changed' };
    if (document.activeElement !== node || args.require_interactive && (document.visibilityState !== 'visible' || !document.hasFocus()))
      return { ...state, ready: false, reason: 'input_focus_lost' };
    let atEnd = false;
    if ('selectionStart' in node) atEnd = node.selectionStart === actual.length && node.selectionEnd === actual.length;
    else {
      const selection = getSelection();
      if (selection?.rangeCount === 1 && offset === 0 && actual === '' &&
          node.contains(selection.getRangeAt(0).commonAncestorContainer) && selection.toString() === '') atEnd = true;
      else if (selection?.rangeCount === 1 && selection.isCollapsed && node.contains(selection.anchorNode)) {
        const tail = document.createRange(); tail.selectNodeContents(node);
        tail.setStart(selection.anchorNode, selection.anchorOffset);
        atEnd = tail.toString().length === 0;
      }
    }
    return { ...state, ready: atEnd, reason: atEnd ? 'prefix_verified' : 'input_caret_changed' };
  }
  const submission = claim => {
    if (job.submitted) throw new Error('This job was already submitted.');
    // Retain the prepared editor instead of switching to the first generic
    // textarea after a page rerender; if the provider replaces its node, the
    // focused/current composer is rebound below.
    let replacement = job.input?.isConnected ? job.input : query(document, job.inputSelector).find(node => visible(node) && enabled(node));
    const active = document.activeElement;
    if (active && active !== replacement && active instanceof HTMLElement &&
        active.matches('textarea,input:not([type]),input[type="text"],[contenteditable="true"]') &&
        visible(active) && enabled(active)) replacement = active;
    // A controlled editor can change element type during a native edit (for
    // example textarea -> Tiptap div). The original selector then no longer
    // matches; rediscover the active composer using the provider selector set.
    if (!replacement) {
      const current = find('input', true);
      if (current?.node) {
        replacement = current.node;
        job.input = current.node;
        job.inputSource = current.source;
        job.inputSelector = current.selector;
      }
    }
    const input = replacement && visible(replacement) && enabled(replacement) ? { node: replacement, source: job.inputSource } : null;
    const currentText = input ? readValue(input.node).trim() : '';
    const prefixMatches = currentText === expectedInput.slice(0, currentText.length) && currentText.length <= expectedInput.length;
    const state = { page: pageState(), inputLength: currentText.length, expectedLength: expectedInput.length, prefixMatches, inputSource: input?.source || 'none' };
    if (!input || !promptMatches(currentText, expectedInput)) return { ...state, ready: false, reason: 'input_changed' };
    const send = sendControl(input.node);
    Object.assign(state, { sendSource: send?.source || 'none', sendCandidates: send?.candidateCount || 0,
      sendTarget: send ? describeControl(send.node, send.selector, send.source) : null });
    Object.assign(state, candidateReport(input.node, send));
    if (args.require_interactive && (state.page.visibilityState !== 'visible' || !state.page.hasFocus)) return { ...state, ready: false, reason: 'page_not_interactive' };
    if (send?.actionConflict) return { ...state, ready: false, reason: 'send_action_conflict' };
    if (send && !send.isEnabled) return { ...state, ready: false, reason: 'send_disabled', method: 'button' };
    if (find('stop')) return { ...state, ready: false, reason: 'page_busy' };
    // Enter can implicitly submit a form. If an unrelated visible submit control
    // exists, do not use Enter to guess which operation the form performs.
    const form = input.node.closest('form');
    if (!send && form && query(form, 'button:not([type]),button[type="submit"],input[type="submit"]').some(visible)) return { ...state, ready: false, reason: 'unrecognized_form_submit' };
    // Providers using the native CDP text path also require an identified Send
    // control. Falling back to Enter can insert a newline or trigger an
    // unrelated form action after a site redesign, so fail with diagnostics.
    if (!send && ['qwen', 'chatgpt', 'glm', 'kimi'].includes(provider)) return { ...state, ready: false, reason: 'send_missing' };
    const target = send?.node || input.node;
    target.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    const rect = target.getBoundingClientRect();
    if (send) state.sendTarget = describeControl(send.node, send.selector, send.source);
    const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
    if (send && (!(rect.width > 0 && rect.height > 0) || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight)) return { ...state, ready: false, reason: 'send_outside_viewport' };
    if (send && provider === 'chatgpt' && args.require_interactive && typeof document.elementFromPoint !== 'function') return { ...state, ready: false, reason: 'send_hit_test_unavailable' };
    if (send && typeof document.elementFromPoint === 'function') {
      const hit = document.elementFromPoint(x, y);
      if (!hit || !(hit === send.node || send.node.contains(hit))) return { ...state, ready: false, reason: 'send_obscured' };
    }
    if (claim) {
      job.submitted = true; // Reservation only; DOM never synthesizes clicks or Enter.
      if (!send) input.node.focus({ preventScroll: true });
    }
    return { ...state, ready: true, reason: 'ready', method: send ? 'button' : 'enter', sendSource: send?.source || 'trusted_enter', x, y };
  };
  if (action === 'canSubmit') return submission(false);
  if (action === 'claimSubmit') return submission(true);
  throw new Error('Unknown DOM action.');
}

module.exports = { pageAction };
