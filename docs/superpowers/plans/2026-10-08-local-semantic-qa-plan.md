# 本地语义检索与精准问答 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让当前工作台先按语义检索本地资料，只有证据和问题条件均通过校验时回答；未命中时沿原有 API 或网页路径兜底。

**Architecture:** 新建 `local_knowledge/` 包，以 SQLite 管理来源、修订、任务和答案依赖，Chroma 保存显式生成的本地向量。本地问答入口只返回 hit、miss 或 cancelled；React 在任何在线意图分析之前调用它，Electron 负责有角色的网页会话采集及取消。所有来源共用索引和证据校验，实际模型评测决定配置能否自动回答。

**Tech Stack:** 现有 Flask、requests、React 19、TypeScript、Electron；新增 Chroma、pypdf、python-docx；SQLite/FTS5 使用标准库；本地 embedding、rerank、QA 使用分别配置的 llama.cpp 兼容端点；pytest、Vitest、Testing Library 和现有 Electron 页面测试负责验证。

**Spec:** [本地语义检索与精准问答设计](../specs/2026-10-08-local-semantic-qa-design.md)。本计划承接 2026-10-08 的书面设计；本次交付为方案文档，任务勾选不表示代码已经实现。

## Global Constraints

- 本地命中时，在线意图分析、在线问答、网页发送和在线综合模型的请求数均为零。
- 用户点击停止属于取消，不属于本地未命中；取消后不得自动发送在线请求。
- 升级已有安装时默认为关闭；用户开启后开始本地检查和未来问答收集。
- 三种角色分别配置端点，不假定一个模型兼任三种任务。
- 桌面单实例使用 `PersistentClient`；显式提交本地生成的向量，禁用默认模型下载。
- 数据库是资料状态的权威来源。
- 向量召回最多 20 个片段；关键词检索最多 20 个片段；去重后最多送 20 个候选给重排端点；取最多 5 个有足够相关性的片段。
- 默认目标 800 字符、重叠 120 字符，上限 1,600 字符。
- 每个文件的默认最大大小为 20 MiB，一次任务最多 2,000 个文件。
- 本轮本地检查总预算 30 秒，各调用使用剩余预算。
- `time_sensitive_ttl_seconds`：默认 3,600 秒；本地仍无法确认时效要求时 miss。
- 尚未校准的配置允许预览检索结果，但自动回答返回 `uncalibrated` 并在线兜底。
- 验证集所有已经返回的本地答案正确且引用支持有效，所有关键条件差异及证据缺失样例无错误本地命中。
- 对验证集可回答样例，本地正确命中率至少 60%。
- 精度评测的最低覆盖为 60 条已标注样例；正向可回答样例至少 30 条；用于校准与最终验证的数据分开。
- 独立 MultiLLM Fusion 服务、Desktop Agent、Claude/Hermes CLI、代码执行及图像生成等有独立协议或副作用的流程，不在本次普通问答路由的实现范围内。
- 各网站原始输入框直接发送仍属于直接在线操作；首版不接管各网站的原生发送按钮，也不拦截应用外 Chrome 的对话。
- 删除资料源只删除索引、导入副本和依赖缓存，不删除用户原始文档。
- 日志不记录密钥，不把大块文档和隐藏模型推理默认写入诊断事件。

## Review Focus

1. 取消后本地迟到结果、网页事件和旧请求清理到达：不得在线兜底，不得覆盖随后新请求的消息与加载状态。任务 5、8、9 验证。
2. 相同问题文字对应不同对象、系统约束或来源范围：请求指纹必须不同，缓存仍需验证当前条件。任务 1、5、9 验证。
3. 检索之后来源被禁用、删除或原文件被替换：返回前重新检查，旧答案和依赖缓存不能命中。任务 3、4、5、7 验证。
4. 上传相对路径越界、选定目录内符号链接逃逸或 PDF 展开超限：逐项拒绝并保留原因，不影响其他有效文档。任务 3、7、10 验证。
5. 模型返回 NaN、错误候选索引、截断 JSON，或相同模型名换了权重：明确失败或要求重新评测，不能沿用旧阈值。任务 2、5、6 验证。

---

## 1. 代码核对结论与实施顺序

本计划依据当前工作区代码，而不是假定已有统一问答服务：

| 已核对位置 | 必须处理的现状 |
|---|---|
| `src/App.tsx:637` | `handleSendMessage` 先要求 provider，之后立即调用 `/api/auto-route`；本地检查必须提前，AbortController 也必须提前建立。 |
| `src/App.tsx:556`、`src/components/ChatArea.tsx:619` | 新建会话和输入框也依赖 provider；只放开发送函数仍不能使用纯本地问答。 |
| `src/App.tsx:1690` | `handleStop` 只 abort 前端 HTTP；需协作取消本地请求和已发起的网页问答。 |
| `electron/main.cjs:1250` | `desktop:web-chat` 未向 `runWebChat` 传入取消信号；后者已经接受 `options.signal`。 |
| `src/hooks/useBackendState.ts:64` | 保存完整状态时有 300ms 防抖；来源去重、修订与删除不能依赖前端回调次数。 |
| `server.py:3038`、`server.py:3194` | 状态整体保存与单会话增删改都有写入路径，全部需要同步资料失效。 |
| `server.py:2885`、`server.py:2978` | 设置采用递归合并；重置分组是固定列表，新增分组时需一并扩展。 |
| `server.py:225` | 单次上传上限为 50 MiB；目录上传需要分批，不能用“最多 2,000 文件”推导允许一次上传 40 GiB。 |
| `.gitignore` | `docs/` 已被忽略。文档保留在既有目录；以后提交方案时仅按需强制添加明确的文件，不解除整个目录的忽略规则。 |

按任务 1–10 顺序实施。1–6 构成本地后端；7 接入已有对话；8 完成网页边界；9 接通用户提问；10 完成管理、定位和端到端验收。每个任务都有独立可运行的验证，后续任务不能绕过前序接口。

执行环境沿用父项目 `run.sh` 的 `.venv`（设置了 `VENV_DIR` 时使用对应目录）。以下 `python` 命令均在 `source .venv/bin/activate` 后运行；未激活时使用该环境的 `bin/python`，不能假定系统存在 `python` 命令。任务 1 先写测试依赖文件并安装 pytest；任务 3 写解析实现前安装 `python -m pip install -r requirements-knowledge.txt`；不在方案编写阶段安装依赖或启动模型。

## 2. 文件责任与共享契约

