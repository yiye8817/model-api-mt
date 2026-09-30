"""Small, dependency-free Markdown renderer for terminal result messages.

Only this module creates terminal escape sequences. Model-supplied terminal
controls are discarded before parsing, and code blocks are displayed, never
interpreted. Wrapping uses terminal cells rather than Python string lengths.
"""

from __future__ import annotations

import html
import json
import os
import re
import shutil
import unicodedata
from typing import Any, TextIO
from urllib.parse import unquote, urlsplit


def _decode_markdown_line_break_escapes(text: str, scope: str) -> tuple[str, list[dict]]:
    """Decode a Markdown answer that was serialized with literal ``\\n``.

    Some web models return the whole Markdown document as one string containing
    backslash-n pairs instead of JSON line breaks.  That makes headings,
    tables, quotes and fenced code look like ordinary prose in the terminal.
    Only prose/Markdown-looking documents are normalized; JSON replies and
    short ordinary strings are left byte-for-byte unchanged.  A doubled
    backslash is preserved so an explicitly literal ``\\n`` remains visible.
    """
    if not isinstance(text, str) or text.count("\\n") < 2:
        return text, []
    if text.lstrip().startswith(("{", "[", '"')):
        return text, []
    markdown_hint = re.search(r"(?:^|\n|\\n)\s*(?:#{1,6}\s|[-+*]\s|\d+[.)]\s|\||>\s|`{1,3})", text)
    if not markdown_hint:
        return text, []
    output: list[str] = []
    positions: list[int] = []
    index = 0
    while index < len(text):
        if text.startswith("\\\\", index):
            output.append("\\\\")
            index += 2
        elif text.startswith("\\n", index):
            output.append("\n")
            positions.append(index)
            index += 2
        elif text.startswith("\\r\\n", index):
            output.append("\n")
            positions.append(index)
            index += 4
        else:
            output.append(text[index])
            index += 1
    if not positions:
        return text, []
    return "".join(output), [{"kind": "escaped_markdown_line_breaks_all",
                              "scope": scope, "count": len(positions),
                              "positions": positions[:64]}]


def _restore_escaped_markdown_breaks(
        text: str, scope: str = "final_answer_display") -> tuple[str, list[dict]]:
    """Recover visibly double-encoded Markdown paragraph/row separators only.

    This is presentation normalization, never an action/argument decoder. A
    document already containing real newlines, JSON, or fenced code is left
    alone. Inline code and literal escapes inside ordinary words/paths remain
    exact. Only paragraph breaks and breaks preceding Markdown block markers
    are unambiguous enough to restore without asking the model to rewrite code.
    """
    if (not isinstance(text, str) or "\n" in text or "\r" in text or text.count("\\n") < 2
            or text.lstrip().startswith(("{", "[", '"')) or re.search(r"`{3,}|~{3,}", text)):
        return text, []
    block = re.compile(r" {0,3}(?:#{1,6}\s|[-+*]\s|\d+[.)]\s|\||>\s)")
    changes = []
    output = []
    index = 0
    inline_ticks = 0
    block_seen = bool(block.match(text))
    while index < len(text):
        if text[index] == "`":
            end = index
            while end < len(text) and text[end] == "`":
                end += 1
            count = end - index
            if not inline_ticks:
                inline_ticks = count
            elif inline_ticks == count:
                inline_ticks = 0
            output.append(text[index:end])
            index = end
            continue
        if text[index] == "\\":
            # Preserve escaped backslashes as pairs; a Windows path or code
            # example must not accidentally become a newline on a second pass.
            if text[index:index + 2] == "\\\\":
                output.append(text[index:index + 2])
                index += 2
                continue
            if not inline_ticks and text[index:index + 2] == "\\n":
                end = index
                while text[end:end + 2] == "\\n":
                    end += 2
                count = (end - index) // 2
                next_block = bool(block.match(text[end:]))
                block_seen = block_seen or next_block
                if count >= 2 or next_block:
                    output.append("\n" * count)
                    changes.append({"position": index, "newlines": count})
                    index = end
                    continue
        output.append(text[index])
        index += 1
    if not block_seen or sum(item["newlines"] for item in changes) < 2:
        return text, []
    return "".join(output), [{"kind": "escaped_markdown_line_breaks", "scope": scope,
                              "count": sum(item["newlines"] for item in changes),
                              "positions": [item["position"] for item in changes[:32]]}]


