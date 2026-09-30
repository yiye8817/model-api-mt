'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow, BrowserView, clipboard } = require('electron');
const { detectSite, runWebChat, startNewWebChat, __test } = require('./web-chat.cjs');

app.whenReady().then(async () => {
  assert.equal(detectSite('https://chat.deepseek.com/'), 'deepseek');
  assert.equal(detectSite('https://chat.qwen.ai/'), 'qwen');
  assert.equal(detectSite('https://chatgpt.com/'), 'chatgpt');
  assert.equal(detectSite('https://grok.com/'), 'grok');
  assert.equal(detectSite('https://claude.ai/new'), 'claude');
  assert.equal(detectSite('https://gemini.google.com/app'), 'gemini');
  assert.equal(detectSite('https://poe.com/'), 'poe');
  const win = new BrowserWindow({ show: false, width: 900, height: 700 });
  const view = new BrowserView({ webPreferences: { backgroundThrottling: false } });
  win.setBrowserView(view);
  view.setBounds({ x: 0, y: 0, width: 900, height: 700 });
  const html = `<!doctype html><html><body>
    <main style="height:680px;display:flex;flex-direction:column;justify-content:flex-end">
      <button type="button" data-testid="model-switcher-dropdown-button">GPT-5</button>
      <button type="button" data-testid="create-new-chat-button">New chat</button>
      <div id="answers"></div>
      <form onsubmit="event.preventDefault()">
        <textarea aria-label="发送消息" style="width:700px;height:80px"></textarea>
        <button type="button" aria-label="发送">发送</button>
      </form>
    </main>
    <script>
      document.querySelector('[aria-label="发送"]').onclick = () => {
        const stop = document.createElement('button');
        stop.dataset.testid = 'stop-button';
        stop.textContent = 'Stop generating';
        document.querySelector('main').appendChild(stop);
        const answer = document.createElement('div');
        answer.setAttribute('data-message-author-role', 'assistant');
        answer.textContent = '可以实现，但';
        document.querySelector('#answers').appendChild(answer);
        const citation = document.createElement('div');
        citation.setAttribute('data-message-author-role', 'assistant');
        citation.textContent = 'GitHub +1';
        document.querySelector('#answers').appendChild(citation);
        const copy = document.createElement('button');
        copy.dataset.testid = 'copy-turn-action-button';
        copy.setAttribute('aria-label', 'Copy');
        copy.textContent = 'Copy';
        copy.onclick = () => {
          const onCopy = event => {
            event.clipboardData.setData('text/plain', '# Markdown copied\\n\\n- 完整回答\\n- ' + document.querySelector('textarea').value);
            event.preventDefault();
          };
          document.addEventListener('copy', onCopy, { once: true });
          document.execCommand('copy');
        };
        document.querySelector('#answers').appendChild(copy);
        setTimeout(() => {
          answer.textContent = '网页回答：这是完整且足够长的主体内容，用于确认提取器会等待生成结束并选择最长回答，而不是过早返回末尾的引用碎片。问题是：' + document.querySelector('textarea').value;
          stop.remove();
        }, 1500);
      };
      document.querySelector('[data-testid="create-new-chat-button"]').onclick = () => window.newChatClicked = true;
    </script>
  </body></html>`;
  await view.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  const secondWin = new BrowserWindow({ show: false, width: 900, height: 700 });
  const secondView = new BrowserView({ webPreferences: { backgroundThrottling: false } });
  secondWin.setBrowserView(secondView);
  secondView.setBounds({ x: 0, y: 0, width: 900, height: 700 });
  await secondView.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

  clipboard.writeText('用户原剪贴板');
  const firstEvents = [];
  const secondEvents = [];
  const [result, secondResult] = await Promise.all([
    runWebChat(view, '真实 DOM 测试', {
      timeoutMs: 10000,
      stableMs: 1000,
      onProgress: (event, message, details) => firstEvents.push({ event, message, details }),
    }),
    runWebChat(secondView, '第二网页测试', {
      timeoutMs: 10000,
      stableMs: 1000,
      onProgress: (event, message, details) => secondEvents.push({ event, message, details }),
    }),
  ]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.content, '# Markdown copied\n\n- 完整回答\n- 真实 DOM 测试');
  assert.equal(secondResult.ok, true, JSON.stringify(secondResult));
  assert.equal(secondResult.content, '# Markdown copied\n\n- 完整回答\n- 第二网页测试');
  const expectedEvents = [
    'prompt-sent', 'server-replied', 'response-complete', 'page-rendered',
    'scrolled-bottom', 'copy-nodes-scanned', 'copy-clicked',
    'markdown-copied', 'dom-dump-captured',
  ];
  for (const events of [firstEvents, secondEvents]) {
    for (const event of expectedEvents) {
      assert.ok(events.some(item => item.event === event), `missing progress event: ${event}`);
    }
  }
  for (const item of [result, secondResult]) {
    assert.equal(item.extraction?.ok, true, JSON.stringify(item.extraction));
    assert.equal(item.extraction?.source, 'copy-button');
    assert.equal(item.validation?.copiedMarkdown, true, JSON.stringify(item.validation));
  }
  assert.equal(clipboard.readText(), '用户原剪贴板');

  const copyHandler = markdown => `
    const copyMarkdown = () => {
      const onCopy = event => {
        event.clipboardData.setData('text/plain', ${JSON.stringify(markdown)});
        event.preventDefault();
      };
      document.addEventListener('copy', onCopy, { once: true });
      document.execCommand('copy');
    };
  `;
  const deepSeekHtml = `<!doctype html><html><body>
    <main style="min-height:900px;padding-top:700px">
      <div data-virtual-list-item-key="assistant-message-1">
        <div class="ds-markdown ds-assistant-message-main-content">DeepSeek answer</div>
        <div class="ds-flex">
          <div id="deep-copy" role="button" class="ds-button" tabindex="0">icon-copy</div>
          <div role="button" class="ds-button">icon-retry</div>
          <div role="button" class="ds-button">icon-like</div>
          <div role="button" class="ds-button">icon-dislike</div>
        </div>
      </div>
    </main>
    <script>
      ${copyHandler('# DeepSeek Markdown\n\n- copied from assistant')}
      document.querySelector('#deep-copy').onclick = copyMarkdown;
    </script>
  </body></html>`;
  await secondView.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(deepSeekHtml)}`);
  const deepState = await secondView.webContents.executeJavaScript(
    `(${__test.readChatStateInPage.toString()})('deepseek', 'test prompt')`, true,
  );
  assert.equal(deepState.copyReady, true, JSON.stringify(deepState));
  const deepCopy = await __test.copyLatestAnswerMarkdown(secondView.webContents, 'deepseek');
  assert.equal(deepCopy.ok, true, JSON.stringify(deepCopy));
  assert.equal(deepCopy.content, '# DeepSeek Markdown\n\n- copied from assistant');
  assert.match(deepCopy.buttonLabel, /DeepSeek assistant action button 1/);

  const chatGptHtml = `<!doctype html><html><body>
    <main style="min-height:900px;padding-top:700px">
      <section data-turn="user" data-testid="conversation-turn-1">
        <button id="user-copy" aria-label="复制消息" data-testid="copy-turn-action-button">copy user</button>
      </section>
      <section data-turn="assistant" data-testid="conversation-turn-2">
        <div data-message-author-role="assistant">Older ChatGPT answer</div>
        <button id="old-assistant-copy" aria-label="复制回复" data-testid="copy-turn-action-button">copy old assistant</button>
      </section>
      <section data-turn="assistant" data-testid="conversation-turn-3">
        <div data-message-author-role="assistant">Latest ChatGPT answer</div>
        <button id="assistant-copy" aria-label="复制回复" data-testid="copy-turn-action-button">copy latest assistant</button>
      </section>
    </main>
    <script>
      window.userCopyClicked = false;
      window.oldAssistantCopyClicked = false;
      document.querySelector('#user-copy').onclick = () => { window.userCopyClicked = true; };
      document.querySelector('#old-assistant-copy').onclick = () => { window.oldAssistantCopyClicked = true; };
      ${copyHandler('# ChatGPT Markdown\n\n- copied from assistant')}
      document.querySelector('#assistant-copy').onclick = copyMarkdown;
    </script>
  </body></html>`;
  await secondView.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(chatGptHtml)}`);
  // 网页 AI 群聊通常在对话页运行，此时 BrowserView 已从窗口卸下。
  secondWin.removeBrowserView(secondView);
  const chatState = await secondView.webContents.executeJavaScript(
    `(${__test.readChatStateInPage.toString()})('chatgpt', 'test prompt')`, true,
  );
  assert.equal(chatState.copyReady, true, JSON.stringify(chatState));
  const chatCopy = await __test.copyLatestAnswerMarkdown(secondView.webContents, 'chatgpt');
  assert.equal(chatCopy.ok, true, JSON.stringify(chatCopy));
  assert.equal(chatCopy.clickMethod, 'native-input', JSON.stringify(chatCopy));
  assert.equal(chatCopy.content, '# ChatGPT Markdown\n\n- copied from assistant');
  assert.match(chatCopy.buttonLabel, /ChatGPT last aria-label="复制回复"/);
  assert.deepEqual(
    await secondView.webContents.executeJavaScript(
      '({ user: window.userCopyClicked, oldAssistant: window.oldAssistantCopyClicked })',
    ), { user: false, oldAssistant: false },
    'ChatGPT must click only the last aria-label="复制回复" button',
  );
  assert.equal(clipboard.readText(), '用户原剪贴板');

  const chatGptFallbackHtml = `<!doctype html><html><body>
    <main style="min-height:900px;padding-top:700px">
      <section data-turn="assistant" data-testid="conversation-turn-2">
        <div data-message-author-role="assistant">Old ChatGPT answer</div>
        <button id="stale-reply-copy" aria-label="复制回复" data-testid="copy-turn-action-button">old copy</button>
      </section>
      <section data-turn="assistant" data-testid="conversation-turn-3">
        <div data-message-author-role="assistant">Latest answer without labeled copy</div>
        <div role="group" aria-label="回复操作">
          <button id="fallback-first">first bottom action</button>
          <button id="fallback-second">second bottom action</button>
        </div>
      </section>
    </main>
    <script>
      window.staleReplyClicked = false;
      window.secondFallbackClicked = false;
      document.querySelector('#stale-reply-copy').onclick = () => { window.staleReplyClicked = true; };
      document.querySelector('#fallback-second').onclick = () => { window.secondFallbackClicked = true; };
      ${copyHandler('# ChatGPT fallback Markdown\n\n- bottom first button')}
      document.querySelector('#fallback-first').onclick = copyMarkdown;
    </script>
  </body></html>`;
  await secondView.webContents.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(chatGptFallbackHtml)}`,
  );
  const fallbackState = await secondView.webContents.executeJavaScript(
    `(${__test.readChatStateInPage.toString()})('chatgpt', 'test prompt')`, true,
  );
  assert.equal(fallbackState.copyReady, true, JSON.stringify(fallbackState));
  const fallbackCopy = await __test.copyLatestAnswerMarkdown(secondView.webContents, 'chatgpt');
  assert.equal(fallbackCopy.ok, true, JSON.stringify(fallbackCopy));
  assert.equal(fallbackCopy.content, '# ChatGPT fallback Markdown\n\n- bottom first button');
  assert.match(fallbackCopy.buttonLabel, /bottom assistant action row button 1/);
  assert.deepEqual(
    await secondView.webContents.executeJavaScript(
      '({ stale: window.staleReplyClicked, second: window.secondFallbackClicked })',
    ), { stale: false, second: false },
    'ChatGPT fallback must ignore stale reply copy and click the bottom row first button',
  );
  assert.equal(clipboard.readText(), '用户原剪贴板');

  assert.ok(result.durationMs >= 1500, JSON.stringify(result));
  assert.equal(result.validation?.complete, true, JSON.stringify(result.validation));
  assert.ok(result.pageDump?.assistantNodes?.length >= 2, 'completion dump missing assistant nodes');
  assert.ok(result.pageDump.assistantNodes.some(node => node.outerHTML.includes('GitHub +1')));
  assert.equal(result.model, 'GPT-5');
  const archiveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-chat-mhtml-'));
  const archivePath = path.join(archiveDir, 'complete-page.mhtml');
  await view.webContents.savePage(archivePath, 'MHTML');
  assert.ok(fs.statSync(archivePath).size > 500, 'MHTML archive is unexpectedly small');
  assert.match(fs.readFileSync(archivePath, 'utf8').slice(0, 500), /Saved by Blink|Snapshot-Content-Location|MIME-Version|multipart\/related/i);
  fs.rmSync(archiveDir, { recursive: true, force: true });
  const newChat = await startNewWebChat(view);
  assert.equal(newChat.ok, true, JSON.stringify(newChat));
  assert.equal(await view.webContents.executeJavaScript('window.newChatClicked'), true);
  console.log('electron_web_chat_dom=passed');
  secondWin.destroy();
  win.destroy();
  app.quit();
}).catch(error => {
  console.error(error);
  app.exit(1);
});
