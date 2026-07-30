#!/usr/bin/env bash
# ============================================================
# 源码打包脚本
#   只打包"源码 + 运行所需文件"，排除：
#     - 编译产物：.venv / node_modules / dist / __pycache__ / *.pyc ...
#     - 执行期生成：workspace/(临时代码、模型、下载物) / data/(对话、统计、密钥) / 日志 / *.bak.*
#   解压后执行 ./run.sh 即可重新装依赖、构建前端并启动。
#
#   用法:
#     ./package.sh            # 生成 release/<name>_<时间戳>.tar.gz
#     ./package.sh --list     # 仅预览将被打包的文件清单（不生成压缩包）
#     ./package.sh --help
#
#   环境变量:
#     PKG_NAME=model-api-mt   压缩包名前缀
#     OUT_DIR=./release       输出目录
#     FORMAT=tar.gz|zip       打包格式（默认 tar.gz）
# ============================================================
set -euo pipefail

cd "$(dirname "$0")"
ROOT_DIR="$(pwd)"
BASE="$(basename "$ROOT_DIR")"
PARENT="$(dirname "$ROOT_DIR")"

PKG_NAME="${PKG_NAME:-model-api-mt}"
OUT_DIR="${OUT_DIR:-$ROOT_DIR/release}"
FORMAT="${FORMAT:-tar.gz}"
STAMP="$(date +%Y%m%d_%H%M%S)"

log()  { printf "\033[1;36m[pack]\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m[warn]\033[0m %s\n" "$*"; }
err()  { printf "\033[1;31m[error]\033[0m %s\n" "$*" >&2; }

# ---------- 排除规则 ----------
# 顶层目录（相对 tar 的工作目录 PARENT，因此带上 $BASE/ 前缀）
DIR_EXCLUDES=(
    "$BASE/.git"
    "$BASE/release"
    "$BASE/node_modules"
    "$BASE/dist"
    "$BASE/.venv"
    "$BASE/workspace"   # 执行期：临时代码 / 模型 / 下载物 / .venv-run
    "$BASE/data"        # 执行期：对话、模型统计、providers(含密钥)、.sudo_pass
    "$BASE/plugins"     # 执行期：插件管理器运行时安装的插件(plugin_<时间戳>_*)，启动时自动重建
)
# 通配规则（匹配任意层级；GNU tar 的 * 会跨越 /）
GLOB_EXCLUDES=(
    '*/plugins/plugin_*'  # 任意层级里运行时安装的插件实例(plugin_<时间戳>_*)
    '*/__pycache__'
    '*/node_modules'      # 插件子目录里的依赖
    '*/.venv'
    '*/.venv-run'
    '*/dist'
    '*.pyc'
    '*.pyo'
    '*.bak'
    '*.bak.*'             # server.py.bak.* / App.tsx.bak.* ...
    '*/.vite'
    '*/.mypy_cache'
    '*/.pytest_cache'
    '*/.ruff_cache'
    '*/.cache'
    '*.log'
    '*/wget-log'
    '*.egg-info'
    '*.DS_Store'
    '*/.sudo_pass'
    '*.tar.gz'
    '*.tgz'
    '*.zip'
)

build_tar_excludes() {
    TAR_EXCL=()
    local e
    for e in "${DIR_EXCLUDES[@]}";  do TAR_EXCL+=( --exclude="$e" ); done
    for e in "${GLOB_EXCLUDES[@]}"; do TAR_EXCL+=( --exclude="$e" ); done
}

# ---------- 子命令：预览清单 ----------
list_files() {
    command -v tar >/dev/null 2>&1 || { err "缺少命令: tar"; exit 1; }
    build_tar_excludes
    log "将被打包的文件（预览，不生成压缩包）："
    tar -C "$PARENT" "${TAR_EXCL[@]}" --exclude-vcs -cf - "$BASE" \
        | tar -tf - | sort
}

# ---------- 打 tar.gz ----------
pack_targz() {
    command -v tar >/dev/null 2>&1 || { err "缺少命令: tar"; exit 1; }
    build_tar_excludes
    local archive="$OUT_DIR/${PKG_NAME}_${STAMP}.tar.gz"
    mkdir -p "$OUT_DIR"
    log "打包中 -> $archive"
    tar -C "$PARENT" "${TAR_EXCL[@]}" --exclude-vcs -czf "$archive" "$BASE"
    finish "$archive"
}

# ---------- 打 zip ----------
pack_zip() {
    command -v zip >/dev/null 2>&1 || { err "缺少命令: zip（或改用 FORMAT=tar.gz）"; exit 1; }
    local archive="$OUT_DIR/${PKG_NAME}_${STAMP}.zip"
    mkdir -p "$OUT_DIR"
    # zip 的排除模式相对被压缩目录，统一去掉 $BASE/ 前缀
    local zip_excl=()
    local e
    for e in "${DIR_EXCLUDES[@]}";  do zip_excl+=( -x "${e#$BASE/}/*" ); done
    for e in "${GLOB_EXCLUDES[@]}"; do zip_excl+=( -x "$e" ); done
    log "打包中 -> $archive"
    ( cd "$ROOT_DIR" && zip -rq "$archive" . "${zip_excl[@]}" -x '.git/*' )
    finish "$archive"
}

finish() {
    local archive="$1"
    local size
    size="$(du -h "$archive" | cut -f1)"
    local count
    case "$archive" in
        *.tar.gz) count="$(tar -tzf "$archive" | wc -l)";;
        *.zip)    count="$(unzip -l "$archive" 2>/dev/null | tail -1 | awk '{print $2}')";;
    esac
    log "完成：$archive"
    log "大小：$size    条目：${count:-?}"
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$archive" | awk '{print "[pack] SHA256："$1}'
    fi
    warn "已排除：编译产物(.venv/node_modules/dist/__pycache__) 与 执行期文件(workspace/data/日志/备份)。"
    warn "解压后运行 ./run.sh 即可自动装依赖、构建前端并启动。"
}

# ---------- 入口 ----------
cmd="${1:-pack}"
case "$cmd" in
    pack|"")
        case "$FORMAT" in
            tar.gz|targz|tgz) pack_targz ;;
            zip)              pack_zip ;;
            *) err "未知 FORMAT: $FORMAT（支持 tar.gz / zip）"; exit 1 ;;
        esac
        ;;
    --list|list|-l)   list_files ;;
    -h|--help|help)   sed -n '2,24p' "$0" ;;
    *) err "未知参数: $cmd"; sed -n '2,24p' "$0"; exit 1 ;;
esac
