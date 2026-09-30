"""Create a complete, project-local demo without loading a model or running it."""

import ctypes
import errno
import io
import json
import os
from pathlib import Path
import uuid

from .contracts import ToolError
from .skills import SkillLibrary


DESCRIPTION = "当用户要求统计工作区顶层文件并保存 Markdown 清单时使用；不读取文件正文，不递归扫描。"

_BODY = """# 工作区文件清单

## 目的与输入

为用户指定的工作区目录生成可核对的 Markdown 文件清单。输入为工作区内的目录
（默认 `.`）以及新报告路径（默认 `workspace-report.md`）。用户要求递归、读取正文
或扫描工作区外目录时，这个示例不适用，应先按实际任务选择合适的方法。

## 工具与步骤

1. 使用 `files.list`，参数 `path` 为输入目录、`limit:500`、`recursive:false`。
   只记录实际返回的条目，不读取文件正文，不跟随符号链接。
2. 按 `type` 统计已观察到的文件、目录、符号链接和特殊条目，保留路径和字节数。
   `truncated:true` 时写明清单不完整，不能声称得到了目录的完整总数。
3. 使用 `files.write` 把范围、已观察数量、是否截断和文件表格写入新报告；
   `overwrite:false`，需要新建父目录时使用 `create_parents:true`。
   对文件名中的竖线、换行等字符作 Markdown 转义，避免破坏表格。
4. 使用 `files.read` 回读报告，核对路径、范围、数量和截断说明与观察结果一致。
   写入失败或已存在同名文件时，报告失败原因，不把它描述成已保存。
5. 最终给出保存路径、核验结果和扫描范围。报告本身在采集之后创建，
   不应倒填到之前采集的条目里。

## 可选脚本

默认流程只需要 `files` 和 `skills` 能力。如果需要一个确定性的 JSON 清单，
可以按需调用本技能 `scripts/workspace_report.py`；用 `skills.read` 返回的
`base_path` 组成脚本绝对路径，使用当前运行时提供的真实 Python 解释器。
通过 `shell.run` 的 `argv` 数组传入脚本路径、`--workspace`、实际目录路径和
`--limit`、`500`，不要拼接 shell 引号。脚本只读取顶层条目元数据并输出 JSON，
不写文件、不联网、不执行目录内的文件，也不跟随符号链接。
先检查退出码、输出是否截断，再解析 JSON；报告仍使用 `files.write` 保存并回读。

技能不会授予工具权限。可选脚本需要已经授权的 `shell` 能力，未授权时仍可采用
上面的文件工具流程；不要因为技能中写了某个工具就跳过运行时授权。
"""

_SCRIPT = '''#!/usr/bin/env python3
"""List only top-level metadata; no file contents, writes, or symlink traversal."""

import argparse
import json
import os
from pathlib import Path
import stat
import sys


def inspect_workspace(workspace, limit=500):
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 500:
        raise ValueError("limit must be between 1 and 500")
    path = Path(workspace).absolute()
    if ".." in path.parts:
        raise ValueError("workspace must not contain '..'")
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    descriptor = os.open(path.anchor, flags)
    try:
        for part in path.parts[1:]:
            child = os.open(part, flags, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        entries = []
        truncated = False
        with os.scandir(descriptor) as iterator:
            for entry in iterator:
                if len(entries) >= limit:
                    truncated = True
                    break
                info = entry.stat(follow_symlinks=False)
                mode = info.st_mode
                kind = ("symlink" if stat.S_ISLNK(mode) else "directory" if stat.S_ISDIR(mode)
                        else "file" if stat.S_ISREG(mode) else "special")
                entries.append({"path": entry.name, "type": kind, "bytes": info.st_size})
        entries.sort(key=lambda item: item["path"])
        return {"workspace": str(path), "scope": "top-level", "entries": entries,
                "entry_count": len(entries), "truncated": truncated, "follows_symlinks": False}
    finally:
        os.close(descriptor)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--limit", type=int, default=500)
    args = parser.parse_args(argv)
    try:
        result = inspect_workspace(args.workspace, args.limit)
    except (OSError, ValueError) as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
'''


