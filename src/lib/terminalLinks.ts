import type { IBuffer, ILink, IDisposable, ILinkHandler } from 'xterm';

export type TerminalTextLink = { text: string; start: number; end: number; kind: 'url' | 'path' };

// Keep URL and path detection in one place so every xterm-backed surface has
// identical behavior (Codex, Desktop Agent, Hermes, Claude Code, and the dock
// terminal). Match path-shaped tokens rather than generic non-whitespace text
// so prose and Markdown wrappers stay outside the link range.
const TERMINAL_TARGET_PATTERN = /https?:\/\/[^\s<>"'`()\[\]]+|file:\/\/[^\s<>"'`()\[\]]+|(["'])(?:\\.|(?!\1)[^\\\r\n])*\1|(?:~[\\/]|\.{1,2}[\\/]|[\\/]|[A-Za-z]:[\\/]|\\\\)[^\s<>"'`()\[\]]+|(?:[^\s<>"'`()\[\]\/\\]+\.[A-Za-z][A-Za-z0-9_-]{0,19})(?::\d+(?::\d+)?)?(?=$|[\s.,;:!?)}\]}>])|(?:[^\s<>"'`()\[\]\/\\]+[\\/])[^\s<>"'`()\[\]]+|(?:README|LICENSE|Makefile|Dockerfile|Procfile|Gemfile|Rakefile|justfile|\.env(?:\.[\w-]+)?|(?:go|go\.mod|go\.sum|Cargo\.toml|pyproject\.toml|requirements\.txt))(?=$|[\s.,;:!?)}\]}>])/gi;

function trimTarget(value: string): string {
  let target = value;
  if ((target.startsWith('"') || target.startsWith("'")) && target.endsWith(target[0])) target = target.slice(1, -1);
  target = target.replace(/^[([{<]+/, '');
  return target.replace(/[.,;:!?)}\]}>]+$/, '');
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function isPath(value: string): boolean {
  if (!value || isHttpUrl(value)) return false;
  if (/^file:\/\//i.test(value)) return true;
  if (/^(?:~[\\/]|\.{1,2}[\\/]|[\\/]|[A-Za-z]:[\\/]|\\\\)/.test(value)) return true;
  if (/^[^\s<>"'`()\[\]\/\\]+[\\/][^\\/]/.test(value)) return true;
  if (/(?:^|[\\/])[^\\/\s]+\.[A-Za-z][A-Za-z0-9_-]{0,19}$/.test(value)) return true;
  return /^(?:README|LICENSE|Makefile|Dockerfile|Procfile|Gemfile|Rakefile|justfile|\.env(?:\.[\w-]+)?|go(?:\.mod|\.sum)?|Cargo\.toml|pyproject\.toml|requirements\.txt)$/i.test(value);
}

function normalizePath(value: string): string {
  let target = trimTarget(value);
  if (!target || isHttpUrl(target)) return target;
  // Compiler and test-runner suffixes are metadata, not part of the path.
  target = target.replace(/:(\d+)(?::\d+)?$/, '');
  target = target.replace(/#L\d+(?:-L\d+)?$/, '');
  return target;
}

/** Find clickable targets in plain PTY output, including JSON string values. */
export function findTerminalTextLinks(text: string): TerminalTextLink[] {
  const links: TerminalTextLink[] = [];
  TERMINAL_TARGET_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(TERMINAL_TARGET_PATTERN)) {
    const raw = match[0];
    const quoted = (raw.startsWith('"') || raw.startsWith("'")) && raw.endsWith(raw[0]);
    const inner = quoted ? raw.slice(1, -1) : raw;
    let target = trimTarget(inner);
    if (!target) continue;
    const offset = inner.indexOf(target);
    const start = (match.index ?? 0) + (quoted ? 1 : 0) + Math.max(0, offset);
    const kind = isHttpUrl(target) ? 'url' : 'path';
    if (kind === 'path') target = normalizePath(target);
    if (!target || (kind === 'path' && !isPath(target))) continue;
    links.push({ text: target, start, end: start + target.length, kind });
  }
  return links;
}

/** Xterm asks per physical row; reconstruct its soft-wrapped logical line. */
export function terminalLinksForLine(
  buffer: IBuffer,
  cols: number,
  bufferLineNumber: number,
  activate: (event: MouseEvent, link: TerminalTextLink) => void,
): ILink[] {
  if (cols <= 0 || !buffer.getLine(bufferLineNumber - 1)) return [];
  let first = bufferLineNumber - 1;
  while (first > 0 && buffer.getLine(first)?.isWrapped && bufferLineNumber - first < 32) first--;
  let last = bufferLineNumber - 1;
  while (last + 1 < buffer.length && buffer.getLine(last + 1)?.isWrapped && last - first < 32) last++;
  const rows: string[] = [];
  for (let row = first; row <= last; row++) {
    const line = buffer.getLine(row);
    if (!line) break;
    rows.push(line.translateToString(row === last));
  }
  const combined = rows.join('');
  if (combined.length > 8192) return [];
  return findTerminalTextLinks(combined).flatMap(link => {
    const startRow = Math.floor(link.start / cols);
    const endRow = Math.floor((link.end - 1) / cols);
    const requestedRow = bufferLineNumber - first - 1;
    if (startRow > requestedRow || endRow < requestedRow) return [];
    return [{
      text: link.text,
      range: {
        start: { x: link.start % cols + 1, y: first + startRow + 1 },
        end: { x: (link.end - 1) % cols + 1, y: first + endRow + 1 },
      },
      decorations: { pointerCursor: true, underline: true },
      activate: (event: MouseEvent) => activate(event, link),
    }];
  });
}

interface TerminalLinkProviderHost {
  cols: number;
  buffer: { active: IBuffer };
  registerLinkProvider: (provider: {
    provideLinks: (line: number, callback: (links: ILink[] | undefined) => void) => void;
  }) => IDisposable;
}

/** Register the shared provider and gate activation on Ctrl/Cmd. */
export function registerTerminalLinkProvider(
  term: TerminalLinkProviderHost,
  activate: (link: TerminalTextLink) => void,
): IDisposable {
  return term.registerLinkProvider({
    provideLinks: (lineNumber, callback) => {
      callback(terminalLinksForLine(term.buffer.active, term.cols, lineNumber, (event, link) => {
        // A normal click remains terminal text selection. Ctrl (Cmd on macOS)
        // is the explicit open gesture for every virtual terminal.
        if (!event.ctrlKey && !event.metaKey) return;
        activate(link);
      }));
    },
  });
}

/** Gate xterm's built-in OSC-8 links on the same Ctrl/Cmd gesture. */
export function terminalLinkHandler(activate: (target: string) => void): ILinkHandler {
  return {
    // The callback still validates the protocol/path before opening it; this
    // lets explicit file:// hyperlinks use the same path opener as plain text.
    allowNonHttpProtocols: true,
    activate: (event, target) => {
      if (!event.ctrlKey && !event.metaKey) return;
      activate(target);
    },
  };
}
