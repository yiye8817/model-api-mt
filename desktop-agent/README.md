# Fusion Desktop Agent 0.17.0

> 信息检索默认采用网页模型已启用的站内 `web_search` 直接结果；只有明确要求本地多路/并行抓取、逐页核实或来源报告时，才调用 Agent 的本地搜索/浏览器工具。`browser-research` 的多路阶段会以 `mode=parallel` 同时调用当前配置中的 DDG/DDGo、Browser Use、OpenCLI 和 Playwright，并稳定去重合并结果。


> 当前 Agent **0.17.0**，对应父应用 **1.17.9**。所有模型 JSON 在本地纠正；`./run.sh skill list` / 交互 `skill` 显示内置及用户技能，切换模型与技能目录不丢失内置技能。`./run.sh doctor` 应显示 `python_deterministic_v5`。参见 [更新说明](../docs/LOCAL_JSON_SKILLS_QWEN_RETRY_1179.md)。
通过父项目的 OpenAI 兼容接口，让指定的网页模型分解任务、调用本地工具、检查执行结果，并输出 Markdown。此目录独立启动；运行任务或进入交互时会检查并按需启动本机父应用，等待 API 与网页桥接就绪。所选模型仍须在父应用中启用并完成登录。

本版配套父应用 **1.17.5**。请同步更新父应用和 Agent；GLM 不刷新、双模型等待、响应文件交接、本地 Python 工具仍保留。**本版不再执行意图分类或关键词工具门控**，原文中的旧路由限制不再适用。

## 0.16.0 既有能力：JSON 修复、统一工具循环与配置持久化

严格 JSON 输出提示 + 本地严格解析 + 有界文本引号纠正 + 每工具 schema 校验。模型返回的 `"Prompt as Code"` 等未转义文本引号可以本地修复；无法确定原意或已截断的响应不执行，不补造缺失文字，原文及报告另存便于调试。

所有输入均有相同的工具目录；模型可选择 action 或 final。workspace 默认仅为相对路径基准和命令 cwd，`filesystem_scope=host` 支持系统用户有权限的绝对路径、`~`、`../`。任意 Python、shell、浏览器、桌面操作仍分别检查能力授权，不能提权。

`/model`、`/workspace`、`/response-mode`、`/verbose`、`/allow`、`/deny`、`/skill load/unload` 自动保存。`/config set 配置名 值` 和离线 `./run.sh config set 配置名 值` 覆盖全部设置。默认保存到 `desktop-agent/agent.config.json`；使用 `--config` 时写回该指定文件。写入使用文件锁、临时文件替换和 0600 权限，不保存真实令牌。`--no-save-config` 可让本次运行参数临时生效。

详见 [配置命令、修复样本和升级说明](../docs/AGENT_JSON_TOOLS_CONFIG_1174.md)。

## 本地工具优先与 Python 实现（保留）

新增 `environment.tools` 检查实际 PATH 程序和当前 Python 环境；`local.run` 优先执行真实命令，仅确认程序不存在且未启动时执行 `fallback_python`；`python.run` 接受模型针对缺失功能编写的完整工具源码，使用当前 Agent 解释器运行。两者都要求 `shell` 能力授权；无需为固定的 `web.fetch/web.read` 或 `files.search` 的 Python 实现授予任意代码权限。

`解析https://github.com/trending中今天的项目详情` 与所有其他输入一样进入工具循环，模型可直接调用 `web.fetch`，不再因被归为闲聊而禁止调用。`web.fetch` 使用开源 Python HTTP 读取器：尝试全部公共 DNS 地址、有限指数退避、多个普通浏览器请求头，并支持常见 gzip/deflate 响应；遇到 403、验证码或 JavaScript 页面时会明确提示使用已授权的 `browser.open`，不会把拒绝页误报成成功。网页正文默认保存到每轮 `web-pages/` 后读取，生成工具源码、输入、清单、结果保存在 `python-tools/`。它们是当前用户进程，不是操作系统沙箱。详见 [配置、示例和边界说明](../docs/LOCAL_TOOLS_PYTHON_FALLBACK_1173.md)。

## 0.14.0：文件传递与 JSON 离线调试（保留）

默认 `response_delivery: "file"`，HTTP 客户端将响应原文和助手正文保存到本轮 `responses/`，只把本地文件引用交给 Agent；`agent.response_file_handoff` 记录交接的本地路径，Agent 随后校验路径、大小、权限与 SHA-256 后读入，再解析协议和执行授权动作。`--response-delivery inline` 可切回原方式。

异常 JSON 默认保存到本轮 `json-repair/`，包括修复成功与失败样本。运行 `./run.sh repair-json /绝对路径/events1.jsonl --events --output-dir /绝对路径/新的回放目录` 可离线复现；不启动父服务、不请求模型、不执行动作。原始文件含完整正文，请按敏感数据管理；`--log-metadata-only` 不持久保存新增加的响应/修复正文，临时交接文本读完即删，但正常任务结果与状态文件仍按原流程保存。详见 [完整说明](../docs/JSON_FILE_HANDOFF_AND_CHAT_1172.md)。

## 快速开始

需要 Linux、Python 3.10+。核心任务循环、HTTP 客户端、命令及文件工具只使用 Python 标准库。

```bash
# 首次先在父项目执行 ./run.sh 安装依赖并登录模型网页
cd desktop-agent
./run.sh                    # 自动检查/启动父应用，进入交互输入
./run.sh --v                # 进入交互，并显示工作目录、任务记录和结果路径
# 或一次执行一个任务：
./run.sh run "生成本机基础环境 Markdown 报告，保存 reports/system-info.md，读取核验后告诉我结果" \
  --model chatgpt --skill system-report --allow shell
```

默认从 `~/.local/share/multillm-fusion/api-key.txt` 读取父应用的本地令牌；也支持父应用的 `FUSION_DATA_DIR`、`FUSION_TOKEN`。自定义令牌可使用 `FUSION_AGENT_API_KEY` 环境变量或配置中的 `api_key_file`，不要把真实令牌写入示例配置。

默认模型是 `chatgpt`。`--model deepseek`、`--model qwen`、`--model glm`、`--model kimi`，或父接口公布的 `web-glm`、`web-kimi` 等名称可指定单模型。所选模型必须出现在 `doctor --api` 的模型列表中；该检查只调用 `/v1/models`，实际发送能力还取决于 Electron 网页桥和登录状态。复杂任务建议使用单模型，减少每一步网页生成和融合的等待。

