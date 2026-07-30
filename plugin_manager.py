import ast
import json
import re
import os
import base64
import hashlib
import subprocess
import tempfile
import threading
from pathlib import Path
from datetime import datetime
from typing import Dict, Any, Optional, Tuple, List, Callable

PLUGINS_DIR = Path(__file__).parent / 'plugins'
PLUGINS_DIR.mkdir(exist_ok=True)

# ============================================================
# 输出格式说明（system prompt 用）
# ============================================================
PLUGIN_OUTPUT_FORMAT_PY = '''
你生成的Python代码需要输出JSON格式的结果：result = {"type": "mixed", "content": []}
content 可包含: {"type": "text", "data": "..."}, {"type": "status", "status": "success|warning|error|info", "message": "..."},
{"type": "table", "title": "...", "headers": [], "rows": []}, {"type": "info", "title": "...", "data": {}},
{"type": "list", "title": "...", "items": []}, {"type": "code", "language": "py", "data": "..."}
最后必须: print("===PLUGIN_RESULT===" + json.dumps(result, ensure_ascii=False))
'''

PLUGIN_OUTPUT_FORMAT_BASH = '''
你生成的 Bash 脚本必须在最后输出一行 JSON 结果（用于 UI 渲染），格式：
echo "===PLUGIN_RESULT===<JSON_STRING>"
其中 JSON_STRING 形如：
{"type":"mixed","content":[
  {"type":"status","status":"success","message":"..."},
  {"type":"text","data":"..."},
  {"type":"table","title":"...","headers":[],"rows":[]},
  {"type":"list","title":"...","items":[]},
  {"type":"code","language":"sh","data":"..."}
]}
脚本顶部建议:  set -euo pipefail
若需要 root 权限，请直接使用 sudo（无需在脚本里处理密码，运行环境会自动注入已保存密码）。
'''

# 保留旧名称给老代码引用
PLUGIN_OUTPUT_FORMAT = PLUGIN_OUTPUT_FORMAT_PY


# ============================================================
# 代码提取（从 LLM 文本中识别 bash / python）
# ============================================================
def extract_code(text: str, default_language: str = 'python') -> Tuple[str, str]:
    """返回 (code, language)。language 在 'python' / 'bash' 中。

    1) 优先 fence ```bash | ```sh | ```python``
    2) 无语言 fence：看首行 shebang 或关键字
    3) 整段裸代码
    """
    if not text:
        return '', default_language

    m = re.search(r'```(?:bash|sh|shell)\b\s*\n(.*?)\n```', text, re.DOTALL | re.IGNORECASE)
    if m:
        return m.group(1).strip(), 'bash'
    m = re.search(r'```(?:python|py)\b\s*\n(.*?)\n```', text, re.DOTALL | re.IGNORECASE)
    if m:
        return m.group(1).strip(), 'python'

    m = re.search(r'```\s*\n(.*?)\n```', text, re.DOTALL)
    if m:
        body = m.group(1).strip()
        if _looks_like_bash(body):
            return body, 'bash'
        if _looks_like_python(body):
            return body, 'python'
        return body, default_language

    body = text.strip()
    if _looks_like_bash(body):
        return body, 'bash'
    if _looks_like_python(body):
        return body, 'python'
    return '', default_language


def _looks_like_bash(body: str) -> bool:
    head = body.lstrip()[:200]
    if head.startswith(('#!/bin/bash', '#!/usr/bin/env bash', '#!/bin/sh', '#!/usr/bin/env sh')):
        return True
    bash_keywords = ('apt-get ', 'apt ', 'systemctl ', 'set -e', 'set -u', 'set -o pipefail',
                     'echo ', 'mkdir ', 'rm -', 'curl ', 'wget ')
    return any(k in head for k in bash_keywords) and 'def ' not in head and 'import ' not in head


def _looks_like_python(body: str) -> bool:
    head = body.lstrip()[:200]
    if head.startswith(('#!/usr/bin/env python', '#!/usr/bin/python', 'import ', 'from ', '#')):
        return True
    return 'def ' in head or 'print(' in head


