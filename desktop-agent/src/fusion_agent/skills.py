"""Dependency-free skill readers, including merged built-in/user discovery.

Only single-line ``name``/``description`` frontmatter is accepted. Discovery
reads metadata only; it does not execute scripts or add tool permissions.
"""

import json
import os
import re
import stat
from pathlib import Path

from .contracts import ToolError, ToolSpec

_NAME = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*\Z")
MAX_SKILL_BYTES = 64 * 1024
MAX_HEADER_BYTES = 8192
MAX_DIRECTORIES = 512


class SkillLibrary:
    def __init__(self, root: Path):
        # Do not resolve symlinks: each component is opened with O_NOFOLLOW.
        self.root = Path(os.path.abspath(root))

    @staticmethod
    def _valid_name(name):
        return isinstance(name, str) and len(name) <= 64 and bool(_NAME.fullmatch(name))

    def _open_root(self):
        flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
        current = os.open(self.root.anchor, flags)
        try:
            for part in self.root.parts[1:]:
                child = os.open(part, flags, dir_fd=current)
                os.close(current)
                current = child
            return current
        except BaseException:
            os.close(current)
            raise

    @staticmethod
    def _open_file(root_fd, name):
        directory = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                            dir_fd=root_fd)
        try:
            descriptor = os.open("SKILL.md", os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK,
                                 dir_fd=directory)
        finally:
            os.close(directory)
        try:
            info = os.fstat(descriptor)
            if not stat.S_ISREG(info.st_mode):
                raise ValueError("SKILL.md 必须是普通文件")
            if info.st_size > MAX_SKILL_BYTES:
                raise ValueError("SKILL.md 超过 64 KiB")
            return os.fdopen(descriptor, "rb")
        except BaseException:
            os.close(descriptor)
            raise

    @staticmethod
    def _read_header(stream):
        lines = []
        total = 0
        while total <= MAX_HEADER_BYTES:
            line = stream.readline(MAX_HEADER_BYTES + 1 - total)
            if not line:
                raise ValueError("缺少完整 frontmatter")
            total += len(line)
            if total > MAX_HEADER_BYTES:
                break
            decoded = line.decode("utf-8").rstrip("\r\n")
            if not lines and decoded != "---":
                raise ValueError("文件必须以 --- frontmatter 开始")
            if lines and decoded == "---":
                return lines[1:]
            lines.append(decoded)
        raise ValueError("frontmatter 超过 8 KiB")

    @classmethod
    def _metadata(cls, stream, directory_name):
        metadata = {}
        for line in cls._read_header(stream):
            key, separator, value = line.partition(":")
            if not separator or key not in ("name", "description") or key in metadata:
                raise ValueError("frontmatter 仅允许 name 和 description 各出现一次")
            value = value.strip()
            if value.startswith('"'):
                value = json.loads(value)
            elif (not value or value[0] in "'[{&*!>|%@`" or " #" in value or ": " in value):
                raise ValueError("复杂 frontmatter 字符串请使用 JSON 双引号")
            if not isinstance(value, str) or not value.strip() or any(ord(c) < 32 for c in value):
                raise ValueError("frontmatter 值必须是非空单行字符串")
            metadata[key] = value
        if set(metadata) != {"name", "description"}:
            raise ValueError("缺少 name 或 description")
        if not cls._valid_name(metadata["name"]) or metadata["name"] != directory_name:
            raise ValueError("name 必须与目录一致，且只含小写字母、数字及分隔短横线")
        if len(metadata["description"]) > 512:
            raise ValueError("description 超过 512 字符")
        return metadata

    def catalog(self):
        try:
            root_fd = self._open_root()
        except FileNotFoundError:
            return []
        except OSError as exc:
            raise ToolError("invalid_skill_root", "技能根目录不可读取，或路径包含符号链接") from exc
        try:
            names = []
            with os.scandir(root_fd) as entries:
                for index, entry in enumerate(entries):
                    if index >= MAX_DIRECTORIES:
                        raise ToolError("skill_limit", "技能根目录条目超过 512 个")
                    if self._valid_name(entry.name) and entry.is_dir(follow_symlinks=False):
                        names.append(entry.name)
            result = []
            for name in sorted(names):
                try:
                    with self._open_file(root_fd, name) as stream:
                        result.append(self._metadata(stream, name))
                except (OSError, ValueError, UnicodeError):
                    # One malformed/unreadable skill must not disable the others.
                    continue
            return result
        finally:
            os.close(root_fd)

    def load(self, name):
        if not self._valid_name(name):
            raise ToolError("invalid_skill_name", "技能名称只能使用小写字母、数字及分隔短横线")
        try:
            root_fd = self._open_root()
            try:
                with self._open_file(root_fd, name) as stream:
                    self._metadata(stream, name)
                    body_offset = stream.tell()
                    stream.seek(0)
                    contents = stream.read(MAX_SKILL_BYTES + 1)
                    if len(contents) > MAX_SKILL_BYTES:
                        raise ValueError("SKILL.md 超过 64 KiB")
                    if not contents[body_offset:].decode("utf-8").strip():
                        raise ValueError("SKILL.md 缺少技能正文")
                    return contents.decode("utf-8")
            finally:
                os.close(root_fd)
        except FileNotFoundError as exc:
            raise ToolError("skill_not_found", "未找到指定技能的 SKILL.md") from exc
        except (OSError, ValueError, UnicodeError) as exc:
            raise ToolError("invalid_skill", "无法加载技能：路径、编码、frontmatter 或正文不符合要求") from exc

    def check(self, name):
        """Inspect current files without running the skill or any of its scripts."""
        from .skill_workflow import check_skill
        return check_skill(self, name)

    def specs(self):
        return [
            ToolSpec("skills.list", "列出内置与用户目录的全部可用技能及来源，不执行任何技能脚本。",
                     {"type": "object", "properties": {}, "additionalProperties": False},
                     "skills", False, lambda args: {"skills": self.catalog()}),
            ToolSpec("skills.read", "按需阅读技能正文；技能文字不会授予额外工具权限。",
                     {"type": "object", "properties": {"name": {"type": "string", "maxLength": 64}},
                      "required": ["name"], "additionalProperties": False},
                     "skills", False, self._read_tool),
        ]

    def _read_tool(self, args):
        name = args.get("name")
        content = self.load(name)
        return {"name": name, "base_path": str(self.root / name), "content": content}


