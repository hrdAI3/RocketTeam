'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Sparkles, Shield, ArrowRight, Check, Loader2, Users } from 'lucide-react';
import { Avatar, MemberInline } from '../../../components/Avatar';
import { RationaleBlock } from '../../../components/rationale';
import { ConfidenceExplainer } from '../../../components/ConfidenceExplainer';
import { TaskCard } from '../../../components/TaskCard';
import type { AgentAction, Department, Task, SimulationConfig } from '@/types';

const ACTION_LABEL: Record<string, string> = {
  BID: 'Bid',
  DEFER: 'Defer',
  RECOMMEND_SPLIT: 'Recommend split',
  OBJECT: 'Object',
  COMMIT: 'Commit',
  REFINED_BID: 'Refined bid'
};

const ACTION_VERB: Record<string, string> = {
  BID: 'willing to take it on',
  DEFER: 'suggests passing to',
  RECOMMEND_SPLIT: 'recommends splitting into',
  OBJECT: 'objects to the plan',
  COMMIT: 'formally commits',
  REFINED_BID: 'revised score after reflection'
};

interface LiveState {
  config?: SimulationConfig;
  current_round?: number;
  current_track?: 'optimistic' | 'skeptical';
  actions: AgentAction[];
  synthesizing: boolean;
  task?: Task;
  done: boolean;
  error?: string;
}

const ROUND_LABEL = ['', 'Initial stances', 'Defers and splits', 'Objections and commits', 'Reflection and lock-in'];
const ROUND_DESC = [
  '',
  'Each candidate independently scores capability / load / collaboration.',
  'After seeing peers\' scores, some defer or recommend a split.',
  'Members may object or formally commit; consensus = converged.',
  'After hearing the full discussion, each member revisits their own scores.'
];

