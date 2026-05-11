'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import { TaskCard } from '../../components/TaskCard';
import { TaskCardSkeleton } from '../../components/Skeleton';
import { useToast } from '../../components/Toast';
import { useNewTask } from '../../components/NewTaskModal';
import type { Task, Department, Priority } from '@/types';
import { computePriority } from '@/types';

type StatusFilter = 'all' | 'predicting' | 'predicted' | 'accepted' | 'overridden' | 'completed';
type PriorityFilter = 'all' | Priority;

const FILTER_LABEL: Record<StatusFilter, string> = {
  all: '全部',
  predicting: '推演中',
  predicted: '已推演',
  accepted: '已采纳',
  overridden: '已修改',
  completed: '已完成'
};

const PRIORITY_FILTER_LABEL: Record<PriorityFilter, string> = {
  all: '全部优先级',
  P0: 'P0 · 重要+紧急',
  P1: 'P1 · 重要+不紧急',
  P2: 'P2 · 不重要+紧急',
  P3: 'P3 · 不重要+不紧急'
};

export default function TasksPage() {
  const toast = useToast();
  const { open: openNewTask } = useNewTask();
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [agentNames, setAgentNames] = useState<string[]>([]);
  const [deptMap, setDeptMap] = useState<Record<string, Department>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [pFilter, setPFilter] = useState<PriorityFilter>('all');

  const refresh = useCallback(async () => {
    try {
      const [tRes, aRes] = await Promise.all([
        fetch('/api/tasks', { cache: 'no-store' }),
        fetch('/api/agents', { cache: 'no-store' })
      ]);
      if (tRes.ok) {
        const t = (await tRes.json()) as { tasks: Task[] };
        setTasks(t.tasks);
      }
      if (aRes.ok) {
        const a = (await aRes.json()) as {
          agents: Array<{ name: string; tier?: string; dept?: Department; _error?: string }>;
        };
        const real = a.agents.filter((x) => !x._error);
        setAgentNames(real.filter((x) => x.tier !== 'stub').map((x) => x.name));
        const map: Record<string, Department> = {};
        for (const x of real) if (x.dept) map[x.name] = x.dept;
        setDeptMap(map);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const stats = useMemo(() => {
    const counts: Record<StatusFilter, number> = {
      all: tasks?.length ?? 0,
      predicting: 0,
      predicted: 0,
      accepted: 0,
      overridden: 0,
      completed: 0
    };
    let confSum = 0;
    let confN = 0;
    let decompCount = 0;
    const dailyTasks: Record<string, number> = {};
    const dailyOverrides: Record<string, number> = {};
    const last7Keys: string[] = [];
    const today = new Date();
    for (let i = 6; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const k = d.toISOString().slice(0, 10);
      last7Keys.push(k);
      dailyTasks[k] = 0;
      dailyOverrides[k] = 0;
    }

    for (const t of tasks ?? []) {
      counts[t.status as StatusFilter] = (counts[t.status as StatusFilter] ?? 0) + 1;
      const c = (t.decision as { confidence?: number })?.confidence;
      if (typeof c === 'number') {
        confSum += c;
        confN += 1;
      }
      const decomp = (t.decision as { decomposition?: unknown[] })?.decomposition;
      if (decomp && (decomp as unknown[]).length > 0) decompCount += 1;
      const day = (t.created_at ?? '').slice(0, 10);
      if (day in dailyTasks) {
        dailyTasks[day] = (dailyTasks[day] ?? 0) + 1;
        if (t.status === 'overridden') dailyOverrides[day] = (dailyOverrides[day] ?? 0) + 1;
      }
    }
    const acceptedRate = counts.all > 0 ? counts.accepted / counts.all : 0;
    const overrideRate = counts.all > 0 ? counts.overridden / counts.all : 0;
    const avgConf = confN > 0 ? confSum / confN : 0;

    return {
      counts,
      acceptedRate,
      overrideRate,
      avgConf,
      decompCount,
      last7Keys,
      dailyTasks,
      dailyOverrides
    };
  }, [tasks]);

  const filteredTasks = useMemo(() => {
    if (!tasks) return null;
    let result = tasks;
    if (filter !== 'all') result = result.filter((t) => t.status === filter);
    if (pFilter !== 'all') {
      result = result.filter((t) => {
        if (!t.importance || !t.urgency) return false;
        return computePriority(t.importance, t.urgency) === pFilter;
      });
    }
    return result;
  }, [tasks, filter, pFilter]);

  const pCounts = useMemo(() => {
    const c: Record<PriorityFilter, number> = { all: tasks?.length ?? 0, P0: 0, P1: 0, P2: 0, P3: 0 };
    for (const t of tasks ?? []) {
      if (t.importance && t.urgency) {
        c[computePriority(t.importance, t.urgency)] += 1;
      }
    }
    return c;
  }, [tasks]);

  const onOverride = async (taskId: string, target: string, reason?: string) => {
    try {
      const res = await fetch(`/api/tasks/${taskId}/override`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ override_to: target, reason })
      });
      if (!res.ok) throw new Error(`override ${res.status}`);
      toast.push(`已改派 → ${target}`, 'success');
      void refresh();
    } catch (err) {
      toast.push((err as Error).message, 'error');
    }
  };

  const onAccept = async (taskId: string) => {
    try {
      const res = await fetch(`/api/tasks/${taskId}/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      if (!res.ok) {
        const e = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(e.error ?? `accept ${res.status}`);
      }
      toast.push('已采纳', 'success');
      void refresh();
    } catch (err) {
      toast.push((err as Error).message, 'error');
    }
  };

  return (
    <div className="px-12 py-10 max-w-[1100px] mx-auto">
      {/* Hero */}
      <header className="flex items-end justify-between mb-8">
        <div className="max-w-2xl">
          <div className="eyebrow mb-2">Rocket Team / 任务</div>
          <h1 className="display-title">任务看板</h1>
          <p className="prose-warm text-body text-ink-muted mt-3">
            任务的推荐分工、当前进展、置信度、改派与采纳记录全部留痕。
          </p>
        </div>
        <button onClick={openNewTask} className="btn-coral flex items-center gap-1.5">
          <Plus size={13} />
          新任务
          <kbd className="ml-1 font-mono text-[10px] px-1 py-0.5 bg-white/20 rounded">⌘N</kbd>
        </button>
      </header>

      {error && (
        <div className="card-surface border-rust p-4 mb-6 text-body text-ink">{error}</div>
      )}

      {/* Stats strip */}
      {tasks && tasks.length > 0 && (
        <section className="mb-6">
          <div className="grid grid-cols-12 gap-px bg-rule rounded-xl overflow-hidden border border-rule">
            <StatCell
              col={3}
              label="任务总数"
              value={stats.counts.all}
              caption={`其中 ${stats.decompCount} 个被拆分`}
            />
            <StatCell
              col={3}
              label="平均置信度"
              value={`${Math.round(stats.avgConf * 100)}%`}
              caption="决策可信度均值"
              accent
            />
            <StatCell
              col={3}
              label="采纳率"
              value={`${Math.round(stats.acceptedRate * 100)}%`}
              caption={`${stats.counts.accepted} / ${stats.counts.all} 直接采用`}
            />
            <StatCell
              col={3}
              label="改派率"
              value={`${Math.round(stats.overrideRate * 100)}%`}
              caption={`${stats.counts.overridden} 个被人工改派`}
            />
          </div>
          <div className="mt-3">
            <Sparkline
              keys={stats.last7Keys}
              values={stats.last7Keys.map((k) => stats.dailyTasks[k] ?? 0)}
              overrides={stats.last7Keys.map((k) => stats.dailyOverrides[k] ?? 0)}
            />
          </div>
        </section>
      )}

      {/* Priority filter row */}
      <div className="flex flex-wrap gap-2 mb-3">
        {(['all', 'P0', 'P1', 'P2', 'P3'] as PriorityFilter[]).map((p) => {
          const active = pFilter === p;
          const n = pCounts[p];
          return (
            <button
              key={p}
              onClick={() => setPFilter(p)}
              className={`px-2.5 py-1 text-[12px] rounded-full border transition-all ${
                active
                  ? p === 'P0'
                    ? 'border-rust bg-rust/10 text-rust'
                    : p === 'P1'
                      ? 'border-amber bg-amber/10 text-amber'
                      : p === 'P2'
                        ? 'border-coral bg-coral-subtle text-coral-deep'
                        : 'border-ink-muted bg-paper-subtle text-ink'
                  : 'border-rule bg-paper-card text-ink-muted hover:border-rule-strong'
              }`}
            >
              {PRIORITY_FILTER_LABEL[p]}{' '}
              <span className="font-mono text-[10.5px] opacity-70">{n}</span>
            </button>
          );
        })}
      </div>

      {/* Status filter tabs */}
      <section>
        <div className="flex items-end justify-between mb-4 border-b border-rule">
          <nav className="flex items-end gap-1">
            {(['all', 'predicting', 'predicted', 'accepted', 'overridden', 'completed'] as StatusFilter[]).map(
              (f) => {
                const active = filter === f;
                const n = stats.counts[f];
                return (
                  <button
                    key={f}
                    onClick={() => setFilter(f)}
                    className={`px-3.5 py-2 text-[13.5px] transition-colors border-b-2 -mb-px ${
                      active
                        ? 'border-coral text-coral-deep font-medium'
                        : 'border-transparent text-ink-muted hover:text-ink'
                    }`}
                  >
                    {FILTER_LABEL[f]}
                    <span
                      className={`ml-1.5 font-mono text-[10.5px] ${
                        active ? 'text-coral' : 'text-ink-quiet'
                      }`}
                    >
                      {n}
                    </span>
                  </button>
                );
              }
            )}
          </nav>
          {filteredTasks && (
            <span className="pb-2 font-mono text-[11px] text-ink-quiet">
              {filteredTasks.length} 条
            </span>
          )}
        </div>

        {loading && (
          <div className="space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <TaskCardSkeleton key={i} />
            ))}
          </div>
        )}

        {!loading && tasks && tasks.length === 0 && (
          <div className="rounded-2xl border border-dashed border-rule p-16 text-center bg-paper-card">
            <p className="font-serif text-title text-ink mb-2">尚无任务</p>
            <p className="text-body text-ink-muted mb-5">
              点击「新任务」或按 ⌘N 启动你的第一次推演。
            </p>
            <button onClick={openNewTask} className="btn-coral inline-flex items-center gap-1.5">
              <Plus size={13} /> 新任务
            </button>
          </div>
        )}

        {!loading &&
          filteredTasks &&
          filteredTasks.length === 0 &&
          tasks &&
          tasks.length > 0 && (
            <div className="rounded-xl border border-dashed border-rule p-12 text-center bg-paper-card">
              <p className="text-body text-ink-muted">该状态下暂无任务。</p>
            </div>
          )}

        {!loading && filteredTasks && filteredTasks.length > 0 && (
          <div className="space-y-3">
            {filteredTasks.map((t) => (
              <TaskCard
                key={t.id}
                task={t}
                agentChoices={agentNames}
                onOverride={onOverride}
                onAccept={onAccept}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function StatCell({
  col,
  label,
  value,
  caption,
  accent
}: {
  col: number;
  label: string;
  value: number | string;
  caption?: string;
  accent?: boolean;
}) {
  return (
    <div className="bg-paper-card px-5 py-4" style={{ gridColumn: `span ${col}` }}>
      <div className={`font-serif text-[32px] leading-none ${accent ? 'text-coral' : 'text-ink'}`}>
        {value}
      </div>
      <div className="eyebrow mt-2">{label}</div>
      {caption && <div className="text-[11px] text-ink-quiet mt-1.5">{caption}</div>}
    </div>
  );
}

function Sparkline({
  keys,
  values,
  overrides
}: {
  keys: string[];
  values: number[];
  overrides: number[];
}) {
  const max = Math.max(1, ...values);
  return (
    <div className="card-warm p-4">
      <div className="flex items-baseline justify-between mb-3">
        <div className="eyebrow">最近 7 天 · 推演趋势</div>
        <div className="flex items-center gap-3 text-[10.5px] text-ink-quiet">
          <span className="inline-flex items-center gap-1.5">
            <span className="w-2 h-2 rounded bg-coral" />
            新增任务
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="w-2 h-2 rounded bg-amber" />
            被改派
          </span>
        </div>
      </div>
      <div className="flex items-end gap-2 h-20">
        {keys.map((k, i) => {
          const v = values[i];
          const o = overrides[i];
          const h = (v / max) * 100;
          const oh = v > 0 ? (o / v) * h : 0;
          return (
            <div key={k} className="flex-1 flex flex-col items-center gap-1.5">
              <div className="relative w-full bg-paper-deep rounded-md flex flex-col-reverse" style={{ height: `${Math.max(2, h)}%` }}>
                <div className="bg-coral rounded-md w-full h-full" />
                {oh > 0 && (
                  <div
                    className="bg-amber absolute left-0 right-0 bottom-0 rounded-b-md"
                    style={{ height: `${oh}%` }}
                  />
                )}
              </div>
              <div className="text-[10px] font-mono text-ink-quiet tabular-nums">{v}</div>
            </div>
          );
        })}
      </div>
      <div className="flex justify-between mt-1 text-[9.5px] font-mono text-ink-ghost">
        {keys.map((k) => (
          <span key={k} className="flex-1 text-center">
            {k.slice(5)}
          </span>
        ))}
      </div>
    </div>
  );
}
