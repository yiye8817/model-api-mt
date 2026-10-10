export interface LocalEndpoint {
  url: string; protocol: 'openai_embeddings' | 'llama_rerank' | 'llama_chat';
  model: string; model_revision: string; allow_lan: boolean;
  source?: 'custom' | 'provider'; provider_id?: string; path?: string;
  score_transform?: 'identity' | 'sigmoid'; context_tokens?: number; max_output_tokens?: number;
}
export interface LocalKnowledgeSettings {
  enabled: boolean; collect_api_chats: boolean; collect_web_chats: boolean;
  embedding_endpoint: LocalEndpoint; rerank_endpoint: LocalEndpoint; qa_endpoint: LocalEndpoint;
  vector_top_k: number; rerank_top_k: number; local_timeout_seconds: number;
  evaluation_profile_id: string; online_fallback: boolean; selected_source_ids: string[];
  time_sensitive_ttl_seconds: number;
}
export interface SourcePosition {
  kind: 'lines' | 'pdf_page' | 'docx' | 'message'; start_line?: number; end_line?: number;
  start_char?: number; end_char?: number; page?: number | null; paragraph?: number | null;
  table?: number | null; row?: number | null; column?: number | null; message_id?: string | null;
}
export interface KnowledgeSource {
  id: string; kind: 'document' | 'api_chat' | 'web_chat' | 'web_synthesis'; title: string;
  locator: Record<string, unknown>; enabled: boolean; revision: number; content_hash: string;
  context_complete: boolean; completed_at?: number | null; valid_until?: number | null;
  status: string; nature: string; metadata: Record<string, unknown>;
}
export interface Citation {
  source_id: string; source_kind: string; title: string; chunk_id: string; revision: number;
  locator: Record<string, unknown>; position: SourcePosition; quote: string;
}
export interface KnowledgeTraceStep { stage: string; status: string; duration_ms?: number; candidate_count?: number; reason?: string }
export interface KnowledgeQueryRequest {
  request_id: string; question: string; context: {role: string; content: string}[];
  system_constraints: string; source_ids: string[]; mode: 'api' | 'web';
  online_target: {kind: 'api'; provider_id: string; model: string} | {kind: 'web'; target_ids: string[]} | null;
  parameters: Record<string, unknown>; conversation_id?: string; user_message_id?: string;
  bypass_saved_reuse?: boolean;
}
export interface KnowledgeQueryResult {
  request_id: string; decision: 'hit' | 'miss' | 'cancelled'; reason: string;
  answer: string | null; citations: Citation[]; trace: KnowledgeTraceStep[];
  local_model: string; duration_ms: number; answer_origin: 'local_generated' | 'validated_cache' | 'saved_answer' | null;
  saved_entry?: { id: string; question: string; source_name: string; source_url: string; fact_status: 'correct' | 'unverified' | 'uncertain' | 'incorrect' };
  match_method?: string;
}
export interface KnowledgeMessage {
  request_id: string; origin: 'local_generated' | 'validated_cache' | 'saved_answer' | 'online'; reason?: string;
  citations: Citation[]; trace: KnowledgeTraceStep[]; local_model?: string; duration_ms?: number;
  saved_entry?: KnowledgeQueryResult['saved_entry'];
}
export interface Completion {
  status: 'complete' | 'stopped' | 'error' | 'partial' | 'unknown';
  kind: 'api' | 'web' | 'local' | 'workflow'; request_id: string; finished_at: number;
  effective_constraints?: string; parameters?: Record<string, unknown>; origin_hash?: string;
  context?: {role:string;content:string}[];
}
export interface CompletedTurn {
  conversation_id: string; user_message_id: string; assistant_message_id: string;
  question: string; answer: string; context: {role:string; content:string}[];
  system_constraints: string; provider_id?: string; model?: string; completion: Completion;
  source_kind?: KnowledgeSource['kind']; locator?: Record<string, unknown>;
  context_complete?: boolean; candidate_ids?: string[]; origin_hash?: string;
}
export interface JobSnapshot {
  id: string; kind: string; status: string; phase: string; completed: number; total: number;
  succeeded: number; skipped: number; failed: number; cancel_requested: boolean;
  stage?: string; current_item?: string; percent?: number; elapsed_seconds?: number; eta_seconds?: number | null;
  bytes_total?: number; bytes_completed?: number; chunks_total?: number; chunks_completed?: number;
  batches_total?: number; batches_completed?: number; started_at?: number | null; updated_at?: number | null;
  finished_at?: number | null; last_error?: string; notification_key?: string;
  items: {path?: string; source_id?: string; status: string; reason?: string; chunks?: number; revision?: number}[];
  result: Record<string, unknown> | null;
}

export interface ProviderSummary {
  id: string; name: string; api_type: string; configured: boolean;
  embedding_models: string[]; rerank_models: string[]; reason?: string | null;
}

export interface ProviderProbeResult {
  ok: boolean; role: 'embedding' | 'rerank'; model: string; count?: number;
  dimension?: number; top_score?: number; latency_ms?: number; error?: string;
}