```bash
./run.sh init                 # 可选：生成私有 agent.config.json，不覆盖已有文件
./run.sh tools                # 查看实际工具名称及参数 schema
./run.sh skills               # 查看全部内置及用户 Skill
./run.sh skills list          # 同上
./run.sh skills system-report # 查看 Skill 正文
./run.sh skills read system-report # 同上
./run.sh doctor               # 只检查本地依赖；加 --api 才访问本地 API
./run.sh status               # 只读父服务状态，不自动启动
./run.sh chat --model deepseek # 显式启动交互模式
./run.sh pack                 # 本地打包代码及脱敏日志，不上传
./run.sh skill-demo my-report # 生成完整可加载的示例技能，不调用模型
./run.sh skill-test my-report # 结构、引用和 Python 语法检查，不执行技能脚本
./run.sh history              # 查询历史任务，不启动父应用
./run.sh sessions             # 查询历史交互会话
./run.sh run --help
```

## 交互输入与调试

在真实终端直接运行 `./run.sh`，或执行 `./run.sh chat`。输入自然语言任务后回车执行；后续自然语言输入默认接着当前上下文执行，每轮仍创建独立任务记录和日志。执行中临时授予的能力不跨轮继承，启动参数 `--allow` 的显式授权默认持久保存；使用 `--no-save-config` 时仅本次会话生效。无参数且输入不是交互终端时显示用法并退出；脚本自动化使用 `run "任务"`，每次命令行调用独立运行。

输入时会在行尾以灰色显示本地候选。按 **Tab** 或在行末按 **右方向键**，将候选填入当前输入；仍须按 **Enter** 才执行。光标位于文字中间时，右方向键只移动光标；↑/↓ 可选择历史输入。候选来自交互命令、技能名称、已查询的模型列表和本地历史任务，输入过程不请求模型；`/models` 或 `/model` 查询后更新模型候选。新建 Skill 后无需重启即可获得技能名称建议。

Linux 普通交互终端支持行内建议；重定向输入/输出或 `TERM=dumb` 时使用普通输入，不输出光标控制码。`NO_COLOR` 隐藏并禁用候选接受，仍保留普通编辑和历史选择。粘贴多行文本时保留为可编辑输入，不把其中的换行自动当成执行命令。

| 命令 | 功能 |
| --- | --- |
| `/help` | 显示交互帮助 |
| `/models` | 从 API 查询已启用的模型 |
| `/model deepseek` | 校验后切换模型并保存，下一任务和重启后生效 |
| `/workspace ~/work` | 切换默认目录并保存，不限制文件访问到该目录；含空格请加引号 |
| `/config [show/get/set/save]` | 查看或保存全部 Agent 设置，例如 `/config set timeout 120` |
| `/allow shell`、`/deny shell` | 显式保存或撤销默认能力授权，下一任务生效 |
| `/response-mode file` | 切换响应交接模式并保存 |
| `/retry` | 在当前上下文中重试上一条提示，使用当前模型和目录，创建新记录，不重放已执行的修改动作 |
| `/new` | 清空当前内存上下文并建立新交互会话记录；保留历史文件 |
| `/context` | 查看当前原始目标、最近提示、状态及步骤摘要 |
| `/status` | 查看父服务、网页桥接、当前模型及任务状态 |
| `/doctor`、`/doctor --api` | 本地依赖检查，或连同 API 模型检查 |
| `/tools` | 格式化显示工具及参数 |
| `/skills`、`/skills list` | 查看全部内置及用户技能和来源 |
| `/skills 名称`、`/skills read 名称` | 查看技能正文 |
| `/skill-demo my-report` | 生成 demo Skill，不覆盖已有目录 |
| `/skill create [描述]` 或独立输入 `创建skill` | 进入步骤录制状态，后续输入先记录、不执行 |
| `/skill finish` 或独立输入 `结束创建skill` | 保存待确认草稿，再由当前模型建议名称与用途 |
| `/skill preview` | 查看当前录制内容或待确认草稿 |
| `/skill name my-report` | 在待确认阶段修改名称 |
| `/skill confirm [名称]` 或独立输入 `确认创建skill` | 确认名称并创建 Skill，不自动加载或运行 |
| `/skill cancel` 或独立输入 `取消创建skill` | 取消本次创建，保留草稿记录并恢复普通输入 |
| `/my-report [任务描述]` | 显式运行真实存在的同名技能；省略描述时按技能中的目标与步骤运行 |
| `/skill load my-report` | 为后续任务加载技能，每次任务读取最新正文 |
| `/skill unload my-report` | 从后续任务的预加载列表移除该技能 |
| `/skill reload` | 重新读取并检查当前已加载技能 |
| `/skill test my-report` | 静态检查技能结构、资源引用及 Python 脚本语法 |
| `/skill run my-report 统计当前工作区文件并保存新报告` | 本轮增加指定技能并执行自然语言任务 |
| `/verbose on`、`/verbose off` | 开关目录、任务编号和结果路径的自动显示；`/v` 为别名 |
| `/history`、`/history 关键词` | 列出最近任务，或按任务/结果内容搜索 |
| `/history show 任务编号` | 查看原任务、工具摘要和格式化结果 |
| `/sessions`、`/session 会话编号` | 列出历史交互会话，或查看该会话的任务 |
| `/logs` | 显示最近任务的日志与结果路径 |
| `/pack` | 打包代码和脱敏日志，包含本会话最近任务事件，默认移除正文 |
| `/pack --include-content` | 在分析包中保留脱敏后的日志正文 |
| `/quit` | 退出，也可在输入处按 Ctrl+D |

执行任务时按 Ctrl+C 停止该任务并回到输入；输入提示处按 Ctrl+C 退出。普通输入状态下，`/技能名称` 只有匹配当前目录中有效且不占用内置命令名称的 Skill 才会执行；其他未知 `/命令` 报错，不作为 shell 命令执行。调试命令和最终回答都经过格式解析与终端排版。录制期间的输入规则见下方“录制自己的 Skill”。

默认启动及任务结束时不显示工作目录、记录目录和结果文件路径。`./run.sh --v`、`-v`、`--verbose` 均可开启，也支持 `./run.sh run "任务" --verbose`；交互中用 `/verbose on` / `/verbose off` 切换。`/status`、`/logs` 是主动查询，始终显示对应信息。详细模式只增加这些说明，完整审计日志仍只写文件。

## 继续任务与补充要求