def _markdown_code_ranges(text: str) -> list[tuple[int, int]]:
    """Identify fenced/indented code and code spans before presentation edits."""
    protected = []
    fence = None
    offset = 0
    for line in text.splitlines(keepends=True):
        marker = re.match(r"^ {0,3}(`{3,}|~{3,})", line)
        if fence:
            protected.append((offset, offset + len(line)))
            if re.fullmatch(r" {0,3}" + re.escape(fence[0]) + "{" + str(len(fence)) + r",}\s*", line):
                fence = None
        elif marker:
            fence = marker.group(1)
            protected.append((offset, offset + len(line)))
        elif line.startswith(("    ", "\t")):
            protected.append((offset, offset + len(line)))
        offset += len(line)
    # A code span may span lines. Pair equal-length backtick runs, skipping the
    # intervening runs exactly as Markdown does; unmatched ticks remain prose.
    ticks = list(re.finditer(r"`+", text))
    next_equal = {}
    next_index = {}
    for index in range(len(ticks) - 1, -1, -1):
        count = len(ticks[index].group())
        if count in next_equal:
            next_index[index] = next_equal[count]
        next_equal[count] = index
    index = 0
    while index < len(ticks):
        closing = next_index.get(index)
        if closing is None:
            index += 1
        else:
            protected.append((ticks[index].start(), ticks[closing].end()))
            index = closing + 1
    protected.extend((match.start(), match.end()) for match in
                     re.finditer(r"<(pre|code)\b[^>]*>.*?</\1\s*>", text, re.IGNORECASE | re.DOTALL))
    return sorted(protected)


