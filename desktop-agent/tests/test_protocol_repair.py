import json

import pytest

from fusion_agent.runtime import ProtocolError, parse_reply
from fusion_agent.registry import validate
from fusion_agent.web_fetch import WebFetchTools


def test_known_conversation_wrapper_and_markdown_array_escapes_are_repaired():
    reply = (
        '{"type":"action","tool":"shell.run","arguments":{"argv":\\["adb","shell",'
        '"dumpsys","meminfo","com.ist.whiteboard"\\]},"summary":"读取 meminfo",'
        '"plan":\\["读取","分析"\\]}\n\n</conversation\\_message>'
    )
    changes = []

    action = parse_reply(reply, changes)

    assert action["arguments"]["argv"][-1] == "com.ist.whiteboard"
    assert any(item["kind"] == "known_trailing_protocol_marker" for item in changes)
    assert any(item["kind"] == "markdown_array_delimiters" for item in changes)


def test_unknown_trailing_text_remains_rejected():
    reply = json.dumps({
        "type": "action",
        "tool": "shell.run",
        "arguments": {"argv": ["adb", "shell", "getprop"]},
        "summary": "读取设备属性",
    }, ensure_ascii=False) + "\n额外说明"

    with pytest.raises(ProtocolError, match="Extra data"):
        parse_reply(reply)


def test_known_conversation_wrapper_pair_is_removed():
    inner = json.dumps({
        "type": "action",
        "tool": "shell.run",
        "arguments": {"argv": ["adb", "shell", "getprop"]},
        "summary": "读取设备属性",
    }, ensure_ascii=False)
    changes = []

    action = parse_reply(f"<conversation_message>\n{inner}\n</conversation_message>", changes)

    assert action["tool"] == "shell.run"
    assert any(item["kind"] == "known_protocol_wrapper_pair" for item in changes)


def test_one_redundant_object_closer_is_removed_after_complete_action():
    inner = json.dumps({
        "type": "action",
        "tool": "shell.run",
        "arguments": {"argv": ["adb", "shell", "top"]},
        "summary": "读取进程信息",
    }, ensure_ascii=False)
    changes = []

    action = parse_reply(inner + "\n\n}", changes)

    assert action["arguments"]["argv"][-1] == "top"
    assert any(item["kind"] == "redundant_json_object_closers" for item in changes)


def test_final_display_metadata_is_dropped_without_changing_answer():
    reply = json.dumps({
        "type": "final",
        "answer": "结果正文",
        "summary": "任务摘要",
    }, ensure_ascii=False)
    changes = []

    result = parse_reply(reply, changes)

    assert result == {"type": "final", "answer": "结果正文"}
    assert any(item["kind"] == "final_display_metadata_dropped" for item in changes)


def test_verified_search_redirect_markdown_url_is_unwrapped_for_web_fetch():
    reply = (
        '{"type":"action","tool":"web.fetch","arguments":{"url":"'
        '[https://passport.baidu.com/](https://link.wtturl.cn/?target=https%3A%2F%2Fpassport.baidu.com%2F&scene=im "autolink")",'
        '"timeout":30},"summary":"读取公开页面"}'
    )
    changes = []

    action = parse_reply(reply, changes)

    assert action["arguments"]["url"] == "https://passport.baidu.com/"
    assert any(item["kind"] == "markdown_url_unwrapped" for item in changes)


def test_doubao_20260924_030121_combined_json_damage_is_repaired_without_execution(tmp_path):
    # Original reply from the failed run: nested unescaped link-title quotes,
    # a Markdown-escaped schema key, and escaped array delimiters coexist.
    reply = (
        r'{"type":"action","tool":"web.fetch","arguments":{"url":"'
        r'[https://github.com/topics/iptv](https://link.wtturl.cn/?target=https%3A%2F%2Fgithub.com%2Ftopics%2Fiptv&scene=im&aid=497858&lang=zh "autolink")",'
        r'"timeout":60,"max\_chars":10000},"summary":" 读取 GitHub iptv 主题页面，获取相关仓库列表，作为项目抓取入口 ",'
        r'"plan":\[" 拉取 github topics/iptv 页面 "," 提取仓库链接 "," 整理仓库清单 "\]}'
    )
    changes = []

    action = parse_reply(reply, changes)

    assert action["type"] == "action"
    assert action["tool"] == "web.fetch"
    assert action["arguments"] == {
        "url": "https://github.com/topics/iptv", "timeout": 60, "max_chars": 10000,
    }
    assert action["plan"] == [" 拉取 github topics/iptv 页面 ", " 提取仓库链接 ", " 整理仓库清单 "]
    spec = next(item for item in WebFetchTools(tmp_path).specs() if item.name == "web.fetch")
    validate(action["arguments"], spec.parameters)
    assert {item["kind"] for item in changes} == {
        "markdown_text_escapes", "unescaped_text_quotes", "markdown_array_delimiters", "markdown_url_unwrapped",
    }


def test_json_repair_candidate_normalizes_schema_known_markdown_key(tmp_path):
    """json_repair's valid-but-literal ``max\\_chars`` key must be canonicalized."""
    json_repair = pytest.importorskip("json_repair")
    from fusion_agent.runtime import Runtime

    reply = (
        r'{"type":"action","tool":"web.fetch","arguments":{"url":"'
        r'[https://github.com/open-free-llm-api/awesome-freellm-apis](https://link.wtturl.cn/?target=https%3A%2F%2Fgithub.com%2Fopen-free-llm-api%2Fawesome-freellm-apis&scene=im&aid=497858&lang=zh "autolink")",'
        r'"timeout":60,"max\_chars":15000},"summary":"读取公开接口清单",'
        r'"plan":\["抓取 README","整理接口"\]}\n\n}'
    )
    candidate = json_repair.repair_json(reply, return_objects=False)
    changes = []
    action = parse_reply(candidate, changes)
    assert "max\\_chars" in action["arguments"]
    specs = {item.name: item.public() for item in WebFetchTools(tmp_path).specs()}

    Runtime._normalize_repair_argument_keys(action, specs, changes)
    validate(action["arguments"], specs["web.fetch"]["parameters"])

    assert action["arguments"]["max_chars"] == 15000
    assert "max\\_chars" not in action["arguments"]
    assert any(item["kind"] == "json_repair_argument_key_markdown_escape" for item in changes)
