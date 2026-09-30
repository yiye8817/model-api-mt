'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const SENSITIVE = /^(?:prompt|messages?|content|markdown|html|text|cookies?|authorization|password|api[_-]?key|token|secret|localStorage|storage)$/i;

function redactText(value, secrets = []) {
  let result = String(value);
  for (const secret of [...new Set(secrets.filter(s => typeof s === 'string' && s.length))].sort((a, b) => b.length - a.length)) {
    result = result.split(secret).join('[REDACTED]');
    const escaped = JSON.stringify(secret).slice(1, -1);
    if (escaped !== secret) result = result.split(escaped).join('[REDACTED]');
  }
  return result
    .replace(/(Bearer\s+)[^\s'"<>]+/gi, '$1[REDACTED]')
    .replace(/((?:set-cookie|cookie|authorization)\s*:\s*)[^\r\n]+/gi, '$1[REDACTED]')
    .replace(/(\b[a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/([?&](?:api[_-]?key|access[_-]?token|token|key|secret|auth|code|password)=)[^&\s'"<>]+/gi, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|password|secret|token)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,&;}]+)/gi, '$1"[REDACTED]"');
}

function sanitize(value, secrets = [], depth = 0) {
  if (depth > 6) return '[TRUNCATED]';
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return redactText(value, secrets).slice(0, 2000);
  if (Array.isArray(value)) return value.slice(0, 40).map(item => sanitize(item, secrets, depth + 1));
  if (value && typeof value === 'object') {
    const result = {};
    for (const [key, item] of Object.entries(value).slice(0, 80)) {
      if (item === undefined) continue;
      result[key] = SENSITIVE.test(key) ? '[REDACTED]' : sanitize(item, secrets, depth + 1);
    }
    return result;
  }
  return String(value);
}

// Only explicit payload fields contain requested conversation/operation details.
// Credentials stay redacted even when content tracing is enabled.
function sanitizePayload(value, secrets = [], depth = 0) {
  if (depth > 24) return '[DEPTH_LIMIT]';
  if (typeof value === 'string') return redactText(value, secrets);
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (Array.isArray(value)) return value.map(item => sanitizePayload(item, secrets, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
      /^(?:authorization|proxy-authorization|headers|cookies?|password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|localStorage)$/i.test(key)
        ? '[REDACTED]' : sanitizePayload(item, secrets, depth + 1)]));
  }
  return String(value);
}

function diskSecrets(env = process.env) {
  const data = path.resolve(env.FUSION_DATA_DIR || path.join(os.homedir(), '.local/share/multillm-fusion'));
  const values = [env.FUSION_TOKEN];
  for (const [filename, parse] of [
    ['api-key.txt', text => text.trim()],
    ['config.json', text => JSON.parse(text).fusion?.api_key],
  ]) {
    try {
      const file = path.join(data, filename);
      const stat = fs.lstatSync(file);
      if (!stat.isSymbolicLink() && stat.isFile() && stat.size <= 4 * 1024 * 1024) values.push(parse(fs.readFileSync(file, 'utf8')));
    } catch {}
  }
  return values.filter(value => typeof value === 'string' && value.length);
}

function createLogger({ component = 'electron', filename = `${component}.log`, directory = process.env.FUSION_LOG_DIR || path.join(ROOT, 'logs'),
  getSecrets = () => [], terminal = line => process.stderr.write(line), maxBytes = 5 * 1024 * 1024, backups = 3,
  content = !['0', 'false', 'off'].includes((process.env.FUSION_LOG_CONTENT || '').toLowerCase()), maxContentChars = 2000000, chunkChars = 8192 } = {}) {
  const folder = path.resolve(directory);
  if (path.basename(filename) !== filename) throw new Error('Invalid diagnostic log filename');
  const file = path.join(folder, filename);
  let warned = false;
  const secretValues = () => { try { return getSecrets().filter(Boolean); } catch { return []; } };
  function append(line) {
    try {
      fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
      if (!fs.lstatSync(folder).isDirectory() || fs.lstatSync(folder).isSymbolicLink()) throw Object.assign(new Error('Invalid log directory'), { code: 'ELOOP' });
      let size = 0;
      try { const stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink()) throw Object.assign(new Error('Invalid log file'), { code: 'ELOOP' }); size = stat.size; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (size && size + Buffer.byteLength(line) > maxBytes) {
        for (let index = backups; index >= 1; index--) {
          const from = index === 1 ? file : `${file}.${index - 1}`;
          const to = `${file}.${index}`;
          try { fs.renameSync(from, to); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
      }
      const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW || 0), 0o600);
      try { fs.fchmodSync(fd, 0o600); fs.writeSync(fd, line); } finally { fs.closeSync(fd); }
    } catch (error) {
      if (!warned) { warned = true; terminal(`[fusion] 日志文件写入失败 (${error.code || 'log_error'})，终端日志继续输出。\n`); }
    }
  }
  const log = (event, fields = {}, level) => {
    const secrets = secretValues();
    const { payload, ...metadata } = fields;
    const cleaned = sanitize(metadata, secrets);
    const record = { ...cleaned, time: new Date().toISOString(), component,
      level: level || (/error|fail|timeout|gone/.test(event) ? 'error' : 'info'), event: redactText(event, secrets).slice(0, 100) };
    let records = [record];
    if (payload !== undefined) {
      if (!content) record.payload_omitted = true;
      else {
        let serialized;
        try { serialized = JSON.stringify(sanitizePayload(payload, secrets)); }
        catch { serialized = JSON.stringify({ error: 'payload_not_serializable' }); }
        const chars = serialized.length;
        serialized = serialized.slice(0, Math.max(1, maxContentChars));
        const parts = Math.max(1, Math.ceil(serialized.length / Math.max(1, chunkChars)));
        const payloadId = require('node:crypto').randomUUID();
        records = Array.from({ length: parts }, (_, index) => ({ ...record, payload_id: payloadId, part: index + 1, parts,
          chars, truncated: chars > serialized.length, payload: serialized.slice(index * chunkChars, (index + 1) * chunkChars) }));
      }
    }
    for (const row of records) {
      const line = JSON.stringify(row) + '\n';
      terminal(line);
      append(line);
    }
  };
  // Callers only forward already-sanitized structured records from our backend
  // or Electron child; processing a JSON payload chunk again could corrupt it.
  log.forward = line => terminal(String(line).replace(/\n?$/, '\n'));
  log.file = file;
  log.directory = folder;
  return log;
}

function lineSink(onLine, maxLength = 131072) {
  let buffer = '', dropping = false;
  const { StringDecoder } = require('node:string_decoder');
  const decoder = new StringDecoder('utf8');
  function feed(text) {
    for (const part of text.match(/[^\n]*\n|[^\n]+$/g) || []) {
      const complete = part.endsWith('\n');
      if (!dropping) buffer += complete ? part.slice(0, -1) : part;
      if (buffer.length > maxLength) { buffer = ''; dropping = true; }
      if (complete) {
        onLine(dropping ? '[oversized diagnostic line omitted]' : buffer.replace(/\r$/, ''));
        buffer = ''; dropping = false;
      }
    }
  }
  return { write: chunk => feed(typeof chunk === 'string' ? chunk : decoder.write(chunk)), end: () => {
    feed(decoder.end());
    if (buffer || dropping) onLine(dropping ? '[oversized diagnostic line omitted]' : buffer);
    buffer = ''; dropping = false;
  } };
}

module.exports = { createLogger, redactText, sanitize, sanitizePayload, diskSecrets, lineSink };
