# 本地知识文档导入、进度通知与 Provider 能力设计

## 背景与目标

8766 工作区已有本地知识模块，包含文档解析、分块、向量索引、重排、持久化任务和“本地知识”设置页。本次改动把它完善成可持续使用的文档导入工作流：用户可以在 `http://127.0.0.1:8766/` 导入本地文件或目录，索引在服务后台继续运行，页面显示细粒度进度，服务完成后给出明确通知；向量模型和重排模型可以直接选择已配置的在线 Provider，并在保存前测试实际接口。

成功标准：

- 任务提交后关闭设置或刷新页面，任务仍在服务端运行并可恢复查看。
- 页面能显示阶段、总体进度、当前文件、计数、耗时和逐项错误；服务重启后未完成任务不会丢失。
- 索引成功完成后，页面显示一次完成通知；失败和取消也有对应通知。
- “本地知识”中可从已配置 Provider 和其模型列表选择 embedding、rerank；密钥只由后端读取。
- embedding 与 rerank 均有独立测试按钮，能校验真实响应结构并展示维度或分数信息。
- Provider 配置变化不会静默复用不兼容的旧向量；原有自定义本地端点仍可使用。

## 范围与限制

本次改动限定在 8766 对应的 `local-semantic-qa` 工作区，沿用现有 Flask、React、SQLite 和后台线程队列。不引入 Celery、Redis、浏览器端模型调用或新的必需生产依赖。在线 Provider 的 embedding 和 rerank 调用由服务端发起，遵守现有 Provider 的 Base URL、API 类型、模型和 API Key 配置。

首版按 OpenAI 兼容协议实现 `/v1/embeddings` 和 `/v1/rerank`。不支持这两个协议的 Provider 会在能力测试中明确显示“不支持或响应格式不兼容”，不会被标记为可用。自定义端点继续受现有本地地址安全校验约束；Provider 模式不把远程 URL 当作本地端点校验对象。

## 方案与模块边界

### 后台任务与索引

扩展 `local_knowledge.jobs` 与 `local_knowledge.ingest` 的现有任务记录，不改变任务 ID 和持久化入口。任务快照增加：

- `stage`：queued、scanning、parsing、chunking、embedding、reranking、committing、done、failed、cancelled；
- `current_item`：当前文件相对路径或来源标题；
- `bytes_total`、`bytes_completed`、`items_total`、`items_completed`；
- `chunks_total`、`chunks_completed`、`batches_total`、`batches_completed`；
- `started_at`、`updated_at`、`finished_at`、`last_error`；
- 可排序的 `items` 明细，包含路径、阶段、状态、耗时、分块数和错误。

阶段进度由任务线程在有意义的边界更新，写入同一 SQLite 任务表，避免只存在于进程内存。服务启动时沿用现有恢复逻辑，把 queued/running/waiting 任务恢复为可继续执行的状态；已完成任务保留最终快照供页面查看。任务更新采用短事务，不把模型响应原文或 API Key 写入任务记录。

### Provider 解析与能力客户端

新增一个后端 Provider 解析边界，输入仅允许 `provider_id`、`model` 和能力类型。它从 `/api/providers` 对应的持久化 Provider 读取 Base URL、API 类型、模型和 Key，并构造短生命周期的 embedding/rerank 客户端。返回给前端的 Provider 摘要只包含：id、名称、API 类型、可选模型、配置完整性和最近测试状态；永远不包含 Key。

本地知识 endpoint 配置保留现有字段，并增加可选的：

- `source`: `custom` 或 `provider`；
- `provider_id`: 选定 Provider 的稳定 ID；
- `path`: 可选协议路径，默认 embedding 为 `/v1/embeddings`、rerank 为 `/v1/rerank`。

当 `source=provider` 时 URL 由 Provider 配置解析，界面显示但不允许用隐藏字段覆盖；当 `source=custom` 时保持现有 URL、模型和 allow_lan 行为。Provider 解析失败、模型不存在、HTTP 非 2xx、JSON 形状错误、数量不匹配、维度变化和非有限分数都转成可读的能力测试错误。