同一次 `chat` 进程中，后续输入会带上此前用户目标、模型回复、工具观察以及未解决的失败和待核验状态。例如，网页模型在已执行 5 个工具步骤后超时，输入“继续”会从已保存的进度继续规划；输入“报告中再加上交换分区占用”则作为原任务的补充要求。已经派发的修改动作不会因继续或 `/retry` 自动重放；结果不确定的操作仍须检查现场，不能把旧失败或未核验状态当成完成。失败或步数停止后若补充了新的环境操作（例如把“点击确定”改成“点击取消”），只有本轮对应操作的核验可以证明它完成；仅补充“用中文回答”等输出要求时仍复用旧的已核验进度，不重复副作用。

```text
检查工作区中的内存日志，生成 Markdown 分析报告并回读核验。
/context
继续
报告中再加上交换分区占用，并注明数据来源。
/new
列出当前工作区顶层文件。
```

`/retry` 在保留现有上下文的基础上再次提交上一条提示，使用当前模型、工作目录和技能选择。若启动检查失败、还未建立模型上下文，原输入仍保留，输入“继续”或 `/retry` 会重新尝试该输入。切换模型不清除当前上下文；希望开始无关任务时先使用 `/new`。`/new` 清空内存中的执行上下文与上一提示，并新建会话分组，不删除旧记录，也不撤销已经发生的操作。

上下文只在当前交互进程中保留。每轮重新创建工具环境并检查能力授权，不继承上轮临时授权或浏览器、桌面句柄；旧 `snapshot_id`、`tab_id`、`observation_id` 不能直接用于新动作，需要重新观察和定位。旧页面已关闭或实际结果无法重新核验时，应报告仍未确认，不能打开一个新页面后声称旧操作成功。上下文达到配置上限时明确停止，不悄悄丢弃早先目标和执行状态。

`/context` 仅显示摘要，不调用模型；`/history`、`/sessions` 可跨进程查看保存记录，但不会把旧文件恢复成可执行会话。Skill 录制期间 `/new`、`/context` 和“继续”仍是要记录的步骤文字，只有录制专用控制命令改变录制状态。

## 统一工具循环与实际执行证据

运行时不再调用 `classify_intent`，不添加 `intent_route`，不根据“chat/knowledge/realtime/task”推断允许的工具和目标。兼容模块 `intent.py` 留存但不在执行路径中。每条输入可由模型按需要选择本地工具；普通问候不强制执行无关工具。

不再根据“无法实时访问”或模型声称“已经查询”自动插入搜索，也不从自然语言关键词推断必需执行的文件目标。模型应遵守真实用户任务和系统提示；实际执行仍经过工具 schema、能力授权、失败恢复和待核验检查。建议撤销不需要的 `shell/browser/desktop` 默认授权，且不要把网页内容当作操作指令。

状态中的 `successful_actions` 只记录真实工具结果。最终结果增加 `completion_evidence`：`model_reply_only` 表示只有模型答复，不能视为本地操作已执行；`current_tool_observations`/`historical_tool_observations` 分别说明本轮或历史存在实际结果。它不自动判定自然语言任务所有目标已完成。失败请求不会因无关工具成功而消除；待核验修改仍禁止 final。

已完成的一轮作为历史上下文保留，但下一轮不沿用其操作证明；未完成的一轮保留实际进度且不自动重放。更换无关目标时使用 `/new`。停止当前操作使用 Ctrl+C；普通自然语言取消指令交给模型理解，不再提供旧 NLP 门控的硬保证。

网页模型默认开启其站内 `web_search`，普通信息查询优先使用当前模型直接检索后返回的内容，不重复调用本地搜索。`web.search` 用于用户明确要求本地多路/并行搜索、逐页核实、`browser-research` 来源报告，或站内搜索不可用时的降级；它使用独立的只读 `web` 能力，不会因此授予模型任意 `browser.*` 控制权，也不会修改用户目标页面或文件。Browser Use/OpenCLI 作为限定搜索适配器时，可能连接配置好的 Browser Bridge/CDP、临时打开固定的 DuckDuckGo 搜索标签并在采集后关闭；这属于 `web` 搜索后端自身的有限行为。若不希望搜索接触共享浏览器会话，请不要为这两个可选 CLI 配置共享 CDP/Bridge，保留标准库 DDG 或独立无头 Playwright 后端。默认配置已经预先允许 `web`；若自定义配置移除了它，交互模式可在首次需要时确认，非交互任务则需显式增加 `--allow web`。参数如下：

```json
{"query":"2026 年 9 月 AI 新闻","mode":"sequential","max_results":8,"timeout_seconds":15}
```

- `query` 必填，1–2048 字符；`max_results` 为 1–20，默认 8；`timeout_seconds` 为每路 1–120 秒，默认 15。
- `sequential` 默认按 DDG/DDGo → Browser Use → OpenCLI → Playwright 尝试，首个返回有效结果的后端即停止。
- `parallel` 只在用户明确要求多路/并行搜索时使用，同时调用可用后端，随后按上述优先级稳定合并并按 URL 去重。共享本地浏览器的外部 CLI 可能争用资源，优先追求稳定性时使用默认顺序模式。
- 并行聚合超时后，Python 线程不能强制取消已经进入第三方库的调用；内置 CLI 使用独立进程组和硬超时清理进程树，Playwright 的启动、导航和结果等待共享同一截止时间。第三方库仍可能在超时后短暂完成自身清理，因此连续高频搜索应优先使用顺序模式。
- `ddgo` 是本项目对标准库 DuckDuckGo HTML POST/解析器的诊断名称，不要求安装名为 `ddgo` 的程序。后续外部依赖缺失会记为 `unavailable` 并继续降级；四路都没有有效结果才返回 `search_failed`。

Browser Use 适配当前 CLI 3：以 `browser-use` 裸命令接收固定的 stdin Python 模板，查询只通过受限环境变量传入，不运行第二个 LLM，也不把 API Key 注入子进程。它要求 Python 3.11+，Agent 使用 Python 3.10 时应作为独立 CLI 环境安装；用 `command -v browser-use`、`browser-use --doctor` 检查。OpenCLI 实际调用 `opencli duckduckgo search <query> --limit <N> -f json`，需要 Node.js 20.18.1+、Chrome/Chromium Browser Bridge；单页数量限制为上游支持的 10。两种 CLI 都只继承 PATH、HOME、显示和各自 browser/bridge 配置等白名单环境，不继承 Fusion token、模型 API Key、`NODE_OPTIONS` 或 `PYTHONPATH`。生产路径不使用 shell，并以流式读取限制 stdout；stderr 只排空而不进入模型，超时或输出超限会终止独立进程组及其后代。用 `command -v opencli`、`opencli doctor` 检查。Playwright 使用 Agent 当前解释器中的独立无头 Chromium；可用 `./setup.sh --browser` 或 `environment.browser_check` / `environment.browser_setup` 检查和安装。外部组件不会由一次搜索任务任意安装。

