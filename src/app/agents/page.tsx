'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { PersonAgentCard } from '../../components/PersonAgentCard';
import { AgentCardSkeleton } from '../../components/Skeleton';
import { BootstrapModal } from '../../components/BootstrapModal';
import { useToast } from '../../components/Toast';
import type { TeamMemberProfile, Department } from '@/types';

type AgentItem = TeamMemberProfile | { name: string; _error: string };
type DeptFilter = 'all' | Department;
type WorkloadFilter = 'all' | 'blocked' | 'active' | 'idle';

const DEPT_ORDER: Department[] = ['老板', '研发', '产品', '职能', '运营'];
const WORKLOAD_TABS: Array<{ key: WorkloadFilter; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'active', label: '忙碌' },
  { key: 'idle', label: '空闲' },
  { key: 'blocked', label: '阻塞' }
];

// Classify by workload only — current_tasks is narrative (LLM-inferred from
// meetings), not telemetry. Spec §0.2 + §3.3 require workload-based filtering
// so the "有任务" tab count cannot be inflated by model speculation.
function classifyWorkload(p: TeamMemberProfile): Exclude<WorkloadFilter, 'all'> {
  if ((p.workload?.blocked_on?.length ?? 0) > 0) return 'blocked';
  if ((p.workload?.active?.length ?? 0) > 0) return 'active';
  return 'idle';
}

const NAME_COLLATOR = new Intl.Collator('zh-Hans-CN', { sensitivity: 'base' });

const WORKLOAD_RANK: Record<Exclude<WorkloadFilter, 'all'>, number> = {
  blocked: 0,
  active: 1,
  idle: 2
};

function compareMembers(a: TeamMemberProfile, b: TeamMemberProfile): number {
  const rankDiff = WORKLOAD_RANK[classifyWorkload(a)] - WORKLOAD_RANK[classifyWorkload(b)];
  if (rankDiff !== 0) return rankDiff;
  // Within the same workload bucket: leads first, then surname.
  const aLead = (a.role ?? '').includes('负责人') ? 0 : 1;
  const bLead = (b.role ?? '').includes('负责人') ? 0 : 1;
  if (aLead !== bLead) return aLead - bLead;
  return NAME_COLLATOR.compare(a.name, b.name);
}

function daysSince(iso: string | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / (24 * 60 * 60 * 1000)));
}

