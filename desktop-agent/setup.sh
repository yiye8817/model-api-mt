#!/usr/bin/env bash
set -euo pipefail
AGENT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
BROWSER=0
DESKTOP=0
for argument in "$@"; do
  case "$argument" in
    --browser) BROWSER=1 ;;
    --desktop) DESKTOP=1 ;;
    --all) BROWSER=1; DESKTOP=1 ;;
    -h|--help)
      cat <<'HELP'
安装可选工具依赖到 desktop-agent/.venv，无需 root，不修改父项目环境。
  ./setup.sh --browser          安装 Playwright 与 Chromium 用户目录二进制
  ./setup.sh --desktop          安装 PyAutoGUI、Pillow、Pyperclip
  ./setup.sh --all              安装以上两组
核心 CLI/文件工具依赖 json-repair；其他浏览器/桌面依赖按需安装。
本脚本不运行 sudo、apt 或 playwright install-deps。
如果桌面/浏览器缺少系统动态库，需要使用已具备依赖的桌面环境。
HELP
      exit 0 ;;
    *) echo "未知安装选项：$argument；使用 --help" >&2; exit 2 ;;
  esac
done
if [[ "$BROWSER" == 0 && "$DESKTOP" == 0 ]]; then
  echo '请选择 --browser、--desktop 或 --all；核心功能可直接使用 ./run.sh。' >&2
  exit 2
fi
python3 -c 'import sys; assert sys.version_info >= (3, 10), "需要 Python 3.10+"'
if [[ ! -x "$AGENT_ROOT/.venv/bin/python" ]]; then
  python3 -m venv "$AGENT_ROOT/.venv"
fi
AGENT_PYTHON="$AGENT_ROOT/.venv/bin/python"
"$AGENT_PYTHON" -m pip install -e "$AGENT_ROOT"
if [[ "$BROWSER" == 1 ]]; then
  "$AGENT_PYTHON" -m pip install -r "$AGENT_ROOT/requirements-browser.txt"
  "$AGENT_PYTHON" -m playwright install chromium
fi
if [[ "$DESKTOP" == 1 ]]; then
  "$AGENT_PYTHON" -m pip install -r "$AGENT_ROOT/requirements-desktop.txt"
fi
echo '可选依赖安装完成。运行 ./run.sh doctor 查看 API、显示环境和工具依赖。'