def _repair_polluted_citations(text: str) -> tuple[str, list[dict]]:
    """Repair one observed citation serialization defect, never invent a URL.

    Both the multiline domain label and its same-host URL must contain the
    *same* displaced Chinese punctuation/list number. Ordinary /n paths, query
    strings, normal multiline labels and code are not evidence of corruption.
    The damaged destination is removed from display, with an explicit marker;
    the caller retains the original reply and records these edits in its audit.
    """
    if not isinstance(text, str) or "\n" not in text:
        return text, []
    # Final-result formatting is never a decoder for whole JSON/protocol text.
    if text.lstrip().startswith(("{", '"')) or re.match(r'^\s*\[\s*(?:[\[\{"\d-]|true\b|false\b|null\b)', text):
        return text, []
    protected = _markdown_code_ranges(text)

    def is_code(start, end):
        return any(left < end and right > start for left, right in protected)

    line_space = r"(?:[ \t]|\r?\n|\\n)"
    citation = re.compile(
        r"(?P<separator>(?:\r?\n[ \t]{0,3}){1,4})?"
        r"(?<!!)\[(?P<host>(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63})"
        + line_space + r"+(?P<punct>[。！？；])(?:" + line_space + r"+(?P<number>[1-9][0-9]{0,3}))?"
        + r"[ \t]*\]\((?P<url>https?://[^\s()<>]+)\)")
    result = []
    changes = []
    cursor = 0
    for match in citation.finditer(text):
        if match.start() < cursor or is_code(match.start(), match.end()):
            continue
        label_start = text.find("[", match.start(), match.end())
        # Require a real multiline label, not literal escapes in a one-line
        # command or data example. Escaped Markdown brackets are also literal.
        if "\n" not in text[label_start:match.start("url")] or (label_start and text[label_start - 1] == "\\"):
            continue
        try:
            target = urlsplit(match.group("url"))
            path = unquote(target.path, encoding="utf-8", errors="strict")
            if (target.scheme not in {"http", "https"} or target.netloc.lower() != match.group("host").lower()
                    or target.query or target.fragment):
                continue
        except (ValueError, UnicodeError):
            continue
        number = match.group("number")
        expected_suffix = match.group("punct") + ("/n" + number if number else "")
        if not re.fullmatch(r"(?:/n){1,4}" + re.escape(expected_suffix), path):
            continue
        end = match.end()
        if number:
            # In this defect the next list delimiter was split around the
            # citation. Only move it when its trailing dot and next text exist.
            trailer = re.match(r"\.[ \t]*\r?\n[ \t]{0,3}(?=\S)", text[end:])
            if not trailer or is_code(end, end + trailer.end()):
                continue
            end += trailer.end()
        preceding = text[cursor:match.start()]
        joined = 0
        if preceding and match.group("separator"):
            # Reflow only the prose paragraph belonging to a proven damaged
            # citation. Soft CJK line wrapping must not leave a leading comma.
            boundary = list(re.finditer(r"\n[ \t]*\n", preceding))
            paragraph_at = boundary[-1].end() if boundary else 0
            paragraph = preceding[paragraph_at:]
            if not is_code(cursor + paragraph_at, match.start()) and "`" not in paragraph:
                paragraph, joined = re.subn(r"(?<=[\u3000-\u9fff\uff00-\uffef])\r?\n[ \t]{0,3}(?=[\u3000-\u9fff\uff00-\uffef])", "", paragraph)
                preceding = preceding[:paragraph_at] + paragraph
            if not preceding.endswith(match.group("punct")):
                preceding += match.group("punct")
            replacement = "\n\n来源：`" + match.group("host") + "`（链接异常）"
        else:
            replacement = (match.group("separator") or "") + "来源：`" + match.group("host") + "`（链接异常）" + match.group("punct")
        if number:
            replacement += "\n\n" + number + ". "
        result.extend((preceding, replacement))
        changes.append({"kind": "polluted_citation", "scope": "final_answer_display", "host": match.group("host"),
                        "destination_removed": True, "displaced_list_number": int(number) if number else None,
                        "joined_soft_line_breaks": joined})
        cursor = end
    if not changes:
        return text, []
    result.append(text[cursor:])
    return "".join(result), changes


