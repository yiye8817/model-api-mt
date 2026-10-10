# 本地知识导入与 Provider 能力 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完善 8766 工作区的本地文档后台索引、细粒度进度/完成通知，以及已配置在线 Provider 的 embedding/rerank 选择和接口测试。

**Architecture:** 扩展现有 SQLite 持久化 JobQueue 和 ImportManager，让进度在任务边界写入数据库并可恢复；增加一个服务端 Provider 能力客户端，统一用于 probe 和索引；React 的“本地知识”设置与资料管理页通过轮询任务快照展示阶段、错误和通知。Provider Key 只在后端解析，不进入浏览器或任务数据。

**Tech Stack:** Flask、Python 标准库、SQLite、现有本地知识模块、React/TypeScript、Vitest、unittest。

**Spec:** `docs/superpowers/specs/2026-10-10-local-knowledge-import-provider-design.md`

## Global Constraints

- 仅修改 8766 对应的 `local-semantic-qa` 工作区。
- 不引入 Celery、Redis、浏览器端模型调用或新的必需生产依赖。
- Provider Key 只由服务端读取，不能进入 React 状态、任务 payload、响应或日志。
- Provider 首版只支持 `/v1/embeddings` 和 `/v1/rerank` 的兼容响应；不兼容时明确失败。
- 自定义本地端点保持现有 loopback/LAN 安全校验和配置兼容。
- 任务状态、进度更新、取消和恢复必须幂等；失败批次不能标记为成功。
- embedding Provider、模型、版本或维度变化必须产生新的模型指纹并提示重新索引。

## Review Focus

- 上传中途浏览器刷新或关闭：任务仍在服务端运行，重新打开页面可恢复同一任务且完成通知只出现一次。覆盖 Task 5 的刷新恢复测试。
- embedding/rerank Provider 返回非 2xx、错误 JSON、重复索引、错维度或非有限分数：probe 和索引都显示可读错误且不写入成功索引。覆盖 Task 2/3 的 transport regression tests。
- 已删除 Provider 或模型不在其列表中：配置保存返回 400，不静默退回旧 Provider。覆盖 Task 3 的 config validation test。
- API Key 与远程错误正文包含敏感信息：API 响应、任务快照和日志均不泄露 Key。覆盖 Task 2/3 的 redaction test。
- 服务重启时任务处于 running/waiting_index：恢复后不会重复提交已经完成的来源修订，也不会无限停留。覆盖 Task 1 的 recovery test。

## File Map

- `local_knowledge/schema.sql`, `local_knowledge/store.py`: 任务进度字段、读取/更新和恢复查询。
- `local_knowledge/jobs.py`, `local_knowledge/ingest.py`: 任务事件、阶段计数、批次进度和最终状态。
- `local_knowledge/config.py`, `local_knowledge/model_clients.py`, new `local_knowledge/provider_clients.py`: Provider 引用校验、指纹和安全的远程 embedding/rerank 请求。
- `local_knowledge/api.py`, `server.py`: Provider 摘要、probe、配置验证和任务快照接口。
- `src/lib/knowledgeTypes.ts`, `src/lib/knowledgeApi.ts`, new `src/hooks/useKnowledgeJobs.ts` helpers: typed progress/provider/probe contracts and polling.
- `src/components/KnowledgeSettings.tsx`, `src/components/SettingsModal.tsx`: Provider/model selectors and independent tests.
- `src/components/KnowledgePanel.tsx`, `src/App.tsx`: import task timeline, recovery, toast/browser notification, and direct access.
- `tests/test_knowledge_jobs.py`, `tests/test_knowledge_provider.py`, `tests/test_knowledge_api.py`, `tests/test_content_library_deployment.py`: backend regression coverage.
- `src/components/KnowledgePanel.test.tsx`, `src/components/KnowledgeSettings.test.tsx`: UI interaction coverage.

### Task 1: Persisted job progress and restart recovery

