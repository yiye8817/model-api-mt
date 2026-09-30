"""Explicit console gates for recording skills; captured text is never dispatched."""

import re

from .contracts import ToolError
from .skills import SkillLibrary


RESERVED_COMMANDS = frozenset({
    "help", "models", "model", "workspace", "config", "allow", "deny", "response-mode", "retry", "status", "doctor", "tools", "skills",
    "skill", "skill-demo", "verbose", "v", "history", "sessions", "session", "logs", "pack", "quit", "new", "context",
})
RECORDING_HELP = """## Skill 录制

现在输入的内容会按顺序保存为技能步骤，不执行工具或系统命令。

- `/skill finish` 或单独输入“结束创建skill”：生成草稿和名称建议。
- `/skill preview`：查看已录入的内容。
- `/skill cancel`：取消本次创建，保留草稿记录。
- `/quit`：退出并保留未发布的草稿记录。

其它输入（包括 `/model`、`/retry` 等文字）均作为步骤记录。
"""
REVIEW_HELP = """草稿尚未发布，也没有执行其中的步骤。
使用 `/skill confirm 名称` 确认创建，或 `/skill name 新名称` 修改建议名称。
`/skill preview` 查看草稿；`/skill cancel` 取消。
"""


def validate_command_name(name):
    if not SkillLibrary._valid_name(name):
        raise ToolError("invalid_skill_name", "名称须为最多 64 个字符的小写字母、数字及分隔短横线。")
    if name in RESERVED_COMMANDS:
        raise ToolError("reserved_skill_name", "该名称是已有交互命令，请选择其它 Skill 名称。")
    return name


class SkillCaptureConsole:
    def __init__(self, settings, args, *, display, event, refresh, secrets=()):
        from .skill_recording import SkillRecording
        self.settings, self.args = settings, args
        self.display, self.event, self.refresh = display, event, refresh
        self.recorder = SkillRecording(settings.skills_dir, settings.runtime_dir, secrets=secrets)

    @property
    def active(self):
        return self.recorder.phase != "idle"

    def prompt(self):
        if self.recorder.phase == "recording":
            return f"skill[录制 {len(self.recorder.draft['steps'])} 步]> "
        if self.recorder.phase == "review":
            return "skill[待确认]> "
        return None

    def exit_notice(self):
        if self.active:
            self.display("未发布的 Skill 草稿已保留；录制内容未执行。")
            if getattr(self.args, "verbose", False):
                self.display({"draft_path": str(self.recorder.draft_path)})

    def _emit(self, name, **fields):
        self.event(name, {"status": self.recorder.phase, "payload": fields})

    def _preview(self):
        report = self.recorder.preview()
        if report.get("markdown"):
            self.display(report["markdown"])
        else:
            self.display("## Skill 录制预览")
            if report.get("topic"):
                self.display(report["topic"])
            for index, step in enumerate(report.get("steps", []), 1):
                self.display(f"### 步骤 {index}")
                self.display(step)
            if not report.get("steps"):
                self.display("尚未录入步骤。")
        if self.recorder.phase == "review":
            name = self.recorder.draft.get("proposed_name", self.recorder.draft.get("name", ""))
            self.display(f"建议命令：`/{name}`\n\n确认创建：`/skill confirm {name}`\n\n" + REVIEW_HELP)
        if getattr(self.args, "verbose", False):
            self.display({"draft_path": str(self.recorder.draft_path)})

    def _finish(self):
        # Persist the original ordered steps before starting any external request.
        self.recorder.finish()
        self._emit("skill.recording_finished", draft=self.recorder.draft)
        from .skill_naming import propose_skill
        try:
            proposal = propose_skill(self.settings, self.args, self.recorder.draft)
            if proposal:
                validate_command_name(proposal.get("name"))
                self.recorder.suggest(proposal)
        except KeyboardInterrupt:
            self.display("已取消名称建议，录制草稿仍在；可修改名称后确认。")
        except Exception as exc:
            self._emit("skill.naming_failed", error_type=type(exc).__name__)
            self.display("名称建议未应用，录制草稿仍在；可修改名称后确认。")
        self._preview()

    def handle(self, line):
        """Return True iff consumed. Only literal commands change capture state."""
        # A quoted mention or a multi-line block containing a command never
        # crosses a gate. Chinese aliases must occupy the whole input.
        aliases = {
            "创建skill": "create", "结束创建skill": "finish",
            "确认创建skill": "confirm", "取消创建skill": "cancel",
        }
        single_line = "\n" not in line and "\r" not in line
        command_text = line.strip() if single_line else line
        folded = re.sub(r"[ \t]+", "", command_text).casefold()
        action, remainder = aliases.get(folded), ""
        if action is None and single_line:
            match = re.fullmatch(r"/skill[ \t]+(create|finish|confirm|name|preview|cancel)(?:[ \t]+(.*))?", command_text)
            if match:
                action, remainder = match.group(1), match.group(2) or ""
        if action is None:
            if not self.active:
                return False
            if command_text == "/quit":
                self.exit_notice()
                return False
            if self.recorder.phase == "recording":
                self.recorder.append(line)
                self._emit("skill.step_recorded", step_count=len(self.recorder.draft["steps"]),
                           step=self.recorder.draft["steps"][-1])
                self.display(f"已记录第 {len(self.recorder.draft['steps'])} 步；继续输入，或输入“结束创建skill”。")
            else:
                self.display(REVIEW_HELP)
            return True
        if action == "create":
            self.recorder.start(remainder)
            self._emit("skill.recording_started", draft=self.recorder.draft)
            self.display(RECORDING_HELP)
            return True
        if not self.active:
            raise ToolError("skill_recording_inactive", "尚未开始创建 Skill；使用 /skill create 或“创建skill”。")
        if action in ("name", "confirm") and self.recorder.phase != "review":
            raise ToolError("skill_review_required", "请先输入“结束创建skill”，查看草稿后再确认名称。")
        if action in ("finish", "preview", "cancel") and remainder:
            raise ValueError(f"用法：/skill {action}")
        if action == "finish":
            self._finish()
        elif action == "preview":
            self._preview()
        elif action == "cancel":
            report = self.recorder.cancel()
            self._emit("skill.recording_cancelled", result=report)
            self.display("已取消 Skill 创建，草稿记录保留；现在恢复普通任务输入。")
        elif action == "name":
            self.recorder.rename(validate_command_name(remainder))
            self._emit("skill.recording_renamed", draft=self.recorder.draft)
            self._preview()
        elif action == "confirm":
            # Even a valid name cannot confirm while still recording. The core
            # validates this phase again before any publication.
            name = remainder or self.recorder.draft.get("proposed_name", self.recorder.draft.get("name", ""))
            validate_command_name(name)
            report = self.recorder.confirm(name)
            self._emit("skill.recording_published", result=report)
            self.refresh()
            self.display(f"已创建 Skill：**{report['name']}**。录制步骤尚未执行。\n\n"
                         f"运行：`/{report['name']}` 或 `/skill run {report['name']} 任务描述`\n\n"
                         f"静态检查：`/skill test {report['name']}`；加载：`/skill load {report['name']}`。")
            if report.get("warning"):
                self.display(report["warning"])
            if getattr(self.args, "verbose", False):
                self.display({"path": report["path"], "draft_path": str(self.recorder.draft_path)})
        return True
