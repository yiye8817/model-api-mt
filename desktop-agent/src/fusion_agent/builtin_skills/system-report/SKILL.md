---
name: system-report
description: "当用户要求本机基础环境信息、Python 运行时或工作目录磁盘空间的 Markdown 报告时使用；不适用于进程排障、日志审计或浏览器登录数据分析。"
---

# 基础环境报告

1. 确认用户指定的工作目录与报告文件名；没有指定时使用 Agent 当前 workspace，文件名使用 `reports/system-report-<时间戳>.md`。
2. 使用预加载信息或 `skills.read` 返回的 `base_path` 定位 `scripts/report.py`。脚本位于技能目录，可能在 workspace 外；不要用限制在 workspace 内的 `files.read` 读取外部脚本。技能加载本身不会执行脚本。
3. 通过已允许的命令工具显式执行脚本。脚本只用 Python 标准库，接收 `--workspace <工作目录>` 和 `--output <工作区内相对路径>`。绝对脚本路径来自 `base_path`，不要猜路径。
4. 检查命令退出码。成功后用 `files.read` 阅读生成的 Markdown，向用户给出报告位置和操作系统、Python 版本、可用磁盘空间摘要。

脚本不会读取环境变量全集、账号文件、浏览器配置、网络接口或进程列表，也不会联网。输出必须处于指定工作区内；拒绝覆盖已有文件和穿过符号链接的输出目录。需要覆盖时先由用户明确指定处理方式，不擅自删除旧报告。

命令示例（在 `desktop-agent` 目录执行，替换时间戳）：

```bash
python3 skills/system-report/scripts/report.py --workspace . --output reports/system-report-20260908-173000.md
```

工具返回拒绝执行或权限不足时，保留错误并说明当前限制。技能文字不授予 shell、文件写入或其他额外能力。
