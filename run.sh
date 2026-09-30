#!/usr/bin/env bash
# ============================================================
# LLM API Manager 一键启动脚本（已整合 m1 + 插件功能）
#   用法:
#     ./run.sh              # 默认: 安装依赖 + 编译前端 + 在 8765 端口启动
#     ./run.sh 9000         # 指定端口启动（同上流程）
#     ./run.sh -p 9000      # 指定端口（等价）
#     ./run.sh --port 9000  # 指定端口（等价）
#     ./run.sh build        # 仅构建前端 (vite build -> dist/)
#     ./run.sh dev          # 前端开发模式 (vite dev server)
#     ./run.sh server       # 仅启动后端（dist 缺失时才构建）
#     ./run.sh server -p 9000
#     ./run.sh all          # 同默认：安装依赖 + 编译前端 + 启动
#     ./run.sh deps         # 仅安装 / 升级 Python + Node 依赖
#     ./run.sh tools        # 仅安装 / 检查 Claude、Hermes 等 CLI 可执行文件
#     ./run.sh clean        # 清理 dist/ node_modules/ __pycache__/ .venv/
#     ./run.sh electron     # 构建前端并以 Electron 桌面壳启动（可内嵌 DeepSeek 等站）
#
#   环境变量:
#     PORT=8765        后端监听端口（也可通过 -p / 位置参数指定）
#     HOST=0.0.0.0
#     VENV_DIR=.venv   Python 虚拟环境目录
#     SKIP_OPTIONAL=1  跳过可选依赖 (DDGS web_search)
#     SKIP_CLI_TOOLS=1 跳过 Claude / Hermes 等 CLI 安装检查
#     CLI_UPDATE=0          跳过已安装 Claude/Codex CLI 的更新检查
#     HERMES_CLI_UPDATE=1   启用 Hermes CLI 的版本更新检查（默认关闭）
#     HERMES_INSTALL_ARGS="--skip-browser"  传给 hermes install.sh 的额外参数
#     HERMES_PROXY=http://127.0.0.1:20809  下载/安装 Hermes 时使用的本地代理（空=直连）
#     FLASK_DEBUG=1    开启 Flask debug/reloader（默认关闭，日志轮转使用单进程）
#     LOG_DIR=logs     服务与大模型交互日志目录
#     LOG_LLM_CONTENT=0 仅记录交互元数据，不保存提示词与回复正文
#     ELECTRON_DISABLE_GPU=0 重新启用 Electron GPU（Linux 默认关闭以规避 VSync 错误）
#
#   核心 / 可选 Python 依赖:
#     必需: flask, requests
#     可选: flask-sock      （WebSocket PTY 真终端 /ws，仅 Unix）
#           ddgs            （/api/web-search 的 DuckDuckGo 联网搜索）
# ============================================================

set -e

cd "$(dirname "$0")"
ROOT_DIR="$(pwd)"

PORT="${PORT:-8765}"
HOST="${HOST:-0.0.0.0}"
VENV_DIR="${VENV_DIR:-.venv}"
SKIP_OPTIONAL="${SKIP_OPTIONAL:-0}"
SKIP_CLI_TOOLS="${SKIP_CLI_TOOLS:-0}"
CLI_UPDATE="${CLI_UPDATE:-1}"
# Hermes 的版本检查会访问远程 Git/PyPI，默认关闭；需要时显式设置为 1。
HERMES_CLI_UPDATE="${HERMES_CLI_UPDATE:-0}"
HERMES_INSTALL_ARGS="${HERMES_INSTALL_ARGS:---skip-browser}"
# 下载 Hermes 默认走本地 20809 代理（Clash/V2Ray 等）；设 HERMES_PROXY= 可关闭
HERMES_PROXY="${HERMES_PROXY-http://127.0.0.1:20809}"

# ---------- 工具函数 ----------
log()  { printf "\033[1;36m[run]\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m[warn]\033[0m %s\n" "$*"; }
err()  { printf "\033[1;31m[error]\033[0m %s\n" "$*" >&2; }

need() {
    command -v "$1" >/dev/null 2>&1 || { err "缺少命令: $1"; exit 1; }
}

