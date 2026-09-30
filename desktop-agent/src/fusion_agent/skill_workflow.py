"""Fresh skill selection and bounded, non-executing structural validation."""

import ast
import io
import os
from pathlib import PurePosixPath
import re
import shlex
import stat
from urllib.parse import unquote, urlsplit

from .contracts import ToolError
from .skills import MAX_SKILL_BYTES, AgentSkillLibrary as SkillLibrary

MAX_RESOURCE_FILES = 256
MAX_RESOURCE_DEPTH = 8
MAX_RESOURCE_BYTES = 1024 * 1024
MAX_TOTAL_RESOURCE_BYTES = 4 * 1024 * 1024
_LOCAL_LINK = re.compile(r"\[[^]\n]*\]\(([^)\n]+)\)")
_CODE_RESOURCE = re.compile(r"`((?:scripts|references|resources|assets|agents)/[^`\n]+)`")


def skill_hints(name, task=None):
    """Return runnable commands for the active desktop-agent configuration."""
    if not SkillLibrary._valid_name(name):
        raise ToolError("invalid_skill_name", "技能名称只能使用小写字母、数字及分隔短横线")
    task = task or "请按照此技能处理我的任务，先确认必要输入。"
    return {
        "load": f"/skill load {name}",
        "test": f"/skill test {name}",
        "run": f"/skill run {name} {task}",
        "terminal_test": f"./run.sh skill-test {name}",
        "terminal_run": f"./run.sh run --skill {name} {shlex.quote(task)}",
        "test_scope": "只检查结构、资源引用与 Python 语法，不执行脚本，也不证明任务效果。",
    }


class SkillSelection:
    """Keep names only: every task reopens the selected skills from disk."""

    def __init__(self, library, names=()):
        if isinstance(names, str):
            raise ValueError("names 必须是技能名称列表")
        self.library = library
        self._names = []
        for name in names:
            self.load(name)

    @property
    def names(self):
        return tuple(self._names)

    def load(self, name):
        result = self.library._read_tool({"name": name})
        if name not in self._names:
            self._names.append(name)
        return result

    def unload(self, name):
        if not SkillLibrary._valid_name(name):
            raise ToolError("invalid_skill_name", "技能名称只能使用小写字母、数字及分隔短横线")
        if name not in self._names:
            return False
        self._names.remove(name)
        return True

    def contents_for_task(self):
        # Returning only after every read succeeds prevents a partially loaded
        # selection, and there is no older body to fall back to after an edit.
        return [self.library._read_tool({"name": name}) for name in self._names]

    def reload(self):
        return self.contents_for_task()


def _resource_paths(content):
    """Find explicit local Markdown links and resource paths in code spans."""
    paths = {(target, True) for target in _CODE_RESOURCE.findall(content)}
    for match in _LOCAL_LINK.finditer(content):
        target = match.group(1).strip()
        if target.startswith("<"):
            closing = target.find(">")
            if closing < 0:
                continue
            target = target[1:closing]
        elif ' "' in target:
            target = target.split(' "', 1)[0]
        parsed = urlsplit(target)
        if parsed.scheme or parsed.netloc or not parsed.path:
            continue
        paths.add((unquote(parsed.path), False))
    return paths


def _relative_parts(path, base):
    parsed = PurePosixPath(path)
    if not path or parsed.is_absolute() or "\x00" in path or "\\" in path:
        raise ValueError("资源引用必须是技能目录内的相对路径")
    parts = list(PurePosixPath(base).parts)
    for part in parsed.parts:
        if part == "..":
            if not parts:
                raise ValueError("资源引用越过技能目录边界")
            parts.pop()
        elif part != ".":
            parts.append(part)
    return tuple(parts)


class _CheckLimit(Exception):
    pass