| 创建/修改 | 文件及责任 |
|---|---|
| 创建 | `local_knowledge/contracts.py`：请求、来源、片段、结果和稳定枚举；`config.py`：默认值、参数验证、角色配置指纹。 |
| 创建 | `local_knowledge/schema.sql`、`store.py`：事务、修订、FTS、缓存依赖、请求与评测记录。 |
| 创建 | `local_knowledge/model_clients.py`：三类本地端点、预算、协作取消、能力探测。 |
| 创建 | `local_knowledge/parsers.py`、`text.py`、`ingest.py`：解析、位置、分块、目录边界与上传暂存；`jobs.py`：单队列、逐项结果与恢复。 |
| 创建 | `local_knowledge/vectors.py`、`retrieval.py`：Chroma 适配、混合召回、重排与相邻证据预算。 |
| 创建 | `local_knowledge/matching.py`、`service.py`：问题约束、生成校验、缓存复核、统一决策与取消。 |
| 创建 | `local_knowledge/evaluation.py`、`chat_sync.py`、`api.py`、`__init__.py`：真实模型评测、聊天资料同步、Flask 蓝图及延迟初始化。 |
| 修改 | `server.py`：设置分组、蓝图注册、保存后的同步入口、普通问答完成与实际在线调用计数；不承载检索算法。 |
| 创建 | `requirements-knowledge.txt`、`requirements-dev.txt`：可选资料依赖与 Python 测试依赖。 |
| 创建 | `src/lib/knowledgeTypes.ts`、`knowledgeApi.ts`、`knowledgeRouting.ts`：类型、HTTP 客户端、发送前检查与取消；`src/hooks/useKnowledgeJobs.ts`：任务轮询。 |
| 创建 | `src/components/KnowledgeSettings.tsx`、`KnowledgePanel.tsx`、`KnowledgeCitations.tsx`、`KnowledgeSourceViewer.tsx`：连接、资料管理、引用、按真实位置查看证据。 |
| 修改 | `src/types.ts`、`src/App.tsx`、`src/components/ChatArea.tsx`、`SettingsModal.tsx`、`DirPicker.tsx`、`WebViewer.tsx`、`src/lib/desktopBridge.ts`：设置、消息字段、统一路由、导入入口和定位回调。 |
| 创建/修改 | `electron/web-conversation.cjs`：可见角色消息采集；修改 `electron/main.cjs`、`preload.cjs`、`web-chat.cjs` 及既有页面测试。 |
| 创建 | `tests/knowledge/` 的分项 Python 测试、`tests/fixtures/local_knowledge/` 样本，前端同目录 `.test.ts(x)`、`src/test/setup.ts`、`vitest.config.ts`。 |

共享数据结构在任务 1 定义，后续任务不得各自发明字段：

- `SourceKind = Literal['document', 'api_chat', 'web_chat', 'web_synthesis']`；`Source` 含 `id/kind/title/locator/enabled/revision/content_hash/context_complete/completed_at/valid_until/status/nature`。`nature` 为 `document` 或 `historical_model_answer`，不会因点赞或入库改变。
- `SourceLocator` 为判别联合：`file` 含路径、所选根和 `file_stat(size/mtime_ns/dev/inode)`；`upload` 含导入副本 ID、相对路径；`chat` 含会话和消息 ID；`web` 含原 URL、站点及可读取的会话 ID。一个来源可关联多个可追溯定位。
- `Position` 使用 `kind='lines'|'pdf_page'|'docx'|'message'`；分别含 1 起始的行区间、页码、段落/表格单元位置或消息 ID；附 `start_char/end_char` 定位原文，范围采用左闭右开。
- `Chunk` 含 `id/source_id/revision/text/keyword_text/position/ordinal/continuation_group/status`；`Candidate` 添加 `raw_score/score_transform/rank`，不叫准确率。
- `QueryRequest` 含规格中的所有字段，并添加 `conversation_id/user_message_id/parameters` 以构建完整指纹。`source_ids=[]` 表示本次未进一步限定，按用户启用范围解析；显式 ID 列表过滤后为空表示空范围，不能回退到全库。
- `online_target` 是 `{'kind':'api','provider_id':str,'model':str}`、`{'kind':'web','target_ids':list[str]}` 或 `null`；不能含 URL 凭据和 API 密钥。
- `QueryResult` 为三种判别结果；只有 `decision='hit'` 有非空 `answer/citations`，miss 和 cancelled 的 `answer=null/citations=[]`。共同字段为 `request_id/reason/trace/local_model/duration_ms/answer_origin`；`answer_origin` 为 `local_generated` 或 `validated_cache`。
- `Citation` 含 `source_id/source_kind/title/chunk_id/revision/locator/position/quote`。`TraceStep` 含 `stage/status/duration_ms/candidate_count` 和稳定原因，不含隐藏推理或全文。
- `Completion` 含 `status='complete'|'stopped'|'error'|'partial'|'unknown'`、`kind='api'|'web'|'local'|'workflow'`、`request_id/finished_at/effective_constraints/parameters/origin_hash`。origin_hash 覆盖实际发送的问题、必要上下文、回答与生效约束，不能在消息编辑后自动改成新问题的哈希；不包含密钥。新增 `ChatMessage.completion` 与独立 `ChatMessage.knowledge`；旧消息无 completion 时按 unknown 处理。
- `CompletedTurn` 含稳定会话/消息 ID、原问题、回答、有效系统约束、必要上下文、provider ID、实际模型、完成状态及关联候选 ID。源 ID 从类型和稳定消息 ID 派生；哈希变化推进 revision，不改变源 ID。
- `JobSnapshot` 含 `id/kind/status/phase/completed/total/succeeded/skipped/failed/cancel_requested/items/result`，`items` 为有路径/消息 ID 和稳定原因的逐项结果；评测报告存入 `result`。

辅助类型也统一在 `contracts.py` 定义，不留给各任务自行命名：`ParseLimits(max_file_bytes,max_text_chars,max_pdf_page_bytes,timeout_seconds,max_memory_bytes)`；`TextUnit(text,position,kind,continuation_group)`；`ParsedDocument(units,nature,warnings)`；`ScanResult(files,skipped,failed)`；`UploadItem(relative_path,stream,size,encoding)`；`PreparedQuestion(original,retrieval_question,kind,constraints,context_basis)`；`MatchResult(answerable,reason,matched_constraints,unresolved_constraints,conflicts)`；`ValidatedAnswer(answer,claims,citations)`；`EvaluationDataset(calibration,validation)`；`EvaluationReport(answerable,correct_hits,wrong_hits,items,model_fingerprint,dataset_hash,real_models,reviewed)`，其 `meets_release_gate() -> bool` 使用规格门槛。Python 内部是 dataclass/TypedDict，序列化后为以下 JSON 结构。

前端 `knowledgeTypes.ts` 导出这些 JSON 类型；统一以 `KnowledgeQueryRequest/KnowledgeQueryResult` 对应 Python `QueryRequest/QueryResult`，`SourcePosition` 对应 Python `Position`，其他同名。`LocalKnowledgeSettings` 对应 config 分组，`LocalRouteResult` 定义在 `knowledgeRouting.ts`；不能在不同组件重复定义不兼容的接口。

以下是实现时必须保持的网络契约；请求/响应的业务字段使用 snake_case，转换到已有 camelCase ChatMessage 字段由前端入口完成：

| 操作 | 请求 | 响应 |
|---|---|---|
| status / probe | status 无参数；probe `{roles:['embedding','rerank','qa']}` | `{enabled,roles,index,calibration,counts}`；每个角色 `{available,model,fingerprint,error}`。 |
| sources / enable / delete | GET 可传 `q`；PATCH `{enabled:boolean}`；DELETE 无 body | GET `{sources:Source[]}`；PATCH `{source:Source}`；DELETE `{ok:true}`。 |
| import | `{kind:'paths',roots:string[],explicit_files?:string[],encoding?:string}`；或 `{kind:'api_chats',conversation_ids:string[]}`；或 `{kind:'upload',purpose:'knowledge'|'evaluation'}` | 202 `{job_id:string}`；paths 必须有显式 roots，不能接受空根隐式扫描。 |
| upload | multipart 的 `job_id/batch_id/relative_paths`（与 `files` 一一对应的 JSON 数组）/`final`/`files` | 202 `{job_id,job:JobSnapshot}`；相同 batch_id 相同哈希重试幂等，不同哈希返回 409。 |
| web-import | `{snapshot:WebConversationSnapshot,workbench_conversation_id?:string}` | 202 `{job_id}`；受限快照可以索引参考正文，不能标成完整可复用问答。 |
| refresh / jobs / job cancel | refresh 空 body；job GET 无 body；cancel 空 body | refresh 202 `{job_id}`；job GET `{job:JobSnapshot}`；cancel `{ok,cancel_requested}`。 |
| query / query cancel / request progress | query 使用 `QueryRequest`；cancel 空 body；progress 无 body | `QueryResult`；`{ok,cancelled}`；`{request_id,stage,trace,decision,online_model_requests,duration_ms}`。 |
| evaluate | `{operation:'run',calibration_source_id,validation_source_id}`；或 `{operation:'activate',report_id,reviewed:true}` | run 202 `{job_id}`；activate 200 `{evaluation_profile_id}`，不合格/不兼容报告返回 409。 |
| record | `{turn:CompletedTurn,online_calls?:[{call_id,kind,model}]}` | `{source_id,revision,status:'pending'|'unchanged'|'indexed'|'reference_only'}`；与聊天同步使用同一源 ID。 |
| source content | `revision` 必填，按源 ID 读取 | `{source_id,revision,text,units:[{text,position}]}`，缺失 404、失效 409。 |

