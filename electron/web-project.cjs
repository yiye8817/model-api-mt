'use strict';

function buildProjectPrompt(goal, language, environment) {
  return [
    '请实现下面的软件项目，并给出完整、可在本机运行的工程。',
    `目标：${goal}`,
    `语言：${language}；运行环境：${environment}。`,
    '输出一个完整 Markdown 文档，说明方案和目录结构，然后逐个输出所有文件。',
    '每个文件使用标题 “## File: 相对路径”，紧跟对应语言代码围栏；不要省略内容。',
    '路径保持项目真实结构，只使用相对路径；依赖清单、构建配置、测试也作为文件输出。',
    '不要把安装或启动命令混入源文件。最后输出 ```workbench-project 代码块，内容是 JSON：',
    '{"language":"python|node|bash|c|cpp|java|go|rust|html","entry":"入口相对路径","run_cmd":"从项目根目录运行的命令","deps":[]}',
    'run_cmd 需要安装依赖时包含安装步骤；Python 使用项目 .venv-run，编译语言先编译所有模块再运行。',
    '包含可执行的验收方式；命令行程序给出实际输出；网页项目使用本地端口并打印完整 http://127.0.0.1:端口 地址。',
    '如果本轮收到执行错误，请返回完整修复版 Markdown 和全部文件，保留原需求及上述格式。',
  ].join('\n');
}