# Keep the source-tree location for editable checkouts (it is also the user's
# default ``skills/`` directory), but ship a package-local copy for wheels and
# standalone installs where the repository-level directory is not present.
_SOURCE_BUILTIN_SKILLS = Path(__file__).resolve().parents[2] / "skills"
_PACKAGED_BUILTIN_SKILLS = Path(__file__).resolve().parent / "builtin_skills"
BUILTIN_SKILLS = (_SOURCE_BUILTIN_SKILLS if _SOURCE_BUILTIN_SKILLS.is_dir()
                  else _PACKAGED_BUILTIN_SKILLS)


class AgentSkillLibrary(SkillLibrary):
    """User directory + installed built-ins, shared by every model.

    `root` deliberately remains the writable user directory for skill recording.
    Reading/checking a built-in always uses its real resource directory. A local
    name wins an unqualified collision; builtin:name remains explicitly visible.
    """
    def __init__(self, root: Path, builtin_root: Path | None = None):
        super().__init__(root)
        self.local = SkillLibrary(self.root)
        self.builtin = SkillLibrary(builtin_root or BUILTIN_SKILLS)
        self.same_root = self.root == self.builtin.root

    @staticmethod
    def _split(name):
        if not isinstance(name, str):
            raise ToolError("invalid_skill_name", "技能名必须是字符串")
        scope, separator, bare = name.partition(":")
        if not separator:
            scope, bare = "", name
        if scope not in ("", "builtin", "local") or not SkillLibrary._valid_name(bare):
            raise ToolError("invalid_skill_name", "使用技能名或 builtin:名称 / local:名称")
        return scope, bare

    @staticmethod
    def _valid_name(name):
        try:
            AgentSkillLibrary._split(name)
            return True
        except ToolError:
            return False

    def _locate(self, name):
        scope, bare = self._split(name)
        if scope == "builtin" or self.same_root and scope != "local":
            return self.builtin, bare, "builtin"
        if scope == "local":
            return self.local, bare, "local"
        # lexists detects a malformed/symlink local override: report it instead
        # of silently substituting a different skill with the same name.
        if os.path.lexists(self.root / bare):
            return self.local, bare, "local"
        return self.builtin, bare, "builtin"

    def catalog(self):
        builtin = self.builtin.catalog()
        local = [] if self.same_root else self.local.catalog()
        names = {item["name"] for item in local}
        rows = []
        for scope, library, entries in (("local", self.local, local), ("builtin", self.builtin, builtin)):
            for item in entries:
                bare = item["name"]
                name = f"builtin:{bare}" if scope == "builtin" and bare in names else bare
                rows.append({**item, "name": name, "source": scope, "id": f"{scope}:{bare}",
                             "base_path": str(library.root / bare),
                             "shadowed": scope == "builtin" and bare in names})
        return sorted(rows, key=lambda item: (item["name"], item["source"]))

    def load(self, name):
        library, bare, _ = self._locate(name)
        return library.load(bare)

    def check(self, name):
        library, bare, source = self._locate(name)
        result = library.check(bare)
        return {**result, "name": name, "source": source, "base_path": str(library.root / bare)}

    def _read_tool(self, args):
        name = args.get("name")
        library, bare, source = self._locate(name)
        return {"name": name, "source": source, "base_path": str(library.root / bare),
                "content": library.load(bare)}

    def specs(self):
        specs = super().specs()
        # Qualified names may add an 8-character scope prefix.
        specs[1].parameters["properties"]["name"]["maxLength"] = 80
        return specs
