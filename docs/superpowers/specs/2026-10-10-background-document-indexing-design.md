# 后台本地文档索引与在线模型能力设计

## 目标

内容库支持本地文档后台导入和索引。用户提交后请求立即返回任务 ID，界面持续展示解析、切块、向量化、写入等阶段的进度；索引完成时显示页面通知，并在浏览器允许时发送系统通知。用户可以从现有 provider 中选择 embedding 与 rerank 模型，未选择或能力不可用时继续使用本地 FTS 检索。

## 范围与兼容性

- 保留现有 `POST /api/knowledge/import` 同步接口，已有公开数据集导入和调用方行为不变。
- 新增后台导入接口，首版支持现有 `records`、`massive`、`cmrc` 格式，以及 `text` 和 `markdown` 文本文档。浏览器上传的文件以 multipart 发送，文本粘贴继续可用。
- PDF/DOCX 作为可选解析能力：运行环境安装对应解析包时启用；缺少依赖或格式不支持时，任务失败并返回可读错误，不影响已有 JSON/JSONL 导入。
- 后台任务状态写入同一知识库 SQLite，服务重启后可查询已完成/失败任务；运行中的任务在重启后标为失败并说明服务中断。
- provider 复用现有 `providers.json`，不复制或新增 API key 存储。

## 任务与数据流

1. 前端选择文件、格式、数据集名称、可选 provider、embedding 模型和 rerank 模型，调用 `POST /api/knowledge/import/jobs`。
2. 后端校验文件大小、格式、名称和 provider/model 引用，创建任务记录并返回 `{job_id, status}`；实际文件内容存入任务工作目录，避免把大文档放入请求响应或单条 SQLite 字段。
3. 后台 worker 按阶段执行：`reading` 读取/解析、`chunking` 切块、`embedding` 调用 provider（如选择）、`indexing` 写入 entries/FTS/向量、`completed` 完成。每个阶段更新计数、百分比、开始/结束时间、最近消息和错误。rerank 模型不参与写入索引，而是在检索时对候选结果重排；任务只保存并校验该选择。
4. 前端每 700ms 轮询 `GET /api/knowledge/import/jobs/<job_id>`；任务完成、失败或取消时停止轮询并刷新内容库状态。轮询比长连接更适合当前 Flask + Electron/浏览器双运行方式；接口保留事件序列字段，未来可换 SSE。
5. 已索引内容保留原有 FTS 字段。向量存入 `entry_embeddings`（entry、provider、model、维度、JSON 向量、更新时间）；搜索可选使用 embedding 召回并以 rerank 结果排序，向量服务失败时返回 FTS 结果并在响应中说明降级。

## API

### 创建后台任务

`POST /api/knowledge/import/jobs`

请求 JSON 或 multipart 字段：

- `content`（文本导入时）或 `file`（本地文件上传）
- `format`: `records | massive | cmrc | text | markdown`
- `name`、`source_url`、`partition`
- `provider_id`（可空）、`embedding_model`（可空）、`rerank_model`（可空）
- `chunk_size`（默认 800，范围 200–4000）、`chunk_overlap`（默认 120，必须小于 chunk_size）

返回 `202`：`{job_id, status: "queued", name}`。

### 查询任务

`GET /api/knowledge/import/jobs/<job_id>` 返回：

```json
{
  "id": "...",
  "status": "queued|running|completed|failed|cancelled",
  "phase": "reading|chunking|embedding|indexing|completed|failed",
  "processed": 120,
  "total": 300,
  "percent": 40,
  "imported": 0,
  "updated": 0,
  "evaluations": 0,
  "embedding": {"provider_id": "...", "model": "...", "processed": 80, "failed": 0},
  "rerank": {"provider_id": "...", "model": "...", "enabled": true},
  "message": "正在生成向量…",
  "error": null,
  "created_at": "...",
  "started_at": "...",
  "finished_at": "..."
}
```

### 取消任务

`POST /api/knowledge/import/jobs/<job_id>/cancel` 设置取消标记。worker 在解析、批处理和写入边界检查标记，已提交的事务保持一致。

### provider 能力

`GET /api/knowledge/providers/capabilities` 返回当前 provider 的可选模型，并标记 embedding/rerank 可用性。首版允许用户显式选择模型；OpenAI 兼容 provider 使用 `/embeddings`，rerank 使用 `/rerank`，请求和响应字段兼容常见 OpenAI/Cohere 形式。Anthropic provider 不能直接用于 embedding/rerank，界面禁用对应选择。

知识搜索请求可附带 `provider_id`、`embedding_model` 和 `rerank_model`；缺省时沿用最近一次任务保存的索引配置。启用 rerank 时先用本地 FTS/向量召回候选，再把候选文本和查询发送给 `/rerank`，按返回分数排序；服务不可用时保留召回顺序并返回 `retrieval.degraded` 及原因。

## 存储与一致性

- `import_jobs` 保存任务元数据、JSON 配置（包括后续检索使用的 rerank 选择）、进度和错误。
- `import_job_files` 保存工作文件路径和清理状态；任务完成或失败后删除临时文件。
- `entry_embeddings` 以 `(entry_id, provider_id, model)` 唯一，重复导入复用同一内容摘要并更新索引。
- 每个文档批次在单个 SQLite 事务中提交 entries、FTS 和 embedding；取消/失败不会留下半条 entry。
- worker 使用有限线程池（默认 2）和每任务锁；应用退出时标记运行中任务失败。

## 前端体验

- 导入页增加文件名、格式、模型能力配置和分块参数表单。
- 提交后显示任务卡片：当前阶段、进度条、`processed/total`、embedding/rerank 状态、最近消息、耗时和错误；允许取消。
- 任务完成提示“文档索引完成”，显示导入/更新/向量数；调用 `Notification` 前检查权限，拒绝时仅显示页面提示。
- 内容库刷新后保留原有全文搜索、标注和评测能力。搜索结果增加检索方式/降级提示，不改变现有结果结构的必需字段。

## 错误处理

- 请求校验错误返回 400；不存在任务返回 404；任务内部错误保存在任务记录并以 `failed` 返回，避免轮询只能看到通用 500。
- provider 超时、鉴权错误或响应格式错误记录错误摘要；已生成的 FTS 索引可以完成本地检索，任务是否成功取决于用户是否选择了该能力（选择后向量阶段失败则任务失败并可重试）。
- 同一任务只允许一个 worker；重复取消、重复查询均幂等。

## 验证

- Python 单测覆盖任务创建/状态迁移、取消、重启恢复、文本切块、embedding 请求解析、rerank 请求解析/降级和 FTS 降级。
- Flask API 测试覆盖 202 创建、轮询返回、失败/取消响应、provider 能力筛选及原同步接口回归。
- React 构建检查类型和导入表单；手工验证浏览器通知权限拒绝与 Electron 环境。
