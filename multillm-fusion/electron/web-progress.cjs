'use strict';

// Never forward DOM, URLs, prompts, response text or chain-of-thought. These
// stages describe only evidence already observed by this job's adapter.
function webProgress(event, fields = {}) {
  if (event === 'adapter.rate_limit_wait_started') return { stage: 'rate_limited', wait_ms: Math.max(0, Number(fields.wait_ms) || 0) };
  if (event === 'adapter.verification_required') return { stage: 'verification_required' };
  if (event === 'adapter.verification_cleared') return { stage: 'verification_cleared' };
  if (event === 'adapter.start') return { stage: 'preparing' };
  if (event === 'adapter.submission_dispatched') return { stage: 'send_dispatched' };
  if (event === 'adapter.submission_accepted') return { stage: 'accepted' };
  if (event === 'adapter.retry_stage_started') return { stage: fields.stage === 'manual' ? 'manual_retry_required' : 'retrying',
    retry_stage: fields.stage, ...(Number.isFinite(fields.remaining_seconds) ? { remaining_seconds: fields.remaining_seconds } : {}) };
  if (event === 'adapter.retry_manual_wait') return { stage: 'manual_retry_required', retry_stage: 'manual', remaining_seconds: fields.remaining_seconds };
  if (event === 'adapter.qwen_manual_send_wait_started' || event === 'adapter.qwen_manual_send_wait') return { stage: 'manual_retry_required', retry_stage: 'manual_send',
    ...(Number.isFinite(fields.remaining_seconds) ? { remaining_seconds: fields.remaining_seconds } : Number.isFinite(fields.wait_seconds) ? { remaining_seconds: Math.ceil(fields.wait_seconds) } : {}) };
  if (event === 'adapter.qwen_manual_send_detected') return { stage: 'recovering', retry_stage: 'manual_send' };
  if (event === 'adapter.retry_unavailable') return { stage: 'retry_unavailable', retry_reason: fields.reason };
  if (event === 'adapter.recovery_retry') return { stage: 'retrying' };
  if (event === 'adapter.recovery_manual_required') return { stage: 'manual_retry_required' };
  if (event === 'adapter.recovery_observed') return { stage: 'recovering' };
  if (event === 'adapter.network_response' && fields.tracked_response && Number.isInteger(fields.status) && fields.status >= 100 && fields.status <= 599) {
    return { stage: 'server_responded', http_status: fields.status };
  }
  if (event === 'adapter.wait') {
    if (fields.reason === 'streaming') return { stage: 'generating' };
    if (['waiting_network_response', 'waiting_new_answer', 'waiting_final_content'].includes(fields.reason)) return { stage: 'waiting_response' };
    if (['waiting_stability', 'incomplete_structured_response', 'stable_answer'].includes(fields.reason)) return { stage: 'collecting' };
  }
  return null;
}

module.exports = { webProgress };
