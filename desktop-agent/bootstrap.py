"""Select an isolated Agent Python before a browser task starts; install no packages here."""

import argparse
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parent


def browser_requested(arguments):
    arguments = list(arguments)
    while arguments and arguments[0] in ("-v", "--v", "--verbose"):
        arguments.pop(0)
    if not arguments:
        if not sys.stdin.isatty():
            return False
        arguments = ["chat"]
    if arguments[0] not in ("run", "chat") or any(flag in arguments for flag in ("-h", "--help")):
        return False
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--config")
    parser.add_argument("--allow", default="")
    options, _ = parser.parse_known_args(arguments[1:])
    if {item.strip() for item in options.allow.split(",")} & {"browser"}:
        return True
    # Reuse the application's validated config and path rules; never eval shell
    # text or echo a private configuration while selecting an interpreter.
    from fusion_agent.config import load_settings
    return "browser" in load_settings(options.config).allowed_capabilities


def select_python(arguments, root=ROOT):
    current = sys.executable
    # Explicit interpreter choice and active virtual environments stay intact.
    if os.environ.get("FUSION_AGENT_PYTHON") or sys.prefix != sys.base_prefix:
        return current
    if not browser_requested(arguments):
        return current
    environment = root / ".venv"
    if environment.is_symlink():
        raise ValueError("Agent .venv 不能是符号链接；请用 FUSION_AGENT_PYTHON 显式指定已有环境。")
    executable = environment / "bin/python"
    if not executable.is_file() or not os.access(executable, os.X_OK):
        print("正在创建浏览器任务的隔离环境，依赖将在任务中按授权安装。", file=sys.stderr, flush=True)
        result = subprocess.run([current, "-m", "venv", str(environment)], timeout=120)
        if result.returncode:
            raise RuntimeError("Agent 虚拟环境创建失败，请检查 Python venv 支持；未调用模型或执行任务。")
    if not executable.is_file() or not os.access(executable, os.X_OK):
        raise RuntimeError("Agent 虚拟环境没有可用 Python；未调用模型或执行任务。")
    return str(executable)


def main(arguments=None):
    arguments = sys.argv[1:] if arguments is None else arguments
    try:
        executable = select_python(arguments)
        os.execv(executable, [executable, "-m", "fusion_agent", *arguments])
    except (OSError, RuntimeError, ValueError, subprocess.TimeoutExpired) as exc:
        print(f"Agent 启动失败：{exc}", file=sys.stderr, flush=True)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