_validate_port() {
    if ! [[ "$PORT" =~ ^[0-9]+$ ]] || [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
        err "无效端口: $PORT（需为 1-65535 的整数）"
        exit 1
    fi
}

# 解析命令行：支持 -p/--port/纯数字端口，其余为子命令
parse_args() {
    CMD=""
    while [ $# -gt 0 ]; do
        case "$1" in
            -p|--port)
                [ -n "${2:-}" ] || { err "选项 $1 需要端口号"; exit 1; }
                PORT="$2"
                shift 2
                ;;
            --port=*)
                PORT="${1#*=}"
                shift
                ;;
            -h|--help|help)
                CMD="help"
                shift
                ;;
            build|dev|server|backend|all|deps|tools|cli|clean|electron)
                CMD="$1"
                [ "$CMD" = "backend" ] && CMD="server"
                [ "$CMD" = "cli" ] && CMD="tools"
                shift
                ;;
            *)
                if [[ "$1" =~ ^[0-9]+$ ]]; then
                    PORT="$1"
                    shift
                else
                    err "未知参数: $1"
                    exit 1
                fi
                ;;
        esac
    done
    [ -z "$CMD" ] && CMD="default"
    _validate_port
}

_ensure_path_local_bin() {
    case ":$PATH:" in
        *":$HOME/.local/bin:"*) ;;
        *) export PATH="$HOME/.local/bin:$PATH" ;;
    esac
}

_NPM_USER_PREFIX="${NPM_USER_PREFIX:-$HOME/.local}"

_load_nvm() {
    export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
    if [ -s "$NVM_DIR/nvm.sh" ]; then
        # shellcheck disable=SC1090
        . "$NVM_DIR/nvm.sh"
        return 0
    fi
    return 1
}

_ensure_node_on_path() {
    _load_nvm 2>/dev/null || true
    hash -r 2>/dev/null || true
    _ensure_path_local_bin
}

# 升级 Node.js 到最新版（优先 nvm → fnm → n → 引导安装 nvm）
_upgrade_node() {
    log "升级 Node.js 到最新版..."

    if _load_nvm; then
        if nvm install node && nvm use node && nvm alias default node 2>/dev/null; then
            _ensure_node_on_path
            log "Node 已升级 (nvm): $(node -v 2>/dev/null)"
            return 0
        fi
    fi

    if command -v fnm >/dev/null 2>&1; then
        # shellcheck disable=SC1090
        if fnm install --latest && eval "$(fnm env)"; then
            _ensure_node_on_path
            log "Node 已升级 (fnm): $(node -v 2>/dev/null)"
            return 0
        fi
    fi

    if command -v n >/dev/null 2>&1; then
        if n latest; then
            _ensure_node_on_path
            log "Node 已升级 (n): $(node -v 2>/dev/null)"
            return 0
        fi
    fi

    if command -v curl >/dev/null 2>&1; then
        export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
        if [ ! -s "$NVM_DIR/nvm.sh" ]; then
            log "安装 nvm 以便升级 Node.js..."
            if curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash; then
                _load_nvm && nvm install node && nvm use node && nvm alias default node 2>/dev/null
                _ensure_node_on_path
                log "Node 已升级 (新装 nvm): $(node -v 2>/dev/null)"
                return 0
            fi
        elif _load_nvm; then
            nvm install node && nvm use node && nvm alias default node 2>/dev/null
            _ensure_node_on_path
            log "Node 已升级 (nvm): $(node -v 2>/dev/null)"
            return 0
        fi
    fi

    warn "无法自动升级 Node.js，请手动安装 Node 22+（推荐 nvm: https://github.com/nvm-sh/nvm）"
    return 1
}

# npm 命令失败时自动升级 Node 并重试一次
_npm_try_upgrade_retry() {
    local label="$1"
    shift
    if "$@"; then
        return 0
    fi
    warn "${label} 失败，尝试升级 Node.js 到最新版后重试..."
    _upgrade_node || return 1
    need npm
    "$@"
}

# 用户级 npm 全局安装（避免写入 /usr/lib 权限错误）
_npm_user_global() {
    mkdir -p "$_NPM_USER_PREFIX/bin" "$_NPM_USER_PREFIX/lib"
    _npm_try_upgrade_retry "npm 全局安装" \
        env NPM_CONFIG_PREFIX="$_NPM_USER_PREFIX" npm install -g "$@"
}

