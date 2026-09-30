"""Small human-facing progress summaries, separate from the complete audit log."""

import shlex
import sys
import unicodedata

from .audit import redact_content
from .rendering import safe_terminal_text


def _brief(value, limit=180):
    text = " ".join(safe_terminal_text(str(value)).split())
    return text if len(text) <= limit else text[:limit - 1] + "…"


def _literal(value):
    """Show hidden controls in approval targets instead of silently deleting them."""
    text = str(value)
    return "".join((f"\\u{ord(char):04x}" if unicodedata.category(char) in ("Cc", "Cf")
                    and char not in "\n\t" else char) for char in text)


def authorization_details(arguments, secrets=()):
    """Readable arguments; command, path and URL targets are never shortened."""
    clean = redact_content(arguments, secrets)
    lines = []

    def append(label, value, indent=0):
        prefix = " " * indent + _literal(label) + "："
        if label == "argv" and isinstance(value, list) and all(isinstance(item, str) for item in value):
            lines.append(prefix + _literal(shlex.join(value)))
        elif isinstance(value, dict):
            lines.append(prefix)
            for key, item in value.items():
                append(str(key), item, indent + 2)
        elif isinstance(value, list):
            lines.append(prefix)
            for index, item in enumerate(value, 1):
                append(str(index), item, indent + 2)
        elif label in ("content", "data") and isinstance(value, str) and len(value) > 1000:
            # File bodies are not execution targets. Indicate the exact omitted
            # length while keeping destination paths and commands complete.
            shown = _literal(value[:1000]).replace("\n", "\n" + " " * (indent + 2))
            lines.append(prefix + shown + f"\n{' ' * (indent + 2)}…（内容共 {len(value)} 字符，仅预览前 1000 字符）")
        else:
            shown = _literal(value).replace("\n", "\n" + " " * (indent + 2))
            lines.append(prefix + shown)

    for key, value in clean.items():
        append(str(key), value)
    return "\n".join(lines)