# ============================================================
# 语法/项目结构校验：在执行前做一次廉价 sanity check，减少明显的编译/语法错误
# ============================================================
def validate_syntax(code: str, language: str) -> Tuple[bool, str]:
    """语法校验。返回 (ok, error_msg)。

    - python: ast.parse 解析（不执行任何代码）
    - bash:   bash -n 静态语法检查
    - 其它:   跳过，默认 ok=True

    错误信息会被规整为人类可读的多行说明，并指明出错行号。
    """
    if not code or not code.strip():
        return False, '代码为空'
    lang = (language or '').lower()
    if lang in ('python', 'py'):
        try:
            ast.parse(code)
            return True, ''
        except SyntaxError as e:
            line = e.lineno or 0
            col = e.offset or 0
            snippet = (e.text or '').rstrip('\n')
            return False, (
                f"Python SyntaxError @ line {line}, col {col}: {e.msg}\n"
                + (f"  >>> {snippet}\n" if snippet else '')
                + (f"      {' ' * max(0, col - 1)}^\n" if col else '')
            )
        except Exception as e:
            return False, f"Python parse error: {e}"
    if lang in ('bash', 'sh', 'shell'):
        with tempfile.NamedTemporaryFile('w', suffix='.sh', delete=False, encoding='utf-8') as tf:
            tf.write(code)
            tmp_path = tf.name
        try:
            r = subprocess.run(['bash', '-n', tmp_path], capture_output=True, text=True, timeout=10)
            if r.returncode == 0:
                return True, ''
            err = (r.stderr or r.stdout or 'bash syntax error').strip()
            err = err.replace(tmp_path, '<script>')
            return False, err
        except subprocess.TimeoutExpired:
            return False, 'bash -n 超时（脚本结构可能异常复杂）'
        except FileNotFoundError:
            # 系统没装 bash，跳过校验
            return True, ''
        except Exception as e:
            return False, f'bash -n 调用失败: {e}'
        finally:
            try: os.unlink(tmp_path)
            except Exception: pass
    return True, ''


# ============================================================
# 多文件项目工程化输出
# ============================================================
_PROJECT_FENCE_RE = re.compile(
    r'```([a-zA-Z0-9_+\-]+)\s*[:#]\s*([\w./\-]+)\s*\n([\s\S]*?)\n?```'
)
# 形如 ```python:main.py 或 ```python#path/to/file.py 的代码块


def _safe_rel_path(raw: str) -> Optional[str]:
    """归一化用户给的相对路径，拒绝跳出 plugin 目录的写入。返回 None 表示不安全。"""
    if not raw:
        return None
    p = raw.strip().lstrip('/').strip()
    if not p:
        return None
    # 拒绝绝对路径、上级、隐藏跳逃
    if p.startswith(('/', '\\')) or '..' in Path(p).parts:
        return None
    return p


def extract_project_files(text: str, default_language: str = 'python') -> Optional[Dict[str, Any]]:
    """从 LLM 输出中提取多文件项目结构。

    支持的格式（任选）：
      A) 在 fence 上标注路径： ```python:main.py
      B) 在 fence 上标注路径： ```python#lib/utils.py
      C) 文本类文件（无语言）：```:requirements.txt 或 ```text:requirements.txt
      D) 普通 ```python``` / ```bash``` 块未指定路径时按入口处理（仅在与其它带路径文件并存时生效）

    返回 {'files': [{'path': str, 'content': str, 'language': str}], 'entry': str, 'language': str}
    若没识别出"带路径"代码块，返回 None（调用方应回退到单文件 extract_code）。
    """
    if not text:
        return None
    found: List[Dict[str, str]] = []
    for m in _PROJECT_FENCE_RE.finditer(text):
        lang_tag = (m.group(1) or '').lower()
        raw_path = m.group(2)
        body = (m.group(3) or '').rstrip() + '\n'
        rel = _safe_rel_path(raw_path)
        if not rel:
            continue
        # 推断每个文件的语言（按扩展名）
        suffix = Path(rel).suffix.lower()
        if suffix in ('.py',):
            lang = 'python'
        elif suffix in ('.sh', '.bash'):
            lang = 'bash'
        else:
            lang = lang_tag or 'text'
        found.append({'path': rel, 'content': body, 'language': lang})
    if not found:
        return None

    # 入口：优先 main.py / main.sh，其次 run.py / run.sh，否则取第一个可执行文件
    paths = [f['path'] for f in found]
    entry = None
    preferences = ['main.py', 'main.sh', 'run.py', 'run.sh', 'app.py', 'index.py']
    for cand in preferences:
        if cand in paths:
            entry = cand
            break
    if not entry:
        for f in found:
            if f['language'] in ('python', 'bash'):
                entry = f['path']
                break
    if not entry:
        entry = found[0]['path']

    # 项目主语言：入口文件的语言
    project_lang = next((f['language'] for f in found if f['path'] == entry), default_language)
    if project_lang not in ('python', 'bash'):
        project_lang = default_language

    return {'files': found, 'entry': entry, 'language': project_lang}