评测数据文件以 `purpose='evaluation'` 上传得到 source ID，JobSnapshot 的逐项结果带 source_id；evaluate 只访问已导入副本。该用途单独接受 `.jsonl`，状态为 `evaluation_dataset`，不走普通文档索引；评测 JSONL 由专用解析器读取，不将标准答案作为普通知识资料参与召回。任务 6 定义该专用解析及指标，任务 7 注册操作，任务 10 提供运行/人工复核后的激活入口。

补充两个只读定位/进度接口，已同步到设计文档：`GET /api/knowledge/requests/<request_id>` 读取真实阶段，`GET /api/knowledge/sources/<id>/content?revision=N` 返回已导入的原文与位置。后者不接受任意路径；旧修订已失效则返回 409。

## 3. 任务清单

### Task 1: 可关闭的配置、存储与修订契约

**Files:**
- Create: `local_knowledge/__init__.py`, `local_knowledge/contracts.py`, `local_knowledge/config.py`, `local_knowledge/schema.sql`, `local_knowledge/store.py`, `requirements-knowledge.txt`, `requirements-dev.txt`, `tests/knowledge/test_store.py`, `tests/knowledge/test_config.py`。
- Modify: `server.py` 的 `DEFAULT_SETTINGS`、`api_settings_set`、`api_settings_reset`；`src/types.ts` 的 `AppSettings/ChatMessage`；Create: `src/lib/knowledgeTypes.ts`。

**Interfaces:**
- Consumes: `_load_settings() -> dict`、`_save_settings(patch) -> dict` 与共享契约。
- Produces: `default_config() -> dict`、`validate_config(value: dict) -> dict`；`Store(data_dir: Path)`；`upsert_pending(source: Source, chunks: Sequence[Chunk]) -> int`、`activate_revision(source_id: str, revision: int) -> bool`、`invalidate_source(source_id: str) -> None`、`dependencies_current(deps: Mapping[str,int]) -> bool`、`request_fingerprint(request: QueryRequest, effective_scope: Sequence[str]) -> str`。

- [ ] **Step 1: 写配置与 SQLite 失败测试，并创建 `requirements-dev.txt` 安装 `pytest>=8,<10` 作为测试准备。**

```python
def test_defaults_off_and_exact_budgets():
    c = default_config()
    assert c['enabled'] is False
    assert (c['vector_top_k'], c['rerank_top_k']) == (20, 5)
    assert (c['local_timeout_seconds'], c['time_sensitive_ttl_seconds']) == (30, 3600)
```

另写 `test_pending_revision_not_answerable`（pending 不能查询）、`test_repeated_hash_keeps_revision`（相同源与哈希 revision 不变）、`test_changed_context_changes_fingerprint`（对象、系统约束、范围、模式、模型和参数分别变化都改变指纹；密钥不能进入输入结构）、`test_reset_knowledge_preserves_other_settings`、`test_missing_fts5_disables_knowledge_only`。

- [ ] **Step 2: 运行失败测试。** `python -m pytest tests/knowledge/test_store.py tests/knowledge/test_config.py -q`；预期新增模块/接口缺失导致 FAIL。在当前项目 Python 环境安装 `requirements-dev.txt` 中的 pytest 后运行，不修改独立 Agent 的测试环境。
- [ ] **Step 3: 实现契约、默认配置与存储。** 七张规格实体表、单调修订、FTS5 和缓存依赖表使用迁移版本管理；每线程独立连接，启用外键、WAL、5,000ms busy timeout，事务不含模型调用。来源失效首先撤销可见状态及依赖缓存。角色配置包括 `url/protocol/model/model_revision/allow_lan`；rerank 另有 `score_transform`，QA 另有 `context_tokens=4096/max_output_tokens=1024`，探测到更小 context 时按较小值使用。空端点不自动补云地址；收集默认 true，总开关 false；fallback 默认 true。可选依赖初始约束为 `chromadb>=1,<2`、`pypdf>=6,<7`、`python-docx>=1.2,<2`，测试依赖 `pytest>=8,<10`，执行时记录实际解析版本；Flask 导入不能因这些依赖缺失失败。
- [ ] **Step 4: 运行同一测试命令和 `npx tsc --noEmit`。** 预期 Python PASS；新类型不引入类型错误。既有设置和未带新字段的存量状态仍能读取。
- [ ] **Step 5: 提交该任务明确的文件。** 建议提交信息 `feat: add local knowledge contracts and revision store`。

### Task 2: 三类本地模型客户端与共享截止时间

**Files:** Create: `local_knowledge/model_clients.py`, `tests/knowledge/test_model_clients.py`, `tests/knowledge/model_server.py`。

**Interfaces:**
- Consumes: 任务 1 配置、`Candidate` 与契约。
- Produces: `Budget(seconds: float, cancel_event: threading.Event)`，`remaining() -> float`、`check() -> None`；`ModelClients(config: dict)`，`probe(budget: Budget) -> dict`、`embed(texts: Sequence[str], budget: Budget) -> list[list[float]]`、`rerank(question: str, candidates: Sequence[Candidate], budget: Budget) -> list[Candidate]`、`json_chat(messages: Sequence[dict], schema: dict, budget: Budget) -> dict`、`count_tokens(text: str, budget: Budget) -> int`；`ModelUnavailable/LocalTimeout/Cancelled` 异常。

- [ ] **Step 1: 写回环 HTTP 替身测试。** `tests/knowledge/model_server.py` 提供 `ModelServer(responses: dict)` 上下文管理器、`calls` 和延迟/断流控制；测试只访问回环。

```python
def test_embedding_rejects_nonfinite(model_server):
    model_server.embeddings = [[0.1, float('nan')]]
    with pytest.raises(ModelUnavailable):
        ModelClients(model_server.config).embed(['问题'], Budget(30, Event()))
```

补写 `test_embedding_dimension_and_order`、`test_rerank_rejects_duplicate_or_out_of_range_index`、`test_json_chat_rejects_truncated_and_empty_output`、`test_redirect_to_public_host_not_followed`、`test_lan_requires_explicit_allowance`、`test_budget_not_restarted_between_calls`（29 秒已耗尽只余 1 秒）、`test_cancel_closes_inflight_transport`、`test_model_revision_changes_fingerprint`。含 `localhost.example.com`、IPv6 回环、私网 IP 与公网解析的 hostname 边界。

