'use strict';
const { extractReply, extractJSONFromText, htmlToJSON, copyProtocolText, domToJSON, structuredReplyState } = require('./reply-extraction.cjs');
const { webProgress } = require('./web-progress.cjs');
const { runQwenRecovery, RetryArtifacts } = require('./qwen-retry.cjs');

const crypto = require('node:crypto');
const { Buffer } = require('node:buffer');
const { responseError, RESPONSE_ERROR_LIMIT } = require('./response-error.cjs');
const { inputChunks, promptMetrics, requestMetrics, classifyGenerationRequest } = require('./input-transport.cjs');
const TurndownService = require('turndown');
const { gfm } = require('turndown-plugin-gfm');

class AdapterError extends Error {
  constructor(code, message, details = undefined) { super(message); this.code = code; this.details = details; }
}

const { pageAction } = require('./provider-dom.cjs');

function validateSelectors(selectors) {
  if (!selectors || typeof selectors !== 'object') throw new AdapterError('selectors_invalid', '未配置网页选择器。');
  for (const key of ['input', 'send', 'assistant', 'stop']) {
    if (!Array.isArray(selectors[key]) || selectors[key].length > 40 || selectors[key].some(s => typeof s !== 'string' || s.length > 1000)) {
      throw new AdapterError('selectors_invalid', `无效的 ${key} 选择器配置。`);
    }
    if (['input', 'assistant'].includes(key) && !selectors[key].length) throw new AdapterError('selectors_missing', `请配置 ${key} 选择器。`);
  }
  if (selectors.new_chat !== undefined && (!Array.isArray(selectors.new_chat) || selectors.new_chat.length > 40 || selectors.new_chat.some(s => typeof s !== 'string' || s.length > 1000))) {
    throw new AdapterError('selectors_invalid', '无效的 new_chat 选择器配置。');
  }
}

function markdownFromHTML(html) {
  const converter = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-', emDelimiter: '*' });
  converter.use(gfm);
  converter.remove(['script', 'style', 'button', 'iframe']);
  // Choose a fence longer than any backtick run inside code so embedded Markdown survives.
  converter.addRule('safeFencedCode', {
    filter: node => node.nodeName === 'PRE',
    replacement: (_content, node) => {
      const code = node.querySelector('code') || node;
      const classes = `${code.getAttribute('class') || ''} ${node.getAttribute('class') || ''}`;
      const match = classes.match(/(?:language|lang)-([a-z0-9_+.-]+)/i);
      const text = code.textContent.replace(/\n$/, '');
      const runs = text.match(/`+/g) || [];
      const fence = '`'.repeat(Math.max(3, ...runs.map(run => run.length + 1)));
      return `\n\n${fence}${match ? match[1] : ''}\n${text}\n${fence}\n\n`;
    },
  });
  return converter.turndown(html).trim();
}

function answerSignature(answer) {
  return answer ? crypto.createHash('sha256').update(answer.html || '').digest('hex') : '';
}

class CompletionTracker {
  constructor(baseline, { stableSeconds, minWaitSeconds, startedAt = Date.now() }) {
    this.baseline = baseline.answers || [];
    this.baselineLast = answerSignature(this.baseline.at(-1));
    this.stableMs = stableSeconds * 1000;
    this.minWaitMs = minWaitSeconds * 1000;
    this.startedAt = startedAt;
    this.lastChangedAt = startedAt;
    this.signature = '';
    this.seenStop = false;
    this.answer = null;
    this.capture = null;
  }
  update(snapshot, now = Date.now()) {
    this.seenStop ||= snapshot.stopping;
    const answer = snapshot.answers.at(-1);
    const signature = answerSignature(answer);
    const isNew = snapshot.answers.length > this.baseline.length || (signature && signature !== this.baselineLast);
    if (!isNew || !answer?.text?.trim()) return { done: false, reason: !isNew ? 'waiting_new_answer' : 'waiting_final_content' };
    if (signature !== this.signature) {
      this.signature = signature;
      this.lastChangedAt = now;
      this.answer = answer;
      this.capture = structuredReplyState(answer);
    }
    // A changed output is mandatory. Hidden-tab generation can pause briefly, so require
    // stability even when a stop indicator disappears. Sites without indicators use 2x.
    const stability = this.seenStop ? this.stableMs : this.stableMs * 2;
    // Network streaming may pause without changing the DOM. Start the final
    // stability window only after the tracked response has actually finished.
    if (snapshot.responsePending) this.lastChangedAt = now;
    const done = !snapshot.stopping && !snapshot.responsePending && !this.capture?.incomplete && now - this.startedAt >= this.minWaitMs && now - this.lastChangedAt >= stability;
    return { done, answer: this.answer, capture: this.capture, reason: done ? 'stable_answer' : snapshot.responsePending ? 'waiting_network_response' : snapshot.stopping ? 'streaming' : this.capture?.incomplete ? 'incomplete_structured_response' : 'waiting_stability' };
  }
}

function checkAbort(signal) {
  if (signal?.aborted) throw new AdapterError('cancelled', signal.reason === 'input_view_hidden' ? '发送期间模型页面被隐藏、最小化或关闭，操作已取消；不会自动重发。' : '任务已取消；不会自动重发。');
}

function sendNotReady(target) {
  const reasons = {
    input_changed: '网页输入内容与完整提示不一致，或输入框已被替换',
    send_missing: '没有识别到该模型的发送按钮，请检查发送选择器',
    send_action_conflict: '命中的按钮当前是语音、停止或其他操作，未作为发送按钮点击',
    send_hit_test_unavailable: '无法确认发送按钮的实际点击目标，未执行发送',
    send_disabled: '发送按钮仍处于禁用状态，请检查网页是否仍在处理输入或等待验证',
    unrecognized_form_submit: '输入框所在表单有未识别的提交按钮，未执行点击',
    send_outside_viewport: '发送按钮不在可点击的网页区域内',
    send_obscured: '发送按钮被其他页面元素遮挡，请关闭弹层后重试',
    page_busy: '网页仍在生成或处理上一条请求',
    page_not_interactive: '模型页面在发送前失去可见状态或页面焦点',
  };
  const reason = target?.reason || 'send_not_ready';
  const length = Number.isInteger(target?.inputLength) && Number.isInteger(target?.expectedLength)
    ? `；输入长度 ${target.inputLength}/${target.expectedLength}` : '';
  return new AdapterError('send_not_ready', `${reasons[reason] || '发送前网页状态未就绪'}（${reason}${length}）。未执行发送。`);
}
function bounded(promise, deadline, signal) {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return reject(new AdapterError('timeout', '网页生成超时；不会自动重发。'));
    const timer = setTimeout(() => done(reject, new AdapterError('timeout', '网页生成超时；不会自动重发。')), remaining);
    const abort = () => { try { checkAbort(signal); } catch (error) { done(reject, error); } };
    function done(fn, result) { clearTimeout(timer); signal?.removeEventListener('abort', abort); fn(result); }
    signal?.addEventListener('abort', abort, { once: true });
    promise.then(value => done(resolve, value), error => done(reject, error));
  });
}
function pause(ms, deadline, signal) {
  return bounded(new Promise(resolve => setTimeout(resolve, ms)), deadline, signal);
}

// A dispatched input event is not evidence that the site accepted the prompt.
function submissionEvidence(before, snapshot) {
  if (snapshot.stopping) return 'generation_indicator';
  const last = snapshot.answers.at(-1);
  if (last?.text?.trim() && (snapshot.answers.length > before.answers.length || answerSignature(last) !== answerSignature(before.answers.at(-1)))) return 'new_assistant_content';
  if (snapshot.inputEmpty && snapshot.userCount > (before.userCount || 0) && snapshot.lastUserMatchesPrompt) return 'new_user_turn';
  return null;
}

// CDP targets this webContents directly and does not require bringing its window
// to the foreground. Network status diagnostics omit headers and request bodies.
async function dispatchTrustedInput(wc, target, deadline, signal, trace = () => {}, guard = () => {}) {
  const send = async (method, params) => {
    checkAbort(signal);
    guard();
    trace('adapter.cdp_started', { method, input_event: params.type, payload: { parameters: params } });
    try {
      const result = await bounded(wc.debugger.sendCommand(method, params), deadline, signal);
      trace('adapter.cdp_acknowledged', { method, input_event: params.type, acknowledged: true });
      return result;
    } catch (error) {
      trace('adapter.cdp_failed', { method, input_event: params.type, code: error.code || 'cdp_error' });
      throw error;
    }
  };
  checkAbort(signal);
  if (target.method === 'button') {
    const point = { x: target.x, y: target.y, button: 'left', clickCount: 1 };
    await send('Input.dispatchMouseEvent', { ...point, type: 'mousePressed', buttons: 1 });
    // One press/release gesture only. Never fall back to Enter after an ambiguous click.
    checkAbort(signal);
    await send('Input.dispatchMouseEvent', { ...point, type: 'mouseReleased', buttons: 0 });
  } else {
    const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
    await send('Input.dispatchKeyEvent', { ...key, type: 'keyDown', text: '\r', unmodifiedText: '\r' });
    checkAbort(signal);
    await send('Input.dispatchKeyEvent', { ...key, type: 'keyUp' });
  }
}

