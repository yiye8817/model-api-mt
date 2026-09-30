'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const { createLogger, diskSecrets, lineSink } = require('../electron/diagnostics.cjs');

const ROOT = path.resolve(__dirname, '..');
const NO_SANDBOX_WARNING = '兼容模式：已禁用 Chromium 所有进程的沙箱，网页进程隔离保护会降低；不建议用于日常网页登录。contextIsolation 等设置不能替代进程沙箱。\n';
const SANDBOX_HELP = '\n系统未允许 Electron 使用当前沙箱机制。无需 root 的兼容启动命令：\n  ./run.sh --skip-install -- --no-sandbox\n此命令会关闭 Chromium 所有进程的沙箱，降低网页进程隔离保护；不建议用于日常网页登录。启动器不会自动降级。\n';

// Chromium treats these switches as present even when written --name=false.
function hasSwitch(args, name) {
  return args.some(arg => arg === `--${name}` || arg.startsWith(`--${name}=`));
}

function buildLaunchPlan({ args = [], platform = process.platform, uid = process.getuid?.() } = {}) {
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) throw new Error('Electron 参数必须是字符串数组。');
  if (platform === 'linux' && uid === 0) throw new Error('请用普通桌面用户启动应用；不要使用 root 或 sudo 运行浏览器。');
  const noSandbox = hasSwitch(args, 'no-sandbox');
  if (noSandbox && hasSwitch(args, 'enable-sandbox')) throw new Error('--no-sandbox 与 --enable-sandbox 不能同时使用。');
  const flags = [...args];
  if (platform === 'linux' && !noSandbox && !hasSwitch(flags, 'disable-setuid-sandbox')) flags.unshift('--disable-setuid-sandbox');
  return { args: ['.', ...flags], noSandbox };
}

function isSandboxFailure(text) {
  return /No usable sandbox|SUID sandbox helper|setuid_sandbox_host|Failed to (?:move to|create)[^\n]*namespace|user.?namespaces?[^\n]*(?:Operation not permitted|Permission denied)|(?:Operation not permitted|Permission denied)[^\n]*user.?namespaces?|zygote_host_impl[^\n]*(?:Operation not permitted|Permission denied)/i.test(text);
}

async function launch({ args = [], processLike = process, spawnChild = spawn, electronPath, root = ROOT, diagnostics } = {}) {
  let plan, executable;
  try {
    plan = buildLaunchPlan({ args, platform: processLike.platform, uid: processLike.getuid?.() });
    executable = electronPath || require('electron');
  } catch (error) {
    if (diagnostics) diagnostics('launcher_error', { detail: error.message });
    else processLike.stderr.write(`启动失败：${error.message}\n`);
    return { code: 1, signal: null };
  }
  if (plan.noSandbox) processLike.stderr.write(NO_SANDBOX_WARNING);
  diagnostics?.('launcher_start', { pid: processLike.pid, node: process.versions.node, no_sandbox: plan.noSandbox, rootless: !plan.noSandbox && processLike.platform === 'linux' });

  return new Promise(resolve => {
    let child, complete = false, tail = '', sandboxFailure = false;
    const diagnosticSink = diagnostics && lineSink(line => {
      try {
        const record = JSON.parse(line);
        if (['electron', 'backend'].includes(record.component) && record.time && record.event) { diagnostics.forward(line); return; }
      } catch {}
      if (line.trim()) diagnostics('native_stderr', { detail: line }, 'warn');
    });
    const forwardInterrupt = () => { if (child && !complete) child.kill('SIGINT'); };
    const forwardTerminate = () => { if (child && !complete) child.kill('SIGTERM'); };
    const finish = (code, signal) => {
      if (complete) return;
      complete = true;
      diagnosticSink?.end();
      processLike.removeListener('SIGINT', forwardInterrupt);
      processLike.removeListener('SIGTERM', forwardTerminate);
      if ((code !== 0 || signal) && sandboxFailure && !plan.noSandbox) processLike.stderr.write(SANDBOX_HELP);
      diagnostics?.('launcher_exit', { code, signal, sandbox_failure: sandboxFailure });
      resolve({ code: code ?? null, signal: signal || null });
    };
    try {
      child = spawnChild(executable, plan.args, { cwd: root, env: processLike.env, stdio: ['inherit', 'inherit', 'pipe'] });
      processLike.on('SIGINT', forwardInterrupt);
      processLike.on('SIGTERM', forwardTerminate);
      child.stderr?.on('data', chunk => {
        // Forward diagnostics unchanged; retain only a small in-memory window
        // for matching an error split across chunks. Never save stderr to disk.
        if (diagnosticSink) diagnosticSink.write(chunk);
        else processLike.stderr.write(chunk);
        const diagnostics = tail + chunk.toString();
        sandboxFailure ||= isSandboxFailure(diagnostics);
        tail = diagnostics.slice(-8192);
      });
      child.once('error', error => {
        if (diagnostics) diagnostics('launcher_spawn_error', { detail: error.message });
        else processLike.stderr.write(`Electron 启动失败：${error.message}\n`);
        finish(1, null);
      });
      // 'close' follows stderr draining; 'exit' can precede the final error text.
      child.once('close', finish);
    } catch (error) {
      if (diagnostics) diagnostics('launcher_spawn_error', { detail: error.message });
      else processLike.stderr.write(`Electron 启动失败：${error.message}\n`);
      finish(1, null);
    }
  });
}

if (require.main === module) {
  const diagnostics = createLogger({ component: 'launcher', getSecrets: () => diskSecrets() });
  process.env.FUSION_LOG_DIR = diagnostics.directory;
  launch({ args: process.argv.slice(2), diagnostics }).then(({ code, signal }) => {
    if (signal) {
      try { process.kill(process.pid, signal); }
      catch { process.exitCode = 128 + (require('node:os').constants.signals[signal] || 1); }
    } else process.exitCode = code ?? 1;
  }).catch(error => {
    process.stderr.write(`启动失败：${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { buildLaunchPlan, hasSwitch, isSandboxFailure, launch };
