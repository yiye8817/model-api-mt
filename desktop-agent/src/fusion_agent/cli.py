"""Command line entrypoint; no GUI/browser import or API request during discovery."""

import argparse
from copy import deepcopy
from datetime import datetime, timezone
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sys
import time
from uuid import uuid4

from . import __version__
from .payload_repair import REPAIR_ALGORITHM
from .audit import Audit
from .config import (ROOT, Settings, api_key, initialize, load_settings, save_settings,
                     settings_dict, setting_value, update_settings)
from .registry import ToolRegistry, redact_known
from .rendering import render_markdown, safe_terminal_text
from .terminal import TerminalProgress, authorization_details


def parser():
    result = argparse.ArgumentParser(description="通过 MultiLLM Fusion 文本 API 执行本地桌面任务")
    result.add_argument("--version", action="version", version=__version__)
    result.add_argument("-v", "--v", "--verbose", dest="verbose", action="store_true", help="显示工作目录、任务记录和结果文件路径")
    commands = result.add_subparsers(dest="command")
    from .repair_json import parser as repair_parser
    commands.add_parser("repair-json", parents=[repair_parser()], add_help=False,
                        help="离线回放 JSON 修复；不启动服务器、不调用模型、不执行动作")
    config_command = commands.add_parser("config", help="查看、修改并保存 Agent 配置，无需连接服务器")
    config_command.add_argument("--config", help="指定 Agent 配置文件")
    config_command.add_argument("operation", nargs="?", default="show", choices=("show", "get", "set", "save"))
    config_command.add_argument("key", nargs="?")
    config_command.add_argument("value", nargs="*")
    init = commands.add_parser("init", help="创建本地配置，不覆盖已有文件")
    init.add_argument("--output", default=str(ROOT / "agent.config.json"))
    for name in ("run", "chat", "tools", "skills", "skill", "doctor", "status", "pack", "skill-demo", "skill-test", "history", "sessions"):
        command = commands.add_parser(name)
        command.add_argument("--config", help="Agent JSON 配置文件；相对路径基于该文件目录")
        command.add_argument("-v", "--v", "--verbose", dest="verbose", action="store_true", default=argparse.SUPPRESS,
                             help="显示工作目录、任务记录和结果文件路径")
        if name in ("run", "chat"):
            if name == "run":
                command.add_argument("task", nargs="?", help="自然语言任务")
                command.add_argument("--task-file", help="从 UTF-8 文件读取任务")
            command.add_argument("--no-auto-start", action="store_true", help="不自动启动父项目服务器")
            command.add_argument("--model", help="chatgpt/deepseek/qwen/glm/kimi 等已启用模型")
            command.add_argument("--base-url")
            command.add_argument("--workspace", help="相对路径基准及命令默认 cwd；默认不限制文件访问范围")
            command.add_argument("--allow", default="", help="预先授权并保存的能力，例如 shell,browser,desktop；--no-save-config 可临时授权")
            command.add_argument("--skill", action="append", default=[], help="预加载 Skill，可重复指定；也支持运行中按需加载")
            command.add_argument("--max-steps", type=int)
            command.add_argument("--timeout", type=float)
            command.add_argument("--max-context-chars", type=int)
            command.add_argument("--filesystem-scope", choices=("host", "workspace"), help="host（默认）不限制到 workspace；workspace 保留旧范围")
            command.add_argument("--no-save-config", action="store_true", help="本次参数临时生效，不写入配置")
            command.add_argument("--response-delivery", choices=("file", "inline"),
                                 help="服务器回复传递方式：file 先落盘再由 Agent 读回；默认 file")
            command.add_argument("--no-python-tool-fallback", action="store_true",
                                 help="禁用生成式 Python 工具；不影响内置只读工具的固定 Python 实现")
            command.add_argument("--no-save-problem-json", action="store_true",
                                 help="不另存 JSON 修复样本；不影响正常任务记录")
            command.add_argument("--headless", action="store_true", help="浏览器无界面运行；桌面工具仍需真实 X11")
            command.add_argument("--browser-no-sandbox", action="store_true", help="本次浏览器排障关闭 Chromium 进程沙箱；不会自动启用")
            command.add_argument("--non-interactive", action="store_true", help="缺少能力授权时返回错误，不等待输入")
            command.add_argument("--log-metadata-only", action="store_true", help="本次日志仅记录阶段和状态，不记录任务/模型正文/工具参数结果")
        elif name == "pack":
            command.add_argument("--include-content", action="store_true", help="包含对话及工具正文，默认只打包脱敏诊断")
            command.add_argument("--run-id", help="额外包含指定任务的 events.jsonl")
        elif name == "skill-demo":
            command.add_argument("name", nargs="?", default="workspace-report-demo")
        elif name == "skill-test":
            command.add_argument("name", help="只检查技能结构与支持的脚本语法，不执行脚本")
        elif name == "history":
            command.add_argument("query", nargs="?", default="", help="按任务内容搜索；--show 查看指定任务")
            command.add_argument("--show", help="查看任务编号对应的用户输入和结果")
            command.add_argument("--limit", type=int, default=20)
        elif name == "sessions":
            command.add_argument("session_id", nargs="?", help="查看指定交互会话的任务")
            command.add_argument("--limit", type=int, default=20)
        elif name == "doctor":
            command.add_argument("--api", action="store_true", help="读取 /v1/models 检查连接，不生成模型回复")
        elif name == "skill":
            command.add_argument("operation", nargs="?", default="list", choices=("list", "read", "show", "test"))
            command.add_argument("name", nargs="?")
        elif name == "skills":
            command.add_argument("name", nargs="?", help="省略或使用 list 列出全部技能；也可直接指定名称")
            command.add_argument("read_name", nargs="?", help="skills read/show 后指定技能名称")
    return result


