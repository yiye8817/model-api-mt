"""Exact tool aliases and read-only discovery; never execute a guessed substitute."""

import os
from pathlib import Path
import shutil


ALIASES = {
    "file.read": "files.read", "file.list": "files.list", "file.write": "files.write",
    "file.stat": "files.stat", "file.search": "files.search", "file.mkdir": "files.mkdir",
    "file.copy": "files.copy", "file.move": "files.move", "file.delete": "files.delete",
}
_CLI_GROUPS = {
    "read": ("cat", "head", "tail", "bat", "batcat"),
    "list": ("ls", "find"),
    "search": ("rg", "grep", "find"),
    "download": ("curl", "wget"),
    "python": ("python3", "python"),
    "archive": ("tar", "gzip", "zip", "unzip"),
}


def canonical_tool(name, known_tools):
    """An existing real tool always wins over an alias with the same name."""
    if name in known_tools:
        return name
    target = ALIASES.get(name)
    return target if target in known_tools else None


def alternatives(name, catalog, arguments=None):
    """Only PATH inspection. Candidate names are hints, not runnable conversions."""
    names = [item["name"] for item in catalog]
    leaf = str(name).rsplit(".", 1)[-1]
    groups = [group for group, programs in _CLI_GROUPS.items()
              if leaf == group or name in programs]
    programs = list(dict.fromkeys(program for group in groups or _CLI_GROUPS
                                  for program in _CLI_GROUPS[group]))
    installed = []
    for program in programs:
        located = shutil.which(program)
        if located:
            installed.append({"name": program, "path": located})
    feature = "read" if name in _CLI_GROUPS["read"] else "list" if name == "ls" else leaf
    preferred = [tool for tool in ("files." + feature,) if tool in names]
    return {
        "requested_tool_or_program": name,
        "original_arguments": arguments or {},
        "preferred_tools": preferred,
        "available_tools": names,
        "installed_cli_candidates": installed,
        "automatic_execution": False,
        "python_fallback": ({
            "tool": "python.run", "native_first_tool": "local.run",
            "required_capability": "shell", "automatic_execution": False,
            "source_required": True, "preserve_original_target": True,
        } if "python.run" in names else None),
        "instruction": (
            "先选同功能的现有工具；候选 CLI 仅表示已安装，不保证参数兼容。"
            "请保留原任务、原目标路径及参数含义，按真实工具 schema 重新生成一个动作；"
            "使用 CLI 时通过 local.run（优先）或 shell.run 的 argv 并取得 shell 授权。"
            "不能通过候选绕过已拒绝的能力或文件工作区限制。"
            "原动作尚未执行，候选不会自行运行；对于已有不确定结果须先核验，不能重放。"
            + (" 若确实没有同功能工具，使用 python.run 编写完整 Python 实现；优先标准库，"
               "通过 input 传递原参数，执行前保存脚本，仍需 shell 授权及对应任务范围。"
               "可使用 local.run 的 argv 与 fallback_python：原命令不存在且未启动才自动改用 Python。"
               "没有 shell 范围或授权时只能用现有受控工具，不能借生成代码绕过权限。"
               if "python.run" in names else "")
        ),
    }


def simple_read_target(arguments, workspace):
    """Recognize only a literal single-file read with no flags or shell syntax.

    This proof allows a complete files.read to discharge a *not-started* cat
    attempt. Unknown commands and more complex argv never acquire this proof.
    """
    argv = arguments.get("argv")
    if (arguments.get("command") is not None or not isinstance(argv, list)
            or not argv or argv[0] not in ("cat", "file.read")):
        return None
    operands = argv[1:]
    explicit_end = len(operands) == 2 and operands[0] == "--"
    if explicit_end:
        operands = operands[1:]
    if len(operands) != 1 or not isinstance(operands[0], str) or not operands[0] or operands[0] == "-":
        return None
    if operands[0].startswith("-") and not explicit_end:
        return None
    try:
        root = Path(workspace).resolve()
        cwd = (root / arguments.get("cwd", ".")).resolve()
        cwd.relative_to(root)
        target = (cwd / operands[0]).resolve()
        return target.relative_to(root).as_posix()
    except (ValueError, TypeError, RuntimeError, OSError):
        return None


def executable_missing(executable, cwd, env):
    """ENOENT can also mean missing cwd/interpreter; only claim a missing program."""
    if not Path(cwd).is_dir():
        return False
    if os.path.dirname(executable):
        target = Path(executable)
        if not target.is_absolute():
            target = Path(cwd) / target
        return not target.exists()
    search = os.pathsep.join(str(Path(cwd) / entry) if not os.path.isabs(entry) else entry
                             for entry in env.get("PATH", os.defpath).split(os.pathsep))
    return shutil.which(executable, path=search) is None
