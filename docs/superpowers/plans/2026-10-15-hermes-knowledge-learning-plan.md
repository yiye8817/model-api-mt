# Hermes Knowledge Learning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在独立「知识学习」Tab 中统一查看已有和新增文档，使用 Hermes 生成可交互思维导图、全部知识点、跨文档知识图谱，支持有原文引用的文档问答、深度探索与整合归档。

**Architecture:** 新增独立 `learning` Python 包，以 SQLite 和正文快照保存文档修订、结构化分析与学习记录。来源适配器只读接入既有两个资料库；后台任务通过注入的 Hermes 会话工厂执行分析、问答和整合。React 学习工作区复用现有 Tab、主题和网页打开能力，通过 HTTP 与任务轮询工作。

**Tech Stack:** Python 3、Flask、SQLite FTS5、现有 Hermes 运行时、现有 PDF/DOCX 解析器、React 19、TypeScript、Tailwind、SVG、pytest、Vitest、Testing Library。

**Spec:** `docs/superpowers/specs/2026-10-15-hermes-knowledge-learning-design.md`

## Global Constraints

- 在中部 Tab 栏增加常驻「知识学习」入口。通过新建标签菜单也能定位到该 Tab，重复点击激活已有实例。
- 支持多文件上传，首版格式为 TXT、Markdown、PDF 和 DOCX。
- 单文件上限沿用现有文档解析约束 20 MiB，每次上传请求不超过应用现有 50 MiB 总限制。
- 链接入口接受公开 HTTP 或 HTTPS 网页，复用已有公开地址校验、受控抓取和正文提取能力。
- 学习数据保存到 `data/learning/learning.sqlite3`，文件副本与正文快照位于同一目录下。
- SQLite 使用 WAL 与外键约束，应用层不引入图数据库依赖。
- 任务只保存 provider ID 和模型名称，不持久化密钥。
- 初始后台并发为两个任务，同一文档修订同时只运行一份分析。
- 任务状态为 queued、running、completed、failed 或 cancelled。
- 服务启动时将原 queued 任务恢复入队，将中断的 running 任务标记为失败并说明服务中断。
- 分析文档、提问和探索均不依赖普通对话的本地模型精度评测门槛。
- 本地知识和内容库文档自动同步列表，分析由用户触发；新增上传和链接导入自动进入解析、分析任务。
- 保留既有来源及其位置性质；历史会话、公开评测集和普通问答条目不自动作为文档导入。
- 所有模型成果绑定文档修订并校验引用，所有后台任务在提交前检查取消和修订状态。
- 沿用当前依赖，SVG 直接渲染结构化数据；新增包必须有本任务无法用现有依赖完成的理由。

## Review Focus

- 文档在分析或问答运行期间被更新或删除：迟到结果不得成为当前有效成果，追问不得扩大到其他文档；由任务 1、4、5 测试固定。
- 同名不同领域的知识点、同内容的多个来源和删除后仍有支持证据的关系：保持来源可追溯，避免错误合并和误删除；由任务 2、4 测试固定。
- 分块数超过一批的长文、正文中的提示指令、格式错误和伪造引用：尾部内容不能遗漏，文档作为资料处理，错误输出不能替换有效分析；由任务 3、4 测试固定。
- 缺少 Hermes、Chroma、本地问答配置或可选 PDF/DOCX 依赖：已有资料与成果仍能读取，操作错误具体可见，同批有效文件继续处理；由任务 2、7、8 测试固定。
- 快速切换文档、切换 Tab、取消和重启：旧请求不能覆盖新选择，后台任务独立于组件生命周期，完成与失败可再次查询；由任务 3、8、10 测试固定。

## 文件与接口约定

新增后端文件为 `learning/__init__.py`、`contracts.py`、`schema.sql`、`store.py`、`sources.py`、`ingest.py`、`hermes.py`、`jobs.py`、`analysis.py`、`graph.py`、`retrieval.py`、`service.py`、`archives.py`、`api.py`、`runtime.py`。`server.py` 只提供既有能力回调并注册 Blueprint；`knowledge/store.py` 增加只读文档枚举。现有受控文件解析器直接复用；网页正文提取增加公开可复用函数并保持当前搜索调用的默认行为。

新增前端文件为 `src/lib/learningTypes.ts`、`learningApi.ts`、`src/hooks/useLearningJobs.ts`，以及 `src/components/learning/` 下的 `LearningPanel.tsx`、`LearningSidebar.tsx`、`ImportSources.tsx`、`DocumentStudy.tsx`、`MindMap.tsx`、`CitationPanel.tsx`、`DocumentQuestions.tsx`、`ConceptExplorer.tsx`、`KnowledgeGraph.tsx`、`ArchiveView.tsx`、`GraphViewport.tsx`。`src/App.tsx` 增加一个固定 Tab 和菜单入口。

测试位于 `tests/learning/` 及前端对应 `.test.ts`、`.test.tsx` 文件。`tests/learning/conftest.py` 提供临时 SQLite、只读既有来源、可控 Hermes 会话替身及服务工厂，禁止测试读写真实 `data/`、真实 provider 或产生远程模型调用。

