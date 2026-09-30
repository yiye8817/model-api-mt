"""Explainable, conservative routing for a user's first agent turn.

The router is deliberately not an authorization system.  It can keep an
answer-only request out of the action loop, but it can never grant a tool or a
capability.  In particular, side-effectful actions require both an explicit
request detected here *and* the normal runtime permission checks.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import date, datetime, timezone
import math
import re
import unicodedata


CHAT = "chat"
KNOWLEDGE_QUERY = "knowledge_query"
REALTIME_QUERY = "realtime_query"
TASK_ACTION = "task_action"


@dataclass(frozen=True)
class IntentDecision:
    """A routing recommendation plus auditable evidence.

    ``side_effect_gate_open`` only records that the user explicitly requested
    a side effect.  It does not bypass the tool catalog, capability allow-list,
    schema validation, or any confirmation enforced by the runtime.
    """

    kind: str
    confidence: float
    direct_to_model: bool
    realtime_required: bool
    explicit_search_requested: bool
    action_loop_requested: bool
    side_effect_gate_open: bool
    requested_capabilities: tuple[str, ...]
    mutating_capabilities: tuple[str, ...]
    requested_targets: tuple[str, ...]
    reasons: tuple[str, ...]
    evidence: tuple[str, ...]

    def as_dict(self) -> dict:
        data = asdict(self)
        data["requested_capabilities"] = list(self.requested_capabilities)
        data["mutating_capabilities"] = list(self.mutating_capabilities)
        data["requested_targets"] = list(self.requested_targets)
        data["reasons"] = list(self.reasons)
        data["evidence"] = list(self.evidence)
        return data

    @classmethod
    def from_dict(cls, value: dict) -> "IntentDecision":
        """Strictly restore a decision from persisted state.

        State is treated as untrusted input: unknown/missing fields, loose truthy
        values, contradictory routing flags, and oversized evidence are rejected
        rather than silently opening an action or side-effect gate.
        """

        fields = {
            "kind", "confidence", "direct_to_model", "realtime_required",
            "explicit_search_requested", "action_loop_requested",
            "side_effect_gate_open", "reasons", "evidence",
            "requested_capabilities", "mutating_capabilities", "requested_targets",
        }
        if not isinstance(value, dict) or set(value) != fields:
            raise ValueError("invalid persisted intent fields")
        kind = value["kind"]
        if kind not in {CHAT, KNOWLEDGE_QUERY, REALTIME_QUERY, TASK_ACTION}:
            raise ValueError("invalid persisted intent kind")
        confidence = value["confidence"]
        if (isinstance(confidence, bool) or not isinstance(confidence, (int, float))
                or not math.isfinite(confidence) or not 0 <= confidence <= 1):
            raise ValueError("invalid persisted intent confidence")
        bool_fields = (
            "direct_to_model", "realtime_required", "explicit_search_requested",
            "action_loop_requested", "side_effect_gate_open",
        )
        if any(type(value[name]) is not bool for name in bool_fields):
            raise ValueError("invalid persisted intent flags")

        def text_tuple(name):
            items = value[name]
            if (not isinstance(items, (list, tuple)) or len(items) > 32
                    or any(not isinstance(item, str) or len(item) > 500 for item in items)):
                raise ValueError(f"invalid persisted intent {name}")
            return tuple(items)

        reasons = text_tuple("reasons")
        evidence = text_tuple("evidence")
        requested_capabilities = text_tuple("requested_capabilities")
        mutating_capabilities = text_tuple("mutating_capabilities")
        requested_targets = text_tuple("requested_targets")
        allowed_capabilities = {"files", "shell", "browser", "desktop", "web", "skills"}
        if (len(set(requested_capabilities)) != len(requested_capabilities)
                or any(item not in allowed_capabilities for item in requested_capabilities)):
            raise ValueError("invalid persisted requested capabilities")
        if (len(set(mutating_capabilities)) != len(mutating_capabilities)
                or any(item not in requested_capabilities or item in {"web", "skills"}
                       for item in mutating_capabilities)):
            raise ValueError("invalid persisted mutating capabilities")
        if (len(set(requested_targets)) != len(requested_targets)
                or any(not item.startswith(("file:", "url:")) for item in requested_targets)):
            raise ValueError("invalid persisted requested targets")
        action = value["action_loop_requested"]
        if value["direct_to_model"] == action:
            raise ValueError("contradictory persisted intent route")
        if (kind == TASK_ACTION) != action:
            raise ValueError("persisted action kind does not match action gate")
        if value["side_effect_gate_open"] and not action:
            raise ValueError("persisted side-effect gate lacks an action request")
        if value["side_effect_gate_open"] != bool(mutating_capabilities):
            raise ValueError("persisted side-effect gate does not match requested mutation scopes")
        if value["explicit_search_requested"] and not value["realtime_required"]:
            raise ValueError("persisted explicit search lacks real-time routing")
        if kind == REALTIME_QUERY and not value["realtime_required"]:
            raise ValueError("persisted real-time kind lacks real-time routing")
        if value["realtime_required"] and "web" not in requested_capabilities:
            raise ValueError("persisted real-time route lacks web scope")
        if kind in {CHAT, KNOWLEDGE_QUERY} and value["realtime_required"]:
            raise ValueError("persisted answer-only kind has contradictory real-time routing")
        return cls(
            kind=kind,
            confidence=float(confidence),
            direct_to_model=value["direct_to_model"],
            realtime_required=value["realtime_required"],
            explicit_search_requested=value["explicit_search_requested"],
            action_loop_requested=action,
            side_effect_gate_open=value["side_effect_gate_open"],
            requested_capabilities=requested_capabilities,
            mutating_capabilities=mutating_capabilities,
            requested_targets=requested_targets,
            reasons=reasons,
            evidence=evidence,
        )


@dataclass(frozen=True)
class SearchEscalation:
    """Whether a model answer needs a read-only live-search follow-up."""

    should_search: bool
    confidence: float
    reasons: tuple[str, ...]
    evidence: tuple[str, ...]

    def as_dict(self) -> dict:
        data = asdict(self)
        data["reasons"] = list(self.reasons)
        data["evidence"] = list(self.evidence)
        return data


_CONTINUATIONS = re.compile(
    r"^(?:继续|接着(?:做|说)?|继续上一步|continue|go on|keep going|resume)[。.!！?？\s]*$",
    re.IGNORECASE,
)
_CHAT_ONLY = re.compile(
    r"^(?:你好|您好|嗨|哈喽|谢谢|多谢|早上好|下午好|晚上好|在吗|"
    r"hello|hi|hey|thanks|thank you|good (?:morning|afternoon|evening))[。.!！?？\s]*$",
    re.IGNORECASE,
)
_ACTION_CANCELLATION = re.compile(
    r"(?:算了|取消(?:这个|该|上个|之前)?任务|别(?:再)?继续|不要再(?:做|执行|操作|继续)|"
    r"不要操作(?:电脑|系统|文件|浏览器)|"
    r"(?:停止|停下)[，,。.!！\s]*(?:不要|别|当前|这个|任务|操作|执行|继续|吧|了)|"
    r"\b(?:never mind|cancel (?:it|that|the task)|do not continue|don't continue|"
    r"stop (?:now|the task|doing that)|answer only|do not take action)\b)",
    re.IGNORECASE,
)
_DECLINES_REALTIME_SEARCH = re.compile(
    r"(?:不(?:用|需要|必)(?:再)?(?:联网|搜索|检索|实时)|无需(?:联网|搜索|检索|实时)|"
    r"不要(?:联网|搜索|检索)|只(?:用|使用)已有(?:内容|信息|结果)|"
    r"\b(?:no (?:web )?search|do not search|don't search|without (?:live|web) search|use existing results only)\b)",
    re.IGNORECASE,
)

# Searching the public web is a read-only information request, not proof that
# the user authorized unrelated browser or filesystem actions.
_EXPLICIT_SEARCH = (
    re.compile(r"(?:联网|上网|网上|网络|web)[^。！？\n]{0,12}(?:搜索|检索|查询|查找|查一下)"),
    re.compile(r"(?:搜索|检索|查询|查找|查一下)[^。！？\n]{0,12}(?:联网|上网|网上|网络|web)"),
    re.compile(r"(?:请|麻烦(?:你)?|帮我|替我|用|使用)\s*(?:多路|并行|同时|multi[- ]route|parallel)*\s*(?:搜索|检索|查找|查一下)", re.IGNORECASE),
    re.compile(r"^(?:多路|并行|同时)\s*(?:并行|多路)?\s*(?:搜索|检索|查找|查一下)"),
    # A leading imperative search is explicit even without the word “web”.
    # Exclude common noun phrases so “搜索算法是什么” remains stable knowledge.
    re.compile(r"^\s*(?:搜索|检索|查找|查一下)(?!算法|引擎|功能|框|词|技巧|原理)"),
    re.compile(r"\b(?:search|browse|look up|check)\s+(?:on\s+)?(?:the\s+)?web\b", re.IGNORECASE),
    re.compile(r"\b(?:online search|web search)\b", re.IGNORECASE),
    re.compile(r"\bplease\s+(?:(?:parallel|multi[- ]route)\s+)?(?:search|look up|check)\b", re.IGNORECASE),
    re.compile(r"^\s*(?:search(?:\s+for)?|look\s+up)\s+(?!algorithms?\b|engines?\b)", re.IGNORECASE),
)

_REALTIME_STRONG = (
    re.compile(r"最新|实时|刚刚|今日|今天|今晚|本周|本月|近期|最近|现任|当前版本|当前价格|现在的|截至(?:今天|今日|目前|现在)"),
    re.compile(r"\b(?:latest|live|breaking|today|tonight|this week|this month|right now|as of now|currently serving|current (?:version|price))\b", re.IGNORECASE),
)
_VOLATILE_TOPICS = (
    re.compile(r"新闻|天气|气温|空气质量|股价|股票|指数|汇率|币价|价格|票价|油价|金价|比分|赛果|赛程|排名|航班|列车|路况|热搜|榜单|选举结果|现任|版本|发布状态|服务器状态"),
    re.compile(r"\b(?:news|weather|temperature|air quality|stock|share price|market|exchange rate|crypto|price|fare|score|result|schedule|standing|flight|train|traffic|trending|election result|president|prime minister|ceo|version|release status|service status)\b", re.IGNORECASE),
)
_TIME_CONTEXT = (
    re.compile(r"现在|目前|此刻|截至|今天|今日|刚刚|最近|本周|本月|今年|202[0-9]年"),
    re.compile(r"\b(?:now|current|currently|today|recent|this (?:week|month|year)|as of|in 202[0-9])\b", re.IGNORECASE),
)
_STABLE_CONTEXT = re.compile(
    r"(?:什么是|是什么|何为|定义|原理|机制|历史|概念|科普|教程|为什么|为何|如何(?:形成|运作|工作)|"
    r"\b(?:what is|what are|how does|how do|why does|why do|define|definition|principle|mechanism|history|concept|tutorial)\b)",
    re.IGNORECASE,
)
_CONTENT_TRANSFORM_CONTEXT = re.compile(
    r"摘录|给定内容|已有内容|格式|排版|翻译|改写|润色|校对|整理|分类|语法|写作|传播|"
    r"\b(?:excerpt|given (?:text|content)|format|layout|translate|rewrite|proofread|polish|grammar|writing)\b",
    re.IGNORECASE,
)
_CONTENT_GENERATION = re.compile(
    r"写一首|写(?:个|一个|篇|段)(?:故事|笑话|诗|文案|文章)|讲(?:个|一个)?笑话|创作|起草|生成(?:一段|一个|代码|文本)|"
    r"\b(?:write|compose|draft|generate|create|tell me)\b.{0,24}\b(?:poem|story|joke|copy|article|code|text)\b",
    re.IGNORECASE,
)

_KNOWLEDGE_MARKERS = (
    re.compile(r"什么|为何|为什么|怎么|如何|谁|哪里|多少|解释|介绍|区别|比较|总结|列出|告诉我|查询|查一下|是否|能否|可以吗|吗[？?]?"),
    re.compile(r"\b(?:what|why|how|who|where|when|which|explain|describe|compare|summari[sz]e|list|tell me|is|are|can|could|would)\b", re.IGNORECASE),
)

# Environment-facing verbs are intentionally narrower than general generation
# verbs.  For example, "写一首诗" stays answer-only, while "写入文件" is an
# action request.
_ACTION_VERBS_ZH = r"打开|关闭|点击|填写|输入|选择|运行|执行|安装|卸载|下载|上传|创建|新建|删除|移除|移动|复制|重命名|编辑|修改|写入|保存|发送|提交|启动|停止|控制|压缩|解压|读取|查看|列出|浏览|调用"
_ACTION_VERBS_EN = r"open|close|click|fill|type|select|run|execute|install|uninstall|download|upload|create|delete|remove|move|copy|rename|edit|modify|write|save|send|submit|start|stop|control|archive|extract|read|view|list|inspect"
_ENV_TARGETS = re.compile(
    r"文件|目录|文件夹|终端|命令|脚本|本地工具|Python工具|Python 工具|浏览器|网页|页面|桌面|屏幕|窗口|按钮|输入框|鼠标|指针|应用|程序|软件|服务|数据库|仓库|路径|"
    r"\b(?:file|folder|directory|terminal|command|script|browser|web ?page|desktop|screen|window|button|input|mouse|pointer|app|application|program|software|service|database|repository|repo|path)\b|"
    r"(?:^|\s)(?:~/|/[^\s]+|\.?\.?/[^\s]+)|"
    r"(?<![\w./~-])[\w][\w.-]{0,127}\.(?:md|markdown|txt|json|jsonl|ya?ml|csv|tsv|py|js|ts|html|css|sh)\b",
    re.IGNORECASE,
)
_DIRECTIVE = re.compile(r"请|麻烦|帮我|替我|给我|立即|马上|现在就|务必|please|could you|would you|for me", re.IGNORECASE)
_ACTION_AT_START = re.compile(
    rf"^\s*(?:请(?:你)?|麻烦(?:你)?|帮我|替我|please\s+)?(?:{_ACTION_VERBS_ZH}|(?:{_ACTION_VERBS_EN})\b)",
    re.IGNORECASE,
)
_BA_ACTION = re.compile(
    rf"(?:^\s*|[，,；;]\s*)(?:请(?:你)?|麻烦(?:你)?|帮我|替我)?\s*(?:把|将)[^。！？\n]{{0,64}}"
    rf"(?:{_ACTION_VERBS_ZH}|(?:{_ACTION_VERBS_EN})\b)",
    re.IGNORECASE,
)
_ACTION_ANYWHERE = re.compile(rf"(?:{_ACTION_VERBS_ZH}|\b(?:{_ACTION_VERBS_EN})\b)", re.IGNORECASE)
_ACTION_CLAUSE = re.compile(
    rf"(?:并(?:且)?|然后|随后|接着|再|并再|,\s*(?:then\s+)?|;\s*(?:then\s+)?|\band\s+(?:then\s+)?|\bthen\s+)"
    rf"(?:请(?:你)?|帮我|替我|please\s+)?(?:{_ACTION_VERBS_ZH}|(?:{_ACTION_VERBS_EN})\b)",
    re.IGNORECASE,
)
_LOCATIVE_ACTION = re.compile(
    rf"^\s*(?:在|于)\s*(?:浏览器|网页|页面|桌面|屏幕|窗口|应用|程序|软件)"
    rf"[^。！？\n]{{0,48}}(?:{_ACTION_VERBS_ZH})|"
    rf"^\s*(?:in|on)\s+(?:the\s+)?(?:browser|web ?page|desktop|screen|window|app|application)"
    rf"[^.!?\n]{{0,48}}\b(?:{_ACTION_VERBS_EN})\b",
    re.IGNORECASE,
)
_HOW_TO = re.compile(r"如何|怎么(?:做|才能)?|教程|示例|说明|能否|可以(?:不|吗)|是否可以|how (?:do|can|to)|example|tutorial|is it possible|can (?:I|you)\b", re.IGNORECASE)
_NEGATED_ACTION = re.compile(rf"(?:不要|别|无需|禁止|不能|do not|don't|never)\s*(?:{_ACTION_VERBS_ZH}|{_ACTION_VERBS_EN})", re.IGNORECASE)
_SIDE_EFFECT = re.compile(
    r"打开|关闭|删除|移除|写入|保存|修改|编辑|重命名|移动|复制|安装|卸载|上传|发送|提交|创建|新建|执行|运行|调用|点击|填写|输入|选择|控制|"
    r"\b(?:open|close|delete|remove|write|save|modify|edit|rename|move|copy|install|uninstall|upload|send|submit|create|execute|run|click|fill|type|select|control)\b",
    re.IGNORECASE,
)

_STALE_FEEDBACK = (
    re.compile(r"知识截止|知识更新至|无法.{0,8}(?:实时|联网|浏览|访问网络|确认最新)|不能.{0,8}(?:实时|联网|浏览|访问网络|确认最新)|不保证.{0,6}(?:最新|实时)|可能不是最新|截至.{0,12}(?:知识|训练数据)|需要联网(?:确认|查询)|我没有实时"),
    re.compile(r"\b(?:knowledge cutoff|training data (?:ends|ended)|cannot (?:browse|access|verify)|can't (?:browse|access|verify)|no (?:live|real[- ]time) access|may be out of date|not necessarily (?:current|up to date)|need to (?:browse|search|check) (?:the )?web)\b", re.IGNORECASE),
)
_LIVE_PROVENANCE = re.compile(
    r"(?:(?:已|刚刚|实时)(?:检索|搜索|查询|抓取|获取|更新)|"
    r"(?:检索|搜索|查询|抓取|获取|更新时间|数据时间)\s*(?:于|时间为|时间|：|:)?\s*(?:今天|今日|刚刚|202[0-9]))|"
    r"\b(?:(?:live|real[- ]time) (?:search|lookup|result)|"
    r"(?:searched|retrieved|fetched|checked|updated)\s+(?:at|on|today|just now|202[0-9]))\b",
    re.IGNORECASE,
)
# A bare URL adjacent to Chinese prose ends at that prose. Percent-encode
# non-ASCII URL components (or separate the URL with whitespace) when needed.
_URL = re.compile(r"https?://[^\s<>\]\)\"'`\u3000-\u303f\u3400-\u9fff\uff00-\uffef]+", re.IGNORECASE)
_WEB_READ = re.compile(
    r"解析|抓取|爬取|获取|读取|查看|访问|提取|分析|总结|汇总|整理|浏览|"
    r"\b(?:fetch|retrieve|read|view|visit|parse|scrape|analy[sz]e|summari[sz]e|inspect|browse)\b",
    re.IGNORECASE,
)
_WEB_REFERENCE = re.compile(r"(?:上述|上面|之前|这个|该|此)(?:网页|页面|网址|链接)|"
                            r"(?:网页|页面|网址|链接)(?:中|里|内|的)|"
                            r"\b(?:this|that|above|previous) (?:page|url|link|website)\b", re.IGNORECASE)



def _matches(patterns, text: str) -> list[str]:
    found = []
    for pattern in patterns:
        match = pattern.search(text)
        if match:
            found.append(match.group(0))
    return found


def _decision(kind: str, confidence: float, *, realtime=False, search=False,
              action=False, side_effect=False, capabilities=(), mutating_capabilities=(),
              targets=(), reasons=(), evidence=()) -> IntentDecision:
    capabilities = tuple(dict.fromkeys((*capabilities, *(("web",) if realtime else ()))))
    mutating_capabilities = tuple(dict.fromkeys(mutating_capabilities))
    return IntentDecision(
        kind=kind,
        confidence=round(max(0.0, min(1.0, confidence)), 2),
        direct_to_model=not action,
        realtime_required=bool(realtime),
        explicit_search_requested=bool(search),
        action_loop_requested=bool(action),
        side_effect_gate_open=bool(side_effect),
        requested_capabilities=capabilities,
        mutating_capabilities=mutating_capabilities,
        requested_targets=tuple(dict.fromkeys(targets)),
        reasons=tuple(reasons),
        evidence=tuple(evidence),
    )


def declines_realtime_search(text: str) -> bool:
    """Return true only for an explicit instruction to keep existing information."""
    if not isinstance(text, str):
        return False
    return bool(_DECLINES_REALTIME_SEARCH.search(unicodedata.normalize("NFKC", text)))


_FILE_TARGET_TOKEN = re.compile(
    r"(?<![\w:])(?:~?/|\.{1,2}/|/)[^\s\x00-\x1f<>|\"']+|"
    r"(?<![\w./~-])[\w][\w.-]{0,127}\.(?:md|markdown|txt|json|jsonl|ya?ml|csv|tsv|py|js|ts|html|css|sh)\b",
    re.IGNORECASE,
)
_FILE_WORD = re.compile(r"文件|目录|文件夹|路径|\b(?:file|folder|directory|path)\b", re.IGNORECASE)
_SHELL_WORD = re.compile(r"终端|命令|脚本|命令行|本地工具|Python工具|Python 工具|\b(?:terminal|command|script|cli|shell|python tool)\b", re.IGNORECASE)
_BROWSER_WORD = re.compile(r"浏览器|网页|页面|\b(?:browser|web ?page|tab)\b", re.IGNORECASE)
_DESKTOP_WORD = re.compile(r"桌面|屏幕|窗口|鼠标|指针|应用|程序|软件|\b(?:desktop|screen|window|mouse|pointer|app|application|program|software)\b", re.IGNORECASE)
_DESKTOP_STRONG_WORD = re.compile(
    r"桌面应用|应用窗口|桌面|屏幕|鼠标|指针|"
    r"\b(?:desktop\s+(?:app|application)|application\s+window|"
    r"desktop|screen|mouse|pointer)\b",
    re.IGNORECASE,
)
_FILE_MUTATION = re.compile(r"写入|保存|创建|新建|删除|移除|移动|复制|重命名|编辑|修改|上传|下载|\b(?:write|save|create|delete|remove|move|copy|rename|edit|modify|upload|download)\b", re.IGNORECASE)
_BROWSER_MUTATION = re.compile(r"打开|关闭|点击|填写|输入|选择|上传|下载|发送|提交|\b(?:open|close|click|fill|type|select|upload|download|send|submit)\b", re.IGNORECASE)
_DESKTOP_MUTATION = re.compile(r"打开|关闭|点击|填写|输入|选择|控制|移动|\b(?:open|close|click|fill|type|select|control|move)\b", re.IGNORECASE)


def _requested_targets(text: str) -> tuple[str, ...]:
    urls = [(match.start(), match.end(), match.group(0).rstrip("，。！？,.;；)）]】"))
            for match in _URL.finditer(text)]
    targets = ["url:" + value for _, _, value in urls]
    for match in _FILE_TARGET_TOKEN.finditer(text):
        if any(left <= match.start() < right for left, right, _ in urls):
            continue
        value = match.group(0).rstrip("，。！？,.;；)）]】")
        if value:
            targets.append("file:" + value)
    return tuple(dict.fromkeys(targets))[:32]


def _mask_target_tokens(text: str) -> str:
    """Hide URL/path basenames before matching natural-language keywords.

    Names such as ``input.txt``, ``browser.md`` and ``example.com`` must not be
    interpreted as the verbs/keywords input, browser or example.  The original
    string remains available to the target extractor and is never rewritten in
    the task sent to the model.
    """
    spans = [(match.start(), match.end()) for match in _URL.finditer(text)]
    spans.extend((match.start(), match.end()) for match in _FILE_TARGET_TOKEN.finditer(text))
    if not spans:
        return text
    characters = list(text)
    for left, right in spans:
        characters[left:right] = " " * (right - left)
    return "".join(characters)


def _requested_scopes(text: str, *, realtime: bool) -> tuple[tuple[str, ...], tuple[str, ...]]:
    capabilities = []
    mutating = []
    targets = _requested_targets(text)
    semantic_text = _mask_target_tokens(text)
    has_file_target = any(item.startswith("file:") for item in targets)
    browser = bool(_BROWSER_WORD.search(semantic_text) or any(item.startswith("url:") for item in targets))
    desktop = bool(_DESKTOP_STRONG_WORD.search(semantic_text)
                   or (_DESKTOP_WORD.search(semantic_text) and not browser))
    files = bool(_FILE_WORD.search(semantic_text) or has_file_target)
    shell = bool(_SHELL_WORD.search(semantic_text))
    if realtime:
        capabilities.append("web")
    for enabled, name in ((files, "files"), (shell, "shell"), (browser, "browser"), (desktop, "desktop")):
        if enabled:
            capabilities.append(name)
    if files and _FILE_MUTATION.search(semantic_text):
        mutating.append("files")
    if shell and _SIDE_EFFECT.search(semantic_text):
        mutating.append("shell")
    if browser and _BROWSER_MUTATION.search(semantic_text):
        mutating.append("browser")
    if desktop and _DESKTOP_MUTATION.search(semantic_text):
        mutating.append("desktop")
    return tuple(dict.fromkeys(capabilities)), tuple(dict.fromkeys(mutating))


def classify_intent(text: str, previous: IntentDecision | None = None) -> IntentDecision:
    """Classify one input without invoking a model or granting permissions.

    Precedence is governed by hard gates rather than the largest fuzzy score:
    an action needs an environment-facing verb plus imperative evidence, and a
    real-time route needs temporal/search evidence.  Ambiguous text remains in
    the answer-only path.
    """

    if not isinstance(text, str):
        raise TypeError("text must be a string")
    normalized = unicodedata.normalize("NFKC", text).strip()
    if not normalized:
        return _decision(CHAT, 0.35, reasons=("empty_or_whitespace_input",))
    semantic_text = _mask_target_tokens(normalized)

    if _ACTION_CANCELLATION.search(semantic_text):
        return _decision(
            CHAT,
            0.99,
            reasons=("user_cancelled_action_loop", "answer_only_followup"),
            evidence=("action_cancellation",),
        )

    if _CONTINUATIONS.fullmatch(normalized):
        if previous is None:
            return _decision(CHAT, 0.45, reasons=("continuation_without_prior_route",),
                             evidence=(normalized,))
        # A continuation inherits only the already-established gate.  It can
        # never turn an answer-only turn into a side-effectful action.
        return _decision(
            previous.kind,
            min(previous.confidence, 0.82),
            realtime=previous.realtime_required,
            search=previous.explicit_search_requested,
            action=previous.action_loop_requested,
            side_effect=previous.side_effect_gate_open,
            capabilities=previous.requested_capabilities,
            mutating_capabilities=previous.mutating_capabilities,
            targets=previous.requested_targets,
            reasons=("explicit_continuation_of_prior_route",),
            evidence=(normalized,),
        )

    if _CHAT_ONLY.fullmatch(normalized):
        return _decision(CHAT, 0.98, reasons=("standalone_social_message",),
                         evidence=(normalized,))

    search_declined = declines_realtime_search(semantic_text)
    search_evidence = [] if search_declined else _matches(_EXPLICIT_SEARCH, semantic_text)
    volatile_evidence = _matches(_VOLATILE_TOPICS, semantic_text)
    realtime_evidence = _matches(_REALTIME_STRONG, semantic_text)
    time_evidence = _matches(_TIME_CONTEXT, semantic_text)
    stable_context = bool(_STABLE_CONTEXT.search(semantic_text))

    action_match = _ACTION_ANYWHERE.search(semantic_text)
    target_match = _ENV_TARGETS.search(normalized)
    directive_match = _DIRECTIVE.search(semantic_text)
    starts_with_action = _ACTION_AT_START.search(semantic_text)
    ba_action = _BA_ACTION.search(semantic_text)
    action_clause = _ACTION_CLAUSE.search(semantic_text)
    locative_action = _LOCATIVE_ACTION.search(semantic_text)
    how_to = _HOW_TO.search(semantic_text)
    negated = _NEGATED_ACTION.search(semantic_text)
    knowledge_evidence = _matches(_KNOWLEDGE_MARKERS, semantic_text)
    strong_action_syntax = bool(
        starts_with_action
        or action_clause
        or ba_action
        or (locative_action and not knowledge_evidence)
    )
    # Question/how-to wording closes the side-effect gate unless an unambiguous
    # imperative and an environment target are both present.
    explicit_action = bool(
        action_match
        and target_match
        and not negated
        and (strong_action_syntax or (directive_match and not knowledge_evidence))
        and not (how_to and not (directive_match and starts_with_action))
    )
    # Reading an explicit page is a real environment task, not chat. It needs
    # neither browser navigation nor shell authorization for the bundled GET tool.
    # Never infer this from a URL mentioned in code/how-to/negated requests.
    page_targets = tuple(item for item in _requested_targets(normalized) if item.startswith("url:"))
    inherited_page = False
    if not page_targets and previous and _WEB_REFERENCE.search(semantic_text):
        page_targets = tuple(item for item in previous.requested_targets if item.startswith("url:"))
        inherited_page = bool(page_targets)
    web_read = _WEB_READ.search(semantic_text)
    if (page_targets and web_read and not search_declined and not negated and not how_to
            and not re.search(r"(?:不要|别|禁止|无需|不能)\s*(?:访问|解析|抓取|爬取|获取|提取|分析|总结|汇总)|\b(?:do not|don't|never)\s+(?:fetch|retrieve|visit|parse|scrape|analy[sz]e|summari[sz]e|browse)\b", semantic_text, re.I)
            and not _CONTENT_GENERATION.search(semantic_text)
            and not re.search(r"翻译|改写|润色|校对|给定内容|摘录|已有内容|已提供|\b(?:translate|rewrite|proofread|excerpt|provided text)\b", semantic_text, re.I)
            and not _SIDE_EFFECT.search(semantic_text)
            and not _FILE_MUTATION.search(semantic_text)):
        return _decision(
            TASK_ACTION, 0.98, realtime=True, search=bool(search_evidence),
            action=True, capabilities=("web",), targets=page_targets,
            reasons=("explicit_web_content_read", "read_only_environment_action",
                     *(("referenced_previous_user_url",) if inherited_page else ())),
            evidence=(f"web_read:{web_read.group(0)}", *[f"target:{url}" for url in page_targets[:4]]),
        )
    if explicit_action:
        evidence = [f"action_verb:{action_match.group(0)}", f"environment_target:{target_match.group(0)}"]
        if directive_match:
            evidence.append(f"directive:{directive_match.group(0)}")
        if starts_with_action:
            evidence.append("imperative_position:start")
        if action_clause:
            evidence.append(f"coordinated_action:{action_clause.group(0)}")
        if locative_action:
            evidence.append("imperative_construction:locative")
        if ba_action:
            evidence.append("imperative_construction:把/将")
        evidence.extend(f"explicit_search:{value}" for value in search_evidence)
        evidence.extend(f"volatile_topic:{value}" for value in volatile_evidence)
        realtime_action = bool(search_evidence or (realtime_evidence and volatile_evidence))
        capabilities, mutating_capabilities = _requested_scopes(
            normalized, realtime=realtime_action)
        return _decision(
            TASK_ACTION,
            0.96 if directive_match and starts_with_action else 0.9,
            realtime=realtime_action,
            search=bool(search_evidence),
            action=True,
            side_effect=bool(mutating_capabilities),
            capabilities=capabilities,
            mutating_capabilities=mutating_capabilities,
            targets=_requested_targets(normalized),
            reasons=("explicit_environment_action", "runtime_permissions_still_required"),
            evidence=evidence,
        )

    # An explicit web lookup is an information route when the same input does
    # not also contain an explicit environment action.  It authorizes neither a
    # browser click nor any mutation, but the search itself must not be skipped.
    if search_evidence:
        evidence = [f"explicit_search:{value}" for value in search_evidence]
        evidence.extend(f"volatile_topic:{value}" for value in volatile_evidence)
        return _decision(
            REALTIME_QUERY,
            0.99,
            realtime=True,
            search=True,
            reasons=("user_explicitly_requested_web_search", "read_only_information_route"),
            evidence=evidence,
        )

    # Strong temporal language plus a changeable subject, or a strong phrase
    # that is inherently live (最新/实时/today/latest), enters the feedback gate.
    inherently_live = any(re.search(r"最新|实时|刚刚|\b(?:latest|live|breaking|right now)\b",
                                    value, re.IGNORECASE) for value in realtime_evidence)
    content_transform = bool(_CONTENT_TRANSFORM_CONTEXT.search(semantic_text) or _CONTENT_GENERATION.search(semantic_text))
    realtime = bool(not content_transform and (
        (realtime_evidence and (volatile_evidence or inherently_live))
        or (time_evidence and volatile_evidence and not stable_context)))
    # Very short, topic-like queries usually omit words such as "today":
    # "AI新闻", "北京天气", and "BTC价格" nevertheless ask for volatile
    # information.  Limit this inference to compact inputs and close it when a
    # definition/history/mechanism signal makes the stable meaning explicit.
    compact = re.sub(r"[\s，。！？、,.!?;；:：]", "", semantic_text)
    terse_volatile = bool(
        volatile_evidence
        and len(compact) <= 10
        and not stable_context
        and not content_transform
    )
    realtime = realtime or terse_volatile
    if realtime:
        evidence = [f"temporal:{value}" for value in (realtime_evidence or time_evidence)]
        evidence.extend(f"volatile_topic:{value}" for value in volatile_evidence)
        return _decision(
            REALTIME_QUERY,
            0.93 if realtime_evidence and volatile_evidence else 0.84,
            realtime=True,
            reasons=("time_sensitive_information_request", "model_answer_must_pass_freshness_gate"),
            evidence=evidence,
        )

    # Suppressed action evidence is intentionally visible for audit/debugging.
    if knowledge_evidence or how_to or stable_context:
        evidence = [f"query:{value}" for value in knowledge_evidence]
        if action_match and target_match:
            evidence.append("action_gate:closed_by_question_or_missing_imperative")
        if negated:
            evidence.append("action_gate:closed_by_negation")
        return _decision(
            KNOWLEDGE_QUERY,
            0.9 if knowledge_evidence else 0.76,
            reasons=("answerable_information_request", "no_explicit_environment_action"),
            evidence=evidence,
        )

    if _CONTENT_GENERATION.search(semantic_text):
        return _decision(
            CHAT,
            0.9,
            reasons=("answer_content_generation", "no_explicit_environment_action"),
            evidence=("content_generation",),
        )

    return _decision(
        CHAT,
        0.62,
        reasons=("no_realtime_or_action_gate_matched", "default_answer_only_route"),
    )


def _today_markers(now: datetime | date | None) -> tuple[str, ...]:
    if now is None:
        day = datetime.now(timezone.utc).date()
    elif isinstance(now, datetime):
        day = now.date()
    else:
        day = now
    return (
        day.isoformat(),
        f"{day.year}/{day.month}/{day.day}",
        f"{day.year}/{day.month:02d}/{day.day:02d}",
        f"{day.year}-{day.month}-{day.day}",
        f"{day.year}年{day.month}月{day.day}日",
    )


def assess_web_search(task: str, answer: str, *, intent: IntentDecision | None = None,
                      now: datetime | date | None = None) -> SearchEscalation:
    """Apply the post-answer freshness gate for a real-time information query.

    A URL alone is not considered proof of freshness.  To avoid trusting a
    plausible but stale model answer, bypassing search requires current
    retrieval/date provenance.  A URL is useful supporting evidence but is not
    mandatory.  Explicit user requests to search always win.  The result only
    recommends the read-only ``web.search`` tool; normal capability checks
    still apply.
    """

    route = intent if intent is not None else classify_intent(task)
    if route.explicit_search_requested:
        return SearchEscalation(
            True,
            1.0,
            ("explicit_web_search_must_not_be_satisfied_from_model_memory",),
            tuple(route.evidence),
        )
    if not route.realtime_required:
        return SearchEscalation(
            False,
            0.99,
            ("request_is_not_time_sensitive",),
            (f"intent:{route.kind}",),
        )
    if not isinstance(answer, str) or not answer.strip():
        return SearchEscalation(True, 0.99, ("empty_model_feedback",), ())

    stale = _matches(_STALE_FEEDBACK, answer)
    if stale:
        return SearchEscalation(
            True,
            0.99,
            ("model_disclosed_missing_or_stale_live_access",),
            tuple(f"stale_feedback:{value}" for value in stale),
        )

    urls = _URL.findall(answer)
    live_markers = _LIVE_PROVENANCE.findall(answer)
    today_markers = [marker for marker in _today_markers(now) if marker in answer]
    if live_markers or today_markers:
        evidence = []
        if urls:
            evidence.append(f"source_url:{urls[0]}")
        evidence.extend(f"current_date:{value}" for value in today_markers[:2])
        evidence.extend(f"retrieval_marker:{value}" for value in live_markers[:2])
        return SearchEscalation(
            False,
            0.84 if not urls else 0.9,
            ("model_feedback_contains_current_or_retrieval_provenance",),
            tuple(evidence),
        )

    missing = []
    if not live_markers and not today_markers:
        missing.append("missing_current_retrieval_timestamp")
    return SearchEscalation(
        True,
        0.88,
        tuple(missing or ("live_provenance_not_demonstrated",)),
        tuple(f"source_url:{value}" for value in urls[:1]),
    )