class TerminalProgress:
    """Render one concise line per user-relevant transition, never raw payloads."""

    def __init__(self, stream=None, secrets=(), verbose=False):
        self.stream = stream if stream is not None else sys.stderr
        self.secrets = tuple(secrets)
        self.verbose = bool(verbose)
        self.model = "模型"
        self._last_line = None
        self._shown_actions = set()
        self._shown_results = set()
        self._web_stages = {}
        self._search_mode = None

    def write(self, line):
        line = safe_terminal_text(str(line))
        if line == self._last_line:
            return
        self._last_line = line
        try:
            self.stream.write(line + "\n")
            self.stream.flush()
        except (OSError, ValueError):
            pass

    def __call__(self, name, fields):
        fields = fields or {}
        payload = fields.get("payload")
        payload = payload if isinstance(payload, dict) else {}

        def brief(value, limit=180):
            return _brief(redact_content(value, self.secrets), limit)

        if name == "agent.started":
            self.model = brief(fields.get("model") or "模型", 60)
        elif name == "run.started":
            self.write(f"任务开始 · {self.model} · 最多 {fields.get('max_steps', '—')} 个工具步骤")
        elif name == "run.continued":
            self.write("已恢复当前会话上下文，继续处理尚未完成的步骤。")
        elif name == "model.request":
            self._web_stages.clear()
            self.write(f"等待 {self.model} 响应…")
        elif name == "model.web_progress":
            stage = fields.get("stage")
            provider = brief(fields.get("provider") or self.model, 60)
            key = (fields.get("progress_id") or fields.get("request_id"), provider)
            state = (stage, fields.get("http_status"), fields.get("wait_ms"))
            if self._web_stages.get(key) == state:
                return
            self._web_stages[key] = state
            labels = {"queued": "请求已排队", "preparing": "正在准备网页",
                      "rate_limited": "访问过快，正在限速等待",
                      "send_dispatched": "已投递发送动作，等待网页接收",
                      "accepted": "网页已接收请求", "server_responded": "生成服务器已返回",
                      "waiting_response": "正在等待或接收网页响应",
                      "retrying": "网页响应异常，正在点击本轮的重试按钮",
                      "manual_retry_required": "请在此模型网页检查并点击重试；当前请求会继续等待并采集回答",
                      "recovering": "正在恢复并采集本轮网页回答",
                      "verification_required": "等待 GLM 人工验证，请在父应用打开原网页处理；不会绕过或重复发送",
                      "verification_cleared": "验证码界面已解除，继续核验原请求",
                      "candidates_started": "正在收集所有候选模型的回答",
                      "candidate_saved": "候选回答完整，原文已保存",
                      "candidate_failed": "候选回答失败", "candidate_timed_out": "候选回答超时",
                      "candidate_cancelled": "候选任务已取消",
                      "fusion_started": "候选任务均已结束，开始整合", "fusion_completed": "整合已完成",
                      "generating": "正在生成回答", "collecting": "正在等待完整回答并采集",
                      "provider_completed": "网页回答已采集", "provider_failed": "网页响应失败",
                      "completed": "响应已返回，正在解析", "failed": "请求失败", "cancelled": "请求已取消"}
            if stage in labels:
                status = fields.get("http_status")
                suffix = f"（HTTP {status}）" if stage == "server_responded" and isinstance(status, int) else ""
                if stage == "rate_limited" and isinstance(fields.get("wait_ms"), (int, float)):
                    suffix = f"（{fields['wait_ms'] / 1000:.1f} 秒）"
                self.write(f"{provider} · {labels[stage]}{suffix}")
        elif name == "model.fusion_server_listening":
            seconds = fields.get("timeout_seconds")
            suffix = f"（最多继续 {seconds} 秒）" if isinstance(seconds, int) else ""
            self.write("MultiLLM Fusion 返回 502 · 请到 Fusion 窗口处理当前网页操作，正在监听服务器结果" + suffix)
        elif name == "model.http_error" and fields.get("status") == 502:
            self.write("MultiLLM Fusion 返回 502 · 请到 Fusion 窗口处理当前网页操作；不会重复发送，正在监听服务器结果")
        elif name == "tool.alias_resolved":
            original = brief(fields.get("original_tool") or payload.get("original_tool") or "工具名", 80)
            resolved = brief(fields.get("tool") or fields.get("resolved_tool") or payload.get("resolved_tool") or "可用工具", 80)
            self.write(f"工具名称已匹配：{original} → {resolved}")
        elif name == "tool.alternatives_found":
            self.write("已找到同功能的可用工具或命令，正在校验替代方案。")
        elif name == "tool.local_selected":
            self.write("本地工具 · 使用已安装命令")
        elif name == "tool.local_missing":
            self.write("本地命令不存在且尚未执行 · 改用 Python 实现")
        elif name == "tool.python_prepared":
            self.write("Python 工具已保存 · 使用当前 Agent 解释器执行")
            if self.verbose:
                self.write("  脚本：" + brief(fields.get("path", ""), 400))
        elif name == "web.fetch_started":
            self.write("本地网页读取 · 多地址/退避 HTTP 正在获取实际页面")
        elif name == "web.fetch_retry":
            reason = brief(fields.get("reason", "暂时失败"), 40)
            attempt = fields.get("attempt")
            suffix = f"（第 {attempt} 次）" if isinstance(attempt, int) else ""
            self.write(f"本地网页读取 · {reason}，正在调整连接重试{suffix}")
        elif name == "web.fetch_completed":
            self.write("页面已获取 · 读取内容及来源链接")
        elif name == "web.search_started":
            self._search_mode = fields.get("method") if fields.get("method") in ("sequential", "parallel") else "sequential"
            label = "多路并行" if self._search_mode == "parallel" else "顺序降级"
            self.write(f"正在搜索实时网页信息（{label}）…")
        elif name == "web.search_backend":
            providers = {"ddgo": "DDG", "browser_use": "Browser Use",
                         "opencli": "OpenCLI", "playwright": "Playwright"}
            provider = providers.get(fields.get("provider"), "备用搜索后端")
            status = fields.get("status")
            labels = {"ok": "已返回结果", "empty": "未找到有效结果",
                      "unavailable": "当前不可用", "timeout": "响应超时", "failed": "搜索失败"}
            label = labels.get(status, "已结束")
            if self._search_mode == "sequential" and status in ("empty", "unavailable", "timeout", "failed"):
                label += "，尝试下一路"
            self.write(f"  网页搜索 · {provider} · {label}")
        elif name == "web.search_completed":
            count = fields.get("result_count")
            suffix = f" · 已整理 {count} 条结果" if isinstance(count, int) and not isinstance(count, bool) else ""
            self.write("网页搜索完成" + suffix)
            self._search_mode = None
        elif name == "web.search_failed":
            self.write("网页搜索结束 · 未获得可用结果")
            self._search_mode = None
        elif name == "tool.attempt":
            action_id = fields.get("action_id")
            if action_id is not None and action_id in self._shown_actions:
                return
            if action_id is not None:
                self._shown_actions.add(action_id)
            summary = brief(payload.get("summary") or fields.get("tool") or "执行工具")
            self.write(f"第 {fields.get('step', '—')} 步 · {summary} [{brief(fields.get('tool', ''), 80)}]")
        elif name == "tool.result":
            action_id = fields.get("action_id")
            if action_id is not None and action_id in self._shown_results:
                return
            if action_id is not None:
                self._shown_results.add(action_id)
            result = payload.get("result")
            result = result if isinstance(result, dict) else {}
            verification = result.get("verification") or {}
            verification = verification if isinstance(verification, dict) else {}
            execution = result.get("execution") or {}
            execution = execution if isinstance(execution, dict) else {}
            if result.get("outcome_unknown"):
                label = "执行结果不确定，需核验"
            elif not fields.get("ok", result.get("ok", False)):
                label = "未执行" if execution.get("status") == "not_started" else "失败"
            elif result.get("pending_verification"):
                label = "当前检查已完成，原操作仍待核验"
            elif verification.get("status") == "pending":
                label = "操作已触发，等待核验"
            elif verification.get("status") == "verified":
                label = "成功，已核验"
            else:
                label = "成功"
            error = result.get("error") or {}
            error = error if isinstance(error, dict) else {}
            detail = brief(error.get("message") or error.get("code") or "")
            self.write("  " + label + (f"：{detail}" if detail else ""))
        elif name in ("model.json_repair_started",):
            stage = payload.get("stage")
            label = {"local": "本地修复", "json_repair": "开源 json_repair", "model": "大模型兜底"}.get(stage, "JSON 修复")
            self.write("正在进行 JSON 修复（" + label + "）…")
        elif name in ("model.json_repair_failed",):
            self.write("JSON 修复阶段失败，查看日志后继续下一级兜底。")
        elif name in ("model.json_repair_succeeded",):
            self.write("JSON 修复候选已生成，继续校验动作。")
        elif name in ("model.protocol_normalized", "model.protocol_repaired"):
            self.write("已修正 JSON 格式，继续校验动作。")
        elif name == "model.invalid_protocol":
            self.write("模型回复格式需要修正，正在处理。")
        elif name in ("model.repair_requested", "model.action_replan_requested"):
            if payload.get("request", {}).get("type") == "tool_resolution":
                self.write("正在选择可用本地工具，或生成获授权的 Python 实现…")
            else:
                self.write(f"正在请求模型修正动作参数（第 {fields.get('repair_count', 1)} 次）…")
        elif name == "verification.required":
            self.write("上一步尚未核验，正在要求模型检查实际结果。")
        elif name == "run.recovery_requested":
            self.write(f"仍有网页未读取成功，正在请求模型处理（第 {fields.get('repair_count', 1)}/2 次）；阶段性总结已保存。")
        elif name == "verification.insufficient":
            self.write("当前核验不足，仍需检查操作目标。")
        elif name == "environment.command.started":
            labels = {"ensurepip": "准备 pip", "pip_install": "安装 Playwright", "install_playwright": "安装 Playwright",
                      "browser_install": "安装 Chromium", "install_chromium": "安装 Chromium"}
            stage = fields.get("step", "依赖安装")
            self.write("  依赖准备 · " + labels.get(stage, brief(stage, 80)) + "…")
        elif name in ("environment.command.completed", "environment.command.failed"):
            self.write("  依赖阶段" + ("完成" if name.endswith(".completed") else "失败，请查看本轮日志"))
        elif name == "agent.finished":
            labels = {"completed": "任务完成", "failed": "任务未完成", "stopped": "任务已停止"}
            label = labels.get(fields.get("status"), "任务结束")
            self.write(f"{label} · 已执行 {fields.get('steps', 0)} 个工具步骤")