def _repair_polluted_full_url_links(text: str) -> tuple[str, list[dict]]:
    """Repair the observed full-URL/displaced-list-number serialization defect.

    A repair is permitted only when the visible URL is an exact byte prefix of
    the destination and the remaining destination is exactly ``/n/nN``, where
    ``N`` is the list number displaced into the link label. The list delimiter
    immediately following the link and following non-whitespace content are
    also required. No URL component is inferred or reconstructed.
    """
    if not isinstance(text, str) or ("\n" not in text and r"\n" not in text):
        return text, []
    protected = _markdown_code_ranges(text)

    def is_code(start, end):
        return any(left < end and right > start for left, right in protected)

    def valid_url_pair(visible, target):
        try:
            parsed_visible = urlsplit(visible)
            parsed_target = urlsplit(target)
            valid = (parsed_visible.scheme in {"http", "https"} and bool(parsed_visible.hostname)
                     and parsed_target.scheme in {"http", "https"} and bool(parsed_target.hostname)
                     and not parsed_visible.username and not parsed_visible.password
                     and not parsed_target.username and not parsed_target.password
                     and not parsed_visible.query and not parsed_visible.fragment
                     and not parsed_target.query and not parsed_target.fragment
                     and not re.search(r"[\\\x00-\x1f\x7f]", visible + target))
            parsed_visible.port
            parsed_target.port
            return valid
        except (TypeError, ValueError):
            return False

    damaged_link = re.compile(
        r"(?<!!)(?<!\\)\[(?P<visible>https?://[^\\\s\[\]()<>]+)"
        r"\r?\n[ \t]*\r?\n[ \t]*(?P<number>[1-9][0-9]{0,3})"
        r"\]\((?P<target>https?://[^\\\s()<>]+)\)"
        r"(?P<delimiter>\.)[ \t]*(?=\S)")
    output = []
    changes = []
    cursor = 0
    for match in damaged_link.finditer(text):
        if match.start() < cursor or is_code(match.start(), match.end()):
            continue
        visible = match.group("visible")
        target = match.group("target")
        number = match.group("number")
        if target != visible + "/n/n" + number:
            continue
        if not valid_url_pair(visible, target):
            continue
        output.append(text[cursor:match.start()])
        output.append(f"[{visible}]({visible})\n\n{number}. ")
        changes.append({"kind": "polluted_full_url_link",
                        "scope": "files.write_markdown_content",
                        "position": match.start(),
                        "original_destination": target,
                        "normalized_destination": visible,
                        "destination_suffix_removed": "/n/n" + number,
                        "displaced_list_number": int(number)})
        cursor = match.end()
    if not changes:
        numbered_result = text
    else:
        output.append(text[cursor:])
        numbered_result = "".join(output)

    # The uploaded document's final link carries the same defect without a
    # displaced next-item number. A single literal/real newline and matching
    # /n destination suffix are conclusive only at end-of-document.
    terminal_link = re.compile(
        r"(?<!!)(?<!\\)\[(?P<visible>https?://[^\\\s\[\]()<>]+)(?:\\n|\r?\n)"
        r"\]\((?P<target>https?://[^\\\s()<>]+)\)(?P<trailing>[ \t\r\n]*)\Z")
    terminal = terminal_link.search(numbered_result)
    terminal_protected = _markdown_code_ranges(numbered_result)
    terminal_is_code = terminal and any(
        left < terminal.end() and right > terminal.start() for left, right in terminal_protected)
    if terminal and not terminal_is_code:
        visible = terminal.group("visible")
        target = terminal.group("target")
        if target == visible + "/n" and valid_url_pair(visible, target):
            numbered_result = (numbered_result[:terminal.start()]
                               + f"[{visible}]({visible})" + terminal.group("trailing"))
            changes.append({"kind": "polluted_full_url_link",
                            "scope": "files.write_markdown_content",
                            "position": terminal.start(),
                            "original_destination": target,
                            "normalized_destination": visible,
                            "destination_suffix_removed": "/n",
                            "displaced_list_number": None})
    if not changes:
        return text, []
    return numbered_result, changes


def normalize_markdown_document(text: str, path: str) -> tuple[str, list[dict]]:
    """Normalize proven web serialization damage only for Markdown file writes.

    Callers keep the raw protocol reply for audit. This function is idempotent,
    performs no I/O, and leaves non-Markdown destinations and code untouched.
    """
    try:
        suffix = os.path.splitext(os.fspath(path))[1].lower()
    except TypeError:
        return text, []
    if suffix not in {".md", ".markdown"} or not isinstance(text, str):
        return text, []
    text, escaped = _decode_markdown_line_break_escapes(text, scope="files.write_markdown_content")
    text, breaks = _restore_escaped_markdown_breaks(text, scope="files.write_markdown_content")
    text, links = _repair_polluted_full_url_links(text)
    return text, escaped + breaks + links


def normalize_final_markdown(text: str) -> tuple[str, list[dict]]:
    """Normalize final presentation only; audit callers retain the raw answer."""
    text, escaped = _decode_markdown_line_break_escapes(text, scope="final_answer_display")
    text, breaks = _restore_escaped_markdown_breaks(text)
    text, citations = _repair_polluted_citations(text)
    return text, escaped + breaks + citations


