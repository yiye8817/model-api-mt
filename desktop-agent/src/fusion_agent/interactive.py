"""Interactive task shell; slash commands never become operating-system commands."""

from copy import copy, deepcopy
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import shlex
import subprocess
import sys
from uuid import uuid4

from .audit import Audit
from .config import ROOT, api_key, settings_dict, setting_value, save_settings, update_settings
from .contracts import ToolError
from .rendering import render_markdown, safe_terminal_text


HELP = """## 交互命令

直接输入自然语言任务后回车。后续提示继承当前会话的对话与工具结果；临时授权不会跨轮继承。

| 命令 | 用途 |
| --- | --- |
| /help | 显示帮助 |
| /models | 从 API 读取可用模型，不生成回复 |
| /model 模型ID | 校验模型可用后切换，下一任务生效 |
| /response-mode file/inline | 切换响应传递方式；file 先落盘再由 Agent 读回 |
| /workspace 路径 | 切换默认工作目录并保存；host 模式不限制其他路径 |
| /config [show/get/set/save] | 查看或保存所有 Agent 配置；例如 /config set timeout 120 |
| /allow 能力列表 | 将 shell,browser 等能力加入持久配置 |
| /deny 能力列表 | 从持久配置中撤销能力，下一任务生效 |
| /retry | 保留上下文，用当前模型和工作目录重试上一提示，创建新记录 |
| /new | 清空当前上下文，开始新会话，保留已有历史记录 |
| /context | 查看当前原始目标、状态与已执行步骤摘要 |
| /status | 查看父服务状态、当前模型和工作目录 |
| /doctor [--api] | 检查依赖；--api 同时检查模型列表 |
| /tools | 查看工具及参数 |
| /skill、/skill list、skills、skills list | 列出全部内置和自定义技能及来源 |
| /skill read 名称、/skills [read] 名称 | 阅读技能正文；所有模型使用同一目录 |
| /skill-demo 名称 | 生成不覆盖已有文件的 demo Skill |
| /skill create [描述] | 开始录制技能；也可单独输入“创建skill” |
| /skill finish | 结束录制，生成待确认草稿；也可输入“结束创建skill” |
| /skill confirm [名称] | 在草稿阶段确认名称并创建，不执行步骤 |
| /skill name 名称 | 修改待确认草稿的名称 |
| /skill preview / /skill cancel | 查看或取消当前录制 |
| /skill load/unload 名称 | 动态加载或卸载后续任务使用的技能 |
| /skill reload | 重新检查已加载技能，不使用旧正文缓存 |
| /skill test 名称 | 静态检查结构与支持的脚本语法，不执行脚本 |
| /skill run 名称 任务 | 本次任务使用指定技能 |
| /技能名称 [任务] | 用已存在的同名技能执行新任务；省略任务则按录制步骤执行 |
| /verbose on/off | 打开或关闭自动显示目录、任务和结果路径 |
| /history [关键词] | 搜索历史任务 |
| /history show 任务编号 | 查看历史用户输入和格式化结果 |
| /sessions | 列出历史交互会话 |
| /session 会话编号 | 查看该会话的任务 |
| /logs | 查看最近任务和日志文件路径 |
| /pack [--include-content] | 打包代码和脱敏日志；显式选项包含正文 |
| /quit | 退出；也可按 Ctrl+D |

启动参数 --allow 的显式授权在会话内保留；执行中选择允许的能力仅对该任务有效。
灰色候选可按 Tab 或行末右方向键接受；回车才提交，↑/↓选择历史输入。
任务执行时 Ctrl+C 停止该任务并回到输入；输入提示处 Ctrl+C 退出。
输入“继续”或补充要求会带上当前上下文；不会自动重放已经执行的工具步骤。
Skill 录制期间，除录制控制命令和 /quit 外，所有输入仅保存为步骤。
"""


def display(value, stream=None):
    """Use one renderer for answers and structured diagnostic output."""
    text = json.dumps(value, ensure_ascii=False, indent=2) if not isinstance(value, str) else value
    render_markdown(text, stream if stream is not None else sys.stdout)


def local_history(settings):
    from .history import History
    try:
        credential = api_key(settings)
    except (ValueError, OSError):
        credential = ""
    return History(settings.runtime_dir, secrets=(credential,))


def _cell(value):
    return " ".join(safe_terminal_text(value if value is not None else "—").split()).replace("|", "\\|")