def validate_project_files(files: List[Dict[str, str]]) -> Tuple[bool, List[str]]:
    """对每个 .py / .sh 文件跑 validate_syntax。返回 (all_ok, error_lines)。"""
    errors: List[str] = []
    for f in files:
        lang = (f.get('language') or '').lower()
        if lang not in ('python', 'bash'):
            continue
        ok, err = validate_syntax(f.get('content') or '', lang)
        if not ok:
            errors.append(f"❌ {f['path']} ({lang}):\n{err.rstrip()}")
    return (not errors), errors


# ============================================================
# 创建/读取/更新插件
# ============================================================
def generate_plugin_name(message: str) -> str:
    return f"plugin_{datetime.now().strftime('%Y%m%d_%H%M%S')}_{hashlib.md5(message.encode()).hexdigest()[:8]}"


def _write_run_sh(plugin_dir: Path, language: str) -> None:
    if language == 'bash':
        run_sh = '#!/bin/bash\ncd "$(dirname "$0")"\nbash main.sh "$@"\n'
    else:
        run_sh = (
            '#!/bin/bash\n'
            'cd "$(dirname "$0")"\n'
            '[ -f requirements.txt ] && pip install -q -r requirements.txt 2>/dev/null || true\n'
            'python3 main.py "$@"\n'
        )
    p = plugin_dir / "run.sh"
    p.write_text(run_sh, encoding='utf-8')
    os.chmod(p, 0o755)


def create_plugin(
    plugin_name: str,
    code: str = '',
    description: str = '',
    language: str = 'python',
    files: Optional[List[Dict[str, str]]] = None,
    entry: Optional[str] = None,
) -> Path:
    """创建插件目录。

    单文件模式：传 code + language，自动写入 main.py 或 main.sh。
    项目工程模式：传 files=[{path, content, language?}]，按相对路径写入多文件目录；
                  entry 指定入口文件名（默认 main.py / main.sh）。run.sh 仍以入口为准。

    language ∈ {'python', 'bash'}。
    """
    language = (language or 'python').lower()
    if language not in ('python', 'bash'):
        language = 'python'
    plugin_dir = PLUGINS_DIR / plugin_name
    plugin_dir.mkdir(exist_ok=True)
    (plugin_dir / "output").mkdir(exist_ok=True)

    file_list: List[str] = []
    if files:
        for f in files:
            rel = _safe_rel_path(f.get('path') or '')
            if not rel:
                continue
            full = plugin_dir / rel
            full.parent.mkdir(parents=True, exist_ok=True)
            full.write_text(f.get('content') or '', encoding='utf-8')
            if full.suffix in ('.sh', '.bash') or rel.endswith(('main.sh',)):
                try: os.chmod(full, 0o755)
                except Exception: pass
            file_list.append(rel)
        if not entry:
            for cand in ('main.py', 'main.sh', 'run.py', 'run.sh'):
                if cand in file_list:
                    entry = cand
                    break
            if not entry and file_list:
                entry = file_list[0]
        # 兜底：若用户没给 main.py/main.sh，把 entry 复制成 main.<ext> 以适配 run.sh 默认调用
        if entry and entry not in ('main.py', 'main.sh'):
            target = 'main.sh' if entry.endswith(('.sh', '.bash')) else 'main.py'
            (plugin_dir / target).write_text((plugin_dir / entry).read_text(encoding='utf-8'), encoding='utf-8')
            if target == 'main.sh':
                try: os.chmod(plugin_dir / target, 0o755)
                except Exception: pass
            file_list.append(target)
    else:
        # 兼容单文件入口
        if language == 'bash':
            main_path = plugin_dir / "main.sh"
            main_path.write_text(code, encoding='utf-8')
            os.chmod(main_path, 0o755)
            file_list.append('main.sh')
        else:
            main_path = plugin_dir / "main.py"
            main_path.write_text(code, encoding='utf-8')
            file_list.append('main.py')

    with open(plugin_dir / "plugin.json", "w", encoding="utf-8") as f:
        json.dump({
            "name": plugin_name,
            "description": description,
            "created_at": datetime.now().isoformat(),
            "version": "1.0",
            "language": language,
            "files": sorted(set(file_list)),
            "entry": entry or ('main.sh' if language == 'bash' else 'main.py'),
        }, f, ensure_ascii=False, indent=2)

    _write_run_sh(plugin_dir, language)
    return plugin_dir