def _read_tree(directory_fd, prefix, files, counters, errors, depth=0):
    """Read relative to held descriptors; never follow a symlink or open FIFO."""
    if depth > MAX_RESOURCE_DEPTH:
        raise _CheckLimit("技能资源目录深度超过 8 层")
    with os.scandir(directory_fd) as entries:
        names = []
        for entry in entries:
            counters["entries"] += 1
            if counters["entries"] > MAX_RESOURCE_FILES:
                raise _CheckLimit("技能目录条目超过 256 个")
            names.append(entry.name)
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC
    for name in sorted(names):
        relative = f"{prefix}/{name}" if prefix else name
        try:
            info = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
            if stat.S_ISDIR(info.st_mode):
                child = os.open(name, flags | os.O_DIRECTORY, dir_fd=directory_fd)
                try:
                    _read_tree(child, relative, files, counters, errors, depth + 1)
                finally:
                    os.close(child)
            elif stat.S_ISREG(info.st_mode):
                descriptor = os.open(name, flags | os.O_NONBLOCK, dir_fd=directory_fd)
                with os.fdopen(descriptor, "rb") as stream:
                    opened = os.fstat(stream.fileno())
                    if not stat.S_ISREG(opened.st_mode):
                        raise ValueError("资源不是普通文件")
                    if opened.st_size > MAX_RESOURCE_BYTES:
                        raise ValueError("单个资源超过 1 MiB，未读取")
                    if counters["bytes"] + opened.st_size > MAX_TOTAL_RESOURCE_BYTES:
                        raise _CheckLimit("技能资源合计超过 4 MiB，停止检查")
                    raw = stream.read(MAX_RESOURCE_BYTES + 1)
                if len(raw) > MAX_RESOURCE_BYTES:
                    raise ValueError("单个资源超过 1 MiB，未读取")
                counters["bytes"] += len(raw)
                if counters["bytes"] > MAX_TOTAL_RESOURCE_BYTES:
                    raise _CheckLimit("技能资源合计超过 4 MiB，停止检查")
                files[relative] = raw
            else:
                raise ValueError("不支持符号链接或特殊文件")
        except (OSError, ValueError) as exc:
            errors.append(f"{relative}: {exc}")


def check_skill(library, name):
    """Return a structural report; successful syntax checks never execute code."""
    if not library._valid_name(name):
        raise ToolError("invalid_skill_name", "技能名称只能使用小写字母、数字及分隔短横线")
    errors, warnings, files, python_scripts = [], [], {}, []
    root_fd = directory_fd = None
    try:
        # Validate body/frontmatter with the ordinary loader as well, so the
        # checker cannot approve something the runtime would refuse to load.
        library.load(name)
        root_fd = library._open_root()
        directory_fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                               dir_fd=root_fd)
        _read_tree(directory_fd, "", files, {"entries": 0, "bytes": 0}, errors)
        skill_bytes = files.get("SKILL.md", b"")
        if len(skill_bytes) > MAX_SKILL_BYTES:
            raise ValueError("SKILL.md 超过 64 KiB")
        stream = io.BytesIO(skill_bytes)
        library._metadata(stream, name)
        body = stream.read().decode("utf-8")
        if not body.strip():
            errors.append("SKILL.md: 缺少技能正文")
        for relative, raw in files.items():
            if relative.endswith(".py") and relative.startswith("scripts/"):
                try:
                    ast.parse(raw, filename=relative)
                    python_scripts.append(relative)
                except (SyntaxError, ValueError, UnicodeError) as exc:
                    errors.append(f"{relative}: Python 语法错误：{exc}")
            elif relative.startswith("scripts/"):
                warnings.append(f"{relative}: 仅检查文件结构，未检查此脚本语言语法")
            if relative.endswith(".md"):
                try:
                    markdown = raw.decode("utf-8")
                    for target, root_based in sorted(_resource_paths(markdown)):
                        # Markdown links are relative to the containing file.
                        # Code-span resource paths are conventionally root-based.
                        base = "." if root_based else str(PurePosixPath(relative).parent)
                        parts = _relative_parts(target, base)
                        candidate = str(PurePosixPath(*parts))
                        if candidate not in files:
                            errors.append(f"{relative}: 缺少引用资源 {target}")
                except (UnicodeError, ValueError) as exc:
                    errors.append(f"{relative}: {exc}")
    except ToolError as exc:
        errors.append(str(exc))
    except (OSError, ValueError, UnicodeError, _CheckLimit) as exc:
        errors.append(f"技能结构无法读取：{exc}")
    finally:
        for descriptor in (directory_fd, root_fd):
            if descriptor is not None:
                os.close(descriptor)
    return {
        "name": name,
        "ok": not errors,
        "status": "structure_failed" if errors else "structure_passed",
        "summary": "结构检查失败" if errors else "结构检查通过；未执行脚本，未验证任务效果",
        "errors": errors,
        "warnings": warnings,
        "checked_files": sorted(files),
        "checked_python_scripts": sorted(python_scripts),
        "executed_scripts": False,
        "hints": skill_hints(name),
    }
