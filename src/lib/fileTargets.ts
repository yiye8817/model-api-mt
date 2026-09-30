/** File types that a normal browser can render as a page or media preview. */
const BROWSER_FILE_EXTENSIONS = new Set([
  '.html', '.htm', '.xhtml', '.pdf',
  '.txt', '.text', '.md', '.markdown', '.log', '.csv', '.json', '.xml',
  '.css', '.js', '.mjs', '.cjs', '.map', '.svg',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.avif',
  '.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac',
  '.mp4', '.webm', '.mov', '.m4v', '.avi',
]);

function stripTargetSuffix(value: string): string {
  return value
    .trim()
    .replace(/[.,;:!?)}\]}>'"]+$/, '')
    .replace(/:(\d+)(?::\d+)?$/, '')
    .replace(/#L\d+(?:-L\d+)?$/, '');
}

/** Return the path portion of a file:// URL, or the original path. */
export function filePathFromTarget(value: string): string {
  const target = stripTargetSuffix(value);
  if (!/^file:\/\//i.test(target)) return target;
  try {
    const parsed = new URL(target);
    if (parsed.hostname && parsed.hostname !== 'localhost') {
      return `//${parsed.hostname}${decodeURIComponent(parsed.pathname)}`;
    }
    return decodeURIComponent(parsed.pathname);
  } catch {
    return target;
  }
}

/** Resolve a terminal-relative path without relying on Node's path module. */
export function resolveFileTarget(target: string, cwd?: string): string {
  const value = filePathFromTarget(target);
  if (!value || /^(?:~[\\/]|[\\/]|[A-Za-z]:[\\/]|\\\\)/.test(value)) return value;
  const base = String(cwd || '').trim();
  if (!base || base === '~') return value;
  return `${base.replace(/[\\/]$/, '')}/${value}`;
}

/** Whether a local file has a browser-renderable extension. */
export function isBrowserOpenableFile(value: string): boolean {
  const target = filePathFromTarget(value).replace(/[\\/]$/, '');
  const name = target.split(/[\\/]/).pop() || '';
  const dot = name.lastIndexOf('.');
  return dot > 0 && BROWSER_FILE_EXTENSIONS.has(name.slice(dot).toLowerCase());
}

/** Build a same-origin URL served by the local filesystem preview endpoint. */
export function browserFileUrl(value: string): string {
  const path = filePathFromTarget(value);
  return new URL(`/api/local/fs/serve?path=${encodeURIComponent(path)}`, window.location.href).toString();
}

export function fileTargetName(value: string): string {
  const path = filePathFromTarget(value).replace(/[\\/]$/, '');
  return path.split(/[\\/]/).pop() || path;
}
