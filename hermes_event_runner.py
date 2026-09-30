#!/usr/bin/env python3
"""Run Hermes CLI while mirroring tool lifecycle events as JSON Lines."""

import json
import os
import re
import sys

_EVENT_FD = int(os.environ.get("HERMES_EVENT_FD", "-1"))
_URL_RE = re.compile(r"https?://[^\s<>\[\]()\"']+")


def _text(value, limit=1600):
    if value is None:
        return ""
    if isinstance(value, str):
        text = value
    else:
        try:
            text = json.dumps(value, ensure_ascii=False, default=str)
        except Exception:
            text = str(value)
    text = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", text).strip()
    return text if len(text) <= limit else text[:limit] + "…"


def _urls(*values):
    found, seen = [], set()
    for value in values:
        for url in _URL_RE.findall(_text(value, 12000)):
            url = url.rstrip(".,;:!?)]}，。；：！？）】》")
            if '\\' in url:
                continue
            if url and url not in seen:
                seen.add(url)
                found.append(url)
    return found[:20]


def _emit(payload):
    if _EVENT_FD < 0:
        return
    try:
        data = json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n"
        os.write(_EVENT_FD, data.encode("utf-8"))
    except OSError:
        pass


def _install_progress_bridge():
    from cli import HermesCLI

    def structured_progress(
        self, event_type, function_name=None, preview=None,
        function_args=None, **kwargs,
    ):
        if event_type not in {
            "tool.started", "tool.completed",
            "moa.reference", "moa.aggregating",
        }:
            return
        if function_name and str(function_name).startswith("_"):
            return
        payload = {
            "event": event_type,
            "tool": _text(function_name, 160),
            "preview": _text(preview, 800),
        }
        if event_type == "tool.started":
            payload["args"] = _text(function_args, 1000)
        elif event_type == "tool.completed":
            payload.update({
                "duration": round(float(kwargs.get("duration") or 0), 2),
                "isError": bool(kwargs.get("is_error")),
                "result": _text(kwargs.get("result"), 1600),
            })
        urls = _urls(preview, function_args, kwargs.get("result"))
        if urls:
            payload["urls"] = urls
        _emit(payload)

    HermesCLI._on_tool_progress = structured_progress


def main():
    _install_progress_bridge()
    from hermes_cli.main import main as hermes_main
    return hermes_main()


if __name__ == "__main__":
    sys.exit(main())