共享 JSON 字段固定为 snake_case。核心对象：`Document` 包含 `id,title,category,tags,revision,content_hash,status,sources,analysis_id`；`Chunk` 包含 `id,document_id,revision,ordinal,text,position`；`Citation` 包含 `document_id,revision,chunk_id,quote,position,title`；`Analysis` 包含 `id,document_id,revision,summary,category,tags,tree,concepts,relations,coverage`；树节点包含 `id,label,children,concept_id,citations`，coverage 包含 processed 和 total。

`Concept` 包含 `id,name,domain,description,aliases,citations,document_ids`；`Relation` 包含 `id,source,target,type,citations`；`GraphNode` 包含 `id,label,type,document_id,concept_id`，type 为 document 或 concept。概念归一化使用 Unicode NFKC、casefold 和空白折叠，领域不同不自动合并。

`SourceSnapshot` 为来源适配器输出，包含 `source_id,origin,title,content_hash,external_revision,locator,chunks,status`，origin 为 local_knowledge、content_library 或 learning；每个 chunk 包含 text、position、ordinal。由 LearningStore 赋予本模块 document_id、revision 和 chunk_id。

`Scope` 为 `{mode:'selected',document_ids:['doc-a']}` 或 `{mode:'all'}`。空的 selected 范围返回 400。提交任务时 all 解析为当前文档及修订的快照；新增文档不改变已经开始的问答范围。`Job` 包含 `id,kind,status,phase,processed,total,message,error,result,document_revisions,created_at,updated_at`。`Page` 统一为 `{items,total,page,page_size}`，默认每页 30，范围 1–100。

## Task 1 文档修订与学习数据存储

**Files:**
- Create: `learning/__init__.py`, `learning/contracts.py`, `learning/schema.sql`, `learning/store.py`
- Test: `tests/learning/__init__.py`, `tests/learning/conftest.py`, `tests/learning/test_store.py`

**Interfaces:**
- Produces: `LearningStore(data_dir: Path)`，`connection()` 提供事务连接。
- Produces: `upsert_document(source: dict, chunks: list[dict]) -> dict`、`get_document(document_id: str) -> dict`、`list_documents(filters: dict, page: int = 1, page_size: int = 30) -> dict`。
- Produces: `get_chunks(document_id: str, revision: int) -> list[dict]`、`update_document(document_id: str, patch: dict) -> dict`、`remove_document(document_id: str) -> None`、`resolve_scope(scope: dict) -> dict[str, int]`、`revisions_current(revisions: dict[str,int]) -> bool`。
- Produces: `LearningError(message: str, status: int = 400)`、共享 `TypedDict`，以及 `SourceSnapshot` 数据结构。
- Tables: documents、document_sources、excluded_sources、revisions、chunks、chunks_fts、analyses、concepts、concept_mentions、relations、relation_evidence、conversations、turns、explorations、archives、jobs。分析、图谱和学习记录相关方法在所属任务中加入。

- [ ] **Step 1 写失败测试。** 覆盖重启持久化、相同来源幂等写入、正文变更递增修订、中文标题搜索、分类与标签人工覆盖，以及删除和范围快照；断言如下：

```python
def test_document_revision_invalidates_old_scope(store, source, chunks):
    first = store.upsert_document(source, chunks)
    scope = store.resolve_scope({'mode': 'selected', 'document_ids': [first['id']]})
    second = store.upsert_document({**source, 'content_hash': 'changed'}, [{**chunks[0], 'text': '新正文'}])
    assert second['revision'] == first['revision'] + 1
    assert store.revisions_current(scope) is False
    assert store.get_chunks(first['id'], first['revision'])[0]['text'] == chunks[0]['text']
```

- [ ] **Step 2 验证失败。** 运行 `.venv/bin/python -m pytest tests/learning/test_store.py -q`，预期缺少 `learning` 或对应方法导致 FAIL。
- [ ] **Step 3 实现存储与类型。** 按接口创建表、WAL、外键和操作事务；文档来源与正文修订分离，维护片段 FTS；只允许标题、分类、标签的显式人工修改，旧修订保留而默认查询只读当前有效修订。
- [ ] **Step 4 验证通过。** 重跑该测试文件，要求全部 PASS；额外断言缺失或已删除文档及空 selected 范围均抛出 `LearningError`，不被解释为 all。
- [ ] **Step 5 提交。** `git add learning tests/learning`；`git commit -m "feat: persist learning documents and revisions"`。

## Task 2 既有资料同步与文件链接导入

**Files:**
- Create: `learning/sources.py`, `learning/ingest.py`
- Modify: `knowledge/store.py` 的只读查询方法；`web_research/pages.py` 的正文提取入口；`web_research/sources.py` 的抓取截取范围元数据
- Test: `tests/learning/test_sources.py`, `tests/learning/test_ingest.py`

