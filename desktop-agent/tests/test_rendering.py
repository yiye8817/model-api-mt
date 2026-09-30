from io import StringIO

from fusion_agent.rendering import normalize_final_markdown, render_markdown


def test_literal_markdown_line_breaks_are_restored_for_tables_and_quotes():
    source = "标题\\n> 引用\\n\\n| 名称 | 值 |\\n|---|---|\\n| app | 499MB |"

    normalized, changes = normalize_final_markdown(source)

    assert "\\n" not in normalized
    assert "标题\n> 引用\n\n| 名称 | 值 |" in normalized
    assert changes[0]["kind"] == "escaped_markdown_line_breaks_all"

    output = StringIO()
    render_markdown(source, output, width=80)
    rendered = output.getvalue()
    assert "│ 引用" in rendered
    assert "名称" in rendered and "499MB" in rendered


def test_single_backtick_multiline_code_block_is_formatted():
    source = "## 命令\\n`bash\\nadb shell top -b\\n`"

    output = StringIO()
    render_markdown(source, output, width=80)

    rendered = output.getvalue()
    assert "[bash]" in rendered
    assert "adb shell top -b" in rendered


def test_short_plain_literal_newline_escape_is_preserved():
    source = r"返回字面量 \\n 文本"

    normalized, changes = normalize_final_markdown(source)

    assert normalized == source
    assert changes == []