def _run_table(rows):
    if not rows:
        display("没有匹配的历史任务。")
        return
    lines = ["| 任务编号 | 模型 | 状态 | 任务 |", "| --- | --- | --- | --- |"]
    lines += ["| " + " | ".join(_cell(row.get(key)) for key in ("run_id", "model", "status", "task")) + " |" for row in rows]
    display("\n".join(lines))


def show_history(history, *, query="", run_id=None, limit=20):
    if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 100:
        raise ValueError("历史查询 limit 范围为 1..100")
    if not run_id:
        _run_table(history.list_runs(query=query, limit=limit))
        return
    record = history.detail(run_id)
    display(f"## 历史任务 {_cell(record['run_id'])}\n\n模型：{_cell(record.get('model'))}；"
            f"状态：{_cell(record.get('status'))}；工具步骤：{_cell(record.get('steps'))}\n\n### 用户任务")
    display(record.get("task") or "未找到原始用户任务。")
    if record.get("original_task") and record["original_task"] != record.get("task"):
        display("### 本会话原始目标")
        display(record["original_task"])
    if record.get("tools"):
        display("### 工具执行摘要")
        display(record["tools"])
    display("### 保存的结果")
    display(record.get("answer") or "尚无保存的结果。")


def show_sessions(history, *, session_id=None, limit=20):
    if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 100:
        raise ValueError("历史查询 limit 范围为 1..100")
    if session_id:
        session = history.session_detail(session_id, limit=limit)
        display(f"## 交互会话 {_cell(session['session_id'])}")
        _run_table(session.get("runs", []))
        return
    sessions = history.list_sessions(limit=limit)
    if not sessions:
        display("没有已保存的交互会话。旧版独立任务可通过 /history 查询。")
        return
    lines = ["| 会话编号 | 初始模型 | 任务数 |", "| --- | --- | --- |"]
    lines += ["| " + " | ".join(_cell(row.get(key)) for key in ("session_id", "model", "run_count")) + " |" for row in sessions]
    display("\n".join(lines))


class Suggestions:
    """Small local candidate source; typing never performs an HTTP request."""
    commands = ("/config", "/config save", "/config set ", "/allow ", "/deny ", "/help", "/models", "/model ", "/response-mode file", "/response-mode inline", "/workspace ", "/retry", "/new", "/context", "/status", "/doctor", "/doctor --api",
                "/tools", "/skill", "/skill list", "/skill read ", "/skills", "/skills ", "/skill-demo ", "/skill load ", "/skill unload ",
                "/skill create", "/skill finish", "/skill confirm ", "/skill name ", "/skill preview", "/skill cancel",
                "/skill reload", "/skill test ", "/skill run ", "/verbose on", "/verbose off",
                "/history", "/history show ", "/sessions", "/session ", "/logs", "/pack",
                "/pack --include-content", "/quit")

    def __init__(self, library, tasks=()):
        self.library = library
        self.tasks = list(tasks)[-100:]
        self.models = ["chatgpt", "deepseek", "qwen", "claude", "grok",
                       "glm", "kimi", "web-glm", "web-kimi"]
        self.skills = []
        self.capture = None
        self.refresh_skills()

    def refresh_skills(self):
        try:
            self.skills = [row["name"] for row in self.library.catalog()]
        except (ToolError, OSError, ValueError):
            # Optional completion must not prevent /skills or /skill test from
            # reporting the actual broken configuration through normal commands.
            self.skills = []

    def __call__(self, prefix):
        if not prefix:
            return []
        if self.capture and self.capture.active:
            phase = self.capture.recorder.phase
            candidates = (["/skill finish", "结束创建skill", "/skill preview", "/skill cancel", "/quit"]
                          if phase == "recording" else
                          ["/skill confirm " + self.capture.recorder.draft["proposed_name"],
                           "/skill name ", "/skill preview", "/skill cancel", "/quit"])
            return [value for value in candidates if value.startswith(prefix) and value != prefix]
        candidates = list(self.commands)
        if prefix.startswith("/"):
            from .skill_console import RESERVED_COMMANDS
            candidates += ["/" + name + " " for name in self.skills if name not in RESERVED_COMMANDS]
        if prefix.startswith("/model "):
            candidates = ["/model " + name for name in self.models]
        for start in ("/skill read ", "/skills ", "/skill load ", "/skill unload ", "/skill test ", "/skill run "):
            if prefix.startswith(start):
                candidates = [start + name + (" " if start == "/skill run " else "") for name in self.skills]
                break
        if not prefix.startswith("/"):
            candidates = list(reversed(self.tasks))
        return list(dict.fromkeys(value for value in candidates if value.startswith(prefix) and value != prefix))[:20]