# 判断下载内容是否为 shell 安装脚本（过滤地区限制页等 HTML）
_is_shell_script() {
    local f="$1"
    [ -f "$f" ] || return 1
    head -c 256 "$f" | grep -q '^#!' && return 0
    head -n 5 "$f" | grep -qE '(^#!/|(^|\s)bash|set -e)' && return 0
    return 1
}

# 下载远程安装脚本，校验后再执行（禁止 curl | bash 直接管道 HTML）
# 用法: _run_remote_installer URL [installer-args...]
# 环境变量 CURL_PROXY：若设置则 curl 走该代理
_run_remote_installer() {
    local url="$1"
    shift
    local tmp rc=1
    local curl_opts=(-fsSL)
    if [ -n "${CURL_PROXY:-}" ]; then
        curl_opts+=(-x "$CURL_PROXY")
    fi
    tmp="$(mktemp)"
    if curl "${curl_opts[@]}" "$url" -o "$tmp" 2>/dev/null; then
        if _is_shell_script "$tmp"; then
            # 安装脚本内部下载也走同一代理
            if [ -n "${CURL_PROXY:-}" ]; then
                HTTP_PROXY="$CURL_PROXY" HTTPS_PROXY="$CURL_PROXY" ALL_PROXY="$CURL_PROXY" \
                    http_proxy="$CURL_PROXY" https_proxy="$CURL_PROXY" all_proxy="$CURL_PROXY" \
                    bash "$tmp" "$@" && rc=0
            else
                bash "$tmp" "$@" && rc=0
            fi
        else
            warn "安装脚本不可用（$url 返回非脚本内容，可能被地区限制）"
        fi
    fi
    rm -f "$tmp"
    return "$rc"
}

# Hermes 下载用代理：探测本地端口是否在听
_hermes_proxy_env() {
    if [ -z "${HERMES_PROXY:-}" ]; then
        return 1
    fi
    local host port
    # 支持 http://127.0.0.1:20809 或 127.0.0.1:20809
    host="$(printf '%s' "$HERMES_PROXY" | sed -E 's#^[a-zA-Z]+://##; s#/.*##; s#:.*##')"
    port="$(printf '%s' "$HERMES_PROXY" | sed -E 's#^[a-zA-Z]+://##; s#/.*##; s#.*:##')"
    [ -n "$host" ] || host="127.0.0.1"
    [ -n "$port" ] || port="20809"
    if (echo >/dev/tcp/"$host"/"$port") 2>/dev/null; then
        return 0
    fi
    if command -v curl >/dev/null 2>&1; then
        curl -fsS -m 2 -o /dev/null "http://${host}:${port}/" 2>/dev/null && return 0
    fi
    return 1
}

_install_claude_via_npm() {
    command -v npm >/dev/null 2>&1 || return 1
    log "通过 npm 用户级安装 Claude Code（$_NPM_USER_PREFIX）..."
    _npm_user_global @anthropic-ai/claude-code@latest
}

_cli_executable() {
    local name="$1"
    local home_bin="$HOME/.local/bin/$name"
    if [ -x "$home_bin" ]; then
        printf '%s\n' "$home_bin"
        return 0
    fi
    command -v "$name" 2>/dev/null || true
}

_cli_version_line() {
    local bin="$1"
    shift
    "$bin" "$@" 2>/dev/null | head -n1 | tr -d '\r' || true
}

_version_number() {
    printf '%s\n' "$1" | grep -oE '[0-9]+(\.[0-9]+){1,3}([.-][0-9A-Za-z.]+)?' | head -n1 || true
}

_claude_latest_version() {
    command -v npm >/dev/null 2>&1 || return 1
    npm view @anthropic-ai/claude-code version --silent --fetch-timeout=10000 --fetch-retries=1 2>/dev/null | tail -n1 | tr -d '\r' || true
}

