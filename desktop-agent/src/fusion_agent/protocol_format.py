"""Explicit model-facing JSON output contract; runtime validates independently.

Web chat providers cannot guarantee constrained decoding. The prompt therefore
never substitutes for strict local parsing and per-tool schema validation.
"""
import json

PROTOCOL_SCHEMA = {
    "oneOf": [
        {"type": "object", "additionalProperties": False,
         "required": ["type", "answer"], "properties": {
             "type": {"enum": ["final"]}, "answer": {"type": "string", "minLength": 1, "maxLength": 262144}}},
        {"type": "object", "additionalProperties": False,
         "required": ["type", "tool", "arguments", "summary"], "properties": {
             "type": {"enum": ["action"]}, "tool": {"type": "string", "minLength": 1, "maxLength": 80},
             "arguments": {"type": "object"}, "summary": {"type": "string", "maxLength": 2000},
             "plan": {"type": "array", "maxItems": 30, "items": {"type": "string", "maxLength": 2000}}}},
    ]
}

FORMAT_RULES = r'''
输出编码是严格 JSON，不是 Markdown/Python 字典。必须遵守：
1. 仅输出一个完整对象，首字符 {，末字符 }；键名与字符串必须用 ASCII 双引号。禁止解释前缀、代码围栏、注释、重复字段、多对象和尾逗号。
2. 字符串内部的双引号必须写为 \"；反斜杠写为 \\；换行写为 \n；回车写为 \r；制表符写为 \t。禁止裸换行、单引号代替 JSON 引号，以及 \_、\* 等非法 JSON 转义。
3. 每个字符串的起止双引号必须配对；字符串外的 { } 和 [ ] 必须匹配。字符串内经过转义的引号/括号不是 JSON 结构，不得错误提前结束。
4. 布尔值使用 true/false，空值使用 null；禁止 True/False/None、NaN、Infinity。禁止把整个 JSON 再转义为一个字符串。
5. Python 源码放入 python.run.arguments.code，作为一个正确转义的 JSON 字符串；命令优先使用 argv 数组。不要在 command 中嵌套未转义的双引号。
6. Python 的字符串字面量优先用单引号；必须用双引号时，仍需先做 JSON 转义。文件路径等数据优先放入 arguments.input，脚本从 sys.argv[1] 读取，不把长路径拼入 code。Python 源码中的字典、f-string、引号和反斜杠也属于 JSON 字符串内容，不得提前闭合 code。
7. 发送前检查对象完整性、字符串编码、字段类型，以及工具 arguments 是否与目录中的 parameters 一致。只输出通过检查的对象，不输出检查过程。
以下仅为编码示例，不是新的执行任务：
'''


def format_contract():
    examples = [
        {"type": "final", "answer": '这里的 "Prompt as Code" 只是文字。\n下一段。'},
        {"type": "action", "tool": "python.run", "arguments": {
            "code": 'print("ready")\n', "purpose": "编码示例，不要执行"}, "summary": "演示源码的正确 JSON 编码"},
        {"type": "action", "tool": "python.run", "arguments": {
            "code": "import json, sys\nfrom pathlib import Path\nparams = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))\nprint(params['path'])\n",
            "input": {"path": "/path/to/events.jsonl"}, "purpose": "输入参数编码示例，不要执行"},
            "summary": "路径作为数据传递，不插入 Python 源码"},
    ]
    return FORMAT_RULES + '\n'.join(json.dumps(x, ensure_ascii=False, allow_nan=False) for x in examples) + '\n输出对象 schema：\n' + json.dumps(PROTOCOL_SCHEMA, ensure_ascii=False)