export default function LiveSimPage({ params }: { params: { id: string } }) {
  const router = useRouter();
  const [state, setState] = useState<LiveState>({ actions: [], synthesizing: false, done: false });
  const [deptMap, setDeptMap] = useState<Record<string, Department>>({});
  const [agentChoices, setAgentChoices] = useState<string[]>([]);

  // Fetch dept map once.
  useEffect(() => {
    fetch('/api/agents', { cache: 'force-cache' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { agents: Array<{ name: string; dept: Department }> } | null) => {
        if (!d) return;
        const map: Record<string, Department> = {};
        for (const a of d.agents) map[a.name] = a.dept;
        setDeptMap(map);
        setAgentChoices(d.agents.map((a) => a.name));
      })
      .catch(() => {});
  }, []);

  // Subscribe to SSE stream.
  useEffect(() => {
    const ctrl = new AbortController();
    const url = `/api/sim/${params.id}/stream`;

    (async () => {
      try {
        const res = await fetch(url, { signal: ctrl.signal });
        if (!res.ok || !res.body) {
          setState((s) => ({ ...s, error: `Connection failed ${res.status}`, done: true }));
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split('\n\n');
          buffer = frames.pop() ?? '';
          for (const frame of frames) {
            let event = 'message';
            let data = '';
            for (const line of frame.split('\n')) {
              if (line.startsWith('event: ')) event = line.slice(7).trim();
              else if (line.startsWith('data: ')) data += line.slice(6);
            }
            if (!data) continue;
            try {
              const parsed = JSON.parse(data) as Record<string, unknown>;
              if (event === 'sim_started') {
                setState((s) => ({ ...s, config: parsed.config as SimulationConfig }));
              } else if (event === 'round_started') {
                setState((s) => ({
                  ...s,
                  current_round: parsed.round_num as number,
                  current_track: parsed.track as 'optimistic' | 'skeptical'
                }));
              } else if (event === 'action') {
                setState((s) => ({ ...s, actions: [...s.actions, parsed.action as AgentAction] }));
              } else if (event === 'synthesizing') {
                setState((s) => ({ ...s, synthesizing: true }));
              } else if (event === 'decision') {
                setState((s) => ({ ...s, task: parsed.task as Task, done: true }));
              } else if (event === 'error' || event === 'sim_failed') {
                setState((s) => ({ ...s, error: parsed.error as string, done: true }));
              }
            } catch (parseErr) {
              console.error('[live sse]', parseErr);
            }
          }
        }
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
        setState((s) => ({ ...s, error: (err as Error).message, done: true }));
      }
    })();

    return () => ctrl.abort();
  }, [params.id]);

  const cancelSim = async () => {
    if (!confirm('Cancel this simulation? Partial actions remain in the audit log, but no final decision will be produced.')) return;
    try {
      await fetch(`/api/sim/${params.id}/cancel`, { method: 'POST' });
      router.push('/tasks');
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="px-12 py-10 max-w-[1100px] mx-auto">
      <header className="flex items-start justify-between mb-6">
        <div>
          <Link
            href="/tasks"
            className="text-caption text-ink-muted hover:text-ink inline-flex items-center gap-1 mb-3"
          >
            ← Tasks
          </Link>
          <div className="eyebrow mb-1">
            Team simulation · <span className="font-mono">{params.id}</span>
          </div>
          <h1 className="display-title">
            {state.config?.task_description ?? <span className="text-ink-quiet">Loading task…</span>}
          </h1>
        </div>
        {!state.done && !state.error && (
          <button
            onClick={cancelSim}
            className="btn-ghost text-caption inline-flex items-center gap-1.5 shrink-0 mt-8"
            title="Cancel the simulation (it continues if the page is open; closing the page stops it)"
          >
            Cancel
          </button>
        )}
      </header>
      {state.config && (
        <p className="text-body text-ink-muted mb-4">
          {state.config.eligible_agents.length} candidate{state.config.eligible_agents.length === 1 ? '' : 's'} · {state.config.rounds} round{state.config.rounds === 1 ? '' : 's'} ·{' '}
          Strategy:{' '}
          {STRATEGY_LABEL_LOCAL[(state.config as { strategy?: string }).strategy ?? '']?.name ?? 'Default'}
          {state.config.splittable && ' · splittable'}
        </p>
      )}

      {state.error && (
        <div className="card-surface border-rust p-4 mb-6 text-body text-ink">
          Simulation error: {state.error}
        </div>
      )}

      {/* Done → final decision (same UI as /tasks page) */}
      {state.task && state.done && (
        <div className="mb-6">
          <TaskCard
            task={state.task}
            agentChoices={agentChoices}
            onAccept={async (id) => {
              const res = await fetch(`/api/tasks/${id}/accept`, { method: 'POST' });
              if (res.ok) {
                const updated = (await res.json()) as Task;
                setState((s) => ({ ...s, task: updated }));
              }
            }}
            onOverride={async (id, target, reason) => {
              const res = await fetch(`/api/tasks/${id}/override`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ override_to: target, reason })
              });
              if (res.ok) {
                const updated = (await res.json()) as Task;
                setState((s) => ({ ...s, task: updated }));
              }
            }}
          />
          <div className="mt-3 flex items-center gap-3 text-caption">
            <Link href="/tasks" className="btn-ghost">Back to tasks</Link>
            <button
              onClick={() => router.push(`/sim/${params.id}`)}
              className="btn-ghost inline-flex items-center gap-1.5"
            >
              View full simulation <ArrowRight size={12} />
            </button>
          </div>
        </div>
      )}

      {/* Synthesizing — no decision yet */}
      {state.synthesizing && !state.task && (
        <div className="card-warm p-6 mb-6 shadow-soft animate-fade-in flex items-center gap-3">
          <Loader2 size={18} className="text-coral animate-spin" />
          <div>
            <div className="font-serif text-[16px] text-ink">Report Agent is synthesizing this simulation</div>
            <div className="text-caption text-ink-quiet">Final assignment recommendation incoming…</div>
          </div>
        </div>
      )}

      {/* Active config — candidates */}
      {state.config && (
        <CandidatePanel
          config={state.config}
          actions={state.actions}
          deptMap={deptMap}
          synthesizing={state.synthesizing}
          done={state.done}
        />
      )}

      {/* Single strategy column — actions stream as they arrive */}
      {state.config && (
        <div className="mt-6">
          <TrackPanel
            track="optimistic"
            actions={state.actions.filter((a) => a.track === 'optimistic')}
            currentTrack={state.current_track}
            currentRound={state.current_round}
            eligibleCount={state.config.eligible_agents.length}
            deptMap={deptMap}
            strategy={(state.config as { strategy?: string }).strategy}
            totalRounds={state.config.rounds}
          />
        </div>
      )}

      {!state.config && (
        <div className="card-warm p-6 shadow-soft animate-fade-in">
          <div className="flex items-center gap-3">
            <Loader2 size={18} className="text-coral animate-spin" />
            <div>
              <div className="font-serif text-[16px] text-ink">Generating configuration</div>
              <div className="text-caption text-ink-quiet">
                PMA is decomposing the task and identifying stakeholders…
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function CandidatePanel({
  config,
  actions,
  deptMap,
  synthesizing,
  done
}: {
  config: SimulationConfig;
  actions: AgentAction[];
  deptMap: Record<string, Department>;
  synthesizing: boolean;
  done: boolean;
}) {
  // Per agent, set of round numbers they've acted in across BOTH tracks.
  const roundsActed = useMemo(() => {
    const map: Record<string, Set<number>> = {};
    for (const a of actions) {
      if (!map[a.agent_name]) map[a.agent_name] = new Set();
      map[a.agent_name].add(a.round_num);
    }
    return map;
  }, [actions]);

  return (
    <section className="card-warm p-5 shadow-card animate-fade-in">
      <div className="flex items-baseline justify-between mb-3">
        <div className="flex items-center gap-2">
          <Users size={14} className="text-coral" />
          <h2 className="font-serif text-[16px] text-ink">Candidates picked by PMA</h2>
          <span className="text-[11px] text-ink-quiet font-mono">
            {config.eligible_agents.length} member{config.eligible_agents.length === 1 ? '' : 's'}
          </span>
        </div>
        <div className="text-[11px] text-ink-quiet">
          {synthesizing ? 'Discussion ended' : done ? 'Simulation complete' : 'Discussion in progress'}
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {config.eligible_agents.map((name) => {
          const rounds = roundsActed[name] ?? new Set<number>();
          const acted = rounds.size > 0;
          return (
            <div
              key={name}
              className={`flex items-center gap-2 pl-1.5 pr-2.5 py-1 rounded-full border transition-all ${
                acted
                  ? 'bg-coral-subtle border-coral-mute'
                  : 'bg-paper-subtle border-rule opacity-70'
              }`}
              title={`Spoke in round${rounds.size === 1 ? '' : 's'}: ${[...rounds].sort().join(', ') || 'none yet'}`}
            >
              <Avatar name={name} dept={deptMap[name]} size="xs" />
              <span className="font-serif text-[13px] text-ink">{name}</span>
              <span className="flex items-center gap-0.5 ml-0.5">
                {[1, 2, 3, 4].map((r) => (
                  <span
                    key={r}
                    className={`w-1.5 h-1.5 rounded-full ${
                      rounds.has(r) ? 'bg-coral' : 'bg-rule-strong'
                    }`}
                    aria-label={`Round ${r} ${rounds.has(r) ? 'spoken' : 'not spoken'}`}
                  />
                ))}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

const STRATEGY_LABEL_LOCAL: Record<string, { name: string; desc: string }> = {
  concentrated: { name: 'Concentrated ownership', desc: 'Pick the strongest fit · short rounds, fast convergence' },
  delegate: { name: 'Delegate first', desc: 'Prefer AI agents; otherwise high-capacity members' },
  stretch_review: { name: 'Growth-oriented', desc: 'Hand stretch work to members on a learning curve' },
  ai_batch: { name: 'AI batch', desc: 'Default to handing everything to AI agents' }
};

function TrackPanel({
  track,
  actions,
  currentTrack,
  currentRound,
  eligibleCount,
  deptMap,
  strategy,
  totalRounds = 4
}: {
  track: 'optimistic' | 'skeptical';
  actions: AgentAction[];
  currentTrack: 'optimistic' | 'skeptical' | undefined;
  currentRound: number | undefined;
  eligibleCount: number;
  deptMap: Record<string, Department>;
  strategy?: string;
  totalRounds?: number;
}) {
  const Icon = Sparkles;
  const isCurrent = currentTrack === track;
  const expected = eligibleCount * totalRounds;
  const stratInfo = strategy ? STRATEGY_LABEL_LOCAL[strategy] : null;
  const pct = Math.min(100, (actions.length / Math.max(1, expected)) * 100);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [actions.length]);

  // Group actions by round
  const byRound = useMemo(() => {
    const m: Record<number, AgentAction[]> = { 1: [], 2: [], 3: [], 4: [] };
    for (const a of actions) (m[a.round_num] ??= []).push(a);
    return m;
  }, [actions]);

  return (
    <div
      className={`rounded-2xl border border-coral-mute p-5 transition-all ${
        isCurrent ? 'bg-coral-subtle/40 ring-1 ring-coral/30' : 'bg-coral-subtle/15'
      }`}
    >
      <header className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-lg flex items-center justify-center bg-coral text-white">
            <Icon size={16} strokeWidth={2.4} />
          </div>
          <div>
            <h3 className="font-serif text-[18px] text-ink leading-tight">
              {stratInfo ? `Strategy · ${stratInfo.name}` : 'Simulation discussion'}
            </h3>
            <div className="text-[11px] text-ink-quiet leading-tight">
              {stratInfo?.desc ?? 'Members weigh in, score, defer, and reflect round by round'}
            </div>
          </div>
        </div>
        {isCurrent && currentRound && (
          <span className="text-[10.5px] px-2 py-0.5 rounded-full bg-coral text-white animate-pulse-coral">
            Round {currentRound} / {totalRounds}
          </span>
        )}
      </header>

      <div className="h-1.5 bg-paper-deep/80 rounded-full overflow-hidden mb-1">
        <div className="h-full bg-coral transition-all" style={{ width: `${pct}%` }} />
      </div>
      <div className="text-[10.5px] font-mono text-ink-quiet mb-3 flex justify-between">
        <span>
          {actions.length} / {expected} action{expected === 1 ? '' : 's'}
        </span>
        <span>{Math.round(pct)}%</span>
      </div>

      <div ref={scrollRef} className="space-y-3 max-h-[640px] overflow-y-auto pr-1 -mr-1">
        {Array.from({ length: totalRounds }, (_, i) => i + 1).map((r) => {
          const list = byRound[r] ?? [];
          if (list.length === 0 && currentRound !== r) return null;
          return (
            <div key={r}>
              <div className="flex items-baseline gap-2 mb-1.5 sticky top-0 bg-inherit py-0.5">
                <div className="eyebrow">Round {r} · {ROUND_LABEL[r]}</div>
                <span className="text-[10px] text-ink-quiet">{ROUND_DESC[r]}</span>
              </div>
              <div className="space-y-1.5">
                {list.map((a, i) => (
                  <ActionLine key={i} action={a} deptMap={deptMap} />
                ))}
                {currentRound === r && isCurrent && list.length < eligibleCount && (
                  <div className="flex items-center gap-2 px-2.5 py-2 text-[12px] text-ink-quiet">
                    <Loader2 size={11} className="animate-spin" />
                    Waiting for {eligibleCount - list.length} more member{eligibleCount - list.length === 1 ? '' : 's'}…
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ActionLine({ action, deptMap }: { action: AgentAction; deptMap: Record<string, Department> }) {
  const p = action.payload;
  const verb = ACTION_VERB[action.action_type] ?? action.action_type;
  return (
    <div className="flex items-start gap-2 px-2.5 py-2 rounded-lg bg-paper-card border border-rule-soft animate-fade-in">
      <Avatar name={action.agent_name} dept={deptMap[action.agent_name]} size="sm" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5 flex-wrap">
          <span className="font-serif text-[13.5px] text-ink font-medium">{action.agent_name}</span>
          <span className="text-[12px] text-ink-muted">{verb}</span>
          {p.type === 'BID' && (
            <span className="text-[10.5px] font-mono text-ink-quiet">
              capability {p.capability_fit}/10 · load {p.load_fit}/10
            </span>
          )}
          {p.type === 'DEFER' && (
            <MemberInline name={p.recommend} dept={deptMap[p.recommend]} size="xs" emphasis />
          )}
          {p.type === 'COMMIT' && p.subtask && (
            <span className="font-serif text-[12.5px] text-forest">&ldquo;{p.subtask}&rdquo;</span>
          )}
          {p.type === 'OBJECT' && p.against && (
            <span className="font-serif text-[12.5px] text-rust">&ldquo;{p.against}&rdquo;</span>
          )}
          {p.type === 'RECOMMEND_SPLIT' && (
            <span className="text-[10.5px] font-mono text-ink-quiet">
              {p.subtasks.length} subtask{p.subtasks.length === 1 ? '' : 's'}
            </span>
          )}
          {p.type === 'REFINED_BID' && (
            <span className="text-[10.5px] font-mono text-ink-quiet">
              capability {p.capability_fit}
              {p.delta_capability !== 0 && (
                <span className={p.delta_capability > 0 ? 'text-forest ml-0.5' : 'text-rust ml-0.5'}>
                  ({p.delta_capability > 0 ? '+' : ''}
                  {p.delta_capability})
                </span>
              )}{' '}
              · load {p.load_fit}
              {p.delta_load !== 0 && (
                <span className={p.delta_load > 0 ? 'text-forest ml-0.5' : 'text-rust ml-0.5'}>
                  ({p.delta_load > 0 ? '+' : ''}
                  {p.delta_load})
                </span>
              )}
            </span>
          )}
          <span
            className={`text-[10px] px-1.5 py-0.5 rounded ml-auto ${
              action.action_type === 'COMMIT'
                ? 'bg-forest/10 text-forest'
                : action.action_type === 'OBJECT'
                  ? 'bg-rust/10 text-rust'
                  : 'bg-paper-subtle text-ink-muted'
            }`}
          >
            {ACTION_LABEL[action.action_type] ?? action.action_type}
          </span>
        </div>
        {'reason' in p && p.reason && (
          <p className="text-[12px] text-ink-muted leading-snug mt-1 quote-soft">{p.reason}</p>
        )}
      </div>
    </div>
  );
}

function DecisionCard({
  task,
  deptMap,
  simId,
  onSeeReplay
}: {
  task: Task;
  deptMap: Record<string, Department>;
  simId: string;
  onSeeReplay: () => void;
}) {
  const [accepting, setAccepting] = useState(false);
  const [accepted, setAccepted] = useState(task.status === 'accepted');
  const d = task.decision as {
    top1?: string | null;
    decomposition?: Array<{ subtask: string; assignee: string; rationale: string }>;
    confidence: number;
    rationale: string;
  };
  const decomp = d.decomposition;
  const confPct = Math.round((d.confidence ?? 0) * 100);
  const confColor = confPct >= 80 ? 'text-forest' : confPct >= 65 ? 'text-coral' : 'text-amber';

  return (
    <div className="card-warm p-6 shadow-modal animate-slide-up mb-6">
      <div className="flex items-start justify-between gap-6 mb-4">
        <div>
          <div className="eyebrow mb-2 flex items-center gap-1.5">
            <Check size={11} className="text-forest" />
            Simulation complete · final recommendation
          </div>
          {decomp && decomp.length > 0 ? (
            <h2 className="font-serif text-[28px] leading-tight text-ink">
              Split into <span className="text-coral-deep">{decomp.length}</span> subtask{decomp.length === 1 ? '' : 's'}
            </h2>
          ) : d.top1 ? (
            <h2 className="font-serif text-[28px] leading-tight text-ink">
              Recommended for <span className="text-coral-deep">{d.top1}</span>
            </h2>
          ) : (
            <h2 className="font-serif text-[28px] leading-tight text-ink-soft">No clear owner</h2>
          )}
        </div>
        <div className="shrink-0">
          <ConfidenceExplainer
            confidence={d.confidence ?? 0}
            evidenceCount={(task.decision as { ground_truth_evidence_count?: number }).ground_truth_evidence_count ?? 0}
            trackAgree={(task.decision as { tracks_agree?: boolean }).tracks_agree ?? false}
            converged={(task.decision as { converged?: boolean }).converged ?? false}
          />
        </div>
      </div>

      {decomp && decomp.length > 0 && (
        <div className="grid grid-cols-2 gap-3 mb-4">
          {decomp.map((s, i) => (
            <div key={i} className="rounded-lg bg-paper-card border border-rule p-3.5">
              <div className="font-serif text-[15px] text-ink leading-snug mb-2">{s.subtask}</div>
              <div className="flex items-center gap-2">
                <Avatar name={s.assignee} dept={deptMap[s.assignee]} size="sm" />
                <div>
                  <div className="font-serif text-[13.5px] text-coral-deep font-semibold leading-tight">
                    {s.assignee}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {d.rationale && (
        <div className="pt-4 border-t border-rule-soft">
          <RationaleBlock text={d.rationale} />
        </div>
      )}

      <footer className="mt-4 pt-4 border-t border-rule-soft flex items-center gap-3">
        <Link href="/tasks" className="btn-ghost flex items-center gap-1.5">
          Back to tasks
        </Link>
        <button
          onClick={onSeeReplay}
          className="btn-ghost text-caption inline-flex items-center gap-1.5"
        >
          View full simulation <ArrowRight size={12} />
        </button>
        {!accepted ? (
          <button
            onClick={async () => {
              if (accepting) return;
              setAccepting(true);
              try {
                const res = await fetch(`/api/tasks/${task.id}/accept`, { method: 'POST' });
                if (res.ok) setAccepted(true);
              } finally {
                setAccepting(false);
              }
            }}
            disabled={accepting}
            className="btn-coral inline-flex items-center gap-1.5 ml-auto"
          >
            <Check size={13} /> {accepting ? 'Accepting…' : 'Accept this plan'}
          </button>
        ) : (
          <span className="ml-auto text-caption text-forest inline-flex items-center gap-1.5">
            <Check size={13} /> Accepted
          </span>
        )}
      </footer>
    </div>
  );
}