搜索页标题、摘要和 URL 都按不可信观察处理：只保留有标题的公开 HTTP(S) 结果，拒绝凭据 URL、本地/特殊数值地址以及整数、十六进制、八进制和畸形 dotted IPv4 写法，移除片段、跟踪、云存储签名和递归编码的敏感查询参数，并限制返回大小。该检查不执行 DNS 解析，结果也不会被搜索工具自动打开；重要结论仍应从来源核对。后端接口、依赖诊断、日志和附件根因见 [1.14.0 Agent 意图、搜索与协议诊断](../docs/AGENT_INTENT_SEARCH_AND_FALLBACK.md)。

## 网页响应过程

连接配套父应用时，终端按当前请求的实际事件显示“请求已排队”“正在准备网页”“已投递发送动作，等待网页接收”“网页已接收请求”“生成服务器已返回（HTTP 状态）”“正在等待或接收网页响应”“正在生成回答”“正在等待完整回答并采集”“响应已返回，正在解析”等阶段。父应用为每个模型分别报告进度；没有观察到的事件不会被定时器补造。

发送动作已投递不代表网页已经接收；服务器返回 HTTP 状态也不代表完整答案已经生成，Agent 仍等待本轮答案采集及严格解析完成。只有支持 Fusion 进度能力的父服务才提供这些网页细节；远端兼容 API、旧版父服务或进度查询不可用时，保留普通“等待模型响应”提示，任务请求继续正常处理。进度查询失败不会重发生成请求。

父应用检测到本轮网页的明确错误，且能定位到属于当前回合的可信“重试/重新生成”按钮时，最多自动点击一次，并显示重试阶段 `retrying`。自动重试无效、按钮不可确认或发送接收状态不明时，显示 `manual_retry_required`，提示你到对应模型网页处理。父界面的“处理网页重试”入口可显示需要处理的后台模型页。请保持当前会话，点击本轮“重试/重新生成”；若完整提示仍停在输入框，检查后手动发送。不要新建会话或再次粘贴整段提示。

人工处理期间，父应用保留原提示和本轮开始前的采集基准，继续观察当前回合；检测到本轮恢复后显示 `recovering`，等待完整回答，再把结果交给 Agent 解析并继续后续步骤。程序不会为了恢复而刷新网页、切换会话或重新填入整条提示。只有当前请求的恢复等待仍在进行时，才会接收这次人工重试的结果；如果终端已经报告恢复超时，本轮请求已经结束，不会继续在后台采集。

父项目配置 `generation.recovery_timeout_seconds` 控制额外恢复等待，默认 `180` 秒，范围 `0`–`600`；设为 `0` 关闭这条恢复流程。超过窗口仍未取得完整回答时明确失败，已完成的工具步骤与当前 Agent 上下文继续保留，可以查看网页和 `/context` 后输入“继续”或补充要求。该机制不自动重试 Agent 的 HTTP POST，也不重放本地工具操作；恢复窗口从首次进入异常恢复开始计时，且不超过原生成截止时间加该预算；人工再次重试不会重新计时。真实网页的错误样式和按钮仍取决于站点实际界面，需在已登录的桌面环境核对。

## 查询历史任务与交互会话

`/history` 默认显示最近 20 个任务；查看详情会解析已有任务记录并格式化显示用户输入、状态、工具执行摘要和保存的 Markdown 结果。历史查询只读本地记录，不调用模型、不执行旧命令，也不会把查询到的记录加入下一轮上下文。它与当前交互进程自动保留的上下文分别处理；退出进程后，不能通过查询历史恢复执行。

命令行查询方式：

```bash
./run.sh history
./run.sh history "环境报告" --limit 50
./run.sh history --show 任务编号
./run.sh sessions
./run.sh sessions 会话编号 --limit 50
```

请将“任务编号”和“会话编号”替换为列表中的完整编号；`--limit` 为 1–100。任务查询兼容旧版已保存的运行记录；交互会话分组从 0.7.0 开始保存，更早的记录可通过 `history` 查询。会话索引位于 `.runtime/sessions/`，不代表恢复了网页模型的上下文。历史文件损坏、过大或不可读取时会跳过或提示，当前任务仍可运行。

## 父应用自动启动

进入交互或执行任务时，默认检查本项目 `http://127.0.0.1:8765/v1`（端口遵循 `FUSION_PORT`）。健康检查成功后还须通过认证确认网页桥接已连接。服务已就绪时复用；未启动时在后台执行父项目 `./run.sh --skip-install`，只启动一次并等待就绪。仅有 API 而未连接 Electron 时也会尝试启动父窗口。

启动输出写入父项目 `logs/agent-parent-start.log`，终端只显示简短进度。等待超时或缺依赖会给出日志路径；进入交互时启动失败仍可使用调试命令。首次缺依赖请先运行父项目 `./run.sh` 安装。启动继续使用普通用户和现有沙箱策略，不需要 root；用户登录不会自动完成。

自定义端口须让 `FUSION_PORT` 与 Agent `base_url` 一致。其他自定义或远端接口由原 API 客户端访问，不由 Agent 启动。认证失败、未知服务占用端口或状态不明时不会再启动另一个实例。`run` / `chat --no-auto-start` 可关闭自动启动；`doctor`、`status`、`tools`、`skills`、`pack`、`skill-demo`、`skill-test`、`history` 和 `sessions` 单独运行时不会启动父应用。

父应用启动后保持运行，退出 Agent 不关闭父窗口。自动启动进程的记录用于避免重复启动，不会终止不属于本次启动的进程。

配置示例见 `config.example.json`。相对路径以配置文件所在目录为基准；未指定配置时以 `desktop-agent/` 为基准。`--workspace` 则按当前终端目录解析。常用字段：

| 字段 | 默认值 | 用途 |
| --- | --- | --- |
| `base_url` | `http://127.0.0.1:8765/v1` | 父应用接口地址 |
| `model` | `chatgpt` | 单模型名称 |
| `workspace` | `workspace` | 相对路径基准及命令默认目录，不是默认文件边界 |
| `filesystem_scope` | `host` | host 或显式 workspace 范围 |
| `auto_save_config` | `true` | 自动保存命令行/交互设置 |
| `runtime_dir` | `.runtime` | 审计日志、任务记录、浏览器配置和截图 |
| `skills_dir` | `skills` | 本项目 Skill 目录 |
| `timeout` | `900` | 单次 API 请求超时秒数 |
| `max_steps` | `20` | 一次任务最多的工具动作数 |
| `max_context_chars` | `160000` | 上下文字符上限，达到后明确停止 |
| `log_content` | `true` | 在日志文件中记录脱敏后的任务、请求、回复、工具参数和结果，不向终端输出正文日志 |
| `allowed_capabilities` | `["files", "skills", "web"]` | 预先允许的能力 |