def get_plugin_language(plugin_dir: Path) -> str:
    """返回插件的语言 'bash' | 'python'，缺省 python。"""
    j = plugin_dir / "plugin.json"
    if j.exists():
        try:
            with open(j, 'r', encoding='utf-8') as f:
                lang = (json.load(f).get("language") or '').lower()
                if lang in ('bash', 'python'):
                    return lang
        except Exception:
            pass
    if (plugin_dir / "main.sh").exists():
        return 'bash'
    return 'python'


def get_plugin_code(plugin_dir: Path) -> Tuple[str, str]:
    """返回 (code, language)。"""
    lang = get_plugin_language(plugin_dir)
    main = plugin_dir / ('main.sh' if lang == 'bash' else 'main.py')
    if main.exists():
        return main.read_text(encoding='utf-8'), lang
    # 老插件：仅有 main.py
    py = plugin_dir / 'main.py'
    if py.exists():
        return py.read_text(encoding='utf-8'), 'python'
    return '', lang


def update_plugin_main(plugin_dir: Path, code: str, language: Optional[str] = None) -> str:
    """更新主脚本。如果 language 与当前不同，会切换 main 文件类型并刷新 plugin.json + run.sh。
    返回最终 language。"""
    cur_lang = get_plugin_language(plugin_dir)
    target_lang = (language or cur_lang).lower()
    if target_lang not in ('bash', 'python'):
        target_lang = cur_lang

    if target_lang != cur_lang:
        # 切语言：删旧 main，写新 main，更新 plugin.json + run.sh
        for old in ('main.sh', 'main.py'):
            p = plugin_dir / old
            if p.exists():
                try: p.unlink()
                except Exception: pass
        info = {}
        j = plugin_dir / "plugin.json"
        if j.exists():
            try:
                with open(j, 'r', encoding='utf-8') as f:
                    info = json.load(f) or {}
            except Exception:
                info = {}
        info["language"] = target_lang
        with open(j, 'w', encoding='utf-8') as f:
            json.dump(info, f, ensure_ascii=False, indent=2)
        _write_run_sh(plugin_dir, target_lang)

    main_name = 'main.sh' if target_lang == 'bash' else 'main.py'
    main_path = plugin_dir / main_name
    main_path.write_text(code, encoding='utf-8')
    if target_lang == 'bash':
        os.chmod(main_path, 0o755)
    return target_lang


# ============================================================
# Sudo 自动注入
# ============================================================
_SUDO_RE = re.compile(r'(^|[\s;&|`(])sudo\b')


def _has_sudo(code: str) -> bool:
    return bool(_SUDO_RE.search(code or ''))


def _build_sudo_bash_wrapper(password: str) -> str:
    """生成 bash 脚本头部的 sudo 包装段。把密码以 base64 注入避免转义。"""
    if not password:
        return ''
    b64 = base64.b64encode(password.encode('utf-8')).decode('ascii')
    return (
        "# === autoinjected sudo wrapper (plugin_manager) ===\n"
        "__SUDO_PW_FILE__=\"$(mktemp)\"\n"
        "chmod 600 \"$__SUDO_PW_FILE__\"\n"
        "trap '[ -f \"$__SUDO_PW_FILE__\" ] && rm -f \"$__SUDO_PW_FILE__\"' EXIT\n"
        f"printf %s '{b64}' | base64 -d > \"$__SUDO_PW_FILE__\"\n"
        "sudo() { command sudo -S -p '' \"$@\" < \"$__SUDO_PW_FILE__\"; }\n"
        "export -f sudo 2>/dev/null || true\n"
        "# === end autoinjected sudo wrapper ===\n\n"
    )