**Files:**
- Modify: `local_knowledge/schema.sql`, `local_knowledge/store.py`, `local_knowledge/jobs.py`
- Test: `tests/test_knowledge_jobs.py`

**Interfaces:**
- Consumes: existing `Store.create_job`, `Store.update_job`, `ImportManager.recover`.
- Produces: `Store.update_job_progress(job_id, patch) -> JobSnapshot`, `Store.active_jobs() -> list[JobSnapshot]`, and snapshots containing `stage`, `current_item`, byte/chunk/batch counters, timestamps, `last_error`, and `notification_key`.

- [ ] **Step 1: Write failing tests** for persisted progress fields, monotonic counter updates, active-job listing, restart recovery of running jobs, and idempotent terminal updates.
- [ ] **Step 2: Run the focused tests** with `.venv/bin/python -m unittest tests.test_knowledge_jobs -v`; expect failures for missing progress fields/methods.
- [ ] **Step 3: Implement the schema migration and Store methods**. Keep existing job rows readable with defaults; update timestamps transactionally and never serialize payload secrets.
- [ ] **Step 4: Extend JobQueue recovery bookkeeping** so cancellation and restart move interrupted work to a resumable queued state without duplicating completed source revisions.
- [ ] **Step 5: Run focused tests and the existing job suite**; expect all progress/recovery assertions to pass.
- [ ] **Step 6: Commit** with `git add local_knowledge/schema.sql local_knowledge/store.py local_knowledge/jobs.py tests/test_knowledge_jobs.py && git commit -m "feat: persist local knowledge job progress"`.

### Task 2: Provider-backed embedding and rerank client

**Files:**
- Modify: `local_knowledge/config.py`, `local_knowledge/model_clients.py`
- Create: `local_knowledge/provider_clients.py`
- Test: `tests/test_knowledge_provider.py`

**Interfaces:**
- Consumes: endpoint config from Task 1 and provider records loaded by `server.py`.
- Produces: `ProviderCatalog.list() -> list[dict]`, `ProviderClientFactory.from_selection(role, selection) -> ProviderModelClient`, `ProviderModelClient.probe(role, budget) -> dict`, `embed(texts, budget) -> list[list[float]]`, and `rerank(question, candidates, budget) -> list[Candidate]`.

- [ ] **Step 1: Write failing tests** using a local HTTP fixture for OpenAI-compatible embedding/rerank success, API-key header use, malformed response, non-2xx response, dimension mismatch, duplicate index, and redaction of key in errors/serialized snapshots.
- [ ] **Step 2: Run `.venv/bin/python -m unittest tests.test_knowledge_provider -v`**; expect failures because provider selection and client factory do not exist.
- [ ] **Step 3: Implement provider selection validation** with endpoint fields `source`, `provider_id`, and `path`; preserve `source=custom` behavior and add model/provider to the model fingerprint.
- [ ] **Step 4: Implement the server-side client** with bounded HTTP, API-type-aware headers, `/v1/embeddings`, `/v1/rerank`, strict JSON/finite-number checks, and errors that exclude credentials and raw response bodies.
- [ ] **Step 5: Make the existing index path use the same factory** used by probe, so a successful test and actual indexing share URL, model, protocol, and credentials.
- [ ] **Step 6: Run focused provider tests and existing vector/model-client tests**; expect all success and rejection cases to pass.
- [ ] **Step 7: Commit** with `git add local_knowledge/config.py local_knowledge/model_clients.py local_knowledge/provider_clients.py tests/test_knowledge_provider.py && git commit -m "feat: support configured provider embedding and rerank"`.

### Task 3: Flask provider catalog, probe, config validation, and job API

**Files:**
- Modify: `local_knowledge/api.py`, `server.py`, `tests/test_knowledge_api.py`
- Test: `tests/test_content_library_deployment.py`

