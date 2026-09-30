"""Bounded, field-aware JSON quote repair. No execution or missing-tail invention.

Only unescaped quotation marks inside explicitly textual payloads can change.
A candidate must still pass the independent strict JSON decoder and protocol
validator. Member-looking boundaries are never swallowed as text to hide a
second action, duplicate key, or truncated object.
"""
from __future__ import annotations

import json
import re
import hashlib
import warnings

from .payload_repair import escape_raw_string_controls

_PYTHON_FIELDS = frozenset({("arguments", "code"), ("arguments", "fallback_python")})

_MEMBER = re.compile(r',\s*"(?:[^"\\\x00-\x1f]|\\["\\/bfnrt]|\\u[0-9a-fA-F]{4})*"\s*:')
_NUMBER = re.compile(r'-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?')
_JSON_ESCAPES = frozenset('"\\/bfnrt')
_MARKDOWN_PUNCTUATION = frozenset(r'''!"#$%&'()*+,-./:;<=>?@[\]^_`{|}~''')


def _shell_argv_path(path, tool):
    """Return whether a path is one string element of shell.run argv."""

    return (tool == "shell.run" and len(path) == 3 and path[:2] == ("arguments", "argv")
            and isinstance(path[2], int))


def repair_incomplete_shell_command_transport(source: str) -> tuple[str, list[dict]]:
    """Escape recoverable shell-command quotes in an unfinished JSON prefix.

    This is a diagnostic-only pass. It runs only when the action is visibly a
    ``shell.run`` command and no closing object delimiter is present. It never
    appends a quote, summary, argument, or object delimiter, so the result can
    only become an ``incomplete_response`` artifact and can never be dispatched.
    """
    prefix = re.match(
        r'(?s)^\s*\{\s*"type"\s*:\s*"action"\s*,\s*'
        r'"tool"\s*:\s*"shell\.run"\s*,\s*"arguments"\s*:\s*\{\s*'
        r'"command"\s*:\s*"',
        source,
    )
    if prefix is None or "}" in source[prefix.end():]:
        return source, []
    output = [source[:prefix.end()]]
    positions = []
    index = prefix.end()
    while index < len(source):
        char = source[index]
        if char == "\\" and index + 1 < len(source):
            output.extend((char, source[index + 1]))
            index += 2
            continue
        if char == '"':
            output.append('\\"')
            positions.append(index)
        else:
            output.append(char)
        index += 1
    if not positions:
        return source, []
    return "".join(output), [{
        "kind": "incomplete_shell_command_quotes",
        "scope": "arguments.command",
        "count": len(positions),
        "positions": positions[:64],
        "position_basis": "input_before_transport_repair",
        "executable": False,
    }]


def _python_probe_markdown_escapes(source: str) -> str:
    r"""Remove only invalid Markdown escapes for the compile-only probe.

    The probe must be able to recognize a Python string terminator even when
    the model also emitted ``\[`` or ``\_`` in the same code field. This is a
    temporary validation view; the actual candidate is repaired by the
    field-aware pass in ``runtime.py`` and no code is executed here.
    """
    output = []
    index = 0
    while index < len(source):
        char = source[index]
        if char == "\\" and index + 1 < len(source):
            following = source[index + 1]
            if following in _JSON_ESCAPES or following == "u":
                output.extend((char, following))
            elif following in _MARKDOWN_PUNCTUATION:
                output.append(following)
            else:
                output.extend((char, following))
            index += 2
            continue
        output.append(char)
        index += 1
    return "".join(output)