def _write_sudo_askpass(plugin_dir: Path, password: str) -> Path:
    """为 python/外部子进程提供 SUDO_ASKPASS（配合 `sudo -A` 使用）。"""
    askpass = plugin_dir / ".sudo_askpass.sh"
    # 密码也用 base64 转义，免特殊字符问题
    b64 = base64.b64encode(password.encode('utf-8')).decode('ascii')
    askpass.write_text(
        '#!/bin/sh\n'
        f"printf %s '{b64}' | base64 -d\n",
        encoding='utf-8',
    )
    os.chmod(askpass, 0o700)
    return askpass


# ============================================================
# 执行
# ============================================================
def process_plugin_output(result: Dict, plugin_name: str) -> Dict:
    if isinstance(result.get("content"), list):
        for item in result["content"]:
            if (item.get("type") == "image" and item.get("data")
                    and not str(item["data"]).startswith("data:")
                    and not str(item["data"]).startswith("http")):
                item["data"] = f"/api/plugins/{plugin_name}/output/{Path(item['data']).name}"
    return result


def _parse_plugin_result(stdout: str, stderr: str, returncode: int, plugin_name: str) -> Dict:
    """从 stdout 中提取 ===PLUGIN_RESULT=== 行，没有则把 stdout/stderr 包成 text。"""
    plugin_result = None
    for line in (stdout or '').split('\n'):
        if line.startswith("===PLUGIN_RESULT==="):
            try:
                plugin_result = json.loads(line[len("===PLUGIN_RESULT==="):])
                break
            except json.JSONDecodeError:
                pass
    if plugin_result is None:
        if returncode == 0 and stdout.strip():
            plugin_result = {"type": "text", "content": stdout.strip()}
        else:
            err = (stderr or '').strip() or (stdout or '').strip() or '无输出'
            plugin_result = {
                "type": "mixed",
                "content": [
                    {"type": "status", "status": "error" if returncode != 0 else "info",
                     "message": err[-1000:]},
                ],
            }
    return process_plugin_output(plugin_result, plugin_name)


def _build_plugin_command(
    plugin_dir: Path,
    code: str,
    language: str,
    needs_sudo: bool,
    sudo_password: Optional[str],
    env: Dict[str, str],
    cleanup_paths: List[Path],
) -> List[str]:
    """构造 plugin 启动命令，并按需写入 sudo wrapper / askpass 临时文件。"""
    if language == 'bash':
        if needs_sudo and sudo_password:
            wrapper = _build_sudo_bash_wrapper(sudo_password)
            patched = plugin_dir / ".main.patched.sh"
            patched.write_text(wrapper + code, encoding='utf-8')
            os.chmod(patched, 0o700)
            cleanup_paths.append(patched)
            return ["bash", str(patched)]
        return ["bash", str(plugin_dir / "run.sh")]
    # python
    if needs_sudo and sudo_password:
        askpass = _write_sudo_askpass(plugin_dir, sudo_password)
        cleanup_paths.append(askpass)
        env["SUDO_ASKPASS"] = str(askpass)
    return ["bash", str(plugin_dir / "run.sh")]