- [ ] **Step 2: 运行 `python -m pytest tests/knowledge/test_model_clients.py -q`。** 预期新客户端缺失而 FAIL。
- [ ] **Step 3: 实现上述方法。** 首版协议固定 `openai_embeddings`、`llama_rerank`、`llama_chat`，分别使用 `/v1/embeddings`、`/v1/rerank`、`/v1/chat/completions`。重排适配器接受已探测的 `results[{index,relevance_score}]` 或 `data[{index,score}]`，混合/未知形态拒绝；保留原始分数，变换为 `identity` 或 `sigmoid`，阈值跟随评测配置。使用独立于 `/api/chat` 的传输，不经过在线代理、默认重试、环境 HTTP 代理或跨地址重定向。为阻塞网络调用设置剩余预算，并由可终止调用工作进程承载，截止或取消时关闭连接并回收进程；不能只把线程 Future 标记取消。`/tokenize` 能力缺失时用 UTF-8 字节数作保守 token 上界，超过 context 预算减少完整证据单元。权重身份使用显式 `model_revision`，探测 ID、向量维度、协议/评分变换组成指纹；未声明可信权重修订不能激活自动回答评测配置。
- [ ] **Step 4: 运行同一测试命令。** 预期 PASS，日志中没有全文、密钥或模型隐藏推理。
- [ ] **Step 5: 提交客户端及测试。** 建议提交信息 `feat: add bounded local embedding rerank and qa clients`。

接口和启动参数以 [llama.cpp server 官方文档](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md) 为依据；运行时仍以探测为准，不假定所有兼容服务支持相同返回结构。

### Task 3: 有边界、有定位的资料解析和任务执行

**Files:** Create: `local_knowledge/parsers.py`, `local_knowledge/text.py`, `local_knowledge/ingest.py`, `local_knowledge/jobs.py`, `tests/knowledge/test_ingest.py`, `tests/knowledge/test_jobs.py`, `tests/fixtures/local_knowledge/documents/`。

**Interfaces:**
- Consumes: `Store`、`Source/Chunk/Position/JobSnapshot`。
- Produces: `parse_file(path: Path, limits: ParseLimits) -> ParsedDocument`（`units: list[TextUnit]`、解析性质和错误）；`chunk_document(document: ParsedDocument, target: int=800, overlap: int=120, maximum: int=1600) -> list[Chunk]`；`scan_root(root: Path, explicit_files: Sequence[Path]=()) -> ScanResult`；`ImportManager(store: Store, index_revision: Callable[[str,int,Budget],None] | None=None)`，`enqueue(payload: dict) -> str`、`append_upload(job_id: str, files: Sequence[UploadItem], final: bool) -> JobSnapshot`、`cancel(job_id: str) -> bool`、`snapshot(job_id: str) -> JobSnapshot`、`recover() -> None`；`check_file_freshness(source: Source) -> bool`。

- [ ] **Step 1: 写解析/队列失败测试和最小样本。**

```python
def test_chunk_limits_and_original_positions(markdown_document):
    chunks = chunk_document(markdown_document)
    assert all(len(c.text) <= 1600 for c in chunks)
    assert all(c.position.start_line >= 1 for c in chunks)
    assert all(markdown_document.contains_at(c.text, c.position) for c in chunks)
```

补写 `test_pdf_page_and_docx_table_positions`、`test_long_code_has_continuation_group`、`test_twenty_mib_and_two_thousand_files_boundaries`（20 MiB 允许，+1 字节拒绝；第 2,001 个列出限制）、`test_symlink_and_upload_traversal_rejected`（绝对路径、`../`、反斜线越界和外部符号链接）、`test_sensitive_names_and_binary_skipped`、`test_scanned_encrypted_corrupt_pdf_reported`、`test_parser_timeout_kills_worker`、`test_cancel_keeps_revision_unpublished`、`test_partial_success_and_restart_recovery`、`test_file_changed_with_same_size_and_mtime`（引用前补充文件标识/哈希核验）。

- [ ] **Step 2: 运行 `python -m pytest tests/knowledge/test_ingest.py tests/knowledge/test_jobs.py -q`。** 预期新增入口缺失而 FAIL。
- [ ] **Step 3: 实现解析、扫描、单工作队列和上传暂存。** 文本原文不做破坏性规范化，编码仅自动接受 UTF-8/UTF-8 BOM/有 BOM 的 UTF-16，其他编码逐项报告并允许显式 encoding 重试。首版文本后缀固定 `.txt/.md/.markdown/.py/.js/.jsx/.ts/.tsx/.c/.h/.cpp/.hpp/.java/.go/.rs/.sh/.html/.css/.sql/.json/.csv/.yaml/.yml/.toml`，另加 `.pdf/.docx`。跳过规格中的目录/敏感名；普通隐藏文本只在显式选择时读入。大代码/表格续块不丢内容，重叠与引用通过位置回溯校验。解析工作进程默认每文件 30 秒、展开文本上限 10 Mi 字符、PDF 单页解压内容上限 20 MiB；Unix 上设置 512 MiB 内存上限，其他平台采用可用的等效子进程约束，无法实施时明确标记限制。PDF 中表格结构无法可靠保存时报告表格限制，不能把扁平文本当成可靠表格问答证据；DOCX ZIP 也检查展开上限。上传先创建 `kind=upload` 的持久任务，再发送批次；每批文件内容合计最多 40 MiB，累计最多 2,000 文件；只在 final 批次后排队处理。选定路径在实际打开时再次校验，原文件大小/mtime/文件身份变化时复核哈希。解析成功先提交 pending，尚未接入任务 4 时任务状态为 `waiting_index`。
- [ ] **Step 4: 运行同一测试命令。** 预期 PASS；删除来源测试还要断言原文件字节不变；部分失败不使整个任务冒充成功。
- [ ] **Step 5: 提交解析、队列、样本和测试。** 建议提交信息 `feat: import documents with bounded parsing and source positions`。