export default function AgentsPage() {
  const toast = useToast();
  const [agents, setAgents] = useState<AgentItem[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [bootstrapOpen, setBootstrapOpen] = useState(false);
  const [bootstrapClear, setBootstrapClear] = useState(false);
  const [workloadFilter, setWorkloadFilter] = useState<WorkloadFilter>('all');
  const [deptFilter, setDeptFilter] = useState<DeptFilter>('all');

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/agents', { cache: 'no-store' });
      if (!res.ok) throw new Error(`Failed: ${res.status}`);
      const data = (await res.json()) as { agents: AgentItem[] };
      setAgents(data.agents);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const realAgents = useMemo(
    () => (agents ?? []).filter((a): a is TeamMemberProfile => !('_error' in a)),
    [agents]
  );

  const totalReal = realAgents.length;

  const stats = useMemo(() => {
    let withCC = 0;
    let withActive = 0;
    let blockedTotal = 0;
    let oldestStaleDays: number | null = null;
    for (const a of realAgents) {
      if (a.agents?.claude_code) withCC++;
      if ((a.workload?.active?.length ?? 0) > 0) withActive++;
      blockedTotal += a.workload?.blocked_on?.length ?? 0;
      const d = daysSince(a._meta?.bootstrapped_at);
      if (d !== null && (oldestStaleDays === null || d > oldestStaleDays)) oldestStaleDays = d;
    }
    return { withCC, withActive, blockedTotal, oldestStaleDays };
  }, [realAgents]);

  const workloadCounts = useMemo(() => {
    const c = { blocked: 0, active: 0, idle: 0 };
    for (const a of realAgents) c[classifyWorkload(a)]++;
    return c;
  }, [realAgents]);

  const deptCounts = useMemo(() => {
    const map: Record<string, number> = { all: realAgents.length };
    for (const d of DEPT_ORDER) map[d] = 0;
    for (const a of realAgents) {
      if (a.dept) map[a.dept] = (map[a.dept] ?? 0) + 1;
    }
    return map;
  }, [realAgents]);

  const visible = useMemo(() => {
    let list = realAgents;
    if (deptFilter !== 'all') list = list.filter((a) => a.dept === deptFilter);
    if (workloadFilter !== 'all') list = list.filter((a) => classifyWorkload(a) === workloadFilter);
    return [...list].sort(compareMembers);
  }, [realAgents, deptFilter, workloadFilter]);

  const empty = !loading && totalReal === 0;
  const corruptedNames = (agents ?? []).filter(
    (a): a is { name: string; _error: string } => '_error' in a
  );

  return (
    <div className="px-12 py-10 max-w-[1100px] mx-auto">
      <header className="flex items-end justify-between mb-10">
        <div className="max-w-2xl">
          <div className="eyebrow mb-2">Rocket Team / 团队</div>
          <h1 className="display-title">团队成员</h1>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => {
              if (!confirm('清空全部成员画像重新生成？\n已有 evolution 历史会丢失。')) return;
              setBootstrapClear(true);
              setBootstrapOpen(true);
            }}
            className="btn-ghost flex items-center gap-1.5"
          >
            <RefreshCw size={12} /> 重建画像
          </button>
          {empty && (
            <button
              onClick={() => {
                setBootstrapClear(false);
                setBootstrapOpen(true);
              }}
              className="btn-coral"
            >
              立即生成
            </button>
          )}
        </div>
      </header>

      {totalReal > 0 && (
        <section className="mb-8">
          <div className="grid grid-cols-2 lg:grid-cols-12 gap-px bg-rule rounded-xl overflow-hidden border border-rule">
            <Stat
              label="团队 / 已配 CC"
              value={`${totalReal} / ${stats.withCC}`}
              caption="每人配 1 个 Claude Code"
            />
            <Stat
              label="画像中有 active 任务"
              value={stats.withActive}
              caption={`${totalReal} 中 ${stats.withActive} 人画像里挂着 active`}
              accent
            />
            <Stat
              label="阻塞任务"
              value={stats.blockedTotal}
              caption={stats.blockedTotal > 0 ? '需要 leader 介入' : '无阻塞'}
              tone={stats.blockedTotal > 0 ? 'warn' : 'neutral'}
            />
            <Stat
              label="画像首建至今"
              value={stats.oldestStaleDays === null ? '—' : `${stats.oldestStaleDays} 天`}
              caption={
                stats.oldestStaleDays === null ? '尚未生成' : '最久未 bootstrap 的人'
              }
            />
          </div>
        </section>
      )}

      {totalReal > 0 && (
        <div className="mb-6 flex items-end justify-between gap-4 border-b border-rule">
          <nav className="flex items-end gap-1 flex-wrap">
            {WORKLOAD_TABS.map(({ key, label }) => {
              const active = workloadFilter === key;
              const n = key === 'all' ? totalReal : workloadCounts[key];
              const isWarn = key === 'blocked' && n > 0;
              const ariaLabel = isWarn ? `${label}（需介入）${n}` : `${label} ${n}`;
              return (
                <button
                  key={key}
                  onClick={() => setWorkloadFilter(key)}
                  aria-label={ariaLabel}
                  aria-pressed={active}
                  className={`px-3.5 py-2 text-[13.5px] transition-colors border-b-2 -mb-px inline-flex items-center gap-1.5 ${
                    active
                      ? isWarn
                        ? 'border-amber text-amber font-medium'
                        : 'border-coral text-coral-deep font-medium'
                      : isWarn
                        ? 'border-transparent text-amber hover:text-amber'
                        : 'border-transparent text-ink-muted hover:text-ink'
                  }`}
                >
                  {isWarn && (
                    <AlertTriangle size={12} strokeWidth={2.4} aria-hidden="true" />
                  )}
                  {label}
                  <span
                    className={`font-mono text-[10.5px] ${
                      active ? (isWarn ? 'text-amber' : 'text-coral') : 'text-ink-quiet'
                    }`}
                  >
                    {n}
                  </span>
                </button>
              );
            })}
          </nav>
          <div className="pb-2">
            <select
              value={deptFilter}
              onChange={(e) => setDeptFilter(e.target.value as DeptFilter)}
              className="text-[12px] bg-paper-card border border-rule rounded px-2 py-1 text-ink-soft hover:border-rule-strong focus:outline-none focus:border-coral"
              aria-label="按部门筛选"
            >
              <option value="all">所有部门 · {deptCounts.all ?? 0}</option>
              {DEPT_ORDER.map((d) => {
                const n = deptCounts[d] ?? 0;
                if (n === 0) return null;
                return (
                  <option key={d} value={d}>
                    {d} · {n}
                  </option>
                );
              })}
            </select>
          </div>
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-rust bg-paper-card p-4 mb-6 text-body text-ink">
          {error}
          <button onClick={refresh} className="ml-3 link-coral">重试</button>
        </div>
      )}

      {corruptedNames.length > 0 && (
        <div className="rounded-xl border border-amber bg-paper-card p-4 mb-6 text-body text-ink">
          {corruptedNames.length} 个画像损坏：{corruptedNames.map((c) => c.name).join('，')}。
          <button
            onClick={() => {
              setBootstrapClear(true);
              setBootstrapOpen(true);
            }}
            className="ml-3 link-coral"
          >
            重建
          </button>
        </div>
      )}

      {loading && (
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 auto-rows-fr">
          {Array.from({ length: 6 }).map((_, i) => (
            <AgentCardSkeleton key={i} />
          ))}
        </div>
      )}

      {empty && !loading && (
        <div className="rounded-2xl border border-dashed border-rule p-16 text-center bg-paper-card max-w-[800px]">
          <div className="font-serif text-title text-ink mb-2">还没有成员画像</div>
          <p className="text-body text-ink-muted mb-6 max-w-md mx-auto">
            系统会读取你接入的会议记录，为团队每位成员各建一份内部画像。
          </p>
          <button
            onClick={() => {
              setBootstrapClear(false);
              setBootstrapOpen(true);
            }}
            className="btn-coral"
          >
            立即生成
          </button>
        </div>
      )}

      {!loading && totalReal > 0 && visible.length === 0 && (
        <div className="rounded-xl border border-rule bg-paper-card p-10 text-center text-ink-muted">
          当前筛选下没有成员。
          <button
            onClick={() => {
              setWorkloadFilter('all');
              setDeptFilter('all');
            }}
            className="ml-2 link-coral"
          >
            清除筛选
          </button>
        </div>
      )}

      {!loading && visible.length > 0 && (
        <section>
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 auto-rows-fr">
            {visible.map((a) => (
              <PersonAgentCard key={a.name} profile={a} />
            ))}
          </div>
        </section>
      )}

      <BootstrapModal
        open={bootstrapOpen}
        clear={bootstrapClear}
        onClose={() => setBootstrapOpen(false)}
        onDone={(result) => {
          setBootstrapOpen(false);
          toast.push(`画像已生成 · ${result.agents_created.length} 人`, 'success');
          if (result.errors.length > 0) {
            toast.push(`${result.errors.length} 警告，看 console`, 'error');
          }
          void refresh();
        }}
      />
    </div>
  );
}

function Stat({
  label,
  value,
  caption,
  accent,
  tone
}: {
  label: string;
  value: number | string;
  caption?: string;
  accent?: boolean;
  tone?: 'warn' | 'neutral';
}) {
  const valueColor =
    tone === 'warn' ? 'text-amber' : accent ? 'text-coral' : 'text-ink';
  // Mobile: parent grid is grid-cols-2 → each stat occupies 1 of 2 (50%).
  // Desktop (lg): parent grid is grid-cols-12 → each stat spans 3 of 12 (25%).
  // Tailwind responsive classes are required so the grid actually reflows;
  // an inline `gridColumn` style would not respond to the breakpoint.
  return (
    <div className="bg-paper-card px-5 py-4 col-span-1 lg:col-span-3">
      <div className={`font-serif text-[28px] leading-none ${valueColor}`}>{value}</div>
      <div className="eyebrow mt-2">{label}</div>
      {caption && <div className="text-[11px] text-ink-quiet mt-1.5">{caption}</div>}
    </div>
  );
}
