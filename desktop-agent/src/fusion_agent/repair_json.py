"""Offline replay of model protocol repair. No API, tools, shell or Agent.run.

Usage: python -m fusion_agent.repair_json original.invalid.json
       python -m fusion_agent.repair_json events.jsonl --events --output-dir out
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
import time
from uuid import uuid4

from .payload_repair import REPAIR_ALGORITHM

from .response_files import RepairArchive, ResponseFileError, json_bytes, private_directory, private_write


MAX_INPUT_BYTES = 32 * 1024 * 1024
EVENT_NAMES = frozenset({"model.raw_reply", "model.response", "model.invalid_protocol",
                         "model.local_protocol_repair_failed", "model.json_repair_started",
                         "model.json_repair_failed", "model.json_repair_succeeded",
                         "model.protocol_normalized", "model.protocol_repaired"})


def _read_input(path: Path) -> str:
    if path.is_symlink():
        raise ValueError("回放输入不能是符号链接。")
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_INPUT_BYTES:
            raise ValueError("回放输入必须是最大 32 MiB 的普通 UTF-8 文件。")
        with os.fdopen(fd, "rb", closefd=False) as file:
            raw = file.read(MAX_INPUT_BYTES + 1)
        if len(raw) > MAX_INPUT_BYTES:
            raise ValueError("回放输入超过 32 MiB 限制。")
        return raw.decode("utf-8-sig")
    finally:
        os.close(fd)


def extract_event_replies(text: str) -> tuple[list[tuple[str, dict]], list[str]]:
    """Reassemble Audit payload segments; never decode twice or follow paths.

    The outer JSONL payload is a JSON string. Its raw_reply/reply/content value
    is the exact *inner* malformed model JSON, not the printable log escaping.
    Missing/truncated/duplicate segments produce warnings, not guessed replies.
    """
    groups = {}
    warnings = []
    for line_number, line in enumerate(text.splitlines(), 1):
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except (ValueError, RecursionError):
            warnings.append(f"第 {line_number} 行不是合法 JSONL，已跳过。")
            continue
        if not isinstance(record, dict) or record.get("event") not in EVENT_NAMES:
            continue
        if record.get("truncated") or record.get("payload_omitted"):
            warnings.append(f"第 {line_number} 行正文缺失或被截断，无法回放。")
            continue
        total, part = record.get("parts", 1), record.get("part", 1)
        if type(total) is not int or type(part) is not int or not 1 <= part <= total <= 512:
            warnings.append(f"第 {line_number} 行分片编号不合法，已跳过。")
            continue
        if not isinstance(record.get("payload"), (str, dict)):
            continue
        identity = record.get("payload_id") if total > 1 else line_number
        key = (str(record.get("run_id", "")), str(record["event"]), str(identity))
        if key not in groups:
            if len(groups) >= 4096:
                warnings.append("已达到 4096 组日志事件上限；剩余内容未读取。")
                break
            groups[key] = {"parts": {}, "total": total, "bad": False,
                           "line": line_number, "event": record["event"]}
        group = groups[key]
        if total != group["total"] or part in group["parts"]:
            group["bad"] = True
        group["parts"][part] = record["payload"]
    samples, seen = [], set()
    for group in groups.values():
        if group["bad"] or len(group["parts"]) != group["total"]:
            warnings.append(f"第 {group['line']} 行开始的正文分片不完整或重复，已跳过。")
            continue
        try:
            parts = [group["parts"][i] for i in range(1, group["total"] + 1)]
            payload = parts[0] if len(parts) == 1 and isinstance(parts[0], dict) else json.loads("".join(parts))
        except (TypeError, ValueError, RecursionError):
            warnings.append(f"第 {group['line']} 行开始的 payload 无法解码，已跳过。")
            continue
        if not isinstance(payload, dict):
            continue
        source = next((payload[key] for key in ("raw_reply", "reply", "content")
                       if isinstance(payload.get(key), str)), None)
        # A response_file pathname in an event is NOT permission to read a file.
        if source is None:
            continue
        digest = hashlib.sha256(source.encode("utf-8", errors="surrogatepass")).hexdigest()
        if digest in seen:
            continue
        seen.add(digest)
        samples.append((source, {"event": group["event"], "line": group["line"]}))
    return samples, warnings


def replay(path: Path, output_dir: Path, *, events=False, http_response=False) -> dict:
    from .runtime import ProtocolError, parse_reply
    from .rendering import normalize_final_markdown

    text = _read_input(path)
    warnings = []
    if events:
        samples, warnings = extract_event_replies(text)
    elif http_response:
        data = json.loads(text)
        try:
            source = data["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError):
            raise ValueError("HTTP 响应中没有 choices[0].message.content 文本。") from None
        if not isinstance(source, str):
            raise ValueError("HTTP 响应正文不是助手文本。")
        samples = [(source, {"source": "http_response"})]
    else:
        samples = [(text, {"source": "raw_reply"})]
    if not samples:
        raise ValueError("没有可回放的完整助手正文；日志可能省略正文、缺失分片，或只有文件引用。")
    # Fresh destination: replay never overwrites the original, previous fixes,
    # or any task's runtime files.
    output_dir = Path(os.path.abspath(output_dir))
    if any(parent.is_symlink() for parent in (output_dir.parent, *output_dir.parent.parents)):
        raise ValueError("回放输出的上级目录不能包含符号链接。")
    # Never chmod an existing caller-owned parent (e.g. /tmp or their project).
    output_dir.parent.mkdir(parents=True, exist_ok=True)
    output_dir.mkdir(mode=0o700, exist_ok=False)
    archive = RepairArchive(output_dir / "samples")
    rows = []
    for source, metadata in samples[:archive.MAX_SAMPLES]:
        changes, action, error = [], None, None
        try:
            action = parse_reply(source, changes)
        except ProtocolError as exc:
            error = exc
        details = archive.save(source, action=action, normalizations=changes, error=error,
                               metadata=metadata)
        if action is not None and action["type"] == "final":
            rendered, display_changes = normalize_final_markdown(action["answer"])
            private_write(Path(details["directory"]) / "answer.md", rendered.encode("utf-8"))
            private_write(Path(details["directory"]) / "display-normalizations.json", json_bytes(display_changes))
        rows.append({"ok": action is not None, "normalization_kinds": [item["kind"] for item in changes],
                     "sample": details})
    if len(samples) > archive.MAX_SAMPLES:
        warnings.append("样本超出 512 条；超限部分未回放。")
    result = {"version": 1, "algorithm": REPAIR_ALGORITHM, "input": str(path),
              "output_dir": str(output_dir), "sample_count": len(rows),
              "passed": sum(row["ok"] for row in rows), "failed": sum(not row["ok"] for row in rows),
              "incomplete": sum(row["sample"].get("status") == "incomplete" for row in rows),
              "warnings": warnings, "server_requests": 0, "executed_actions": 0, "samples": rows}
    private_write(output_dir / "replay-summary.json", json_bytes(result))
    return result


def parser():
    command = argparse.ArgumentParser(description="本地 JSON 修复回放；不调用模型、不执行动作")
    command.add_argument("input", type=Path)
    mode = command.add_mutually_exclusive_group()
    mode.add_argument("--events", action="store_true", help="从 events.jsonl 重组正文并去重回放")
    mode.add_argument("--http-response", action="store_true", help="从 HTTP 响应的 message.content 提取正文")
    command.add_argument("--output-dir", type=Path, help="新的输出目录；必须不存在，不覆盖任何文件")
    return command


def main(argv=None):
    options = parser().parse_args(argv)
    output = options.output_dir or Path("json-repair-replay-" + time.strftime("%Y%m%d-%H%M%S") + "-" + uuid4().hex[:8])
    try:
        result = replay(options.input, output, events=options.events, http_response=options.http_response)
    except (OSError, ValueError, RecursionError) as exc:
        # Exception class only: arbitrary model text is never echoed on errors.
        print(f"JSON 回放失败 ({type(exc).__name__})：请检查输入格式、大小、路径权限以及输出目录是否已存在。", file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=True, indent=2))
    return 0 if not result["failed"] and not result["warnings"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
