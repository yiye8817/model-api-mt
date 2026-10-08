# 本地语义问答验收报告

日期：2026-10-08。代码位于 `feat/local-semantic-qa` 分支。

## 当前结论

程序的确定性行为已通过自动化检查。**实际模型精度验收未完成**：原工作区与实施工作区均没有配置 embedding、rerank、问答三个本地端点。未运行真实模型的独立验证集，也没有激活实际模型评测配置。

不能将测试替身中的分数或答案视为语义精度证明。配置本地服务、导入业务资料、运行独立评测并人工核对引用后，才可验收和激活自动回答。

## 已执行检查

| 检查 | 结果 |
|---|---|
| `PYTHONPATH=desktop-agent/src .venv/bin/python -m pytest` | 165 passed；包含既有 Agent 测试与新增知识功能测试 |
| `PYTHONPATH=desktop-agent/src .venv/bin/python -m unittest discover -s desktop-agent/tests -v` | 13 tests，OK |
| `npm run test:knowledge` | 20 passed；包含真实 App 本地命中、无 provider、新建会话、网页群聊前置检查、原目标兜底、取消、部分流、逐项上传失败和综合失败后的原始回答保存 |
| `npx tsc --noEmit` | 通过 |
| `npm run build` | 通过 |
| `npm run test:web-chat` | `electron_web_chat_dom=passed`；包括明确角色消息、未知历史、发送前/生成中/复制阶段取消和原有复制提取回归 |

新增端到端测试使用真实临时 SQLite/Chroma、文档解析和回环 HTTP 协议替身。它们验证索引提交、同义问法的路由、引用位置、原文件变更后旧答案失效以及条件检查；不证明实际模型能理解所有这些输入。

实际解析的依赖版本：Python 3.12.3、Flask 3.1.3、requests 2.34.2、Chroma 1.5.9、pypdf 6.19.0、python-docx 1.2.0、pytest 9.1.1；Node 22.23.1、React 19.2.3、Electron 37.10.3、Vitest 5.0.3、jsdom 30.1.2。三个实际模型的服务版本、权重指纹、向量维度及阈值未取得。

## 独立代码复核与修正

对整个分支进行了独立复核，以下八项重要问题均通过先失败、后通过的回归测试修正；修正后执行上述完整检查。没有遗留的轻微复核项。

任务提交、修正测试和实施决定的完整记录见 [执行记录](superpowers/reports/2026-10-08-local-semantic-qa-execution.md)。

| 问题 | 修正及回归覆盖 |
|---|---|
| 所选文件不存在时扫描其父目录 | 逐项报告选定路径不可用；`test_missing_selected_file_does_not_scan_its_parent` |
| 网页问答或综合的依据变更仍保留有效旧来源 | 问题、回答、候选、完成状态或必要上下文变化时撤销来源与缓存；`test_web_synthesis_provenance_change_invalidates_source` |
| 重复 request ID 直接返回已保存命中 | 复核总开关、评测与模型指纹、有效范围、来源修订及文件新鲜度；`test_repeated_request_id_revalidates_disabled_evidence` |
| 设置替换服务后取消找不到原请求 | 同一 Runtime 内共享请求取消登记，最终提交前再检查取消状态；`test_settings_replacement_preserves_request_cancellation` |
| 历史来源上下文没有参与模型校验 | 保留网页先前消息、有效约束和完成性，在匹配、生成、验证时提供来源背景；`test_matching_receives_original_source_context_and_constraints`、`test_visible_web_import_preserves_previous_context_and_revisions` |
| 一个不合格上传文件中断整批导入 | 有效文件继续处理，路径不合法、敏感名及超限逐项报告；批次重试保持幂等；`test_upload_records_bad_items_and_imports_good_ones`、`test_retried_upload_batch_is_idempotent_with_rejected_items`及前端上传测试 |
| 无条件拒绝以历史问答回答事实问题 | 完整历史来源经过适用性、条件及引用支持核验后可使用，并保留历史回答性质；`test_eligible_historical_answer_is_checked_and_labeled` |
| 更新嵌套文件时丢失原目录身份 | 使用原 root 与显式文件列表，更新原来源修订；`test_refresh_nested_file_preserves_original_source_identity` |

另外补齐网页实际发送计数和综合失败后的完整原始候选收集。`test_web_send_counts_do_not_require_a_completed_answer` 验证计数独立于完整回答且幂等；真实 App 回归验证已发送事件会计数、完整候选能在综合失败时单独记录。

## 实施决定及复核范围

1. 在隔离 worktree 的 `feat/local-semantic-qa` 分支实施，使用本机 Git exclude 隐藏工作目录，保护主工作区已有改动。代价：交付需要保留额外工作目录，合并需单独选择。
2. 增加只读 `POST /api/knowledge/preview`，实现未校准配置的检索预览。代价：新增接口及界面控制需维护。
3. 实际模型精度不以替身测试判定，自动回答配置保持未激活。代价：配置模型并完成独立评测前只能预览或在线兜底。
4. 已登录网站的实时 DOM 适配不以本地页面夹具替代验收。代价：网页功能仍需登录后实机验证，站点变化可能要求适配更新。
5. 主工作区原有 `electron/web-project.cjs` 改动保持原样，未纳入本次复核。代价：未来合并后要结合该改动再次检查相关运行流程。

## 评测资料与待完成事项

附带 calibration / validation 各 30 条合成样例，每组 15 正例，六类各 5 题，事实家族隔离。样例及标签见 `tests/fixtures/local_knowledge/`。实际业务精度需加入人工标注的领域样例和新的独立验证集。

- [ ] 配置三个实际本地端点、权重修订及实际服务版本。
- [ ] 执行真实模型校准与独立验证，保存数据集哈希、评分变换和冻结阈值。
- [ ] 人工逐题核对答案及引用支持，报告分项准确性和正例正确命中率。
- [ ] 验证集错误本地命中为 0，正例正确命中率至少 60%。
- [ ] 核对已登录真实站点的当前 DOM 适配、可见历史范围和停止按钮行为。

自动化测试中本地命中时在线自动选模型、API、网页发送和综合的调用为零；真实模型/真实网站组合仍需要上述实机检查。