async function startNetworkTrace(wc, log, deadline, signal, context = {}) {
  if (typeof wc.debugger?.on !== 'function') return () => {};
  const requests = new Map(), inspecting = new Set();
  let closed = false;
  let armed = false, responseObserved = false, responseCount = 0, failureCount = 0;
  const failed = [];
  const recordFailure = row => { failed.push({ ...row, serial: ++failureCount }); if (failed.length > 64) failed.shift(); };
  const publicURL = value => { try { const u = new URL(value); return ['https:', 'http:'].includes(u.protocol) ? u.origin + u.pathname : null; } catch { return null; } };
  const listener = (_event, method, params) => {
    if (method === 'Network.requestWillBeSent' && ['Fetch', 'XHR', 'Document'].includes(params.type)) {
      const url = publicURL(params.request?.url);
      if (!url) return;
      if (requests.size >= 1024) {
        const unused = [...requests].find(([, request]) => !request.response);
        if (unused) requests.delete(unused[0]);
        else { recordFailure({ code: 'response_tracking_capacity' }); return; }
      }
      const previous = params.redirectResponse ? requests.get(params.requestId) : null;
      const classification = classifyGenerationRequest(params.request, context);
      const response = Boolean(previous?.response || armed && ['Fetch', 'XHR'].includes(params.type) && classification.tracked);
      responseObserved ||= response;
      if (response && !previous?.response) responseCount++;
      requests.set(params.requestId, { url, method: params.request?.method, resource_type: params.type, afterSend: armed, response, attempt: previous?.attempt || responseCount });
      log('adapter.network_request', { network_id: params.requestId, method: params.request?.method, resource_type: params.type,
        tracked_response: response, attribution: previous?.response ? 'tracked_redirect' : classification.reason,
        prompt_relation: classification.prompt_relation, payload: { url } });
      if (response) log('adapter.request_payload', { network_id: params.requestId,
        ...requestMetrics(params.request, context.prompt), prompt_relation: classification.prompt_relation });
    } else if (method === 'Network.responseReceived' && ['Fetch', 'XHR', 'Document'].includes(params.type)) {
      const url = publicURL(params.response?.url);
      if (!url) return;
      const request = requests.get(params.requestId);
      if (request) { request.status = params.response?.status; request.mime = String(params.response?.mimeType || ''); }
      // A streaming MIME type alone does not associate a response with this
      // prompt: notification feeds can start or reconnect after the send too.
      // Only the post-send generation endpoints selected at request start
      // participate in completion. Unknown endpoints retain DOM observation.
      if (request?.response && params.response?.status >= 400) {
        request.failed = true;
        recordFailure({ network_id: params.requestId, status: params.response.status, attempt: request.attempt });
      }
      log('adapter.network_response', { network_id: params.requestId, status: params.response?.status,
        method: request?.method, resource_type: params.type, mime_type: String(params.response?.mimeType || '').slice(0, 100),
        tracked_response: Boolean(request?.response), payload: { url } });
    } else if (method === 'Network.loadingFailed' && requests.has(params.requestId)) {
      log('adapter.network_failed', { network_id: params.requestId, cancelled: Boolean(params.canceled),
        payload: { url: requests.get(params.requestId).url, error: String(params.errorText || 'network_failed').slice(0, 300) } });
      if (requests.get(params.requestId).response) recordFailure({ network_id: params.requestId, code: String(params.errorText || 'network_failed').slice(0, 300), attempt: requests.get(params.requestId).attempt });
      requests.delete(params.requestId);
    } else if (method === 'Network.loadingFinished') {
      const request = requests.get(params.requestId);
      if (request?.response) log('adapter.network_response_finished', { network_id: params.requestId, payload: { url: request.url } });
      requests.delete(params.requestId);
      // HTTP 200 can carry a terminal JSON/SSE error instead of a completion.
      // Only Qwen's already-attributed current generation is read, after it has
      // finished, with bounded size/time. Never fetch an unrelated response.
      if (context.provider === 'qwen' && request?.response && !request.failed && request.status >= 200 && request.status < 300 &&
          /json|event-stream/i.test(request.mime) && Number.isFinite(params.encodedDataLength) && params.encodedDataLength <= RESPONSE_ERROR_LIMIT) {
        const inspection = {}; inspecting.add(inspection);
        void bounded(Promise.resolve().then(() => wc.debugger.sendCommand('Network.getResponseBody', { requestId: params.requestId })), Math.min(deadline, Date.now()+1500), signal)
          .then(reply => {
            if (closed || signal?.aborted || typeof reply?.body !== 'string' || reply.body.length > RESPONSE_ERROR_LIMIT * (reply.base64Encoded ? 1.4 : 1)) return;
            const body = reply.base64Encoded ? Buffer.from(reply.body, 'base64').toString('utf8') : reply.body;
            const error = responseError(body, request.mime);
            if (error && request.attempt === responseCount) {
              recordFailure({ network_id: params.requestId, attempt: request.attempt, ...error });
              log('adapter.network_application_error', { network_id: params.requestId, tracked_response: true, http_status: request.status, ...error });
            }
          }).catch(error => { if (!closed && !signal?.aborted) log('adapter.response_error_check_unavailable', { network_id: params.requestId, code: error.code || 'body_unavailable' }); })
          .finally(() => inspecting.delete(inspection));
      }
    }
  };
  wc.debugger.on('message', listener);
  const stop = () => { closed = true; wc.debugger.removeListener('message', listener); requests.clear(); inspecting.clear(); };
  stop.arm = () => { armed = true; };
  stop.state = () => ({ observed: responseObserved, pending: inspecting.size + [...requests.values()].filter(request => request.response && !request.failed).length,
    failed: failed.slice(0, 20).map(({ serial, attempt, ...row }) => row) });
  stop.checkpoint = () => ({ responseCount, failureCount });
  stop.terminalFailure = () => responseCount > 0 && stop.state().pending === 0 && failed.some(row => row.attempt === responseCount);
  // A later observed attempt can supersede earlier failures, but can never
  // erase a failure reported by that new attempt or an outstanding stream.
  stop.acknowledgeFailures = checkpoint => {
    for (let i = failed.length - 1; i >= 0; i--) if (failed[i].serial <= checkpoint.failureCount) failed.splice(i, 1);
  };
  try { await bounded(wc.debugger.sendCommand('Network.enable'), deadline, signal); }
  catch (error) {
    stop();
    if (signal?.aborted) throw error;
    log('adapter.network_trace_unavailable', { code: error.code || 'network_domain_unavailable' });
    return () => {};
  }
  return stop;
}

