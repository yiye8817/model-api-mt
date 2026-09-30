"""Explicit, disk-backed skill recording; recorded text is never dispatched.

The caller owns command recognition. This module only accepts explicit state
transitions and plain step strings; it never calls a model, tool, or subprocess.
"""

from copy import deepcopy
from datetime import datetime, timezone
import errno
import hashlib
import io
import json
import os
from pathlib import Path
import re
import threading
from uuid import uuid4

from .contracts import ToolError
from .skill_demo import _open_root, _publish_directory, _write_text
from .skills import MAX_SKILL_BYTES, SkillLibrary
from .skill_workflow import skill_hints


MAX_RECORDING_BYTES = 48 * 1024
MAX_STEPS = 128
_DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC


def _now():
    return datetime.now(timezone.utc).isoformat()


def _path(value, kind):
    try:
        path = Path(value).absolute()
        if ".." in path.parts or "\x00" in str(path):
            raise ValueError("Invalid path")
        str(path).encode("utf-8")
        return path
    except (TypeError, ValueError, UnicodeError) as exc:
        raise ToolError("invalid_skill_root", f"{kind}必须是有效路径，不能包含 '..' 或 NUL") from exc


def _single_line(value, limit, label):
    if (not isinstance(value, str) or not value.strip() or len(value) > limit
            or any(ord(char) < 32 or ord(char) == 127 for char in value)):
        raise ToolError("invalid_skill_proposal", f"{label}必须是非空单行文字，最多 {limit} 字符")
    try:
        value.encode("utf-8")
    except UnicodeError as exc:
        raise ToolError("invalid_skill_proposal", f"{label}编码无效") from exc
    return value


