'use client';

import { useState, useEffect } from 'react';
import { ChevronDown, ChevronUp, Check, RefreshCw, ArrowRight, X, Loader2 } from 'lucide-react';
import { cn, ago } from './utils';
import { ConfidenceRing } from './ConfidenceRing';
import { Avatar, MemberInline } from './Avatar';
import { RationaleBlock, parseRationale } from './rationale';
import type { Task, PMADecision, PMADecisionV2, Department, Priority, ExecutionMode } from '@/types';
import { computePriority, PRIORITY_LABEL, canInterrupt } from '@/types';

interface TaskCardProps {
  task: Task;
  onOverride?: (taskId: string, target: string, reason?: string) => Promise<void> | void;
  onAccept?: (taskId: string) => Promise<void> | void;
  agentChoices?: string[];
}

function isV2(d: PMADecision | PMADecisionV2): d is PMADecisionV2 {
  return 'sim_replay_id' in d || 'decomposition' in d;
}

export function TaskCard({ task, onOverride, onAccept, agentChoices = [] }: TaskCardProps) {
  const { decision, status } = task;
  const isPredicting = status === 'predicting' || decision === null;
  const v2 = decision !== null && isV2(decision);
  const [expanded, setExpanded] = useState(false);
  const [overriding, setOverriding] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const [overrideTarget, setOverrideTarget] = useState<string>('');
  const [overrideReason, setOverrideReason] = useState<string>('');
  const [showConfirm, setShowConfirm] = useState(false);
  const [deptMap, setDeptMap] = useState<Record<string, Department>>({});

  // Cheap fetch — once per card mount. Cached by browser.
  useEffect(() => {
    fetch('/api/agents', { cache: 'force-cache' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { agents: Array<{ name: string; dept: Department }> } | null) => {
        if (!d) return;
        const map: Record<string, Department> = {};
        for (const a of d.agents) map[a.name] = a.dept;
        setDeptMap(map);
      })
      .catch(() => {});
  }, []);

  const top1 =
    decision === null
      ? null
      : v2
        ? (decision as PMADecisionV2).top1 ?? (decision as PMADecisionV2).decomposition?.[0]?.assignee ?? null
        : (decision as PMADecision).top1;

  return (
    <article className="card-surface p-5 animate-fade-in">
      <header className="flex items-start justify-between gap-3 mb-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1.5 flex-wrap">
            <span className="font-mono text-[11px] text-ink-quiet">{task.id}</span>
            <StatusPill status={status} />
            {task.importance && task.urgency && (
              <PriorityPill priority={computePriority(task.importance, task.urgency)} />
            )}
            <span className="text-[11px] text-ink-quiet">{ago(task.created_at)}</span>
            {task.deadline && (
              <span className="text-[11px] text-ink-quiet">· due {task.deadline}</span>
            )}
            {task.estimated_effort_days !== undefined && (
              <span className="text-[11px] text-ink-quiet">· {task.estimated_effort_days} person-day{task.estimated_effort_days === 1 ? '' : 's'}</span>
            )}
          </div>
          <h3 className="font-serif text-[18px] leading-snug text-ink">{task.description}</h3>
        </div>
      </header>

      {isPredicting ? (
        <div className="rounded-lg bg-coral-subtle/40 border border-coral-mute p-4 mb-3 flex items-start gap-3 animate-pulse-coral">
          <Loader2 size={16} className="text-coral animate-spin mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="font-serif text-[14.5px] text-ink mb-1">PMA simulating…</div>
            <div className="text-[12px] text-ink-muted">The system is selecting candidates and running multiple rounds.</div>
          </div>
        </div>
      ) : top1 && decision ? (
        <div className="flex items-start gap-4 mb-4">
          <ConfidenceRing value={decision.confidence} />
          <div className="min-w-0 flex-1">
            {v2 && (decision as PMADecisionV2).decomposition && (decision as PMADecisionV2).decomposition!.length > 0 ? (
              <DecompositionView decomposition={(decision as PMADecisionV2).decomposition!} deptMap={deptMap} />
            ) : (
              <RationaleHead
                top1={top1}
                deptMap={deptMap}
                rationale={decision.rationale}
                alternatives={decision.alternatives}
                overrideTo={task.override_to}
                mode={decision.mode}
              />
            )}
          </div>
        </div>
      ) : decision ? (
        <div className="rounded-lg bg-paper-subtle border border-rule p-4 mb-3">
          <p className="text-body text-ink">
            <span className="font-semibold">Simulation complete; no clear owner.</span> {decision.rationale}
          </p>
        </div>
      ) : null}

      <div className="flex items-center gap-2 pt-3 border-t border-rule-soft">
        {decision !== null && v2 && (
          <a
            href={`/sim/${(decision as PMADecisionV2).sim_replay_id}`}
            className="text-caption text-coral hover:text-coral-deep transition-colors flex items-center gap-1"
          >
            <ArrowRight size={12} /> View simulation
          </a>
        )}
        {decision !== null && !v2 && (
          <button
            onClick={() => setExpanded((v) => !v)}
            className="flex items-center gap-1 text-caption text-ink-muted hover:text-ink"
          >
            {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            {(decision as PMADecision).all_responses?.length ?? 0} member response{((decision as PMADecision).all_responses?.length ?? 0) === 1 ? '' : 's'}
          </button>
        )}
        {decision === null && task.sim_id && (
          <a
            href={`/live/${task.sim_id}`}
            className="text-caption text-coral hover:text-coral-deep transition-colors flex items-center gap-1"
          >
            <ArrowRight size={12} /> Watch simulation live
          </a>
        )}

        {top1 && status === 'predicted' && (
          <>
            <span className="ml-auto" />
            {agentChoices.length > 0 && onOverride && (
              <select
                disabled={overriding || showConfirm}
                className="text-caption border border-rule rounded-md px-2 py-1 bg-paper-card text-ink"
                onChange={(e) => {
                  const target = e.target.value;
                  if (!target || target === top1) return;
                  // Stage the choice — DON'T execute yet. User must confirm.
                  setOverrideTarget(target);
                  setOverrideReason('');
                  setShowConfirm(true);
                }}
                value=""
                aria-label="Reassign owner"
              >
                <option value="">Reassign</option>
                {agentChoices
                  .filter((a) => a !== top1)
                  .map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
              </select>
            )}
            <button
              onClick={async () => {
                if (!onAccept || accepting) return;
                setAccepting(true);
                try {
                  await onAccept(task.id);
                } finally {
                  setAccepting(false);
                }
              }}
              disabled={accepting || !onAccept}
              className="btn-coral text-caption flex items-center gap-1 disabled:opacity-60"
            >
              <Check size={12} /> {accepting ? 'Accepting…' : 'Accept'}
            </button>
          </>
        )}
        {status === 'accepted' && (
          <span className="ml-auto text-caption text-forest inline-flex items-center gap-1">
            <Check size={12} /> Accepted
          </span>
        )}
        {status === 'overridden' && task.override_to && (
          <span className="ml-auto text-caption text-amber inline-flex items-center gap-1">
            Reassigned → <MemberInline name={task.override_to} dept={deptMap[task.override_to]} size="xs" emphasis />
          </span>
        )}
      </div>

      {/* Override confirm panel */}
      {showConfirm && overrideTarget && top1 && onOverride && (
        <div className="mt-3 pt-3 border-t border-rule-soft bg-amber/5 rounded-md p-3">
          <div className="flex items-start gap-2.5 mb-3">
            <RefreshCw size={13} className="text-amber mt-1 shrink-0" />
            <div className="flex-1">
              <div className="text-body text-ink">
                Reassign this task from{' '}
                <MemberInline name={top1} dept={deptMap[top1]} size="xs" /> to{' '}
                <MemberInline name={overrideTarget} dept={deptMap[overrideTarget]} size="xs" emphasis />
                ?
              </div>
              <div className="text-caption text-ink-quiet mt-1">
                The reassign is written to the audit log and fed back to both profiles as a strong signal.
              </div>
            </div>
          </div>
          <textarea
            value={overrideReason}
            onChange={(e) => setOverrideReason(e.target.value)}
            rows={2}
            placeholder="Reason (optional, but a short note helps)"
            className="w-full bg-paper-card border border-rule rounded-md px-2.5 py-1.5 text-[13px] text-ink outline-none placeholder:text-ink-quiet focus:border-coral-mute mb-2"
          />
          <div className="flex items-center justify-end gap-2">
            <button
              onClick={() => {
                setShowConfirm(false);
                setOverrideTarget('');
                setOverrideReason('');
              }}
              disabled={overriding}
              className="btn-ghost text-caption inline-flex items-center gap-1"
            >
              <X size={11} /> Cancel
            </button>
            <button
              onClick={async () => {
                setOverriding(true);
                try {
                  await onOverride(task.id, overrideTarget, overrideReason.trim() || undefined);
                  setShowConfirm(false);
                  setOverrideTarget('');
                  setOverrideReason('');
                } finally {
                  setOverriding(false);
                }
              }}
              disabled={overriding}
              className="btn-coral text-caption inline-flex items-center gap-1"
            >
              <Check size={11} /> {overriding ? 'Reassigning…' : 'Confirm reassign'}
            </button>
          </div>
        </div>
      )}

      {!v2 && expanded && (decision as PMADecision).all_responses && (
        <div className="mt-3 pt-3 border-t border-rule-soft space-y-2.5">
          {(decision as PMADecision).all_responses.map((r) => (
            <div key={r.agent_name} className="flex items-start gap-2.5">
              <Avatar name={r.agent_name} dept={deptMap[r.agent_name]} size="sm" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="font-serif text-[14px] text-ink">{r.agent_name}</span>
                  <span
                    className={cn(
                      'px-1.5 py-0.5 rounded font-mono text-[10px]',
                      r.fallback ? 'bg-paper-subtle text-ink-quiet' : 'bg-coral-subtle text-coral-deep'
                    )}
                  >
                    capability {r.capability_fit ?? '—'} · load {r.load_fit ?? '—'}
                  </span>
                  {r.fallback && (
                    <span className="text-ink-quiet inline-flex items-center gap-1 text-[10px]">
                      <RefreshCw size={10} /> default substituted
                    </span>
                  )}
                </div>
                <p className="text-[12.5px] text-ink-muted font-serif leading-relaxed quote-soft">{r.reason}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </article>
  );
}

function DecompositionView({
  decomposition,
  deptMap
}: {
  decomposition: NonNullable<PMADecisionV2['decomposition']>;
  deptMap: Record<string, Department>;
}) {
  return (
    <div>
      <div className="eyebrow mb-3">Split · {decomposition.length} subtask{decomposition.length === 1 ? '' : 's'}</div>
      <ul className="space-y-2.5">
        {decomposition.map((s, i) => (
          <li key={i} className="rounded-xl bg-paper-subtle p-3.5 border border-rule-soft hover:border-rule transition-colors">
            <div className="flex items-start justify-between gap-3 mb-2">
              <div className="font-serif text-[15.5px] text-ink leading-snug">{s.subtask}</div>
              <div className="flex items-center gap-2 shrink-0">
                <Avatar name={s.assignee} dept={deptMap[s.assignee]} size="sm" />
                <div>
                  <div className="font-serif text-[14px] text-coral-deep font-semibold leading-tight">
                    {s.assignee}
                  </div>
                </div>
              </div>
            </div>
            <p className="text-[12.5px] text-ink-muted leading-relaxed font-serif quote-soft mb-2">
              {s.rationale}
            </p>
            <div className="flex items-center gap-3 text-[10px] font-mono">
              <span className="text-ink-quiet">capability</span>
              <span className="text-ink">{s.capability_fit}</span>
              <span className="text-ink-quiet">·</span>
              <span className="text-ink-quiet">load</span>
              <span className="text-ink">{s.load_fit}</span>
              <span className="text-ink-quiet">·</span>
              <span className="text-ink-quiet">collab</span>
              <span className="text-ink">{s.collab_fit}</span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Visual cue for ExecutionMode. agent_led = coral chip with Cpu icon
// (一等公民). human_only = ink chip. co_pilot = forest. split = amber.
function ModePill({
  mode,
  owner
}: {
  mode: ExecutionMode;
  owner: string;
}) {
  const map: Record<ExecutionMode, { label: string; cls: string; title: string }> = {
    agent_led: {
      label: `Claude Code drives`,
      cls: 'bg-coral-subtle text-coral-deep border-coral-mute',
      title: `${owner} · Claude Code drives`
    },
    co_pilot: {
      label: `${owner} drives + Claude Code assists`,
      cls: 'bg-paper-subtle text-forest border-rule',
      title: `${owner} drives; Claude Code accelerates`
    },
    human_only: {
      label: `${owner} handles personally`,
      cls: 'bg-paper-subtle text-ink border-rule',
      title: `Human-only · ${owner} handles personally`
    },
    split: {
      label: 'Split',
      cls: 'bg-amber/10 text-amber border-amber/30',
      title: 'Subtasks routed to different pairs'
    }
  };
  const m = map[mode];
  return (
    <span
      className={`text-[10px] px-1.5 py-0.5 rounded border inline-flex items-center gap-1 ${m.cls}`}
      title={m.title}
    >
      {m.label}
    </span>
  );
}

function PriorityPill({ priority }: { priority: Priority }) {
  const cls: Record<Priority, string> = {
    P0: 'bg-rust/10 text-rust border-rust/30',
    P1: 'bg-amber/10 text-amber border-amber/30',
    P2: 'bg-coral-subtle text-coral-deep border-coral-mute',
    P3: 'bg-paper-subtle text-ink-muted border-rule'
  };
  return (
    <span
      className={`text-[10px] px-1.5 py-0.5 rounded border ${cls[priority]}`}
      title={`${priority} · ${PRIORITY_LABEL[priority]}${canInterrupt(priority) ? ' · can interrupt current work' : ''}`}
    >
      {PRIORITY_LABEL[priority]}
    </span>
  );
}

function StatusPill({ status }: { status: Task['status'] }) {
  const map: Record<Task['status'], { label: string; cls: string }> = {
    predicting: { label: 'Predicting', cls: 'bg-coral text-paper animate-pulse-coral' },
    predicted: { label: 'Predicted', cls: 'bg-coral-subtle text-coral-deep' },
    accepted: { label: 'Accepted', cls: 'bg-paper-subtle text-forest' },
    overridden: { label: 'Reassigned', cls: 'bg-paper-subtle text-amber' },
    completed: { label: 'Done', cls: 'bg-paper-subtle text-ink-muted' }
  };
  const m = map[status];
  return <span className={cn('text-[10px] px-1.5 py-0.5 rounded', m.cls)}>{m.label}</span>;
}

function RationaleHead({
  top1,
  deptMap,
  rationale,
  alternatives,
  overrideTo,
  mode
}: {
  top1: string;
  deptMap: Record<string, Department>;
  rationale: string;
  alternatives: string[];
  overrideTo?: string;
  mode?: ExecutionMode;
  expanded?: boolean;
  onToggle?: () => void;
}) {
  const parsed = rationale ? parseRationale(rationale) : {};

  return (
    <div>
      {/* Top1 + mode + override + alternatives — single compact row */}
      <div className="flex items-center gap-2 flex-wrap mb-3">
        <span className="text-ink-muted text-[13px]">Recommend</span>
        <MemberInline name={top1} dept={deptMap[top1]} size="sm" emphasis />
        {mode && <ModePill mode={mode} owner={top1} />}
        {overrideTo && overrideTo !== top1 && (
          <>
            <span className="text-ink-quiet text-[13px]">·</span>
            <span className="text-amber text-[12px]">Reassigned</span>
            <span className="text-ink-muted text-[13px]">→</span>
            <MemberInline name={overrideTo} dept={deptMap[overrideTo]} size="sm" emphasis />
          </>
        )}
        {alternatives.length > 0 && (
          <>
            <span className="text-ink-ghost text-[13px] mx-1">·</span>
            <span className="text-[11px] text-ink-quiet">Alternatives</span>
            {alternatives.slice(0, 4).map((a) => (
              <MemberInline key={a} name={a} dept={deptMap[a]} size="xs" />
            ))}
          </>
        )}
      </div>

      {/* Always show structured rationale — 4 sections with icons + labels.
          parseRationale → recommend / evidence / divergence / risks. RationaleBlock
          handles unstructured text gracefully (renders as one paragraph). */}
      {rationale && (
        <div className="rounded-lg bg-paper-subtle/40 border border-rule-soft p-3.5">
          <RationaleBlock text={rationale} />
        </div>
      )}
    </div>
  );
}