def normalize_python_code_double_escapes(code: str) -> str:
    """Turn doubled line controls into source newlines outside Python strings.

    A model may encode a code line break as the two source characters ``\\n``.
    Replacing those blindly would corrupt literals such as ``split('\\n')``.
    This small lexical pass preserves quoted strings and comments, and is only
    used after a compile-only proof is required; it never executes code.
    """
    output = []
    index = 0
    quote = None
    triple = False
    comment = False
    while index < len(code):
        char = code[index]
        if comment:
            output.append(char)
            if char == "\n":
                comment = False
            index += 1
            continue
        if quote is not None:
            if triple and code.startswith(quote * 3, index):
                output.append(quote * 3)
                index += 3
                quote = None
                triple = False
                continue
            if not triple and char == quote:
                output.append(char)
                index += 1
                quote = None
                continue
            if char == "\\" and index + 1 < len(code):
                output.extend((char, code[index + 1]))
                index += 2
                continue
            output.append(char)
            index += 1
            continue
        if char == "#":
            output.append(char)
            comment = True
            index += 1
            continue
        if char in "'\"":
            if code.startswith(char * 3, index):
                output.append(char * 3)
                index += 3
                quote = char
                triple = True
            else:
                output.append(char)
                index += 1
                quote = char
                triple = False
            continue
        if char == "\\" and index + 1 < len(code) and code[index + 1] in "nrt":
            output.append({"n": "\n", "r": "\r", "t": "\t"}[code[index + 1]])
            index += 2
            continue
        output.append(char)
        index += 1
    return "".join(output)