`run --allow web,shell,browser,desktop` 显式授予并保存对应能力；仅本次使用可加 `--no-save-config`；交互终端也可以在首次需要该能力时确认一次。`web` 只允许受限的公开网页搜索，与可打开和操作网页的 `browser` 分离。`--non-interactive` 不等待输入，未授予的能力返回错误。Skill 不会自动授予能力。`shell.run` 能运行当前用户拥有权限的命令，**工作目录不是操作系统沙箱**，因此应给出清楚的任务范围。

## 命令行、文件和已有 CLI

```bash
./run.sh run "检查工作目录中的 Python 源码语法，把检查结果写入 syntax-report.md，不修改源码" \
  --workspace /path/to/project --model deepseek --allow shell

./run.sh run "使用 git status 和 git diff 检查本目录改动，写出 review.md，不提交或推送" \
  --workspace /path/to/repository --allow shell

./run.sh run --task-file tasks/my-task.txt --model qwen --allow shell --non-interactive
```

`shell.run` 接收 `argv` 数组或 `command` 字符串，两者只能选一个。`argv` 直接执行程序，`command` 使用不加载启动配置的 Bash。可调用已经安装的 git、Python、npm、其他 CLI；Agent 不会自动安装这些工具。子进程环境使用白名单，不继承 Fusion API token 等凭据变量；需要认证的 CLI 应使用你已配置好的本机认证方式。

命令默认超时 60 秒，可按工具参数设置为 1–300 秒；输出有长度限制。超时、Ctrl+C 和正常退出都会清理所属进程组的子进程，不适合启动长期后台服务；主动脱离进程组的程序不在该清理保证内。文件工具支持列目录、状态、分段读取、内容搜索、原子写入、建目录、复制、移动和删除。`files.search` 固定参数优先调用 `rg`，仅在不可用或后端异常时降级到 `grep`，返回实际后端、尝试记录、匹配行和截断状态。默认 host 允许当前系统用户可访问的工作目录外路径；显式 workspace 模式才限制目录范围；写入、复制和移动默认不覆盖，递归删除必须显式设置 `recursive=true`。

`shell.run` 保留实际退出码和标准输出/错误，非零退出或超时返回 `ok:false`；退出码 0 只证明命令正常退出，还应检查任务要求的产物。`files.write` 写入后重新读取并比较实际字节，回读不一致会失败。报告内容是否正确仍需要按任务检查。

模型写出 `file.read/list/write/stat/search/mkdir/copy/move/delete` 时，会精确匹配到对应的 `files.*` 工具。原参数保持不变，并重新进行对应工具的参数、配置文件范围和能力检查；终端及文件日志会记录名称匹配结果。

0.11.0 为 read/list/write/stat/search/mkdir/copy/move/delete 的少量明确拼写提供受控 Python 兜底，例如 `read_file`、`list_directory`、`write_file`、`stat_file`、`search_files`、`make_directory`、`copy_file`、`move_file`、`rename_file` 和 `delete_file`。只有正常工具查找失败后才会匹配固定表；若规范 `files.*` 工具已注册，则仍调用现有工具，否则动态装载相同的本地 `LocalTools` 实现。日志事件分别为 `tool.alias_resolved` 或 `tool.python_fallback_resolved`，绝不执行模型提供的 Python 代码。

该兜底不是任意 Python 执行器：`python`、`python.run`、`eval`、`execute` 等名称永远不会据此运行，也不会把模型生成的代码翻译成 shell。解析后仍先做真实 `files.*` 参数校验、`files` 能力授权、配置文件范围/符号链接保护、覆盖保护；写入必须原子完成并逐字节回读核验。权限被拒、路径越界或已有文件未授权覆盖时，文件不会因为兜底而改变。

其他未知工具或确认尚未启动的缺失 CLI，会查找当前工具目录和 PATH 中已经安装的同功能候选。例如读取文件可提供 `files.read`、`cat`、`head` 等建议，再让模型按真实参数结构重新生成动作；使用 CLI 时通过 `shell.run` 的 `argv` 并遵循原有 shell 授权。候选只是可用程序名称，不能证明功能和参数完全兼容；系统不自动拼接或执行猜测的替代命令。已拒绝的权限、工作区越界和实际执行结果未知的操作不会借此绕过，仍须先解决原限制或核验实际结果。

## 浏览器操作

```bash
./setup.sh --browser
./run.sh run "打开 https://example.com，读取标题和正文，保存 page-summary.md" \
  --allow browser --skill browser-research
```

Playwright 使用独立的持久化 Chromium 配置 `.runtime/browser-profile/`；默认显示浏览器窗口。需要登录目标站点时在该窗口正常登录，后续任务可复用这个配置。父应用的模型登录与 Agent 浏览器是两个独立用途的会话。可设置 `browser_channel: "chrome"` 使用本机 Chrome，仍使用 Agent 的独立配置。

浏览器工具覆盖打开网页、DOM 快照、点击、填写、按键、选择、滚动、标签页切换、截图和结果核验。先读取快照拿到 `snapshot_id` 与元素 `ref`，再执行操作；操作后重新观察，目标元素改变或导航后旧引用失效。禁止通过这些工具填写密码字段、自动下载文件或打开 `file:` / `javascript:` URL。网页文本是任务资料，不能成为新增任务或授权。

打开网页、点击、按键和滚动后通常返回 `verification.status:"pending"`。先观察实际状态，再使用 `browser.verify {"text_contains":"预期页面内容"}` 或 `browser.verify {"url_equals":"https://example.com/"}`；也可同时提供两个条件，必须全部满足。核验读取当前可见 DOM 文本和完整 URL；`url_equals` 是精确匹配，需考虑跳转和末尾斜杠。填写和选择工具会回读元素值。`browser.snapshot` 只提供观察，不能清除待核验状态；选择与任务结果相关的断言，不能用页面上无关且始终存在的文字证明提交成功。