**Interfaces:**
- Consumes: Task 1 的文档和片段接口；`local_knowledge.parsers.parse_file`、`ParseLimits`；`web_research.sources.fetch_page(url,cancel,max_chars)`。
- Produces: `KnowledgeStore.document_snapshots() -> list[dict]`，按 `document:` dataset 聚合片段，按 chunk 序号排序，仅返回文档。
- Produces: `SourceSynchronizer(store, local_store, content_store).sync() -> dict`，返回 added、updated、removed、skipped 和 errors。
- Produces: `parse_upload(path: Path, cancel: Event) -> dict`、`parse_link(url: str, cancel: Event) -> dict`、`make_chunks(units: list[dict], document_id: str, revision: int) -> list[dict]`；解析结果包含 title、units、warnings、source。
- Produces: `extract_article(document: dict, max_chars: int | None = 18000) -> tuple[str,str,str]`，现有 `_extract` 保留原默认 18000 字符语义；学习导入读取受控抓取到的完整正文快照，超出抓取上限提示截取范围。

- [ ] **Step 1 写失败测试。** 同步两处资料库、禁用本地知识且无 Chroma 时枚举、排除会话与评测集、片段序号 2 在 10 之前、移除后不被刷新收回、来源删除和同内容多来源都要验证。

```python
def test_sync_does_not_readd_excluded_source(syncer, store):
    assert syncer.sync()['added'] == 1
    document = store.list_documents({})['items'][0]
    store.remove_document(document['id'])
    assert syncer.sync()['added'] == 0
    assert store.list_documents({})['total'] == 0
```

- [ ] **Step 2 验证失败。** `.venv/bin/python -m pytest tests/learning/test_sources.py tests/learning/test_ingest.py -q`，要求新接口测试 FAIL。
- [ ] **Step 3 实现只读同步。** 使用 `local_store.list_sources()` 和 `revision_chunks()`，不调用 `Runtime.components()`；内容库增加只读快照接口。同步以来源 ID 为键，正文摘要相同时保留多个来源，来源故障单独报告，不能将读取失败解释为全库已删除。
- [ ] **Step 4 实现导入原语。** 文件格式限制与大小检查后调用受控解析器，保留行、页和段落位置；切块默认 1600 字符、重叠 160 字符，每个位置可追溯。网页复用现有 URL、DNS 和重定向校验，不使用搜索摘要作为正文；`fetch_page` 增加 `truncated` 布尔元数据，标记是否到达其 512000 bytes 抓取上限，页面显示对应快照范围；空页和登录页返回可读错误。旧内容库片段使用片段位置标识，不能虚构页码。
- [ ] **Step 5 验证通过。** 运行上述测试并追加 `.venv/bin/python -m pytest tests/test_web_page_parsing.py tests/test_knowledge_documents.py -q`。测试包括 20 MiB 边界、中文文本、缺少可选依赖、扫描 PDF、正文尾部、内网重定向和单个失败文件；有效数据保留。
- [ ] **Step 6 提交。** 精确暂存本任务文件；`git commit -m "feat: import and synchronize learning sources"`。

## Task 3 Hermes 调用与持久后台任务

**Files:**
- Create: `learning/hermes.py`, `learning/jobs.py`
- Modify: `learning/store.py` 的任务方法；`server.py` 的 `_HermesSession` 取消收尾
- Test: `tests/learning/test_hermes.py`, `tests/learning/test_jobs.py`

**Interfaces:**
- Produces: `HermesClient(session_factory, get_providers, cli_available, work_dir: Path)`，`available() -> dict`，`request(prompt: str, cancel: Event, progress: Callable, provider_id: str | None = None, model: str | None = None, timeout: float = 900) -> str`。
- Session factory: `factory(send_json: Callable, cwd: str, provider: dict | None, model: str | None)` 返回现有 `_HermesSession`，保留 `start()`、`send_user(text)`、`close(cleanup_only=False)` 接口。
- Produces: `LearningJobs(store, workers: int = 2)`，`register(kind: str, handler: Callable) -> None`、`submit(kind: str, payload: dict, revisions: dict[str,int], dedupe_key: str | None = None) -> dict`、`cancel(job_id: str) -> dict`、`recover() -> None`、`shutdown() -> None`。
- Handler: `handler(payload: dict, context: JobContext) -> dict`；`JobContext` 提供 cancel_event、`progress(phase: str,processed: int,total: int,message: str)`、`ensure_active()`。
- Store: `create_job(kind: str,payload: dict,revisions: dict[str,int],dedupe_key: str | None = None) -> dict`、`get_job(job_id: str) -> dict`、`update_job(job_id: str, **patch) -> dict`、`active_jobs() -> list[dict]`、`transition_job(job_id: str,expected: list[str],patch: dict) -> bool`。任务去重只用于导入和分析，同一问答内容允许用户再次发起。

- [ ] **Step 1 写失败测试。** 用可控会话替身模拟 started、progress、response、done、error 与延迟 done；验证等待最终结果、超时、取消、清理和密钥不入库。任务测试固定以下重启行为：