embedding 测试发送一个短文本并返回维度、响应条数和模型；rerank 测试发送一个问题和两个候选文档并返回响应条数、最高分和排序是否完整。索引任务使用同一客户端工厂，不允许“测试通过但实际索引走另一套配置”。

### Flask 接口

在现有 `/api/knowledge` 蓝图中增加或扩展：

- `GET /api/knowledge/providers`：返回脱敏 Provider 摘要和 embedding/rerank 可选模型。
- `POST /api/knowledge/probe`：接受 `{role, source, provider_id, model, path}`，只测试 `embedding` 或 `rerank`；返回 `{ok, role, model, dimension?, count?, top_score?, error?}`。
- `GET /api/knowledge/jobs/<id>`：返回完整进度快照和 `notification_key`；旧字段保持兼容。
- `POST /api/knowledge/jobs/<id>/cancel`：保持幂等，返回取消请求状态。

现有导入、上传、刷新、删除和配置校验接口继续使用，错误保持 JSON 格式并返回 4xx。Provider 配置保存仍通过 `/api/settings`，保存前执行结构验证；如果选择的 Provider 被删除或模型不再存在，保存返回 400 并说明需要重新选择。

## 前端交互

### 文档导入

“本地知识”页提供文件、目录、后端路径三种入口，复用现有上传和路径导入。任务提交后立即显示任务卡片，用户可以关闭设置窗口；再次打开时自动加载最近的活动任务和最近完成任务。任务卡片包括：

- 横向阶段时间线；
- 百分比、已完成/总数、当前文件和已处理字节；
- 分块和向量批次计数、速度与预计剩余时间（无法估算时显示处理中）；
- 成功、跳过、失败计数；
- 可展开的逐项结果与错误；
- 停止按钮和完成后的“查看资料”刷新动作。

任务完成、失败、取消各只触发一次通知。页面内使用持久的 toast/状态条；首次需要权限时尝试 `Notification.requestPermission()`，获准后发浏览器通知，拒绝或不可用时不阻塞任务。通知内容包含任务类型、成功/失败数量和错误摘要。

### Provider 选择与测试

“本地知识”设置中，向量模型和重排模型各显示“来源”选择：`已配置 Provider` 或 `自定义本地端点`。Provider 模式下先选 Provider，再选模型；模型列表为空时显示配置提示。每个角色有独立“测试接口”按钮和内联结果区域，测试过程不会自动保存配置；“保存”后索引任务才使用新配置。测试期间禁用该角色的控件，错误保留在对应角色下，避免用户误以为另一个角色也失败。

## 安全、恢复与数据一致性

- API Key 只在服务端 Provider 存储和请求头中使用，不能进入 React 状态回传、任务 payload、日志或错误文本。
- Provider 请求采用现有总超时、响应大小限制、JSON 校验和子进程可终止机制；不把远程 URL 传给本地端点解析器。
- 任务每次提交前校验文件数量、大小、相对路径和敏感文件规则；索引失败时不把未完成批次标记为成功。
- embedding 模型、模型版本、维度或 Provider 变化会生成新的模型指纹。旧向量不会在新指纹下被直接复用，页面显示需要重新索引。
- 同一任务的进度更新和最终状态更新幂等；取消、超时、服务重启不会把任务留在无限运行状态。

## 验证计划

后端测试覆盖：

- 进度字段和阶段在扫描、解析、embedding、提交、完成及失败时单调更新；
- 任务在服务重启后恢复，取消和重复查询幂等；
- Provider 摘要脱敏，embedding/rerank probe 使用正确 URL、请求体和鉴权头；
- malformed JSON、非 2xx、数量/维度/分数异常均被拒绝；
- Provider 配置保存、删除 Provider、模型变更和自定义端点兼容；
- API Key 不出现在任务、响应和日志中。

前端测试覆盖：

- 文档导入显示详细进度并在终态只通知一次；
- 刷新/重新打开页面能恢复活动任务；
- Provider 选择更新模型列表，embedding/rerank 测试成功和失败都显示在对应角色；
- 自定义端点模式与现有配置保持兼容。

验收命令：`.venv/bin/python -m unittest discover -s tests -v`、`npm run test:knowledge`、`npx tsc --noEmit`、`npm run build`、`git diff --check`，并通过实际 8766 服务完成一次小文档导入和两个能力测试。
