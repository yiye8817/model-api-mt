import { useCallback, useEffect, useState } from 'react';
import {
  Command, Sparkles, Zap, Search, Loader2, Download, Check, Plus, Trash2,
  CornerDownLeft, Send, RefreshCw, Power, Pencil, X,
} from 'lucide-react';
import type { AutoInputRule, ClaudePluginEntry, ClaudeInstalledPlugin } from '../types';
import {
  CLAUDE_COMMANDS, CLAUDE_COMMON_COUNT, getCommandDesc, sortClaudeCommands,
} from '../lib/claudeCommands';
import {
  HERMES_COMMANDS, HERMES_COMMON_COUNT, getHermesCommandDesc, sortHermesCommands,
} from '../lib/hermesCommands';

interface Props {
  /** 当前活动 Agent 标签页 id（无则命令/注入禁用）。 */
  activeClaudeTabId: string | null;
  /** claude | hermes，决定命令列表与文案。 */
  variant?: 'claude' | 'hermes';
  /** 活动会话的动态斜杠命令 / skills（来自 system/init）。 */
  commands: string[];
  skills: string[];
  /** 把文本注入到当前 Claude 标签的输入框（send=true 时直接发送）。 */
  onInsert: (text: string, send: boolean) => void;
  rules: AutoInputRule[];
  rulesEnabled: boolean;
  onRulesChange: (rules: AutoInputRule[]) => void;
  onRulesEnabledChange: (v: boolean) => void;
}

type Tab = 'cmd' | 'skill' | 'auto';

const CUSTOM_CMD_KEY = 'workbench/customCommands';

function loadCustom(): string[] {
  try { return JSON.parse(localStorage.getItem(CUSTOM_CMD_KEY) || '[]'); } catch { return []; }
}
function saveCustom(list: string[]) {
  try { localStorage.setItem(CUSTOM_CMD_KEY, JSON.stringify(list)); } catch { /* noop */ }
}