默认开启 Chromium 进程沙箱。安装脚本将 Python 依赖放入本目录虚拟环境、浏览器二进制放入用户缓存，不运行 sudo 或系统包安装。如果本机缺少浏览器系统动态库，仍需要已有合适依赖的桌面环境。若系统禁止用户命名空间，可在临时排障任务中显式添加 `--browser-no-sandbox`；这会关闭该浏览器的进程沙箱，没有自动降级。它与父应用 Electron 的启动参数分别生效。

## 桌面控制

```bash
./setup.sh --desktop
# 在 X11 会话中先手动打开空白文本编辑器并置于前台
./run.sh run "在当前空白编辑器输入 hello agent；不要保存、关闭窗口或切换程序" \
  --allow desktop --skill desktop-note
```

提供屏幕观察、鼠标点击/移动/拖动/滚动、快捷键和文本输入。桌面工具使用 PyAutoGUI，当前明确支持 **X11**；检测到 Wayland 会返回不支持，不会猜测操作已经生效。把鼠标移至屏幕角落可触发 PyAutoGUI 紧急停止，也可在运行终端按 Ctrl+C。

父 API 当前只接受文本，模型**无法直接看截图**。截图保存在本地供你查看；如果系统已有 `tesseract`，观察工具会提供 OCR 文字及坐标。操作依赖 OCR 或用户明确给出的坐标；无法定位控件时应停止说明。每次动作需要最近观察的 `observation_id`，默认 180 秒有效，动作后失效。中文输入还需要 Pyperclip 及可用的系统剪贴板后端（例如 xclip/xsel）；`doctor` 会列出是否检测到这些依赖。

桌面动作投递后返回待核验状态。`desktop.verify {"text_contains":"hello agent"}` 会重新截图并用 OCR 检查文字；OCR 不可用或文字不匹配时返回失败。`desktop.verify {"x":100,"y":200}` 读取实际鼠标位置，只能确认 `desktop.move`，不能证明点击、输入、拖动或快捷键达成目的。`desktop.observe` 本身不会解除待核验状态。桌面动作若没有可检查的文字结果，当前实现可能无法确认，应报告限制并停止，不能仅凭截图文件已生成就声明完成。

同时安装两组可选依赖使用 `./setup.sh --all`。脚本不安装 Tesseract、剪贴板后端或其他系统库。

## 执行协议与结果

父接口没有原生 `tool_calls` 或图片消息支持。Agent 仅发送 `model`、文本 `messages` 和 `stream: false`，要求模型每轮输出一个 JSON 动作：

```json
{"type":"action","tool":"shell.run","arguments":{"argv":["python3","--version"]},"summary":"检查 Python 运行时","plan":["检查环境","生成报告","读取核验"]}
```

本地校验工具名、参数和能力后执行，将结果作为不可信观察文本返回模型。任务完成时模型输出：

```json
{"type":"final","answer":"已完成任务。这里是 Markdown 结果。"}
```

解析器只接受一个 JSON 对象，或仅由一个 JSON 代码块构成的回复；多对象、重复键和不合规范的参数都会被拒绝。Python 修复器只做确定性变换：字符串内部裸 LF/CRLF 编码成 JSON `\n`；文件路径的既有窄 `\_` 修复继续保留；`final.answer` 或 `files.write.arguments.content` 中的 `\*` 只有在私有标记探针严格解码并证明所有位置均属非执行正文时才移除反斜杠。工具名、shell 参数、URL、路径中的其他损坏不猜测。0.16.0 另外允许限定文本字段（含 summary/plan、Python 源码字符串）的内嵌引号修复；边界不明确仍拒绝。截断回复保存为不完整诊断，不能补造后文，不向服务器请求第二次格式改写。

对于已经通过严格 JSON 解析的 `files.write`，只有目标扩展名为 `.md` / `.markdown` 且损坏形态可唯一证明时，才恢复双重编码的段落换行和附件中精确匹配的 `/n/nN` 链接编号污染；代码块、行内代码、普通 URL、非 Markdown 文件和不匹配的路径不变。原始回复始终保存在日志与 transcript，规范化内容、位置和范围记录在 `model.protocol_normalized`。之后仍须依次通过工具 schema、能力授权、配置文件范围与写后回读。`browser.open` 继续兼容显示地址与目标相同的完整网址链接。详见 [1.14.0 Agent 意图、搜索与协议诊断](../docs/AGENT_INTENT_SEARCH_AND_FALLBACK.md) 和 [终端与 JSON 修复说明](../docs/AGENT_TERMINAL_AND_JSON.md)。

执行状态未知时记录 `uncertain_actions`。浏览器或桌面有待核验动作时，必须先调用相应的 `verify`，才可继续同类动作或提交最终回答；读取快照、截屏、列文件不能冒充核验。模型持续跳过核验会以 `verification_pending` 停止。工具失败和核验失败会保留在任务记录中，不能把失败回执改写为成功。核验只证明指定条件成立，仍不能保证模型选择了正确操作或完全实现用户目标。

HTTP 502 等错误保留父服务的错误正文、错误码、`request_id` 和来源错误；例如日志会指出网页发送失败或生成超时，而非只有“HTTP 502”。符合本轮恢复条件且已启用恢复的网页异常，会先按上方“网页响应过程”等待处理；恢复仍失败才返回错误。Agent 不会自动重试 HTTP POST 或重放已执行动作；同一次交互中，检查现场后可输入“继续”或补充要求，继承失败前的目标、观察和未完成状态。达到步数、上下文或父 API 请求限制时明确停止并保留记录。

默认产物和记录：

| 位置 | 内容 |
| --- | --- |
| `workspace/` | 任务生成的文件 |
| `.runtime/runs/<run_id>/transcript.json` | 完整任务、模型动作和工具观察 |
| `.runtime/runs/<run_id>/state.json` | 步骤、当前动作、终态、具体错误、待核验动作与失败记录 |
| `.runtime/runs/<run_id>/events.jsonl` | 与全局日志相同的每轮详细日志，逐条立即 flush，不轮转 |
| `.runtime/runs/<run_id>/result.md` | 成功、失败或停止都生成，包含状态、步数和结果/错误 |
| `.runtime/runs/<run_id>/final.md` | 完成时的最终 Markdown 回答 |
| `.runtime/logs/agent.log` | 操作、正文和结果的详细文件日志；5 MiB 轮转，保留 3 份 |
| `.runtime/sessions/<session_id>.json` | 交互会话及其任务编号索引，用于历史分组查询 |

