/**
 * Electron 启动器：清理 Cursor/IDE 注入的 ELECTRON_RUN_AS_NODE，
 * 并在 Linux 开发环境加上 --no-sandbox（避免 chrome-sandbox 未正确 setuid）。
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const electronBin = require('electron');
const args = [];

if (process.platform === 'linux') {
  // 未做 setuid 时 Chromium 会直接 abort；开发期允许 --no-sandbox
  const sandbox = path.join(path.dirname(electronBin), 'chrome-sandbox');
  let needNoSandbox = true;
  try {
    const st = fs.statSync(sandbox);
    // setuid root → mode & 04000
    if (st.uid === 0 && (st.mode & 0o4000)) needNoSandbox = false;
  } catch { /* missing */ }
  if (needNoSandbox && !process.argv.includes('--no-sandbox')) {
    args.push('--no-sandbox');
  }
}

args.push(...process.argv.slice(2));
if (!args.includes('.') && !args.some((a) => a.endsWith('main.cjs'))) {
  // 默认加载本项目
  args.push(path.join(__dirname, '..'));
}

const child = spawn(electronBin, args, { stdio: 'inherit', env });
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
