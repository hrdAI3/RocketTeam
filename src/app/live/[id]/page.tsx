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
  BID: '投标',
  DEFER: '推让',
  RECOMMEND_SPLIT: '建议拆分',
  OBJECT: '反对',
  COMMIT: '承接',
  REFINED_BID: '反思修正'
};

const ACTION_VERB: Record<string, string> = {
  BID: '愿意承接',
  DEFER: '建议交给',
  RECOMMEND_SPLIT: '建议拆成',
  OBJECT: '反对方案',
  COMMIT: '正式承接',
  REFINED_BID: '反思后修正评分'
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

const ROUND_LABEL = ['', '初轮表态', '推让与拆分', '反对与承接', '反思与定稿'];
const ROUND_DESC = [
  '',
  '每位候选成员独立给出能力 / 负载 / 协作三维评分',
  '看见同伴的评分后，部分成员选择推让或建议拆分',
  '可能反对、可能正式承接，达到共识则收敛',
  '看完全部讨论后，每人重审自己的能力分数。听到反对会改，被夸了会升'
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
          setState((s) => ({ ...s, error: `连接失败 ${res.status}`, done: true }));
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
    if (!confirm('确认取消本次推演？已产生的部分会保留在审计日志，但不会生成最终决策。')) return;
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
            ← 任务
          </Link>
          <div className="eyebrow mb-1">
            团队推演 · <span className="font-mono">{params.id}</span>
          </div>
          <h1 className="display-title">
            {state.config?.task_description ?? <span className="text-ink-quiet">推演任务加载中…</span>}
          </h1>
        </div>
        {!state.done && !state.error && (
          <button
            onClick={cancelSim}
            className="btn-ghost text-caption inline-flex items-center gap-1.5 shrink-0 mt-8"
            title="取消推演（页面后台依然能继续，关掉它会停推演）"
          >
            取消推演
          </button>
        )}
      </header>
      {state.config && (
        <p className="text-body text-ink-muted mb-4">
          {state.config.eligible_agents.length} 位候选 · {state.config.rounds} 轮推演 ·{' '}
          策略：
          {STRATEGY_LABEL_LOCAL[(state.config as { strategy?: string }).strategy ?? '']?.name ?? '默认'}
          {state.config.splittable && ' · 任务可拆分'}
        </p>
      )}

      {state.error && (
        <div className="card-surface border-rust p-4 mb-6 text-body text-ink">
          推演出错：{state.error}
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
            <Link href="/tasks" className="btn-ghost">返回任务列表</Link>
            <button
              onClick={() => router.push(`/sim/${params.id}`)}
              className="btn-ghost inline-flex items-center gap-1.5"
            >
              查看完整推演 <ArrowRight size={12} />
            </button>
          </div>
        </div>
      )}

      {/* Synthesizing — no decision yet */}
      {state.synthesizing && !state.task && (
        <div className="card-warm p-6 mb-6 shadow-soft animate-fade-in flex items-center gap-3">
          <Loader2 size={18} className="text-coral animate-spin" />
          <div>
            <div className="font-serif text-[16px] text-ink">Report Agent 正在综合本次推演</div>
            <div className="text-caption text-ink-quiet">即将给出最终分工建议…</div>
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
              <div className="font-serif text-[16px] text-ink">配置生成中</div>
              <div className="text-caption text-ink-quiet">
                PMA 正在拆解任务、寻找干系人、认真思考中...
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
          <h2 className="font-serif text-[16px] text-ink">PMA 选出的候选成员</h2>
          <span className="text-[11px] text-ink-quiet font-mono">
            {config.eligible_agents.length} 人
          </span>
        </div>
        <div className="text-[11px] text-ink-quiet">
          {synthesizing ? '讨论结束' : done ? '推演完成' : '讨论进行中'}
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
              title={`已发言轮次：${[...rounds].sort().join(', ') || '尚未发言'}`}
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
                    aria-label={`第 ${r} 轮${rounds.has(r) ? '已发言' : '未发言'}`}
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
  concentrated: { name: '集中承接', desc: '挑最稳的人主做 · 短轮快速收敛' },
  delegate: { name: '委派优先', desc: '优先 AI agent；找 capacity 高的人' },
  stretch_review: { name: '成长导向', desc: '给学习曲线上的人 stretch 机会主做' },
  ai_batch: { name: 'AI 批处理', desc: '默认全交给 AI agent' }
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
              {stratInfo ? `推演策略 · ${stratInfo.name}` : '推演讨论'}
            </h3>
            <div className="text-[11px] text-ink-quiet leading-tight">
              {stratInfo?.desc ?? '团队成员逐轮表态、互评、反思'}
            </div>
          </div>
        </div>
        {isCurrent && currentRound && (
          <span className="text-[10.5px] px-2 py-0.5 rounded-full bg-coral text-white animate-pulse-coral">
            第 {currentRound} / {totalRounds} 轮
          </span>
        )}
      </header>

      <div className="h-1.5 bg-paper-deep/80 rounded-full overflow-hidden mb-1">
        <div className="h-full bg-coral transition-all" style={{ width: `${pct}%` }} />
      </div>
      <div className="text-[10.5px] font-mono text-ink-quiet mb-3 flex justify-between">
        <span>
          {actions.length} / {expected} 动作
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
                <div className="eyebrow">第 {r} 轮 · {ROUND_LABEL[r]}</div>
                <span className="text-[10px] text-ink-quiet">{ROUND_DESC[r]}</span>
              </div>
              <div className="space-y-1.5">
                {list.map((a, i) => (
                  <ActionLine key={i} action={a} deptMap={deptMap} />
                ))}
                {currentRound === r && isCurrent && list.length < eligibleCount && (
                  <div className="flex items-center gap-2 px-2.5 py-2 text-[12px] text-ink-quiet">
                    <Loader2 size={11} className="animate-spin" />
                    等待剩余 {eligibleCount - list.length} 位成员表态…
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
              能力 {p.capability_fit}/10 · 负载 {p.load_fit}/10
            </span>
          )}
          {p.type === 'DEFER' && (
            <MemberInline name={p.recommend} dept={deptMap[p.recommend]} size="xs" emphasis />
          )}
          {p.type === 'COMMIT' && p.subtask && (
            <span className="font-serif text-[12.5px] text-forest">「{p.subtask}」</span>
          )}
          {p.type === 'OBJECT' && p.against && (
            <span className="font-serif text-[12.5px] text-rust">「{p.against}」</span>
          )}
          {p.type === 'RECOMMEND_SPLIT' && (
            <span className="text-[10.5px] font-mono text-ink-quiet">
              {p.subtasks.length} 个子任务
            </span>
          )}
          {p.type === 'REFINED_BID' && (
            <span className="text-[10.5px] font-mono text-ink-quiet">
              能力 {p.capability_fit}
              {p.delta_capability !== 0 && (
                <span className={p.delta_capability > 0 ? 'text-forest ml-0.5' : 'text-rust ml-0.5'}>
                  ({p.delta_capability > 0 ? '+' : ''}
                  {p.delta_capability})
                </span>
              )}{' '}
              · 负载 {p.load_fit}
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
            推演完成 · 最终建议
          </div>
          {decomp && decomp.length > 0 ? (
            <h2 className="font-serif text-[28px] leading-tight text-ink">
              建议拆为 <span className="text-coral-deep">{decomp.length}</span> 个子任务
            </h2>
          ) : d.top1 ? (
            <h2 className="font-serif text-[28px] leading-tight text-ink">
              推荐分配给 <span className="text-coral-deep">{d.top1}</span>
            </h2>
          ) : (
            <h2 className="font-serif text-[28px] leading-tight text-ink-soft">无明确合适人选</h2>
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
          返回任务列表
        </Link>
        <button
          onClick={onSeeReplay}
          className="btn-ghost text-caption inline-flex items-center gap-1.5"
        >
          查看完整推演 <ArrowRight size={12} />
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
            <Check size={13} /> {accepting ? '采纳中…' : '采纳此方案'}
          </button>
        ) : (
          <span className="ml-auto text-caption text-forest inline-flex items-center gap-1.5">
            <Check size={13} /> 已采纳
          </span>
        )}
      </footer>
    </div>
  );
}
