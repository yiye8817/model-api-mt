# 公开基准与内容库使用

主工作台侧栏的 **内容库** 可直接检索与维护内容，不要求配置 Provider。对话输入区的 **查找已保存内容** 携带当前输入打开检索；助手回答下方的 **来源 / 核验** 打开对应条目的标注。

## 使用

1. 输入问题，查看意图、匹配样例和问答结果。可以筛选已保存对话、公开集、手动条目、来源、标签和事实状态。
2. 点击 **标注来源与事实状态**，填写来源名称、HTTP(S) 链接、标签、备注及“未核验 / 正确 / 存疑 / 错误”。保存后可用于后续检索；重复导入和历史同步不会覆盖标注。原始来源始终保留。
3. 用 **新建条目** 保存自己的问答，或补充项目11类意图中的样例。新内容默认为未核验。
4. 用 **导入公开集** 导入 JSON/JSONL。MASSIVE 必须是 zh-CN；其 train 样例用于判定，dev/test 只用于评测。CMRC 可选训练分区保存问答，或开发/测试分区仅索引原文、保留问题用于评测。错误记录导致整次导入回滚。
5. 在 **基准评测** 运行公开子集评测，查看实际样本量、Accuracy、Macro-F1、Hit@1/5、MRR@5 和未覆盖类别。没有样例时指标显示“无样例”。

匹配分是词项相关度，不是事实正确率。人工核验状态不由模型自动修改，也不参与公开基准打分。切换“已确认正确优先”只会对相关候选按人工状态排序。没有足够意图样例时返回未知；自动选模型可用已配置的意图模型兜底，缺配置、缺密钥或调用失败时保留可用的本地结果。

## 数据来源、授权与修改

- **MASSIVE 1.1 / zh-CN**：原始作者 Amazon Science / Alexa；来源 [官方仓库](https://github.com/alexa/massive)、[论文](https://arxiv.org/abs/2204.08582)、[官方1.1下载](https://amazon-massive-nlu-dataset.s3.amazonaws.com/amazon-massive-dataset-1.1.tar.gz)。许可 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)。本子集按原文件顺序，对每个原始标签保留最多20条train、5条dev、5条test；仅保留 ID、语言、分区、标签和文本，未修改文本。实际1176条train、286条dev、288条test。
- **CMRC2018 开发集**：原始作者 Yiming Cui、Ting Liu、Wanxiang Che、Li Xiao、Zhipeng Chen、Wentao Ma、Shijin Wang、Guoping Hu；来源 [官方仓库](https://github.com/ymcui/cmrc2018)、[论文](https://aclanthology.org/D19-1600/)、[数据集说明](https://ymcui.com/cmrc2018/)。许可 [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)。本子集选取原始开发集前160个段落及其590个问题，保留原始文本、问题和答案；本子集以同一 CC BY-SA 4.0 许可提供。用于本应用的评测是文档检索，问题与短答案不进入索引。

`manifest.json` 记录下载位置、版本、取样规则和上游文件/子集 SHA256。首次使用内容库自动导入已提交的子集，并校验子集文件哈希；正常运行不联网下载数据。`baseline-results.json` 是此公开子集的实际本地结果，不是完整数据集或官方排行榜成绩。

## 导入格式

统一问答记录示例：

```json
[{"id":"qa-1","kind":"qa","question":"如何安装Python？","answer":"使用官方安装包。","source_name":"Python官方文档","source_url":"https://www.python.org/downloads/"}]
```

意图记录示例：

```json
[{"id":"intent-1","kind":"intent","question":"请编写Python程序","intent":"代码编写","split":"train"}]
```

统一意图标签为 yitu.txt 的11类或“未知”。公开数据集的原始标签另存，不将 MASSIVE 覆盖的3个映射类别描述为完整11类评测。相同数据集名称与来源链接、稳定 ID 保证幂等导入；名称/链接变化会被视为另一个数据集。人工标注的来源修改不影响原始导入身份。

## 本地验证与重建

```sh
.venv/bin/python -m unittest discover -s tests -v
npx tsc --noEmit
npm run build
.venv/bin/python scripts/prepare_knowledge_benchmarks.py
```

最后一条命令会重新下载官方数据并重建子集及哈希清单。运行数据位于 git 忽略的 `data/knowledge.sqlite3`，可用 `KNOWLEDGE_DB_PATH` 覆盖数据库路径进行隔离测试。独立 Fusion 窗口的历史目前不自动同步，向量检索和自动事实核验不属于本版本。