```python
def test_recover_requeues_only_queued_jobs(jobs, store, blocking_handler):
    jobs.register('analysis', blocking_handler)
    queued = store.create_job('analysis', {}, {}, 'queued-key')
    running = store.create_job('analysis', {}, {}, 'running-key')
    store.update_job(running['id'], status='running')
    jobs.recover()
    assert store.get_job(running['id'])['status'] == 'failed'
    assert '中断' in store.get_job(running['id'])['error']
    assert blocking_handler.started.wait(2)
    assert store.get_job(queued['id'])['status'] == 'running'
    blocking_handler.release.set()
```

- [ ] **Step 2 验证失败。** `.venv/bin/python -m pytest tests/learning/test_hermes.py tests/learning/test_jobs.py -q`，预期未实现接口 FAIL。
- [ ] **Step 3 实现 Hermes 适配器。** 事件通过线程安全队列接收；每任务一个会话；provider 按 ID 从当前配置解析，未指定时使用当前默认配置或 Hermes 原配置。只在 CLI 可用性上判断学习后台能力，不要求 PTY 或前端 WebSocket；超时和取消后停止运行并回收临时配置，避免先删除配置再等待仍在运行的进程。
- [ ] **Step 4 实现任务生命周期。** 有界线程池、持久化 payload 和修订快照、分析去重、真实阶段计数、显式取消及提交前状态复核；所有处理器注册后调用 recover。测试的 blocking_handler 提供 started 和 release 两个 Event，fixture 收尾始终 release，避免竞态断言和挂起。同步写入取消状态与发布成果需共享事务条件，迟到 response 或 done 不得改为 completed。
- [ ] **Step 5 验证通过。** 上述两测试文件全部 PASS，新增取消发生于 Popen 前、错误发生于 response 后、重复取消和并发去重测试；保持现有 Hermes 聊天接口兼容。
- [ ] **Step 6 提交。** 精确暂存本任务文件；`git commit -m "feat: run durable Hermes learning jobs"`。

## Task 4 文档结构分析与跨文档知识图谱

**Files:**
- Create: `learning/analysis.py`, `learning/graph.py`
- Modify: `learning/store.py` 的分析、知识点及关系读写
- Test: `tests/learning/test_analysis.py`, `tests/learning/test_graph.py`

**Interfaces:**
- Consumes: HermesClient.request、JobContext、LearningStore.get_chunks 和 revisions_current。
- Produces: `DocumentAnalyzer(store, hermes).run(payload: dict, context: JobContext) -> dict`；`validate_analysis(value: dict, chunks: list[dict]) -> dict`。
- Produces: `LearningStore.commit_analysis(document_id: str, revision: int, analysis: dict, job_id: str) -> dict`、`get_analysis(document_id: str, revision: int | None = None) -> dict`。
- Produces: `GraphService(store).list_concepts(filters: dict,page: int = 1,page_size: int = 30) -> dict`、`get_concept(concept_id: str) -> dict`、`graph(filters: dict,page: int = 1,page_size: int = 100) -> dict`。
- Graph response: nodes、edges、total_nodes、total_edges、page、page_size、coverage；概念键按领域及规范名称生成，关系证据绑定 analysis 和 document revision。

- [ ] **Step 1 写失败测试。** 固定尾部知识点覆盖、同名异域、引用不存在、重复树 ID、树环、悬空关系、第二批失败与修订竞争；模型资料边界用含「忽略之前指令」的文档测试。

```python
def test_failed_late_batch_keeps_previous_analysis(analyzer, store, context, two_batch_document, hermes):
    before = store.get_analysis(two_batch_document['id'])
    hermes.fail_on_request = 2
    with pytest.raises(LearningError):
        analyzer.run({'document_ids': [two_batch_document['id']]}, context)
    assert store.get_analysis(two_batch_document['id'])['id'] == before['id']
```

- [ ] **Step 2 验证失败。** `.venv/bin/python -m pytest tests/learning/test_analysis.py tests/learning/test_graph.py -q`，要求新功能测试 FAIL。
- [ ] **Step 3 实现全量分批分析。** 每批正文预算默认 12000 字符，使用有编号的片段；提示中明确资料是被分析数据而非指令。要求返回 summary、category、tags、tree、concepts、relations、coverage；各批使用独立 ID 前缀，合并时累积全部已验证知识点和关系，分层归并只压缩结构摘要，不丢弃尾部概念。格式或证据错误最多追加一次修正请求，仍失败则终止。
- [ ] **Step 4 实现原子激活与图谱。** 校验 chunk_id、非空 quote 子串、修订、节点唯一性与树无环、所有关系端点；在一个事务中写入有效分析及概念引用。同一领域同名概念归并，不同领域分离；别名仅在有证据时归并。默认图谱只取当前有效分析，删除来源时按剩余证据保留关系。分类和标签人工修改优先。
- [ ] **Step 5 验证通过。** 重跑两测试文件，断言最后一片段知识点存在、coverage 的 processed 等于 total、删除一份资料后其他证据仍可查询；图谱分页覆盖全部节点、邻接查询和关系列表，不以首屏节点数冒充全量。
- [ ] **Step 6 提交。** 精确暂存本任务文件；`git commit -m "feat: analyze documents and build learning graphs"`。

