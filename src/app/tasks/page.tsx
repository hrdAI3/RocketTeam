'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw, ChevronDown, ChevronRight, Loader2, FolderKanban } from 'lucide-react';
import { useToast } from '../../components/Toast';
import type { Task, PMADecisionV2 } from '@/types';

// Projects — the record of tasks dispatched via the CLI (`team:dispatch`),
// the simulation's predicted owners, and the leader's accept/override calls.
// This page does NOT create tasks. Lean: status segments + expandable rows.
// Each row is a one-line summary by default; expand to see the breakdown.

type Status = Task['status'];

const STATUS_META: Record<Status, { label: string; dot: string; pill: string; rank: number }> = {
  predicting: { label: 'Predicting', dot: 'bg-sky', pill: 'bg-sky/10 text-sky', rank: 1 },
  predicted: { label: 'Awaiting decision', dot: 'bg-amber', pill: 'bg-amber/10 text-amber', rank: 0 },
  accepted: { label: 'Accepted', dot: 'bg-forest', pill: 'bg-forest/10 text-forest', rank: 2 },
  overridden: { label: 'Reassigned', dot: 'bg-coral', pill: 'bg-coral-subtle text-coral-deep', rank: 2 },
  completed: { label: 'Done', dot: 'bg-ink-quiet', pill: 'bg-paper-subtle text-ink-muted', rank: 3 }
};

type Filter = 'all' | Status;
const FILTER_ORDER: Filter[] = ['all', 'predicted', 'predicting', 'accepted', 'overridden', 'completed'];
const FILTER_LABEL: Record<Filter, string> = {
  all: 'All',
  predicting: 'Predicting',
  predicted: 'Awaiting decision',
  accepted: 'Accepted',
  overridden: 'Reassigned',
  completed: 'Done'
};

