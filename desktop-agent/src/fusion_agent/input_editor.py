"""Small POSIX line editor with opt-in, never-executing inline suggestions.

The terminal is raw only while reading a task, never while a tool asks for
permission. Bracketed paste keeps pasted newlines inside one editable input.
Non-terminal callers retain ordinary line-input semantics and receive no ANSI.
"""

from __future__ import annotations

import codecs
from collections import deque
from contextlib import contextmanager
import itertools
import os
import select
import sys
import unicodedata
from typing import Callable, Iterable, TextIO

from .rendering import safe_terminal_text


MAX_INPUT_BYTES = 100_000
MAX_HISTORY = 1000


def _cells(value: str) -> int:
    return sum(_char_cells(char) for char in value)


def _char_cells(char: str) -> int:
    if unicodedata.combining(char) or unicodedata.category(char) in {"Mn", "Me", "Cf"}:
        return 0
    return 2 if unicodedata.east_asian_width(char) in {"W", "F"} else 1


def _visible(value: str) -> str:
    return safe_terminal_text(value).replace("\n", "↵").expandtabs(4)


def _cell_slice(value: str, start: int, end: int) -> str:
    """Clip without printing half of a wide character or a bare combining mark."""
    offset, output = 0, []
    for char in value:
        width = _char_cells(char)
        if not width:
            if output and start < offset <= end:
                output.append(char)
            continue
        following = offset + width
        if following > start and offset < end:
            if offset >= start and following <= end:
                output.append(char)
            else:
                output.append(" " * (min(following, end) - max(offset, start)))
        offset = following
        if offset > end:
            break
    return "".join(output)


def _previous(value: str, index: int) -> int:
    index = max(0, index - 1)
    while index > 0 and _char_cells(value[index]) == 0:
        index -= 1
    return index


def _following(value: str, index: int) -> int:
    index = min(len(value), index + 1)
    while index < len(value) and _char_cells(value[index]) == 0:
        index += 1
    return index