## Task 5 文档问答与知识点深度探索

**Files:**
- Create: `learning/retrieval.py`, `learning/service.py`
- Modify: `learning/store.py` 的会话、回答和探索记录
- Test: `tests/learning/test_questions.py`, `tests/learning/test_exploration.py`

**Interfaces:**
- Produces: `Retriever(store, semantic_lookup: Callable | None = None).search(question: str, revisions: dict[str,int], limit: int = 12) -> list[dict]`；`validate_citations(citations: list[dict], evidence: list[dict]) -> list[dict]`。
- Produces: `LearningService(store,jobs,hermes,retriever,analyzer,graph,synchronizer,archives=None)`，`ask(question: str, scope: dict, conversation_id: str | None = None, provider_id: str | None = None, model: str | None = None) -> dict`；`explore(concept_id: str, scope: dict | None = None) -> dict`。
- Produces: `answer_job(payload: dict,context: JobContext) -> dict`、`explore_job(payload: dict,context: JobContext) -> dict`，分别注册为 question 和 exploration 处理器。
- Store: `list_conversations(filters: dict,page: int = 1,page_size: int = 30) -> dict`、`get_conversation(conversation_id: str) -> dict`、`save_turn(conversation_id: str | None,question: str,answer: dict,scope: dict,revisions: dict[str,int],job_id: str) -> dict`、`save_exploration(concept_id: str,result: dict,revisions: dict[str,int],job_id: str) -> dict`；每条回答保存 scope、document_revisions、answer、citations 和 extension。

- [ ] **Step 1 写失败测试。** 中文检索、证据不足、单文档与多文档范围、空 selected、未知 ID、越界引用、追问范围冲突、运行中更新文档和拓展说明分离。

```python
def test_selected_scope_never_uses_other_document(retriever, docs):
    hits = retriever.search('保修期', {docs['a']['id']: docs['a']['revision']})
    assert hits
    assert {hit['document_id'] for hit in hits} == {docs['a']['id']}

def test_followup_keeps_original_scope(service, conversation):
    with pytest.raises(LearningError):
        service.ask('继续解释', {'mode': 'all'}, conversation_id=conversation['id'])
```

- [ ] **Step 2 验证失败。** `.venv/bin/python -m pytest tests/learning/test_questions.py tests/learning/test_exploration.py -q`，要求范围与问答测试 FAIL。
- [ ] **Step 3 实现问答。** SQLite FTS 与现有中文关键词分词召回，参数化文档范围过滤；可选语义回调失败时使用文本检索。证据不足直接保存「资料无法回答」结果；有证据时调用 Hermes，结构化返回 answer、citations、extension，校验引用后发布。新会话固定快照范围，追问不得悄悄扩展；过期修订提示新建会话。
- [ ] **Step 4 实现探索。** 按概念的有效来源召回资料，输出 principles、prerequisites、examples、pitfalls、related、questions 和引用；外部通用解释存入 extension。将已有探索和问答记录公开给档案模块，不自动触发额外模型调用。
- [ ] **Step 5 验证通过。** 上述测试全部 PASS；断言取消或删除文档后无 completed 回答，模型返回的伪造 quote 无法作为有效引用。
- [ ] **Step 6 提交。** 精确暂存本任务文件；`git commit -m "feat: answer document questions and explore concepts"`。

## Task 6 整合归档与导出

**Files:**
- Create: `learning/archives.py`
- Modify: `learning/store.py` 的归档持久化
- Test: `tests/learning/test_archives.py`

**Interfaces:**
- Produces: `ArchiveService(store,hermes).run(payload: dict,context: JobContext) -> dict`、`save_note(title: str,text: str,citations: list[dict],revisions: dict[str,int],origin: dict) -> dict`、`list_archives(filters: dict,page: int = 1,page_size: int = 30) -> dict`、`get_archive(archive_id: str) -> dict`、`export(archive_id: str,fmt: str) -> tuple[bytes,str,str]`。
- Archive: id、title、category、document_revisions、documents、concepts、markdown、citations、needs_update、created_at；导出返回 bytes、mime 和 filename。
- Consumes: 已有分析、片段、问答及探索结果；没有分析的文档先提示完成分析，不将空分析写成综合笔记。

- [ ] **Step 1 写失败测试。** 覆盖主题归档、矛盾来源并列、问答和探索保存笔记、重启读取与导出一致性。

```python
def test_archive_becomes_stale_after_revision_update(archives, store, archive, changed_source, chunks):
    store.upsert_document(changed_source, chunks)
    saved = archives.get_archive(archive['id'])
    assert saved['needs_update'] is True
    body, mime, filename = archives.export(archive['id'], 'markdown')
    assert saved['markdown'] in body.decode('utf-8')
    assert mime.startswith('text/markdown') and filename.endswith('.md')
```