def components(settings):
    from .browser import BrowserTools
    from .desktop import DesktopTools
    from .local_tools import LocalTools
    from .environment import EnvironmentTools
    from .skills import AgentSkillLibrary as SkillLibrary
    from .web_search import WebSearchTools
    from .web_fetch import WebFetchTools
    from .local_execution import LocalExecutionTools
    runtime = Path(settings.runtime_dir)
    local = LocalTools(Path(settings.workspace), runtime, filesystem_scope=settings.filesystem_scope)
    browser = BrowserTools(runtime, headless=settings.browser_headless, channel=settings.browser_channel, sandbox=settings.browser_sandbox)
    environment = EnvironmentTools(runtime, local.shell_run, active_driver=lambda: browser._playwright)
    desktop = DesktopTools(runtime)
    web_search = WebSearchTools()
    web_fetch = WebFetchTools(runtime)
    execution = LocalExecutionTools(local)
    execution.enabled = settings.python_tool_fallback
    skills = SkillLibrary(Path(settings.skills_dir))
    owners = [local, browser, desktop, environment, web_search, web_fetch, execution]
    specs = [*local.specs(), *browser.specs(), *web_search.specs(), *desktop.specs(),
             *skills.specs(), *environment.specs(), *web_fetch.specs(), *execution.specs()]
    return owners, skills, specs


def doctor_report(settings, check_api=False):
    from .local_execution import inventory
    report = {"agent_version": __version__, "repair_algorithm": REPAIR_ALGORITHM,
              "agent_source": str(Path(__file__).resolve()), "python": sys.version.split()[0], "python_executable": sys.executable,
              "python_prefix": sys.prefix, "python_is_venv": sys.prefix != sys.base_prefix, "platform": sys.platform,
              "model": settings.model, "workspace": settings.workspace,
              "filesystem_scope": settings.filesystem_scope, "config_file": getattr(settings, "_config_path", None),
              "display": bool(os.environ.get("DISPLAY")), "wayland": bool(os.environ.get("WAYLAND_DISPLAY") or os.environ.get("XDG_SESSION_TYPE", "").lower() == "wayland"),
              "optional_python": {name: importlib.util.find_spec(name) is not None for name in ("playwright", "pyautogui", "PIL", "pyperclip")},
              "optional_cli": {name: shutil.which(name) is not None
                               for name in ("browser-use", "opencli", "tesseract", "xclip", "xsel")},
              "local_environment": inventory(), "python_tool_fallback": settings.python_tool_fallback,
              "api_checked": False}
    if check_api:
        from .client import FusionClient
        client = FusionClient(settings.base_url, api_key(settings), settings.model, timeout=min(settings.timeout, 15), allow_remote_http=settings.allow_remote_http)
        report["models"] = [item["id"] for item in client.models()]
        report["api_checked"] = True
        report["selected_model_available"] = settings.model in report["models"]
    return report


