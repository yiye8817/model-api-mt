'use strict';
// Inspect only a known generation response envelope, never model-authored text.
// No payload contents are returned to diagnostics or used as instructions.
const LIMIT = 262144;
function responseError(body, mime = '') {
  if (typeof body !== 'string' || body.length > LIMIT) return null;
  const classify = (value, event = '') => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    // Text/choices are successful generated data even if they quote JSON errors.
    if (Array.isArray(value.choices) && value.choices.length || typeof value.content === 'string' || typeof value.text === 'string') return null;
    const objectError = typeof value.error === 'string' ? Boolean(value.error.trim()) : value.error && typeof value.error === 'object' && !Array.isArray(value.error) && ['code','status','status_code','message','type'].some(k => value.error[k] !== undefined && value.error[k] !== null && value.error[k] !== '');
    const failed = objectError || value.success === false || value.status === 'error' || value.type === 'error' || event === 'error';
    if (!failed) return null;
    const info = value.error && typeof value.error === 'object' && !Array.isArray(value.error) ? value.error : value;
    const candidate = Number(info.status || info.status_code || info.code || value.code);
    return { code: 'response_application_error', ...(Number.isInteger(candidate) && candidate >= 400 && candidate <= 599 ? { status: candidate } : {}),
      evidence: event === 'error' ? 'sse_error_event' : 'error_envelope' };
  };
  const raw = body.trim();
  try { const found = classify(JSON.parse(raw)); if (found) return found; } catch {}
  if (/event-stream/i.test(mime) || /^(?:event:|data:)/.test(raw)) {
    for (const frame of raw.replace(/\r\n?/g, '\n').split('\n\n').slice(0, 1024)) {
      const lines = frame.split('\n');
      const event = lines.find(line => line.startsWith('event:'))?.slice(6).trim();
      const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (!data || data === '[DONE]') continue;
      try { const found = classify(JSON.parse(data), event); if (found) return found; } catch {}
    }
  }
  return null;
}
module.exports = { responseError, RESPONSE_ERROR_LIMIT: LIMIT };
