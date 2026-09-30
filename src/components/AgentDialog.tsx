import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  X, Wand2, Loader2, ArrowRight, ArrowLeft, Play, RefreshCw,
  Sparkles, CheckCircle2, XCircle, Plus, Trash2, KeyRound, Zap,
  Minus, Maximize2, Minimize2, FileCode2, Square, ChevronUp, ChevronDown,
} from 'lucide-react';
import type { APIProvider } from '../types';

const MAX_AUTO_FIX = 3;

interface ProjectFile {
  path: string;
  content: string;
}

interface ProjectMeta {
  slug: string;
  dir: string;
  language: string;
  entry: string;
  runCmd: string;
  summary: string;
  deps: string[];
  execCommand: string;
}

// 匹配各种 sudo / su 密码提示（中文/英文/不同发行版/带用户名）
//   [sudo] password for yiye:
//   [sudo] yiye 的密码：
//   [sudo] 密码：
//   [sudo] passwort für yiye:
//   password for yiye:
//   Password:
//   口令：/ 密码：
const SUDO_PROMPT_RE =
  /(\[sudo\][^\n]{0,80}[:：]|password for\s+\S+\s*:|(?:^|\s)Password\s*:\s*$|(?:^|\s)(?:口令|密码)\s*[:：]\s*$)/im;

type Stage = 'goal' | 'plan' | 'script' | 'project' | 'run';

interface PlanStep {
  title: string;
  description: string;
}

type ParamType = 'text' | 'password' | 'number' | 'boolean' | 'select';

interface ParamDef {
  name: string;
  type: ParamType;
  label?: string;
  description?: string;
  default?: string;
  required?: boolean;
  options?: string[];
}

interface Props {
  visible: boolean;
  provider: APIProvider | null;
  initialGoal?: string;
  /** 'project'：多文件工程化代码工作流；'script'（默认）：单文件脚本工作流。 */
  mode?: 'script' | 'project';
  /** 打开后自动跑：计划 → 工程代码 → 执行（用于 auto-route 命中「代码编写」）。 */
  autoStart?: boolean;
  /** 将 AI 生成的工程提示词写回当前对话输入框。 */
  onInsertPrompt?: (text: string) => void;
  onClose: () => void;
}