def _debug_event(settings, name, fields):
    try:
        credential = api_key(settings)
    except (ValueError, OSError):
        credential = ""
    audit = Audit(Path(settings.runtime_dir) / "logs/agent.log", secrets=(credential,), content=settings.log_content)
    try:
        audit(name, fields)
    finally:
        audit.close()


def pack_diagnostics(settings, *, include_content=False, run_id=None):
    """Call the parent's bounded, redacting packer without echoing process logs."""
    if run_id is not None and (not isinstance(run_id, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}", run_id)):
        raise ValueError("任务标识只能包含字母、数字、下划线和连字符，最多 128 字符。")
    parent = ROOT.parent
    script = parent / "package.sh"
    if not script.is_file():
        raise ValueError("未找到父项目 package.sh，请在完整项目内运行 Agent。")
    name = "multillm-fusion-diagnostics-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S") + "-" + uuid4().hex[:8] + ".tar.gz"
    output = parent / "diagnostics" / name
    command = ["bash", str(script), "--output", str(output), "--agent-runtime-dir", settings.runtime_dir]
    if run_id:
        command += ["--agent-run-id", run_id]
    if include_content:
        command += ["--include-content"]
    import os
    environment = {**os.environ, "FUSION_PYTHON": sys.executable}
    try:
        result = subprocess.run(command, cwd=parent, env=environment, capture_output=True,
                                text=True, encoding="utf-8", errors="replace", timeout=120)
    except (OSError, subprocess.TimeoutExpired) as exc:
        _debug_event(settings, "diagnostics.pack_failed", {"error_type": type(exc).__name__, "payload": {"command": command}})
        raise ValueError("日志打包未完成，请检查父项目和日志目录；详细信息写入 agent.log。") from exc
    _debug_event(settings, "diagnostics.pack_completed" if result.returncode == 0 else "diagnostics.pack_failed",
                 {"returncode": result.returncode, "payload": {"command": command, "stdout": result.stdout, "stderr": result.stderr}})
    if result.returncode != 0 or not output.is_file():
        raise ValueError("日志打包失败，请查看 agent.log 中的 diagnostics.pack_failed 记录。")
    return {"archive": str(output), "bytes": output.stat().st_size, "run_id": run_id,
            "include_content": bool(include_content), "uploaded": False}


def available_models(settings):
    from .client import FusionClient
    client = FusionClient(settings.base_url, api_key(settings), model=settings.model,
                          timeout=min(settings.timeout, 15), allow_remote_http=settings.allow_remote_http)
    values = client.models()
    return [item["id"] for item in values if isinstance(item, dict) and isinstance(item.get("id"), str)]


def _exact(words, minimum, maximum, usage):
    if not minimum <= len(words) <= maximum:
        raise ValueError("用法：" + usage)


def _start_session(settings, args):
    """Check/start once on entry; failure leaves debugging commands available."""
    from .parent_service import ensure_parent
    from .terminal import TerminalProgress
    try:
        credential = api_key(settings)
    except (ValueError, OSError):
        credential = ""
    audit = Audit(Path(settings.runtime_dir) / "logs/agent.log", secrets=(credential,), content=settings.log_content)
    progress = TerminalProgress(secrets=(credential,), verbose=getattr(args, "verbose", False))
    try:
        audit("interactive.started", {"model": settings.model})
        ensure_parent(settings, auto_start=not args.no_auto_start, progress=progress.write, event=audit,
                      verbose=progress.verbose)
    except KeyboardInterrupt:
        progress.write("已取消父服务检查；仍可使用交互调试命令。")
    except Exception as exc:
        audit("interactive.parent_unavailable", {"error_type": type(exc).__name__, "payload": {"message": str(exc)}})
        message = str(exc) if isinstance(exc, ValueError) else type(exc).__name__
        progress.write(f"父服务暂未就绪：{message}\n可继续使用 /status、/logs、/pack；输入任务时会再次检查。")
    finally:
        audit.close()