class InputEditor:
    """Read a task with a dim completion accepted only by Tab or Right at end.

    ``suggestions`` receives the entire current input and returns complete
    candidate strings. It should use cached local data, not make API requests.
    ``history`` is copied and is available as a mutable list for the caller.
    Submitted nonempty inputs are appended automatically. Permission questions
    must use a separate ordinary input reader, never this task editor.
    """

    def __init__(self, suggestions: Callable[[str], Iterable[str]] | None = None,
                 history: Iterable[str] = (), *, input_stream: TextIO | None = None,
                 output_stream: TextIO | None = None):
        self.suggestions = suggestions
        self.history = [value for value in history if isinstance(value, str)
                        and value and len(value.encode("utf-8")) <= MAX_INPUT_BYTES][-MAX_HISTORY:]
        self.input_stream = input_stream if input_stream is not None else sys.stdin
        self.output_stream = output_stream if output_stream is not None else sys.stdout
        self._pending: deque[int] = deque()

    def _remember(self, value: str) -> str:
        if value.strip() and (not self.history or self.history[-1] != value):
            self.history.append(value)
            del self.history[:-MAX_HISTORY]
        return value

    def _tty(self) -> bool:
        if os.name != "posix" or os.environ.get("TERM") == "dumb":
            return False
        try:
            return self.input_stream.isatty() and self.output_stream.isatty()
        except (AttributeError, OSError, ValueError):
            return False

    def _write(self, value: str):
        self.output_stream.write(value)
        self.output_stream.flush()

    def _plain(self, prompt: str) -> str:
        self._write(safe_terminal_text(prompt))
        value = self.input_stream.readline(MAX_INPUT_BYTES + 2)
        if value == "":
            raise EOFError
        if len(value.encode("utf-8")) > MAX_INPUT_BYTES:
            raise ValueError("输入超过 100 KB")
        return self._remember(value.rstrip("\r\n"))

    @contextmanager
    def _raw_terminal(self):
        import termios
        import tty

        fd = self.input_stream.fileno()
        previous = termios.tcgetattr(fd)
        try:
            tty.setraw(fd, when=termios.TCSANOW)
            self._write("\x1b[?2004h")
            yield fd
        finally:
            # Restore stdin even when rendering, a callback or output fails.
            try:
                termios.tcsetattr(fd, termios.TCSANOW, previous)
            finally:
                try:
                    self._write("\x1b[0m\x1b[?2004l")
                except (OSError, ValueError):
                    pass

    def _ready(self, fd: int, timeout: float = 0) -> bool:
        return bool(self._pending or select.select([fd], [], [], timeout)[0])

    def _byte(self, fd: int) -> bytes:
        if self._pending:
            return bytes((self._pending.popleft(),))
        return os.read(fd, 1)

    def _paste(self, fd: int) -> str:
        end = b"\x1b[201~"
        value = bytearray()
        oversized = False
        # Keep consuming to the closing delimiter even after the limit; no
        # remaining paste bytes may become subsequent commands or keystrokes.
        tail = bytearray()
        while True:
            byte = self._byte(fd)
            if not byte:
                raise EOFError
            tail.extend(byte)
            if tail.endswith(end):
                value.extend(tail[:-len(end)])
                break
            if len(tail) > len(end):
                if len(value) < MAX_INPUT_BYTES:
                    value.append(tail[0])
                else:
                    oversized = True
                del tail[0]
        if oversized or len(value) > MAX_INPUT_BYTES:
            raise ValueError("粘贴超过 100 KB，未提交任务")
        return safe_terminal_text(value.decode("utf-8", errors="replace")).replace("\r\n", "\n").replace("\r", "\n")

    def _key(self, fd: int) -> tuple[str, str]:
        raw = self._byte(fd)
        if not raw:
            raise EOFError
        if raw == b"\x1b":
            sequence = bytearray(raw)
            if not self._ready(fd, .04):
                return "ignore", ""
            following = self._byte(fd)
            if following not in (b"[", b"O"):
                # Unknown Meta key: discard ESC, retain its printable key.
                self._pending.extend(following)
                return "ignore", ""
            sequence.extend(following)
            while len(sequence) < 32 and self._ready(fd, .04):
                byte = self._byte(fd)
                if not byte:
                    raise EOFError
                sequence.extend(byte)
                if b"@" <= byte <= b"~":
                    break
            code = bytes(sequence)
            if code == b"\x1b[200~":
                return "paste", self._paste(fd)
            names = {b"\x1b[A": "up", b"\x1b[B": "down", b"\x1b[C": "right",
                     b"\x1b[D": "left", b"\x1b[H": "home", b"\x1b[F": "end",
                     b"\x1bOA": "up", b"\x1bOB": "down", b"\x1bOC": "right", b"\x1bOD": "left",
                     b"\x1bOH": "home", b"\x1bOF": "end", b"\x1b[1~": "home",
                     b"\x1b[7~": "home", b"\x1b[4~": "end", b"\x1b[8~": "end",
                     b"\x1b[3~": "delete", b"\x1b[1;5D": "word_left",
                     b"\x1b[1;5C": "word_right"}
            return names.get(code, "ignore"), ""
        controls = {b"\x03": "interrupt", b"\x04": "eof", b"\r": "enter", b"\n": "enter",
                    b"\t": "accept", b"\x7f": "backspace", b"\x08": "backspace",
                    b"\x01": "home", b"\x05": "end", b"\x0b": "kill_end",
                    b"\x15": "kill_start", b"\x17": "kill_word", b"\x0c": "redraw"}
        if raw in controls:
            return controls[raw], ""
        if raw[0] < 32:
            return "ignore", ""
        decoder = codecs.getincrementaldecoder("utf-8")("replace")
        value = decoder.decode(raw)
        while not value:
            following = self._byte(fd)
            if not following:
                raise EOFError
            value = decoder.decode(following)
        return "text", value

    def _candidate(self, value: str, cursor: int) -> str:
        # Accept only suggestions the user can actually see. With NO_COLOR,
        # normal editing and history still work, but hidden ghosts cannot be
        # accidentally inserted by Tab or Right.
        if (os.environ.get("NO_COLOR") is not None or cursor != len(value)
                or not value or self.suggestions is None):
            return ""
        try:
            for candidate in itertools.islice(iter(self.suggestions(value) or ()), 32):
                if (isinstance(candidate, str) and candidate != value and candidate.startswith(value)
                        and len(candidate.encode("utf-8")) <= MAX_INPUT_BYTES
                        and candidate == safe_terminal_text(candidate)
                        and not any(char in candidate for char in "\r\n\t")):
                    return candidate[len(value):]
        except Exception:
            # Completion is optional; a stale catalog must not lose a task.
            pass
        return ""

    def _draw(self, prompt: str, value: str, cursor: int, hint: str = ""):
        try:
            columns = max(4, os.get_terminal_size(self.output_stream.fileno()).columns)
        except (AttributeError, OSError, ValueError):
            columns = 80
        visible_prompt = _cell_slice(_visible(prompt), 0, min(columns // 2, columns - 3))
        prompt_width = _cells(visible_prompt)
        available = max(1, columns - prompt_width - 1)  # Never trigger terminal autowrap.
        visible_value = _visible(value)
        cursor_cells = _cells(_visible(value[:cursor]))
        start = max(0, cursor_cells - available + 1)
        body = _cell_slice(visible_value, start, start + available)
        hint_start = max(0, start - _cells(visible_value))
        hint_end = start + available - _cells(visible_value)
        ghost = _cell_slice(_visible(hint), hint_start, max(hint_start, hint_end)) if hint_end > 0 else ""
        # Defensive display guard; _candidate also disables hint acceptance.
        ghost = "" if os.environ.get("NO_COLOR") is not None else ghost
        rendered_hint = "\x1b[90m" + ghost + "\x1b[0m" if ghost else ""
        position = prompt_width + max(0, cursor_cells - start)
        self._write("\r\x1b[2K" + visible_prompt + body + rendered_hint + "\r"
                    + (f"\x1b[{position}C" if position else ""))

    def _queued_paste(self, fd: int) -> str:
        """A queued multiline burst on a legacy terminal needs another Enter."""
        value = bytearray(b"\n")
        oversized = False
        while self._ready(fd):
            byte = self._byte(fd)
            if not byte:
                break
            if len(value) <= MAX_INPUT_BYTES:
                value.extend(byte)
            else:
                oversized = True
        if oversized:
            raise ValueError("粘贴超过 100 KB，未提交任务")
        return safe_terminal_text(value.decode("utf-8", errors="replace"))

    def read_line(self, prompt: str = "") -> str:
        if not self._tty():
            return self._plain(prompt)
        value, cursor, draft = "", 0, ""
        history_position = len(self.history)
        with self._raw_terminal() as fd:
            try:
                while True:
                    hint = self._candidate(value, cursor)
                    self._draw(prompt, value, cursor, hint)
                    key, text = self._key(fd)
                    if key == "interrupt":
                        self._draw(prompt, value, cursor)
                        self._write("^C\r\n")
                        raise KeyboardInterrupt
                    if key == "eof":
                        if not value:
                            self._write("\r\n")
                            raise EOFError
                        key = "delete"
                    if key == "enter":
                        if self._ready(fd):
                            key, text = "paste", self._queued_paste(fd)
                        else:
                            self._draw(prompt, value, len(value))
                            self._write("\r\n")
                            return self._remember(value)
                    if key in {"text", "paste"}:
                        updated = value[:cursor] + text + value[cursor:]
                        if len(updated.encode("utf-8")) > MAX_INPUT_BYTES:
                            self._write("\a")
                            continue
                        value, cursor = updated, cursor + len(text)
                    elif key in {"accept", "right"}:
                        if cursor == len(value) and hint:
                            value += hint
                            cursor = len(value)
                        elif key == "right":
                            cursor = _following(value, cursor)
                    elif key == "left":
                        cursor = _previous(value, cursor)
                    elif key == "home":
                        cursor = 0
                    elif key == "end":
                        cursor = len(value)
                    elif key == "backspace" and cursor:
                        previous = _previous(value, cursor)
                        value, cursor = value[:previous] + value[cursor:], previous
                    elif key == "delete" and cursor < len(value):
                        value = value[:cursor] + value[_following(value, cursor):]
                    elif key == "kill_start":
                        value, cursor = value[cursor:], 0
                    elif key == "kill_end":
                        value = value[:cursor]
                    elif key in {"kill_word", "word_left"}:
                        previous = cursor
                        while previous and value[previous - 1].isspace():
                            previous -= 1
                        while previous and not value[previous - 1].isspace():
                            previous -= 1
                        if key == "kill_word":
                            value = value[:previous] + value[cursor:]
                        cursor = previous
                    elif key == "word_right":
                        while cursor < len(value) and not value[cursor].isspace():
                            cursor += 1
                        while cursor < len(value) and value[cursor].isspace():
                            cursor += 1
                    elif key == "up" and history_position:
                        if history_position == len(self.history):
                            draft = value
                        history_position -= 1
                        value = self.history[history_position]
                        cursor = len(value)
                    elif key == "down" and history_position < len(self.history):
                        history_position += 1
                        value = draft if history_position == len(self.history) else self.history[history_position]
                        cursor = len(value)
            except (OSError, ValueError):
                # A failed renderer or oversized paste never submits input.
                try:
                    self._write("\r\n")
                except (OSError, ValueError):
                    pass
                raise