function ageStr(iso: string | null | undefined): string {
  if (!iso) return '';
  const min = (Date.now() - Date.parse(iso)) / 60000;
  if (min < 1) return 'just now';
  if (min < 60) return `${Math.round(min)}m ago`;
  if (min < 24 * 60) return `${Math.round(min / 60)}h ago`;
  return `${Math.round(min / 60 / 24)}d ago`;
}
// One date format across the app: short month + day.
function fmtDate(s: string | null | undefined): string {
  if (!s) return '';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

function v2(d: Task['decision']): PMADecisionV2 | null {
  if (!d) return null;
  if ('decomposition' in d || 'sim_replay_id' in d) return d as PMADecisionV2;
  return null;
}

function assigneesOf(t: Task): string[] {
  if (t.status === 'overridden' && t.override_to) return [t.override_to];
  const d = v2(t.decision);
  if (!d) return [];
  if (d.decomposition?.length) {
    const set = new Set<string>();
    for (const s of d.decomposition) if (s.assignee) set.add(s.assignee);
    return [...set];
  }
  if (d.top1) return [d.top1];
  return [];
}

function simIdOf(t: Task): string | null {
  if (t.sim_id) return t.sim_id;
  const d = v2(t.decision);
  return d?.sim_replay_id ?? null;
}

export default function ProjectsPage() {
  const toast = useToast();
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [agentNames, setAgentNames] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    document.title = 'Projects · Rocket Team';
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [tRes, aRes] = await Promise.all([
        fetch('/api/tasks', { cache: 'no-store' }),
        fetch('/api/agents', { cache: 'no-store' })
      ]);
      if (tRes.ok) setTasks(((await tRes.json()) as { tasks: Task[] }).tasks);
      if (aRes.ok) {
        const a = (await aRes.json()) as { agents: Array<{ name: string; tier?: string; _error?: string }> };
        setAgentNames(a.agents.filter((x) => !x._error && x.tier !== 'stub').map((x) => x.name));
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

  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: tasks?.length ?? 0, predicting: 0, predicted: 0, accepted: 0, overridden: 0, completed: 0 };
    for (const t of tasks ?? []) c[t.status] = (c[t.status] ?? 0) + 1;
    return c;
  }, [tasks]);

  const visible = useMemo(() => {
    if (!tasks) return null;
    const list = filter === 'all' ? tasks : tasks.filter((t) => t.status === filter);
    return [...list].sort((a, b) => {
      const r = STATUS_META[a.status].rank - STATUS_META[b.status].rank;
      if (r !== 0) return r;
      return Date.parse(b.created_at ?? '0') - Date.parse(a.created_at ?? '0');
    });
  }, [tasks, filter]);

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const onAccept = async (taskId: string) => {
    try {
      const res = await fetch(`/api/tasks/${taskId}/accept`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      if (!res.ok) {
        const e = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(e.error ?? `accept ${res.status}`);
      }
      toast.push('Accepted', 'success');
      void refresh();
    } catch (err) {
      toast.push((err as Error).message, 'error');
    }
  };

  const onOverride = async (taskId: string, target: string) => {
    try {
      const res = await fetch(`/api/tasks/${taskId}/override`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ override_to: target })
      });
      if (!res.ok) throw new Error(`override ${res.status}`);
      toast.push(`Reassigned → ${target}`, 'success');
      void refresh();
    } catch (err) {
      toast.push((err as Error).message, 'error');
    }
  };

  return (
    <div className="px-12 py-10 max-w-[1040px] mx-auto">
      <header className="flex items-end justify-between gap-4 mb-3">
        <div>
          <div className="eyebrow mb-2">Rocket Team / Projects</div>
          <h1 className="display-title">Projects</h1>
        </div>
        <button onClick={refresh} aria-label="Refresh" className="p-2 rounded-md text-ink-quiet hover:text-ink hover:bg-paper-subtle transition-colors mb-0.5">
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
        </button>
      </header>
      <div className="mb-6" />

      {error && (
        <div className="rounded-xl border border-rust bg-paper-card p-4 mb-6 text-body text-ink">
          {error} <button onClick={refresh} className="ml-3 link-coral">Retry</button>
        </div>
      )}

      {/* Status segments — only shown when there are tasks. "All" + the active
          filter always present; otherwise only non-empty statuses (no dead "0" tabs). */}
      {tasks && tasks.length > 0 && (
        <div className="flex items-end gap-1 mb-5 border-b border-rule">
          {FILTER_ORDER.filter((f) => f === 'all' || f === filter || counts[f] > 0).map((f) => {
            const active = filter === f;
            const n = counts[f];
            return (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`px-3.5 py-2 text-[13.5px] transition-colors border-b-2 -mb-px ${
                  active ? 'border-coral text-coral-deep font-medium' : 'border-transparent text-ink-muted hover:text-ink'
                }`}
              >
                {FILTER_LABEL[f]}
                <span className={`ml-1.5 font-mono text-[10.5px] tabular-nums ${active ? 'text-coral' : 'text-ink-quiet'}`}>{n}</span>
              </button>
            );
          })}
        </div>
      )}

      {loading && !tasks && (
        <div className="rounded-xl border border-rule overflow-hidden divide-y divide-rule">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-12 bg-paper-card animate-pulse" />
          ))}
        </div>
      )}

      {!loading && tasks && tasks.length === 0 && (
        <div className="rounded-xl border border-dashed border-rule bg-paper-card px-8 py-16 text-center">
          <FolderKanban size={24} strokeWidth={1.6} className="text-ink-ghost mx-auto mb-3" />
          <p className="font-serif text-[18px] text-ink mb-1.5">No tasks yet</p>
          <p className="text-[13px] text-ink-muted leading-relaxed max-w-md mx-auto">
            After scoping a task in Claude Code, dispatch it with{' '}
            <code className="font-mono text-[12px] px-1.5 py-0.5 bg-paper-subtle rounded">team:dispatch &quot;task description&quot;</code>.{' '}
            PMA will simulate the best owner and surface the recommendation here for you to decide.
          </p>
        </div>
      )}

      {!loading && visible && visible.length === 0 && tasks && tasks.length > 0 && (
        <div className="rounded-xl border border-dashed border-rule p-10 text-center bg-paper-card text-ink-muted text-[13px]">
          No tasks in this state.
        </div>
      )}

      {!loading && visible && visible.length > 0 && (
        <div className="rounded-xl border border-rule overflow-hidden divide-y divide-rule">
          {visible.map((t) => (
            <TaskRow
              key={t.id}
              task={t}
              expanded={expanded.has(t.id)}
              onToggle={() => toggle(t.id)}
              agentNames={agentNames}
              onAccept={() => onAccept(t.id)}
              onOverride={(to) => onOverride(t.id, to)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function TaskRow({
  task,
  expanded,
  onToggle,
  agentNames,
  onAccept,
  onOverride
}: {
  task: Task;
  expanded: boolean;
  onToggle: () => void;
  agentNames: string[];
  onAccept: () => void;
  onOverride: (to: string) => void;
}) {
  const meta = STATUS_META[task.status];
  const assignees = assigneesOf(task);
  const decision = v2(task.decision);
  const simId = simIdOf(task);
  const [picking, setPicking] = useState(false);

  return (
    <div className={task.status === 'predicted' ? 'bg-amber/[0.03]' : 'bg-paper-card'}>
      <button onClick={onToggle} className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-paper-subtle transition-colors">
        <span className={`text-[10px] px-1.5 py-0.5 rounded font-mono shrink-0 ${meta.pill}`}>{meta.label}</span>
        <span className="text-[14px] text-ink truncate flex-1 min-w-0">{task.description}</span>
        {task.status === 'predicting' ? (
          <span className="text-[11.5px] text-sky inline-flex items-center gap-1 shrink-0"><Loader2 size={11} className="animate-spin" /> Predicting</span>
        ) : assignees.length > 0 ? (
          <span className="text-[12px] text-ink-soft shrink-0 max-w-[12rem] truncate">→ {assignees.join(', ')}</span>
        ) : null}
        <span className="text-[11.5px] text-ink-quiet shrink-0 w-20 text-right tabular-nums">{ageStr(task.created_at)}</span>
        {expanded ? <ChevronDown size={14} className="text-ink-quiet shrink-0" /> : <ChevronRight size={14} className="text-ink-quiet shrink-0" />}
      </button>

      {/* Awaiting decision: inline accept / reassign under the row */}
      {task.status === 'predicted' && (
        <div className="px-4 pb-3 -mt-1 flex items-center gap-2 flex-wrap">
          {typeof decision?.confidence === 'number' && (
            <span className="text-[11px] text-ink-quiet tabular-nums">confidence {Math.round(decision.confidence * 100)}%</span>
          )}
          <button onClick={onAccept} className="text-[12px] px-2.5 py-1 rounded-md bg-forest/10 text-forest hover:bg-forest/15 transition-colors">Accept</button>
          {!picking ? (
            <button onClick={() => setPicking(true)} className="text-[12px] px-2.5 py-1 rounded-md border border-rule text-ink-muted hover:border-rule-strong transition-colors">Reassign…</button>
          ) : (
            <select
              autoFocus
              onChange={(e) => {
                if (e.target.value) onOverride(e.target.value);
                setPicking(false);
              }}
              onBlur={() => setPicking(false)}
              className="text-[12px] px-2 py-1 rounded-md border border-rule bg-paper-card text-ink"
              defaultValue=""
            >
              <option value="" disabled>Reassign to…</option>
              {agentNames.map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          )}
        </div>
      )}

      {/* Expanded: the breakdown the leader needs at a glance — facts +
          simulated split. The full reasoning prose lives behind the replay link. */}
      {expanded && (
        <div className="px-4 pb-4 pt-1 border-t border-rule-soft bg-paper-subtle/30">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-x-6 gap-y-2 text-[12.5px] mb-3">
            {task.deadline && <KV label="Due" value={fmtDate(task.deadline)} />}
            {task.importance && task.urgency && (
              <KV label="Priority" value={`${task.importance === 'high' ? 'Important' : 'Not important'} · ${task.urgency === 'high' ? 'Urgent' : 'Not urgent'}`} />
            )}
            {typeof decision?.confidence === 'number' && <KV label="Confidence" value={`${Math.round(decision.confidence * 100)}%`} tabular />}
            {task.override_reason && <KV label="Reassign reason" value={task.override_reason} />}
          </div>
          {(() => {
            const rows =
              decision?.decomposition && decision.decomposition.length > 0
                ? decision.decomposition.map((s) => ({ assignee: s.assignee, subtask: s.subtask }))
                : decision?.top1
                  ? [{ assignee: decision.top1, subtask: decision.top1_subtask?.subtask ?? '' }]
                  : [];
            if (rows.length === 0) return null;
            return (
              <div>
                <div className="eyebrow mb-1.5">Simulated split</div>
                <ul className="space-y-1">
                  {rows.map((r, i) => (
                    <li key={i} className="text-[13px] text-ink-soft flex gap-2">
                      <span className="font-serif text-ink shrink-0">{r.assignee}</span>
                      {r.subtask && (
                        <>
                          <span className="text-ink-quiet">·</span>
                          <span className="leading-snug">{r.subtask}</span>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            );
          })()}
          {simId && (
            <a href={`/sim/${simId}`} className="text-[12px] link-coral mt-3 inline-flex items-center gap-0.5">
              Open simulation (rationale and risks) <ChevronRight size={11} />
            </a>
          )}
        </div>
      )}
    </div>
  );
}

function KV({ label, value, tabular }: { label: string; value: string; tabular?: boolean }) {
  return (
    <div>
      <span className="text-ink-quiet text-[11px]">{label}</span>
      <div className={`text-ink mt-0.5${tabular ? ' tabular-nums' : ''}`}>{value}</div>
    </div>
  );
}