def safe_terminal_text(text: object) -> str:
    """Remove CSI/OSC/DCS/APC/PM controls, including unterminated sequences.

    Keep line breaks and tabs for the renderer; callers making one-line status
    messages can subsequently collapse whitespace. Normalizing carriage returns
    prevents model output from overwriting previous terminal progress messages.
    """
    value = str(text).replace("\r\n", "\n").replace("\r", "\n")
    output: list[str] = []
    index = 0
    while index < len(value):
        char = value[index]
        # String controls can contain arbitrary printable payload. Discard the
        # complete payload, not just ESC itself (OSC 52 can set the clipboard).
        string_control = char in "\x90\x98\x9d\x9e\x9f"
        escape_string = char == "\x1b" and value[index + 1:index + 2] in {"P", "X", "]", "^", "_"}
        if string_control or escape_string:
            osc = char == "\x9d" or value[index:index + 2] == "\x1b]"
            index += 2 if escape_string else 1
            while index < len(value):
                if value[index] == "\x9c" or (osc and value[index] == "\x07"):
                    index += 1
                    break
                if value[index:index + 2] == "\x1b\\":
                    index += 2
                    break
                index += 1
            continue
        if char == "\x9b" or value[index:index + 2] == "\x1b[":
            index += 1 if char == "\x9b" else 2
            while index < len(value) and not ("@" <= value[index] <= "~"):
                index += 1
            index += index < len(value)
            continue
        if char == "\x1b":
            index += 1
            while index < len(value) and " " <= value[index] <= "/":
                index += 1
            if index < len(value) and "0" <= value[index] <= "~":
                index += 1
            continue
        codepoint = ord(char)
        if char in "\n\t" or (codepoint >= 32 and not 127 <= codepoint <= 159
                               and char not in "\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069"):
            output.append(char)
        index += 1
    return "".join(output)


def _cell_width(char: str) -> int:
    if unicodedata.combining(char) or unicodedata.category(char) in {"Mn", "Me", "Cf"}:
        return 0
    return 2 if unicodedata.east_asian_width(char) in {"W", "F"} else 1


def _width(text: str) -> int:
    return sum(_cell_width(char) for char in text)


def _wrap(text: str, width: int) -> list[str]:
    """Wrap prose at word boundaries where practical, and at CJK characters."""
    if not text:
        return [""]
    width = max(1, width)
    lines: list[str] = []
    for logical_line in text.expandtabs(4).split("\n"):
        remaining = logical_line.strip()
        if not remaining:
            lines.append("")
        while remaining:
            used = 0
            cutoff = 0
            last_space = -1
            for position, char in enumerate(remaining):
                cells = _cell_width(char)
                if used + cells > width and position:
                    break
                used += cells
                cutoff = position + 1
                if char.isspace():
                    last_space = position
            if cutoff < len(remaining) and last_space > 0:
                # Do not throw away most of a line for one early space.
                if _width(remaining[:last_space]) >= width // 2:
                    cutoff = last_space
            lines.append(remaining[:cutoff].rstrip())
            remaining = remaining[cutoff:].lstrip()
    return lines


