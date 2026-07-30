/**
 * 启动 Claude Code 前的版本检测与自动更新。
 * 失败时不抛错、不阻塞启动，仅通过 onMsg 反馈进度。
 */
export async function ensureClaudeLatest(onMsg: (s: string) => void): Promise<void> {
  try {
    onMsg('检测 Claude Code 版本…');
    const r = await fetch('/api/claude/version-check')
      .then((x) => (x.ok ? x.json() : null))
      .catch(() => null);

    if (!r || !r.cli) {
      onMsg('');
      return;
    }
    if (r.latest && r.current && !r.upToDate) {
      onMsg(`发现新版本 ${r.latest}（当前 ${r.current}），正在更新…`);
      const u = await fetch('/api/claude/update', { method: 'POST' })
        .then((x) => (x.ok ? x.json() : null))
        .catch(() => null);
      if (u?.ok) onMsg(`已更新到 ${u.version || '最新版本'}`);
      else onMsg(u?.hint || `自动更新失败，将以当前版本 ${r.current} 启动`);
    } else if (r.current) {
      onMsg(`已是最新版本 ${r.current}`);
    } else {
      onMsg('');
    }
  } catch {
    onMsg('');
  }
}