export default function AgentDialog({ visible, provider, initialGoal, mode = 'script', autoStart = false, onInsertPrompt, onClose }: Props) {
  const [stage, setStage] = useState<Stage>('goal');
  const [goal, setGoal] = useState('');
  const [refinement, setRefinement] = useState('');
  const [steps, setSteps] = useState<PlanStep[]>([]);
  // 多文件工程化（project 模式）
  const [planLanguage, setPlanLanguage] = useState('');
  const [projectLanguage, setProjectLanguage] = useState('python');
  const [environment, setEnvironment] = useState('local-linux');
  const [promptLoading, setPromptLoading] = useState(false);
  const [generatedPrompt, setGeneratedPrompt] = useState('');
  const [projectFiles, setProjectFiles] = useState<ProjectFile[]>([]);
  const [projectMeta, setProjectMeta] = useState<ProjectMeta | null>(null);
  const [activeFile, setActiveFile] = useState('');
  const autoStartedRef = useRef(false);
  const isProject = mode === 'project';
  // 单步重生成：当前正在重生成的步骤索引、最近一次重生成的提示信息（小条幅）
  const [regeneratingIndex, setRegeneratingIndex] = useState<number | null>(null);
  const [stepReasons, setStepReasons] = useState<Record<number, string>>({});
  const [language, setLanguage] = useState<'bash' | 'python'>('bash');
  const [script, setScript] = useState('');
  const [parameters, setParameters] = useState<ParamDef[]>([]);
  const [paramValues, setParamValues] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [output, setOutput] = useState('');
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [running, setRunning] = useState(false);
  const [fixReason, setFixReason] = useState<string | null>(null);
  const [sudoPromptOpen, setSudoPromptOpen] = useState(false);
  const [sudoPwdInput, setSudoPwdInput] = useState('');
  const [sudoSubmitting, setSudoSubmitting] = useState(false);
  // 自动修复循环
  const [autoFix, setAutoFix] = useState(true);
  const [autoFixing, setAutoFixing] = useState(false);
  const [autoFixCount, setAutoFixCount] = useState(0);
  // 窗口模式：normal=居中浮窗；maximized=全屏；minimized=右下浮动小条（后台执行不打断）
  const [windowMode, setWindowMode] = useState<'normal' | 'maximized' | 'minimized'>('normal');
  const sessionRef = useRef<EventSource | null>(null);
  const sidRef = useRef<string | null>(null);
  const sudoLastTriggerRef = useRef(0); // 上次 sudo 注入时间戳，做节流
  const sudoFailCountRef = useRef(0); // 连续触发计数（保存的密码错了的话避免死循环）
  const autoFixCountRef = useRef(0);  // 当前一次手动启动后已经自动修复了多少次
  const autoFixInFlightRef = useRef(false); // 自动修复正在进行（防止重复触发）
  const outputRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null); // 当前在飞行中的 LLM 请求
  const stoppedRef = useRef(false); // 用户主动停止：阻断自动修复重跑

  // 开始一次新操作：清除"已停止"标记并建立可中断的 AbortController
  const beginOp = useCallback(() => {
    stoppedRef.current = false;
    const ac = new AbortController();
    abortRef.current = ac;
    return ac.signal;
  }, []);
  const isAbort = (e: any) => e?.name === 'AbortError';

  // 切换可见性时重置（每次点击 Wand2 都是一次新的 AI 工作流"对话"）
  useEffect(() => {
    if (visible) {
      // 关闭已有 session
      sessionRef.current?.close();
      sessionRef.current = null;
      sidRef.current = null;
      sudoLastTriggerRef.current = 0;
      sudoFailCountRef.current = 0;
      autoFixCountRef.current = 0;
      autoFixInFlightRef.current = false;
      try { abortRef.current?.abort(); } catch { /* noop */ }
      abortRef.current = null;
      stoppedRef.current = false;
      // 全部重置
      setStage('goal');
      setSteps([]);
      setLanguage('bash');
      setScript('');
      setParameters([]);
      setParamValues({});
      setOutput('');
      setExitCode(null);
      setRunning(false);
      setError(null);
      setFixReason(null);
      setSudoPromptOpen(false);
      setSudoPwdInput('');
      setRefinement('');
      setAutoFixing(false);
      setAutoFixCount(0);
      setRegeneratingIndex(null);
      setStepReasons({});
      setWindowMode('normal');
      setPlanLanguage('');
      setProjectLanguage('python');
      setEnvironment('local-linux');
      setPromptLoading(false);
      setGeneratedPrompt('');
      setProjectFiles([]);
      setProjectMeta(null);
      setActiveFile('');
      autoStartedRef.current = false;
      // 用聊天输入框的当前内容预填需求（用户也可手动改）
      setGoal((initialGoal || '').trim());
    } else {
      sessionRef.current?.close();
      sessionRef.current = null;
      autoStartedRef.current = false;
      try { abortRef.current?.abort(); } catch { /* noop */ }
      abortRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // 自动滚动输出到底部
  useEffect(() => {
    if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [output]);

  const resetAll = useCallback(() => {
    sessionRef.current?.close();
    sessionRef.current = null;
    sidRef.current = null;
    sudoLastTriggerRef.current = 0;
    sudoFailCountRef.current = 0;
    autoFixCountRef.current = 0;
    autoFixInFlightRef.current = false;
    try { abortRef.current?.abort(); } catch { /* noop */ }
    abortRef.current = null;
    stoppedRef.current = false;
    setStage('goal');
    setGoal('');
    setSteps([]);
    setLanguage('bash');
    setScript('');
    setParameters([]);
    setParamValues({});
    setOutput('');
    setExitCode(null);
    setRunning(false);
    setError(null);
    setFixReason(null);
    setSudoPromptOpen(false);
    setSudoPwdInput('');
    setAutoFixing(false);
    setAutoFixCount(0);
    setRegeneratingIndex(null);
    setStepReasons({});
    setProjectLanguage('python');
    setEnvironment('local-linux');
    setPromptLoading(false);
    setGeneratedPrompt('');
  }, []);

  // ========== 停止：中断当前执行 / LLM 调用，并阻断自动修复重跑 ==========
  const handleStop = useCallback(async () => {
    stoppedRef.current = true;
    // 阻止自动修复 effect 再次触发
    autoFixInFlightRef.current = true;
    autoFixCountRef.current = MAX_AUTO_FIX;
    // 中断在飞行中的 LLM 请求（计划 / 工程 / 修复 / 细化等）
    try { abortRef.current?.abort(); } catch { /* noop */ }
    abortRef.current = null;
    // 关闭输出流
    try { sessionRef.current?.close(); } catch { /* noop */ }
    sessionRef.current = null;
    // 杀掉后端执行会话
    const sid = sidRef.current;
    sidRef.current = null;
    if (sid) {
      try {
        await fetch('/api/run-code-kill', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: sid }),
        });
      } catch { /* noop */ }
    }
    setRunning(false);
    setAutoFixing(false);
    setLoading(false);
    setRegeneratingIndex(null);
    setSudoPromptOpen(false);
    setOutput(prev => prev + '\n\n⏹ 已停止（用户中断）\n');
  }, []);

  // 检测到 sudo 提示后的自动处理：
  //   - 4 秒节流避免同一行 prompt 触发多次
  //   - 累计 2 次失败（说明保存的密码错了）→ 强制弹窗收集
  //   - 已弹窗时不再尝试自动注入
  const handleSudoPrompt = useCallback(async () => {
    const sid = sidRef.current;
    if (!sid) return;
    const now = Date.now();
    if (now - sudoLastTriggerRef.current < 4000) return; // 节流
    sudoLastTriggerRef.current = now;

    if (sudoPromptOpen) return; // 已经在让用户输入

    if (sudoFailCountRef.current >= 2) {
      // 连续 2 次仍提示，说明已保存的密码无效；交给用户重新输入
      setSudoPromptOpen(true);
      return;
    }

    try {
      const r = await fetch('/api/run-code-inject-sudo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sid }),
      });
      if (r.ok) {
        sudoFailCountRef.current += 1;
        return;
      }
      // saved=false 或其他错 → 弹窗
      setSudoPromptOpen(true);
    } catch {
      setSudoPromptOpen(true);
    }
  }, [sudoPromptOpen]);

  // 用户在密码弹框提交：保存到后端 + 注入到当前会话
  const handleSubmitSudoPwd = useCallback(async () => {
    const sid = sidRef.current;
    const pwd = sudoPwdInput;
    if (!sid || !pwd) return;
    setSudoSubmitting(true);
    try {
      await fetch('/api/sudo-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pwd }),
      });
      await fetch('/api/run-code-input', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sid, input: pwd }),
      });
      sudoFailCountRef.current = 0; // 用户主动输入新密码，重置计数
      sudoLastTriggerRef.current = Date.now();
      setSudoPwdInput('');
      setSudoPromptOpen(false);
    } catch (e: any) {
      setError(e?.message || '保存/注入密码失败');
    } finally {
      setSudoSubmitting(false);
    }
  }, [sudoPwdInput]);

  const ensureProvider = () => {
    if (!provider) {
      setError('请先在侧边栏选择一个 Provider');
      return false;
    }
    return true;
  };

  // ========== Stage 1 → 2: 生成步骤（返回结果，便于 autoStart 串联） ==========
  const doPlan = useCallback(async (goalArg: string): Promise<{ steps: PlanStep[]; language: string } | null> => {
    if (!goalArg.trim() || !provider) {
      if (!provider) setError('请先在侧边栏选择一个 Provider');
      return null;
    }
    setLoading(true);
    setError(null);
    const signal = beginOp();
    try {
      const res = await fetch('/api/agent/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify({
          message: goalArg.trim(),
          environment,
          language: isProject ? projectLanguage : undefined,
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKey,
          model: provider.selectedModel,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `规划失败 (${res.status})`);
      const newSteps: PlanStep[] = Array.isArray(data.steps) && data.steps.length ? data.steps : [];
      const lang = (data.language || '') as string;
      setSteps(newSteps);
      setPlanLanguage(lang);
      // 单脚本工作流仅支持 bash/python；采用规划阶段推荐语言，避免初始 bash 覆盖 Python 计划。
      if (!isProject && lang) {
        setLanguage(lang === 'bash' || lang === 'sh' ? 'bash' : 'python');
      }
      setStage('plan');
      return { steps: newSteps, language: lang };
    } catch (e: any) {
      if (isAbort(e) || stoppedRef.current) return null;
      setError(e?.message || '规划失败');
      return null;
    } finally {
      setLoading(false);
    }
  }, [provider, beginOp, environment, isProject, projectLanguage]);

  const handleGeneratePlan = () => { void doPlan(goal); };

  // ========== project 模式：生成多文件工程（返回结果） ==========
  const doProject = useCallback(async (
    goalArg: string, stepsArg: PlanStep[], langArg: string,
  ): Promise<ProjectMeta | null> => {
    if (!provider) { setError('请先在侧边栏选择一个 Provider'); return null; }
    setLoading(true);
    setError(null);
    setFixReason(null);
    const signal = beginOp();
    try {
      const res = await fetch('/api/agent/project', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify({
          message: goalArg,
          steps: stepsArg,
          language: langArg || projectLanguage,
          environment,
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKey,
          model: provider.selectedModel,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `工程生成失败 (${res.status})`);
      const files: ProjectFile[] = Array.isArray(data.files) ? data.files : [];
      const meta: ProjectMeta = {
        slug: data.slug || '',
        dir: data.dir || '',
        language: data.language || langArg || 'python',
        entry: data.entry || '',
        runCmd: data.run_cmd || '',
        summary: data.summary || '',
        deps: Array.isArray(data.deps) ? data.deps : [],
        execCommand: data.exec_command || '',
      };
      setProjectFiles(files);
      setProjectMeta(meta);
      setActiveFile(meta.entry || files[0]?.path || '');
      if (data.truncated) setFixReason('⚠ 模型输出过长可能被截断，请检查文件是否完整。');
      setStage('project');
      return meta;
    } catch (e: any) {
      if (isAbort(e) || stoppedRef.current) return null;
      setError(e?.message || '工程生成失败');
      return null;
    } finally {
      setLoading(false);
    }
  }, [provider, beginOp, environment, projectLanguage]);

  const handleGenerateProject = () => { void doProject(goal, steps, projectLanguage || planLanguage); };

  const handleGeneratePrompt = useCallback(async () => {
    if (!provider || !goal.trim()) return;
    setPromptLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/agent/prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: goal.trim(),
          environment,
          language: projectLanguage,
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKey,
          model: provider.selectedModel,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error || `提示词生成失败 (${response.status})`);
      const prompt = String(data?.prompt || '').trim();
      if (!prompt) throw new Error('模型没有返回提示词');
      setGeneratedPrompt(prompt);
      onInsertPrompt?.(prompt);
    } catch (e: any) {
      setError(e?.message || '提示词生成失败');
    } finally {
      setPromptLoading(false);
    }
  }, [environment, goal, onInsertPrompt, projectLanguage, provider]);

  // project 模式执行：复用 executeScript，把 exec_command 当作 bash 脚本跑
  const handleExecuteProject = useCallback(async (metaArg?: ProjectMeta) => {
    const meta = metaArg || projectMeta;
    if (!meta?.execCommand) return;
    autoFixCountRef.current = 0;
    autoFixInFlightRef.current = false;
    setAutoFixCount(0);
    setAutoFixing(false);
    await executeScript(meta.execCommand, 'bash', [], {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectMeta]);

  // ========== Stage 2: 单步重生成（用户改写 + AI 改写） ==========
  const handleRegenerateStep = useCallback(async (index: number, hint: string) => {
    if (!provider) {
      setError('请先在侧边栏选择一个 Provider');
      return;
    }
    if (index < 0 || index >= steps.length) return;
    setRegeneratingIndex(index);
    setError(null);
    const signal = beginOp();
    try {
      const res = await fetch('/api/agent/refine-step', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify({
          message: goal,
          steps,
          index,
          hint,
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKey,
          model: provider.selectedModel,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `重生成失败 (${res.status})`);
      const newTitle = (data.title || '').trim();
      const newDesc = (data.description || '').trim();
      setSteps(prev => prev.map((s, i) =>
        i === index ? { title: newTitle || s.title, description: newDesc || s.description } : s
      ));
      setStepReasons(prev => ({ ...prev, [index]: data.reason || '已根据你的提示重写本步' }));
    } catch (e: any) {
      if (isAbort(e) || stoppedRef.current) return;
      setError(e?.message || '重生成失败');
    } finally {
      setRegeneratingIndex(null);
    }
  }, [provider, goal, steps, beginOp]);

  // ========== Stage 2 → 3: 生成脚本 + 参数 ==========
  const handleGenerateScript = async () => {
    if (!steps.length || !ensureProvider()) return;
    setLoading(true);
    setError(null);
    setFixReason(null);
    const signal = beginOp();
    try {
      const res = await fetch('/api/agent/script', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify({
          message: goal,
          steps,
          language,
          baseUrl: provider!.baseUrl,
          apiKey: provider!.apiKey,
          model: provider!.selectedModel,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `脚本生成失败 (${res.status})`);
      setLanguage((data.language || 'bash') as 'bash' | 'python');
      setScript(data.script || '');
      const params: ParamDef[] = Array.isArray(data.parameters) ? data.parameters : [];
      setParameters(params);
      const initial: Record<string, string> = {};
      for (const p of params) {
        if (p.type === 'boolean') initial[p.name] = (p.default === '1' || p.default === 'true') ? '1' : '0';
        else initial[p.name] = p.default ?? '';
      }
      setParamValues(initial);
      const notes: string[] = [];
      if (data.truncated) {
        notes.push('⚠ 模型本次输出过长，自动续写多轮后仍未完成。请检查脚本末尾是否完整；如有缺失可点「AI 修复」或在下方"细化"框中描述继续要求。');
      }
      const v = data.validation;
      if (v && typeof v === 'object') {
        if (v.fixed) {
          notes.push('✓ 已自动修复一处语法错误。原始错误：\n' + (v.previous_error || '(略)').slice(0, 400));
        } else if (v.ok === false) {
          notes.push('⚠ 语法检查未通过（已尝试自动修复但仍失败），运行可能会出错：\n' + (v.error || '').slice(0, 400));
        } else if (v.ok === true) {
          // 通过：不打扰用户
        }
      }
      if (notes.length > 0) setFixReason(notes.join('\n\n'));
      setStage('script');
    } catch (e: any) {
      if (isAbort(e) || stoppedRef.current) return;
      setError(e?.message || '脚本生成失败');
    } finally {
      setLoading(false);
    }
  };

  // ========== Stage 3 → 4: 执行脚本 ==========
  // 真正的执行逻辑，参数全部显式传入（不依赖闭包里的 state，便于自动修复后立刻重跑）
  const executeScript = useCallback(async (
    scriptToRun: string,
    langToRun: 'bash' | 'python',
    paramsToCheck: ParamDef[],
    envValues: Record<string, string>,
    opts?: { reason?: string },
  ) => {
    if (!scriptToRun.trim()) return;
    // 校验必填
    for (const p of paramsToCheck) {
      if (p.required && !((envValues[p.name] ?? '').toString().length)) {
        setError(`参数「${p.label || p.name}」必填`);
        return;
      }
    }
    setStage('run');
    // 自动修复重跑时保留之前的 output（拼接前缀），首次手动执行清空
    if (opts?.reason) {
      setOutput(prev => prev + `\n\n────────── ${opts.reason} ──────────\n`);
    } else {
      setOutput('');
    }
    setExitCode(null);
    setError(null);
    setRunning(true);
    setAutoFixing(false);
    setSudoPromptOpen(false);
    sudoLastTriggerRef.current = 0;
    sudoFailCountRef.current = 0;

    sessionRef.current?.close();
    sessionRef.current = null;
    sidRef.current = null;

    const signal = beginOp();
    try {
      const startRes = await fetch('/api/run-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify({
          code: scriptToRun,
          language: langToRun,
          interactive: true,
          env: envValues,
          timeoutSeconds: 120,
        }),
      });
      const startData = await startRes.json();
      if (!startRes.ok) throw new Error(startData?.error || `执行失败 (${startRes.status})`);
      const sid = startData?.session_id;
      if (!sid) {
        // 非交互模式（PTY 不可用时）
        setOutput(prev => prev + (startData.output || ''));
        setExitCode(typeof startData.exit_code === 'number' ? startData.exit_code : 1);
        setRunning(false);
        return;
      }
      sidRef.current = sid;
      const es = new EventSource(`/api/run-code-stream/${encodeURIComponent(sid)}`);
      sessionRef.current = es;
      let outBuf = '';
      es.onmessage = (e) => {
        try {
          const obj = JSON.parse(e.data);
          if (obj.type === 'out') {
            const text = obj.text || '';
            outBuf += text;
            setOutput(prev => prev + text);
            // 在最近 600 字符里检测 sudo 提示（节流由 handleSudoPrompt 内部控制）
            if (SUDO_PROMPT_RE.test(outBuf.slice(-600))) {
              handleSudoPrompt();
            }
          } else if (obj.type === 'exit') {
            setExitCode(typeof obj.exit_code === 'number' ? obj.exit_code : -1);
            setRunning(false);
            es.close();
            sessionRef.current = null;
          }
        } catch {}
      };
      es.onerror = () => {
        es.close();
        sessionRef.current = null;
        setRunning(false);
      };
    } catch (e: any) {
      if (isAbort(e) || stoppedRef.current) {
        setRunning(false);
        return;
      }
      setError(e?.message || '执行失败');
      setRunning(false);
    }
  }, [handleSudoPrompt, beginOp]);

  const handleExecute = useCallback(async () => {
    // 用户主动点「执行」→ 重置自动修复计数（开启新一轮循环）
    autoFixCountRef.current = 0;
    autoFixInFlightRef.current = false;
    setAutoFixCount(0);
    setAutoFixing(false);
    await executeScript(script, language, parameters, paramValues);
  }, [script, language, parameters, paramValues, executeScript]);

  // ========== project 模式：按后续提示词修订工程（修改方案 + 重写代码） ==========
  const handleRefineProject = useCallback(async () => {
    if (!provider) { setError('请先在侧边栏选择一个 Provider'); return; }
    if (!projectMeta || !refinement.trim()) return;
    setLoading(true);
    setError(null);
    const signal = beginOp();
    try {
      const res = await fetch('/api/agent/refine-project', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify({
          message: goal,
          slug: projectMeta.slug,
          language: projectMeta.language,
          files: projectFiles,
          refinement: refinement.trim(),
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKey,
          model: provider.selectedModel,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `修订失败 (${res.status})`);
      const files: ProjectFile[] = Array.isArray(data.files) ? data.files : projectFiles;
      const meta: ProjectMeta = {
        slug: data.slug || projectMeta.slug,
        dir: data.dir || projectMeta.dir,
        language: data.language || projectMeta.language,
        entry: data.entry || projectMeta.entry,
        runCmd: data.run_cmd || projectMeta.runCmd,
        summary: data.summary || '',
        deps: Array.isArray(data.deps) ? data.deps : projectMeta.deps,
        execCommand: data.exec_command || projectMeta.execCommand,
      };
      setProjectFiles(files);
      setProjectMeta(meta);
      setActiveFile(meta.entry || files[0]?.path || '');
      setFixReason(data.reason || '已根据你的新需求重写工程');
      setRefinement('');
      setExitCode(null);
      setOutput('');
      setStage('project');
    } catch (e: any) {
      if (isAbort(e) || stoppedRef.current) return;
      setError(e?.message || '修订失败');
    } finally {
      setLoading(false);
    }
  }, [provider, projectMeta, projectFiles, goal, refinement, beginOp]);

  // ========== 执行后基于结果细化（成功或失败均可用，用户给出新指令） ==========
  const handleRefine = async () => {
    if (isProject) { await handleRefineProject(); return; }
    if (!ensureProvider() || !refinement.trim()) return;
    setLoading(true);
    setError(null);
    const signal = beginOp();
    try {
      const res = await fetch('/api/agent/refine', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify({
          message: goal,
          script,
          language,
          parameters,
          output,
          exitCode,
          refinement: refinement.trim(),
          baseUrl: provider!.baseUrl,
          apiKey: provider!.apiKey,
          model: provider!.selectedModel,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `迭代失败 (${res.status})`);
      setLanguage((data.language || language) as 'bash' | 'python');
      setScript(data.script || script);
      const params: ParamDef[] = Array.isArray(data.parameters) ? data.parameters : parameters;
      setParameters(params);
      setParamValues(prev => {
        const next: Record<string, string> = {};
        for (const p of params) {
          if (p.name in prev) next[p.name] = prev[p.name];
          else if (p.type === 'boolean') next[p.name] = (p.default === '1' || p.default === 'true') ? '1' : '0';
          else next[p.name] = p.default ?? '';
        }
        return next;
      });
      setFixReason(
        (data.truncated ? '⚠ 模型本次输出过长且自动续写后仍未完成，请检查脚本末尾是否完整。\n' : '') +
        (data.reason || '已基于你的细化指令重新生成脚本')
      );
      setRefinement('');
      setExitCode(null);
      setOutput('');
      setStage('script');
    } catch (e: any) {
      if (isAbort(e) || stoppedRef.current) return;
      setError(e?.message || '迭代失败');
    } finally {
      setLoading(false);
    }
  };

  // ========== 失败时让 AI 修复（auto=true 时是自动循环触发，会自动重跑脚本） ==========
  const handleAiFix = useCallback(async (auto: boolean = false) => {
    if (!provider) {
      setError('请先在侧边栏选择一个 Provider');
      return;
    }
    if (exitCode == null || exitCode === 0) return;
    if (autoFixInFlightRef.current) return; // 防重复
    autoFixInFlightRef.current = true;
    setLoading(true);
    setError(null);
    const fixHeader = auto
      ? `\n\n========== AI 自动修复 · 第 ${autoFixCountRef.current + 1}/${MAX_AUTO_FIX} 次 ==========\n`
      : `\n\n========== AI 手动修复 ==========\n`;
    setOutput(prev => prev + fixHeader + `[1/3] 正在打包失败上下文（脚本、参数、exit code、最后 ~4000 字输出）发送给 LLM...\n`);
    const fixStartedAt = Date.now();
    if (auto) setAutoFixing(true);

    const signal = beginOp();
    try {
      setOutput(prev => prev + `[2/3] 已发送，等待 LLM 返回修复后的脚本...\n`);
      const res = await fetch('/api/agent/fix', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify({
          message: goal,
          script,
          language,
          parameters,
          output,
          exitCode,
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKey,
          model: provider.selectedModel,
        }),
      });
      const data = await res.json();
      const elapsed = ((Date.now() - fixStartedAt) / 1000).toFixed(1);
      if (!res.ok) {
        setOutput(prev => prev + `[!] LLM 修复失败：${data?.error || res.status}（耗时 ${elapsed}s）\n`);
        throw new Error(data?.error || `修复失败 (${res.status})`);
      }
      const newLang = (data.language || language) as 'bash' | 'python';
      const newScript = data.script || script;
      const newParams: ParamDef[] = Array.isArray(data.parameters) ? data.parameters : parameters;
      // 合并参数值（保留用户已填）
      const mergedValues: Record<string, string> = {};
      for (const p of newParams) {
        if (p.name in paramValues) mergedValues[p.name] = paramValues[p.name];
        else if (p.type === 'boolean') mergedValues[p.name] = (p.default === '1' || p.default === 'true') ? '1' : '0';
        else mergedValues[p.name] = p.default ?? '';
      }
      setLanguage(newLang);
      setScript(newScript);
      setParameters(newParams);
      setParamValues(mergedValues);
      const reason = (data.truncated ? '⚠ 模型本次输出过长且自动续写后仍未完成，请检查脚本末尾是否完整。\n' : '')
        + (data.reason || '已根据错误信息修复脚本');
      setFixReason(reason);

      const newLines = (newScript || '').split('\n').length;
      const truncWarn = data.truncated ? '（⚠ 输出被截断，已尝试自动续写）' : '';
      setOutput(prev => prev +
        `[3/3] 收到新脚本：${newLang}，${newLines} 行${truncWarn}（LLM 耗时 ${elapsed}s）\n` +
        `修复说明: ${data.reason || '(无)'}\n` +
        (auto ? `=> 将自动重新执行脚本，日志见下方。\n` : `=> 跳回脚本编辑页，请审阅后再执行。\n`)
      );

      if (auto) {
        autoFixCountRef.current += 1;
        setAutoFixCount(autoFixCountRef.current);
        await executeScript(newScript, newLang, newParams, mergedValues, {
          reason: `自动修复重跑 (#${autoFixCountRef.current}/${MAX_AUTO_FIX}): ${reason}`,
        });
      } else {
        setStage('script');
      }
    } catch (e: any) {
      if (isAbort(e) || stoppedRef.current) { setAutoFixing(false); return; }
      setError(e?.message || '修复失败');
      setAutoFixing(false);
    } finally {
      setLoading(false);
      autoFixInFlightRef.current = false;
    }
  }, [provider, exitCode, goal, script, language, parameters, paramValues, output, executeScript, beginOp]);

  // ========== project 模式：失败 → 调 fix-project 重写文件 → 重跑（最多 N 次） ==========
  const handleFixProject = useCallback(async (auto: boolean = false) => {
    if (!provider) { setError('请先在侧边栏选择一个 Provider'); return; }
    if (!projectMeta) return;
    if (exitCode == null || exitCode === 0) return;
    if (autoFixInFlightRef.current) return;
    autoFixInFlightRef.current = true;
    setLoading(true);
    setError(null);
    const header = auto
      ? `\n\n========== AI 自动修复工程 · 第 ${autoFixCountRef.current + 1}/${MAX_AUTO_FIX} 次 ==========\n`
      : `\n\n========== AI 手动修复工程 ==========\n`;
    setOutput(prev => prev + header + '正在发送失败上下文（项目文件 + exit code + 输出）给 LLM...\n');
    if (auto) setAutoFixing(true);
    const signal = beginOp();
    try {
      const res = await fetch('/api/agent/fix-project', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify({
          message: goal,
          slug: projectMeta.slug,
          language: projectMeta.language,
          files: projectFiles,
          output,
          exitCode,
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKey,
          model: provider.selectedModel,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `修复失败 (${res.status})`);
      const files: ProjectFile[] = Array.isArray(data.files) ? data.files : projectFiles;
      const meta: ProjectMeta = {
        slug: data.slug || projectMeta.slug,
        dir: data.dir || projectMeta.dir,
        language: data.language || projectMeta.language,
        entry: data.entry || projectMeta.entry,
        runCmd: data.run_cmd || projectMeta.runCmd,
        summary: data.summary || '',
        deps: Array.isArray(data.deps) ? data.deps : projectMeta.deps,
        execCommand: data.exec_command || projectMeta.execCommand,
      };
      setProjectFiles(files);
      setProjectMeta(meta);
      setActiveFile(meta.entry || files[0]?.path || '');
      setFixReason(data.reason || '已根据错误修复项目');
      setOutput(prev => prev + `收到修复后的工程（${files.length} 个文件）。${auto ? '将自动重跑。' : '请审阅后执行。'}\n`);
      if (auto) {
        autoFixCountRef.current += 1;
        setAutoFixCount(autoFixCountRef.current);
        await executeScript(meta.execCommand, 'bash', [], {}, {
          reason: `自动修复重跑 (#${autoFixCountRef.current}/${MAX_AUTO_FIX}): ${data.reason || ''}`,
        });
      } else {
        setStage('project');
      }
    } catch (e: any) {
      if (isAbort(e) || stoppedRef.current) { setAutoFixing(false); return; }
      setError(e?.message || '修复失败');
      setAutoFixing(false);
    } finally {
      setLoading(false);
      autoFixInFlightRef.current = false;
    }
  }, [provider, projectMeta, projectFiles, exitCode, goal, output, executeScript, beginOp]);

  // ========== 自动修复触发器：脚本失败 → 自动调 AI 修复 → 重跑（最多 N 次） ==========
  useEffect(() => {
    if (stoppedRef.current) return; // 用户已停止：不再自动修复重跑
    if (!autoFix) return;
    if (running) return;
    if (loading) return;
    if (exitCode == null || exitCode === 0) return;
    if (sudoPromptOpen) return; // 等用户输 sudo 密码时不自动修复
    if (autoFixInFlightRef.current) return;
    if (autoFixCountRef.current >= MAX_AUTO_FIX) return;
    if (!provider) return;
    if (stage !== 'run') return;
    // 异步触发，避免在 effect 内 await
    void (isProject ? handleFixProject(true) : handleAiFix(true));
  }, [autoFix, running, loading, exitCode, sudoPromptOpen, provider, stage, isProject, handleAiFix, handleFixProject]);

  // ========== autoStart：打开后自动串联 计划 → 工程代码 → 执行 ==========
  useEffect(() => {
    if (!visible || !autoStart || !isProject) return;
    if (autoStartedRef.current) return;
    if (!provider) return;
    const g = (initialGoal || '').trim();
    if (!g) return;
    autoStartedRef.current = true;
    (async () => {
      const p = await doPlan(g);
      if (!p || stoppedRef.current) return;
      const meta = await doProject(g, p.steps, p.language);
      if (!meta || stoppedRef.current) return;
      await handleExecuteProject(meta);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, autoStart, isProject, provider]);

  // 是否有"未完成"的工作 → 决定关闭时是否需要二次确认，以及最小化条上的状态展示
  const isBusy = running || loading || autoFixing || regeneratingIndex != null;

  const statusInfo = useMemo(() => {
    if (running) return { color: 'text-yellow-300', dot: 'bg-yellow-400 animate-pulse', label: '执行中' };
    if (autoFixing) return { color: 'text-amber-300', dot: 'bg-amber-400 animate-pulse', label: `AI 修复 ${autoFixCount + 1}/${MAX_AUTO_FIX}` };
    if (loading) return { color: 'text-purple-300', dot: 'bg-purple-400 animate-pulse', label: 'LLM 调用中' };
    if (regeneratingIndex != null) return { color: 'text-purple-300', dot: 'bg-purple-400 animate-pulse', label: `重写第 ${regeneratingIndex + 1} 步` };
    if (exitCode === 0) return { color: 'text-emerald-300', dot: 'bg-emerald-400', label: '执行成功' };
    if (exitCode != null && exitCode !== 0) return { color: 'text-red-300', dot: 'bg-red-400', label: `执行失败 (exit ${exitCode})` };
    const stageLabel: Record<Stage, string> = { goal: '描述需求', plan: '规划步骤', script: '编辑脚本', project: '生成工程', run: '准备执行' };
    return { color: 'text-gray-400', dot: 'bg-gray-500', label: stageLabel[stage] };
  }, [running, autoFixing, loading, regeneratingIndex, exitCode, stage, autoFixCount]);

  const handleCloseClick = useCallback(() => {
    if (isBusy) {
      const yes = window.confirm(
        '当前还有任务正在执行（LLM 调用 / 脚本执行 / 自动修复）。\n\n' +
        '关闭会立即中断这些任务。\n建议改用「最小化」让它在后台继续运行。\n\n' +
        '确认强制关闭吗？'
      );
      if (!yes) return;
    }
    setWindowMode('normal');
    onClose();
  }, [isBusy, onClose]);

  if (!visible) return null;

  // ===== 最小化：折叠成右下角浮动小条；EventSource / fetch 持续运行 =====
  if (windowMode === 'minimized') {
    return (
      <div className="fixed bottom-4 right-4 z-50 select-none">
        <div
          className="bg-gray-900/95 backdrop-blur border border-purple-500/40 rounded-full shadow-2xl flex items-center gap-2 pl-3 pr-1 py-1.5 cursor-pointer hover:border-purple-400 hover:shadow-purple-500/20 transition-all"
          onClick={() => setWindowMode('normal')}
          title="点击展开 AI 工作流（后台仍在执行）"
        >
          <Wand2 size={13} className="text-purple-300" />
          <span className="text-xs text-white font-medium">AI 工作流</span>
          <span className={`flex items-center gap-1 text-[11px] ${statusInfo.color}`}>
            <span className={`inline-block w-1.5 h-1.5 rounded-full ${statusInfo.dot}`} />
            {statusInfo.label}
          </span>
          {autoFixCount > 0 && exitCode !== 0 && (
            <span className="text-[10px] text-gray-500">· 已修复 {autoFixCount} 次</span>
          )}
          {isBusy && (
            <button
              onClick={(e) => { e.stopPropagation(); void handleStop(); }}
              className="p-1 rounded-full text-red-300 hover:text-white hover:bg-red-700/60"
              title="停止执行"
            >
              <Square size={10} className="fill-current" />
            </button>
          )}
          <button
            onClick={(e) => { e.stopPropagation(); setWindowMode('normal'); }}
            className="p-1 rounded-full text-gray-400 hover:text-white hover:bg-gray-700/70"
            title="还原"
          >
            <Maximize2 size={11} />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); handleCloseClick(); }}
            className="p-1 rounded-full text-gray-400 hover:text-white hover:bg-red-700/50"
            title="关闭并中断"
          >
            <X size={11} />
          </button>
        </div>
      </div>
    );
  }

  const isMax = windowMode === 'maximized';
  const containerClass = isMax
    ? 'fixed inset-0 bg-black/60 z-50 flex p-0'
    : 'fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4';
  const panelClass = isMax
    ? 'bg-gray-900 border border-gray-700 w-full h-full flex flex-col shadow-2xl'
    : 'bg-gray-900 border border-gray-700 rounded-xl w-full max-w-3xl h-[88dvh] flex flex-col shadow-2xl';

  return (
    <div className={containerClass}>
      <div className={panelClass}>
        {/* Header */}
        <div className="px-5 py-3.5 border-b border-gray-700 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <Wand2 size={18} className="text-purple-400 shrink-0" />
            <h2 className="text-base font-semibold text-white shrink-0">AI 工作流</h2>
            <StageIndicator current={stage} isProject={isProject} />
            {isBusy && (
              <span className={`hidden sm:flex items-center gap-1 text-[11px] ${statusInfo.color} ml-2 px-2 py-0.5 rounded-full bg-gray-800/80`}>
                <span className={`inline-block w-1.5 h-1.5 rounded-full ${statusInfo.dot}`} />
                {statusInfo.label}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {isBusy && (
              <button
                onClick={() => { void handleStop(); }}
                className="flex items-center gap-1 mr-1 px-2 py-1 rounded text-xs font-medium bg-red-600/90 hover:bg-red-600 text-white transition-colors"
                title="停止当前执行 / LLM 调用"
              >
                <Square size={11} className="fill-current" />
                停止
              </button>
            )}
            <button onClick={resetAll} className="p-1.5 rounded text-gray-400 hover:text-white hover:bg-gray-700" title="重新开始">
              <RefreshCw size={14} />
            </button>
            <button
              onClick={() => setWindowMode('minimized')}
              className="p-1.5 rounded text-gray-400 hover:text-white hover:bg-gray-700"
              title="最小化（后台继续执行）"
            >
              <Minus size={14} />
            </button>
            <button
              onClick={() => setWindowMode(isMax ? 'normal' : 'maximized')}
              className="p-1.5 rounded text-gray-400 hover:text-white hover:bg-gray-700"
              title={isMax ? '还原' : '最大化'}
            >
              {isMax ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
            </button>
            <button
              onClick={handleCloseClick}
              className={`p-1.5 rounded text-gray-400 hover:text-white hover:bg-gray-700 ${isBusy ? 'hover:bg-red-700/40' : ''}`}
              title={isBusy ? '关闭（会中断后台任务）' : '关闭'}
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className={`flex-1 min-h-0 px-5 py-4 text-sm text-gray-200 ${
          stage === 'script' || stage === 'run'
            ? 'flex flex-col gap-4 overflow-hidden'
            : 'overflow-y-auto space-y-4'
        }`}>
          {error && (
            <div className="bg-red-900/40 border border-red-500/40 text-red-200 rounded-lg px-3 py-2 text-xs whitespace-pre-wrap">
              {error}
            </div>
          )}
          {!provider && (
            <div className="bg-amber-900/40 border border-amber-500/40 text-amber-200 rounded-lg px-3 py-2 text-xs">
              请先在侧边栏选择一个 Provider 与模型，然后再使用工作流。
            </div>
          )}

          {stage === 'goal' && (
            <div className="space-y-3">
              <label className="block text-xs uppercase tracking-wider text-gray-500">描述你想做的事（任务目标）</label>
              <textarea
                value={goal}
                onChange={e => setGoal(e.target.value)}
                placeholder={isProject
                  ? '例如：创建一个带登录和数据持久化的 Web 项目，完成基本测试并给出启动命令…'
                  : '例如：把当前目录下所有 PNG 图片压缩 70% 后保存到 ./out 目录；或者：批量重命名一组文件…'}
                rows={6}
                className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-500 resize-y"
              />
              <div className="flex items-center justify-between text-xs text-gray-500">
                <div>{isProject ? '选择环境和语言后，模型会生成工程提示词并回填到当前对话输入框。' : '提示：尽量描述清楚输入/输出与约束，结果会更准确。'}</div>
                <div className="flex items-center gap-2">
                  {isProject ? (
                    <>
                      <span>环境:</span>
                      <select
                        value={environment}
                        onChange={e => setEnvironment(e.target.value)}
                        className="bg-gray-800 border border-gray-600 rounded px-2 py-1 text-xs"
                      >
                        <option value="local-linux">本机 Linux</option>
                        <option value="local-macos">本机 macOS</option>
                        <option value="local-windows">本机 Windows</option>
                        <option value="docker">Docker 容器</option>
                        <option value="wsl">WSL</option>
                      </select>
                      <span>语言:</span>
                      <select
                        value={projectLanguage}
                        onChange={e => setProjectLanguage(e.target.value)}
                        className="bg-gray-800 border border-gray-600 rounded px-2 py-1 text-xs"
                      >
                        <option value="python">Python</option>
                        <option value="javascript">JavaScript / Node.js</option>
                        <option value="bash">Shell</option>
                        <option value="c">C</option>
                        <option value="cpp">C++</option>
                        <option value="java">Java</option>
                        <option value="go">Go</option>
                        <option value="rust">Rust</option>
                      </select>
                    </>
                  ) : (
                    <>
                      <span>首选语言:</span>
                      <select
                        value={language}
                        onChange={e => setLanguage(e.target.value as 'bash' | 'python')}
                        className="bg-gray-800 border border-gray-600 rounded px-2 py-1 text-xs"
                      >
                        <option value="bash">bash</option>
                        <option value="python">python</option>
                      </select>
                    </>
                  )}
                </div>
              </div>
              {isProject && generatedPrompt && (
                <div className="rounded-lg border border-cyan-500/30 bg-cyan-950/20 px-3 py-2 text-xs text-cyan-200">
                  已生成并回填提示词。你可以先在当前对话中发送它，再继续生成工程；也可以直接继续当前工程流程。
                </div>
              )}
            </div>
          )}

          {stage === 'plan' && (
            <PlanEditor
              steps={steps}
              onChange={setSteps}
              fixReason={null}
              onRegenerateStep={handleRegenerateStep}
              regeneratingIndex={regeneratingIndex}
              stepReasons={stepReasons}
              onClearReason={(i) => setStepReasons(prev => {
                const next = { ...prev };
                delete next[i];
                return next;
              })}
              providerReady={!!provider}
            />
          )}

          {stage === 'script' && (
            <div className="flex-1 min-h-0">
              <ScriptForm
                language={language}
                script={script}
                onScriptChange={setScript}
                parameters={parameters}
                values={paramValues}
                onValuesChange={setParamValues}
                fixReason={fixReason}
              />
            </div>
          )}

          {stage === 'project' && projectMeta && (
            <ProjectPanel
              meta={projectMeta}
              files={projectFiles}
              activeFile={activeFile}
              onSelectFile={setActiveFile}
              onChangeFile={(path, content) =>
                setProjectFiles(prev => prev.map(f => (f.path === path ? { ...f, content } : f)))
              }
              fixReason={fixReason}
            />
          )}

          {stage === 'run' && (
            <div className="flex-1 min-h-0">
              <RunPanel
                running={running}
                exitCode={exitCode}
                output={output}
                outputRef={outputRef}
                language={isProject ? (projectMeta?.language || 'project') : language}
                script={isProject ? (projectMeta?.execCommand || '') : script}
                sudoPromptOpen={sudoPromptOpen}
                sudoPwdInput={sudoPwdInput}
                onSudoPwdChange={setSudoPwdInput}
                onSudoSubmit={handleSubmitSudoPwd}
                onSudoCancel={() => setSudoPromptOpen(false)}
                sudoSubmitting={sudoSubmitting}
                refinement={refinement}
                onRefinementChange={setRefinement}
                onRefine={handleRefine}
                refineLoading={loading}
                autoFix={autoFix}
                onAutoFixChange={setAutoFix}
                autoFixing={autoFixing}
                autoFixCount={autoFixCount}
                autoFixMax={MAX_AUTO_FIX}
                onStop={() => { void handleStop(); }}
              />
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="px-5 py-3 border-t border-gray-700 flex items-center justify-between gap-2 shrink-0">
          <div className="flex items-center gap-2">
            {stage !== 'goal' && stage !== 'run' && (
              <button
                onClick={() => setStage(stage === 'script' || stage === 'project' ? 'plan' : 'goal')}
                className="flex items-center gap-1 px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-sm"
              >
                <ArrowLeft size={14} /> 上一步
              </button>
            )}
            {stage === 'run' && (
              <button
                onClick={() => { setStage(isProject ? 'project' : 'script'); setExitCode(null); }}
                className="flex items-center gap-1 px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-sm"
              >
                <ArrowLeft size={14} /> {isProject ? '返回工程' : '返回脚本'}
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            {stage === 'goal' && (
              <div className="flex items-center gap-2">
                {isProject && (
                  <button
                    onClick={() => void handleGeneratePrompt()}
                    disabled={promptLoading || loading || !goal.trim() || !provider}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-cyan-500/50 text-cyan-200 hover:bg-cyan-900/30 disabled:bg-gray-800 disabled:text-gray-600 text-sm"
                    title="生成完整工程提示词并回填到当前对话输入框"
                  >
                    {promptLoading ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
                    生成提示词并填入对话框
                  </button>
                )}
                <button
                  onClick={handleGeneratePlan}
                  disabled={loading || promptLoading || !goal.trim() || !provider}
                  className="flex items-center gap-1.5 px-4 py-1.5 rounded bg-purple-600 hover:bg-purple-500 disabled:bg-gray-700 disabled:text-gray-500 text-white text-sm"
                >
                  {loading ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
                  生成步骤
                  <ArrowRight size={14} />
                </button>
              </div>
            )}
            {stage === 'plan' && (
              <button
                onClick={isProject ? handleGenerateProject : handleGenerateScript}
                disabled={loading || !steps.length || !provider}
                className="flex items-center gap-1.5 px-4 py-1.5 rounded bg-purple-600 hover:bg-purple-500 disabled:bg-gray-700 disabled:text-gray-500 text-white text-sm"
              >
                {loading ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
                {isProject ? '生成工程代码' : '生成脚本'}
                <ArrowRight size={14} />
              </button>
            )}
            {stage === 'script' && (
              <button
                onClick={handleExecute}
                disabled={!script.trim() || running}
                className="flex items-center gap-1.5 px-4 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 disabled:bg-gray-700 disabled:text-gray-500 text-white text-sm"
              >
                <Play size={14} />
                执行
              </button>
            )}
            {stage === 'project' && (
              <button
                onClick={() => handleExecuteProject()}
                disabled={!projectMeta || !projectFiles.length || running}
                className="flex items-center gap-1.5 px-4 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 disabled:bg-gray-700 disabled:text-gray-500 text-white text-sm"
              >
                <Play size={14} />
                编译并运行
              </button>
            )}
            {stage === 'run' && exitCode != null && exitCode !== 0 && !autoFixing && (
              <button
                onClick={() => (isProject ? handleFixProject(false) : handleAiFix(false))}
                disabled={loading || !provider}
                className="flex items-center gap-1.5 px-4 py-1.5 rounded bg-red-600 hover:bg-red-500 disabled:bg-gray-700 text-white text-sm"
              >
                {loading ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
                让 AI 修复
              </button>
            )}
            {stage === 'run' && exitCode === 0 && (
              <button
                onClick={onClose}
                className="px-4 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-sm"
              >
                完成
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function StageIndicator({ current, isProject }: { current: Stage; isProject?: boolean }) {
  const stages: { id: Stage; label: string }[] = isProject
    ? [
        { id: 'goal', label: '需求' },
        { id: 'plan', label: '计划' },
        { id: 'project', label: '工程' },
        { id: 'run', label: '运行' },
      ]
    : [
        { id: 'goal', label: '需求' },
        { id: 'plan', label: '步骤' },
        { id: 'script', label: '脚本' },
        { id: 'run', label: '执行' },
      ];
  const idx = stages.findIndex(s => s.id === current);
  return (
    <div className="flex items-center gap-1 text-[11px] text-gray-500 ml-2">
      {stages.map((s, i) => (
        <span key={s.id} className="flex items-center gap-1">
          <span className={i === idx ? 'text-purple-300' : i < idx ? 'text-emerald-400' : 'text-gray-600'}>
            {i + 1}.{s.label}
          </span>
          {i < stages.length - 1 && <span className="text-gray-700">›</span>}
        </span>
      ))}
    </div>
  );
}

function PlanEditor({
  steps, onChange, fixReason,
  onRegenerateStep, regeneratingIndex, stepReasons, onClearReason, providerReady,
}: {
  steps: PlanStep[];
  onChange: (s: PlanStep[]) => void;
  fixReason: string | null;
  onRegenerateStep?: (index: number, hint: string) => Promise<void> | void;
  regeneratingIndex?: number | null;
  stepReasons?: Record<number, string>;
  onClearReason?: (i: number) => void;
  providerReady?: boolean;
}) {
  return (
    <div className="space-y-3">
      {fixReason && (
        <div className="bg-amber-900/30 border border-amber-500/30 text-amber-200 rounded px-3 py-2 text-xs">
          {fixReason}
        </div>
      )}
      <div className="flex items-center justify-between text-xs">
        <span className="uppercase tracking-wider text-gray-500">规划的步骤（可编辑 / 单步 AI 改写）</span>
        <span className="text-[11px] text-gray-600">每一步右侧有 ✨ 按钮，可以让 AI 基于你的提示单独重写</span>
      </div>
      <div className="space-y-2">
        {steps.map((s, i) => (
          <StepCard
            key={i}
            index={i}
            step={s}
            onChange={(next) => onChange(steps.map((x, j) => j === i ? next : x))}
            onDelete={() => onChange(steps.filter((_, j) => j !== i))}
            onRegenerate={
              onRegenerateStep
                ? (hint: string) => Promise.resolve(onRegenerateStep(i, hint))
                : undefined
            }
            regenerating={regeneratingIndex === i}
            disabledRegen={regeneratingIndex != null && regeneratingIndex !== i}
            reason={stepReasons?.[i]}
            onClearReason={() => onClearReason?.(i)}
            providerReady={providerReady}
          />
        ))}
        <button
          onClick={() => onChange([...steps, { title: '', description: '' }])}
          className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded border border-dashed border-gray-700 hover:border-purple-500/60 hover:text-purple-300 text-xs text-gray-500"
        >
          <Plus size={13} /> 添加步骤
        </button>
      </div>
    </div>
  );
}

function StepCard({
  index, step, onChange, onDelete, onRegenerate,
  regenerating, disabledRegen, reason, onClearReason, providerReady,
}: {
  index: number;
  step: PlanStep;
  onChange: (next: PlanStep) => void;
  onDelete: () => void;
  onRegenerate?: (hint: string) => Promise<void>;
  regenerating?: boolean;
  disabledRegen?: boolean;
  reason?: string;
  onClearReason?: () => void;
  providerReady?: boolean;
}) {
  const [hint, setHint] = useState('');
  const [hintOpen, setHintOpen] = useState(false);

  const doRegenerate = async () => {
    if (!onRegenerate) return;
    await onRegenerate(hint.trim());
    // 成功后清空 hint，但保留输入框打开（便于继续微调）
    setHint('');
  };

  return (
    <div className={`bg-gray-800/60 border rounded-lg p-3 transition-colors ${
      regenerating ? 'border-purple-500/60 ring-1 ring-purple-500/30' : 'border-gray-700'
    }`}>
      <div className="flex items-start gap-2">
        <span className="shrink-0 w-6 h-6 rounded-full bg-purple-600/30 text-purple-200 text-xs flex items-center justify-center mt-0.5">
          {regenerating ? <Loader2 size={11} className="animate-spin" /> : index + 1}
        </span>
        <div className="flex-1 space-y-1.5">
          <input
            value={step.title}
            onChange={e => onChange({ ...step, title: e.target.value })}
            placeholder="标题"
            disabled={regenerating}
            className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-purple-500 disabled:opacity-60"
          />
          <textarea
            value={step.description}
            onChange={e => onChange({ ...step, description: e.target.value })}
            placeholder="描述（要做什么、关键命令）"
            rows={2}
            disabled={regenerating}
            className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs text-gray-300 focus:outline-none focus:ring-1 focus:ring-purple-500 resize-y disabled:opacity-60"
          />

          {reason && (
            <div className="flex items-start gap-1.5 bg-purple-900/20 border border-purple-500/30 text-purple-200 rounded px-2 py-1 text-[11px]">
              <Sparkles size={11} className="mt-0.5 shrink-0" />
              <span className="flex-1">{reason}</span>
              {onClearReason && (
                <button onClick={onClearReason} className="text-purple-400 hover:text-white" title="关闭">
                  <X size={11} />
                </button>
              )}
            </div>
          )}

          {hintOpen && onRegenerate && (
            <div className="bg-gray-900/60 border border-purple-500/30 rounded p-2 space-y-1.5">
              <div className="text-[11px] text-purple-300 flex items-center gap-1">
                <Sparkles size={11} /> 给 AI 一个修改提示（可选；留空则在原内容基础上做改写）
              </div>
              <textarea
                value={hint}
                onChange={e => setHint(e.target.value)}
                placeholder="例如：改用 rsync 实现 / 加错误处理 / 写得更详细一点 / 拆成 dpkg + apt-get -f 两条命令…"
                rows={2}
                disabled={regenerating}
                className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 focus:outline-none focus:ring-1 focus:ring-purple-500 resize-y disabled:opacity-60"
                onKeyDown={e => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    void doRegenerate();
                  }
                }}
              />
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] text-gray-600">Ctrl/⌘+Enter 快速生成</span>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => { setHintOpen(false); setHint(''); }}
                    className="text-[11px] text-gray-500 hover:text-white px-2 py-0.5 rounded"
                  >取消</button>
                  <button
                    onClick={() => void doRegenerate()}
                    disabled={regenerating || disabledRegen || !providerReady}
                    title={!providerReady ? '请先在侧边栏选择 Provider' : undefined}
                    className="flex items-center gap-1 px-2 py-1 rounded bg-purple-600 hover:bg-purple-500 disabled:bg-gray-700 disabled:text-gray-500 text-white text-[11px]"
                  >
                    {regenerating ? <Loader2 size={11} className="animate-spin" /> : <Sparkles size={11} />}
                    {regenerating ? '生成中…' : '重新生成本步'}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="flex flex-col items-center gap-1 shrink-0">
          {onRegenerate && (
            <button
              onClick={() => setHintOpen(v => !v)}
              disabled={regenerating || disabledRegen || !providerReady}
              className={`p-1 rounded ${
                hintOpen ? 'text-purple-300 bg-purple-900/30' : 'text-gray-500 hover:text-purple-300'
              } disabled:opacity-50`}
              title={
                !providerReady ? '请先选择 Provider'
                : disabledRegen ? '另一步正在重新生成…'
                : (hintOpen ? '收起' : '让 AI 单独重写这一步')
              }
            >
              {regenerating ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
            </button>
          )}
          <button
            onClick={onDelete}
            disabled={regenerating}
            className="p-1 text-gray-500 hover:text-red-400 disabled:opacity-50"
            title="删除此步"
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>
    </div>
  );
}

function ProjectPanel({
  meta, files, activeFile, onSelectFile, onChangeFile, fixReason,
}: {
  meta: ProjectMeta;
  files: ProjectFile[];
  activeFile: string;
  onSelectFile: (path: string) => void;
  onChangeFile: (path: string, content: string) => void;
  fixReason: string | null;
}) {
  const current = files.find(f => f.path === activeFile) || files[0];
  return (
    <div className="space-y-3">
      {fixReason && (
        <div className="bg-amber-900/30 border border-amber-500/30 text-amber-200 rounded px-3 py-2 text-xs">
          🛠 {fixReason}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <span className="px-2 py-0.5 rounded-full bg-purple-900/30 border border-purple-700/40 text-purple-200">
          语言 <span className="font-mono">{meta.language}</span>
        </span>
        <span className="px-2 py-0.5 rounded-full bg-gray-800 border border-gray-700 text-gray-300">
          入口 <span className="font-mono">{meta.entry || '—'}</span>
        </span>
        {meta.deps?.length > 0 && (
          <span className="px-2 py-0.5 rounded-full bg-gray-800 border border-gray-700 text-amber-300 font-mono">
            依赖 {meta.deps.join(', ')}
          </span>
        )}
        <span className="text-gray-500">· {files.length} 个文件</span>
      </div>
      {meta.summary && <div className="text-xs text-gray-400">{meta.summary}</div>}

      <div className="flex gap-3 min-h-[300px]">
        {/* 文件树 */}
        <div className="w-44 shrink-0 border border-gray-700 rounded-lg bg-gray-800/40 overflow-y-auto max-h-[52vh]">
          {files.map(f => (
            <button
              key={f.path}
              onClick={() => onSelectFile(f.path)}
              className={`w-full text-left px-2.5 py-1.5 text-xs flex items-center gap-1.5 border-b border-gray-800 last:border-0 ${
                current?.path === f.path ? 'bg-purple-900/30 text-purple-200' : 'text-gray-400 hover:bg-gray-700/50'
              }`}
              title={f.path}
            >
              <FileCode2 size={12} className="shrink-0" />
              <span className="truncate font-mono">{f.path}</span>
            </button>
          ))}
        </div>
        {/* 文件内容编辑 */}
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="text-[11px] text-gray-500 font-mono mb-1 truncate">{current?.path}</div>
          <textarea
            value={current?.content || ''}
            onChange={e => current && onChangeFile(current.path, e.target.value)}
            spellCheck={false}
            className="flex-1 w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-xs font-mono text-gray-200 focus:outline-none focus:ring-1 focus:ring-purple-500 leading-relaxed resize-none min-h-[300px]"
          />
        </div>
      </div>
      <div className="text-[11px] text-gray-600">
        将运行：<span className="font-mono text-gray-400">{meta.runCmd || 'bash run.sh'}</span>
        <span className="ml-2">（点「编译并运行」会自动安装依赖 / 编译并执行，失败可自动修复 {MAX_AUTO_FIX} 次）</span>
      </div>
    </div>
  );
}

function ScriptForm({
  language, script, onScriptChange, parameters, values, onValuesChange, fixReason,
}: {
  language: string;
  script: string;
  onScriptChange: (s: string) => void;
  parameters: ParamDef[];
  values: Record<string, string>;
  onValuesChange: (v: Record<string, string>) => void;
  fixReason: string | null;
}) {
  return (
    <div className="h-full min-h-0 flex flex-col gap-4 overflow-hidden">
      {fixReason && (
        <div className="bg-amber-900/30 border border-amber-500/30 text-amber-200 rounded px-3 py-2 text-xs">
          🛠 {fixReason}
        </div>
      )}
      {parameters.length > 0 && (
        <div className="shrink-0 max-h-[38%] overflow-y-auto space-y-2 pr-1">
          <div className="text-xs uppercase tracking-wider text-gray-500">需要你确认/输入的参数</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 bg-gray-800/40 border border-gray-700 rounded-lg p-3">
            {parameters.map(p => (
              <div key={p.name} className="space-y-1">
                <label className="block text-[11px] text-gray-400">
                  <span className="font-mono text-purple-300">{p.name}</span>
                  {p.required && <span className="text-red-400 ml-1">*</span>}
                  {p.label && <span className="text-gray-500 ml-1">— {p.label}</span>}
                </label>
                {p.type === 'boolean' ? (
                  <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={values[p.name] === '1'}
                      onChange={e => onValuesChange({ ...values, [p.name]: e.target.checked ? '1' : '0' })}
                    />
                    {values[p.name] === '1' ? '启用' : '禁用'}
                  </label>
                ) : p.type === 'select' && p.options?.length ? (
                  <select
                    value={values[p.name] ?? ''}
                    onChange={e => onValuesChange({ ...values, [p.name]: e.target.value })}
                    className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-xs"
                  >
                    {p.options.map(o => (<option key={o} value={o}>{o}</option>))}
                  </select>
                ) : (
                  <input
                    type={p.type === 'password' ? 'password' : p.type === 'number' ? 'number' : 'text'}
                    value={values[p.name] ?? ''}
                    onChange={e => onValuesChange({ ...values, [p.name]: e.target.value })}
                    placeholder={p.default ?? ''}
                    className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-xs font-mono"
                  />
                )}
                {p.description && <div className="text-[11px] text-gray-500">{p.description}</div>}
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="flex-1 min-h-0 flex flex-col gap-1">
        <div className="flex items-center justify-between text-xs text-gray-500 shrink-0">
          <span className="uppercase tracking-wider">脚本预览（{language}，可微调）</span>
          <span className="text-[11px] text-gray-600">环境变量将自动注入运行时</span>
        </div>
        <textarea
          value={script}
          onChange={e => onScriptChange(e.target.value)}
          spellCheck={false}
          className="flex-1 min-h-0 w-full resize-none bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-xs font-mono text-gray-200 focus:outline-none focus:ring-1 focus:ring-purple-500 leading-relaxed"
        />
      </div>
    </div>
  );
}

function RunPanel({
  running, exitCode, output, outputRef, language, script,
  sudoPromptOpen, sudoPwdInput, onSudoPwdChange, onSudoSubmit, onSudoCancel, sudoSubmitting,
  refinement, onRefinementChange, onRefine, refineLoading,
  autoFix, onAutoFixChange, autoFixing, autoFixCount, autoFixMax, onStop,
}: {
  running: boolean;
  exitCode: number | null;
  output: string;
  outputRef: React.RefObject<HTMLDivElement | null>;
  language: string;
  script: string;
  onStop: () => void;
  sudoPromptOpen: boolean;
  sudoPwdInput: string;
  onSudoPwdChange: (v: string) => void;
  onSudoSubmit: () => void;
  onSudoCancel: () => void;
  sudoSubmitting: boolean;
  refinement: string;
  onRefinementChange: (v: string) => void;
  onRefine: () => void;
  refineLoading: boolean;
  autoFix: boolean;
  onAutoFixChange: (v: boolean) => void;
  autoFixing: boolean;
  autoFixCount: number;
  autoFixMax: number;
}) {
  const [showExecutedScript, setShowExecutedScript] = useState(false);
  const finished = !running && exitCode != null && !autoFixing;
  const reachedAutoFixLimit = autoFixCount >= autoFixMax && exitCode != null && exitCode !== 0;
  return (
    <div className="h-full min-h-0 flex flex-col gap-2 overflow-hidden">
      <div className="flex items-center gap-2 text-xs flex-wrap">
        {autoFixing ? (
          <span className="flex items-center gap-1.5 text-amber-300">
            <Loader2 size={13} className="animate-spin" /> AI 自动修复中（{autoFixCount + 1}/{autoFixMax}）…
          </span>
        ) : running ? (
          <span className="flex items-center gap-1.5 text-yellow-400"><Loader2 size={13} className="animate-spin" /> 执行中…</span>
        ) : exitCode === 0 ? (
          <span className="flex items-center gap-1.5 text-emerald-400">
            <CheckCircle2 size={13} /> 执行成功 (exit 0)
            {autoFixCount > 0 && <span className="text-gray-500 ml-1">· 自动修复 {autoFixCount} 次后通过</span>}
          </span>
        ) : exitCode != null ? (
          <span className="flex items-center gap-1.5 text-red-400">
            <XCircle size={13} /> 执行失败 (exit {exitCode})
            {autoFixCount > 0 && <span className="text-gray-500 ml-1">· 已自动修复 {autoFixCount} 次仍失败</span>}
          </span>
        ) : (
          <span className="text-gray-400">准备执行…</span>
        )}
        {(running || autoFixing) && (
          <button
            onClick={onStop}
            className="ml-auto flex items-center gap-1 px-2 py-0.5 rounded bg-red-600/90 hover:bg-red-600 text-white text-[11px] font-medium transition-colors"
            title="停止当前执行 / 自动修复"
          >
            <Square size={10} className="fill-current" /> 停止
          </button>
        )}
        <label
          className={`${(running || autoFixing) ? '' : 'ml-auto '}flex items-center gap-1.5 text-[11px] cursor-pointer select-none ${autoFix ? 'text-amber-300' : 'text-gray-500'}`}
          title="脚本执行失败时，自动调用 AI 修复并重跑（最多 3 次）"
        >
          <Zap size={11} />
          自动修复
          <input
            type="checkbox"
            checked={autoFix}
            onChange={e => onAutoFixChange(e.target.checked)}
            className="accent-amber-500"
          />
        </label>
        <span className="text-[11px] text-gray-500 font-mono">{language}</span>
      </div>

      {reachedAutoFixLimit && (
        <div className="bg-amber-900/30 border border-amber-500/40 text-amber-200 rounded px-3 py-2 text-xs flex items-start gap-2">
          <Zap size={13} className="mt-0.5 shrink-0" />
          <div>
            已达自动修复上限（{autoFixMax} 次）仍未成功。请检查输出找出根本原因，再点击下方「让 AI 修复」单次修复，或在末尾「继续迭代」框中给 AI 更明确的提示重新生成脚本。
          </div>
        </div>
      )}

      {sudoPromptOpen && (
        <div className="bg-amber-900/30 border border-amber-500/40 rounded-lg p-3 space-y-2">
          <div className="flex items-center gap-2 text-amber-200 text-xs">
            <KeyRound size={13} />
            <span>需要 sudo 密码（首次输入后会保存到本地，下次自动使用）</span>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="password"
              value={sudoPwdInput}
              onChange={e => onSudoPwdChange(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && sudoPwdInput) onSudoSubmit(); }}
              placeholder="输入 sudo 密码…"
              autoFocus
              className="flex-1 bg-gray-900 border border-amber-500/30 rounded px-2 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-amber-500"
            />
            <button
              onClick={onSudoSubmit}
              disabled={!sudoPwdInput || sudoSubmitting}
              className="px-3 py-1.5 rounded bg-amber-600 hover:bg-amber-500 disabled:bg-gray-700 disabled:text-gray-500 text-white text-xs"
            >
              {sudoSubmitting ? <Loader2 size={12} className="animate-spin" /> : '提交并继续'}
            </button>
            <button
              onClick={onSudoCancel}
              className="px-2 py-1.5 rounded text-gray-400 hover:text-white text-xs"
              title="取消"
            >
              <X size={14} />
            </button>
          </div>
        </div>
      )}

      <div
        ref={outputRef}
        className="flex-1 min-h-[120px] bg-[#0f172a] border border-gray-700 rounded-lg p-3 font-mono text-xs text-gray-200 whitespace-pre-wrap break-all overflow-auto"
      >
        {output || (running ? '' : '(暂无输出)')}
      </div>

      {finished && (
        <div className="border border-purple-500/30 bg-purple-900/15 rounded-lg p-3 space-y-2">
          <div className="flex items-center gap-2 text-xs text-purple-200">
            <Sparkles size={13} />
            <span>基于本次执行结果继续迭代（描述你想改进/调整的方向，AI 会重新生成脚本）</span>
          </div>
          <textarea
            value={refinement}
            onChange={e => onRefinementChange(e.target.value)}
            placeholder="例如：输出改成 JSON 格式 / 加重试逻辑 / 把 Q4_K_M 改成 Q5_K_M / 同时把结果写到日志文件…"
            rows={3}
            className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-purple-500 resize-y"
          />
          <div className="flex justify-end">
            <button
              onClick={onRefine}
              disabled={!refinement.trim() || refineLoading}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-purple-600 hover:bg-purple-500 disabled:bg-gray-700 disabled:text-gray-500 text-white text-xs"
            >
              {refineLoading ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
              重新生成脚本
            </button>
          </div>
        </div>
      )}

      <div className={`${
        showExecutedScript ? 'basis-[42%] min-h-[96px] shrink' : 'shrink-0'
      } flex flex-col min-h-0 overflow-hidden`}>
        {showExecutedScript && (
          <pre className="flex-1 min-h-0 mb-1 bg-gray-950/80 border border-gray-800 rounded p-2 text-[11px] text-gray-400 whitespace-pre-wrap break-all overflow-auto">
            {script}
          </pre>
        )}
        <button
          type="button"
          onClick={() => setShowExecutedScript(open => !open)}
          aria-expanded={showExecutedScript}
          className="shrink-0 self-start flex items-center gap-1 text-[11px] text-gray-500 hover:text-gray-300"
        >
          {showExecutedScript ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
          {showExecutedScript ? '收起本次执行的脚本' : '查看本次执行的脚本'}
        </button>
      </div>
    </div>
  );
}