def _inline(text: str) -> str:
    """Make common inline Markdown readable without executing terminal markup."""
    # Protect code spans before removing emphasis / escaping Markdown syntax.
    placeholder_prefix = "\ufff0"
    while placeholder_prefix in text:
        placeholder_prefix += "\ufff0"
    code_spans: dict[str, str] = {}
    fragments: list[str] = []
    cursor = 0
    ticks = list(re.finditer(r"`+", text))
    token_index = 0
    while token_index < len(ticks):
        opening = ticks[token_index]
        closing_index = next((candidate for candidate in range(token_index + 1, len(ticks))
                              if ticks[candidate].group() == opening.group()), None)
        if closing_index is None:
            token_index += 1
            continue
        closing = ticks[closing_index]
        token = placeholder_prefix + str(len(code_spans)) + "\ufff1"
        code_spans[token] = text[opening.end():closing.start()]
        fragments.extend((text[cursor:opening.start()], token))
        cursor = closing.end()
        token_index = closing_index + 1
    fragments.append(text[cursor:])
    part = "".join(fragments)
    part = re.sub(r"<br\s*/?>", "\n", part, flags=re.IGNORECASE)
    part = re.sub(r"</?(?:strong|em|b|i|del|s)>|</?code>", "", part, flags=re.IGNORECASE)
    part = re.sub(r"<(https?://[^>]+)>", r"\1", part)
    # URL parentheses are common; one balanced inner pair is sufficient for
    # readable terminal links without depending on a full Markdown parser.
    def link(match: re.Match[str]) -> str:
        label = match.group(2)
        target = match.group(3).strip()
        target = re.sub(r'\s+["\'].*["\']$', "", target)
        if target.startswith("<") and target.endswith(">"):
            target = target[1:-1]
        if match.group(1):
            return f"[图片：{label}] ({target})"
        return label if label.rstrip("/") == target.rstrip("/") else f"{label} ({target})"
    part = re.sub(r"(!?)\[([^\]\n]+)\]\(((?:[^()\n]|\([^()\n]*\))*)\)", link, part)
    for pattern in (
        r"\*\*(?=\S)(.+?)(?<=\S)\*\*",
        r"__(?=\S)(.+?)(?<=\S)__",
        r"~~(?=\S)(.+?)(?<=\S)~~",
        r"(?<!\w)\*(?=\S)(.+?)(?<=\S)\*(?!\w)",
        r"(?<!\w)_(?=\S)(.+?)(?<=\S)_(?!\w)",
    ):
        part = re.sub(pattern, r"\1", part)
    part = re.sub(r"\\([\\`*_{}\[\]()#+\-.!|>])", r"\1", part)
    # Python's HTML decoder discards numeric ESC references alone, leaving
    # an OSC payload visible. Decode control references first so the whole
    # sequence is discarded, including any clipboard/title payload.
    def control_entity(match: re.Match[str]) -> str:
        value = match.group(1)
        if len(value) > 12:
            return match.group(0)
        number = int(value[1:], 16) if value.lower().startswith("x") else int(value)
        return chr(number) if number < 32 or 127 <= number <= 159 else match.group(0)
    part = re.sub(r"&#([xX][0-9a-fA-F]+|[0-9]+);?", control_entity, part)
    part = safe_terminal_text(part)
    try:
        part = html.unescape(part)
    except (ValueError, OverflowError):
        # Malformed/oversized numeric entities remain literal readable text.
        pass
    part = safe_terminal_text(part)
    for token, content in code_spans.items():
        part = part.replace(token, content)
    return part


def _table_cells(line: str) -> list[str]:
    line = line.strip()
    if line.startswith("|"):
        line = line[1:]
    if line.endswith("|") and not line.endswith("\\|"):
        line = line[:-1]
    cells: list[str] = []
    current: list[str] = []
    index = 0
    code_ticks = 0
    while index < len(line):
        char = line[index]
        if char == "\\" and index + 1 < len(line):
            current.extend(line[index:index + 2])
            index += 2
            continue
        if char == "`":
            end = index
            while end < len(line) and line[end] == "`":
                end += 1
            count = end - index
            if not code_ticks:
                code_ticks = count
            elif count == code_ticks:
                code_ticks = 0
            current.append(line[index:end])
            index = end
            continue
        if char == "|" and not code_ticks:
            cells.append("".join(current).strip())
            current = []
        else:
            current.append(char)
        index += 1
    cells.append("".join(current).strip())
    return cells


def _table_separator(line: str) -> bool:
    cells = _table_cells(line)
    return bool(cells) and "|" in line and all(re.fullmatch(r":?-{3,}:?", cell) for cell in cells)


def format_json(value: Any, width: int | None = None) -> str:
    """Pretty-print data as JSON, retaining strings and never treating them as code.

    Width is accepted for a shared renderer interface. JSON string values and
    code blocks are intentionally not wrapped: changing them would hide the
    exact URL, file path, or command the user needs to inspect.
    """
    del width
    return safe_terminal_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False))


def _unique_json_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate JSON key")
        result[key] = value
    return result


