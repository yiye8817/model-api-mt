#!/usr/bin/env python3
"""Write a small local environment report without scanning personal files."""

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import platform
import shutil


def write_report(workspace, output):
    workspace = Path(workspace).absolute()
    relative = Path(output)
    if relative.is_absolute() or not relative.parts or any(part in ("..", ".") for part in relative.parts):
        raise ValueError("--output 必须是工作区内的相对文件路径，且不能包含 ..")
    if relative.suffix.lower() != ".md":
        raise ValueError("--output 必须使用 .md 扩展名")
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    directory = os.open(workspace.anchor, flags)
    try:
        for part in workspace.parts[1:]:
            child = os.open(part, flags, dir_fd=directory)
            os.close(directory)
            directory = child
        usage = shutil.disk_usage(directory)
        report = "\n".join([
            "# 基础环境报告", "",
            f"生成时间（UTC）：{datetime.now(timezone.utc).isoformat(timespec='seconds')}", "",
            "| 项目 | 值 |", "| --- | --- |",
            f"| 操作系统 | {platform.system()} |",
            f"| 内核版本 | {platform.release()} |",
            f"| CPU 架构 | {platform.machine()} |",
            f"| Python | {platform.python_implementation()} {platform.python_version()} |",
            f"| 磁盘总量 | {usage.total / (1024 ** 3):.2f} GiB |",
            f"| 磁盘可用量 | {usage.free / (1024 ** 3):.2f} GiB |", "",
            "磁盘统计对应调用者明确指定的工作目录所在文件系统。",
            "本报告未读取账号、登录数据、环境变量全集或工作目录中的文件内容。", "",
        ])
        for part in relative.parts[:-1]:
            try:
                os.mkdir(part, 0o700, dir_fd=directory)
            except FileExistsError:
                pass
            child = os.open(part, flags, dir_fd=directory)
            os.close(directory)
            directory = child
        descriptor = os.open(relative.name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                             0o600, dir_fd=directory)
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            stream.write(report)
    finally:
        os.close(directory)
    return {"path": str(workspace / relative), "bytes": len(report.encode("utf-8"))}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", default=".")
    parser.add_argument("--output", default="reports/system-report.md")
    args = parser.parse_args()
    try:
        print(json.dumps(write_report(args.workspace, args.output), ensure_ascii=False))
    except (OSError, ValueError) as exc:
        parser.exit(1, f"无法生成报告：{exc}\n")


if __name__ == "__main__":
    main()
