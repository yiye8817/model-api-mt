'use strict';
const { Buffer } = require('node:buffer');
const { createHash } = require('node:crypto');
const canonical = text => String(text).replace(/\r\n?/g, '\n');

// Chunks are native edits within ONE composer, never separate website requests.
// UTF-16 surrogate pairs and normalized line endings must survive each boundary.
function inputChunks(text, size = 4096) {
  if (typeof text !== 'string' || !Number.isInteger(size) || size < 256 || size > 16384) throw new TypeError('Invalid input chunk settings');
  text = canonical(text);
  const parts = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(text.length, start + size);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end--;
    parts.push(text.slice(start, end)); start = end;
  }
  return parts.length ? parts : [''];
}
function promptMetrics(text) {
  text = canonical(text);
  return { prompt_chars: text.length, prompt_utf8_bytes: Buffer.byteLength(text, 'utf8'),
    prompt_sha256: createHash('sha256').update(text, 'utf8').digest('hex') };
}
function requestMetrics(request, expected) {
  // Do not request bodies through CDP, and never log contents/headers/tokens.
  // requestWillBeSent may or may not supply postData. Absence is not a failure.
  const raw = request?.postData;
  if (typeof raw !== 'string') return { body_available: false, prompt_match: 'unavailable' };
  const result = { body_available: true, body_utf8_bytes: Buffer.byteLength(raw, 'utf8'), prompt_match: 'unverified' };
  if (typeof expected !== 'string' || raw.length > 4_000_000) return result;
  let value;
  try { value = JSON.parse(raw); } catch { return result; }
  const target = canonical(expected), queue = [value];
  let count = 0;
  while (queue.length && count++ < 20000) {
    const item = queue.pop();
    if (typeof item === 'string' && canonical(item) === target) { result.prompt_match = 'exact'; break; }
    if (item && typeof item === 'object') for (const next of Object.values(item)) {
      if (queue.length >= 20000) return result;
      queue.push(next);
    }
  }
  return result;
}

// Network traffic is an observation, not a reliable job identifier. A save,
// title-generation request or notification can run alongside the real answer.
// Inspect only supported request envelopes and the LAST message, never a string
// found anywhere in history. No bodies, headers or tokens leave this helper.
function requestPromptEvidence(request, expected) {
  const raw = request?.postData;
  if (typeof raw !== 'string' || raw.length > 4_000_000) return { relation: 'unavailable', stream: false };
  let body;
  try { body = JSON.parse(raw); } catch { return { relation: 'unavailable', stream: false }; }
  const text = value => {
    if (typeof value === 'string') return value;
    if (Array.isArray(value) && value.length <= 10000 && value.every(part => part &&
        ['text', 'input_text'].includes(part.type) && typeof part.text === 'string')) return value.map(part => part.text).join('');
    return null;
  };
  const queue = [{ value: body, depth: 0 }];
  let stream = false, nodes = 0;
  while (queue.length && nodes++ < 40) {
    const { value, depth } = queue.shift();
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    stream ||= value.stream === true;
    let content = null;
    if (Array.isArray(value.messages) && value.messages.length) {
      const last = value.messages.at(-1);
      if (last?.role === 'assistant') return { relation: 'assistant_ended', stream };
      if (last?.role === 'user') content = text(last.content);
    } else {
      for (const field of ['prompt', 'query', 'message']) {
        const candidate = value[field];
        content = text(candidate);
        if (content === null && candidate?.role === 'user') content = text(candidate.content);
        if (content !== null) break;
      }
    }
    if (content !== null && typeof expected === 'string') return { relation: canonical(content) === canonical(expected) ? 'exact' : 'different', stream };
    if (depth < 3) for (const key of ['data', 'payload', 'input', 'inputs']) {
      if (value[key] && typeof value[key] === 'object') queue.push({ value: value[key], depth: depth + 1 });
    }
  }
  return { relation: 'unavailable', stream };
}
function classifyGenerationRequest(request, context = {}) {
  const evidence = requestPromptEvidence(request, context.prompt);
  const result = (tracked, reason) => ({ tracked, reason, prompt_relation: evidence.relation });
  if (request?.method !== 'POST') return result(false, 'not_post');
  let url, origin;
  try { url = new URL(request.url); origin = context.origin ? new URL(context.origin).origin : null; }
  catch { return result(false, 'invalid_url'); }
  if (!['http:', 'https:'].includes(url.protocol)) return result(false, 'invalid_url');
  if (['different', 'assistant_ended'].includes(evidence.relation)) return result(false, 'not_current_user_request');
  const sameOrigin = !origin || url.origin === origin;
  const known = /(?:\/(?:completions?|generat(?:e|ions?))|\/(?:chat|conversation)\/(?:send|stream))\/?$/i.test(url.pathname);
  // A known path may have no body in CDP, especially for long Agent prompts.
  // Preserve failure tracking then. Cross-origin APIs need exact prompt proof.
  if (known && (sameOrigin || evidence.relation === 'exact')) return result(true, evidence.relation === 'exact' ? 'known_endpoint_current_prompt' : 'known_endpoint_body_unavailable');
  // /chat and /chats/id/messages also serve persistence. For these and opaque
  // same-origin endpoints, an explicit streaming flag AND latest-user match are
  // required. A MIME type observed later is never sufficient by itself.
  if (sameOrigin && evidence.relation === 'exact' && evidence.stream) return result(true, 'streaming_current_prompt');
  return result(false, sameOrigin ? 'unattributed_request' : 'different_origin_unverified');
}

module.exports = { inputChunks, promptMetrics, requestMetrics, requestPromptEvidence, classifyGenerationRequest };