class _Renderer:
    def __init__(self, stream: TextIO, width: int | None):
        self.stream = stream
        self.width = max(8, min(240, int(width or shutil.get_terminal_size((88, 24)).columns)))
        self.color = (bool(getattr(stream, "isatty", lambda: False)())
                      and "NO_COLOR" not in os.environ and os.environ.get("TERM", "") != "dumb")
        self.lines: list[str] = []

    def style(self, value: str, code: str = "1") -> str:
        return f"\x1b[{code}m{value}\x1b[0m" if self.color and value else value

    def blank(self) -> None:
        if self.lines and self.lines[-1]:
            self.lines.append("")

    def prose(self, text: str, prefix: str = "", continuation: str | None = None) -> None:
        continuation = continuation if continuation is not None else prefix
        available = self.width - max(_width(prefix), _width(continuation))
        for index, line in enumerate(_wrap(_inline(text), available)):
            self.lines.append((prefix if index == 0 else continuation) + line)

    def table(self, rows: list[list[str]]) -> None:
        count = len(rows[0])
        values = [[_inline(value) for value in (row + [""] * count)[:count]] for row in rows]
        self.blank()
        if count * 4 + (count - 1) * 3 > self.width:
            for row in values[1:]:
                for label, value in zip(values[0], row):
                    self.prose(f"{label}: {value}")
                self.blank()
            return
        widths = [max(3, max(_width(line) for row in values for line in row[col].split("\n")))
                  for col in range(count)]
        budget = self.width - (count - 1) * 3
        while sum(widths) > budget:
            biggest = max(range(count), key=lambda col: widths[col])
            widths[biggest] -= 1
        for row_index, row in enumerate(values):
            wrapped = [_wrap(value, widths[col]) for col, value in enumerate(row)]
            for line_index in range(max(map(len, wrapped))):
                cells = [lines[line_index] if line_index < len(lines) else "" for lines in wrapped]
                rendered = " | ".join(value + " " * (widths[col] - _width(value))
                                      for col, value in enumerate(cells)).rstrip()
                self.lines.append(self.style(rendered) if row_index == 0 else rendered)
            if row_index == 0:
                self.lines.append(self.style("─┼─".join("─" * width for width in widths), "2"))
        self.blank()

    def render(self, source: str) -> None:
        text = safe_terminal_text(source)
        # Display whole JSON replies in an inspectable structured form. A JSON
        # example embedded in prose is handled as Markdown, never extracted.
        try:
            value = json.loads(text, object_pairs_hook=_unique_json_object)
        except (ValueError, TypeError, RecursionError):
            value = None
        if isinstance(value, (dict, list)):
            try:
                # Do not let deeply nested JSON amplify a short response into
                # megabytes of indentation (independent of Python recursion limits).
                pending, seen = [(value, 0)], 0
                while pending:
                    item, depth = pending.pop()
                    seen += 1
                    if depth > 64 or seen > 20000:
                        raise ValueError("JSON display nesting/size limit")
                    if isinstance(item, dict): pending.extend((v, depth + 1) for v in item.values())
                    elif isinstance(item, list): pending.extend((v, depth + 1) for v in item)
                self.lines.extend(format_json(value).splitlines())
                return
            except (ValueError, RecursionError):
                pass
        lines = text.splitlines()
        index = 0
        while index < len(lines):
            line = lines[index]
            if not line.strip():
                self.blank()
                index += 1
                continue
            fence = re.match(r"^ {0,3}(`{3,}|~{3,})\s*(.*)$", line)
            if fence:
                self.blank()
                marker, language = fence.groups()
                if language:
                    self.lines.extend(self.style(item, "2") for item in _wrap(f"[{language}]", self.width))
                index += 1
                while index < len(lines):
                    if re.fullmatch(r" {0,3}" + re.escape(marker[0]) + "{" + str(len(marker)) + r",}\s*", lines[index]):
                        index += 1
                        break
                    # Do not wrap or interpret code, including nested Markdown.
                    self.lines.append(lines[index].expandtabs(4))
                    index += 1
                self.blank()
                continue
            # A few web models emit a multiline code block with one backtick
            # on each boundary (`` `bash`` … `` ` ``) instead of a fenced
            # triple-backtick block.  Treat it as a fence only when a matching
            # closing line exists; ordinary inline code remains unchanged.
            single_fence = re.match(r"^ {0,3}`([^`\n]+)\s*$", line)
            if single_fence:
                closing = next((candidate for candidate in range(index + 1, len(lines))
                                if re.fullmatch(r" {0,3}`\s*", lines[candidate])), None)
                if closing is not None:
                    self.blank()
                    language = single_fence.group(1).strip()
                    if language:
                        self.lines.extend(self.style(item, "2") for item in _wrap(f"[{language}]", self.width))
                    self.lines.extend(lines[item].expandtabs(4) for item in range(index + 1, closing))
                    self.blank()
                    index = closing + 1
                    continue
            if index + 1 < len(lines) and "|" in line and _table_separator(lines[index + 1]):
                rows = [_table_cells(line)]
                index += 2
                while index < len(lines) and lines[index].strip() and "|" in lines[index]:
                    rows.append(_table_cells(lines[index]))
                    index += 1
                self.table(rows)
                continue
            heading = re.match(r"^ {0,3}(#{1,6})\s+(.+?)(?:\s+#+\s*)?$", line)
            setext = (index + 1 < len(lines) and re.fullmatch(r" {0,3}(?:={3,}|-{3,})\s*", lines[index + 1]))
            if heading or setext:
                title = _inline(heading.group(2) if heading else line.strip())
                self.blank()
                title_lines = _wrap(title, self.width)
                self.lines.extend(self.style(part) for part in title_lines)
                if (not heading or len(heading.group(1)) <= 2) and title_lines:
                    self.lines.append(self.style("─" * min(self.width, max(map(_width, title_lines))), "2"))
                self.blank()
                index += 1 if heading else 2
                continue
            if re.fullmatch(r" {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})", line):
                self.blank()
                self.lines.append(self.style("─" * self.width, "2"))
                self.blank()
                index += 1
                continue
            item = re.match(r"^(\s*)([-+*]|\d+[.)])\s+(.*)$", line)
            if item:
                indentation, marker, content = item.groups()
                indentation = " " * min(len(indentation.expandtabs(4)), max(0, self.width // 3))
                checkbox = re.match(r"\[([ xX])\]\s*(.*)$", content)
                if checkbox:
                    marker = "☑" if checkbox.group(1).lower() == "x" else "☐"
                    content = checkbox.group(2)
                elif marker in "-+*":
                    marker = "•"
                prefix = indentation + marker + " "
                self.prose(content, prefix, " " * _width(prefix))
                index += 1
                # Indented prose belongs to this item. Do not consume nested
                # lists or a code fence, which require their own rendering.
                while (index < len(lines) and lines[index].startswith(" " * (len(item.group(1)) + 2))
                       and lines[index].strip()
                       and not re.match(r"^\s*(?:[-+*]|\d+[.)])\s|^\s*(?:`{3,}|~{3,})", lines[index])):
                    self.prose(lines[index].strip(), " " * _width(prefix))
                    index += 1
                continue
            quote = re.match(r"^\s*>\s?(.*)$", line)
            if quote:
                self.prose(quote.group(1), "│ ")
            elif line.startswith("    ") or line.startswith("\t"):
                self.lines.append(line.expandtabs(4))
            else:
                # Preserve explicit source line breaks; unlike paragraph joins,
                # this keeps Markdown hard breaks and Chinese text unambiguous.
                self.prose(line)
            index += 1

    def write(self) -> None:
        while self.lines and not self.lines[-1]:
            self.lines.pop()
        self.stream.write("\n".join(self.lines) + ("\n" if self.lines else ""))
        self.stream.flush()


def render_markdown(text: str, stream: TextIO, width: int | None = None) -> None:
    """Write a formatted, sanitized Markdown/JSON result and flush the stream.

    Redirected output is plain text. TTY headings use ANSI only when NO_COLOR
    is absent and TERM is not dumb. Long code/JSON strings are never reflowed.
    """
    renderer = _Renderer(stream, width)
    text, _ = normalize_final_markdown(text)
    renderer.render(text)
    renderer.write()