export default function WorkbenchPanel({
  activeClaudeTabId, variant = 'claude', commands, skills, onInsert,
  rules, rulesEnabled, onRulesChange, onRulesEnabledChange,
}: Props) {
  const [tab, setTab] = useState<Tab>('cmd');
  const disabled = !activeClaudeTabId;
  const isHermes = variant === 'hermes';
  const agentLabel = isHermes ? 'Hermes' : 'Claude Code';

  return (
    <div className="flex flex-col h-full bg-gray-900 text-gray-100 border-l border-gray-700">
      <div className="shrink-0 flex border-b border-gray-700 text-xs">
        {([['cmd', '命令', Command], ['skill', 'Skill', Sparkles], ['auto', '自动', Zap]] as const).map(([k, label, Icon]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={`flex-1 flex items-center justify-center gap-1.5 py-2 border-b-2 ${
              tab === k
                ? (isHermes ? 'border-amber-500 text-white bg-gray-850' : 'border-purple-500 text-white bg-gray-850')
                : 'border-transparent text-gray-400 hover:text-gray-200'
            }`}
          >
            <Icon size={13} /> {label}
          </button>
        ))}
      </div>

      {disabled && (
        <div className="px-3 py-2 text-[11px] text-amber-300/80 bg-amber-900/20 border-b border-amber-800/30">
          请先切换到一个 {agentLabel} 标签页再使用命令 / 自动应答。
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto">
        {tab === 'cmd' && <CommandsTab variant={variant} commands={commands} skills={skills} disabled={disabled} onInsert={onInsert} />}
        {tab === 'skill' && (isHermes
          ? <HermesSkillTab skills={skills} disabled={disabled} onInsert={onInsert} />
          : <SkillTab disabled={disabled} onInsert={onInsert} />
        )}
        {tab === 'auto' && (
          <AutoTab rules={rules} enabled={rulesEnabled} onChange={onRulesChange} onEnabledChange={onRulesEnabledChange} />
        )}
      </div>
    </div>
  );
}

/* ----------------------------- 命令 (SP4) ----------------------------- */
function CommandsTab({ variant = 'claude', commands, skills, disabled, onInsert }: {
  variant?: 'claude' | 'hermes';
  commands: string[]; skills: string[]; disabled: boolean;
  onInsert: (text: string, send: boolean) => void;
}) {
  const isHermes = variant === 'hermes';
  const BUILTIN = isHermes ? HERMES_COMMANDS : CLAUDE_COMMANDS;
  const COMMON_COUNT = isHermes ? HERMES_COMMON_COUNT : CLAUDE_COMMON_COUNT;
  const sortFn = isHermes ? sortHermesCommands : sortClaudeCommands;
  const getDesc = isHermes ? getHermesCommandDesc : getCommandDesc;
  const accentClass = isHermes ? 'text-amber-300' : 'text-purple-300';
  const hoverClass = isHermes ? 'hover:bg-amber-600/40' : 'hover:bg-purple-600/40';
  const focusClass = isHermes ? 'focus:border-amber-500' : 'focus:border-purple-500';
  const [custom, setCustom] = useState<string[]>(loadCustom);
  const [draft, setDraft] = useState('');
  const [filter, setFilter] = useState('');

  const addCustom = () => {
    const v = draft.trim().replace(/^\//, '');
    if (!v) return;
    const next = Array.from(new Set([...custom, v]));
    setCustom(next); saveCustom(next); setDraft('');
  };
  const delCustom = (c: string) => {
    const next = custom.filter((x) => x !== c);
    setCustom(next); saveCustom(next);
  };

  const f = filter.trim().toLowerCase();
  const matchq = (s: string) => !f || s.toLowerCase().includes(f);
  const matchCmd = (cmd: string, desc?: string) => matchq(cmd) || (desc ? matchq(desc) : false);

  const builtinSet = new Set(BUILTIN.map((b) => b.cmd));
  const dynamic = sortFn(
    commands.filter((c) => !builtinSet.has(c) && matchq(c)),
  );
  const commonBuiltin = BUILTIN.slice(0, COMMON_COUNT).filter((b) => matchCmd(b.cmd, b.desc));
  const moreBuiltin = BUILTIN.slice(COMMON_COUNT).filter((b) => matchCmd(b.cmd, b.desc));

  const CmdRow = ({ cmd, desc, onDel }: { cmd: string; desc?: string; onDel?: () => void }) => (
    <div className="group flex items-center gap-1 px-2 py-1 rounded hover:bg-gray-800">
      <button
        disabled={disabled}
        onClick={() => onInsert('/' + cmd + ' ', false)}
        className="flex-1 min-w-0 text-left disabled:opacity-40"
        title="插入到输入框"
      >
        <span className={`font-mono ${accentClass} text-[13px]`}>/{cmd}</span>
        {desc && <span className="text-gray-500 text-[11px] ml-2">{desc}</span>}
      </button>
      <button
        disabled={disabled}
        onClick={() => onInsert('/' + cmd, true)}
        className={`opacity-0 group-hover:opacity-100 p-1 rounded ${hoverClass} text-gray-400 hover:text-white disabled:opacity-40`}
        title="立即发送"
      >
        <Send size={12} />
      </button>
      {onDel && (
        <button onClick={onDel} className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-red-600/40 text-gray-500 hover:text-red-300" title="删除">
          <Trash2 size={12} />
        </button>
      )}
    </div>
  );

  return (
    <div className="p-2 space-y-3">
      <div className="relative">
        <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-500" />
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="过滤命令…"
          className={`w-full pl-7 pr-2 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded focus:outline-none ${focusClass}`}
        />
      </div>

      <Section title="常用命令">
        {commonBuiltin.map((b) => (
          <CmdRow key={b.cmd} cmd={b.cmd} desc={b.desc} />
        ))}
      </Section>

      {moreBuiltin.length > 0 && (
        <Section title="全部命令">
          {moreBuiltin.map((b) => (
            <CmdRow key={b.cmd} cmd={b.cmd} desc={b.desc} />
          ))}
        </Section>
      )}

      {dynamic.length > 0 && (
        <Section title="会话命令">
          {dynamic.map((c) => <CmdRow key={c} cmd={c} desc={getDesc(c)} />)}
        </Section>
      )}

      {skills.filter(matchq).length > 0 && (
        <Section title="Skills">
          {skills.filter(matchq).map((s) => <CmdRow key={s} cmd={s} />)}
        </Section>
      )}

      <Section title="自定义命令">
        {custom.filter(matchq).map((c) => <CmdRow key={c} cmd={c} onDel={() => delCustom(c)} />)}
        <div className="flex items-center gap-1 px-1 pt-1">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') addCustom(); }}
            placeholder="新增命令（不含 /）"
            className={`flex-1 px-2 py-1 text-xs bg-gray-800 border border-gray-700 rounded focus:outline-none ${focusClass}`}
          />
          <button onClick={addCustom} className="p-1.5 rounded bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300" title="添加">
            <Plus size={13} />
          </button>
        </div>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-gray-500 px-2 mb-0.5">{title}</div>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

/* ----------------------------- Hermes Skills ----------------------------- */
function HermesSkillTab({ skills, disabled, onInsert }: {
  skills: string[];
  disabled: boolean;
  onInsert: (text: string, send: boolean) => void;
}) {
  const [q, setQ] = useState('');
  const [allSkills, setAllSkills] = useState<string[]>(skills);
  const [loading, setLoading] = useState(false);

  useEffect(() => { setAllSkills(skills); }, [skills]);

  useEffect(() => {
    setLoading(true);
    fetch('/api/hermes/skills')
      .then((r) => r.ok ? r.json() : { skills: [] })
      .then((d) => {
        const list = Array.isArray(d.skills) ? d.skills : [];
        if (list.length) setAllSkills((prev) => Array.from(new Set([...prev, ...list])));
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const f = q.trim().toLowerCase();
  const filtered = allSkills.filter((s) => !f || s.toLowerCase().includes(f));

  return (
    <div className="p-2 space-y-2">
      <div className="relative">
        <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-500" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="过滤 Skill…"
          className="w-full pl-7 pr-2 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded focus:outline-none focus:border-amber-500"
        />
      </div>
      {loading && <div className="flex items-center gap-2 text-xs text-gray-500 px-2"><Loader2 size={12} className="animate-spin" /> 加载中…</div>}
      {filtered.length === 0 && !loading && (
        <div className="text-xs text-gray-500 px-2">暂无已启用的 Skill。可在 Hermes 中用 /skills 安装。</div>
      )}
      {filtered.map((s) => (
        <div key={s} className="group flex items-center gap-1 px-2 py-1 rounded hover:bg-gray-800">
          <button
            disabled={disabled}
            onClick={() => onInsert(`/skill ${s}`, false)}
            className="flex-1 min-w-0 text-left disabled:opacity-40"
            title="插入 /skill 命令"
          >
            <span className="font-mono text-amber-300 text-[13px]">{s}</span>
          </button>
          <button
            disabled={disabled}
            onClick={() => onInsert(`/skill ${s}`, true)}
            className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-amber-600/40 text-gray-400 hover:text-white disabled:opacity-40"
            title="立即加载 Skill"
          >
            <Send size={12} />
          </button>
          <button
            disabled={disabled}
            onClick={() => onInsert(`使用 ${s}`, true)}
            className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-amber-600/40 text-gray-400 hover:text-white disabled:opacity-40"
            title="自然语言使用"
          >
            <CornerDownLeft size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}

/* ----------------------------- Skill (SP5) ----------------------------- */
/** 从插件 id（形如 name@marketplace）取可用作 slash 命令的基础名。 */
function pluginBaseName(id: string): string {
  return (id || '').split('@')[0].trim();
}

function SkillTab({ disabled, onInsert }: {
  disabled: boolean;
  onInsert: (text: string, send: boolean) => void;
}) {
  const [q, setQ] = useState('');
  const [available, setAvailable] = useState<ClaudePluginEntry[]>([]);
  const [installed, setInstalled] = useState<ClaudeInstalledPlugin[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const [installedNow, setInstalledNow] = useState<Set<string>>(new Set());
  const [mktSource, setMktSource] = useState('');
  const [mktBusy, setMktBusy] = useState(false);
  const [mktMsg, setMktMsg] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setErr(null);
    fetch('/api/claude/plugins/catalog')
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j?.error || `加载失败 (${r.status})`);
        setAvailable(Array.isArray(j.available) ? j.available : []);
        setInstalled(Array.isArray(j.installed) ? j.installed : []);
        if (j.warning) setErr(j.warning);
      })
      .catch((e) => setErr(e?.message || String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const installedIds = new Set(installed.map((p) => p.id));
  const f = q.trim().toLowerCase();
  const filtered = available
    .filter((p) => !f || p.name.toLowerCase().includes(f) || (p.description || '').toLowerCase().includes(f) || (p.marketplaceName || '').toLowerCase().includes(f))
    .sort((a, b) => (b.installCount || 0) - (a.installCount || 0))
    .slice(0, 60);

  const doInstall = (id: string) => {
    setInstalling(id);
    fetch('/api/claude/plugins/install', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: id }),
    })
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.ok) throw new Error(j?.error || '安装失败');
        setInstalledNow((s) => new Set(s).add(id));
        load();
      })
      .catch((e) => setErr(e?.message || String(e)))
      .finally(() => setInstalling(null));
  };

  /** 在当前 claudecode 里用自然语言「使用」某 skill。 */
  const useSkill = (name: string) => {
    onInsert(`使用 ${name}`, true);
  };

  /** 向当前（交互式终端）claudecode 注入 /reload-plugins 让新启用的插件即时加载。 */
  const reloadPlugins = () => {
    onInsert('/reload-plugins', true);
  };

  /** 启用某插件 → reload-plugins 加载 → 稍后自然语言「使用 xxx」做简单测试。 */
  const enableAndTest = async (p: ClaudeInstalledPlugin) => {
    const base = pluginBaseName(p.id);
    setBusyId(p.id); setErr(null);
    try {
      const r = await fetch('/api/claude/plugins/enable', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: p.id, scope: p.scope }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j?.error || '启用失败');
      load();
      if (!disabled) {
        reloadPlugins();                                   // 在交互终端里热加载
        window.setTimeout(() => useSkill(base), 2500);     // 等加载完成后做简单测试
      }
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setBusyId(null);
    }
  };

  const addMarketplace = () => {
    const src = mktSource.trim();
    if (!src) return;
    setMktBusy(true); setMktMsg(null); setErr(null);
    fetch('/api/claude/marketplaces/add', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: src }),
    })
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.ok) throw new Error(j?.error || '添加失败');
        setMktMsg('已添加，正在刷新目录…');
        setMktSource('');
        load();
      })
      .catch((e) => setErr(e?.message || String(e)))
      .finally(() => setMktBusy(false));
  };

  return (
    <div className="p-2 space-y-2">
      <div className="flex items-center gap-1">
        <div className="relative flex-1">
          <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-500" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索 skill / 插件…"
            className="w-full pl-7 pr-2 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded focus:outline-none focus:border-purple-500"
          />
        </div>
        <button onClick={load} className="p-1.5 rounded bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300" title="刷新目录">
          {loading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
        </button>
      </div>

      {/* 添加市场 */}
      <details className="text-xs">
        <summary className="cursor-pointer text-gray-400 hover:text-gray-200 select-none py-1">添加市场（GitHub owner/repo 或 URL）</summary>
        <div className="flex items-center gap-1 mt-1">
          <input
            value={mktSource}
            onChange={(e) => setMktSource(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') addMarketplace(); }}
            placeholder="如 anthropics/claude-plugins-official"
            className="flex-1 px-2 py-1 bg-gray-800 border border-gray-700 rounded focus:outline-none focus:border-purple-500"
          />
          <button onClick={addMarketplace} disabled={mktBusy || !mktSource.trim()} className="p-1.5 rounded bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 disabled:opacity-40">
            {mktBusy ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
          </button>
        </div>
        {mktMsg && <div className="text-emerald-400 mt-1">{mktMsg}</div>}
      </details>

      {err && <div className="text-[11px] text-amber-300 bg-amber-900/20 rounded px-2 py-1">{err}</div>}

      <div className="text-[10px] text-gray-500 px-1">
        {loading ? '加载中…' : `可用 ${available.length} · 已安装 ${installed.length}`}
      </div>

      {/* 已安装：用自然语言「使用 xxx」在当前 claudecode 中调用 */}
      {installed.length > 0 && (
        <div className="space-y-1">
          <div className="flex items-center justify-between px-1">
            <span className="text-[10px] uppercase tracking-wide text-gray-500">已安装（可使用）</span>
            <button
              disabled={disabled}
              onClick={reloadPlugins}
              className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-gray-800 hover:bg-gray-700 border border-gray-700 text-[10px] text-gray-300 disabled:opacity-40"
              title={disabled ? '请先切换到一个 Claude Code 交互终端' : '向交互终端发送 /reload-plugins 重新加载插件'}
            >
              <RefreshCw size={11} /> 重载插件
            </button>
          </div>
          {installed
            .filter((p) => !f || p.id.toLowerCase().includes(f))
            .map((p) => {
              const base = pluginBaseName(p.id);
              const isDisabled = p.enabled === false;
              return (
                <div key={p.id} className="group flex items-center gap-1 border border-gray-700/70 rounded px-2 py-1.5 bg-gray-800/40">
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] text-gray-100 truncate" title={p.id}>{base}</div>
                    <div className="text-[10px] text-gray-500">
                      {p.version ? `v${p.version}` : ''}{p.scope ? ` · ${p.scope}` : ''}{isDisabled ? ' · 已禁用' : ''}
                    </div>
                  </div>
                  {isDisabled ? (
                    <button
                      disabled={busyId === p.id}
                      onClick={() => enableAndTest(p)}
                      className="flex items-center gap-1 px-2 py-1 rounded bg-purple-600/80 hover:bg-purple-500 text-white text-[11px] shrink-0 disabled:opacity-50"
                      title="启用 → 调用 reload-plugins 加载 → 自然语言「使用」做简单测试"
                    >
                      {busyId === p.id ? <Loader2 size={12} className="animate-spin" /> : <Power size={12} />}
                      启用并测试
                    </button>
                  ) : (
                    <button
                      disabled={disabled}
                      onClick={() => useSkill(base)}
                      className="flex items-center gap-1 px-2 py-1 rounded bg-purple-600/80 hover:bg-purple-500 text-white text-[11px] shrink-0 disabled:opacity-40"
                      title={disabled ? '请先切换到一个 Claude Code 标签' : `在当前 claudecode 发送「使用 ${base}」`}
                    >
                      <Send size={12} /> 使用
                    </button>
                  )}
                </div>
              );
            })}
        </div>
      )}

      <div className="space-y-1">
        {available.length > 0 && (
          <div className="text-[10px] uppercase tracking-wide text-gray-500 px-1">市场（可安装）</div>
        )}
        {filtered.map((p) => {
          const isInstalled = installedIds.has(p.pluginId) || installedNow.has(p.pluginId);
          return (
            <div key={p.pluginId} className="border border-gray-700/70 rounded p-2 bg-gray-800/40">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] text-gray-100 font-medium truncate" title={p.pluginId}>{p.name}</div>
                  <div className="text-[10px] text-gray-500">
                    {p.marketplaceName}{typeof p.installCount === 'number' ? ` · ${p.installCount} 安装` : ''}
                  </div>
                </div>
                {isInstalled ? (
                  <span className="flex items-center gap-1 text-[11px] text-emerald-400 shrink-0"><Check size={12} /> 已装</span>
                ) : (
                  <button
                    onClick={() => doInstall(p.pluginId)}
                    disabled={installing === p.pluginId}
                    className="flex items-center gap-1 px-2 py-1 rounded bg-purple-600/80 hover:bg-purple-500 text-white text-[11px] shrink-0 disabled:opacity-50"
                  >
                    {installing === p.pluginId ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
                    安装
                  </button>
                )}
              </div>
              {p.description && (
                <div className="text-[11px] text-gray-400 mt-1 line-clamp-3">{p.description}</div>
              )}
            </div>
          );
        })}
        {!loading && filtered.length === 0 && (
          <div className="text-xs text-gray-500 px-1 py-4 text-center">无匹配结果。可尝试「添加市场」后刷新。</div>
        )}
      </div>
    </div>
  );
}

/* ----------------------------- 自动应答 (SP6) ----------------------------- */
function AutoTab({ rules, enabled, onChange, onEnabledChange }: {
  rules: AutoInputRule[]; enabled: boolean;
  onChange: (r: AutoInputRule[]) => void; onEnabledChange: (v: boolean) => void;
}) {
  const [editing, setEditing] = useState<AutoInputRule | null>(null);

  const blank = (): AutoInputRule => ({ id: `r${Date.now()}`, enabled: true, keyword: '', useRegex: false, reply: '', once: false });

  const upsert = (rule: AutoInputRule) => {
    const exists = rules.some((r) => r.id === rule.id);
    onChange(exists ? rules.map((r) => (r.id === rule.id ? rule : r)) : [...rules, rule]);
    setEditing(null);
  };
  const remove = (id: string) => onChange(rules.filter((r) => r.id !== id));
  const toggle = (id: string) => onChange(rules.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r)));

  return (
    <div className="p-2 space-y-2">
      <div className="flex items-center justify-between bg-gray-800/60 rounded px-2 py-1.5">
        <span className="text-xs text-gray-300 flex items-center gap-1.5"><Power size={13} className={enabled ? 'text-emerald-400' : 'text-gray-500'} /> 自动应答总开关</span>
        <button
          onClick={() => onEnabledChange(!enabled)}
          className={`relative w-9 h-5 rounded-full transition-colors ${enabled ? 'bg-emerald-500' : 'bg-gray-600'}`}
        >
          <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${enabled ? 'translate-x-4' : ''}`} />
        </button>
      </div>
      <p className="text-[10px] text-gray-500 px-1 leading-relaxed">
        当 Claude 一轮输出文本命中关键词时，自动把「回复」发送给 Claude（如检测到询问确认时自动回 yes）。
      </p>

      {rules.map((r) => (
        <div key={r.id} className="border border-gray-700/70 rounded p-2 bg-gray-800/40 space-y-1">
          <div className="flex items-center gap-1">
            <button onClick={() => toggle(r.id)} className={`shrink-0 w-8 h-4 rounded-full transition-colors ${r.enabled ? 'bg-emerald-500' : 'bg-gray-600'}`}>
              <span className={`block w-3 h-3 rounded-full bg-white transition-transform mt-0.5 ${r.enabled ? 'translate-x-4 ml-0.5' : 'ml-0.5'}`} />
            </button>
            <span className="flex-1 min-w-0 truncate text-[12px] text-gray-200">
              {r.useRegex ? '/' : ''}{r.keyword || '(空)'}{r.useRegex ? '/' : ''} {r.once && <span className="text-[9px] text-amber-400">·once</span>}
            </span>
            <button onClick={() => setEditing(r)} className="p-1 rounded hover:bg-gray-700 text-gray-400" title="编辑"><Pencil size={12} /></button>
            <button onClick={() => remove(r.id)} className="p-1 rounded hover:bg-red-600/40 text-gray-500 hover:text-red-300" title="删除"><Trash2 size={12} /></button>
          </div>
          <div className="text-[11px] text-gray-500 truncate pl-9"><CornerDownLeft size={10} className="inline mr-1" />{r.reply || '(空回复)'}</div>
        </div>
      ))}

      {editing ? (
        <RuleEditor rule={editing} onSave={upsert} onCancel={() => setEditing(null)} />
      ) : (
        <button onClick={() => setEditing(blank())} className="w-full flex items-center justify-center gap-1 py-1.5 rounded border border-dashed border-gray-600 text-gray-400 hover:text-white hover:border-gray-400 text-xs">
          <Plus size={13} /> 新增规则
        </button>
      )}
    </div>
  );
}

function RuleEditor({ rule, onSave, onCancel }: { rule: AutoInputRule; onSave: (r: AutoInputRule) => void; onCancel: () => void }) {
  const [draft, setDraft] = useState<AutoInputRule>(rule);
  return (
    <div className="border border-purple-600/50 rounded p-2 bg-gray-850 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs text-gray-300">规则编辑</span>
        <button onClick={onCancel} className="text-gray-500 hover:text-white"><X size={13} /></button>
      </div>
      <input
        value={draft.keyword}
        onChange={(e) => setDraft({ ...draft, keyword: e.target.value })}
        placeholder="触发关键词 / 正则"
        className="w-full px-2 py-1 text-xs bg-gray-800 border border-gray-700 rounded focus:outline-none focus:border-purple-500"
      />
      <textarea
        value={draft.reply}
        onChange={(e) => setDraft({ ...draft, reply: e.target.value })}
        placeholder="命中后自动发送的内容（如 yes / 继续）"
        rows={2}
        className="w-full px-2 py-1 text-xs bg-gray-800 border border-gray-700 rounded resize-none focus:outline-none focus:border-purple-500"
      />
      <div className="flex items-center gap-3 text-[11px] text-gray-400">
        <label className="flex items-center gap-1 cursor-pointer">
          <input type="checkbox" checked={!!draft.useRegex} onChange={(e) => setDraft({ ...draft, useRegex: e.target.checked })} /> 正则
        </label>
        <label className="flex items-center gap-1 cursor-pointer">
          <input type="checkbox" checked={!!draft.once} onChange={(e) => setDraft({ ...draft, once: e.target.checked })} /> 仅一次
        </label>
        <button
          onClick={() => { if (draft.keyword.trim() && draft.reply.trim()) onSave(draft); }}
          disabled={!draft.keyword.trim() || !draft.reply.trim()}
          className="ml-auto px-3 py-1 rounded bg-purple-600 hover:bg-purple-500 text-white disabled:opacity-40"
        >
          保存
        </button>
      </div>
    </div>
  );
}