- [ ] **Step 2 验证失败。** `.venv/bin/python -m pytest tests/learning/test_archives.py -q`，预期归档接口 FAIL。
- [ ] **Step 3 实现归档。** 对所选分析逐批综合并保留文档目录、概念和原文证据；保存已完成版本及修订集合。`save_note` 直接保存已生成内容，生成新综合才调用 Hermes；导出 JSON 包含该归档对应的节点、关系和证据，Markdown 保留标题、来源及引用。
- [ ] **Step 4 验证通过。** 测试文件全部 PASS；不支持的 fmt 返回 400，文件名来自安全 ID/标题，导出不重跑模型、不混入后来更新的数据。
- [ ] **Step 5 提交。** 精确暂存本任务文件；`git commit -m "feat: archive and export integrated learning notes"`。

## Task 7 HTTP 接口与应用运行时接入

**Files:**
- Create: `learning/api.py`, `learning/runtime.py`
- Modify: `learning/service.py` 的导入与查询门面；`server.py` 的运行时注入与 Blueprint 注册
- Test: `tests/learning/test_api.py`, `tests/learning/test_runtime.py`

**Interfaces:**
- Produces: `LearningRuntime(data_dir: Path,session_factory,get_providers,cli_available,get_local_store,get_content_store,semantic_lookup=None)`、`.components() -> LearningService`、`.close() -> None`。
- Produces: `create_blueprint(get_service: Callable) -> Blueprint`，挂载 `/api/learning`，实现规格中的 24 条接口；补充 `POST /api/learning/archives/notes` 将已有回答或探索记录保存为笔记，请求携带 origin ID，服务端从已存结果读取正文。
- Service adds: `status()`、`sync()`、`upload(files: list[tuple[str,BinaryIO]],options: dict) -> dict`、`import_link(url: str,options: dict) -> dict`、`analyze(scope: dict,options: dict) -> dict`，调用 Task 1–6 的查询及任务接口。
- Upload response: `{items:[{filename,document_id,job_id,error}],accepted,rejected}`；job response 为 `{job:Job}`；单对象查询为 `{document}`、`{analysis}`、`{concept}`、`{conversation}` 或 `{archive}`；列表统一 Page。

- [ ] **Step 1 写失败测试。** API 路由、请求类型和边界、202 创建、状态查询、取消、404、非法分页、notes origin 校验与导出内容类型。必须包含缺少 Hermes 时只读仍可用：

```python
def test_reading_documents_does_not_require_hermes(client_without_hermes):
    assert client_without_hermes.get('/api/learning/documents').status_code == 200
    response = client_without_hermes.post('/api/learning/analyze', json={'scope': {'mode': 'all'}})
    assert response.status_code == 503
    assert 'Hermes' in response.json['error']
```

- [ ] **Step 2 验证失败。** `.venv/bin/python -m pytest tests/learning/test_api.py tests/learning/test_runtime.py -q`，新接口 FAIL。
- [ ] **Step 3 实现运行时。** 惰性初始化学习模块，避免 server 导入 Chroma 或可选解析器；注册全部处理器再恢复 queued 任务。server 注入 `_HermesSession`、`_hermes_cli_path`、`load_state`、`_knowledge_runtime.store`、`_get_knowledge_store`；设置关闭钩子回收 executor。默认 provider 按现有配置解析，学习请求仅传 ID 和模型名。
- [ ] **Step 4 实现请求边界。** 校验 JSON 对象、scope、分页、文本与文件大小；参数化查询。超限文件逐项记录，上传批次前后持久化状态。捕获 `LearningError` 返回 JSON，缺少 Hermes 返回 503，任务查询内部失败用 failed job 表达；已保存资料在 Hermes 不可用时仍能列出、修改和删除。
- [ ] **Step 5 验证通过。** 上述测试全部 PASS，并运行 `.venv/bin/python -m pytest tests/knowledge/test_api.py tests/test_knowledge_api.py tests/test_knowledge_jobs.py -q`，确认旧路由行为不变。
- [ ] **Step 6 提交。** 精确暂存本任务文件；`git commit -m "feat: expose Hermes learning APIs"`。

## Task 8 独立 Tab 与资料导图文档问答

**Files:**
- Create: `src/lib/learningTypes.ts`, `src/lib/learningApi.ts`, `src/hooks/useLearningJobs.ts`
- Create: `src/components/learning/LearningPanel.tsx`, `LearningSidebar.tsx`, `ImportSources.tsx`, `DocumentStudy.tsx`, `MindMap.tsx`, `CitationPanel.tsx`, `DocumentQuestions.tsx`, `GraphViewport.tsx`
- Modify: `src/App.tsx` 的 CenterTab、初始标签、图标、内容容器及新建菜单
- Test: `src/lib/learningApi.test.ts`, `src/hooks/useLearningJobs.test.tsx`, `src/components/learning/LearningPanel.test.tsx`, `MindMap.test.tsx`, `DocumentQuestions.test.tsx`, `src/App.learning.test.tsx`