def _open_root(root):
    """Create missing real directories, retaining descriptors at each boundary."""
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    descriptor = os.open(root.anchor, flags)
    try:
        for component in root.parts[1:]:
            try:
                os.mkdir(component, 0o700, dir_fd=descriptor)
            except FileExistsError:
                pass
            child = os.open(component, flags, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def _write_text(directory_fd, filename, content):
    descriptor = os.open(filename, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                         0o600, dir_fd=directory_fd)
    with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
        stream.write(content)
        stream.flush()
        os.fsync(stream.fileno())


def _publish_directory(root_fd, staging, name):
    """Linux atomic directory publication that never replaces an existing entry."""
    library = ctypes.CDLL(None, use_errno=True)
    rename = getattr(library, "renameat2", None)
    if rename is None:
        raise OSError(errno.ENOSYS, "Atomic no-replace directory publication unavailable")
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    if rename(root_fd, os.fsencode(staging), root_fd, os.fsencode(name), 1) != 0:
        error_number = ctypes.get_errno()
        raise OSError(error_number, os.strerror(error_number))


def create_demo_skill(name: str, skills_dir: Path) -> dict:
    """Atomically create a validated demo; existing directories are never replaced.

    The function uses the same name/frontmatter rules as ``SkillLibrary`` and
    emits only a local template. It does not execute its script or call an API.
    """
    if not SkillLibrary._valid_name(name):
        raise ToolError("invalid_skill_name", "技能名称最多 64 个字符，只能使用小写字母、数字及分隔短横线")
    try:
        root = Path(skills_dir).absolute()
        if ".." in root.parts or "\x00" in str(root):
            raise ValueError("skills_dir 不允许包含 '..' 或 NUL")
    except (TypeError, ValueError) as exc:
        raise ToolError("invalid_skill_root", "技能根目录必须是有效路径，不能包含 '..' 或 NUL") from exc

    content = "---\nname: " + name + "\ndescription: " + json.dumps(DESCRIPTION, ensure_ascii=False) + "\n---\n\n" + _BODY
    SkillLibrary._metadata(io.BytesIO(content.encode("utf-8")), name)
    root_fd = stage_fd = scripts_fd = None
    staging = ".skill-demo-" + uuid.uuid4().hex
    created_stage = published = False
    try:
        root_fd = _open_root(root)
        os.mkdir(staging, 0o700, dir_fd=root_fd)
        created_stage = True
        flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
        stage_fd = os.open(staging, flags, dir_fd=root_fd)
        _write_text(stage_fd, "SKILL.md", content)
        os.mkdir("scripts", 0o700, dir_fd=stage_fd)
        scripts_fd = os.open("scripts", flags, dir_fd=stage_fd)
        _write_text(scripts_fd, "workspace_report.py", _SCRIPT)
        os.fsync(scripts_fd)
        os.fsync(stage_fd)
        _publish_directory(root_fd, staging, name)
        published = True
    except OSError as exc:
        if exc.errno in (errno.EEXIST, errno.ENOTEMPTY):
            code, message = "skill_exists", "同名技能目录或文件已存在；请选择新名称，不会覆盖原内容"
        elif exc.errno in (errno.ELOOP, errno.ENOTDIR):
            code, message = "invalid_skill_root", "技能路径含符号链接或不是目录"
        elif exc.errno in (errno.ENOSYS, errno.EOPNOTSUPP, errno.EINVAL):
            code, message = "skill_atomic_unavailable", "当前系统或文件系统不支持安全的原子创建，未发布技能"
        else:
            code, message = "skill_create_failed", f"技能创建失败（errno={exc.errno}）；请检查目录权限及磁盘空间"
        raise ToolError(code, message) from exc
    finally:
        # Cleanup is relative to the already opened staging descriptors; never
        # traverse a replacement root path or recursively remove existing data.
        if created_stage and not published:
            if scripts_fd is not None:
                try:
                    os.unlink("workspace_report.py", dir_fd=scripts_fd)
                except FileNotFoundError:
                    pass
            if stage_fd is not None:
                for entry, remove in (("scripts", os.rmdir), ("SKILL.md", os.unlink)):
                    try:
                        remove(entry, dir_fd=stage_fd)
                    except FileNotFoundError:
                        pass
            if root_fd is not None:
                try:
                    os.rmdir(staging, dir_fd=root_fd)
                except FileNotFoundError:
                    pass
        for descriptor in (scripts_fd, stage_fd, root_fd):
            if descriptor is not None:
                os.close(descriptor)

    destination = root / name
    from .skill_workflow import skill_hints
    return {"name": name, "path": str(destination), "description": DESCRIPTION,
            "files": [str(destination / "SKILL.md"), str(destination / "scripts" / "workspace_report.py")],
            "hints": skill_hints(name, "统计当前工作区顶层文件，保存为新的 workspace-report.md 并回读核对。")}