_install_claude_cli() {
    local cli current_line current_version latest_version
    cli="$(_cli_executable claude)"
    if [ -n "$cli" ]; then
        if [ "$CLI_UPDATE" = "1" ]; then
            current_line="$(_cli_version_line "$cli" --version)"
            current_version="$(_version_number "$current_line")"
            latest_version="$(_claude_latest_version || true)"
            latest_version="$(_version_number "$latest_version")"
            if [ -n "$current_version" ] && [ -n "$latest_version" ] \
                && [ "$current_version" = "$latest_version" ]; then
                log "Claude Code 已是最新版: $current_line"
            elif [ -n "$latest_version" ]; then
                log "发现 Claude Code 更新: ${current_version:-未知} -> $latest_version"
                if "$cli" update >/dev/null 2>&1 \
                    || _install_claude_via_npm; then
                    hash -r 2>/dev/null || true
                    cli="$(_cli_executable claude)"
                    log "Claude Code 已更新: $(_cli_version_line "$cli" --version)"
                else
                    warn "Claude Code 自动更新失败，将继续使用当前版本"
                fi
            else
                warn "无法获取 Claude Code 最新版本，将继续使用: $current_line"
            fi
        else
            log "Claude Code 已就绪: $(_cli_version_line "$cli" --version)"
        fi
        return 0
    fi

    log "安装 Claude Code CLI..."
    if command -v curl >/dev/null 2>&1; then
        _run_remote_installer "https://claude.ai/install.sh" \
            || warn "Claude 官方安装脚本不可用，尝试 npm 用户级安装..."
    else
        warn "未找到 curl，跳过 Claude 官方安装脚本"
    fi

    _ensure_path_local_bin
    cli="$(_cli_executable claude)"
    if [ -n "$cli" ]; then
        log "Claude Code 安装完成: $(_cli_version_line "$cli" --version)"
        return 0
    fi

    if _install_claude_via_npm; then
        _ensure_path_local_bin
        cli="$(_cli_executable claude)"
        if [ -n "$cli" ]; then
            log "Claude Code 安装完成: $(_cli_version_line "$cli" --version)"
            return 0
        fi
    fi

    warn "Claude Code 安装失败，Claude Code 标签页将不可用"
    warn "可手动执行: npm install -g @anthropic-ai/claude-code@latest --prefix \$HOME/.local"
    return 1
}

_hermes_version_output() {
    local cli="$1" output
    output="$("$cli" --version 2>&1 || true)"
    if ! printf '%s\n' "$output" | grep -q 'Hermes Agent'; then
        output="$("$cli" version 2>&1 || true)"
    fi
    printf '%s\n' "$output"
}

_hermes_version_line() {
    _hermes_version_output "$1" | head -n1 | tr -d '\r'
}

_hermes_install_dir() {
    _hermes_version_output "$1" | sed -n 's/^Install directory:[[:space:]]*//p' | head -n1
}

_hermes_report_failure() {
    local label="$1" rc="$2" output="$3" line
    warn "$label（exit=$rc）"
    while IFS= read -r line; do
        [ -n "$line" ] && warn "  $line"
    done <<< "$output"
}