**Interfaces:**
- Produces: `LearningPanel({active:boolean,onOpenUrl?:(url:string,title?:string)=>void})`；App 固定 Tab ID 为 `knowledge-learning`，kind 为 `learning`，不可重复创建。
- Produces: `learningJson<T>(path:string,body?:unknown,method?:string,signal?:AbortSignal):Promise<T>`、`uploadLearningFiles(files:File[],onResult:(item:UploadResult)=>void):Promise<void>`。
- Produces: `useLearningJobs(active:boolean):{jobs:LearningJob[],watch:(jobId:string)=>void,cancel:(jobId:string)=>Promise<void>,refresh:()=>Promise<void>}`，700 ms 轮询关注任务，终态刷新成果。
- Shared UI contract: `onOpenCitation(citation:LearningCitation)` 打开独立引用面板，不改变当前文档问答范围；SVG 节点的 onSelect 返回 node ID，展开状态由组件保存。

- [ ] **Step 1 写失败测试。** 以 API 替身覆盖常驻 Tab 和菜单激活、已有资料展示、选择文档、待分析入口、导入部分失败、导图展开点击、问答和引用。

```tsx
it('keeps the question scoped to the selected document', async () => {
  render(<LearningPanel active />);
  fireEvent.click(await screen.findByRole('button', {name: '手册 A'}));
  fireEvent.change(screen.getByRole('textbox', {name: '向资料提问'}), {target: {value: '保修期多久？'}});
  fireEvent.click(screen.getByRole('button', {name: '发送问题'}));
  await waitFor(() => expect(questionBody().scope).toEqual({mode: 'selected', document_ids: ['doc-a']}));
});
```

- [ ] **Step 2 验证失败。** `npx vitest run src/lib/learningApi.test.ts src/hooks/useLearningJobs.test.tsx src/components/learning/LearningPanel.test.tsx src/components/learning/MindMap.test.tsx src/components/learning/DocumentQuestions.test.tsx src/App.learning.test.tsx`，预期新模块或行为缺失 FAIL。
- [ ] **Step 3 实现资料与任务工作区。** 按前后端同名类型连接查询和提交，上传按总内容 40 MiB 分批留出 multipart 空间。首次激活和手动刷新同步既有来源；保留当前文档、视图与分页。请求通过 AbortController 或递增请求标识隔离，快速切换文档后旧响应不能覆盖新选中项。关闭轮询仅停止观察，不能调用任务取消接口。
- [ ] **Step 4 实现学习视图。** 原文分页、摘要、分类编辑和结构树；MindMap 用确定性树布局及 SVG，提供收起、展开、缩放、适配与键盘可达节点。问答明确显示当前文档、多文档或全部资料范围，绑定历史会话、追问和停止；引用面板按指定修订显示原文并可打开原网页。
- [ ] **Step 5 验证通过。** 重跑上述测试；增加 Hermes 不可用仍展示旧成果、快速切换 A 到 B、隐藏 Tab 后任务完成再返回、取消后迟到结果等断言。运行 `npx tsc --noEmit`，要求退出 0。
- [ ] **Step 6 提交。** 精确暂存本任务文件；`git commit -m "feat: add document learning workbench tab"`。

## Task 9 全部知识点图谱与归档页面

**Files:**
- Create: `src/components/learning/ConceptExplorer.tsx`, `KnowledgeGraph.tsx`, `ArchiveView.tsx`
- Modify: `src/components/learning/LearningPanel.tsx`, `GraphViewport.tsx`, `src/lib/learningApi.ts`, `src/lib/learningTypes.ts`
- Test: `src/components/learning/ConceptExplorer.test.tsx`, `KnowledgeGraph.test.tsx`, `ArchiveView.test.tsx`

**Interfaces:**
- Produces: `ConceptExplorer({onOpenDocument,onOpenCitation,onSelectConcept,onWatchJob})`，支持名称搜索、分类与文档筛选、分页、知识点详情和深入探索。
- Produces: `KnowledgeGraph({selectedConceptId,onSelectConcept,onOpenDocument,onOpenCitation})`，支持图形和关系列表，使用 API 返回的覆盖计数及分页总数。
- Produces: `ArchiveView({scope,onOpenDocument,onOpenCitation,onWatchJob})`，支持生成归档、查看、下载及过期提示；问答和探索通过 notes 接口保存到归档。

- [ ] **Step 1 写失败测试。** 知识点搜索、跨文档多来源、从知识点定位文档与导图、图谱邻接查询、分页、引用和归档导出。

```tsx
it('shows actual graph coverage and can reach later nodes', async () => {
  render(<KnowledgeGraph {...graphProps} />);
  expect(await screen.findByText('已分析 2 / 3 份资料')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', {name: '下一页关系'}));
  expect(await screen.findByText('末页知识点')).toBeTruthy();
});
```