[pypdf 文本提取说明](https://pypdf.readthedocs.io/en/stable/user/extract-text.html)说明了扫描件和内容流内存限制；[python-docx 文档](https://python-docx.readthedocs.io/en/latest/)用于段落和表格解析。此处解析限额是本计划明确的实施默认值，不是库本身的保证。

### Task 4: 一致性索引、中文 FTS 和混合召回

**Files:** Create: `local_knowledge/vectors.py`, `local_knowledge/retrieval.py`, `tests/knowledge/test_vectors.py`, `tests/knowledge/test_retrieval.py`；Modify: `local_knowledge/store.py`, `local_knowledge/jobs.py`, `local_knowledge/text.py`。

**Interfaces:**
- Consumes: 任务 2 `embed/rerank/Budget`，任务 3 pending 修订。
- Produces: `VectorIndex(data_dir: Path, embedding_fingerprint: str, dimension: int)`，`upsert(chunks: Sequence[Chunk], embeddings: Sequence[Sequence[float]]) -> None`、`query(vector: Sequence[float], source_ids: Sequence[str], limit: int) -> list[str]`、`delete(source_id: str) -> None`；`index_revision(source_id: str, revision: int, budget: Budget) -> None`；`keyword_tokens(text: str) -> list[str]`；`Retriever(store: Store, vectors: VectorIndex, models: ModelClients)`，`retrieve(question: str, source_ids: Sequence[str], budget: Budget) -> list[Candidate]`、`evidence_units(candidates: Sequence[Candidate], token_budget: int, budget: Budget) -> list[Chunk]`。

- [ ] **Step 1: 写索引与召回失败测试。**

```python
def test_chroma_failure_does_not_publish_revision(index_harness):
    index_harness.vectors.fail_upsert = True
    with pytest.raises(ModelUnavailable):
        index_harness.index_revision('source-1', 2, Budget(30, Event()))
    assert index_harness.store.visible_revision('source-1') != 2
```

补写 `test_no_default_embedding_download`（拦截公共网络，真实临时 Chroma 仍可显式 upsert/query）、`test_vector_space_separated_by_fingerprint`、`test_deleted_vector_rechecked_in_sqlite`、`test_chinese_and_version_keyword_search`、`test_fts_punctuation_is_escaped`（引号、括号、`OR`、路径、空输入不作为用户自带 FTS 语法执行）、`test_rrf_limits_and_dedup`（两路各≤20，重排输入≤20，输出≤5）、`test_disabled_explicit_scope_cannot_expand`、`test_adjacent_code_units_respect_budget`、`test_restart_finishes_pending_cleanup`。

- [ ] **Step 2: 运行 `python -m pytest tests/knowledge/test_vectors.py tests/knowledge/test_retrieval.py -q`。** 预期 FAIL；可选依赖缺失在专门测试中明确断言，不用跳过真实 Chroma 测试掩盖它。
- [ ] **Step 3: 实现索引和混合召回。** `PersistentClient` 使用 data 子目录，collection 创建/获取显式指定 `embedding_function=None`，只传 `embeddings/query_embeddings`。先写 SQLite pending，再写向量，最后短事务激活；新修订一旦变化旧修订立即不可回答，激活前复核任务取消和当前 revision。中文连续文本生成单字和双字 token；ASCII 保留型号/版本/路径 token 及可拆分部分，保存原文和独立关键词文本。FTS 查询只由转义后的 token 构造，`unicode61` 分词；RRF 固定 `sum(1/(60+rank))`，rank 从 1 起，同分按 chunk ID 稳定排序。候选和相邻块全部回查 SQLite、范围、完成状态；整个证据单元超预算就移除或 miss，不切掉否定词或表头。向量模型变化时建立新 collection 和重索引任务，不在模型调用期间持有写锁。
- [ ] **Step 4: 运行同一测试命令。** 预期 PASS，任务 3 测试重新运行，确认 pending/waiting_index 能升级为已索引。
- [ ] **Step 5: 提交索引及测试。** 建议提交信息 `feat: add revision safe vector and keyword retrieval`。

持久客户端边界参照 [Chroma Client 文档](https://docs.trychroma.com/reference/python/client)，FTS 查询规则参照 [SQLite FTS5 文档](https://www.sqlite.org/fts5.html)；字词预处理与融合公式是本项目的实施选择。

### Task 5: 精准匹配、答案校验、统一服务和取消

**Files:** Create: `local_knowledge/matching.py`, `local_knowledge/service.py`, `tests/knowledge/test_matching.py`, `tests/knowledge/test_service.py`；Modify: `local_knowledge/store.py`, `local_knowledge/contracts.py`。

**Interfaces:**
- Consumes: `Retriever`、`ModelClients`、`Store`、有效评测配置。
- Produces: `Matcher(models: ModelClients)`，`prepare_question(request: QueryRequest, budget: Budget) -> PreparedQuestion`（原问题、检索问题、指代依据、`kind=qa/action/uncertain`、可核对的条件）、`match_evidence(question: PreparedQuestion, chunks: Sequence[Chunk], budget: Budget) -> MatchResult`、`validate_answer(payload: dict, question: PreparedQuestion, chunks: Sequence[Chunk], budget: Budget) -> ValidatedAnswer`；`KnowledgeService(store: Store, retriever: Retriever, models: ModelClients, settings: Callable[[],dict])` 内部创建 Matcher，提供 `query(request: QueryRequest) -> QueryResult`、`cancel(request_id: str) -> bool`、`request_status(request_id: str) -> dict`、`preview(request: QueryRequest) -> list[Candidate]`。

- [ ] **Step 1: 写匹配和服务失败测试。**

```python
def test_cancelled_query_cannot_become_hit(service_harness):
    service_harness.cancel_at('verify')
    result = service_harness.query('A 型号的保修期？')
    assert result.decision == 'cancelled'
    assert result.answer is None and result.citations == []
    assert service_harness.store.cache_count() == 0
```

补写 `test_paraphrase_returns_supported_local_answer`（不同措辞同意图）、`test_constraint_matrix`（实体/版本/年份/数字/单位/否定分别改变）、`test_pronoun_without_antecedent_is_context_uncertain`、`test_partial_or_conflicting_evidence_misses`、`test_missing_quote_or_unsupported_claim_rejected`、`test_answer_text_must_be_fully_covered_by_claims`、`test_stale_latest_answer_misses`、`test_historical_model_answer_is_not_promoted_to_fact`、`test_document_instruction_does_not_change_system_constraints`、`test_action_request_not_answered_from_cache`、`test_source_changes_during_verification`、`test_cache_revalidates_current_question_and_dependencies`、`test_disabled_empty_uncalibrated_unavailable_and_timeout_reasons`。模拟本地总时间超过 30 秒，结果必须是 `local_timeout`，取消优先于超时/miss。

- [ ] **Step 2: 运行 `python -m pytest tests/knowledge/test_matching.py tests/knowledge/test_service.py -q`。** 预期 FAIL。
- [ ] **Step 3: 实现完整本地决策。** 本地模型生成独立问题与条件，每项条件保留原文/前文依据；无法可靠抽取或疑似动作请求不得生成命中。当前模型/评分变换/校验指纹与 profile 不一致返回 uncalibrated；召回后用冻结 profile 阈值过滤重排分数，无足够候选返回 low_relevance。先静态检查来源、完成性、过期和明确条件，再由本地结构化匹配判断全覆盖与冲突；生成使用规格 JSON，温度 0。输入预算扣除系统模板、结构化输出模板及 max_output_tokens 后才放证据和必要上下文，缺失指代所需前文时返回 context_uncertain，不能随意截前六轮。引用引句仅允许在原片段中按统一换行/空白规范匹配，不用模糊匹配补造引文。随后独立本地校验调用检查每项结论的支持关系、数值/单位/实体和整个 answer 的覆盖，避免模型在 claims 外插入无依据结论；任何不确定均 miss。`historical_model_answer` 的客观事实支持不能仅来自一次无来源模型断言；问“之前模型说了什么”可直接引用该记录。返回/缓存提交前再检查文件新鲜度、修订及取消。缓存命中仍核对上下文、来源有效期、QA 指纹、校验版本和当前条件。服务绝不发送在线请求。稳定原因枚举逐项使用规格第 11 节；action 排除使用 `constraint_mismatch` 并记录 `scope_excluded` 阶段，不擅加未知 reason。请求阶段写入 SQLite 元数据；重复 request ID 不能二次启动，取消 ID 即使先于 query 到达也保存短期取消标记。
- [ ] **Step 4: 运行同一测试命令。** 预期 PASS；补跑任务 1–4 测试确认依赖失效路径一致。
- [ ] **Step 5: 提交服务和测试。** 建议提交信息 `feat: validate evidence before serving local answers`。

### Task 6: 本地模型校准、独立验证和配置激活

**Files:** Create: `local_knowledge/evaluation.py`, `tests/knowledge/test_evaluation.py`, `tests/fixtures/local_knowledge/evaluation-calibration.jsonl`, `tests/fixtures/local_knowledge/evaluation-validation.jsonl`, `tests/fixtures/local_knowledge/evaluation-documents/`；Modify: `local_knowledge/store.py`, `local_knowledge/jobs.py`, `local_knowledge/service.py`。

**Interfaces:**
- Consumes: `KnowledgeService` 的同一召回/匹配/校验路径、模型指纹及任务队列。
- Produces: `EvaluationRunner(service: KnowledgeService, store: Store)`，`enqueue(calibration_path: Path, validation_path: Path) -> str`、`run(dataset: EvaluationDataset, cancellation: Event) -> EvaluationReport`、`activate(report_id: str, current_fingerprint: str) -> bool`；`profile_compatible(profile: dict, config: dict) -> bool`。

- [ ] **Step 1: 写评测状态与发布门槛失败测试。**

```python
def test_zero_hit_profile_cannot_pass():
    report = EvaluationReport(answerable=30, correct_hits=0, wrong_hits=0)
    assert report.meets_release_gate() is False
```

补写 `test_one_wrong_hit_rejects_profile`、`test_eighteen_of_thirty_correct_hits_meets_recall_gate`（18/30=60%）、`test_seventeen_of_thirty_rejected`、`test_validation_labels_never_select_threshold`、`test_paraphrase_family_not_split_across_sets`、`test_model_revision_or_transform_change_disables_profile`、`test_cancelled_evaluation_cannot_activate`、`test_real_models_required_flag`（替身结果只标 deterministic，不可激活生产配置）。

- [ ] **Step 2: 运行 `python -m pytest tests/knowledge/test_evaluation.py -q`。** 预期 FAIL。
- [ ] **Step 3: 实现评测与准备人工标注样例。** 最少 60 条，其中 calibration 30、validation 30，各至少 15 正例，按同义改写、条件差异、指代、缺证据、冲突、时效六类各 5 条覆盖；按事实/问法家族分组隔离，资料库可以共享但标准答案不得送入模型。样本含 `id/family_id/category/question/context/expected_answerable/expected_claims/allowed_citations/critical_constraints/as_of`，样本标签需人工核对。阈值只在 calibration 上选择：从实际分数候选中找零错误命中且正确命中最多的阈值，同等结果选更保守者；冻结后仅运行一次 validation，不通过不能用同一验证集反复调参。评测使用受控的内部 evaluation 模式绕过“未校准不能回答”，仍执行全部证据校验；该模式不暴露给普通 query。报告逐题回答、引句、正确/错误命中、拒答、分项指标、耗时、数据集哈希和完整 embedding/rerank/QA/提示词/校验指纹。精度判定使用标准结论/允许引句及人工逐项复核，不让生成模型自己给自己判准确。只有真实端点报告经复核且符合规格门槛才可 activate。
- [ ] **Step 4: 运行同一测试命令。** 预期 PASS。此处只证明评测逻辑，实际模型验收留到任务 10，不能将通过替身测试等同于语义精度达标。
- [ ] **Step 5: 提交评测逻辑、数据和测试。** 建议提交信息 `feat: gate local answers on calibrated model evaluation`。

### Task 7: Flask 接口、API 对话同步及请求计数

**Files:** Create: `local_knowledge/api.py`, `local_knowledge/chat_sync.py`, `tests/knowledge/test_api.py`, `tests/knowledge/test_chat_sync.py`；Modify: `local_knowledge/__init__.py`, `local_knowledge/store.py`, `server.py` 的设置/状态/单会话保存、普通 `/api/chat` 及 `_llm_chat_full` 在线调用位置。

**Interfaces:**
- Consumes: 任务 1–6 的服务、导入管理器和评测 runner；现有 `save_state(state) -> bool`、`_load_settings() -> dict`。
- Produces: `create_blueprint(service: KnowledgeService, imports: ImportManager, evaluations: EvaluationRunner, sync: ChatSynchronizer) -> Blueprint`；`ChatSynchronizer(store: Store, imports: ImportManager)`，`sync_snapshot(conversations: Sequence[dict]) -> None`、`record(turn: CompletedTurn) -> str`；`Store.record_online_call(request_id: str, call_id: str, kind: str, model: str) -> None`。

- [ ] **Step 1: 写 Flask 与对话同步失败测试。**

```python
def test_query_miss_never_contains_candidate_answer(api_client):
    response = api_client.post('/api/knowledge/query', json=valid_request())
    assert response.status_code == 200
    assert response.json['decision'] == 'miss'
    assert response.json['answer'] is None and response.json['citations'] == []
```

补写 `test_all_spec_routes_registered`、`test_input_invalid_is_400`、`test_knowledge_disabled_does_not_import_chroma`、`test_settings_failure_preserves_saved_chat`、`test_double_record_same_messages_one_source`、`test_edit_and_delete_invalidate_before_index_queue`（覆盖整体 PUT 和单会话 PUT/DELETE）、`test_edit_question_keeps_old_answer_reference_only`（编辑问题不能将原答案伪装成针对新问题生成）、`test_stopped_partial_error_unknown_not_answerable`、`test_saved_state_crash_reconciled_on_startup`、`test_local_answer_not_collected_as_independent_authority`、`test_record_cannot_resurrect_deleted_turn`、`test_status_and_trace_do_not_expose_secrets`、`test_source_content_requires_current_revision`、`test_upload_batch_limit_is_413_and_retryable`。

- [ ] **Step 2: 运行 `python -m pytest tests/knowledge/test_api.py tests/knowledge/test_chat_sync.py -q`。** 预期 FAIL。
- [ ] **Step 3: 注册蓝图并实现所有规格接口。** status/probe/sources/import/upload/web-import/source PATCH/DELETE/refresh/jobs GET/cancel/query/query cancel/evaluate/record 均采用共享契约；import/upload/evaluate 返回 202 与 `job_id`，查询为 200 结构化结果；输入错误 400、缺对象 404、版本/ID 冲突 409、超请求大小 413；意外错误 5xx 不夹带候选答案。请求进度 GET 返回当前实际 trace/stage/decision，未知 ID 404。内容 GET 只读来源已导入文本，不借任意路径读文件。保存聊天成功后，先同步禁用变化/删除资料及依赖缓存，再将新内容放入持久队列；不会在 Flask 请求内解析文档或生成向量。同步失败记录待恢复标志，在修复完成前暂停受影响聊天来源参与本地回答，不能保持旧答案可见；保存失败不入库。`/record` 在会话尚未防抖保存时暂存为待核对，只有后续持久化快照确认消息存在且未编辑/删除才激活，启动时复核；同源多入口去重。旧消息完成性 unknown 可导入为受限参考，不能用错误前缀猜测 complete。API 完成性以 SSE 终止/finish reason 为准，断流或 length 截断为 partial。每个实际在线发送动作独立 call ID；请求通过 `X-Request-ID` 传递，同一网页模型收到 prompt-sent 后计数，HTTP POST 尝试（含失败/重试）均计数，排队/轮询不计；在线 auto-route 及其 `_llm_chat_full` 辅助调用继承 ID。本地 JSON 调用独立客户端不会被算为在线。
- [ ] **Step 4: 运行同一测试命令和 `python -m pytest tests/knowledge -q`。** 预期 PASS，普通 API SSE 适配用固定上游替身回归，不启动线上模型。
- [ ] **Step 5: 提交蓝图、同步和测试。** 建议提交信息 `feat: expose knowledge routes and collect completed chat revisions`。

### Task 8: 可见网页会话采集、来源限制与 IPC 取消

**Files:** Create: `electron/web-conversation.cjs`；Modify: `electron/web-chat.cjs`, `electron/main.cjs`, `electron/preload.cjs`, `electron/web-chat.test.cjs`, `src/lib/desktopBridge.ts`, `src/types.ts`。

**Interfaces:**
- Consumes: 当前 `detectSite(url)`、`runWebChat(view,prompt,options)`、`webTabs`、网页 `validation.complete/partial` 和共享 CompletedTurn。
- Produces: `extractVisibleConversation(view, options={}) -> Promise<WebConversationSnapshot>`，包含 `site/url/title/conversation_id/model/messages/context_complete/coverage/skipped`；`messages` 含 `id/role/content/complete/position`，角色不能从普通正文推断。桥接 `importWebConversation(id: string): Promise<WebConversationSnapshot>`、`cancelWebChat(id: string, requestId: string): Promise<{ok:boolean}>`；`webChat(id,prompt,timeoutMs?,requestId?)` 保留前三参数兼容，`WebChatResult` 增加 `requestId/contextSnapshot/cancelled`。

- [ ] **Step 1: 扩展既有 Electron 测试网页。** 写角色消息、无角色普通页面、折叠/虚拟化历史、仍在生成、错误复制文本和两轮同时事件的 data URL fixtures。断言：`test_visible_role_pairs` 只配对实际 user/assistant；`test_unknown_history_is_context_incomplete` 不宣称账户全历史；`test_inflight_reply_excluded` 不导入生成中答案；`test_cancel_before_submit_zero_sends` 的发送按钮计数为 0；`test_cancel_during_generation_no_final_collection` 返回 cancelled、不触发最终复制/持久化可复用答案；`test_late_events_have_request_id` 不串轮。
- [ ] **Step 2: 运行 `npm run test:web-chat`。** 预期新提取/取消接口缺失而 FAIL。无 DISPLAY 的 Linux 使用 `xvfb-run -a npm run test:web-chat`；不添加禁用 Electron 沙箱的参数。
- [ ] **Step 3: 实现按站点角色选择器的可见会话快照及 IPC。** ChatGPT/Claude 等已有明确角色结构的适配器逐项采集；其他站点只有验证到角色/消息边界才导入，无法识别则返回不支持/受限正文，不猜问答配对。没有明确“从会话起点至当前完整覆盖”的证据时 `context_complete=false`；无稳定 DOM 消息 ID 时用会话定位、角色、序号与内容哈希，变化作为修订/受限来源处理。应用发送前抓取历史快照，发送后关联本轮问答，缺模型名标未知。主进程以 `(sender.id,tabId,requestId)` 管理 AbortController；同标签并发问答返回 busy，取消只作用于同 sender 同请求；发送/轮询/复制/最终返回前都检查 signal。关闭标签清理控制器；取消期间可点击本轮已确认的停止按钮，但不刷新/换会话。`runWebChat` 的错误结果明确区分 cancelled，停止后不执行正常最终提取和收集。新 bridge 只允许当前已打开 WebContents，不接入外部 Chrome。进度事件补 requestId，前三参数旧调用仍可用。
- [ ] **Step 4: 运行同一测试命令及 `npx tsc --noEmit`。** 预期 PASS；原有长回答等待、复制、站点检测和新建会话测试继续通过。已发起网页生成能否由站点停止取决于可识别按钮；应用取消至少保证停止采集、综合和入库，不能声称撤回已经送到网站的请求。
- [ ] **Step 5: 提交 Electron、桥接和测试。** 建议提交信息 `feat: import visible web conversations and cancel chat by request`。

### Task 9: 用户提问前置本地检查与安全在线兜底

**Files:** Create: `src/lib/knowledgeApi.ts`, `src/lib/knowledgeRouting.ts`, `src/lib/knowledgeRouting.test.ts`, `src/components/ChatArea.knowledge.test.tsx`, `src/test/setup.ts`, `vitest.config.ts`；Modify: `package.json`, `package-lock.json`, `src/App.tsx`, `src/types.ts`, `src/components/ChatArea.tsx`。

**Interfaces:**
- Consumes: 共享 TS 类型、`GET/POST /api/knowledge/*`、新网页 requestId 及取消桥接。
- Produces: `queryKnowledge(request: KnowledgeQueryRequest, signal: AbortSignal): Promise<KnowledgeQueryResult>`、`cancelKnowledge(requestId: string): Promise<void>`、`recordKnowledge(turn: CompletedTurn): Promise<void>`；`checkLocalFirst(request: KnowledgeQueryRequest, options: {enabled:boolean; onlineFallback:boolean; signal:AbortSignal}): Promise<LocalRouteResult>`，`LocalRouteResult` 为 hit / fallback / cancelled / blocked；`finishRequest(requestId: string, mutation: () => void): boolean` 仅活动请求可修改当前加载/流状态；聊天新增 `knowledgeProgress`、`localKnowledgeEnabled` props 和请求级状态。

- [ ] **Step 1: 写前端失败测试并建立所需测试入口。** 开发依赖添加 Vitest、jsdom、Testing Library（react/user-event），写 `test:knowledge` 脚本和独立配置；安装时按当前 Node/npm 的 engines 选择兼容版本并锁入 package-lock，不升级现有 React/Electron。测试以下可观察行为：

```ts
it('本地命中时所有在线路径调用为零', async () => {
  const result = await checkLocalFirst(request, enabledOptions);
  expect(result.decision).toBe('hit');
  expect(fetchSpy.callsFor('/api/auto-route')).toHaveLength(0);
  expect(fetchSpy.callsFor('/api/chat')).toHaveLength(0);
  expect(desktop.webChat).not.toHaveBeenCalled();
});
```

同一测试组必须覆盖实际 App 发送行为，不能只测试没有在线逻辑的 helper。补写 `local_hit_with_auto_route_and_web_group_enabled`、`no_provider_can_create_conversation_and_send`、`miss_uses_exact_selected_targets_once`、`disabled_uses_existing_path`、`cancelled_or_aborted_never_falls_back`、`500_falls_back_but_400_does_not_send_malformed_question`、`fallback_disabled_is_blocked`、`one_user_and_one_assistant_per_request`、`old_finally_does_not_clear_new_request`、`attachments_and_plugin_actions_bypass_local_answering`、`stream_disconnect_not_recorded_complete`、`resend_runs_local_gate_again`。

- [ ] **Step 2: 运行 `npm run test:knowledge`。** 预期尚未接入本地路径而 FAIL。
- [ ] **Step 3: 调整真实发送生命周期并实现接口。** 在用户点击发送时创建 requestId/controller、固定会话/目标/系统约束/参数快照并置 busy，再执行本地检查；本地结果校验通过前不展示 token。纯本地新会话 `providerId/model` 使用空字符串兼容现有类型，不创建假的 provider；放开新建会话、主输入/发送、欢迎页提示及普通重试对 provider 的硬依赖，插件/图像等按钮仍按原能力判断。hit 只提交一次本地 assistant，带 knowledge 引用和 completion；miss 才执行现有在线 auto-route、研究/API 或网页群聊及综合，目标缺失在这一阶段提示。关闭 fallback 后 miss 显示失败原因，不能偷发在线。附件/插件/显式工作流不走普通问答缓存；自然语言动作由任务 5 排除。controller 覆盖 auto-route 和后续 fetch，各 await 后检查取消；Stop 发送 query cancel 和已发起网页 cancel，旧轮迟到结果只能结束自己的记录，不能修改新轮 UI。保留既有在线分支内部算法，但移动其触发位置，避免双加 user/assistant。`knowledge` 标记 local_generated/validated_cache/online；`completion` 记录真实完成状态。成功的普通 API、网页原始候选与最终综合分别幂等 record，local 答案仅保留依赖不重新入库成权威材料；带 request ID 的调用传给后端统计。请求进度轮询 500ms，结束/卸载时停止，404 在请求尚未登记时短暂忽略，不用定时器伪造阶段。
- [ ] **Step 4: 运行 `npm run test:knowledge`、`npx tsc --noEmit`、`npm run build`。** 预期新测试 PASS、类型检查和构建成功；记录实际在线请求次数，而不是仅凭 UI 标记宣称零调用。
- [ ] **Step 5: 提交路由、界面、测试入口和 lockfile。** 建议提交信息 `feat: route ordinary questions through local evidence before online calls`。

### Task 10: 资料管理、引用定位和实际模型验收

**Files:** Create: `src/components/KnowledgeSettings.tsx`, `KnowledgePanel.tsx`, `KnowledgeCitations.tsx`, `KnowledgeSourceViewer.tsx`, `src/hooks/useKnowledgeJobs.ts`, `src/components/KnowledgePanel.test.tsx`, `src/components/KnowledgeCitations.test.tsx`, `tests/knowledge/test_end_to_end.py`；Modify: `src/components/SettingsModal.tsx`, `DirPicker.tsx`, `WebViewer.tsx`, `ChatArea.tsx`, `src/App.tsx`, `src/lib/knowledgeApi.ts`；Create: `docs/local-knowledge.md`, `docs/local-knowledge-evaluation-report.md`。

**Interfaces:**
- Consumes: 前序全部接口、`Citation/JobSnapshot`、已有 `openWebTab` 和会话选择机制。
- Produces: `KnowledgeSettings({value,onChange}: {value: LocalKnowledgeSettings; onChange:(v:LocalKnowledgeSettings)=>void})`；`KnowledgePanel({onOpenCitation}: {onOpenCitation:(c:Citation)=>void})`；`KnowledgeCitations({citations,onOpen}: {citations:Citation[]; onOpen:(c:Citation)=>void})`；`KnowledgeSourceViewer({sourceId,revision,position}: {sourceId:string; revision:number; position:SourcePosition})`；`useKnowledgeJobs(jobId:string|null): {job:JobSnapshot|null; error:string|null; cancel:()=>Promise<void>}`。

- [ ] **Step 1: 写 UI 与端到端失败测试。** `settings_default_off_and_probe_errors` 检查默认关和三个角色独立状态；`file_and_directory_upload_batch_progress` 检查相对路径和逐项失败；`disable_delete_refresh_invalidates_answer` 检查操作后旧答案不可再命中；`web_import_shows_visible_scope` 显示范围和未知上下文；`citations_navigate_to_exact_source` 分别验证行/页/段落/表格/消息位置；`revision_409_shows_source_changed` 不显示旧文本为当前证据；`unmount_stops_polling` 不继续更新界面。后端 `test_synonym_hit_then_source_update_then_miss` 从真实解析/索引一直走到 query，使用临时 Chroma 和可控本地端点；`test_all_online_auxiliaries_zero_on_hit` 包含 online auto-route、辅助 JSON、网页发送及综合替身计数。
- [ ] **Step 2: 运行 `npm run test:knowledge` 与 `python -m pytest tests/knowledge/test_end_to_end.py -q`。** 预期未有完整管理/定位而 FAIL。
- [ ] **Step 3: 实现管理面板和引用定位。** 设置页新增 knowledge tab，保存及分组重置复用当前设置逻辑；连接区展示独立 probe 状态、模型权重修订和评测状态，提供导入标注数据/运行评测/人工复核后激活，激活仅接收 real_models 且通过门槛、指纹匹配的报告。`DirPicker` 新增可选 `selectionMode='directory'|'file'`，默认 directory 保持原调用；资料导入用 file/directory 模式以及浏览器 multiple/目录上传，后端路径与浏览器相对路径分开展示。按 40 MiB 批次提交 upload，批次 413 可重试而不重复入库；显示成功/跳过/失败项、取消和更新。网页工具栏新增“导入当前可见对话”，只调用显式新 bridge。资料可搜索/启用/禁用/删除；回显资料删除影响的是索引/副本。引用文档在 `KnowledgeSourceViewer` 显示保存原文并滚动高亮位置，PDF 显示真实页码文本、DOCX 显示段落/表格单元，不声称复刻原文件版式；网页打开原 URL，对话切换会话并滚动到带 message ID 的 DOM 锚点。来源更新/删除后引用仍保留历史标记并提示不可用。消息显示“本地资料回答”“历史问答复用”或“在线回答”；分数只在诊断详情。文档写入三服务启动样例、能力检查、安装/限额、失败/恢复、关闭功能及数据目录备份说明，不自动启动或下载新模型。
- [ ] **Step 4: 执行整体验收并保存报告。** 先运行下面的确定性检查，全部通过后在已配置的实际三角色端点上通过 `/api/knowledge/evaluate` 执行任务 6 的独立数据集、人工复核逐题结论与引句并保存报告。实际模型不可用则报告明确标记“实际模型精度验收未完成”，automatic profile 保持无效，不能勾选实际验收子项。

```bash
python -m pytest tests/knowledge -q
PYTHONPATH=desktop-agent/src python -m unittest discover -s desktop-agent/tests -v
npm run test:knowledge
npx tsc --noEmit
npm run build
npm run test:web-chat
```

新增测试分别验证本子系统，现有 Desktop Agent 与 Electron 测试用于确认共用 server/bridge 未破坏。无显示环境的 Electron 测试采用任务 8 的 xvfb 命令。

实际验收报告必须包含：

- [ ] 本机服务和依赖版本、三模型权重/服务指纹、评分变换、阈值、提示词/校验版本。
- [ ] calibration/validation 的样本数、正负比例、六类覆盖、家族隔离和数据集哈希。
- [ ] validation 逐题结果及人工引用支持核对；错误本地命中为 0，正例正确命中率至少 60%。
- [ ] 本地命中开启自动选模型和网页群聊时所有在线请求计数为 0；取消后无新增发送；纯本地无 provider 问答可用。
- [ ] 导入/删除/更新/重启/关闭功能的实际操作结果；未通过项和未执行项如实列出。

- [ ] **Step 5: 提交已通过的管理界面、测试和说明。** 建议提交信息 `feat: manage local sources and verify semantic qa end to end`。报告若包含真实业务资料，只保留用户允许共享的脱敏样例与指标；不要将运行时库、文档副本或密钥加入 Git。

## 4. 三个本地服务的配置样例

以下是实施后的连接说明模板，不在方案编写阶段运行。模型文件需要用户已有的、符合各角色的 GGUF；`--pooling`、context 和 GPU 参数以该模型及本机能力为准。

```bash
llama-server -m /absolute/path/embedding.gguf --embedding --pooling mean --host 127.0.0.1 --port 8011
llama-server -m /absolute/path/reranker.gguf --embedding --pooling rank --host 127.0.0.1 --port 8012
llama-server -m /absolute/path/qa.gguf --host 127.0.0.1 --port 8013
```

设置中的角色 URL 使用上述 origin，不拼接重复 `/v1`；角色协议决定路径。QA 也可复用现有 Hub 已启动的服务，embedding/rerank 使用独立服务。探测成功只证明接口可用，评测通过才开启自动本地回答；服务/模型切换需要重新索引或重新评测。启动参数依据前述 llama.cpp 官方文档，embedding 模型实际 pooling 应在探测中核实。

## 5. 覆盖核对与交付边界

| 设计要求 | 负责实现与验证 |
|---|---|
| 语义优先、同义问法、关键条件、指代、冲突、时效 | 任务 4、5、6；实际模型在任务 10 验收。 |
| 本地命中零在线调用、原目标兜底、停止不兜底 | 任务 5、7、8、9、10。 |
| API/网页/手选文档三类来源与完整性 | 任务 3、7、8；任务 10 提供入口。 |
| 修订、去重、缓存依赖、Chroma 一致性与重启恢复 | 任务 1、3、4、5、7。 |
| 三模型端点、能力检查、评分校准、模型切换 | 任务 2、4、6、10。 |
| 设置、资料管理、引用定位、纯本地无 provider | 任务 9、10。 |
| 既有独立 Agent/CLI/工作流边界与关闭回归 | 任务 5、9、10；不扩展其协议。 |
| 真实精度、最少 60 样例、零错误命中、≥60% 正例命中 | 任务 6、10；缺真实端点不能宣称完成。 |

方案自查：五项 Review Focus 均落到具体测试；接口名称及字段在共享契约中统一；所有规格接口都有负责的任务；每个任务包含失败验证、实现、通过验证和提交边界。新增两个只读接口用于规格要求的真实进度与精确定位，没有扩展资料访问范围。

本次只完成方案编写。实现时先记录既有 Python/TypeScript/Electron 检查基线，按任务顺序推进，不改动当前另有修改的 `electron/web-project.cjs`。实际语义精度是独立验收，不能用编译通过、测试替身或命中率代替。