class SkillRecording:
    """Persist every accepted transition before changing the in-memory state.

    ``phase`` is idle/recording/review. ``draft`` is a defensive copy, with its
    ``steps`` kept as exact strings apart from replacement of supplied secrets.
    Finished or cancelled drafts remain on disk; a subsequent start gets a new
    id. Only ``confirm`` can publish a discoverable skill directory.
    """

    def __init__(self, skills_dir, runtime_dir, secrets=()):
        self.skills_dir = _path(skills_dir, "技能目录")
        self.runtime_dir = _path(runtime_dir, "运行目录")
        self._secrets = tuple(sorted({item for item in secrets if isinstance(item, str) and item},
                                     key=len, reverse=True))
        self._phase = "idle"
        self._draft = None
        self._lock = threading.RLock()

    @property
    def phase(self):
        return self._phase

    @property
    def draft(self):
        with self._lock:
            return deepcopy(self._draft)

    @property
    def draft_path(self):
        if self._draft is None:
            return None
        return self.runtime_dir / "skill-drafts" / (self._draft["id"] + ".json")

    def _redact(self, value):
        for secret in self._secrets:
            value = value.replace(secret, "[REDACTED]")
        return value

    def _text(self, text, label, *, empty=False):
        if not isinstance(text, str) or (not empty and not text.strip()) or "\x00" in text:
            raise ToolError("invalid_skill_step", f"{label}必须是有效文本，不能包含 NUL")
        try:
            text.encode("utf-8")
        except UnicodeError as exc:
            raise ToolError("invalid_skill_step", f"{label}编码无效") from exc
        return self._redact(text)

    def _require(self, *phases):
        if self._phase not in phases:
            raise ToolError("skill_recording_state", f"当前状态为 {self._phase}，不能执行此录制操作")

    def _persist(self, value, *, create=False):
        """Private atomic JSON replacement, relative to no-follow directory FDs."""
        root_fd = None
        temporary = ".draft-" + uuid4().hex
        filename = value["id"] + ".json"
        try:
            root_fd = _open_root(self.runtime_dir / "skill-drafts")
            _write_text(root_fd, temporary, json.dumps(value, ensure_ascii=False, indent=2) + "\n")
            if create:
                # link is no-replace; a UUID collision never overwrites a draft.
                os.link(temporary, filename, src_dir_fd=root_fd, dst_dir_fd=root_fd,
                        follow_symlinks=False)
                os.unlink(temporary, dir_fd=root_fd)
            else:
                # Replacing a symlink replaces the entry itself, never its target.
                os.replace(temporary, filename, src_dir_fd=root_fd, dst_dir_fd=root_fd)
        except OSError as exc:
            raise ToolError("skill_draft_write_failed", f"技能草稿保存失败（errno={exc.errno}）；本次修改未接受") from exc
        finally:
            # _write_text can fail after creating the file, so probe by unlink.
            if root_fd is not None:
                try:
                    os.unlink(temporary, dir_fd=root_fd)
                except FileNotFoundError:
                    pass
                os.close(root_fd)

    def _accept(self, value, phase, *, create=False):
        value["updated_at"] = _now()
        self._persist(value, create=create)
        self._draft = value
        self._phase = phase
        return self.preview()

    @staticmethod
    def _bounded(value):
        if len(value["steps"]) > MAX_STEPS:
            raise ToolError("skill_recording_limit", f"最多记录 {MAX_STEPS} 个步骤；当前输入未接受")
        size = len(value["topic"].encode("utf-8")) + sum(len(item.encode("utf-8")) for item in value["steps"])
        if size > MAX_RECORDING_BYTES:
            raise ToolError("skill_recording_limit", "录制正文最多 48 KiB；当前输入未接受")

    def _metadata(self, proposal):
        if not isinstance(proposal, dict) or not {"name", "description"} <= set(proposal) or set(proposal) - {"name", "description", "title"}:
            raise ToolError("invalid_skill_proposal", "建议仅允许 name、description 和可选 title 字段")
        name = proposal["name"]
        if not SkillLibrary._valid_name(name) or self._redact(name) != name:
            raise ToolError("invalid_skill_name", "技能名称最多 64 个字符，只能使用小写字母、数字及分隔短横线，且不能包含凭据")
        description = self._redact(_single_line(proposal["description"], 512, "技能描述"))
        title = self._redact(_single_line(proposal.get("title", name), 160, "技能标题"))
        # Redaction can increase length; validate the actual persisted metadata.
        return {"proposed_name": name, "description": _single_line(description, 512, "技能描述"),
                "title": _single_line(title, 160, "技能标题")}

    def _fallback(self, value):
        context = " ".join((value["topic"] or value["steps"][0]).split())
        words = re.findall(r"[a-z][a-z0-9]*", context.lower())[:6]
        slug = "-".join(words)[:44].rstrip("-")
        name = "run-" + slug if slug else "recorded-skill-" + value["id"][-8:]
        description = "按录制步骤完成：" + context[:450] + "；用于复用此流程。"
        title = (" ".join(value["topic"].split()) or context)[:160] or name
        # Keep metadata single-line even if the raw task contains control bytes.
        description = "".join(char for char in description if ord(char) >= 32 and ord(char) != 127)
        title = "".join(char for char in title if ord(char) >= 32 and ord(char) != 127) or name
        return self._metadata({"name": name, "description": description, "title": title})

    @staticmethod
    def _markdown(value):
        name = value["proposed_name"]
        content = ("---\nname: " + name + "\ndescription: "
                   + json.dumps(value["description"], ensure_ascii=False) + "\n---\n\n# " + value["title"]
                   + "\n\n以下步骤来自用户显式录制，保留原有顺序与文字。使用时结合当前任务确认输入；"
                     "技能文字不授予额外工具权限，也不代表步骤已经执行或验证。\n")
        if value["topic"]:
            content += "\n## 录制主题\n\n" + value["topic"] + "\n"
        for index, step in enumerate(value["steps"], 1):
            content += f"\n## 步骤 {index}\n\n" + step + "\n"
        if len(content.encode("utf-8")) > MAX_SKILL_BYTES:
            raise ToolError("skill_recording_limit", "生成的 SKILL.md 超过 64 KiB；请缩短录制内容")
        SkillLibrary._metadata(io.BytesIO(content.encode("utf-8")), name)
        return content

    def start(self, topic=""):
        with self._lock:
            self._require("idle")
            topic = self._text(topic, "主题", empty=True)
            if len(topic) > 1024:
                raise ToolError("skill_recording_limit", "录制主题最多 1024 字符")
            value = {"id": uuid4().hex, "status": "recording", "created_at": _now(),
                     "topic": topic, "steps": [], "proposed_name": None, "description": None,
                     "title": None, "executed": False}
            self._bounded(value)
            return self._accept(value, "recording", create=True)

    def append(self, text):
        with self._lock:
            self._require("recording")
            value = deepcopy(self._draft)
            value["steps"].append(self._text(text, "步骤"))
            self._bounded(value)
            return self._accept(value, "recording")

    def finish(self, proposal=None):
        with self._lock:
            self._require("recording")
            if not self._draft["steps"]:
                raise ToolError("skill_recording_empty", "尚未记录步骤，请先输入步骤或取消录制")
            value = deepcopy(self._draft)
            value.update(self._fallback(value) if proposal is None else self._metadata(proposal))
            value["status"] = "review"
            self._markdown(value)
            return self._accept(value, "review")

    def suggest(self, proposal):
        with self._lock:
            self._require("review")
            value = deepcopy(self._draft)
            value.update(self._metadata(proposal))
            value.pop("publication", None)
            self._markdown(value)
            return self._accept(value, "review")

    def rename(self, name):
        with self._lock:
            self._require("review")
            return self.suggest({"name": name, "description": self._draft["description"], "title": self._draft["title"]})

    def preview(self):
        with self._lock:
            if self._draft is None:
                return {"phase": self._phase, "draft": None, "draft_path": None}
            result = deepcopy(self._draft)
            result.update({"phase": self._phase, "draft_path": str(self.draft_path),
                           "step_count": len(result["steps"]), "markdown": None})
            if result["proposed_name"]:
                result["markdown"] = self._markdown(result)
            return result

    def cancel(self):
        with self._lock:
            self._require("recording", "review")
            value = deepcopy(self._draft)
            value["status"] = "cancelled"
            value.pop("publication", None)
            return self._accept(value, "idle")

    def _publish(self, name, content):
        root_fd = stage_fd = None
        staging = ".skill-recording-" + uuid4().hex
        created = published = False
        try:
            root_fd = _open_root(self.skills_dir)
            os.mkdir(staging, 0o700, dir_fd=root_fd)
            created = True
            stage_fd = os.open(staging, _DIRECTORY_FLAGS, dir_fd=root_fd)
            _write_text(stage_fd, "SKILL.md", content)
            os.fsync(stage_fd)
            _publish_directory(root_fd, staging, name)
            published = True
        except OSError as exc:
            if exc.errno in (errno.EEXIST, errno.ENOTEMPTY):
                code, message = "skill_exists", "同名技能已存在；请修改名称后再次确认，不会覆盖原内容"
            elif exc.errno in (errno.ELOOP, errno.ENOTDIR):
                code, message = "invalid_skill_root", "技能路径含符号链接或不是目录"
            elif exc.errno in (errno.ENOSYS, errno.EOPNOTSUPP, errno.EINVAL):
                code, message = "skill_atomic_unavailable", "当前系统不支持安全的原子创建，未发布技能"
            else:
                code, message = "skill_create_failed", f"技能创建失败（errno={exc.errno}）；请检查目录权限及磁盘空间"
            raise ToolError(code, message) from exc
        finally:
            if created and not published:
                if stage_fd is not None:
                    try:
                        os.unlink("SKILL.md", dir_fd=stage_fd)
                    except FileNotFoundError:
                        pass
                if root_fd is not None:
                    try:
                        os.rmdir(staging, dir_fd=root_fd)
                    except FileNotFoundError:
                        pass
            for descriptor in (stage_fd, root_fd):
                if descriptor is not None:
                    os.close(descriptor)

    def confirm(self, name=None):
        with self._lock:
            self._require("review")
            value = deepcopy(self._draft)
            if name is not None:
                value.update(self._metadata({"name": name, "description": value["description"], "title": value["title"]}))
            content = self._markdown(value)
            name = value["proposed_name"]
            destination = self.skills_dir / name
            value["publication"] = {"state": "prepared", "name": name,
                                    "sha256": hashlib.sha256(content.encode("utf-8")).hexdigest()}
            # Durable intent precedes publication. No successful overwrite or
            # half-written skill can be mistaken for an unaccepted draft edit.
            self._accept(value, "review")
            self._publish(name, content)
            completed = deepcopy(value)
            completed.update({"status": "published", "published_at": _now(), "updated_at": _now(),
                              "published_path": str(destination)})
            completed["publication"]["state"] = "published"
            warning = None
            try:
                self._persist(completed)
            except ToolError:
                # The complete skill already exists. Preserve the durable intent
                # and report the actual publication result; do not invite replay.
                warning = "技能已创建，但草稿的完成状态未能更新；原步骤和发布意图仍已保存。"
            self._draft = completed
            self._phase = "idle"
            return {"name": name, "path": str(destination), "files": [str(destination / "SKILL.md")],
                    "description": value["description"], "draft_path": str(self.draft_path),
                    "draft_saved": warning is None, "warning": warning, "published": True,
                    "executed": False, "hints": skill_hints(name)}