**Interfaces:**
- Consumes: Task 1 progress snapshots and Task 2 `ProviderCatalog`/`ProviderClientFactory`.
- Produces: `GET /api/knowledge/providers`, `POST /api/knowledge/probe`, `GET /api/knowledge/jobs/<id>` with full progress and `notification_key`, and validated `/api/knowledge/config/validate` / `/api/settings` behavior for provider references.

- [ ] **Step 1: Write failing Flask tests** for provider summary redaction, successful embedding/rerank probe, malformed provider selection, deleted provider/model rejection, full job progress response, and idempotent cancel.
- [ ] **Step 2: Run the focused API tests** with `.venv/bin/python -m unittest tests.test_knowledge_api tests.test_content_library_deployment -v`; expect 404/validation failures.
- [ ] **Step 3: Register provider catalog and probe routes**. Accept only `embedding` or `rerank`, return dimensions/count/top score, and never return key/base credential fields beyond an explicitly safe URL display.
- [ ] **Step 4: Integrate provider-aware config validation and runtime construction**. A missing provider or model returns 400; custom endpoints continue using existing validation.
- [ ] **Step 5: Return active/recent jobs for UI recovery** while retaining old job fields and JSON error handlers.
- [ ] **Step 6: Run API, provider, and existing local-knowledge tests**; expect all routes and security assertions to pass.
- [ ] **Step 7: Commit** with `git add local_knowledge/api.py server.py tests/test_knowledge_api.py tests/test_content_library_deployment.py && git commit -m "feat: expose local knowledge provider probes"`.

### Task 4: Detailed indexing progress in the ingestion pipeline

**Files:**
- Modify: `local_knowledge/ingest.py`, `local_knowledge/store.py`
- Test: `tests/test_knowledge_jobs.py`

**Interfaces:**
- Consumes: Task 1 `update_job_progress` and Task 2 provider client methods.
- Produces: imports and refreshes that update scanning/parsing/chunking/embedding/committing counters and item records without changing existing import request shapes.

- [ ] **Step 1: Add failing pipeline tests** that import a multi-file fixture, assert stage order and counters, verify current item/error details, and ensure a failed embedding batch does not create an indexed revision.
- [ ] **Step 2: Run the tests** and observe missing progress events or incorrect terminal states.
- [ ] **Step 3: Instrument scan/read/parse/chunk/embed/commit boundaries** with persisted progress patches, byte accounting, batch accounting, and bounded item errors; use `Budget` cancellation checks between batches.
- [ ] **Step 4: Verify recovery and cancellation** against the Task 1 store contract; keep already committed source revisions idempotent.
- [ ] **Step 5: Run the complete Python suite** and confirm all existing import/recovery behavior remains green.
- [ ] **Step 6: Commit** with `git add local_knowledge/ingest.py local_knowledge/store.py tests/test_knowledge_jobs.py && git commit -m "feat: report detailed indexing progress"`.

### Task 5: Settings Provider selectors and capability tests

**Files:**
- Modify: `src/lib/knowledgeTypes.ts`, `src/lib/knowledgeApi.ts`, `src/components/KnowledgeSettings.tsx`, `src/components/SettingsModal.tsx`
- Test: `src/components/KnowledgeSettings.test.tsx`

**Interfaces:**
- Consumes: Task 3 `GET /api/knowledge/providers` and `POST /api/knowledge/probe` contracts.
- Produces: a settings UI that emits valid `source/provider_id/model/path` endpoint configuration and independent probe results without exposing keys.

