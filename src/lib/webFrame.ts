/** 常见聊天/登录站几乎都禁 iframe。 */
const LIKELY_BLOCKED_HOST =
  /(^|\.)(deepseek\.com|openai\.com|chatgpt\.com|claude\.ai|anthropic\.com|gemini\.google\.com|google\.com|bing\.com|microsoft\.com|github\.com|gitlab\.com|notion\.so|slack\.com|discord\.com|x\.com|twitter\.com|facebook\.com|meta\.com)$/i;

export function normalizeHttpUrl(url: string): string {
  let href = url.trim();
  if (!href) return '';
  if (!/^https?:\/\//i.test(href)) href = `https://${href}`;
  return href;
}

export function hostOfUrl(url: string): string {
  try { return new URL(normalizeHttpUrl(url)).hostname; } catch { return ''; }
}

/** 是否极可能禁止被 iframe 嵌入（可在点击回调里同步判断，以便立刻 window.open）。 */
export function isLikelyFrameBlocked(url: string): boolean {
  const host = hostOfUrl(url);
  return !!host && LIKELY_BLOCKED_HOST.test(host);
}
