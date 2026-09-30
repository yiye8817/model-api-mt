/**
 * 给 xterm 终端绑定浏览器剪贴板：复制 / 粘贴。
 * - 复制：有选区时 Ctrl/Cmd+C（避免误发中断信号）
 * - 粘贴：Ctrl/Cmd+V、Shift+Insert、右键；优先用原生 paste 事件（HTTP 公网也可用）
 */

type TermLike = {
  getSelection: () => string;
  hasSelection: () => boolean;
  focus: () => void;
  attachCustomKeyEventHandler: (cb: (e: KeyboardEvent) => boolean) => void;
  element?: HTMLElement | null;
};

export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export async function readTextFromClipboard(): Promise<string> {
  try {
    if (navigator.clipboard?.readText) {
      return await navigator.clipboard.readText();
    }
  } catch { /* fall through */ }
  return '';
}

/**
 * @param term xterm Terminal 实例
 * @param sendInput 把粘贴内容写入 PTY（通常走 WebSocket input）
 * @returns 清理函数
 */
export function bindTermClipboard(
  term: TermLike,
  sendInput: (data: string) => void,
  onSelectedContextMenu?: (text: string) => void,
): () => void {
  const isMod = (e: KeyboardEvent) => e.ctrlKey || e.metaKey;

  term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
    if (e.type !== 'keydown') return true;
    const key = e.key.toLowerCase();

    // 有选区时 Ctrl/Cmd+C → 复制（不发给 PTY，避免变成中断）
    if (isMod(e) && key === 'c' && !e.shiftKey && term.hasSelection()) {
      e.preventDefault();
      e.stopPropagation();
      void copyTextToClipboard(term.getSelection());
      return false;
    }

    // Ctrl/Cmd+Shift+C → 强制复制选区
    if (isMod(e) && e.shiftKey && key === 'c' && term.hasSelection()) {
      e.preventDefault();
      e.stopPropagation();
      void copyTextToClipboard(term.getSelection());
      return false;
    }

    // Ctrl/Cmd+V / Ctrl/Cmd+Shift+V：
    // 不 preventDefault，让浏览器触发 paste 事件（HTTP 下 Clipboard API 常不可用）
    // 返回 false 阻止 xterm 把按键当字符处理
    if (isMod(e) && key === 'v') {
      return false;
    }

    // Shift+Insert 粘贴
    if (e.shiftKey && key === 'insert') {
      return false;
    }

    return true;
  });

  const el = term.element;
  if (!el) return () => {};

  // 原生 paste（Ctrl+V / 右键粘贴 / 系统粘贴）—— 公网 HTTP 也可用
  const onPaste = (ev: ClipboardEvent) => {
    const text = ev.clipboardData?.getData('text/plain');
    if (!text) return;
    ev.preventDefault();
    ev.stopPropagation();
    sendInput(text);
  };

  // 右键：有选区时交给调用方分析；无选区则尝试粘贴
  const onContextMenu = (ev: MouseEvent) => {
    ev.preventDefault();
    if (term.hasSelection()) {
      if (onSelectedContextMenu) {
        onSelectedContextMenu(term.getSelection());
        return;
      }
      void copyTextToClipboard(term.getSelection());
      return;
    }
    void (async () => {
      const text = await readTextFromClipboard();
      if (text) sendInput(text);
      else term.focus();
    })();
  };

  el.addEventListener('paste', onPaste, true);
  el.addEventListener('contextmenu', onContextMenu);

  return () => {
    el.removeEventListener('paste', onPaste, true);
    el.removeEventListener('contextmenu', onContextMenu);
  };
}
