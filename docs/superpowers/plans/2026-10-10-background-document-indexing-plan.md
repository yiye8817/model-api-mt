# Background Document Indexing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Add durable background local-document indexing with progress reporting, completion notifications, and optional embedding/rerank calls through configured providers while preserving existing knowledge imports and FTS search.

**Architecture:** Keep SQLite as the source of truth. Add a small job manager around ThreadPoolExecutor(max_workers=2); the manager persists job state in KnowledgeStore, and a worker runs parsing, chunking, embedding, and transactional indexing. Add an isolated provider client for OpenAI-compatible embeddings and Cohere-style reranking, then expose job/capability APIs and a polling-based React task card.

**Tech Stack:** Python 3, Flask, SQLite/FTS5, requests, React 19, TypeScript, Tailwind, lucide-react, unittest/pytest.

**Spec:** docs/superpowers/specs/2026-10-10-background-document-indexing-design.md

## Global Constraints

- Preserve POST /api/knowledge/import and its existing response and validation behavior.
- Background creation returns HTTP 202 and a job ID; worker status is persisted in the knowledge SQLite database.
- Supported initial formats are records, massive, cmrc, text, and markdown; PDF/DOCX parsing is optional and must report a clear missing-dependency error.
- Use configured providers from providers.json; do not add a second API-key store.
- Embeddings use an OpenAI-compatible /embeddings endpoint; reranking uses a common /rerank request/response shape.
- Default chunk size is 800 characters and overlap is 120; accepted size range is 200–4000 and overlap must be less than size.
- A selected model failure fails the job; no selected model keeps local FTS usable.
- React polls job status every 700ms and uses the Notification API only when permission is available.

## Review Focus

- A malformed late record must leave no partial import; pin this in the worker transaction test.
- A provider timeout, non-JSON response, or invalid vector/rerank shape must produce a persisted failed job with a readable error; pin this in model-client and API tests.
- A service restart must mark queued/running jobs as failed with an interruption message; pin this in the store recovery test.
- A cancelled job must stop at a worker boundary without committing a partial batch; pin this in the cancellation test.
- Closing/reopening the panel or denying browser notification permission must not stop the job or make completion unobservable in the page; pin this in the React polling/notification test or build-level component assertions.

### Task 1: Document parsing and chunking primitives

**Files:**
- Create: knowledge/documents.py
- Modify: knowledge/datasets.py only if shared size/format validation is needed
- Test: tests/test_knowledge_documents.py

**Interfaces:**
- Produces ParsedDocument(text: str, filename: str, media_type: str).
- Produces parse_document(content: bytes, filename: str, fmt: str) -> ParsedDocument.
- Produces chunk_text(text: str, size: int = 800, overlap: int = 120) -> list[str].
- Raises DocumentError with user-facing messages for invalid size, empty input, unsupported format, or missing optional parser.

- [ ] Step 1: Write failing tests for UTF-8 text/Markdown, deterministic overlapping chunks, empty input, invalid overlap/size, and optional PDF/DOCX dependency errors.
- [ ] Step 2: Run pytest tests/test_knowledge_documents.py -q and verify the new imports/functions fail.
- [ ] Step 3: Implement knowledge/documents.py using bytes decoding for text/Markdown, existing JSON validation for structured formats through the worker boundary, and guarded pypdf/python-docx imports for optional formats.
- [ ] Step 4: Run the document tests and verify all pass.
- [ ] Step 5: Commit feat: add document parsing and chunking primitives.

### Task 2: Provider embedding/rerank clients and capability projection

**Files:**
- Create: knowledge/model_clients.py
- Modify: src/types.ts only if the UI needs typed provider capability metadata
- Test: tests/test_knowledge_model_clients.py

**Interfaces:**
- provider_capabilities(providers: list[dict]) -> list[dict] returns provider identity, API type, embedding models, rerank models, and a reason when unavailable.
- embed_texts(provider: dict, model: str, texts: list[str], timeout: int = 120) -> list[list[float]] calls /embeddings and accepts indexed OpenAI data objects.
- rerank_texts(provider: dict, model: str, query: str, documents: list[str], timeout: int = 120) -> list[float] calls /rerank and accepts results or data with index/score.
- Raises ModelClientError for Anthropic providers, HTTP failures, malformed JSON, missing vectors/scores, or mixed vector dimensions.

- [ ] Step 1: Write failing tests with a local HTTP stub for endpoint URL/header construction, OpenAI embedding response ordering, Cohere rerank ordering, Anthropic rejection, and malformed response errors.
- [ ] Step 2: Run pytest tests/test_knowledge_model_clients.py -q and verify failure.
- [ ] Step 3: Implement URL/header reuse compatible with server.py provider conventions without importing the Flask server; classify model options by explicit provider metadata when present, otherwise by model-name hints and expose an empty list with a reason when no capability can be inferred.
- [ ] Step 4: Run the model-client tests and verify pass.
- [ ] Step 5: Commit feat: add embedding and rerank provider clients.

### Task 3: Durable knowledge job schema and worker

**Files:**
- Create: knowledge/jobs.py
- Modify: knowledge/store.py for job/embedding tables and methods
- Modify: knowledge/__init__.py only if package exports are needed
- Test: tests/test_knowledge_jobs.py

**Interfaces:**
- KnowledgeStore.create_import_job(payload: dict, file_path: str | None) -> dict.
- KnowledgeStore.get_import_job(job_id: str) -> dict.
- KnowledgeStore.list_import_jobs(limit: int = 20) -> list[dict].
- KnowledgeStore.update_import_job(job_id: str, **patch) -> dict.
- KnowledgeStore.cancel_import_job(job_id: str) -> dict.
- KnowledgeStore.recover_import_jobs() -> int.
- ImportJobManager(store, get_providers, work_dir, max_workers=2) with submit(payload, content=None, filename=''), cancel(job_id), shutdown().
- Worker statuses are queued|running|completed|failed|cancelled; phases are reading|chunking|embedding|indexing|completed|failed.

