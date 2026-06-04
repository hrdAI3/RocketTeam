'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { RefreshCw, ChevronDown, ChevronRight, Loader2, FolderKanban, FlaskConical, Zap } from 'lucide-react';
import type { Task, PMADecisionV2 } from '@/types';
import { Avatar } from '@/components/Avatar';
import { ConfidenceRing } from '@/components/ConfidenceRing';

// Projects — the record of tasks dispatched via the CLI (`team:dispatch`),
// the simulation's predicted owners, and the leader's accept/override calls.
// This page does NOT create tasks. Read-only board: aggregate strip + tab
// filter + a bordered list of rows. Each row links through to the full
// simulation trace at /predict/[task_id]; expand for the per-subtask breakdown.

type Status = Task['status'];

const STATUS_META: Record<Status, { label: string; dot: string; pill: string; rank: number }> = {
  predicting: { label: 'Simulating', dot: 'bg-sky', pill: 'bg-sky/10 text-sky', rank: 1 },
  predicted: { label: 'Awaiting decision', dot: 'bg-amber', pill: 'bg-amber/10 text-amber', rank: 0 },
  accepted: { label: 'Dispatched', dot: 'bg-forest', pill: 'bg-forest/10 text-forest', rank: 2 },
  overridden: { label: 'Reassigned', dot: 'bg-coral', pill: 'bg-coral-subtle text-coral-deep', rank: 2 },
  completed: { label: 'Done', dot: 'bg-ink-quiet', pill: 'bg-paper-subtle text-ink-muted', rank: 3 }
};

type Filter = 'all' | Status;
const FILTER_ORDER: Filter[] = ['all', 'predicted', 'predicting', 'accepted', 'overridden', 'completed'];
const FILTER_LABEL: Record<Filter, string> = {
  all: 'All',
  predicting: 'Simulating',
  predicted: 'Awaiting',
  accepted: 'Dispatched',
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
  // PMA v2 decisions always carry a `candidates` array (12 candidate scores).
  // Legacy detection via `decomposition` / `sim_replay_id` covered an older
  // simulator. Either marker → treat as v2.
  if ('candidates' in d || 'decomposition' in d || 'sim_replay_id' in d) {
    return d as PMADecisionV2;
  }
  return null;
}

// v2 stores top-level confidence as calibrated_confidence; older shape used
// confidence. Pick whichever is present.
function confOf(d: PMADecisionV2 | null): number | undefined {
  if (!d) return undefined;
  const dd = d as { calibrated_confidence?: number; confidence?: number };
  if (typeof dd.calibrated_confidence === 'number') return dd.calibrated_confidence;
  if (typeof dd.confidence === 'number') return dd.confidence;
  return undefined;
}