仅在 `--v` / `/verbose on` 开启时自动显示工作目录、任务记录目录及结果和可用日志路径；默认可用 `/logs` 按需查看。任务记录文件权限为 0600；若某日志文件不可写会明确提示，其余文件继续尝试保存。日志默认包含任务、每次模型请求及原始回复、动作计划/参数、命令输出和核验结果；已知密钥、密码、Cookie/Authorization 等凭据脱敏。正文以 `payload_id` 和 `part` / `parts` 分段，单份载荷最多 2,000,000 字符，超限标记 `truncated:true`。任务及工具输出自身也有长度限制，需检查对应截断字段。工具返回的文本、网页正文和 OCR 将送入所选网页模型作为下一步上下文；截图本身不上传。

终端无需额外选项即可保持简洁，最终 Markdown 按标题、列表、表格和代码块格式显示，完整 JSON 结果会缩进显示。重定向输出时不包含 ANSI 颜色码；`NO_COLOR` 或 `TERM=dumb` 可关闭终端样式。若日志文件也只需元数据，可使用 `--log-metadata-only`、环境变量 `FUSION_LOG_CONTENT=0` 或配置 `log_content:false`；这些选项不关闭本地 `transcript.json` 任务记录。

任务退出码：完成 `0`、失败 `2`、达到限制停止 `3`、中断 `130`。中断前已经产生的操作不会自动撤销；同一交互进程可带着上下文继续，跨进程记录仅供查询，不支持从历史文件恢复并重放旧任务。

父目录 `./package.sh` 包含本目录源码、Skill 示例和 Agent 日志，默认移除日志正文。排查 `invalid_protocol` 或工具结果时使用 `--include-content` 保留脱敏后的正文；可加 `--agent-run-id <run_id>` 额外收集指定任务的 `events.jsonl`；仍排除完整会话记录、工作区、截图、浏览器配置及私有配置。自定义运行目录时：

```bash
# 在父项目目录执行
./package.sh --include-content --agent-runtime-dir /path/to/agent-runtime
```

## 依赖缺失和提前停止的恢复

若提示 `workspace_required`，日志会保留实际请求目录；不要把当前空工作目录当成原任务结果。例如查看家目录时，在交互中执行 `/workspace /home/example`，再执行 `/retry`。单次调用可使用 `./run.sh run "列出家目录文件" --workspace "$HOME"`。工作目录不会根据模型返回的路径自行扩大。

`incomplete_response` 表示模型返回了未闭合的 JSON 片段，缺失内容无法在本地猜测。父应用会在明显的 JSON 结构尚未闭合时继续等待；若最终仍截断，Agent 记录原始 payload 后直接失败，不再次请求模型补写。排查时使用 `/pack --include-content`，同时收集父应用采集状态与 Agent 原始回复。

目录项的 `size` 是文件系统元数据尺寸，不是子目录递归总容量；要报告完整占用须实际统计。仅依据文件名猜测用途时，结果应标明推测，不能声称已检查文件内容。

0.4.0 修复执行前失败误留 `pending_verifications` 的问题，真正已发出的未知操作仍须核验。浏览器任务先用 `environment.browser_check` 检查当前 Python；缺依赖时可在 shell 能力授权下通过 `environment.browser_setup` 安装并核验，随后继续原任务。不要为修复当前进程而把 Playwright 安装到另一个环境。

`./run.sh run "任务" --allow shell,browser` 会在需要时先建立项目虚拟环境；显式 `FUSION_AGENT_PYTHON`、有效的当前 `VIRTUAL_ENV` 优先。JSON 纠正按连续失败计算，核验纠正按每个待核验动作计数。附件原因、完整运行方式与限制见 [恢复说明](../docs/QWEN_SESSION_AND_AGENT_RECOVERY.md)。

## Skill 编写规则与生成命令

### 录制自己的 Skill

在交互界面单独输入 `创建skill`，或 `/skill create 统计工作区文件并生成报告`，提示符会变为 `skill[录制 0 步]>`。之后每次提交的文字按顺序成为一个步骤；多行输入保留在同一步里。此时 `/model qwen`、`/retry`、`/new`、`/context`、shell 命令和普通任务文字均只录入，不切换模型、不清空上下文、不执行任务。需要选择用于建议名称的模型时，请在开始录制前使用 `/model`。

只有完整、独立的控制命令会改变录制状态。普通句子中提到“结束创建skill”、引用它或在多行文本中包含它，都仍是步骤内容。该过程依据当前状态和明确命令判断，不用模型分类器猜测是否结束或执行。

下面是一段完整的多轮输入；每行分别提交：

```text
创建skill
列出当前工作区顶层文件，保留名称、类型、字节数和是否截断。
统计已观察到的条目，把结果保存到新的 workspace-count.md，不覆盖已有文件。
回读报告，核对统计范围、数量与截断说明，再向用户报告实际结果。
结束创建skill
```

结束录制会先把有序步骤保存成待确认草稿，再向当前模型请求 `name`、`description` 和可选标题建议。模型只能建议这些元数据，不能改写、增加或执行已录步骤。界面随后显示草稿和建议命令；例如可能建议 `workspace-count`，实际名称以本轮界面为准。确认前可查看、换名：

```text
/skill preview
/skill name workspace-count
/skill confirm workspace-count
/skill test workspace-count
/workspace-count
```

`/skill confirm` 不带名称或独立输入 `确认创建skill`，表示确认当前显示的名称；必须先结束录制并进入待确认阶段。名称使用小写字母、数字和分隔短横线，最多 64 个字符，不能占用 `help`、`model`、`retry`、`new`、`context`、`skill`、`quit` 等内置命令。已有同名目录、文件或符号链接会拒绝覆盖，可换名后重新确认。

名称建议失败、模型不可用或取消了命名请求时，已录步骤仍在。无需重录即可 `/skill name workspace-count` 后 `/skill confirm workspace-count`，使用已保存的本地描述完成创建。确认只将 Skill 原子创建到配置的技能目录，不自动加载或运行；只有之后的 `/workspace-count`、`/workspace-count 新任务描述`、`/skill run workspace-count 任务描述` 或常规任务才会执行工具。技能调用也继承当前交互上下文，独立目标可先执行 `/new`。`/retry` 会保留上一次显式调用的一次性技能选择，在当前上下文中重试上一提示，并新建任务记录。

录制与待确认期间，`/skill cancel` 或独立输入 `取消创建skill` 会保留取消草稿并恢复普通输入；`/quit`、Ctrl+D 或在输入处按 Ctrl+C 退出也会保留未发布草稿。草稿位于 `.runtime/skill-drafts/`，开启 `--v` 可查看本轮准确路径。当前没有跨进程恢复录制的命令，重新启动不会自动接着录制；若需修改已结束草稿中的步骤，可取消后重新创建。