function extractMarkdownCodeBlocks(markdown) {
  const aliases = {
    python: 'python', py: 'python', python3: 'python',
    javascript: 'javascript', js: 'javascript', node: 'javascript',
    typescript: 'javascript', ts: 'javascript',
    bash: 'bash', sh: 'bash', shell: 'bash', zsh: 'bash',
    c: 'c', cpp: 'cpp', 'c++': 'cpp', cxx: 'cpp',
    java: 'java', go: 'go', golang: 'go', rust: 'rust', rs: 'rust',
    ruby: 'ruby', rb: 'ruby', php: 'php', html: 'html', htm: 'html',
  };
  const infer = code => {
    if (/^#!.*\bpython(?:3)?\b/m.test(code) || /^(?:from\s+\w[\w.]*\s+import|import\s+\w)/m.test(code) || /\bdef\s+\w+\s*\([^)]*\)\s*:/m.test(code)) return 'python';
    if (/^#!.*\b(?:ba)?sh\b/m.test(code) || /\b(?:echo|printf)\s+.+\n/.test(code)) return 'bash';
    if (/\b(?:console\.log|const|let|var)\s+/.test(code)) return 'javascript';
    if (/<(?:!doctype\s+html|html|head|body)\b/i.test(code)) return 'html';
    if (/^\s*#include\s*[<"](?:iostream|vector|string|cstdio|cstdlib)/m.test(code)) return 'cpp';
    if (/^\s*#include\s*[<"](?:stdio|stdlib|string)\.h[>]/m.test(code)) return 'c';
    if (/\bpublic\s+(?:final\s+|abstract\s+)?class\s+[A-Z]\w*/.test(code) && /\bstatic\s+void\s+main\s*\(/.test(code)) return 'java';
    if (/^\s*package\s+main\b/m.test(code) && /\bfunc\s+main\s*\(/.test(code)) return 'go';
    if (/\bfn\s+main\s*\(/.test(code) && /(?:println!|use\s+[A-Za-z_])/.test(code)) return 'rust';
    return '';
  };
  const source = String(markdown || '');
  const fence = /```[ \t]*([^\n`]*)\n([\s\S]*?)```/g;
  const blocks = [];
  let match;
  while ((match = fence.exec(source))) {
    const info = String(match[1] || '').trim();
    const content = String(match[2] || '').replace(/\n$/, '');
    const tokens = info.split(/\s+/).filter(Boolean);
    const raw = String(tokens[0] || '').toLowerCase().replace(/^language-/, '');
    if (raw === 'workbench-project' || raw === 'project-config' || raw === 'json') continue;
    const language = aliases[raw] || infer(content);
    if (!language || !content.trim()) continue;
    const path = tokens.slice(1).find(token => /[./\\]/.test(token)) || '';
    blocks.push({
      index: blocks.length + 1,
      language,
      code: content,
      info,
      path,
      label: path ? `${language} · ${path}` : `${language} · 代码块 ${blocks.length + 1}`,
    });
  }
  return blocks;
}

/** Runs in the native page. A shadow root keeps wizard inputs out of chat selectors. */
function installProjectWizardInPage() {
  const existing = document.getElementById('workbench-project-wizard');
  if (existing?.shadowRoot) {
    existing.style.display = 'block';
    existing.shadowRoot.querySelector('[data-body]').hidden = false;
    return { ok: true };
  }
  const bridge = window.__workbenchRunCode;
  if (!bridge?.project) return { ok: false, error: '请完全退出并重启桌面应用，加载网页执行桥。' };
  const host = document.createElement('div');
  host.id = 'workbench-project-wizard';
  host.style.cssText = 'position:fixed;right:16px;top:18px;width:min(430px,calc(100vw - 32px));z-index:2147483647;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      :host{font:13px system-ui,sans-serif;color:#e2e8f0}*{box-sizing:border-box}
      section{background:#111827;border:1px solid #475569;border-radius:10px;box-shadow:0 8px 28px #0008}
      header{display:flex;align-items:center;gap:8px;padding:10px;cursor:move;border-bottom:1px solid #334155}
      strong{flex:1}button{color:#dbeafe;background:#1e293b;border:1px solid #475569;border-radius:5px;padding:6px 8px;cursor:pointer;font:inherit}
      button:disabled{opacity:.45;cursor:default}button.primary{background:#047857;border-color:#10b981}
      [data-body]{padding:10px;max-height:75vh;overflow:auto}[hidden]{display:none!important}
      label{display:block;margin:8px 0 4px}textarea,select{background:#020617;color:#e2e8f0;border:1px solid #475569;border-radius:5px;padding:7px;font:inherit;width:100%}
      textarea{resize:vertical;min-height:70px}.row{display:flex;gap:8px}.row>*{flex:1}.actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
      p{color:#94a3b8;font-size:12px;margin:6px 0;line-height:1.5}
      [data-status]{padding:8px 10px;color:#67e8f9;font-size:12px;overflow-wrap:anywhere}
      pre{background:#020617;padding:8px;max-height:220px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font:12px monospace}
      a{color:#6ee7b7;overflow-wrap:anywhere}
    </style>
    <section role="dialog" aria-label="网页项目运行向导">
      <header><strong>网页项目运行向导</strong><button data-collapse title="折叠">−</button><button data-close title="关闭">×</button></header>
      <div data-status>当前网页模型生成 → 保存 Markdown → 解析并运行</div>
      <div data-body>
        <label>软件项目目标</label><textarea data-goal placeholder="例如：创建一个待办事项网站，支持保存数据和自动测试"></textarea>
        <div class="row"><div><label>编程语言</label><select data-language><option value="python">Python</option><option value="node">JavaScript / Node.js</option><option value="bash">Shell</option><option value="c">C</option><option value="cpp">C++</option><option value="java">Java</option><option value="go">Go</option><option value="rust">Rust</option><option value="html">HTML</option></select></div>
        <div><label>目标环境</label><select data-environment><option>本机 Linux</option><option>本机 macOS</option><option>本机 Windows / WSL</option><option>Docker（本机需安装 Docker）</option></select></div></div>
        <div class="actions"><button data-build>生成提示词</button></div>
        <label>发送给当前网页模型的提示词（可修改）</label><textarea data-prompt rows="5"></textarea>
        <label><input type="checkbox" data-autofix checked> 失败后回发给当前网页模型修复，最多 3 次</label>
        <div class="actions"><button class="primary" data-send>发送到当前网页并运行</button><button data-save>自动复制当前回答并运行</button><button data-manual>读取剪贴板并运行</button><button data-stop disabled>停止</button></div>
        <p>也可以先在网页回答上手动点击“复制”，再点“读取剪贴板并运行”。</p>
        <div data-block-tools>
          <label>从剪贴板提取代码块（可选择单个代码块执行）</label>
          <div class="actions"><button data-list-blocks>提取代码块</button><select data-block-select disabled><option>请先提取代码块</option></select><button data-run-block disabled>运行所选</button><button data-save-block disabled>保存所选</button></div>
          <pre data-block-output hidden></pre>
        </div>
        <p>生成时自动折叠窗口，网页仍可滚动和输入。运行发生在这台计算机的项目目录中。</p>
        <div data-result></div><pre data-log hidden></pre>
      </div>
    </section>`;
  document.documentElement.appendChild(host);
  const find = selector => root.querySelector(selector);
  const body = find('[data-body]');
  const status = find('[data-status]');
  const log = find('[data-log]');
  const blockSelect = find('[data-block-select]');
  const blockOutput = find('[data-block-output]');
  let blocks = [];
  let requestId = '';
  let busy = false;
  const setBusy = value => {
    busy = value;
    ['[data-send]', '[data-save]', '[data-manual]', '[data-build]', '[data-list-blocks]'].forEach(selector => { find(selector).disabled = value; });
    find('[data-stop]').disabled = !value;
    if (value) {
      find('[data-run-block]').disabled = true;
      find('[data-save-block]').disabled = true;
    } else {
      const hasBlock = !!blocks[Number(blockSelect.value)];
      find('[data-run-block]').disabled = !hasBlock;
      find('[data-save-block]').disabled = !hasBlock;
    }
  };
  // The same template is used by the main process when an empty prompt is submitted.
  const build = () => {
    const goal = find('[data-goal]').value.trim();
    if (!goal) { status.textContent = '请填写软件项目目标'; return ''; }
    const prompt = window.__workbenchBuildProjectPrompt(goal, find('[data-language]').value, find('[data-environment]').value);
    find('[data-prompt]').value = prompt;
    return prompt;
  };
  find('[data-build]').onclick = build;
  find('[data-collapse]').onclick = () => { body.hidden = !body.hidden; };
  find('[data-close]').onclick = () => { host.style.display = 'none'; };
  find('[data-stop]').onclick = () => { void bridge.project({ action: 'stop', requestId }); };
  const showBlockOutput = (value, ok = true) => {
    blockOutput.hidden = false;
    blockOutput.style.color = ok ? '#a7f3d0' : '#fecdd3';
    blockOutput.textContent = String(value || (ok ? '执行成功（无输出）' : '执行失败'));
  };
  const refreshBlocks = async () => {
    blockOutput.hidden = false;
    blockOutput.textContent = '正在读取系统剪贴板…';
    const result = await bridge.project({ action: 'list-clipboard-blocks' });
    if (!result.ok) {
      blocks = [];
      blockSelect.replaceChildren(new Option(result.error || '没有找到代码块', ''));
      blockSelect.disabled = true;
      find('[data-run-block]').disabled = true;
      find('[data-save-block]').disabled = true;
      showBlockOutput(result.error, false);
      return;
    }
    blocks = Array.isArray(result.blocks) ? result.blocks : [];
    blockSelect.replaceChildren(...blocks.map((block, index) => new Option(block.label, String(index))));
    blockSelect.disabled = blocks.length === 0;
    find('[data-run-block]').disabled = blocks.length === 0;
    find('[data-save-block]').disabled = blocks.length === 0;
    showBlockOutput(blocks.length ? `已提取 ${blocks.length} 个代码块，请选择一个执行。` : '剪贴板中没有识别到可执行代码块。', !!blocks.length);
  };
  blockSelect.onchange = () => {
    const block = blocks[Number(blockSelect.value)];
    if (block) showBlockOutput(`${block.label}\n\n${block.code}`);
  };
  const runSelectedBlock = async action => {
    const block = blocks[Number(blockSelect.value)];
    if (!block) return;
    find('[data-run-block]').disabled = true;
    find('[data-save-block]').disabled = true;
    showBlockOutput(action === 'run-block' ? '正在本地执行所选代码块…' : '正在保存所选代码块…');
    try {
      const result = await bridge.project({ action, code: block.code, language: block.language });
      const output = result.output || result.error || (result.file && (result.file.path || result.file.name)) || '';
      showBlockOutput(output, result.ok !== false && (!result.exit_code || result.exit_code === 0));
    } catch (error) {
      showBlockOutput(String(error?.message || error), false);
    } finally {
      if (!busy) {
        find('[data-run-block]').disabled = false;
        find('[data-save-block]').disabled = false;
      }
    }
  };
  find('[data-list-blocks]').onclick = () => { void refreshBlocks(); };
  find('[data-run-block]').onclick = () => { void runSelectedBlock('run-block'); };
  find('[data-save-block]').onclick = () => { void runSelectedBlock('save-block'); };
  let drag = null;
  const header = find('header');
  header.addEventListener('pointerdown', event => {
    if (event.target.closest('button')) return;
    const rect = host.getBoundingClientRect();
    drag = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    header.setPointerCapture(event.pointerId);
  });
  header.addEventListener('pointermove', event => {
    if (!drag) return;
    host.style.right = 'auto';
    host.style.left = Math.max(0, Math.min(innerWidth - host.offsetWidth, event.clientX - drag.x)) + 'px';
    host.style.top = Math.max(0, Math.min(innerHeight - 45, event.clientY - drag.y)) + 'px';
  });
  header.addEventListener('pointerup', () => { drag = null; });
  const unsubscribe = bridge.onProjectProgress(event => {
    if (event.requestId !== requestId) return;
    status.textContent = event.message;
    log.hidden = false;
    log.textContent = (log.textContent + '\n' + event.message + (event.output ? '\n' + event.output : '')).slice(-18000);
  });
  window.addEventListener('pagehide', unsubscribe, { once: true });
  const start = async action => {
    if (busy) return;
    const prompt = find('[data-prompt]').value.trim() || (action === 'generate' ? build() : '');
    if (action === 'generate' && !prompt) return;
    requestId = 'project-' + Date.now() + '-' + Math.random().toString(36).slice(2);
    setBusy(true);
    body.hidden = true;
    status.textContent = action === 'generate' ? '正在发送到当前网页模型…'
      : (action === 'save-clipboard' ? '正在读取手动复制的网页回答…' : '正在点击当前回答的复制按钮…');
    log.textContent = '';
    find('[data-result]').replaceChildren();
    try {
      let result = await bridge.project({
        action, requestId, prompt, goal: find('[data-goal]').value.trim(),
        language: find('[data-language]').value, autoFix: find('[data-autofix]').checked,
      });
      if (action === 'generate' && result.ok) {
        status.textContent = '网页回答已渲染，正在模拟点击保存并解析 Markdown…';
        result = await bridge.project({
          action: 'save-current', requestId, goal: find('[data-goal]').value.trim(),
          language: find('[data-language]').value, autoFix: find('[data-autofix]').checked,
        });
      }
      body.hidden = false;
      status.textContent = result.ok ? (result.running ? '项目服务已启动' : '项目运行完成') : (result.error || '项目执行失败');
      log.hidden = false;
      log.textContent += '\n' + (result.output || result.error || '');
      if (result.markdownFile) {
        const line = document.createElement('p');
        line.textContent = 'Markdown：' + result.markdownFile;
        find('[data-result]').appendChild(line);
      }
      if (result.projectDir) {
        const line = document.createElement('p');
        line.textContent = '项目：' + result.projectDir;
        find('[data-result]').appendChild(line);
      }
      if (result.previewUrl) {
        const open = document.createElement('button');
        open.textContent = '打开项目页面';
        open.onclick = () => { void bridge.project({ action: 'preview' }); };
        find('[data-result]').appendChild(open);
      }
    } catch (error) {
      body.hidden = false;
      status.textContent = String(error?.message || error);
    } finally { setBusy(false); }
  };
  find('[data-send]').onclick = () => { void start('generate'); };
  find('[data-save]').onclick = () => { void start('save-current'); };
  find('[data-manual]').onclick = () => { void start('save-clipboard'); };
  return { ok: true };
}

function wizardScript() {
  return `window.__workbenchBuildProjectPrompt = ${buildProjectPrompt.toString()}; (${installProjectWizardInPage.toString()})()`;
}

/** Native workflow, deliberately independent of provider API credentials. */
async function runWebProject(options, services) {
  const { report, chat, copy, importMarkdown, run, signal } = services;
  let prompt = String(options.prompt || '').trim();
  let project = null;
  let result = null;
  let markdown = '';
  const check = () => {
    if (signal?.aborted) throw new Error('项目流程已停止');
  };
  const maxFixes = options.autoFix === false ? 0 : 3;
  for (let attempt = 0; attempt <= maxFixes; attempt++) {
    check();
    if (options.action === 'save-current' && attempt === 0) {
      report('copying', options.manualClipboard
        ? '正在读取已手动复制的网页回答，取得 Markdown'
        : '正在点击网页回答的复制按钮，取得 Markdown');
      const copied = await copy();
      if (!copied.ok || !copied.content) throw new Error(copied.error || '网页回答复制失败');
      markdown = copied.content;
    } else {
      report('generating', attempt ? `正在让当前网页模型修复（${attempt}/${maxFixes}）` : '正在让当前网页模型生成项目');
      const answer = await chat(prompt);
      check();
      if (!answer.ok || !answer.content) throw new Error(answer.error || '网页模型没有返回项目');
      // Partial or plain DOM text must not be executed as a complete project.
      if (answer.partial || answer.validation?.complete === false) {
        throw new Error('网页回答尚未完整渲染，请等待完成后点击“保存当前回答并运行”。');
      }
      markdown = answer.content;
    }
    check();
    report('saving', '保存 Markdown 并按文件路径解析工程');
    project = await importMarkdown(markdown, project?.slug);
    check();
    if (project.error) {
      result = { exit_code: 1, error: project.error, output: project.error };
    } else {
      report('saved', `Markdown 已保存：${project.markdown_file}`);
      report('parsed', `已解析 ${project.files.length} 个项目文件；开始安装依赖、编译并运行`);
      result = await run(project.slug);
      check();
    }
    if (result.exit_code === 0 || result.running) {
      return {
        ok: true, output: result.output, exitCode: result.exit_code, running: !!result.running,
        markdownFile: project.markdown_file, projectDir: project.dir, slug: project.slug,
        previewUrl: result.preview_url || project.preview_url || '', repairs: attempt,
      };
    }
    report('failed', `编译/运行失败（exit ${result.exit_code}）`, { output: result.output || result.error });
    if (attempt === maxFixes) break;
    prompt = [
      '刚才的软件项目本地解析/编译/运行失败，请保留原目标并修复，返回完整项目的 Markdown。',
      `原目标：${options.goal || options.prompt}`,
      '完整返回所有文件和 workbench-project 运行配置，严格沿用 ## File: 相对路径 格式。',
      `退出码：${result.exit_code}`,
      `错误输出：\n${String(result.output || result.error).slice(-7000)}`,
      '修正代码和依赖清单，安装命令使用项目环境；不要只输出解释或差异。',
    ].join('\n');
  }
  return {
    ok: false, error: result.error || '自动修复后项目仍未运行成功', output: result.output,
    markdownFile: project?.markdown_file, projectDir: project?.dir, slug: project?.slug,
  };
}

module.exports = {
  buildProjectPrompt, extractMarkdownCodeBlocks, wizardScript, runWebProject,
};
