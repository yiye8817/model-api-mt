'use strict';

// Preserve a whole JSON reply before HTML-to-Markdown escaping changes [] and
// autolinks. This does not repair syntax, extract actions from prose, or validate
// an Agent action: the Agent still validates duplicate keys and its full schema.
function wholeJSONObject(text) {
  if (typeof text !== 'string') return null;
  const source = text.trim();
  if (!source.startsWith('{') || !source.endsWith('}')) return null;
  try {
    const parsed = JSON.parse(source);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? source : null;
  } catch { return null; }
}

// JSON responses rendered by a web page can arrive as HTML entities, a fenced
// Markdown block, or plain text.  Keep this parser deliberately strict: it
// only accepts one complete JSON value and never extracts an object from prose.
function decodeHTMLText(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/<br\s*\/?>(?:\r?\n)?/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n')
    .replace(/<\/div\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (_match, value) => {
      const code = Number.parseInt(value, 16);
      return Number.isSafeInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : _match;
    })
    .replace(/&#(\d+);/g, (_match, value) => {
      const code = Number.parseInt(value, 10);
      return Number.isSafeInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : _match;
    })
    .replace(/&quot;/gi, '"').replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&');
}

function jsonCandidateText(text) {
  if (typeof text !== 'string') return null;
  let source = text.replace(/^\uFEFF/, '').trim();
  const fence = source.match(/^(`{3,}|~{3,})[ \t]*(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n\1[ \t]*$/i);
  if (fence) source = fence[2].trim();
  if (!source) return null;
  try {
    const value = JSON.parse(source);
    // JSON null/booleans are valid JSON, but a web-model response intended for
    // a structured result must be an object or array.  This also rejects empty
    // values while preserving nested strings and duplicate-key source bytes.
    if (!value || typeof value !== 'object') return null;
    return { content: source, value };
  } catch {
    return null;
  }
}

function extractJSONFromText(text, method = 'dom_to_json') {
  const result = jsonCandidateText(text);
  return result ? { ...result, method } : null;
}

function extractJSONFromHTML(html) {
  if (typeof html !== 'string' || !html.trim()) return null;
  // Prefer literal PRE/CODE payloads, then the visible HTML text.  The former
  // avoids Markdown link/list rendering changing JSON punctuation; the latter
  // supports Qwen's plain paragraph renderer.
  const candidates = [];
  const blocks = html.match(/<(?:pre|code)\b[^>]*>[\s\S]*?<\/(?:pre|code)>/gi) || [];
  for (const block of blocks) candidates.push(decodeHTMLText(block));
  candidates.push(decodeHTMLText(html));
  for (const candidate of candidates) {
    const result = jsonCandidateText(candidate);
    if (result) return { ...result, method: 'html_to_json' };
  }
  return null;
}

function extractJSONFromCandidates(candidates, method = 'dom_to_json') {
  if (!Array.isArray(candidates)) return null;
  for (const candidate of candidates) {
    const result = extractJSONFromText(candidate, method);
    if (result) return result;
  }
  return null;
}

// Named aliases keep the provider acquisition paths explicit to callers and
// preserve their method labels in diagnostics.
const htmlToJSON = extractJSONFromHTML;
const copyMarkdownToJSON = text => extractJSONFromText(text, 'copy_markdown_to_json');
const domToJSON = candidates => extractJSONFromCandidates(candidates, 'dom_to_json');

// A provider's native copy button may return a strict JSON value, or the
// complete Agent envelope with a syntax error that must be preserved for the
// local repair pipeline.  Do not silently discard the latter and fall back to
// HTML-to-Markdown: that would replace the copied source with a second,
// escaped representation of the same response.
function copyProtocolText(text) {
  if (typeof text !== 'string') return null;
  let source = text.replace(/^\uFEFF/, '').trim();
  if (!source) return null;
  const strict = jsonCandidateText(source);
  if (strict) return { ...strict, method: 'copy_markdown_to_json' };
  const fence = source.match(/^(`{3,}|~{3,})[ \t]*(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n\1[ \t]*$/i);
  if (fence) source = fence[2].trim();
  const raw = wholeAgentProtocolText(source);
  return raw === null ? null : { content: raw, method: 'copy_protocol_raw' };
}

function wholeAgentProtocolText(text) {
  if (typeof text !== 'string') return null;
  const source = text.trim();
  if (!source.endsWith('}')) return null;
  // Restrict raw malformed preservation to a whole Agent envelope. No code is
  // executed here; Python remains responsible for syntax/schema validation.
  const typeFirst = /^\{\s*"type"\s*:\s*"(?:action|final)"\s*,/.test(source);
  const answerFirst = /^\{\s*"answer"\s*:\s*"/.test(source) && /,\s*"type"\s*:\s*"final"\s*\}$/.test(source);
  return typeFirst || answerFirst ? source : null;
}

function preserveJSONReply(answer) {
  if (!answer || typeof answer.rawText !== 'string') return null;
  if (answer.jsonTextSafe === false) return null;
  const languages = answer.codeLanguages || [];
  if (!Array.isArray(languages) || languages.length > 1 || languages.some(language => language !== '' && language !== 'json')) return null;
  const text = answer.rawText.trim();
  const source = wholeJSONObject(text);
  if (source !== null) return { content: source, method: languages.length ? 'json_code' : 'json_text' };
  // Some providers display a literal code fence instead of a PRE element. The
  // fence must cover the entire reply; surrounding explanations stay Markdown.
  const fence = text.match(/^(`{3,}|~{3,})(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n\1[ \t]*$/i);
  if (!fence) {
    const raw = wholeAgentProtocolText(text);
    return raw === null ? null : { content: raw, method: 'json_raw_unvalidated' };
  }
  const fencedSource = wholeJSONObject(fence[2]);
  if (fencedSource !== null) return { content: fencedSource, method: 'json_code' };
  const raw = wholeAgentProtocolText(fence[2]);
  return raw === null ? null : { content: raw, method: 'json_raw_unvalidated' };
}

function extractReply(answer, markdownFromHTML) {
  const json = preserveJSONReply(answer);
  if (json) return json;
  return { content: markdownFromHTML(answer?.html || ''), method: 'markdown' };
}

// Recognize *valid prefixes* of an object without repairing or executing them.
// A syntax error is deliberately different from a still-open prefix: a complete
// but malformed reply must reach the caller's protocol repair, not wait forever.
function objectPrefixState(source) {
  const root = source[0];
  if (root !== '{' && root !== '[') return { incomplete: false, reason: 'invalid_json_syntax', container_depth: 0 };
  const stack = [{ type: root === '{' ? 'object' : 'array', state: root === '{' ? 'key_or_end' : 'value_or_end' }];
  let index = 1;
  const state = (incomplete, reason) => ({ incomplete, reason, container_depth: stack.length });
  const invalid = () => state(false, 'invalid_json_syntax');
  const string = () => {
    index++;
    while (index < source.length) {
      const char = source[index++];
      if (char === '"') return null;
      if (char.charCodeAt(0) < 32) return invalid();
      if (char !== '\\') continue;
      if (index === source.length) return state(true, 'unfinished_string_escape');
      const escaped = source[index++];
      if ('"\\/bfnrt'.includes(escaped)) continue;
      if (escaped !== 'u') return invalid();
      for (let count = 0; count < 4; count++) {
        if (index === source.length) return state(true, 'unfinished_unicode_escape');
        if (!/[0-9a-f]/i.test(source[index++])) return invalid();
      }
    }
    return state(true, 'unterminated_string');
  };
  while (index < source.length) {
    if (/[ \t\r\n]/.test(source[index])) { index++; continue; }
    if (!stack.length) return invalid(); // Never extract an object from surrounding prose.
    const current = stack.at(-1), char = source[index];
    const close = current.type === 'object' ? '}' : ']';
    if (current.state === 'key_or_end' || current.state === 'key') {
      if (char === close && current.state === 'key_or_end') { stack.pop(); index++; continue; }
      if (char !== '"') return invalid();
      const result = string();
      if (result) return result;
      current.state = 'colon';
      continue;
    }
    if (current.state === 'colon') {
      if (char !== ':') return invalid();
      current.state = 'value'; index++; continue;
    }
    if (current.state === 'comma_or_end') {
      if (char === close) { stack.pop(); index++; continue; }
      if (char !== ',') return invalid();
      current.state = current.type === 'object' ? 'key' : 'value'; index++; continue;
    }
    if (char === ']' && current.state === 'value_or_end') { stack.pop(); index++; continue; }
    current.state = 'comma_or_end';
    if (char === '{' || char === '[') {
      stack.push({ type: char === '{' ? 'object' : 'array', state: char === '{' ? 'key_or_end' : 'value_or_end' });
      index++; continue;
    }
    if (char === '"') {
      const result = string();
      if (result) return result;
      continue;
    }
    const literal = { t: 'true', f: 'false', n: 'null' }[char];
    if (literal) {
      for (const expected of literal) {
        if (index === source.length) return state(true, 'unfinished_literal');
        if (source[index++] !== expected) return invalid();
      }
      continue;
    }
    if (char === '-' || /[0-9]/.test(char)) {
      const start = index;
      while (index < source.length && !/[ \t\r\n,}\]]/.test(source[index])) index++;
      const number = source.slice(start, index);
      if (/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(number)) continue;
      if (index === source.length && /^(?:-|(?:-?(?:0|[1-9][0-9]*))(?:\.|(?:\.[0-9]+)?[eE][+-]?))$/.test(number)) return state(true, 'unfinished_number');
      return invalid();
    }
    return invalid();
  }
  return state(Boolean(stack.length), stack.length ? 'unclosed_container' : 'closed_json_object');
}

function structuredReplyState(answer) {
  if (!answer || answer.jsonTextSafe === false) return null;
  const languages = answer.codeLanguages || [];
  if (!Array.isArray(languages) || languages.length > 1 || languages.some(language => language !== '' && language !== 'json')) return null;
  const raw = typeof answer.rawText === 'string' ? answer.rawText : answer.text;
  if (typeof raw !== 'string') return null;
  let source = raw.trim(), fenceOpen = false;
  const opening = source.match(/^(`{3,}|~{3,})(json)?[ \t]*(?:\r?\n|$)/i);
  if (opening) {
    source = source.slice(opening[0].length);
    const closing = new RegExp(`(?:^|\\r?\\n)${opening[1]}[ \\t]*$`);
    fenceOpen = !closing.test(source);
    if (!fenceOpen) source = source.replace(closing, '');
    source = source.trim();
    if (!source && opening[2]) return { incomplete: true, reason: 'empty_json_code', chars: raw.length, container_depth: 0 };
  }
  if (!/^[{[]/.test(source)) return null;
  const afterRoot = source.slice(1).replace(/^[ \t\r\n]+/, '');
  if (source[0] === '{' && afterRoot && !/["}]/.test(afterRoot[0])) return null;
  if (source[0] === '[' && afterRoot && !/["{}[\]\-0-9tfn]/i.test(afterRoot[0])) return null;
  const result = objectPrefixState(source);
  if (fenceOpen && result.reason === 'closed_json_object') return { ...result, incomplete: true, reason: 'unclosed_json_fence', chars: raw.length };
  return { ...result, chars: raw.length };
}

module.exports = {
  wholeAgentProtocolText, wholeJSONObject, preserveJSONReply, extractReply, structuredReplyState,
  decodeHTMLText, jsonCandidateText, extractJSONFromText, extractJSONFromHTML, extractJSONFromCandidates,
  htmlToJSON, copyMarkdownToJSON, copyProtocolText, domToJSON,
};