def stream_execute_plugin(
    plugin_dir: Path,
    auto_install: bool = True,
    sudo_password: Optional[str] = None,
    timeout: int = 120,
    on_output: Optional[Callable[[str, str], None]] = None,
) -> Dict[str, Any]:
    """流式执行插件：用 Popen 启动子进程，开 2 个线程逐行读 stdout/stderr。
    每读到一行立即回调 `on_output(stream_name, text_line_with_newline)`。
    返回结构与原 `execute_plugin` 完全一致（成功/失败/result/stdout/stderr 等）。

    on_output 回调参数：
      - stream_name: 'stdout' | 'stderr'
      - text:        单行文本（保留末尾换行符方便前端按原样追加）
    回调不会跑 plugin_result（===PLUGIN_RESULT===）行——本函数会自动过滤。
    """
    code, language = get_plugin_code(plugin_dir)
    needs_sudo = _has_sudo(code)
    cleanup_paths: List[Path] = []
    env = {**os.environ, "PLUGIN_OUTPUT_DIR": str(plugin_dir / "output")}

    try:
        cmd = _build_plugin_command(plugin_dir, code, language, needs_sudo, sudo_password, env, cleanup_paths)

        try:
            proc = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                bufsize=1,  # 行缓冲
                cwd=str(plugin_dir),
                env=env,
            )
        except Exception as e:
            return {
                "success": False,
                "result": {"type": "mixed", "content": [
                    {"type": "status", "status": "error", "message": str(e)},
                ]},
                "plugin_name": plugin_dir.name,
                "language": language,
                "stdout": "",
                "stderr": str(e),
                "returncode": -1,
                "needs_sudo": needs_sudo,
            }

        stdout_chunks: List[str] = []
        stderr_chunks: List[str] = []

        def _pump(stream, sink: List[str], stream_name: str):
            try:
                for line in iter(stream.readline, ''):
                    if not line:
                        break
                    sink.append(line)
                    # 不把 ===PLUGIN_RESULT=== 那行回调给前端日志（避免噪声）
                    if on_output and not line.startswith("===PLUGIN_RESULT==="):
                        try:
                            on_output(stream_name, line)
                        except Exception:
                            pass
            finally:
                try: stream.close()
                except Exception: pass

        t_out = threading.Thread(target=_pump, args=(proc.stdout, stdout_chunks, 'stdout'), daemon=True)
        t_err = threading.Thread(target=_pump, args=(proc.stderr, stderr_chunks, 'stderr'), daemon=True)
        t_out.start(); t_err.start()

        try:
            returncode = proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            try: proc.kill()
            except Exception: pass
            t_out.join(timeout=2); t_err.join(timeout=2)
            timeout_msg = f"执行超时（{timeout}s），已强制结束"
            if on_output:
                try: on_output('stderr', f"\n[plugin runner] {timeout_msg}\n")
                except Exception: pass
            return {
                "success": False,
                "result": {"type": "mixed", "content": [
                    {"type": "status", "status": "error", "message": timeout_msg},
                ]},
                "plugin_name": plugin_dir.name,
                "language": language,
                "stdout": "".join(stdout_chunks)[-4000:],
                "stderr": ("".join(stderr_chunks) + f"\n[plugin runner] {timeout_msg}")[-4000:],
                "returncode": -1,
                "needs_sudo": needs_sudo,
            }

        t_out.join(timeout=2); t_err.join(timeout=2)
        stdout = "".join(stdout_chunks)
        stderr = "".join(stderr_chunks)
        plugin_result = _parse_plugin_result(stdout, stderr, returncode, plugin_dir.name)
        return {
            "success": returncode == 0,
            "result": plugin_result,
            "plugin_name": plugin_dir.name,
            "plugin_path": str(plugin_dir),
            "language": language,
            "stdout": stdout[-4000:],
            "stderr": stderr[-4000:],
            "returncode": returncode,
            "needs_sudo": needs_sudo,
            "sudo_injected": bool(needs_sudo and sudo_password),
        }
    finally:
        for p in cleanup_paths:
            try: p.unlink()
            except Exception: pass


def execute_plugin(
    plugin_dir: Path,
    auto_install: bool = True,
    sudo_password: Optional[str] = None,
    timeout: int = 120,
    on_output: Optional[Callable[[str, str], None]] = None,
) -> Dict[str, Any]:
    """非流式执行入口（向后兼容，新增可选 on_output 回调）。
    实际实现走 `stream_execute_plugin`：行级输出会被聚合到 stdout/stderr，
    如有回调则同步推送给上层。"""
    return stream_execute_plugin(
        plugin_dir,
        auto_install=auto_install,
        sudo_password=sudo_password,
        timeout=timeout,
        on_output=on_output,
    )
