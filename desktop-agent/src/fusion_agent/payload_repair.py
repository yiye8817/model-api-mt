"""Local JSON lexical repairs. Never executes text or guesses missing structure."""

from __future__ import annotations

REPAIR_ALGORITHM = "python_deterministic_v6"


def escape_raw_string_controls(source: str) -> tuple[str, list[int], list[int]]:
    """Encode raw control bytes only inside JSON strings.

    Legal escapes, including double-escaped backslashes, stay unchanged. A raw
    CRLF in a string becomes one logical newline (the historical behaviour).
    A backslash immediately followed by a raw control character is retained as
    a literal backslash, NOT discarded as a language-specific line continuation.
    Positions refer to the input to this pass, before any edits.
    """
    output: list[str] = []
    newlines: list[int] = []
    controls: list[int] = []
    in_string = False
    index = 0
    while index < len(source):
        char = source[index]
        if in_string and char == "\\" and index + 1 < len(source):
            following = source[index + 1]
            if ord(following) >= 32:
                output.extend((char, following))
                index += 2
                continue
            # Encode the literal slash; the following control is handled below
            # on the next iteration. Never join two executable command lines.
            output.append("\\\\")
        elif in_string and ord(char) < 32:
            if char in "\r\n":
                newlines.append(index)
                if char == "\r" and index + 1 < len(source) and source[index + 1] == "\n":
                    index += 1
                output.append("\\n")
            else:
                controls.append(index)
                output.append(f"\\u{ord(char):04x}")
        else:
            output.append(char)
            if char == '"':
                in_string = not in_string
        index += 1
    return "".join(output), newlines, controls


def escape_raw_string_newlines(source: str) -> tuple[str, list[int]]:
    """Compatibility entry point; the parser also records other control bytes."""
    fixed, newlines, _ = escape_raw_string_controls(source)
    return fixed, newlines


def markdown_text_location_allowed(location: tuple) -> bool:
    return location == ("answer",) or location == ("arguments", "content")