def repair_text_quotes(source: str, *, allow_shell_argv: bool = False) -> tuple[str, list[dict]]:
    """Repair only locally identifiable interior quotes in a complete document.

    Parsing structure (including keys) is strict; only strings in the allowlist
    use delimiter lookahead. Any uncertainty/failure returns the input untouched.
    JSON escapes are copied byte-for-byte; other passes handle raw controls and
    Markdown escapes. No structure or string terminators are ever added.
    """
    i = 0
    edits: list[tuple[int, tuple]] = []
    tool = None
    kind = None
    output: list[str] = []
    node_count = 0
    python_checks = 0
    validated_python = {}

    class Declined(ValueError):
        pass

    def shell_argv_path(path):
        return allow_shell_argv and _shell_argv_path(path, tool)

    def ws():
        nonlocal i
        while i < len(source) and source[i] in ' \t\r\n':
            output.append(source[i]); i += 1

    def allowed(path):
        if path in (("answer",), ("summary",)):
            return True
        if len(path) == 2 and path[0] == "plan" and isinstance(path[1], int):
            return True
        if path in (("arguments", "content"), ("arguments", "code"),
                    ("arguments", "fallback_python")):
            return True
        if path == ("arguments", "url") and tool in ("browser.open", "web.fetch"):
            return True
        return (path == ("arguments", "command") and tool == "shell.run") or shell_argv_path(path)

    def boundary(pos, parent):
        p = pos + 1
        while p < len(source) and source[p] in ' \t\r\n':
            p += 1
        # Markdown may escape the structural closing bracket before quote
        # repair has restored the JSON string boundaries. Treat ``\]`` as the
        # same delimiter for lookahead, while preserving it for the later
        # audited Markdown normalization pass.
        if p + 1 < len(source) and source[p] == '\\' and source[p + 1] in '[]':
            # The escaped bracket itself is the delimiter. Do not look past
            # it: a quote immediately followed by ``\]`` closes an argv/plan
            # element even though the Markdown slash is still present.
            return parent == "array" and source[p + 1] == "]"
        if p == len(source):
            return parent is None
        if parent == "object":
            return source[p] == '}' or source[p] == ',' and (
                _MEMBER.match(source, p) is not None or source[p + 1:].lstrip().startswith('}'))
        if parent == "array":
            return source[p] in ',]'
        return False

    def python_terminator(token, path):
        """Distinguish a Python dict/string quote from the JSON string end.

        Only transport escaping is repaired. Compilation creates/discards a code
        object, never executes it, imports modules or fixes Python syntax.
        """
        nonlocal python_checks
        python_checks += 1
        if python_checks > 64 or len(token) > 65536:
            raise Declined()
        try:
            fixed, _, _ = escape_raw_string_controls(token)
            fixed = _python_probe_markdown_escapes(fixed)
            raw_code = json.loads(fixed)
            if not isinstance(raw_code, str) or not raw_code.strip():
                return False
            code = normalize_python_code_double_escapes(raw_code)
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", SyntaxWarning)
                warnings.simplefilter("ignore", DeprecationWarning)
                try:
                    compile(code, "<json-repair-check>", "exec", dont_inherit=True)
                except SyntaxError:
                    # Keep quote-boundary repair available for a transport
                    # payload whose code still has an independent Python
                    # syntax defect. The JSON repair never executes it; the
                    # syntax failure is recorded by the caller.
                    if code == raw_code:
                        return False
            validated_python[path] = hashlib.sha256(code.encode("utf-8")).hexdigest()
            return True
        except (ValueError, SyntaxError, RecursionError, OverflowError, MemoryError):
            return False

    def string(path, *, key=False, parent=None):
        nonlocal i
        if i >= len(source) or source[i] != '"':
            raise Declined()
        start = i
        output_start, edit_start = len(output), len(edits)
        output.append('"'); i += 1
        while i < len(source):
            c = source[i]
            if c == '\\':
                if i + 1 >= len(source):
                    raise Declined()
                output.extend(source[i:i+2]); i += 2
            elif c == '"':
                closes = key or not allowed(path) or boundary(i, parent)
                if closes and not key and path in _PYTHON_FIELDS and len(edits) > edit_start:
                    closes = python_terminator(''.join(output[output_start:]) + '"', path)
                if closes:
                    output.append(c); i += 1
                    # Keys/top-level selectors must be legal before any repair.
                    if key or path in (("type",), ("tool",)):
                        try:
                            return json.loads(source[start:i])
                        except json.JSONDecodeError:
                            # Generated Python actions sometimes carry a
                            # Markdown-escaped input key such as ``target\_dir``.
                            # Decode it only for the known python.run input
                            # object; the field-aware runtime pass records the
                            # actual key normalization before accepting JSON.
                            if key and tool == "python.run" and path == ("arguments", "input"):
                                return json.loads(_python_probe_markdown_escapes(source[start:i]))
                            raise
                    return None
                # Avoid mistaking a real next member for an interior quote.
                if len(edits) >= 2048:
                    raise Declined()
                output.append('\\"'); edits.append((i, path)); i += 1
            else:
                output.append(c); i += 1
        raise Declined()

    def value(path=(), parent=None, depth=0):
        nonlocal i, node_count, tool, kind
        node_count += 1
        if depth > 64 or node_count > 20000:
            raise Declined()
        ws()
        if i >= len(source):
            raise Declined()
        c = source[i]
        if c == '"':
            val = string(path, parent=parent)
            if path == ("tool",): tool = val
            if path == ("type",): kind = val
        elif c == '{':
            output.append(c); i += 1; ws()
            keys = set()
            if i < len(source) and source[i] == '}':
                output.append('}'); i += 1; return
            while True:
                key = string(path, key=True)
                if key in keys: raise Declined()
                keys.add(key); ws()
                if i >= len(source) or source[i] != ':': raise Declined()
                output.append(':'); i += 1
                value(path + (key,), 'object', depth + 1); ws()
                if i >= len(source): raise Declined()
                if source[i] == '}':
                    output.append('}'); i += 1; break
                if source[i] != ',': raise Declined()
                output.append(','); i += 1; ws()
                # Leave trailing comma normalization to the existing decoder.
                if i < len(source) and source[i] == '}':
                    output.append('}'); i += 1; break
        elif c == '[' or source.startswith('\\[', i):
            opening = source[i:i + 2] if c == '\\' else c
            output.append(opening); i += len(opening); ws(); index = 0
            if i < len(source) and source[i] == ']':
                output.append(']'); i += 1; return
            if source.startswith('\\]', i):
                output.extend(('\\', ']')); i += 2; return
            while True:
                value(path + (index,), 'array', depth + 1); index += 1; ws()
                if i >= len(source): raise Declined()
                if source[i] == ']':
                    output.append(']'); i += 1; break
                if source.startswith('\\]', i):
                    output.extend(('\\', ']')); i += 2; break
                if source[i] != ',': raise Declined()
                output.append(','); i += 1; ws()
                if i < len(source) and source[i] == ']':
                    output.append(']'); i += 1; break
        else:
            m = _NUMBER.match(source, i)
            token = m.group() if m else next((x for x in ('true', 'false', 'null') if source.startswith(x, i)), None)
            if token is None: raise Declined()
            output.append(token); i += len(token)

    try:
        value(); ws()
        if i != len(source) or not edits:
            return source, []
        # The selectors may follow the payload: validate only after whole parse.
        for _, path in edits:
            if path == ("answer",) and kind == "final": continue
            if kind != "action": raise Declined()
            if path == ("summary",) or path and path[0] == "plan": continue
            if path == ("arguments", "content") and tool in ("files.write", "file.write"): continue
            if path == ("arguments", "url") and tool in ("browser.open", "web.fetch"): continue
            if path == ("arguments", "code") and tool == "python.run": continue
            if path == ("arguments", "fallback_python") and tool == "local.run": continue
            if path == ("arguments", "command") and tool == "shell.run": continue
            if shell_argv_path(path): continue
            raise Declined()
    except (ValueError, RecursionError):
        return source, []
    changes = []
    groups = (
        ("command", lambda path: path == ("arguments", "command") or shell_argv_path(path)),
        ("python", lambda path: path in _PYTHON_FIELDS),
        ("text", lambda path: path not in _PYTHON_FIELDS
         and path != ("arguments", "command") and not shell_argv_path(path)),
    )
    for category, matches in groups:
        group = [(p, path) for p, path in edits if matches(path)]
        if not group:
            continue
        fields = sorted({'.'.join(map(str, path)) for _, path in group})
        if category == "command":
            kind = "unescaped_shell_command_quotes"
            scope = "shell_command_transport"
        elif category == "python":
            kind = "unescaped_python_quotes"
            scope = "python_source_transport"
        else:
            kind = "unescaped_text_quotes"
            scope = "text_fields_only"
        item = {"kind": kind, "scope": scope,
                "count": len(group), "positions": [p for p, _ in group[:64]], "fields": fields,
                "position_basis": "input_before_quote_repair", "inserted": "backslash_before_quote"}
        if category == "python":
            item.update(syntax_validation="compile_only_no_execution",
                        python_source_sha256={'.'.join(path): digest for path, digest in validated_python.items()},
                        code_rewritten=False)
        changes.append(item)
    return ''.join(output), changes


def partial_final_text(source: str) -> str | None:
    """Extract an unfinished final.answer for diagnostics, NEVER an action.

    Exact final-first envelope only. Missing syntax is not completed or accepted
    as a valid reply. Only already present Unicode is returned; a dangling JSON
    escape is excluded from the diagnostic text.
    """
    m = re.match(r'^\s*\{\s*"type"\s*:\s*"final"\s*,\s*"answer"\s*:\s*"', source)
    if not m: return None
    text = source[m.end():]
    chars = []
    i = 0
    while i < len(text):
        c = text[i]
        if c == '"':
            return None  # Not the supported unterminated-string case.
        if c == '\\':
            if i + 1 == len(text): break
            size = 6 if text[i+1] == 'u' else 2
            if i + size > len(text): break
            try:
                chars.append(json.loads('"' + text[i:i+size] + '"'))
            except ValueError:
                return None
            i += size
        else:
            chars.append(c); i += 1
    result = ''.join(chars)
    try: result.encode('utf-8')
    except UnicodeEncodeError: return None
    return result or None