class WebsiteAdapter {
  constructor(webContents, provider, status = () => {}, logger = () => {}, options = {}) {
    this.webContents = webContents; this.provider = provider; this.status = status; this.logger = logger; this.active = false; this.options = options;
    this.lastSubmittedAt = 0;
  }
  async diagnoseSend() {
    validateSelectors(this.provider.selectors);
    if (this.webContents.isDestroyed()) throw new AdapterError('webpage_closed', '模型网页已关闭。');
    let expectedOrigin, observedOrigin;
    try {
      expectedOrigin = new URL(this.provider.url).origin;
      observedOrigin = typeof this.webContents.getURL === 'function' ? new URL(this.webContents.getURL()).origin : expectedOrigin;
    } catch { throw new AdapterError('provider_origin_changed', '当前网页地址无法验证，未读取发送诊断。'); }
    if (observedOrigin !== expectedOrigin) {
      throw new AdapterError('provider_origin_changed', '模型网页当前位于其他站点，未读取或记录该页面内容。请返回配置的模型网址后再检测。');
    }
    const args = { provider_id: this.provider.id, selectors: this.provider.selectors, prompt: '' };
    const report = await bounded(this.webContents.executeJavaScriptInIsolatedWorld(1733,
      [{ code: `(() => location.origin === ${JSON.stringify(expectedOrigin)} ? (${pageAction.toString()})('diagnoseSend',${JSON.stringify(args)}) : ({ __fusionOriginMismatch: true }))()` }]), Date.now() + 5000);
    if (report?.__fusionOriginMismatch) throw new AdapterError('provider_origin_changed', '模型网页在检测期间跳转到其他站点，未记录页面内容。');
    try { this.logger('adapter.send_diagnostic', { provider_id: this.provider.id, payload: { report } }); } catch {}
    return report;
  }
  async run(job, signal, progress = () => {}) {
    if (this.active) throw new AdapterError('provider_busy', '该模型网页已有生成任务。');
    this.active = true;
    const wc = this.webContents;
    const preserveModel = ['qwen', 'glm'].includes(this.provider.id);
    const sessionProvider = this.provider.id;
    const sessionName = sessionProvider === 'glm' ? 'GLM' : 'Qwen';
    const sessionAction = `${sessionProvider}Session`;
    let expectedOrigin;
    try { expectedOrigin = new URL(this.provider.url).origin; }
    catch { throw new AdapterError('provider_url_invalid', '模型网页地址无效，未执行网页操作。'); }
    let crossOriginNavigation = null;
    const rejectCrossOriginNavigation = (event, url, _isInPlace, isMainFrame) => {
      if (isMainFrame === false) return;
      let origin = '';
      try { origin = new URL(url).origin; } catch {}
      if (origin && origin !== expectedOrigin) {
        crossOriginNavigation = origin;
        event?.preventDefault?.();
      }
    };
    if (typeof wc.on === 'function') {
      wc.on('will-navigate', rejectCrossOriginNavigation);
      wc.on('will-redirect', rejectCrossOriginNavigation);
    }
    const startedAt = Date.now();
    const recoveryMs = Number.isFinite(job.recovery_timeout_seconds) ? Math.min(600, Math.max(0, job.recovery_timeout_seconds)) * 1000 : 0;
    const intervalMs = Math.max(0, Math.min(3600, Number(job.access_interval_seconds) || 0)) * 1000;
    const throttleMs = Math.max(0, this.lastSubmittedAt + intervalMs - startedAt);
    const totalDeadline = Number.isFinite(job.total_timeout_seconds)
      ? startedAt + Math.max(0, job.total_timeout_seconds) * 1000 : Infinity;
    const generationDeadline = Math.min(totalDeadline, startedAt + throttleMs + job.timeout_seconds * 1000);
    let deadline = generationDeadline;
    const backgroundRequest = ['api', 'desktop-top'].includes(job.request_source);
    const args = { id: job.job_id, provider_id: this.provider.id, selectors: this.provider.selectors, prompt: job.prompt,
      // Doubao's current Tiptap editor is controlled and does not reliably
      // accept a direct value assignment/execCommand. Use the same trusted
      // browser editing path as Kimi so its framework receives the edit.
      input_transport: ['qwen', 'chatgpt', 'glm', 'kimi', 'doubao', 'yuanbao'].includes(this.provider.id) ? 'cdp' : 'dom',
      // Desktop/API callers use the native background view and must not force
      // the Fusion window to become the active OS window.
      require_interactive: Boolean(this.options.acquireInput) && !backgroundRequest };
    let submitted = false, accepted = false, attached = false, inputDispatched = false, lastWaitReason = '', lastSummary = '', lastLogAt = 0, lastSendState = '';
    let ratingDismissed = false, manualQwenSendRequired = false, selectedModel = null, latestCapture = null, latestSnapshot = null;
    let before = null, tracker = null, preparedJob = false, recoveryStarted = false, verificationSeen = false, lastContextState = '';
    let retryArtifacts = null;
    let stopNetwork = () => {}, networkStarted = false, releaseInput = null, focusEmulated = false, latestPage = null, lastTarget = null;
    const log = (event, fields = {}) => {
      try { this.logger(event, { provider_id: this.provider.id, request_id: job.request_id, job_id: job.job_id, elapsed_ms: Date.now() - startedAt, ...fields }); } catch {}
      try { const state = webProgress(event, fields); if (state) progress(state); } catch {}
    };
    const assertProviderOrigin = () => {
      if (wc.isDestroyed()) throw new AdapterError('webpage_closed', '模型网页已关闭。');
      if (crossOriginNavigation) {
        throw new AdapterError('provider_origin_changed', '模型网页尝试跳转到其他站点，已阻止并停止本轮输入、点击和回答采集。请完成登录并返回配置的模型网址后重试。',
          { expected_origin: expectedOrigin, observed_origin: crossOriginNavigation });
      }
      if (typeof wc.getURL !== 'function') return; // Test doubles predating this invariant.
      let currentOrigin = '';
      try { currentOrigin = new URL(wc.getURL()).origin; } catch {}
      if (currentOrigin !== expectedOrigin) {
        throw new AdapterError('provider_origin_changed', '模型网页已跳转到其他站点，已停止输入、点击和回答采集。请在该模型标签完成登录并返回配置的模型网址后重试。',
          { expected_origin: expectedOrigin, observed_origin: currentOrigin || null });
      }
    };
    const act = async (action, extra = {}) => {
      assertProviderOrigin();
      const callArgs = JSON.stringify({ ...args, ...extra, deadline,
        network_terminal_failure: this.provider.id === 'qwen' && stopNetwork.terminalFailure?.() === true });
      const code = `(() => { const expected = ${JSON.stringify(expectedOrigin)}; if (location.origin !== expected) return { __fusionOriginMismatch: true, observedOrigin: location.origin }; return (${pageAction.toString()})(${JSON.stringify(action)},${callArgs}); })()`;
      const result = await bounded(wc.executeJavaScriptInIsolatedWorld(1733, [{ code }], ['claimSubmit', 'prepare', 'recoveryClaim', 'recoveryTrigger', 'recoveryVisualClaim'].includes(action)), deadline, signal);
      if (result?.__fusionOriginMismatch) {
        throw new AdapterError('provider_origin_changed', '模型网页已跳转到其他站点，已停止输入、点击和回答采集。请返回配置的模型网址后重试。',
          { expected_origin: expectedOrigin, observed_origin: result.observedOrigin || null });
      }
      assertProviderOrigin();
      return result;
    };
    const observe = async (allowFailure = false) => {
      const snapshot = await act('inspect');
      if (snapshot.verification?.required) {
        await waitForVerification(snapshot);
        return observe(allowFailure);
      }
      const network = stopNetwork.state?.();
      snapshot.responsePending = Boolean(network?.pending);
      // Error output is never a candidate answer, even when automatic/manual
      // recovery is disabled. Only attach the broader recovery context when it
      // can actually be used, so a missing site-specific user selector does not
      // change ordinary positive-response evidence with recovery disabled.
      if (preparedJob && submitted) {
        const recovery = await act('recoveryInspect');
        snapshot.currentTurnError = Boolean(recovery?.currentError);
        const context = { reason: recovery?.reason, contextChanged: Boolean(recovery?.contextChanged),
          currentTurnAccepted: Boolean(recovery?.currentTurnAccepted), userCount: recovery?.userCount,
          baselineUserCount: recovery?.baselineUserCount, lastUserMatchesPrompt: recovery?.lastUserMatchesPrompt,
          inputMatchesPrompt: recovery?.inputMatchesPrompt, initialConversation: recovery?.initialConversation,
          boundConversation: recovery?.boundConversation, awaitingFirstConversation: recovery?.awaitingFirstConversation,
          currentError: Boolean(recovery?.currentError), stopping: Boolean(recovery?.stopping), staleStopIgnored: Boolean(recovery?.staleStopIgnored) };
        const contextState = JSON.stringify(context);
        if (contextState !== lastContextState) { log('adapter.context_check', { payload: context }); lastContextState = contextState; }
        // Conversation isolation does not depend on enabling the retry feature.
        if (recovery?.contextChanged) throw new AdapterError('recovery_context_changed',
          `网页会话或输入与本轮不一致（${recovery.reason || 'unknown'}），已停止采集；不会读取其他会话或自动重发。`,
          { recovery: context });
        if (recoveryMs) snapshot.recovery = recovery;
      }
      latestSnapshot = snapshot;
      latestPage = snapshot.page || latestPage;
      if (snapshot.recovery?.contextChanged) throw new AdapterError('recovery_context_changed', '网页已切换会话或出现其他用户输入，已停止本轮采集；不会读取其他会话的回答。');
      if (!allowFailure && network?.failed.length) {
        const summary = network.failed.map(row => row.status ? `HTTP ${row.status}` : row.code).filter(Boolean).join(', ');
        throw new AdapterError('response_network_failed', `网页聊天响应请求失败（${summary || '未知网络状态'}）；未使用不完整回答。请对照 adapter.request_payload 的输入长度及 adapter.network_response 的 HTTP 状态。`,
          { responses: network.failed, prompt: promptMetrics(job.prompt) });
      }
      if (!allowFailure && snapshot.currentTurnError) throw new AdapterError('response_page_error', '网页当前回合显示服务错误，尚未取得完整回答。');
      const summary = JSON.stringify(snapshot.summary);
      if (summary !== lastSummary && Date.now() - lastLogAt >= 1000) { log('adapter.dom', snapshot.summary); lastSummary = summary; lastLogAt = Date.now(); }
      return snapshot;
    };
    const waitReason = (reason, capture = null) => { if (reason !== lastWaitReason) { log('adapter.wait', { reason, ...(capture ? { capture } : {}) }); lastWaitReason = reason; } };
    const sendState = target => {
      lastTarget = target; latestPage = target?.page || latestPage;
      const fields = { ready: Boolean(target?.ready), reason: target?.reason || 'unknown', input_length: target?.inputLength,
        expected_length: target?.expectedLength, input_source: target?.inputSource || 'none', send_source: target?.sendSource || 'none', send_candidates: target?.sendCandidates || 0 };
      const payload = { target: target?.sendTarget || null, page: target?.page || null, selector_checks: target?.selectorChecks || [], unmatched_controls: target?.unmatchedControls || [] };
      const value = JSON.stringify({ fields, payload });
      if (value !== lastSendState) { log('adapter.send_state', { ...fields, payload }); lastSendState = value; }
    };
    const attachDebugger = async () => {
      checkAbort(signal);
      assertProviderOrigin();
      if (attached) return;
      if (!wc.debugger || wc.debugger.isAttached()) throw new AdapterError('debugger_unavailable', '可信输入通道不可用或被开发者工具占用；请关闭该网页的开发者工具后重试。');
      try { wc.debugger.attach('1.3'); attached = true; }
      catch { throw new AdapterError('debugger_unavailable', '无法建立可信输入通道，请关闭该网页的开发者工具后重试。'); }
      if (!networkStarted) { stopNetwork = await startNetworkTrace(wc, log, deadline, signal, { prompt: job.prompt, provider: this.provider.id, origin: expectedOrigin }); networkStarted = true; }
    };
    const releaseInteraction = async () => {
      if (focusEmulated) {
        focusEmulated = false;
        try {
          if (!wc.isDestroyed() && wc.debugger.isAttached()) {
            await bounded(wc.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: false }), Date.now() + 1000);
            log('adapter.focus_released', { acknowledged: true });
          }
        } catch { log('adapter.focus_release_failed', { code: 'focus_cleanup_failed' }); }
      }
      const release = releaseInput; releaseInput = null;
      if (release) {
        try { await release(); log('adapter.input_lease_released'); }
        catch { log('adapter.input_lease_release_failed', { code: 'lease_cleanup_failed' }); }
      }
    };
    const settleSubmission = async (operation, checkpoint, baseline, allowFailure = false) => {
      if (!releaseInput || !['qwen', 'glm'].includes(this.provider.id)) return;
      const settleEnd = Math.min(deadline, Date.now() + Math.min(10, Math.max(0, job.submit_settle_seconds ?? 2)) * 1000);
      let evidence = 'bounded_settle_elapsed';
      log('adapter.submit_settle_started', { operation, timeout_ms: Math.max(0, settleEnd - Date.now()) });
      while (Date.now() < settleEnd) {
        const snapshot = await observe(allowFailure);
        // The initial failed request remains observed during retry. Require an
        // attempt AFTER this click's checkpoint, not the job-wide observed bit.
        const newRequest = (stopNetwork.checkpoint?.().responseCount || 0) > checkpoint.responseCount;
        const proof = submissionEvidence(baseline, snapshot);
        if (newRequest || !snapshot.currentTurnError && (proof === 'generation_indicator' || proof === 'new_assistant_content')) {
          evidence = newRequest ? 'generation_request_started' : proof; break;
        }
        if (Date.now() + 100 >= settleEnd) break;
        await pause(100, deadline, signal);
      }
      log('adapter.submit_settle_finished', { operation, evidence });
    };
    const assertSessionModel = session => {
      const selected = session.model;
      if (selectedModel && selected && (selectedModel.key || selectedModel.label) !== (selected.key || selected.label)) {
        throw new AdapterError(`${sessionProvider}_model_changed`, `${sessionName} 新会话改变了已选择的模型，未发送请求。请在网页重新选择模型；不会刷新页面或自动选择其他模型。`,
          { previous_model: selectedModel, current_model: selected });
      }
      if (sessionProvider === 'glm' && selectedModel && !selected) {
        throw new AdapterError('glm_model_unverified', 'GLM 原先可识别的模型选择现在无法确认，未发送请求。请在网页检查所选模型后重试；不会刷新或自动切换模型。',
          { previous_model: selectedModel });
      }
    };
    const waitForVerification = async initial => {
      verificationSeen = true;
      const hadInputLease = Boolean(releaseInput);
      // Release the input lease so other providers can still send. A human
      // can reveal the original tab via the existing live-job recovery entry.
      await releaseInteraction();
      this.status('verification_required', '检测到 GLM 验证码。请点击“完成人工验证”并在原网页处理；不刷新、不绕过验证，也不重复投递提示。验证等待计入本轮超时。');
      log('adapter.verification_required', { dispatched: submitted, accepted,
        remaining_seconds: Math.max(0, Math.ceil((deadline - Date.now()) / 1000)), kind: initial.verification?.kind });
      let current = initial;
      try {
        while (current.verification?.required) {
          checkAbort(signal);
          await pause(500, deadline, signal);
          current = await act('inspect');
          latestSnapshot = current; latestPage = current.page || latestPage;
        }
      } catch (error) {
        if (error.code === 'timeout') throw new AdapterError('verification_timeout', '等待 GLM 人工验证超时；本轮已停止，未绕过验证码，也未自动重发。');
        throw error;
      }
      // Challenge disappearance is not a forged success verdict: normal
      // origin, model, prompt and submission evidence checks still apply.
      log('adapter.verification_cleared', { dispatched: submitted, accepted, evidence: 'challenge_ui_no_longer_visible' });
      if (preparedJob) {
        const context = await act('recoveryInspect');
        if (context?.contextChanged) throw new AdapterError('recovery_context_changed', '人工验证期间会话或输入发生变化，已停止本轮操作。');
      }
      this.status(submitted ? 'generating' : 'submitting', submitted
        ? '验证界面已解除，继续检查原请求是否被接收；不会自动再次点击发送。'
        : '验证界面已解除，重新检查模型与输入后继续发送。');
      if (hadInputLease && !submitted && this.options.acquireInput) {
        releaseInput = await this.options.acquireInput({ job: { ...job, provider_id: this.provider.id }, signal, deadline });
        if (typeof releaseInput !== 'function') throw new AdapterError('input_lease_invalid', '验证后未能恢复模型输入环境。');
        checkAbort(signal);
        if (attached) {
          await bounded(wc.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true }), deadline, signal);
          focusEmulated = true;
        }
      }
      return current;
    };
    const dismissQwenRating = async () => {
      if (this.provider.id !== 'qwen') return false;
      const session = await act('qwenSession');
      if (!session.rating.length) return false;
      log('adapter.qwen_rating_detected', { payload: { panels: session.rating } });
      if (ratingDismissed) throw new AdapterError('qwen_rating_reappeared', 'Qwen 评分面板再次出现，未重复点击或发送；请手动关闭后重试。');
      const target = await act('qwenDismissTarget');
      log('adapter.qwen_rating_close_target', { ready: target.ready, reason: target.reason, payload: { target: target.target || null } });
      if (!target.ready) throw new AdapterError('qwen_rating_close_required', '检测到 Qwen 评分/反馈面板，但没有找到可安全点击的关闭、跳过或稍后按钮。请手动关闭后重试；未点击评分或提交。', { rating: session.rating });
      ratingDismissed = true;
      let blockedNavigation = false;
      const blockReload = event => {
        event.preventDefault(); blockedNavigation = true;
        log('adapter.qwen_full_navigation_blocked', { operation: 'dismiss_rating', reason: 'preserve_selected_model' });
      };
      if (typeof wc.on === 'function') wc.on('will-navigate', blockReload);
      try {
        await dispatchTrustedInput(wc, target, deadline, signal, (event, fields) => log(event, { operation: 'dismiss_qwen_rating', ...fields }), assertProviderOrigin);
        log('adapter.qwen_rating_close_dispatched', { payload: { target: target.target } });
        const closeDeadline = Math.min(deadline, Date.now() + 5000);
        while (Date.now() < closeDeadline) {
          if (blockedNavigation) throw new AdapterError('qwen_rating_requires_reload', 'Qwen 评分关闭控件试图刷新整个页面，已阻止以保留所选模型。未发送请求；请手动处理该面板。');
          const after = await act('qwenSession');
          if (!after.rating.length && after.inputReady) {
            log('adapter.qwen_rating_closed', { verified: true, evidence: 'recognized_panel_hidden_and_composer_ready' });
            assertSessionModel(after);
            return true;
          }
          await pause(250, deadline, signal);
        }
        throw new AdapterError('qwen_rating_close_unconfirmed', 'Qwen 评分关闭后面板尚未消失或输入框仍不可用，未发送请求；请手动检查。');
      } finally { if (typeof wc.removeListener === 'function') wc.removeListener('will-navigate', blockReload); }
    };

    const deferQwenRatingToManualSend = async (error, stage) => {
      if (this.provider.id !== 'qwen' || !String(error?.code || '').startsWith('qwen_rating_')) throw error;
      const session = await act('qwenSession');
      if (!session.inputPresent || !session.inputEmpty || session.stopping) throw error;
      manualQwenSendRequired = true;
      log('adapter.qwen_rating_auto_dismiss_failed', { code: error.code, stage, manual_send_fallback: true,
        payload: { rating: session.rating, session: { conversation: session.conversation, answers: session.answers, userCount: session.userCount } } });
      return session;
    };

    const preparePreservedSession = async () => {
      let session = await act(sessionAction);
      selectedModel = session.model;
      log(`adapter.${sessionProvider}_session_inspected`, { model_observed: Boolean(session.model), payload: { session } });
      try { await dismissQwenRating(); }
      catch (error) {
        session = await deferQwenRatingToManualSend(error, 'before_new_chat');
        args.fresh_session_confirmed = !session.answers && !session.userCount;
        log('adapter.qwen_manual_send_required', { reason: 'rating_panel_blocks_session_preparation', current_conversation_preserved: true });
        return;
      }
      session = await act(sessionAction);
      // Preserve a user's draft: starting a fresh chat must not discard it.
      if (session.inputPresent && !session.inputEmpty) throw new AdapterError('input_not_empty', `${sessionName} 输入框已有草稿，未新建会话或发送。请先处理草稿。`);
      if (!session.answers && !session.userCount && session.inputReady && session.inputEmpty && !session.stopping) {
        assertSessionModel(session);
        args.fresh_session_confirmed = true;
        log(`adapter.${sessionProvider}_session_ready`, { evidence: 'empty_existing_composer', model_preservation: selectedModel && session.model ? 'observed_unchanged' : 'no_reload_unverified_model', payload: { model: session.model } });
        return;
      }
      const target = await act(`${sessionProvider}NewChatTarget`);
      log(`adapter.${sessionProvider}_new_chat_target`, { ready: target.ready, reason: target.reason, payload: { target: target.target || null } });
      if (!target.ready) throw new AdapterError(`${sessionProvider}_new_chat_required`, `当前 ${sessionName} 页面已有对话，未找到可点击的新建对话按钮。请手动新建空白对话，或更新 new_chat 选择器；不会刷新页面重置模型。`, { session });
      let blockedNavigation = false;
      const blockReload = event => {
        // Electron does not emit will-navigate for pushState/hash SPA routing.
        // Suppress a plain anchor's document navigation before it resets the model.
        event.preventDefault(); blockedNavigation = true;
        log(`adapter.${sessionProvider}_full_navigation_blocked`, { operation: 'new_chat', reason: 'preserve_selected_model' });
      };
      if (typeof wc.on === 'function') {
        wc.on('will-navigate', blockReload);
        wc.on('will-redirect', blockReload);
      }
      try {
        await dispatchTrustedInput(wc, target, deadline, signal, (event, fields) => log(event, { operation: `${sessionProvider}_new_chat`, ...fields }), assertProviderOrigin);
        log(`adapter.${sessionProvider}_new_chat_dispatched`, { payload: { target: target.target } });
        const newChatDeadline = Math.min(deadline, Date.now() + 15000);
        while (Date.now() < newChatDeadline) {
          if (blockedNavigation) throw new AdapterError(`${sessionProvider}_new_chat_requires_reload`, `${sessionName} 新对话控件试图刷新整个页面，已阻止以保留所选模型。请手动新建空白对话，或更新为网页内的新建对话按钮选择器。`);
          const after = await act(sessionAction);
          if (sessionProvider === 'glm' && selectedModel && !after.model) {
            await pause(250, deadline, signal);
            continue;
          }
          assertSessionModel(after);
          // A URL change alone is not sufficient: old turns can remain while a
          // new route loads. Require an empty conversation and ready composer.
          if (!after.answers && !after.userCount && after.inputPresent && !after.stopping) {
            try { await dismissQwenRating(); }
            catch (error) {
              const blocked = await deferQwenRatingToManualSend(error, 'after_new_chat');
              args.fresh_session_confirmed = true;
              log(`adapter.${sessionProvider}_session_ready`, { evidence: 'empty_composer_with_manual_rating_fallback',
                route_changed: session.conversation !== blocked.conversation, model_preservation: selectedModel && blocked.model ? 'observed_unchanged' : 'no_reload_unverified_model' });
              return;
            }
            const verified = await act(sessionAction);
            if (verified.inputReady && verified.inputEmpty && !verified.answers && !verified.userCount) {
              assertSessionModel(verified);
              args.fresh_session_confirmed = true;
              log(`adapter.${sessionProvider}_session_ready`, { evidence: 'previous_turns_cleared', route_changed: session.conversation !== verified.conversation,
                model_preservation: selectedModel && verified.model ? 'observed_unchanged' : 'no_reload_unverified_model', payload: { model: verified.model } });
              return;
            }
          }
          await pause(250, deadline, signal);
        }
        throw new AdapterError(`${sessionProvider}_new_chat_unconfirmed`, `${sessionName} 新建对话操作后，旧消息仍未清空或输入框未就绪。未输入或发送，请检查网页；不会刷新或重复点击。`);
      } finally {
        if (typeof wc.removeListener === 'function') {
          wc.removeListener('will-navigate', blockReload);
          wc.removeListener('will-redirect', blockReload);
        }
      }
    };
    const failureDetails = () => ({ page: latestPage, send_page: lastTarget?.page || null, send_target: lastTarget?.sendTarget || null,
      send_reason: lastTarget?.reason, input_length: lastTarget?.inputLength, expected_length: lastTarget?.expectedLength,
      input_dispatched: inputDispatched, dispatched: submitted, accepted, capture: latestCapture,
      prompt: promptMetrics(job.prompt), network: stopNetwork.state?.() || null });
    const failureHint = () => {
      const page = latestPage || {}, target = lastTarget?.sendTarget;
      return `visibility=${page.visibilityState || 'unknown'}, focus=${page.hasFocus ?? 'unknown'}, selector=${String(target?.selector || 'none').slice(0, 140)}, disabled=${target?.disabled ?? 'unknown'}, obscured=${target?.obscured ?? 'unknown'}, input=${lastTarget?.inputLength ?? '?'}/${lastTarget?.expectedLength ?? '?'}`;
    };
    const evidenceFor = snapshot => snapshot.recovery?.reason === 'recovery_waiting_acceptance' ? null
      : snapshot.recovery?.currentTurnAccepted === true ? 'new_user_turn' : submissionEvidence(before, snapshot);
    const complete = async result => {
      let extraction = extractReply(result.answer, markdownFromHTML);
      const structuredRequested = ['qwen', 'doubao'].includes(this.provider.id) &&
        /(?:\bjson\b|JSON|结构化(?:数据|结果)|机器可读)/i.test(String(job.prompt || ''));
      if (structuredRequested) {
        // The native copy action is the source of truth for Doubao structured
        // replies. Turndown can escape JSON punctuation and rewrite links when
        // it serializes the rendered HTML, so never prefer that representation
        // when a provider copy is available. Qwen keeps the historical HTML
        // first order because its copy control is only a fallback for older DOM
        // revisions.
        const copyFirst = this.provider.id === 'doubao';
        let htmlJSON = null;
        let copiedProtocol = null;
        const tryNativeCopy = async () => {
          if (typeof this.options.readClipboard !== 'function') return null;
          try {
            const target = await act(copyFirst ? 'copyMarkdownTarget' : 'qwenCopyMarkdownTarget');
            if (target?.ready) {
              await dispatchTrustedInput(wc, target, deadline, signal,
                (event, fields) => log(event, { operation: `${this.provider.id}_copy_markdown`, ...fields }), assertProviderOrigin);
              // Provider copy handlers write asynchronously to the system
              // clipboard. Keep the wait bounded by the original generation
              // deadline and never synthesize a clipboard value locally.
              await pause(120, deadline, signal);
              const copied = await Promise.resolve(this.options.readClipboard());
              copiedProtocol = copyProtocolText(copied);
              if (copiedProtocol) extraction = copiedProtocol;
              log(`adapter.${this.provider.id}_json_copy_attempt`, { ready: true,
                qualified: Boolean(copiedProtocol), method: copiedProtocol?.method || null,
                copied_chars: typeof copied === 'string' ? copied.length : 0 });
            } else {
              log(`adapter.${this.provider.id}_json_copy_attempt`, { ready: false, reason: target?.reason || 'copy_control_missing' });
            }
            return copiedProtocol;
          } catch (error) {
            checkAbort(signal);
            log(`adapter.${this.provider.id}_json_copy_attempt`, { ready: false, reason: error.code || 'copy_failed' });
            return null;
          }
        };
        if (!copyFirst) {
          htmlJSON = htmlToJSON(result.answer?.html || '');
          if (htmlJSON) extraction = htmlJSON;
        }
        if (!htmlJSON || copyFirst) await tryNativeCopy();
        // For Doubao, a copied raw Agent envelope is intentionally retained even
        // when strict JSON parsing fails; the desktop-agent repair archive can
        // analyze that exact source. Only fall back to HTML when copy was not
        // available or did not contain a complete protocol envelope.
        if (copyFirst && !copiedProtocol) {
          htmlJSON = htmlToJSON(result.answer?.html || '');
          if (htmlJSON) extraction = htmlJSON;
        }
        const extractionIsQualified = Boolean(extractJSONFromText(extraction.content));
        const copiedRaw = ['copy_markdown_to_json', 'copy_protocol_raw'].includes(extraction.method);
        if (this.provider.id === 'qwen' && !htmlJSON && !extractionIsQualified && !copiedRaw) {
          try {
            const dom = await act('qwenDOMJSON');
            const domJSON = domToJSON(dom?.candidates) || htmlToJSON(dom?.html || '');
            if (domJSON) extraction = domJSON;
            log('adapter.qwen_json_dom_attempt', { ready: Boolean(dom?.ready), qualified: Boolean(domJSON) });
          } catch (error) {
            checkAbort(signal);
            log('adapter.qwen_json_dom_attempt', { ready: false, reason: error.code || 'dom_json_failed' });
          }
        }
      }
      const markdown = extraction.content;
      if (!markdown) throw new AdapterError('empty_output', '网页回复转换为 Markdown 后为空。');
      log('adapter.complete', { markdown_length: markdown.length, extraction_method: extraction.method, completion_signal: result.reason,
        saw_stop: tracker.seenStop, recovery_used: recoveryStarted,
        completion_strategy: stopNetwork.state?.().observed ? 'network_and_dom' : 'dom_stability',
        payload: { markdown, completion_evidence: { network: stopNetwork.state?.() || null, stop_indicator_observed: tracker.seenStop, capture: latestCapture } } });
      this.status('ready', '已获取回复。');
      return markdown;
    };
    const waitForManualQwenSend = async reason => {
      if (this.provider.id !== 'qwen') throw new AdapterError('manual_send_unsupported', '当前模型不支持 Qwen 人工发送等待。');
      const checkpoint = stopNetwork.checkpoint?.() || { responseCount: 0, failureCount: 0 };
      const baseline = before;
      const waitSeconds = Math.min(120, Math.max(1, Number(job.qwen_manual_retry_wait_seconds ?? 20)));
      const waitDeadline = Math.min(deadline, Date.now() + waitSeconds * 1000);
      stopNetwork.arm?.();
      await releaseInteraction();
      log('adapter.qwen_manual_send_wait_started', { reason, wait_seconds: Math.max(0, (waitDeadline - Date.now()) / 1000), checkpoint });
      this.status('manual_retry_required', `Qwen 评分面板未能自动关闭。请在 ${Math.ceil(waitSeconds)} 秒内回到原网页，手动关闭评分面板并点击发送；程序会持续监控网页，直到拿到模型回复。`);
      let started = false, lastCountdown = -1;
      tracker = null;
      while (Date.now() < deadline) {
        const snapshot = await observe(true);
        const mark = stopNetwork.checkpoint?.() || checkpoint;
        const evidence = submissionEvidence(baseline, snapshot);
        if (!started && (mark.responseCount > checkpoint.responseCount || ['new_user_turn', 'generation_indicator', 'new_assistant_content'].includes(evidence))) {
          const detectedEvidence = mark.responseCount > checkpoint.responseCount ? 'network_request' : evidence;
          const claim = await act('confirmManualSubmit', { manual_evidence: detectedEvidence });
          if (!claim?.ready) throw new AdapterError('qwen_manual_send_context_changed', '检测到人工发送迹象，但网页任务上下文已改变；已停止采集以避免读取其他会话。', failureDetails());
          started = true;
          submitted = true;
          accepted = detectedEvidence !== 'network_request' || claim.currentTurnAccepted === true;
          this.lastSubmittedAt = Date.now();
          tracker = new CompletionTracker(baseline, { stableSeconds: job.stable_seconds, minWaitSeconds: job.min_wait_seconds });
          tracker.lastChangedAt = Date.now();
          log('adapter.qwen_manual_send_detected', { evidence: detectedEvidence,
            response_count: mark.responseCount, current_turn_accepted: claim.currentTurnAccepted === true, payload: { network: stopNetwork.state?.() || null } });
          this.status('generating', '已检测到手动发送，正在持续等待 Qwen 返回完整回答…');
        }
        if (!started && mark.failureCount > checkpoint.failureCount) {
          throw new AdapterError('response_network_failed', '手动发送后 Qwen 请求返回网络错误；已保留网页和网络诊断。', failureDetails());
        }
        if (started) {
          const result = tracker.update(snapshot);
          latestCapture = result.capture || null;
          waitReason(result.reason === 'waiting_network_response' && snapshot.stopping ? 'streaming' : result.reason, latestCapture);
          if (result.done) return await complete(result);
          if (mark.failureCount > checkpoint.failureCount) {
            throw new AdapterError('response_network_failed', '手动发送后 Qwen 请求失败；已保留网页和网络诊断。', failureDetails());
          }
        } else {
          const seconds = Math.max(0, Math.ceil((waitDeadline - Date.now()) / 1000));
          if (seconds !== lastCountdown) {
            lastCountdown = seconds;
            log('adapter.qwen_manual_send_wait', { remaining_seconds: seconds, reason, evidence: evidence || 'none',
              response_count: mark.responseCount, user_count: snapshot.userCount, last_user_matches_prompt: snapshot.lastUserMatchesPrompt, stopping: snapshot.stopping });
          }
          if (Date.now() >= waitDeadline) {
            throw new AdapterError('qwen_manual_send_timeout', `等待手动发送已超过 ${Math.ceil(waitSeconds)} 秒，未检测到 Qwen 新请求；未自动重复发送。`, failureDetails());
          }
        }
        if (Date.now() + 500 >= deadline) break;
        await pause(500, deadline, signal);
      }
      throw new AdapterError('qwen_manual_send_timeout', 'Qwen 手动发送后仍未取得完整回答；已持续监控到当前任务时限。', failureDetails());
    };
    const recover = async cause => {
      // Preserve the failed-generation watermark before yielding the input lease.
      // A user/site retry can start during release, repaint or screenshot work.
      const recoveryEntryCheckpoint = stopNetwork.checkpoint?.() || { responseCount: 0, failureCount: 0 };
      const recoveryEntrySnapshot = latestSnapshot || before;
      recoveryStarted = true;
      deadline = Math.min(totalDeadline, generationDeadline + recoveryMs, Date.now() + recoveryMs);
      await releaseInteraction();
      if (this.provider.id === 'qwen' && job.qwen_retry_stages !== false) {
        log('adapter.recovery_started', { code: cause.code, timeout_seconds: Math.max(0, (deadline-Date.now())/1000), dispatched: submitted, accepted });
        return runQwenRecovery({ job, cause, entryCheckpoint: recoveryEntryCheckpoint, entrySnapshot: recoveryEntrySnapshot, act, observe, network: stopNetwork, wc, deadline, signal,
          origin: expectedOrigin, artifacts: this.options.retryArtifacts || {}, artifactStore: retryArtifacts, bounded, pause, log,
          status: (state, message) => this.status(state, message),
          fail: (code, message) => new AdapterError(code, message, failureDetails()),
          acquire: async () => {
            assertProviderOrigin();
            if (this.options.acquireInput) {
              releaseInput = await this.options.acquireInput({ job: { ...job, provider_id: this.provider.id }, signal, deadline: Math.min(deadline, Date.now()+5000) });
              if (typeof releaseInput !== 'function') throw new AdapterError('input_lease_invalid', 'Qwen 重试未能取得页面输入权限。');
              await bounded(wc.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true }), deadline, signal);
              focusEmulated = true;
            }
            if (preserveModel) assertSessionModel(await act(sessionAction));
          },
          release: releaseInteraction,
          dispatch: target => dispatchTrustedInput(wc, target, deadline, signal,
            (event, fields) => log(event, { operation: 'retry_visual_current_turn', ...fields }), assertProviderOrigin),
          settle: (stage, checkpoint, baseline) => settleSubmission(stage, checkpoint, baseline, true),
          resume: (baseline, snapshot) => {
            tracker = new CompletionTracker(baseline || before, { stableSeconds: job.stable_seconds, minWaitSeconds: job.min_wait_seconds });
            tracker.lastChangedAt = Date.now();
            if (snapshot.recovery?.currentTurnAccepted) {
              if (!accepted) log('adapter.submission_accepted', { evidence: 'same_turn_recovery' });
              accepted = true;
            }
          },
          pollComplete: async snapshot => {
            if (!accepted || !tracker || !snapshot.recovery?.contextValid || !snapshot.recovery?.currentTurnAccepted) return { done: false };
            const result = tracker.update(snapshot); latestCapture = result.capture || null;
            waitReason(result.reason === 'waiting_network_response' && snapshot.stopping ? 'streaming' : result.reason, latestCapture);
            return result.done ? { done: true, value: await complete(result) } : { done: false };
          },
        });
      }
      let checkpoint = stopNetwork.checkpoint?.() || { responseCount: 0, failureCount: 0 };
      let prior = latestSnapshot || before;
      let pendingProof = true, manualShown = false, manualActive = false, retryDispatched = false;
      // A delayed Qwen error/footer may appear after Network.loadingFailed.
      // Keep polling for the ONE permitted gesture, but never race a manual or
      // site-initiated new generation, even if its old error card is still shown.
      const recoveryEntryMark = checkpoint;
      let automaticRetrySuppressed = false, retryRevealAttempted = false, lastRetryWait = '';
      let manualAt = Date.now() + Math.min(15000, recoveryMs / 3);
      let requiresNetworkAttempt = cause.code === 'response_network_failed';
      let requiresGenerationCycle = Boolean(prior?.recovery?.currentError);
      let pageFailureActive = Boolean(prior?.recovery?.currentError);
      let originalStillRunning = cause.code === 'timeout' && Boolean(prior?.responsePending || prior?.stopping)
        && !stopNetwork.state?.().failed.length && !prior?.recovery?.currentError;
      const promptManual = reason => {
        if (manualActive) return;
        manualShown = true; manualActive = true;
        log('adapter.recovery_manual_required', { reason, original_code: cause.code, remaining_seconds: Math.max(0, Math.ceil((deadline - Date.now()) / 1000)) });
        this.status('manual_retry_required', '请在此模型网页点击当前回合的“重试/重新生成”；若完整提示仍在输入框，请检查后手动发送。保持当前会话，程序会等待并继续采集本轮回答。');
      };
      log('adapter.recovery_started', { code: cause.code, timeout_seconds: Math.max(0, (deadline - Date.now()) / 1000), dispatched: submitted, accepted });
      let snapshot = await observe(true);
      // Only a new error panel belonging to this exact user turn permits a
      // retry gesture. A timeout, an HTTP 200 or a full composer never does.
      const tryAutomaticRetry = async snapshot => {
        if (retryDispatched || automaticRetrySuppressed || verificationSeen || !snapshot.recovery?.contextValid ||
            !snapshot.recovery.currentError || !(snapshot.recovery.retryAvailable || snapshot.recovery.retryRevealable && !retryRevealAttempted) || snapshot.stopping || snapshot.responsePending) return false;
        try {
          if (this.options.acquireInput) {
            releaseInput = await this.options.acquireInput({ job: { ...job, provider_id: this.provider.id }, signal, deadline: Math.min(deadline, Date.now() + 5000) });
            if (typeof releaseInput !== 'function') throw new AdapterError('input_lease_invalid', '重试输入环境不可用。');
          }
          if (this.options.acquireInput) {
            await bounded(wc.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true }), deadline, signal);
            focusEmulated = true;
          }
          // Input leases can wait behind another model. Recheck the same turn
          // and network after waiting; the user/site may already have retried.
          snapshot = await observe(true);
          const mark = stopNetwork.checkpoint?.() || recoveryEntryMark;
          if (mark.responseCount > recoveryEntryMark.responseCount || snapshot.stopping || snapshot.responsePending) {
            automaticRetrySuppressed = true;
            log('adapter.recovery_auto_skipped', { reason: 'generation_started_before_retry_claim' });
            return false;
          }
          if (!snapshot.recovery?.currentError || !snapshot.recovery?.contextValid || verificationSeen) return false;
          if (preserveModel) assertSessionModel(await act(sessionAction));
          if (!snapshot.recovery.retryAvailable && snapshot.recovery.retryRevealable && !retryRevealAttempted) {
            retryRevealAttempted = true;
            const revealed = await act('recoveryReveal');
            log('adapter.recovery_target_revealed', { ready: Boolean(revealed?.ready), reason: revealed?.reason });
            if (revealed?.contextChanged) throw new AdapterError('recovery_context_changed', '滚动后网页回合已变化，未点击重试。');
            if (!revealed?.ready) return false;
          }
          let target = await act('recoveryTarget');
          log('adapter.recovery_target', { ready: Boolean(target?.ready), reason: target?.reason || 'unknown',
            error_kind: snapshot.recovery?.errorKind || 'current_turn_error' });
          if (target?.ready) {
            target = await act('recoveryClaim', { nonce: target.nonce });
            if (target?.ready && target.method === 'button') {
              // Check once more after the asynchronous reservation. Consuming
              // a claim without clicking is safer than duplicating a new request.
              const latestMark = stopNetwork.checkpoint?.() || recoveryEntryMark;
              if (latestMark.responseCount > recoveryEntryMark.responseCount || stopNetwork.state?.().pending) {
                automaticRetrySuppressed = true;
                log('adapter.recovery_auto_skipped', { reason: 'generation_started_during_retry_claim' });
                return false;
              }
              // Claim before CDP, so ambiguous click acknowledgement is never
              // followed by a second automatic gesture or by Enter.
              retryDispatched = true;
              manualActive = false;
              manualAt = Date.now() + Math.min(15000, recoveryMs / 3);
              log('adapter.recovery_retry', { attempt: 1, max_attempts: 1,
                error_kind: snapshot.recovery?.errorKind || 'current_turn_error', reason: 'current_turn_error_and_verified_retry_control' });
              this.status('retrying', snapshot.recovery?.errorKind === 'qwen_network'
                ? 'Qwen 网络错误，正在点击当前回合的“重试”（1/1）…' : '正在点击当前回合的网页重试按钮（1/1）…');
              await dispatchTrustedInput(wc, target, deadline, signal, (event, fields) => log(event, { operation: 'retry_current_turn', ...fields }), assertProviderOrigin);
              await settleSubmission('retry_current_turn', latestMark, snapshot, true);
            }
          }
        } catch (error) {
          checkAbort(signal);
          if (['recovery_context_changed', 'provider_origin_changed', 'qwen_model_changed', 'glm_model_changed'].includes(error.code)) throw error;
          // Unknown reservation/CDP state is not an invitation to try again.
          automaticRetrySuppressed = true;
          log('adapter.recovery_retry_unconfirmed', { code: error.code || 'retry_control_unavailable', dispatched: retryDispatched });
        } finally { await releaseInteraction(); }
        return retryDispatched;
      };
      await tryAutomaticRetry(snapshot);
      if (!retryDispatched) promptManual(cause.code);
      let lastFailureCount = checkpoint.failureCount;
      while (Date.now() < deadline) {
        snapshot = await observe(true);
        const mark = stopNetwork.checkpoint?.() || checkpoint;
        const report = snapshot.recovery;
        if (!retryDispatched && (mark.responseCount > recoveryEntryMark.responseCount || snapshot.stopping && !prior?.stopping)) {
          if (!automaticRetrySuppressed) log('adapter.recovery_auto_skipped', { reason: 'observed_external_generation' });
          automaticRetrySuppressed = true;
        }
        if (mark.failureCount > lastFailureCount) {
          lastFailureCount = mark.failureCount;
          checkpoint = mark; prior = snapshot; pendingProof = true; originalStillRunning = false;
          requiresNetworkAttempt = true;
          promptManual('retry_response_failed');
        }
        if (report?.currentError && !pageFailureActive) {
          checkpoint = mark; prior = snapshot; pendingProof = true; originalStillRunning = false;
          requiresGenerationCycle = true;
          promptManual('retry_page_error');
        }
        pageFailureActive = Boolean(report?.currentError);
        const newNetworkAttempt = mark.responseCount > checkpoint.responseCount;
        const changedAnswer = answerSignature(snapshot.answers.at(-1)) !== answerSignature(prior?.answers?.at(-1));
        const newUserTurn = snapshot.userCount > (prior?.userCount || 0) && snapshot.lastUserMatchesPrompt;
        const startedGenerating = snapshot.stopping && !prior?.stopping;
        const originalFinished = originalStillRunning && !snapshot.stopping && !snapshot.responsePending;
        // A failed HTTP stream can still flush buffered fragments into the DOM.
        // Neither a changed fragment nor hiding its error panel clears that
        // failure: the known endpoint must start a new generation request.
        const proof = requiresNetworkAttempt ? newNetworkAttempt : requiresGenerationCycle ? (newNetworkAttempt || startedGenerating)
          : (newNetworkAttempt || changedAnswer || newUserTurn || startedGenerating || originalFinished);
        if (pendingProof && report?.contextValid && report.currentTurnAccepted === true && !report.currentError && proof) {
          stopNetwork.acknowledgeFailures?.(checkpoint);
          if (!originalStillRunning) tracker = new CompletionTracker(prior || before, { stableSeconds: job.stable_seconds, minWaitSeconds: job.min_wait_seconds });
          if (!tracker) tracker = new CompletionTracker(before, { stableSeconds: job.stable_seconds, minWaitSeconds: job.min_wait_seconds });
          tracker.lastChangedAt = Date.now();
          pendingProof = false; manualActive = false;
          log('adapter.recovery_observed', { evidence: newNetworkAttempt ? 'new_generation_request' : changedAnswer ? 'changed_current_answer' : newUserTurn ? 'matching_user_turn' : startedGenerating ? 'generation_indicator' : 'original_response_finished' });
          this.status('recovering', '已观察到当前回合恢复，继续等待完整回答…');
        }
        if (!pendingProof && report?.contextValid && report.currentTurnAccepted === true && !report.currentError && !stopNetwork.state?.().failed.length) {
          if (!accepted) {
            const evidence = evidenceFor(snapshot);
            if (evidence) { accepted = true; log('adapter.submission_accepted', { evidence }); }
          }
          if (accepted) {
            const result = tracker.update(snapshot);
            latestCapture = result.capture || null;
            waitReason(result.reason === 'waiting_network_response' && snapshot.stopping ? 'streaming' : result.reason, latestCapture);
            if (result.done) return await complete(result);
          }
        }
        // The old implementation checked a retry target only on entry. Qwen
        // often paints the network-error card/button one or more polls later.
        // Other providers retain the original entry-only behavior.
        if (this.provider.id === 'qwen' && pendingProof && !retryDispatched && !automaticRetrySuppressed && !verificationSeen) {
          const reason = report?.retryAvailable ? 'waiting_idle_response' : report?.reason || 'waiting_current_turn_error';
          if (reason !== lastRetryWait) {
            lastRetryWait = reason;
            log('adapter.recovery_waiting_target', { reason, error_kind: report?.errorKind || null,
              remaining_seconds: Math.max(0, Math.ceil((deadline - Date.now()) / 1000)) });
          }
          await tryAutomaticRetry(snapshot);
        }
        if (retryDispatched && Date.now() >= manualAt && (pendingProof || report?.currentError)) promptManual('automatic_retry_no_response');
        if (Date.now() + 500 >= deadline) break;
        await pause(500, deadline, signal);
      }
      throw new AdapterError('recovery_timeout', '本轮网页恢复等待已到期，仍未取得完整回答。已保留失败诊断；没有重新填入提示或创建新会话。请检查网页后再继续任务。',
        { original_code: cause.code, retry_dispatched: retryDispatched, manual_prompted: manualShown, ...failureDetails() });
    };
    try {
      validateSelectors(this.provider.selectors);
      log('adapter.start', { purpose: job.purpose, prompt_length: job.prompt.length, timeout_seconds: job.timeout_seconds,
        ...promptMetrics(job.prompt), input_chunk_chars: job.input_chunk_chars ?? 4096,
        payload: { prompt: job.prompt, url: this.provider.url } });
      checkAbort(signal);
      if (throttleMs > 0) {
        this.status('rate_limited', `访问过快，等待 ${(throttleMs / 1000).toFixed(1)} 秒…`);
        log('adapter.rate_limit_wait_started', { wait_ms: throttleMs, access_interval_seconds: intervalMs / 1000 });
        await pause(throttleMs, deadline, signal);
        log('adapter.rate_limit_wait_finished', { wait_ms: throttleMs, access_interval_seconds: intervalMs / 1000 });
      }
      let reusePage = false;
      if (preserveModel && typeof wc.getURL === 'function') {
        try { const current = new URL(wc.getURL()), configured = new URL(this.provider.url); reusePage = ['http:', 'https:'].includes(current.protocol) && current.origin === configured.origin; } catch {}
      }
      if (reusePage) {
        this.status('loading', `正在复用 ${sessionName} 页面并保留所选模型…`);
        log('adapter.navigation_reused', { reason: `${sessionProvider}_preserve_selected_model`, payload: { url: wc.getURL() } });
      } else {
        this.status('loading', '正在打开模型网页…');
        await bounded(wc.loadURL(this.provider.url), deadline, signal);
        assertProviderOrigin();
        log('adapter.navigation_complete');
      }
      if (this.options.acquireInput) {
        log('adapter.input_lease_wait', { payload: { page: latestPage } });
        // The host owns cancellation while queued. Do not race and discard a
        // later release handle: that would leave a hidden tab pinned forever.
        try { releaseInput = await this.options.acquireInput({ job: { ...job, provider_id: this.provider.id }, signal, deadline }); }
        catch (error) {
          if (['input_lease_timeout', 'provider_unavailable', 'input_view_unavailable', 'cancelled'].includes(error.code)) {
            throw new AdapterError(error.code, String(error.message).slice(0, 600));
          }
          throw error;
        }
        if (typeof releaseInput !== 'function') throw new AdapterError('input_lease_invalid', '模型页面显示调度没有返回释放句柄，未执行输入。');
        checkAbort(signal);
        log('adapter.input_lease_acquired');
      }
      await attachDebugger();
      try {
        await bounded(wc.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true }), deadline, signal);
        focusEmulated = true;
        log('adapter.focus_emulation', { acknowledged: true });
      } catch (error) {
        checkAbort(signal);
        log('adapter.focus_emulation_unavailable', { code: error.code || 'focus_emulation_unsupported' });
      }
      await pause(100, deadline, signal);
      // A hidden native view can defer mounting its composer. Acquire and focus
      // FIRST; a missing/login-blocked candidate must not monopolize a 60s pair.
      const readyBudget = Number.isFinite(job.total_timeout_seconds)
        ? Math.min(15000, Math.max(1000, (deadline - Date.now()) / 3)) : 45000;
      const readyDeadline = Math.min(deadline, Date.now() + readyBudget);
      while (Date.now() < readyDeadline) {
        before = await observe();
        if ((before.inputReady || (this.provider.id === 'qwen' && (await act('qwenSession')).inputPresent)) && !before.stopping) break;
        waitReason(before.stopping ? 'page_busy' : 'input_missing');
        await pause(500, deadline, signal);
      }
      if ((!before?.inputReady && !(this.provider.id === 'qwen' && (await act('qwenSession')).inputPresent)) || before.stopping) throw new AdapterError('login_or_selector_required', '找不到可用输入框，请先在该标签登录，或更新输入框选择器。');
      await pause(750, deadline, signal);
      before = await observe();
      log('adapter.focus_state', { payload: { page: latestPage } });
      if (this.options.acquireInput && !backgroundRequest && (latestPage?.visibilityState !== 'visible' || !latestPage?.hasFocus)) {
        throw new AdapterError('page_not_interactive', `模型页面未获得可见且聚焦的输入环境（${failureHint()}）。未执行输入；请恢复模型窗口或切换到并排显示。`);
      }
      if (preserveModel) {
        await preparePreservedSession();
        before = await observe();
      }
      let prepared = await act('prepare');
      while (prepared.verification?.required) {
        await waitForVerification(prepared);
        prepared = await act('prepare');
      }
      latestPage = prepared.page || latestPage;
      if (!prepared.ready) throw new AdapterError(prepared.reason,
        prepared.reason === 'input_too_long'
          ? `完整请求有 ${prepared.expectedLength} 字符，超过网页输入框的 ${prepared.inputLimit} 字符限制；未截断任务、未输入或发送。请缩短历史或开始新的 Agent 对话。`
          : '输入框非空、不可用或网页仍在生成，请检查输入区域后再发送。', prepared);
      preparedJob = true;
      if (prepared.inputFocused === false) throw new AdapterError('input_focus_failed', '网页输入框未获得焦点，未执行发送；输入可能已填入，请检查网页现场。');
      let filled;
      if (prepared.inputMethod === 'cdp_insert_text') {
        checkAbort(signal);
        log('adapter.input_dispatch', { transport: 'cdp_insert_text', prompt_length: job.prompt.length });
        // Native edits only, without probing framework private handlers. Plain
        // long text is appended with checks; no received text is reinserted.
        inputDispatched = true;
        try {
          assertProviderOrigin();
          // Doubao swaps its textarea for a rich editor while a native edit is
          // being committed. Chunking across that replacement loses the
          // second chunk and leaves a filled-but-unsent draft. A single native
          // edit lets the site process the complete prompt atomically; the
          // submit gate below rebinds to the replacement editor if needed.
          const parts = prepared.inputKind === 'rich' || this.provider.id === 'doubao'
            ? [job.prompt.replace(/\r\n?/g, '\n')] : inputChunks(job.prompt, job.input_chunk_chars ?? 4096);
          const chunkDelay = Math.min(1000, Math.max(0, job.input_chunk_delay_ms ?? 35));
          let offset = 0;
          const verifyPrefix = async expected => {
            let report;
            // A controlled editor may need a few animation frames to expose
            // the replacement node and commit the native input event. Retry
            // only when the observed value is still a verified prefix; any
            // changed/non-prefix text remains a hard stop.
            const settleDeadline = Math.min(deadline, Date.now() + 2500);
            do {
              report = await act('inputProgress', { input_offset: expected });
              if (report.ready) return report;
              const transient = report.prefixMatches === true && report.inputLength <= expected &&
                ['input_pending', 'input_replaced_or_disabled', 'input_focus_lost'].includes(report.reason);
              if (!transient || Date.now() >= settleDeadline) break;
              await pause(Math.min(120, Math.max(30, chunkDelay)), deadline, signal);
            } while (Date.now() < settleDeadline);
            throw new AdapterError('input_prefix_mismatch',
              `长输入校验失败（${report?.reason || 'unknown'}，${report?.inputLength ?? '?'}/${expected}）；未点击发送，不会覆盖草稿或重复输入。`,
              { input: report, prompt: promptMetrics(job.prompt) });
          };
          for (let index = 0; index < parts.length; index++) {
            checkAbort(signal); assertProviderOrigin();
            if (parts.length > 1) await verifyPrefix(offset);
            await bounded(wc.debugger.sendCommand('Input.insertText', { text: parts[index] }), deadline, signal);
            offset += parts[index].length;
            if (parts.length > 1) {
              // Let the site's controlled editor commit this native input event.
              if (chunkDelay) await pause(chunkDelay, deadline, signal);
              await verifyPrefix(offset);
              log('adapter.input_chunk', { part: index + 1, parts: parts.length, input_length: offset });
            }
          }
          log('adapter.input_acknowledged', { transport: parts.length > 1 ? 'cdp_verified_chunks' : 'cdp_insert_text',
            parts: parts.length, acknowledged: true, ...promptMetrics(job.prompt) });
        }
        catch (error) {
          if (error instanceof AdapterError) throw error;
          throw new AdapterError('input_dispatch_failed', '模型网页的原生输入通道返回错误；文本可能已填入，但未执行发送。请检查网页现场，不会自动重复输入。');
        }
        filled = await act('canSubmit');
        sendState(filled);
        // If Doubao's textarea imposes a browser-side edit cap, the one-shot
        // native insertion may leave a verified prefix only. Append exactly
        // the missing suffix once (never resend the prefix) before the normal
        // send-button gate runs.
        if (this.provider.id === 'doubao' && !filled?.ready && filled?.prefixMatches === true &&
            Number.isInteger(filled.inputLength) && filled.inputLength > 0) {
          const normalizedPrompt = job.prompt.replace(/\r\n?/g, '\n');
          if (filled.inputLength < normalizedPrompt.length) {
            const prefix = await act('inputProgress', { input_offset: filled.inputLength });
            if (prefix.ready) {
              const remainder = normalizedPrompt.slice(filled.inputLength);
              await bounded(wc.debugger.sendCommand('Input.insertText', { text: remainder }), deadline, signal);
              if (chunkDelay) await pause(chunkDelay, deadline, signal);
              filled = await act('canSubmit');
              sendState(filled);
            }
          }
        }
      }
      log('adapter.input_prepared', { input_source: prepared.inputSource, input_length: filled?.inputLength ?? prepared.inputLength, input_transport: prepared.inputMethod || 'dom' });
      await pause(750, deadline, signal);
      let target;
      let sendDeadline = Math.min(deadline, Date.now() + 10000);
      while (Date.now() < sendDeadline) {
        target = await act('canSubmit');
        sendState(target);
        if (manualQwenSendRequired && !target.ready) break;
        if (target.verification?.required) {
          await waitForVerification(target);
          sendDeadline = Math.min(deadline, Date.now() + 10000);
          continue;
        }
        if (target.ready) break;
        if (this.provider.id === 'qwen' && ['send_obscured', 'send_disabled'].includes(target.reason)) {
          let dismissed = false;
          try { dismissed = await dismissQwenRating(); }
          catch (error) {
            if (!String(error?.code || '').startsWith('qwen_rating_')) throw error;
            manualQwenSendRequired = true;
            log('adapter.qwen_rating_auto_dismiss_failed', { code: error.code, reason: error.message });
            break;
          }
          if (dismissed) continue;
          const session = await act('qwenSession');
          if (session.rating?.length) {
            manualQwenSendRequired = true;
            log('adapter.qwen_manual_send_required', { reason: 'rating_panel_blocks_send', payload: { rating: session.rating } });
            break;
          }
        }
        waitReason(target.reason || 'send_not_ready');
        if (Date.now() + 250 >= sendDeadline) break;
        await pause(250, deadline, signal);
      }
      if (!target?.ready) {
        if (manualQwenSendRequired) return await waitForManualQwenSend(target?.reason || 'rating_panel_blocks_send');
        throw sendNotReady(target);
      }
      log('adapter.input_verified', { input_length: target.inputLength, expected_length: target.expectedLength, verified: true, method: 'exact_text_after_line_ending_normalization' });
      checkAbort(signal);
      if (preserveModel) assertSessionModel(await act(sessionAction));
      await attachDebugger();
      target = await act('claimSubmit');
      while (target.verification?.required) {
        await waitForVerification(target);
        if (preserveModel) assertSessionModel(await act(sessionAction));
        target = await act('claimSubmit');
      }
      sendState(target);
      if (!target.ready) {
        if (this.provider.id === 'qwen') {
          const session = await act('qwenSession');
          if (session.rating?.length) return await waitForManualQwenSend('rating_panel_blocks_claim');
        }
        throw sendNotReady(target);
      }
      checkAbort(signal);
      submitted = true;
      this.lastSubmittedAt = Date.now();
      log('adapter.dispatch', { method: target.method, send_source: target.sendSource, transport: 'cdp',
        payload: { target: target.sendTarget || null, x: target.x, y: target.y } });
      const sendCheckpoint = stopNetwork.checkpoint?.() || { responseCount: 0, failureCount: 0 };
      stopNetwork.arm?.();
      await dispatchTrustedInput(wc, target, deadline, signal, log, assertProviderOrigin);
      log('adapter.submission_dispatched', { acknowledged: true });
      // A single bounded commit window, also used for the one permitted retry.
      await settleSubmission('initial_send', sendCheckpoint, before);
      await releaseInteraction();
      this.status('generating', '已投递发送动作，正在等待服务器确认网页接收…');
      const submissionTimeout = Number.isFinite(job.submission_timeout_seconds) && job.submission_timeout_seconds > 0 ? job.submission_timeout_seconds : 120;
      const confirmDeadline = Math.min(deadline, Date.now() + submissionTimeout * 1000);
      log('adapter.submission_wait_started', { timeout_seconds: Math.max(0, (confirmDeadline - Date.now()) / 1000), dispatched: true });
      let confirmation, lastConfirmationLog = Date.now();
      while (Date.now() < confirmDeadline) {
        confirmation = await observe();
        const evidence = evidenceFor(confirmation);
        if (evidence) { accepted = true; log('adapter.submission_accepted', { evidence }); break; }
        waitReason(confirmation.inputEmpty ? 'waiting_submission_evidence' : 'composer_still_contains_input');
        if (Date.now() - lastConfirmationLog >= 5000) {
          log('adapter.submission_waiting', { elapsed_ms: Date.now() - startedAt, remaining_seconds: Math.max(0, (confirmDeadline - Date.now()) / 1000), payload: { network: stopNetwork.state?.() || null, page: latestPage } });
          lastConfirmationLog = Date.now();
        }
        if (Date.now() + 500 >= confirmDeadline) break;
        await pause(500, deadline, signal);
      }
      if (!accepted) throw new AdapterError('submission_unconfirmed', `未检测到网页接收请求（${failureHint()}）：输入可能仍在对话框，或站点没有开始回复。不会自动重发；请查看发送按钮检测报告。`);
      this.status('generating', job.purpose === 'fusion' ? '正在进行语义整合…' : '正在等待网页回复…');
      tracker = new CompletionTracker(before, { stableSeconds: job.stable_seconds, minWaitSeconds: job.min_wait_seconds });
      latestCapture = tracker.update(confirmation).capture || null;
      while (Date.now() < deadline) {
        await pause(750, deadline, signal);
        const snapshot = await observe();
        const result = tracker.update(snapshot);
        latestCapture = result.capture || null;
        waitReason(result.reason === 'waiting_network_response' && snapshot.stopping ? 'streaming' : result.reason, latestCapture);
        if (result.done) {
          return await complete(result);
        }
      }
      throw new AdapterError('timeout', '网页生成超时；不会自动重发。');
    } catch (error) {
      if (crossOriginNavigation && error?.code !== 'provider_origin_changed') {
        error = new AdapterError('provider_origin_changed', '模型网页尝试跳转到其他站点，已停止本轮操作。请完成登录并返回配置的模型网址后重试。',
          { expected_origin: expectedOrigin, observed_origin: crossOriginNavigation });
      }
      const recoverable = ['submission_unconfirmed', 'response_network_failed', 'response_page_error', 'timeout'].includes(error.code);
      const retryReason = signal?.aborted ? 'cancelled' : Date.now() >= totalDeadline ? 'total_deadline_expired'
        : !recoveryMs ? 'recovery_disabled' : !submitted || !before ? 'not_submitted' : recoveryStarted ? 'already_attempted'
        : !recoverable ? 'non_recoverable_error' : 'eligible';
      if (this.provider.id === 'qwen') {
        retryArtifacts ||= new RetryArtifacts({ ...this.options.retryArtifacts, origin: expectedOrigin }, job, log);
        retryArtifacts.event('adapter.retry_eligibility', { eligible: retryReason === 'eligible', reason: retryReason,
          original_code: error.code || 'webpage_error', source: job.request_source || 'unknown',
          staged: job.qwen_retry_stages !== false, recovery_seconds: recoveryMs / 1000,
          remaining_seconds: Number.isFinite(totalDeadline) ? Math.max(0, Math.ceil((totalDeadline-Date.now())/1000)) : null });
      }
      if (retryReason === 'eligible') {
        try { return await recover(error); }
        catch (recoveryError) { error = recoveryError; }
      } else if (this.provider.id === 'qwen' && recoverable) {
        log('adapter.retry_unavailable', { reason: retryReason });
        const note = retryReason === 'total_deadline_expired' ? '候选回答总时限已耗尽，未启动重试；可在设置中增加总等待时间。'
          : retryReason === 'recovery_disabled' ? '网页异常恢复等待设置为 0，重试未启用。' : `重试未启动（${retryReason}）。`;
        error.message = `${error.message} ${note}`;
      }
      if (error.code === 'timeout' && latestCapture?.incomplete) {
        error.message = `网页生成超时，结构化回复仍不完整（${latestCapture.reason}，${latestCapture.chars} 字符）；未返回片段，也不会自动重发。`;
      }
      if (!wc.isDestroyed()) {
        wc.stop();
        try {
          assertProviderOrigin();
          void wc.executeJavaScriptInIsolatedWorld(1733, [{ code: `(${pageAction.toString()})('abort',${JSON.stringify({ id: job.job_id })})` }]).catch(() => {});
        } catch {}
      }
      const code = error.code || 'webpage_error';
      const message = error instanceof AdapterError ? error.message : `网页操作失败 (${code})；请检查登录、网络和选择器${submitted ? '，该请求不会自动重发' : ''}。`;
      log('adapter.failed', { code, input_dispatched: inputDispatched, dispatched: submitted, accepted, wait_reason: lastWaitReason, payload: { error: message, diagnostics: failureDetails() } });
      this.status('error', message);
      throw new AdapterError(code, message, error.details || failureDetails());
    } finally {
      if (typeof wc.removeListener === 'function') {
        wc.removeListener('will-navigate', rejectCrossOriginNavigation);
        wc.removeListener('will-redirect', rejectCrossOriginNavigation);
      }
      await releaseInteraction();
      stopNetwork();
      if (attached && !wc.isDestroyed() && wc.debugger.isAttached()) { try { wc.debugger.detach(); } catch {} }
      this.active = false;
    }
  }
}

module.exports = { WebsiteAdapter, CompletionTracker, markdownFromHTML, validateSelectors, pageAction, bounded, AdapterError, submissionEvidence, dispatchTrustedInput, startNetworkTrace };