def doctor(settings, check_api=False):
    report = doctor_report(settings, check_api)
    print(safe_terminal_text(json.dumps(report, ensure_ascii=False, indent=2)))
    return 0 if not check_api or report["selected_model_available"] else 2


def reserve_run_directory(runtime_dir):
    """Reserve a fresh task directory before opening any per-run log or state file."""
    runs_dir = Path(runtime_dir).absolute() / "runs"
    if any(part.is_symlink() for part in (runs_dir, *runs_dir.parents)):
        raise ValueError("任务记录目录及其上级目录不能是符号链接。")
    runs_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    # A collision includes an existing directory, regular file, or symlink.
    # Never continue a task in an old directory, including one containing only events.jsonl.
    for _ in range(8):
        run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ-") + uuid4().hex[:8]
        run_dir = runs_dir / run_id
        try:
            run_dir.mkdir(mode=0o700, exist_ok=False)
        except FileExistsError:
            continue
        return run_id, run_dir
    raise ValueError("无法生成新的任务记录目录：连续遇到名称冲突，请检查 runtime_dir。")


def apply_run_overrides(settings, args):
    settings = deepcopy(settings)
    for key in ("model", "base_url", "max_steps", "timeout", "max_context_chars", "response_delivery", "filesystem_scope"):
        if getattr(args, key, None) is not None:
            setattr(settings, key, getattr(args, key))
    if args.workspace:
        settings.workspace = str(Path(args.workspace).expanduser().absolute())
    if args.headless:
        settings.browser_headless = True
    if args.browser_no_sandbox:
        settings.browser_sandbox = False
    if args.log_metadata_only:
        settings.log_content = False
    if getattr(args, "no_python_tool_fallback", False):
        settings.python_tool_fallback = False
    if getattr(args, "no_save_problem_json", False):
        settings.save_problem_json = False
    if getattr(args, "verbose", False):
        settings.verbose = True
    if getattr(args, "non_interactive", False):
        settings.non_interactive = True
    if getattr(args, "no_auto_start", False):
        settings.auto_start_parent = False
    if getattr(args, "skill", None):
        settings.default_skills = list(args.skill)
    settings.allowed_capabilities = sorted(set(settings.allowed_capabilities) |
        {item.strip() for item in args.allow.split(",") if item.strip()})
    return settings.validate()


def report_error(exc):
    from .contracts import ToolError
    from .client import ClientError
    if isinstance(exc, (ValueError, ToolError, ClientError, FileExistsError)):
        message = f"Agent 无法执行：{exc}"
    else:
        message = f"Agent 无法执行 ({type(exc).__name__})；请检查配置和依赖，运行 doctor 排查。"
    print(safe_terminal_text(message), file=sys.stderr)


def _preflight_result(run_dir, task, status, code, answer, *, skill_names=(), secrets=()):
    """Record a reserved task that never entered Runtime; never replace records."""
    from .runtime import Runtime
    if run_dir is None or any((run_dir / name).exists() or (run_dir / name).is_symlink()
                              for name in ("state.json", "transcript.json", "final.md", "result.md")):
        return None
    runtime = Runtime(None, None, run_dir)
    answer = redact_known(answer, secrets)
    runtime.messages = [{"role": "user", "content": json.dumps({"type": "original_user_task",
                        "task": redact_known(task, secrets), "selected_skills": list(skill_names)}, ensure_ascii=False)}]
    runtime.state = {"version": 1, "status": status, "steps": 0, "started_at": time.time(),
                     "stage": "preflight", "task_executed": False, "pending_action": None,
                     "uncertain_actions": [], "pending_verifications": {}, "failed_actions": [],
                     "unresolved_failures": [], "last_tool_failed": False, "skill_names": list(skill_names),
                     "last_error": {"code": code, "message": answer, "stage": "preflight"}}
    return runtime._finish(status, answer, code)