def interactive_loop(settings, args, execute, *, read_line=None):
    """Keep conversation checkpoints with fresh per-turn permissions and records."""
    from .cli import components, doctor_report, report_error
    from .parent_service import parent_status
    from .skills import AgentSkillLibrary as SkillLibrary
    from .skill_workflow import SkillSelection, skill_hints
    from .session_context import SessionContext

    settings = deepcopy(settings)
    args = copy(args)
    args.verbose = getattr(args, "verbose", False)
    last_task, last_run, last_extra_skill = None, None, None
    pending_task, pending_extra_skill = None, None
    session_context = SessionContext()
    display("## Desktop Agent\n\n输入任务开始执行，后续提示继承当前上下文。/new 开始新会话，/help 查看命令。详细日志写入文件。")
    if args.verbose:
        display({"model": settings.model, "workspace": settings.workspace})
    _start_session(settings, args)
    library = SkillLibrary(Path(settings.skills_dir))
    selection = SkillSelection(library, names=tuple(args.skill))
    history, session_id, tasks = None, None, []
    try:
        history = local_history(settings)
        session_id = history.start_session(model=settings.model)
        tasks = list(reversed(history.recent_tasks(limit=100)))
        if args.verbose:
            display({"session_id": session_id})
    except Exception as exc:
        _debug_event(settings, "history.unavailable", {"error_type": type(exc).__name__})
        print("历史记录暂不可用，当前任务仍可运行。", file=sys.stderr)
    suggestions = Suggestions(library, tasks)
    from .skill_console import SkillCaptureConsole, RESERVED_COMMANDS
    try:
        capture_credential = api_key(settings)
    except (ValueError, OSError):
        capture_credential = ""
    capture = SkillCaptureConsole(settings, args, display=display,
                                  event=lambda name, fields: _debug_event(settings, name, fields),
                                  refresh=suggestions.refresh_skills, secrets=(capture_credential,))
    suggestions.capture = capture
    if read_line is None:
        from .input_editor import InputEditor
        editor = InputEditor(suggestions=suggestions, history=tasks)
        read_line = editor.read_line

    def record_run(value):
        nonlocal last_run
        last_run = dict(value)
        if history and session_id:
            try:
                history.record_run(session_id, value["run_id"], model=settings.model)
            except Exception as exc:
                _debug_event(settings, "history.record_failed", {"error_type": type(exc).__name__,
                             "payload": {"session_id": session_id, "run_id": value["run_id"]}})
                print("本轮任务记录已创建，但会话索引未能更新；可用 /history 查询。", file=sys.stderr)

    def run_task(task, extra_skill=None):
        nonlocal last_task, last_extra_skill, pending_task, pending_extra_skill
        if task.casefold().strip() in ("继续", "继续执行", "continue"):
            if pending_task:
                task, extra_skill = pending_task, extra_skill or pending_extra_skill
            elif session_context.checkpoint() is None:
                if not last_task:
                    display("当前还没有可继续的任务，请先输入目标；已有任务可通过 /history 查看。")
                    return
                # A startup failure may occur before Runtime has a checkpoint.
                # Retry that original input instead of sending an empty continue.
                task, extra_skill = last_task, extra_skill or last_extra_skill
            elif extra_skill is None:
                extra_skill = last_extra_skill
        elif pending_task and task != pending_task:
            task = pending_task + "\n\n用户补充要求：\n" + task
            extra_skill = extra_skill or pending_extra_skill
        last_task = task
        last_extra_skill = extra_skill
        suggestions.tasks = [*suggestions.tasks[-99:], task]
        run_args = copy(args)
        run_args.session_context = session_context
        run_args.skill = list(dict.fromkeys([*selection.names, *([extra_skill] if extra_skill else [])]))
        previous_checkpoint = session_context.checkpoint()
        pending_task, pending_extra_skill = task, extra_skill
        execution_result = object()
        try:
            execution_result = execute(task, deepcopy(settings), run_args, on_run=record_run)
        finally:
            if (session_context.checkpoint() is not previous_checkpoint or execution_result is None
                    or type(execution_result) is int and execution_result == 0):
                pending_task, pending_extra_skill = None, None

    while True:
        try:
            suggestions.refresh_skills()
            prompt = safe_terminal_text(capture.prompt() or f"agent[{settings.model}]> ")
            raw_line = read_line(prompt)
            line = raw_line.strip()
        except (EOFError, KeyboardInterrupt):
            capture.exit_notice()
            print("\n已退出交互。", file=sys.stderr)
            return 0
        except (ValueError, OSError) as exc:
            report_error(exc)
            continue
        if not line:
            continue
        try:
            if len(raw_line.encode("utf-8")) > 100000:
                raise ValueError("输入超过 100 KB")
            if capture.handle(raw_line):
                continue
            if (line in ("skill", "skill list", "skills", "skills list")
                    or line.startswith(("skill read ", "skill show ", "skills read ", "skills show "))):
                line = "/" + line
            if not line.startswith("/"):
                run_task(line)
                continue
            if re.match(r"^/skill\s+run(?:\s|$)", line):
                # The remainder is a natural-language task, not shell syntax.
                # Preserve quotes/backslashes/newlines exactly as typed.
                parts = line.split(None, 3)
                if len(parts) != 4 or not parts[3].strip():
                    raise ValueError("用法：/skill run 名称 自然语言任务")
                library.load(parts[2])
                run_task(parts[3], extra_skill=parts[2])
                _debug_event(settings, "interactive.command_completed", {"payload": {"command": line}})
                continue
            # Only explicit invocation of an installed, valid skill becomes a
            # task. A classifier cannot promote free text into a command.
            invocation = line.split(None, 1)
            skill_name = invocation[0][1:]
            if (skill_name not in RESERVED_COMMANDS and SkillLibrary._valid_name(skill_name)
                    and any(row["name"] == skill_name for row in library.catalog())):
                library.load(skill_name)
                task = invocation[1] if len(invocation) == 2 else f"按技能 {skill_name} 中记录的目标与步骤执行，并核验结果。"
                run_task(task, extra_skill=skill_name)
                _debug_event(settings, "interactive.command_completed", {"payload": {"command": line}})
                continue
            words = shlex.split(line, posix=True)
            command = words[0]
            if command == "/quit":
                _exact(words, 1, 1, "/quit")
                print("已退出交互。", file=sys.stderr)
                return 0
            if command == "/help":
                _exact(words, 1, 1, "/help")
                display(HELP)
            elif command == "/models":
                _exact(words, 1, 1, "/models")
                suggestions.models = available_models(settings)
                display({"current_model": settings.model, "available_models": suggestions.models})
            elif command == "/model":
                _exact(words, 2, 2, "/model 模型ID")
                suggestions.models = available_models(settings)
                if words[1] not in suggestions.models:
                    raise ValueError("该模型未在 /v1/models 中启用；当前模型保持不变。")
                target = update_settings(settings, {"model": words[1]})
                display({"model": settings.model, "saved": bool(target), "config_file": str(target) if target else None, "effective": "下一任务及重启后" if target else "当前会话"})
            elif command == "/response-mode":
                _exact(words, 2, 2, "/response-mode file/inline")
                if words[1] not in ("file", "inline"):
                    raise ValueError("响应方式只能为 file 或 inline。")
                target = update_settings(settings, {"response_delivery": words[1]})
                display({"response_delivery": settings.response_delivery, "saved": bool(target), "effective": "下一轮任务"})
            elif command == "/workspace":
                _exact(words, 2, 2, '/workspace 路径（含空格时用双引号）')
                path = Path(words[1]).expanduser().absolute()
                if path.exists() and not path.is_dir():
                    raise ValueError("工作目录路径已存在，但不是目录。")
                target = update_settings(settings, {"workspace": str(path)})
                display({"workspace": settings.workspace, "saved": bool(target), "config_file": str(target) if target else None,
                         "filesystem_scope": settings.filesystem_scope, "effective": "下一轮任务"})
            elif command == "/config":
                operation = words[1] if len(words) > 1 else "show"
                if operation == "show":
                    _exact(words, 1, 2, "/config [show]")
                    display({"config_file": getattr(settings, "_config_path", None), "settings": settings_dict(settings)})
                elif operation == "save":
                    _exact(words, 2, 2, "/config save")
                    display({"saved": True, "config_file": str(save_settings(settings))})
                elif operation == "get":
                    _exact(words, 3, 3, "/config get 配置名")
                    if words[2] not in settings_dict(settings): raise ValueError("未知配置名")
                    display({words[2]: getattr(settings, words[2])})
                elif operation == "set":
                    _exact(words, 4, 100, "/config set 配置名 值")
                    key = words[2]
                    value = setting_value(key, " ".join(words[3:]))
                    if key == "workspace":
                        path = Path(value)
                        if path.exists() and not path.is_dir(): raise ValueError("工作目录不是目录")
                    new_selection = None
                    if key in ("default_skills", "skills_dir"):
                        next_library = SkillLibrary(Path(value if key == "skills_dir" else settings.skills_dir))
                        next_names = tuple(value) if key == "default_skills" else selection.names
                        new_selection = SkillSelection(next_library, names=next_names)
                    target = update_settings(settings, {key: value}, persist=True)
                    args.verbose = settings.verbose
                    args.non_interactive = settings.non_interactive
                    args.no_auto_start = not settings.auto_start_parent
                    if new_selection is not None:
                        selection = new_selection
                        library = next_library
                        suggestions.library = library
                        suggestions.refresh_skills()
                    if key == "runtime_dir":
                        history = local_history(settings)
                        session_id = history.start_session(model=settings.model)
                    if key in ("runtime_dir", "skills_dir"):
                        # Config commands are not dispatched during active skill recording.
                        capture = SkillCaptureConsole(settings, args, display=display,
                            event=lambda name, fields: _debug_event(settings, name, fields),
                            refresh=suggestions.refresh_skills, secrets=(capture_credential,))
                        suggestions.capture = capture
                    display({"saved": bool(target), "config_file": str(target), key: getattr(settings, key), "effective": "下一轮任务"})
                else:
                    raise ValueError("/config 支持 show/get/set/save")
            elif command in ("/allow", "/deny"):
                _exact(words, 2, 2, command + " shell,browser,desktop")
                selected = {item.strip() for item in words[1].split(",") if item.strip()}
                if not selected or selected - {"files", "skills", "web", "shell", "browser", "desktop"}:
                    raise ValueError("能力仅支持 files/skills/web/shell/browser/desktop")
                capabilities = set(settings.allowed_capabilities)
                capabilities = capabilities | selected if command == "/allow" else capabilities - selected
                target = update_settings(settings, {"allowed_capabilities": sorted(capabilities)})
                display({"allowed_capabilities": settings.allowed_capabilities, "saved": bool(target), "effective": "下一轮任务"})
            elif command == "/retry":
                _exact(words, 1, 1, "/retry")
                if not last_task:
                    raise ValueError("尚无上一任务，请先输入自然语言任务。")
                run_task(last_task, extra_skill=last_extra_skill)
            elif command == "/new":
                _exact(words, 1, 1, "/new")
                session_context.clear()
                last_task, last_run, last_extra_skill = None, None, None
                pending_task, pending_extra_skill = None, None
                session_id = None
                if history:
                    try:
                        session_id = history.start_session(model=settings.model)
                    except Exception as exc:
                        _debug_event(settings, "history.session_failed", {"error_type": type(exc).__name__})
                display("已开始新会话；输入新的任务。之前的记录仍可通过 /history 查询。")
            elif command == "/context":
                _exact(words, 1, 1, "/context")
                from .audit import redact_content
                display(redact_content({**session_context.summary(), "pending_input": pending_task}, (capture_credential,)))
            elif command in ("/verbose", "/v"):
                _exact(words, 1, 2, "/verbose [on|off]")
                if len(words) == 2:
                    if words[1] not in ("on", "off"):
                        raise ValueError("用法：/verbose [on|off]")
                    update_settings(settings, {"verbose": words[1] == "on"})
                    args.verbose = settings.verbose
                display("详细信息已开启。" if args.verbose else "详细信息已关闭；/logs、/status 可按需查看。")
            elif command == "/history":
                if len(words) >= 2 and words[1] == "show":
                    _exact(words, 3, 3, "/history show 任务编号")
                    show_history(local_history(settings), run_id=words[2])
                else:
                    show_history(local_history(settings), query=" ".join(words[1:]))
            elif command == "/sessions":
                _exact(words, 1, 1, "/sessions")
                show_sessions(local_history(settings))
            elif command == "/session":
                _exact(words, 2, 2, "/session 会话编号")
                show_sessions(local_history(settings), session_id=words[1])
            elif command == "/status":
                _exact(words, 1, 1, "/status")
                display({"model": settings.model, "workspace": settings.workspace, "last_run": last_run,
                         "parent": parent_status(settings)})
            elif command == "/doctor":
                _exact(words, 1, 2, "/doctor [--api]")
                if len(words) == 2 and words[1] != "--api":
                    raise ValueError("用法：/doctor [--api]")
                display(doctor_report(settings, len(words) == 2))
            elif command == "/tools":
                _exact(words, 1, 1, "/tools")
                owners = []
                try:
                    owners, _, specs = components(settings)
                    display([spec.public() for spec in specs])
                finally:
                    for owner in reversed(owners):
                        try:
                            owner.close()
                        except Exception:
                            pass
            elif command == "/skills":
                _exact(words, 1, 3, "/skills [list|名称] 或 /skills read 名称")
                library = SkillLibrary(Path(settings.skills_dir))
                if len(words) == 1 or len(words) == 2 and words[1] == "list":
                    display(library.catalog())
                elif len(words) == 2:
                    display(library.load(words[1]))
                elif words[1] in ("read", "show"):
                    display(library.load(words[2]))
                else:
                    raise ValueError("用法：/skills [list|名称] 或 /skills read 名称")
            elif command == "/skill-demo":
                _exact(words, 2, 2, "/skill-demo 名称")
                from .skill_demo import create_demo_skill
                created = create_demo_skill(words[1], Path(settings.skills_dir))
                suggestions.refresh_skills()
                display(created)
            elif command == "/skill":
                _exact(words, 1, 102, "/skill [list|read|load|unload|reload|test|run] ...")
                action = words[1] if len(words) > 1 else "list"
                if action == "list":
                    _exact(words, 1, 2, "/skill [list]")
                    display(library.catalog())
                elif action in ("read", "show"):
                    _exact(words, 3, 3, "/skill read 名称")
                    display(library._read_tool({"name": words[2]}))
                elif action == "load":
                    _exact(words, 3, 3, "/skill load 名称")
                    candidate = SkillSelection(library, names=selection.names)
                    candidate.load(words[2])
                    target = update_settings(settings, {"default_skills": list(candidate.names)})
                    selection = candidate
                    display({"loaded_skills": list(selection.names), "saved": bool(target), "effective": "后续任务读取最新正文",
                             "hints": skill_hints(words[2])})
                elif action == "unload":
                    _exact(words, 3, 3, "/skill unload 名称")
                    names = list(selection.names)
                    removed = words[2] in names
                    if removed: names.remove(words[2])
                    candidate = SkillSelection(library, names=names)
                    candidate.unload(words[2])  # Validate the name even when not selected.
                    target = update_settings(settings, {"default_skills": list(candidate.names)})
                    selection = candidate
                    display({"removed": removed, "saved": bool(target), "loaded_skills": list(selection.names)})
                elif action == "reload":
                    _exact(words, 2, 2, "/skill reload")
                    selection.reload()
                    suggestions.refresh_skills()
                    display({"loaded_skills": list(selection.names), "status": "已重新检查当前技能正文"})
                elif action == "test":
                    _exact(words, 3, 3, "/skill test 名称")
                    display(library.check(words[2]))
                else:
                    raise ValueError("未知技能命令；使用 load、unload、reload、test 或 run。")
            elif command == "/logs":
                _exact(words, 1, 1, "/logs")
                run_dir = Path(last_run["run_dir"]) if last_run else None
                display({"global_log": str(Path(settings.runtime_dir) / "logs/agent.log"),
                         "run_id": last_run["run_id"] if last_run else None,
                         "run_log": str(run_dir / "events.jsonl") if run_dir else None,
                         "result": str(run_dir / "result.md") if run_dir else None,
                         "response_delivery": settings.response_delivery,
                         "responses": str(run_dir / "responses") if run_dir else None,
                         "json_repair": str(run_dir / "json-repair") if run_dir else None})
            elif command == "/pack":
                _exact(words, 1, 2, "/pack [--include-content]")
                if len(words) == 2 and words[1] != "--include-content":
                    raise ValueError("用法：/pack [--include-content]")
                print("正在打包诊断…", file=sys.stderr)
                display(pack_diagnostics(settings, include_content=len(words) == 2,
                                         run_id=last_run["run_id"] if last_run else None))
            else:
                raise ValueError("未知交互命令；输入 /help 查看支持的命令。")
            _debug_event(settings, "interactive.command_completed", {"payload": {"command": line}})
        except KeyboardInterrupt:
            print("已取消本次操作，返回交互输入。", file=sys.stderr)
        except Exception as exc:
            _debug_event(settings, "interactive.command_failed", {"error_type": type(exc).__name__,
                         "payload": {"command": line, "message": str(exc)}})
            report_error(exc)