# 只清理 Git 明确报告的、位于 Hermes 自身 .git 下且未被占用的遗留锁。
_hermes_recover_stale_lock() {
    local cli="$1" output="$2" install_dir lock resolved
    printf '%s\n' "$output" | grep -qE "Unable to create '.*\.lock'.*File exists" || return 1
    install_dir="$(_hermes_install_dir "$cli")"
    [ -n "$install_dir" ] && [ -d "$install_dir/.git" ] || return 1
    lock="$(printf '%s\n' "$output" | sed -n "s#.*Unable to create '\([^']*\.lock\)'.*#\1#p" | head -n1)"
    [ -n "$lock" ] || return 1
    resolved="$(readlink -f "$lock" 2>/dev/null || true)"
    case "$resolved" in
        "$install_dir"/.git/*.lock) ;;
        *) warn "拒绝清理 Hermes 仓库之外的锁文件: $lock"; return 1 ;;
    esac
    if command -v lsof >/dev/null 2>&1 && lsof "$resolved" >/dev/null 2>&1; then
        warn "Hermes Git 锁仍被进程占用，不自动删除: $resolved"
        return 1
    fi
    if command -v fuser >/dev/null 2>&1 && fuser "$resolved" >/dev/null 2>&1; then
        warn "Hermes Git 锁仍被进程占用，不自动删除: $resolved"
        return 1
    fi
    rm -f -- "$resolved"
    log "已清理 Hermes 遗留 Git 锁: $resolved"
}

# 优先走可达的 HERMES_PROXY；代理失败或不可达时自动直连重试。
_hermes_update_once() {
    local cli="$1"
    shift
    local output rc proxy_output proxy_rc
    if _hermes_proxy_env; then
        if output="$(HTTP_PROXY="$HERMES_PROXY" HTTPS_PROXY="$HERMES_PROXY" ALL_PROXY="$HERMES_PROXY" \
            http_proxy="$HERMES_PROXY" https_proxy="$HERMES_PROXY" all_proxy="$HERMES_PROXY" \
            "$cli" update "$@" 2>&1)"; then
            printf '%s\n' "$output"
            return 0
        else
            proxy_rc=$?
            proxy_output="$output"
            printf '%s\n' "[代理尝试失败 exit=$proxy_rc]" "$proxy_output" "[改用直连重试]"
        fi
    elif [ -n "${HERMES_PROXY:-}" ]; then
        printf '%s\n' "[代理 $HERMES_PROXY 不可达，改用直连]"
    fi
    if output="$(HTTP_PROXY= HTTPS_PROXY= ALL_PROXY= http_proxy= https_proxy= all_proxy= \
        "$cli" update "$@" 2>&1)"; then
        printf '%s\n' "$output"
        return 0
    else
        rc=$?
        printf '%s\n' "$output"
        return "$rc"
    fi
}

_hermes_checked_update() {
    local cli="$1" check_output update_output verify_output rc
    log "检查 Hermes Agent 更新..."
    if check_output="$(_hermes_update_once "$cli" --check)"; then
        :
    else
        rc=$?
        _hermes_report_failure "Hermes Agent 更新检查失败" "$rc" "$check_output"
        if _hermes_recover_stale_lock "$cli" "$check_output"; then
            log "清理遗留锁后重新检查 Hermes Agent 更新..."
            if check_output="$(_hermes_update_once "$cli" --check)"; then
                :
            else
                rc=$?
                _hermes_report_failure "Hermes Agent 更新重试失败" "$rc" "$check_output"
                return 1
            fi
        else
            return 1
        fi
    fi
    if printf '%s\n' "$check_output" | grep -qiE \
        '(up[ -]?to[ -]?date|already.*latest|no update|0 commit(s)? behind)'; then
        log "Hermes Agent 已是最新版（校验通过）: $(_hermes_version_line "$cli")"
        return 0
    fi

    # 不依赖某一版本的提示文案：未明确为最新版时执行幂等更新。
    log "发现或无法明确判断 Hermes Agent 更新状态，开始执行更新..."
    if update_output="$(_hermes_update_once "$cli" --yes)"; then
        :
    else
        rc=$?
        _hermes_report_failure "Hermes Agent 更新失败" "$rc" "$update_output"
        if _hermes_recover_stale_lock "$cli" "$update_output"; then
            log "清理遗留锁后重新执行 Hermes Agent 更新..."
            if update_output="$(_hermes_update_once "$cli" --yes)"; then
                :
            else
                rc=$?
                _hermes_report_failure "Hermes Agent 更新重试失败" "$rc" "$update_output"
                return 1
            fi
        else
            return 1
        fi
    fi

    # 更新命令退出 0 后再次 fetch/check，确认本地确实同步到上游。
    if verify_output="$(_hermes_update_once "$cli" --check)"; then
        :
    else
        rc=$?
        _hermes_report_failure "Hermes Agent 更新后校验失败" "$rc" "$verify_output"
        return 1
    fi
    if ! printf '%s\n' "$verify_output" | grep -qiE \
        '(up[ -]?to[ -]?date|already.*latest|no update|0 commit(s)? behind)'; then
        _hermes_report_failure "Hermes Agent 更新后仍未确认是最新版" 1 "$verify_output"
        return 1
    fi
    hash -r 2>/dev/null || true
    log "Hermes Agent 已更新且校验通过: $(_hermes_version_line "$cli")"
}

_install_hermes_via_pip() {
    if [ ! -f "$VENV_DIR/bin/activate" ]; then
        return 1
    fi
    # shellcheck disable=SC1090
    source "$VENV_DIR/bin/activate"
    local pip_proxy_args=()
    if [ -n "${HERMES_PROXY:-}" ]; then
        pip_proxy_args=(--proxy "$HERMES_PROXY")
        log "通过 pip 安装 Hermes Agent（$VENV_DIR，代理 $HERMES_PROXY）..."
    else
        log "通过 pip 安装 Hermes Agent（$VENV_DIR）..."
    fi
    pip install -q --upgrade pip "${pip_proxy_args[@]}" 2>/dev/null || true
    if ! pip install -q --upgrade "${pip_proxy_args[@]}" hermes-agent; then
        return 1
    fi
    local vbin="$VENV_DIR/bin/hermes"
    if [ -x "$vbin" ]; then
        mkdir -p "$HOME/.local/bin"
        ln -sf "$vbin" "$HOME/.local/bin/hermes" 2>/dev/null || true
        _ensure_path_local_bin
        log "Hermes Agent 安装完成: $(_hermes_version_line "$vbin")"
        return 0
    fi
    return 1
}

_install_hermes_cli() {
    local cli
    cli="$(_cli_executable hermes)"
    if [ -n "$cli" ]; then
        if [ "$HERMES_CLI_UPDATE" = "1" ]; then
            _hermes_checked_update "$cli" || {
                err "Hermes Agent 未能更新并验证；为避免继续使用无法确认的旧版本，本次启动已停止。"
                err "可用 HERMES_CLI_UPDATE=0 临时跳过，或根据上面的原始错误修复网络/Git 后重试。"
                return 1
            }
        else
            log "Hermes Agent 已就绪（HERMES_CLI_UPDATE=0，未检查更新）: $(_hermes_version_line "$cli")"
        fi
        return 0
    fi

    log "安装 Hermes Agent CLI..."
    if [ -n "${HERMES_PROXY:-}" ]; then
        export CURL_PROXY="$HERMES_PROXY"
        if _hermes_proxy_env; then
            log "Hermes 下载使用本地代理: $HERMES_PROXY"
        else
            warn "本地代理 $HERMES_PROXY 暂不可达，仍将尝试经该代理下载（请确认代理已启动）"
        fi
    else
        unset CURL_PROXY || true
    fi

    # 1) 官方 / GitHub 安装脚本（经代理下载）
    local installed=1
    if command -v curl >/dev/null 2>&1; then
        for url in \
            "https://hermes-agent.nousresearch.com/install.sh" \
            "https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh"
        do
            # shellcheck disable=SC2086
            if _run_remote_installer "$url" $HERMES_INSTALL_ARGS; then
                installed=0
                break
            fi
            warn "Hermes 安装脚本失败: $url"
        done
    else
        warn "未找到 curl，跳过 Hermes 安装脚本"
    fi

    _ensure_path_local_bin
    cli="$(_cli_executable hermes)"
    if [ -n "$cli" ]; then
        log "Hermes Agent 安装完成: $(_hermes_version_line "$cli")"
        unset CURL_PROXY || true
        return 0
    fi

    # 2) pip 回退（同样走 HERMES_PROXY）
    if _install_hermes_via_pip; then
        unset CURL_PROXY || true
        return 0
    fi

    unset CURL_PROXY || true
    warn "Hermes Agent 安装失败，Hermes 标签页将不可用"
    warn "可手动执行: source $VENV_DIR/bin/activate && pip install --proxy $HERMES_PROXY hermes-agent"
    return 1
}

setup_cli_tools() {
    if [ "$SKIP_CLI_TOOLS" = "1" ]; then
        warn "SKIP_CLI_TOOLS=1，跳过 Claude / Hermes CLI 安装检查"
        return 0
    fi
    _ensure_path_local_bin
    log "检查 / 安装 Agent CLI 可执行文件..."
    _install_claude_cli || true
    if ! _install_hermes_cli; then
        return 1
    fi
    log "CLI 可执行文件检查完成"
}

# ---------- Python 环境 ----------
setup_python() {
    need python3
    if [ ! -d "$VENV_DIR" ]; then
        log "创建 Python 虚拟环境: $VENV_DIR"
        python3 -m venv "$VENV_DIR"
    fi
    # shellcheck disable=SC1090
    source "$VENV_DIR/bin/activate"

    # 必需依赖
    if ! python -c "import flask, requests" >/dev/null 2>&1; then
        log "安装核心 Python 依赖 (flask, requests)..."
        pip install -q --upgrade pip
        pip install -q flask requests
    fi

    # MultiLLM Fusion 的独立窗口使用同一虚拟环境运行 FastAPI bridge，
    # 避免用户再维护一套隐藏的 Python 环境。
    if ! python -c "import fastapi, uvicorn, httpx, pydantic, json_repair" >/dev/null 2>&1; then
        log "安装 MultiLLM Fusion / Desktop Agent 依赖..."
        pip install -q -r multillm-fusion/requirements.txt
    fi

    # flask-sock：Claude/Hermes 终端 WebSocket 必需（不受 SKIP_OPTIONAL 影响）
    if ! python -c "import flask_sock" >/dev/null 2>&1; then
        log "安装 flask-sock (WebSocket，Claude/Hermes 终端必需)..."
        pip install -q flask-sock || warn "flask-sock 安装失败，Agent 终端将不可用"
    fi

    # 可选依赖
    if [ "$SKIP_OPTIONAL" != "1" ]; then
        if ! python -c "from ddgs import DDGS" >/dev/null 2>&1; then
            log "安装 DDGS web_search (DuckDuckGo 联网搜索)..."
            pip install -q --upgrade ddgs || warn "ddgs 安装失败，/api/web-search 将不可用"
        fi
    fi
}

# ---------- Node 环境 ----------
setup_node() {
    need npm
    if [ ! -d "node_modules" ]; then
        log "安装前端依赖 (npm install)..."
        _npm_try_upgrade_retry "npm install" npm install
    fi
}

ensure_node_deps() {
    need npm
    log "安装 / 检查前端依赖 (npm install)..."
    _npm_try_upgrade_retry "npm install" npm install
}

# ---------- 子命令 ----------
build_frontend() {
    setup_node
    log "构建前端 (vite build -> dist/)"
    npm run build
}

dev_frontend() {
    setup_node
    log "启动前端开发服务器 (vite dev)"
    exec npm run dev
}

start_server() {
    setup_python
    setup_cli_tools
    setup_node
    if [ ! -d "dist" ] || [ -z "$(ls -A dist 2>/dev/null)" ]; then
        warn "dist/ 不存在或为空，先执行前端构建..."
        build_frontend
    fi
    log "启动后端: http://${HOST}:${PORT}"
    PORT="$PORT" HOST="$HOST" exec python server.py
}

start_full() {
    setup_python
    setup_cli_tools
    ensure_node_deps
    build_frontend
    log "启动服务: http://${HOST}:${PORT}"
    PORT="$PORT" HOST="$HOST" exec python server.py
}

install_deps() {
    setup_python
    setup_cli_tools
    setup_node
    log "依赖检查完成"
}

install_tools() {
    setup_python
    setup_cli_tools
}

clean_all() {
    log "清理产物..."
    rm -rf dist node_modules __pycache__ "$VENV_DIR"
    find . -type d -name "__pycache__" -prune -exec rm -rf {} + 2>/dev/null || true
    log "完成"
}

start_electron() {
    need npm
    install_deps
    build_frontend
    if [ ! -d node_modules/electron ]; then
        log "安装 Electron..."
        npm install --no-fund --no-audit
    fi
    log "启动 Electron（将自动拉起后端 PORT=$PORT）..."
    # 清除 IDE 可能注入的 ELECTRON_RUN_AS_NODE，否则 electron.app 为 undefined
    env -u ELECTRON_RUN_AS_NODE PORT="$PORT" ELECTRON_START_SERVER=1 \
      node electron/launch.cjs .
}

# ---------- 入口 ----------
parse_args "$@"
case "$CMD" in
    default|all)    start_full ;;
    build)          build_frontend ;;
    dev)            dev_frontend ;;
    server)         start_server ;;
    deps)           install_deps ;;
    tools)          install_tools ;;
    clean)          clean_all ;;
    electron)       start_electron ;;
    help|-h|--help)
        sed -n '2,37p' "$0"
        ;;
    *)
        err "未知命令: $CMD"
        sed -n '2,37p' "$0"
        exit 1
        ;;
esac