def _record_paths(run_dir, audit, progress=None):
    progress = progress or TerminalProgress()
    if progress.verbose and run_dir is not None and (run_dir / "result.md").is_file():
        progress.write(f"结果文件：{run_dir / 'result.md'}")
    if progress.verbose and audit and audit.run_log_available:
        progress.write(f"详细日志：{audit.run_path}")
    if progress.verbose and audit and audit.global_log_available:
        progress.write(f"全局日志：{audit.path}")
    if audit and not audit.run_log_available and not audit.global_log_available:
        progress.write("详细日志未能保存，请检查日志目录权限及剩余空间。")


def execute_run(task, settings, args, on_run=None):
    """Each task owns fresh registry permissions, browser handles and run records."""
    owners, audit = [], None
    run_id, run_dir, progress = None, None, None
    runtime, result = None, None
    session_context = getattr(args, "session_context", None)
    credential = ""
    runtime_entered = False
    settings = deepcopy(settings)

    def finish_preflight(status, code, answer):
        if runtime_entered:
            return False
        try:
            result = _preflight_result(run_dir, task, status, code, answer,
                                       skill_names=args.skill, secrets=(credential,))
            if result is None:
                return False
            fields = {"run_id": run_id, "status": status, "steps": 0, "error_code": code, "payload": {"result": result}}
            if audit:
                audit("agent.finished", fields)
            if progress:
                progress("agent.finished", fields)
            render_markdown(result["answer"], sys.stdout)
            return True
        except Exception as exc:
            if audit:
                audit("agent.preflight_record_failed", {"run_id": run_id, "error_type": type(exc).__name__})
            return False

    try:
        if not isinstance(task, str) or not task.strip():
            raise ValueError("任务不能为空")
        if len(task.encode("utf-8")) > 100000:
            raise ValueError("任务超过 100 KB")
        if not settings.browser_sandbox:
            print("本次 Agent 浏览器关闭 Chromium 进程沙箱，仅用于临时排障。", file=sys.stderr)
        from .client import FusionClient
        from .runtime import Runtime
        run_id, run_dir = reserve_run_directory(settings.runtime_dir)
        if on_run:
            on_run({"run_id": run_id, "run_dir": str(run_dir)})
        try:
            credential = api_key(settings)
        except (ValueError, OSError):
            credential = ""
        audit = Audit(Path(settings.runtime_dir) / "logs" / "agent.log", secrets=(credential,),
                      content=settings.log_content, run_path=run_dir / "events.jsonl")
        progress = TerminalProgress(secrets=(credential,), verbose=getattr(args, "verbose", False))
        def event(name, fields):
            audit(name, {**fields, "run_id": run_id})
            progress(name, fields)
        from .parent_service import ensure_parent
        parent_report = ensure_parent(settings, auto_start=not args.no_auto_start, progress=progress.write, event=event,
                                      verbose=progress.verbose)
        credential = api_key(settings)
        audit.secrets = progress.secrets = (credential,)
        owners, skills, specs = components(settings)
        from .local_execution import LocalExecutionTools, inventory
        from .web_fetch import WebFetchTools
        for owner in owners:
            if hasattr(owner, "event"):
                owner.event = event
            if isinstance(owner, (LocalExecutionTools, WebFetchTools)):
                owner.artifact_dir = run_dir / ("python-tools" if isinstance(owner, LocalExecutionTools) else "web-pages")
                owner.retain_content = settings.log_content
            if isinstance(owner, LocalExecutionTools):
                owner.secrets = (credential,)
        def authorize(spec, arguments):
            if args.non_interactive or not sys.stdin.isatty():
                return False
            print(safe_terminal_text(f"本次任务需要 {spec.capability} 能力，工具：{spec.name}。"), file=sys.stderr)
            if spec.capability == "shell":
                print("命令使用当前用户权限；工作目录不是系统沙箱。", file=sys.stderr)
            print(authorization_details(arguments, (credential,)), file=sys.stderr)
            print("允许该能力用于本次任务？[y/N] ", end="", file=sys.stderr, flush=True)
            return input().strip().lower() in ("y", "yes")
        catalog = "Execution context (paths are local configuration, not commands):\n" + json.dumps({
            "workspace": settings.workspace, "shell_default_cwd": settings.workspace,
            "filesystem_scope": settings.filesystem_scope, "execution_mode": "tool_loop",
            "allowed_capabilities": list(settings.allowed_capabilities),
            "skills_dir": settings.skills_dir, "model": settings.model,
            "python_executable": sys.executable, "python_is_venv": sys.prefix != sys.base_prefix,
            "local_environment": inventory(),
            "generated_python_enabled": settings.python_tool_fallback,
            "browser_dependency_check": "environment.browser_check",
            "browser_dependency_repair": "environment.browser_setup (requires shell capability)",
            "information_retrieval_policy": {
                "default": "model_direct_web_search",
                "model_direct_web_search": "网页模型已启用站内 web_search；普通信息问题优先使用模型直接检索结果",
                "local_search": "仅用户明确要求多路/并行抓取、逐页核实、来源报告，或站内搜索不可用时调用 web.search/browser",
            },
        }, ensure_ascii=False)
        catalog += "\nAvailable built-in and local skills, identical for every model (read with skills.read before execution):\n" + json.dumps(skills.catalog(), ensure_ascii=False)
        for name in args.skill:
            selected = skills._read_tool({"name": name})
            catalog += f"\nSelected skill {name}; base_path={selected['base_path']}\n" + selected["content"]
        from .local_tools import LocalTools
        from .python_fallback import PythonFileFallbacks
        local_owner = next((owner for owner in owners if isinstance(owner, LocalTools)), None)
        fallbacks = PythonFileFallbacks(local_owner) if local_owner is not None else None
        registry = ToolRegistry(specs, allowed=settings.allowed_capabilities, authorize=authorize, event=event,
                                secrets=(credential,), fallbacks=fallbacks)
        from .response_files import ResponseStore
        response_store = (ResponseStore(run_dir / "responses", retain_content=audit.content, event=event)
                          if settings.response_delivery == "file" else None)
        client = FusionClient(settings.base_url, credential, model=settings.model, timeout=settings.timeout,
                              allow_remote_http=settings.allow_remote_http, event=event,
                              response_delivery=settings.response_delivery, response_store=response_store,
                              web_recovery_timeout=(parent_report.get("web_recovery_timeout")
                                  if isinstance(parent_report, dict) and parent_report.get("web_recovery_supported") is True else None),
                              web_progress=isinstance(parent_report, dict) and parent_report.get("web_progress_supported") is True)
        event("agent.started", {"model": settings.model, "agent_version": __version__,
            "repair_algorithm": REPAIR_ALGORITHM, "payload": {"agent_source": str(Path(__file__).resolve()), "logs": {
            "global": str(audit.path), "run": str(audit.run_path) if audit.run_log_available else None,
            "result": str(run_dir / "result.md"), "responses": str(run_dir / "responses"),
            "json_repair": str(run_dir / "json-repair"),
            "python_tools": str(run_dir / "python-tools"), "web_pages": str(run_dir / "web-pages")},
            "response_delivery": settings.response_delivery}})
        if progress.verbose:
            progress.write(f"工作目录：{settings.workspace}\n任务记录：{run_dir}")
        runtime = Runtime(client, registry, run_dir, skills_catalog=catalog, max_steps=settings.max_steps,
                          max_context_chars=settings.max_context_chars, event=event,
                          response_store=response_store, save_problem_json=settings.save_problem_json,
                          log_content=audit.content)
        runtime_entered = True
        if session_context is None:
            result = runtime.run(task, skill_names=tuple(args.skill))
        else:
            result = runtime.run(task, skill_names=tuple(args.skill), continuation=session_context.checkpoint())
        event("agent.finished", {"status": result["status"], "steps": result.get("steps"), "error_code": result.get("error_code"), "payload": {"result": result}})
        render_markdown(redact_known(result.get("answer", ""), (credential,)), sys.stdout)
        _record_paths(run_dir, audit, progress)
        if result["status"] == "stopped":
            return 130 if result.get("error_code") == "interrupted" else 3
        return {"completed": 0, "failed": 2}.get(result["status"], 2)
    except KeyboardInterrupt:
        if not finish_preflight("stopped", "interrupted", "已取消启动检查，本次任务未执行。"):
            print("已取消本次操作；已有任务记录保持不变。", file=sys.stderr)
        _record_paths(run_dir, audit, progress)
        return 130
    except Exception as exc:
        if audit:
            audit("agent.execution_error" if runtime_entered else "agent.start_failed", {"run_id": run_id, "error_type": type(exc).__name__,
                  "payload": {"message": str(exc)}})
        code = getattr(exc, "code", None) or "preflight_failed"
        from .contracts import ToolError
        from .client import ClientError
        message = str(exc) if isinstance(exc, (ValueError, ToolError, ClientError, FileExistsError)) else type(exc).__name__
        if not finish_preflight("failed", code, f"启动检查失败，本次任务未执行：{message}"):
            report_error(exc)
        _record_paths(run_dir, audit, progress)
        return 2
    finally:
        if session_context is not None and runtime is not None:
            try:
                captured = session_context.capture(runtime)
                if captured and progress and result and result.get("status") in ("failed", "stopped"):
                    progress.write("当前会话上下文已保留；可输入“继续”或补充要求，/new 开始新任务。")
            except Exception as exc:
                if audit:
                    audit("session.capture_failed", {"error_type": type(exc).__name__})
                if progress:
                    progress.write("本轮会话上下文未能更新；详细任务记录已保留。")
        for owner in reversed(owners):
            try:
                owner.close()
            except Exception:
                pass
        if audit:
            audit.close()