- [ ] Step 1: Write failing tests for schema creation, queued state data, state transitions, persisted counters, restart recovery, cancellation, and atomic rejection of malformed late rows.
- [ ] Step 2: Run pytest tests/test_knowledge_jobs.py -q and verify failure.
- [ ] Step 3: Add import_jobs, import_job_files, and entry_embeddings tables in KnowledgeStore.__init__; add JSON serialization helpers and recovery that changes queued/running rows to failed with 服务重启，中断了后台任务.
- [ ] Step 4: Implement ImportJobManager with a bounded executor, per-job lock, temporary-file cleanup, phase/counter updates, cancellation checks, and one SQLite transaction per batch. Use convert for structured formats and parse_document/chunk_text for raw documents; call embed_texts only when configured.
- [ ] Step 5: Store each raw chunk as a normal manual/public QA entry with stable document:<digest>:chunk:<index> IDs, update FTS and optional vector rows, and save the selected rerank configuration in the job payload for later search.
- [ ] Step 6: Run the job tests and verify pass.
- [ ] Step 7: Commit feat: persist and run background knowledge import jobs.

### Task 4: Flask routes, provider wiring, and rerank search

**Files:**
- Modify: knowledge/api.py
- Modify: knowledge/store.py for optional vector recall/rerank result metadata
- Modify: server.py to pass providers and recover/start the manager
- Test: tests/test_knowledge_api.py

**Interfaces:**
- Extend register_knowledge_routes(app, get_store, get_conversations, get_providers=None) while keeping the old three-argument call valid.
- Add POST /api/knowledge/import/jobs (JSON or multipart, returns 202), GET /api/knowledge/import/jobs/<job_id>, GET /api/knowledge/import/jobs, and POST /api/knowledge/import/jobs/<job_id>/cancel.
- Add GET /api/knowledge/providers/capabilities.
- Extend search request with optional provider_id, embedding_model, and rerank_model; response adds retrieval: {mode, degraded, reason?}.
- Keep synchronous /api/knowledge/import behavior unchanged.

- [ ] Step 1: Write failing Flask tests for JSON and multipart job creation, status polling, capabilities filtering, cancel idempotency, missing job 404, failed job payload, and synchronous import regression.
- [ ] Step 2: Run pytest tests/test_knowledge_api.py -q and verify failure.
- [ ] Step 3: Add request parsing/validation and route handlers in knowledge/api.py; use an app-local manager registry so test apps can inject a temporary work directory and provider getter.
- [ ] Step 4: Wire the real provider list from load_state() in server.py, initialize the manager with DATA_DIR/knowledge-imports, call recovery during registration, and register shutdown cleanup.
- [ ] Step 5: Add vector candidate retrieval and optional rerank invocation while preserving existing result keys; return explicit FTS/vector mode and degradation reason.
- [ ] Step 6: Run API, existing knowledge, and routing tests: pytest tests/test_knowledge_api.py tests/test_knowledge.py tests/test_knowledge_routing.py -q.
- [ ] Step 7: Commit feat: expose background knowledge import APIs.

### Task 5: React import configuration, progress card, and notifications

**Files:**
- Modify: src/lib/knowledge.ts with job/capability types and multipart helper
- Modify: src/components/KnowledgePanel.tsx with configuration form, polling, cancel, progress, and notification handling
- Test: src/components/KnowledgePanel.test.tsx if a component test harness is present; otherwise validate with TypeScript/build and focused DOM assertions in an existing test file

**Interfaces:**
- KnowledgeImportJob, KnowledgeProviderCapabilities, and KnowledgeRetrieval types mirror the API fields.
- knowledgeMultipart<T>(path: string, form: FormData, signal?: AbortSignal) -> Promise<T>.
- Panel submits /import/jobs, polls the returned ID every 700ms, stops on terminal state, refreshes status, and shows page notice plus a browser notification when permitted.

- [ ] Step 1: Add type-level/DOM assertions for provider/model controls, processed/total progress text, cancel action, completion notice, and permission-denied fallback.
- [ ] Step 2: Run the focused frontend check and confirm it fails before implementation.
- [ ] Step 3: Implement capability loading, file/FormData submission (preserving text paste), task polling cleanup, progress rendering, cancel handling, and Notification.permission/requestPermission guarded completion notice.
- [ ] Step 4: Run npm run build and the focused assertions; verify pass.
- [ ] Step 5: Commit feat: show background indexing progress in knowledge panel.

### Task 6: Integrated verification and cleanup

**Files:**
- Modify: tests/test_knowledge_api.py or add tests/test_knowledge_integration.py for end-to-end job completion with a fake model client
- Modify: knowledge/jobs.py, knowledge/model_clients.py, or frontend only for failures found in verification

- [ ] Step 1: Run the full Python suite: pytest -q.
- [ ] Step 2: Run the frontend build: npm run build.
- [ ] Step 3: Exercise a temporary Flask app with a text file, fake embedding provider, rerank response, cancellation, and restart recovery; record the terminal job payloads.
- [ ] Step 4: Fix only failures exposed by these checks and rerun the affected checks.
- [ ] Step 5: Run git diff --check and review the final diff for credential leakage, unrelated changes, and API compatibility.
- [ ] Step 6: Commit test: verify background document indexing end to end.