// v2 subtask_split rows — actionable per-subtask assignments. Typed loosely
// here because the field isn't declared on PMADecisionV2 (runtime-only shape).
type SubSplitRow = { subtask: string; suggested_owner?: string | null; alternatives: string[]; why?: string };
function subSplitOf(d: PMADecisionV2 | null): SubSplitRow[] | null {
  if (!d) return null;
  const rows = (d as { subtask_split?: SubSplitRow[] }).subtask_split;
  return rows && rows.length > 0 ? rows : null;
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
  const [tasks, setTasks] = useState<Task[] | null>(null);
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
      const tRes = await fetch('/api/tasks', { cache: 'no-store' });
      if (tRes.ok) setTasks(((await tRes.json()) as { tasks: Task[] }).tasks);
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

  // Accept / override happen in the CC chat via /dispatch, not here.
  // This page is read-only — observe predictions, click through to replay.

  // Aggregate strip — "Awaiting" is the cell the leader cares about, so it
  // owns more visual weight (amber tint + bigger number + pulsing dot when > 0).
  const strip = [
    { k: 'Awaiting', v: counts.predicted, dot: 'bg-amber', hero: true },
    { k: 'Simulating', v: counts.predicting, dot: 'bg-sky', hero: false },
    { k: 'Dispatched', v: counts.accepted, dot: 'bg-forest', hero: false },
    { k: 'Reassigned', v: counts.overridden, dot: 'bg-coral', hero: false },
    { k: 'Done', v: counts.completed, dot: 'bg-ink-quiet', hero: false }
  ];

  return (
    <div className="px-12 py-10 max-w-[1040px] mx-auto">
      <header className="flex items-end justify-between gap-4 mb-7">
        <div>
          <div className="eyebrow mb-2">Rocket Team / Dispatch</div>
          <h1 className="display-title">Dispatch</h1>
          <p className="text-[13px] text-ink-muted mt-2 max-w-xl leading-relaxed">
            Tasks dispatched via PMA v2. Click a row to inspect the full
            simulation trace. To dispatch, use{' '}
            <code className="font-mono text-[12px] px-1 py-0.5 mx-1 bg-paper-subtle rounded">/dispatch</code>{' '}
            inside Claude Code.
          </p>
        </div>
        <button onClick={refresh} aria-label="Refresh" className="p-2 rounded-md text-ink-quiet hover:text-ink hover:bg-paper-subtle transition-colors">
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
        </button>
      </header>

      {error && (
        <div className="rounded-xl border border-rust bg-paper-card p-4 mb-6 text-body text-ink">
          {error} <button onClick={refresh} className="ml-3 link-coral">Retry</button>
        </div>
      )}

      {/* Aggregate strip — 5 cells, "Awaiting" is the hero. Only shown when
          there are tasks. */}
      {tasks && tasks.length > 0 && (
        <div className="grid grid-cols-[1.5fr_1fr_1fr_1fr_1fr] rounded-xl border border-rule bg-paper-card overflow-hidden mb-6">
          {strip.map((s, i) => {
            const live = s.hero && s.v > 0;
            return (
              <div
                key={s.k}
                className={`flex flex-col gap-1 ${s.hero ? 'px-5 py-4' : 'px-4 py-3.5'} ${
                  i === 0 ? '' : 'border-l border-rule'
                } ${live ? 'bg-amber/[0.06]' : ''}`}
              >
                <div className="flex items-center gap-1.5">
                  <span className={`w-1.5 h-1.5 rounded-full ${s.dot} ${live ? 'animate-pulse-coral' : ''}`} />
                  <span className={`eyebrow ${live ? 'text-amber' : 'text-ink-quiet'}`}>{s.k}</span>
                </div>
                <span
                  className={`font-serif tabular-nums leading-none tracking-tight font-medium ${
                    s.hero ? 'text-[36px]' : 'text-[22px]'
                  } ${live ? 'text-amber' : 'text-ink'}`}
                >
                  {s.v}
                </span>
                {live && (
                  <span className="text-[11px] text-ink-muted mt-0.5">pending /dispatch accept or override</span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Tab filter — "All" + the active filter always present; otherwise only
          non-empty statuses (no dead "0" tabs). */}
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
            <div key={i} className="h-14 bg-paper-card animate-pulse" />
          ))}
        </div>
      )}

      {!loading && tasks && tasks.length === 0 && (
        <div className="rounded-xl border border-dashed border-rule bg-paper-card px-8 py-16 text-center">
          <FolderKanban size={24} strokeWidth={1.6} className="text-ink-ghost mx-auto mb-3" />
          <p className="font-serif text-[18px] text-ink mb-1.5">No tasks yet</p>
          <p className="text-[13px] text-ink-muted leading-relaxed max-w-md mx-auto">
            Dispatch from any Claude Code session with{' '}
            <code className="font-mono text-[12px] px-1.5 py-0.5 bg-paper-subtle rounded">/dispatch</code>.
            PMA simulates the 12-member team across three reasoning paths
            and hands the decision back to you.
          </p>
        </div>
      )}

      {!loading && visible && visible.length === 0 && tasks && tasks.length > 0 && (
        <div className="rounded-xl border border-dashed border-rule p-10 text-center bg-paper-card text-ink-muted text-[13px]">
          No tasks in this state.
        </div>
      )}

      {!loading && visible && visible.length > 0 && (
        <div className="rounded-xl border border-rule overflow-hidden divide-y divide-rule bg-paper-card">
          {visible.map((t) => (
            <TaskRow
              key={t.id}
              task={t}
              expanded={expanded.has(t.id)}
              onToggle={() => toggle(t.id)}
            />
          ))}
        </div>
      )}

      {/* Footer info box — read-only board note. */}
      {tasks && tasks.length > 0 && (
        <div className="mt-5 flex items-start gap-2.5 rounded-xl border border-rule bg-paper-subtle px-4 py-3 text-[12px] text-ink-muted leading-relaxed">
          <Zap size={13} strokeWidth={2.2} className="text-coral mt-0.5 shrink-0" />
          <span>
            <strong className="font-serif font-medium text-ink">Read-only board.</strong>{' '}
            Accept / override happens inside Claude Code via{' '}
            <code className="font-mono text-[11px] px-1 py-0.5 bg-paper-card rounded">/dispatch</code>. Top1 is
            whichever candidate survives the multi-round BID / DEFER / OBJECT / COMMIT simulation — not a static rank.
          </span>
        </div>
      )}
    </div>
  );
}

function TaskRow({
  task,
  expanded,
  onToggle
}: {
  task: Task;
  expanded: boolean;
  onToggle: () => void;
}) {
  const meta = STATUS_META[task.status];
  const assignees = assigneesOf(task);
  const decision = v2(task.decision);
  const simId = simIdOf(task);

  const conf = confOf(decision);
  // v2 subtask_split — actionable per-subtask assignments. Prefer this over
  // the legacy v1 decomposition.
  const subSplit = subSplitOf(decision);
  const primaryAssignee = assignees[0] ?? null;
  const simulating = task.status === 'predicting';

  return (
    <div className="group bg-paper-card hover:bg-paper-subtle/40 transition-colors">
      {/* Top strip — the signature row: id mono · status pill (pulsing dot when
          simulating) · description · sim badge · assignee chip · ConfidenceRing
          · age · chevron. Description links through to the trace. */}
      <div className="flex items-center gap-4 px-5 py-3.5">
        <code className="font-mono text-[11px] text-ink-quiet w-16 shrink-0 truncate" title={task.id}>
          {task.id}
        </code>

        <span className={`inline-flex items-center gap-1.5 text-[10.5px] px-2.5 py-0.5 rounded-full shrink-0 justify-center min-w-[104px] ${meta.pill}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${meta.dot} ${simulating ? 'animate-pulse-coral' : ''}`} />
          {meta.label}
        </span>

        <Link
          href={`/predict/${encodeURIComponent(task.id)}`}
          className="font-serif text-[15px] text-ink hover:text-coral-deep transition-colors leading-snug flex-1 min-w-0 truncate"
          title="Open simulation trace"
        >
          {task.description}
        </Link>

        {/* sim badge — "Nc · NR" hint that this came from a simulation */}
        {subSplit && (
          <span className="font-mono text-[10.5px] text-ink-quiet shrink-0 px-1.5 py-0.5 rounded bg-paper-subtle tracking-wide">
            {subSplit.length} subtasks
          </span>
        )}

        {/* assignee avatar chip */}
        {primaryAssignee ? (
          <span
            className={`inline-flex items-center gap-1.5 pl-1 pr-2.5 py-0.5 rounded-full shrink-0 whitespace-nowrap border ${
              task.status === 'overridden' ? 'bg-coral-subtle border-coral/40' : 'bg-paper-subtle border-rule'
            }`}
          >
            <Avatar name={primaryAssignee} size="sm" />
            <span className="font-serif text-[12.5px] text-ink-soft">{primaryAssignee}</span>
            {assignees.length > 1 && (
              <span className="font-mono text-[10px] text-ink-quiet">+{assignees.length - 1}</span>
            )}
          </span>
        ) : simulating ? (
          <span className="text-[11.5px] text-sky italic shrink-0 inline-flex items-center gap-1">
            <Loader2 size={11} className="animate-spin" /> simulating…
          </span>
        ) : (
          <span className="text-[11.5px] text-ink-quiet italic shrink-0">no owner</span>
        )}

        {/* ConfidenceRing */}
        {typeof conf === 'number' ? (
          <ConfidenceRing value={conf} size={30} />
        ) : (
          <span className="w-[30px] h-[30px] shrink-0" />
        )}

        <span className="font-mono tabular-nums text-[11px] text-ink-quiet w-[64px] text-right shrink-0">
          {ageStr(task.created_at)}
        </span>

        <button
          onClick={onToggle}
          aria-label={expanded ? 'Collapse' : 'Expand'}
          className="shrink-0 text-ink-ghost hover:text-ink p-1"
        >
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
      </div>

      {/* Expanded: subtask split + facts + links */}
      {expanded && (
        <div className="px-5 pb-5 pt-3 border-t border-rule-soft bg-paper-subtle/40">
          {/* Subtask split — one line per subtask: serif description left,
              assignee pill right. */}
          {subSplit && (
            <div className="mb-4 rounded-lg border border-rule overflow-hidden divide-y divide-rule-soft">
              {subSplit.map((row, i) => (
                <div
                  key={i}
                  className="flex items-center gap-3 px-3.5 py-2 bg-paper-card hover:bg-paper-subtle/30 transition-colors"
                >
                  <span className="text-[10px] font-mono text-ink-quiet tabular-nums w-5 shrink-0">
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <span className="font-serif text-[13.5px] text-ink leading-snug flex-1 min-w-0 truncate">
                    {row.subtask}
                  </span>
                  <span className="text-ink-ghost shrink-0">→</span>
                  {row.suggested_owner ? (
                    <span className="inline-flex items-center gap-1.5 shrink-0">
                      <Avatar name={row.suggested_owner} size="sm" />
                      <span className="font-serif text-[13px] text-coral-deep">{row.suggested_owner}</span>
                    </span>
                  ) : (
                    <span className="text-[11.5px] text-ink-quiet italic shrink-0">unassigned</span>
                  )}
                  {row.alternatives.length > 0 && (
                    <span className="text-[10.5px] text-ink-quiet shrink-0 hidden md:inline">
                      backup: {row.alternatives.slice(0, 2).join(', ')}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-3 gap-x-6 gap-y-2 text-[12.5px] mb-4">
            {task.deadline && <KV label="Due" value={fmtDate(task.deadline)} />}
            {task.importance && task.urgency && (
              <KV label="Priority" value={`${task.importance === 'high' ? 'Important' : 'Low'} · ${task.urgency === 'high' ? 'Urgent' : 'Not urgent'}`} />
            )}
            {task.estimated_effort_days != null && (
              <KV label="Effort" value={`${task.estimated_effort_days} person-days`} />
            )}
            {typeof conf === 'number' && (
              <KV label="Confidence" value={`${Math.round(conf * 100)}%`} tabular />
            )}
            {task.required_skills && task.required_skills.length > 0 && (
              <KV label="Skills needed" value={task.required_skills.join(' · ')} />
            )}
            {task.override_reason && <KV label="Reassign reason" value={task.override_reason} />}
          </div>

          {/* Subtask why-rationale */}
          {subSplit && (
            <div className="mb-4">
              <div className="eyebrow mb-2">Why this split</div>
              <ul className="space-y-1.5">
                {subSplit.map((row, i) => (
                  <li key={i} className="text-[12px] text-ink-muted leading-relaxed">
                    <span className="font-mono text-ink-quiet mr-2">{String(i + 1).padStart(2, '0')}</span>
                    <span className="text-ink">{row.suggested_owner ?? '—'}</span>
                    {row.why && (
                      <>
                        <span className="text-ink-quiet"> · </span>
                        {row.why}
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Legacy v1 fallback: top1 + decomposition */}
          {!subSplit && (() => {
            const rows =
              decision?.decomposition && decision.decomposition.length > 0
                ? decision.decomposition.map((s) => ({ assignee: s.assignee, subtask: s.subtask }))
                : decision?.top1
                  ? [{ assignee: decision.top1, subtask: decision.top1_subtask?.subtask ?? '' }]
                  : [];
            if (rows.length === 0) return null;
            return (
              <div className="mb-4">
                <div className="eyebrow mb-2">Predicted owner</div>
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
          <div className="flex items-center gap-4 mt-3">
            <Link href={`/predict/${encodeURIComponent(task.id)}`} className="text-[12px] link-coral inline-flex items-center gap-1">
              <FlaskConical size={12} /> Open full simulation trace <ChevronRight size={11} />
            </Link>
            {simId && (
              <a href={`/sim/${simId}`} className="text-[12px] link-coral inline-flex items-center gap-0.5">
                v1 sim <ChevronRight size={11} />
              </a>
            )}
          </div>
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