def main(argv=None):
    selected = list(sys.argv[1:] if argv is None else argv)
    command_parser = parser()
    if not selected or all(item in ("-v", "--v", "--verbose") for item in selected):
        if sys.stdin.isatty():
            selected = ["chat", *selected]
        else:
            command_parser.print_help()
            print("交互终端直接执行 ./run.sh；脚本调用请指定 run <任务> 或 chat。", file=sys.stderr)
            return 2
    args = command_parser.parse_args(selected)
    if args.command is None:
        command_parser.print_help()
        return 2
    owners = []
    try:
        if args.command == "init":
            print(initialize(args.output))
            return 0
        if args.command == "repair-json":
            from .repair_json import main as repair_main
            arguments = [str(args.input)]
            if args.output_dir:
                arguments += ["--output-dir", str(args.output_dir)]
            if args.events:
                arguments.append("--events")
            if args.http_response:
                arguments.append("--http-response")
            return repair_main(arguments)
        settings = load_settings(args.config)
        if args.command == "config":
            if args.operation == "show":
                if args.key or args.value: raise ValueError("用法：config show")
                print(json.dumps({"config_file": settings._config_path, "settings": settings_dict(settings)}, ensure_ascii=False, indent=2))
            elif args.operation == "get":
                if args.key not in Settings.__dataclass_fields__ or args.value:
                    raise ValueError("用法：config get 配置名")
                print(json.dumps(getattr(settings, args.key), ensure_ascii=False))
            elif args.operation == "set":
                if not args.key or not args.value: raise ValueError("用法：config set 配置名 值（布尔/数值/数组使用 JSON）")
                target = update_settings(settings, {args.key: setting_value(args.key, " ".join(args.value))}, persist=True)
                print(json.dumps({"saved": True, "config_file": str(target), args.key: getattr(settings, args.key)}, ensure_ascii=False))
            else:
                if args.key or args.value: raise ValueError("用法：config save")
                print(save_settings(settings))
            return 0
        if args.command in ("history", "sessions"):
            from .interactive import local_history, show_history, show_sessions
            history = local_history(settings)
            if args.command == "history":
                show_history(history, query=args.query, run_id=args.show, limit=args.limit)
            else:
                show_sessions(history, session_id=args.session_id, limit=args.limit)
            return 0
        if args.command == "skill-test":
            from .skills import AgentSkillLibrary as SkillLibrary
            from .interactive import display
            result = SkillLibrary(Path(settings.skills_dir)).check(args.name)
            display(result)
            return 0 if result.get("ok") else 2
        if args.command == "doctor":
            return doctor(settings, args.api)
        if args.command in ("skills", "skill"):
            from .skills import AgentSkillLibrary as SkillLibrary
            library = SkillLibrary(Path(settings.skills_dir))
            if args.command == "skills":
                if args.name in (None, "list") and args.read_name is None:
                    operation, selected_name = "list", None
                elif args.name in ("read", "show") and args.read_name:
                    operation, selected_name = "read", args.read_name
                elif args.name and args.read_name is None:
                    operation, selected_name = "read", args.name
                else:
                    raise ValueError("用法：skills [list|名称] 或 skills read 名称")
            else:
                operation, selected_name = args.operation, args.name
            if operation == "list":
                if selected_name:
                    raise ValueError("skill list 不接收名称；使用 skill read 名称")
                print(safe_terminal_text(json.dumps(library.catalog(), ensure_ascii=False, indent=2)))
            elif not selected_name:
                raise ValueError("请指定技能名")
            elif operation == "test":
                report = library.check(selected_name)
                print(safe_terminal_text(json.dumps(report, ensure_ascii=False, indent=2)))
                return 0 if report.get("ok") else 2
            else:
                render_markdown(library.load(selected_name), sys.stdout)
            return 0
        if args.command in ("status", "pack", "skill-demo"):
            from .interactive import display, pack_diagnostics
            if args.command == "status":
                from .parent_service import parent_status
                display(parent_status(settings))
            elif args.command == "pack":
                display(pack_diagnostics(settings, include_content=args.include_content, run_id=args.run_id))
            else:
                from .skill_demo import create_demo_skill
                display(create_demo_skill(args.name, Path(settings.skills_dir)))
            return 0
        if args.command == "tools":
            owners, skills, specs = components(settings)
            print(safe_terminal_text(json.dumps([spec.public() for spec in specs], ensure_ascii=False, indent=2)))
            return 0
        old_settings = settings
        settings = apply_run_overrides(settings, args)
        changes = {key: getattr(settings, key) for key in Settings.__dataclass_fields__
                   if getattr(settings, key) != getattr(old_settings, key)}
        if (changes and settings.auto_save_config and hasattr(settings, "_config_path")
                and not getattr(args, "no_save_config", False)):
            save_settings(settings, keys=changes)
        if getattr(args, "no_save_config", False):
            settings.auto_save_config = False
        args.verbose = settings.verbose
        args.non_interactive = settings.non_interactive
        args.no_auto_start = not settings.auto_start_parent
        args.skill = list(settings.default_skills)
        if args.command == "chat":
            from .interactive import interactive_loop
            return interactive_loop(settings, args, execute_run)
        if bool(args.task) == bool(args.task_file):
            raise ValueError("提供一个任务字符串或 --task-file，不能同时使用")
        if args.task_file:
            selected = Path(args.task_file)
            if selected.stat().st_size > 100000:
                raise ValueError("任务文件超过 100 KB")
            task = selected.read_text(encoding="utf-8")
        else:
            task = args.task
        return execute_run(task, settings, args)
    except (KeyboardInterrupt, EOFError):
        print("已退出。", file=sys.stderr)
        return 130
    except Exception as exc:
        report_error(exc)
        return 2
    finally:
        for owner in reversed(owners):
            try:
                owner.close()
            except Exception:
                pass