- [ ] **Step 2 验证失败。** `npx vitest run src/components/learning/ConceptExplorer.test.tsx src/components/learning/KnowledgeGraph.test.tsx src/components/learning/ArchiveView.test.tsx`，预期缺失模块或行为 FAIL。
- [ ] **Step 3 实现知识点与图谱。** 渲染全部有效知识点的分页目录、别名与来源；支持知识点探索任务和历史记录。图谱沿用 GraphViewport 的拖动缩放，按文档/概念节点区分样式，边点击展示证据，提供搜索、邻接展开及完整关系列表；显示全库覆盖量与待分析入口。
- [ ] **Step 4 实现归档页面与联动。** 列表按主题及资料筛选，创建综合任务，展示目录、关键概念、笔记和引用；问答与探索的保存动作引用 origin ID。导出直接下载后端响应，过期归档显示更新时间与重新整理入口。来自图谱和目录的跳转激活正确文档、视图及概念节点。
- [ ] **Step 5 验证通过。** 上述测试全部 PASS；`npx tsc --noEmit` 与 `npm run build` 退出 0。空图谱和待分析状态提供真实操作入口，不注入示例节点。
- [ ] **Step 6 提交。** 精确暂存本任务文件；`git commit -m "feat: browse learning concepts graphs and archives"`。

## Task 10 全流程回归与实际 Hermes 验收

**Files:**
- Create: `tests/learning/test_end_to_end.py`, `docs/hermes-knowledge-learning.md`
- Modify: 仅修复本功能在验证中发现的问题

**Interfaces:**
- Uses: Task 7 Flask Blueprint 与全部服务，Task 8–9 页面。
- Produces: 可重复的自动化验收链路、运行说明、可选解析依赖说明、数据备份位置与真实 Hermes 验证记录。

- [ ] **Step 1 写失败测试。** 新增 `test_learning_flow_survives_restart_and_source_removal`，使用临时目录和可控 Hermes，走 HTTP 完成既有资料同步、两份文档上传、分析轮询、导图/知识点/图谱读取、选中文档提问、追问、探索、归档与导出。断言上传均返回有效 document_id，最终任务状态为 completed，问答引用仅来自所选文档，重建 Runtime 后归档 markdown 一致；更新和删除其中一份后归档 needs_update 为 True，其他来源关系仍能查询。
- [ ] **Step 2 验证测试敏感性。** `.venv/bin/python -m pytest tests/learning/test_end_to_end.py -q`；任意缺失链路必须 FAIL，已有完整链路可以直接 PASS，不为满足红灯而破坏实现。
- [ ] **Step 3 完成针对性修复与文档。** 记录入口、导入格式与 20 MiB 限制、网页快照范围、已有资料读取方式、Hermes 配置沿用方式、取消和重启行为及 `data/learning/` 备份。若本环境 Hermes 可用，运行 `hermes --version` 和最小分析/问答/归档用例；先用临时测试资料，不读取用户原始知识库内容作为验收素材。
- [ ] **Step 4 运行最终检查。** 顺序按依赖执行以下命令，独立检查可以同时运行；每项记录命令、退出码和计数。

```bash
PYTHONPATH=desktop-agent/src .venv/bin/python -m pytest
npm run test:knowledge
npx tsc --noEmit
npm run build
npm run test:web-chat
git diff --check
```

- [ ] **Step 5 核对实际界面。** 浏览器或 Electron 可用时检查 Tab、长列表、导图缩放与节点点击、中文问答引用、知识图谱及导出。现有工具无法打开浏览器时，清楚记录未手动验证的界面项目；真实 Hermes 不可用时，只报告替身验收结果和具体缺失条件。
- [ ] **Step 6 提交并交付。** 对需求逐项核对，按 requesting-code-review 与 verification-before-completion 工作流完成最终检查；仅暂存本功能文件。文档目录被 `.gitignore` 排除，使用精确文件路径 `git add -f docs/hermes-knowledge-learning.md`，不强制添加整个 docs 或运行时目录。提交 `feat: verify Hermes knowledge learning workflow`，报告已实现行为、实际测试结果及剩余环境限制。

## 执行顺序与计划复核

Task 1 → Task 2 → Task 3 → Task 4 → Task 5 → Task 6 → Task 7 → Task 8 → Task 9 → Task 10。Task 5 构造器中的 archives 在 Task 6 完成前允许传 None，调用归档相关方法时才要求该依赖存在；生产运行时必须注入完整实例。测试替身的返回结构必须遵守相邻任务的 Interfaces，不得通过为单个测试返回任意结构绕过真实验证。

规格验收点映射：已有资料与持久化由 Task 1–2、7–8 实现；文件链接由 Task 2、7–8 实现；结构与思维导图由 Task 4、8 实现；全部知识点及深度探索由 Task 4–5、9 实现；跨文档图谱由 Task 4、9 实现；单文档、多文档和全部资料问答由 Task 5、8 实现；整合归档由 Task 6、9 实现；取消、重启和迟到结果由 Task 1、3、8、10 验证。

推荐由当前会话顺序实现，再进行一次整体代码审查。来源、修订、引用和任务事务在多个步骤间共享接口，顺序执行有利于及时验证一致性，避免为每个步骤重复交接上下文。执行方法由用户在计划审阅后选择。