已确认的 Skill 立即可发现、补全与显式调用。`/skill test` 仍只检查结构与支持的脚本语法，不执行步骤，也不代表实际任务已经完成。更完整的状态、限制与编写说明见 [SKILL_AUTHORING.md](docs/SKILL_AUTHORING.md)。

### 生成 Demo 与动态加载

内置三个示例：`system-report`（脚本辅助生成环境报告）、`browser-research`（浏览器阅读与引用报告模板）、`desktop-note`（前台编辑器输入与核验）。也可以生成一个可直接加载的工作区文件报告示例：

```bash
./run.sh skill-demo my-check
./run.sh skills my-check
./run.sh skill-test my-check
./run.sh run "统计工作区顶层文件，保存新的 count.md 并回读核验" --skill my-check
```

`skill-demo` 不连接模型或父 API，不执行生成的脚本；省略名称时使用 `workspace-report-demo`。交互模式中使用 `/skill-demo my-check`。命令在配置的 `skills_dir` 下原子创建 `my-check/SKILL.md` 和 `my-check/scripts/workspace_report.py`，同名目录、文件或符号链接已经存在时拒绝覆盖。

生成结果附带实际加载、测试和运行命令。新技能立即加入可发现目录与输入候选，使用下面的交互命令即可启用，无需重启：

```text
/skill-demo my-check
/skill test my-check
/skill load my-check
统计工作区顶层文件，保存新的 count.md 并回读核验
/skill reload
/skill unload my-check
/skill run my-check 统计工作区顶层文件，保存新的 second-count.md 并回读核验
```

`load` / `unload` 更新并保存后续任务的预加载名称（关闭自动保存时仅当前会话生效）；`run` 在本轮已有选择之外添加指定技能。每次任务都会重新读取所选技能当前正文，编辑后自动生效；`reload` 可立即检查当前选择，无效 frontmatter、编码或空正文会明确失败，不回用旧内容。只生成或读取技能不会自动执行任务。

`skill-test` / `/skill test` 只做静态检查：目录和 frontmatter、非空正文、引用的本地资源、路径/符号链接边界及 `scripts/` 下 Python 文件的语法。其他脚本语言只检查结构并标注语法未检查，不运行用户脚本、不联网、不调用模型。结果“结构检查通过”不等于技能能完成真实任务；命令行通过返回 `0`，失败返回 `2`。检查上限为 256 个资源目录条目、8 层目录、单文件 1 MiB、总计 4 MiB；超限明确报告。

实际任务验证可使用临时工作区，不影响已有报告：

```bash
test_workspace="$(mktemp -d)"
printf 'demo\n' > "$test_workspace/example.txt"
./run.sh run "统计顶层文件，保存 count.md，回读并核对条目和截断状态" \
  --workspace "$test_workspace" --skill my-check
cat "$test_workspace/count.md"
```

检查是否只统计了实际观察到的顶层条目、报告是否成功写入并回读、同名报告是否拒绝覆盖，以及条目过多时是否明确标注截断。任务验证会正常调用父应用与模型；涉及脚本的技能仍需对应工具能力。

示例默认通过 `files.list`、`files.write`、`files.read` 完成，包含统计范围、截断说明和报告回读。可选标准库脚本只采集顶层条目元数据并输出 JSON，不读取正文、不递归、不写文件；只有显式调用脚本时才需要 `shell` 能力。

本项目的 Skill 规则如下：

| 项目 | 规则 |
| --- | --- |
| 目录 | 每个技能放在 `skills_dir/<name>/SKILL.md`，文件使用 UTF-8 |
| 名称 | 必须与目录名一致；小写字母、数字及分隔短横线，最多 64 个字符，例如 `android-memory-report` |
| frontmatter | 文件以 `---` 开始；只允许 `name`、`description` 两个键，各出现一次，以 `---` 结束 |
| 描述 | 非空单行，最多 512 个字符；推荐 JSON 双引号字符串，说明何时使用；不支持 YAML 多行、嵌套对象或额外字段 |
| 正文 | 写明目的、触发条件、输入、可用工具、成功条件、失败处理和最终产物；只写这个任务需要的方法 |
| 附件 | 脚本放 `scripts/`，长说明或模板可放 `references/` / `resources/`；正文写清何时读取，路径相对于 `skills.read` 返回的 `base_path` |
| 限制 | `SKILL.md` 不超过 64 KiB，frontmatter 不超过 8 KiB；根目录最多检查 512 个条目；根路径、技能目录和入口文件不允许符号链接 |
| 权限 | Skill 只能描述方法，不能新增工具或授予能力；`permissions`、`allowed-tools`、`agents/openai.yaml` 不属于本项目加载协议 |

模型先看到名称和描述，按需调用 `skills.read` 读取全文；`--skill <name>` 或交互中已 `load` 的名称则在每次任务开始时加载最新全文。添加脚本不会自动执行；技能自身资源检查仍限定在技能包内；一般 `files.*` 访问遵循配置的 host/workspace 范围。修改后先用 `./run.sh skill-test <name>` 检查结构，再在临时工作区验证成功、失败、已存在文件和截断情形。

最小 Skill 放在 `skills/my-check/SKILL.md`：

```markdown
---
name: my-check
description: "当用户要求检查工作目录文件数量并保存 Markdown 摘要时使用。"
---

1. 使用 files.list 列出工作目录，检查结果是否截断。
2. 统计已确认的条目；有截断时不要声称得到完整总数。
3. 使用 files.write 写入用户指定的新 Markdown 文件，不覆盖旧文件。
4. 使用 files.read 核验产物，再报告结果和局限。
```

完整目录约定、脚本使用方式和自定义 Python 工具示例见 [SKILL_AUTHORING.md](docs/SKILL_AUTHORING.md)。

## 开发验证

```bash
PYTHONPATH=src python3 -m unittest discover -s tests -v
PYTHONPATH=src:tests python3 -m unittest -v test_upgrade1174 test_intent_runtime test_runtime_intent_hard_gates test_web_search test_python_fallback
bash -n run.sh setup.sh
```

验证范围见 [TESTING.md](docs/TESTING.md)。浏览器/桌面测试使用模拟对象，真实登录模型与原生图形操作仍需在目标 Linux 上验证。依赖依据：[Playwright 浏览器安装](https://playwright.dev/python/docs/browsers)、[PyAutoGUI 文档](https://pyautogui.readthedocs.io/)、[截图依赖](https://pyautogui.readthedocs.io/en/latest/screenshot.html)。