- [ ] **Step 1: Write failing Vitest tests** for loading provider choices, switching models, embedding/rerank probe success/failure isolation, and custom endpoint compatibility.
- [ ] **Step 2: Run `npm run test:knowledge -- src/components/KnowledgeSettings.test.tsx`**; expect failures for missing controls and routes.
- [ ] **Step 3: Add typed ProviderSummary/ProbeResult/JobProgress contracts and API helpers** in `knowledgeTypes.ts`/`knowledgeApi.ts`.
- [ ] **Step 4: Implement provider/custom source selectors** in `KnowledgeSettings`, with per-role model lists, test buttons, inline status, and save-time validation messaging.
- [ ] **Step 5: Keep the existing local QA configuration and import JSON behavior intact**, including disabled/save states while a configuration file is being read.
- [ ] **Step 6: Run focused Vitest tests and TypeScript checking**; expect all UI interactions to pass.
- [ ] **Step 7: Commit** with `git add src/lib/knowledgeTypes.ts src/lib/knowledgeApi.ts src/components/KnowledgeSettings.tsx src/components/SettingsModal.tsx src/components/KnowledgeSettings.test.tsx && git commit -m "feat: select provider models for local knowledge"`.

### Task 6: Import progress timeline, recovery, and completion notifications

**Files:**
- Modify: `src/hooks/useKnowledgeJobs.ts`, `src/components/KnowledgePanel.tsx`, `src/App.tsx`
- Test: `src/components/KnowledgePanel.test.tsx`

**Interfaces:**
- Consumes: Task 3 job/provider API and Task 4 detailed progress snapshots.
- Produces: a document import UI that can close/reopen, display active/recent jobs, cancel jobs, and notify exactly once for done/failed/cancelled states.

- [ ] **Step 1: Write failing Vitest tests** for stage timeline/counters, active-job recovery after remount, terminal notification deduplication, cancel action, and browser-notification fallback when permission is denied.
- [ ] **Step 2: Run the focused panel tests** and observe missing progress/notification behavior.
- [ ] **Step 3: Extend `useKnowledgeJobs`** to poll active/recent jobs, retain the terminal snapshot, and expose a stable notification key plus refresh/cancel actions.
- [ ] **Step 4: Implement the detailed timeline** with percent/ETA calculation, current item, bytes/chunks/batches, expandable item errors, and a recent-job selector.
- [ ] **Step 5: Implement in-app toast plus guarded `Notification` API usage**. Store notification keys in component/session state so polling and remount do not duplicate notifications; refresh sources on completion.
- [ ] **Step 6: Add direct “本地知识/导入文档” access from the 8766 workbench** while preserving the existing Settings tab and citation viewer lifecycle.
- [ ] **Step 7: Run focused Vitest tests, full frontend tests, TypeScript check, and build**; expect all import and notification flows to pass.
- [ ] **Step 8: Commit** with `git add src/hooks/useKnowledgeJobs.ts src/components/KnowledgePanel.tsx src/App.tsx src/components/KnowledgePanel.test.tsx && git commit -m "feat: show local knowledge indexing progress"`.

### Task 7: Integrated verification and 8766 service acceptance

**Files:**
- Modify: documentation or usage notes only if the verified UI path differs from the spec.
- Test: existing Python/Vitest suites and a temporary HTTP fixture/provider.

**Interfaces:**
- Consumes: all previous task endpoints and UI contracts.
- Produces: evidence that the actual 8766 build supports document import, background progress, completion notification, and provider capability probes.

- [ ] **Step 1: Run the full backend suite**: `.venv/bin/python -m unittest discover -s tests -v`.
- [ ] **Step 2: Run the full frontend suite**: `npm run test:knowledge`.
- [ ] **Step 3: Run static/build checks**: `npx tsc --noEmit`, `npm run build`, `git diff --check`.
- [ ] **Step 4: Start 8766 with an isolated temporary data directory**, import a small UTF-8/Markdown fixture, poll its job until terminal, and verify status/source counts and one completion notification event.
- [ ] **Step 5: Start a local HTTP fixture implementing `/v1/embeddings` and `/v1/rerank`, configure it through the Provider path, run both probes, and verify successful dimension/score output without key leakage.
- [ ] **Step 6: Review the final diff against the spec and record any deferred minor findings before restarting the 8766 service with the verified build.
- [ ] **Step 7: Commit only implementation files and tests; leave generated `data/`, `dist/`, logs, and fixture artifacts ignored.

