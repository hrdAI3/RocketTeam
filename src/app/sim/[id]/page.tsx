'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Sparkles, Shield, MessageSquare } from 'lucide-react';
import { ReportChat } from '../../../components/ReportChat';
import { Avatar, MemberInline } from '../../../components/Avatar';
import { RationaleBlock } from '../../../components/rationale';
import { ConfidenceExplainer } from '../../../components/ConfidenceExplainer';
import type { SimulationRunState, AgentAction, RoundSummary, Track, Department } from '@/types';

type DeptMap = Record<string, Department>;

const ACTION_LABEL: Record<string, string> = {
  BID: '投标',
  DEFER: '推让',
  RECOMMEND_SPLIT: '建议拆分',
  OBJECT: '反对',
  COMMIT: '承接',
  REFINED_BID: '反思修正'
};

const STATUS_LABEL: Record<string, string> = {
  running: '进行中',
  completed: '已完成',
  failed: '失败',
  pending: '待启动'
};

export default function SimReplayPage({ params }: { params: { id: string } }) {
  const [state, setState] = useState<SimulationRunState | null>(null);
  const [deptMap, setDeptMap] = useState<DeptMap>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/sim/${params.id}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))))
      .then(setState)
      .catch((err) => setError(err.message));
    fetch('/api/agents', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))))
      .then((d: { agents: Array<{ name: string; dept: Department }> }) => {
        const map: DeptMap = {};
        for (const a of d.agents) map[a.name] = a.dept;
        setDeptMap(map);
      })
      .catch(() => setDeptMap({}));
  }, [params.id]);

  if (error) {
    return (
      <div className="px-12 py-10 max-w-[1100px] mx-auto">
        <div className="card-surface p-6 max-w-md">
          <div className="font-serif text-title text-rust mb-2">推演记录未找到</div>
          <p className="text-body text-ink-muted">{error}</p>
          <Link href="/tasks" className="link-coral text-caption mt-3 inline-block">
            ← 返回任务列表
          </Link>
        </div>
      </div>
    );
  }
  if (!state) {
    return <div className="px-12 py-10 font-serif text-title text-ink-muted">推演回放加载中…</div>;
  }

  return (
    <div className="px-12 py-10 max-w-[1100px] mx-auto">
      <div className="mb-8">
        <Link
          href="/tasks"
          className="text-caption text-ink-muted hover:text-ink inline-flex items-center gap-1 mb-3"
        >
          <ArrowLeft size={12} /> 任务
        </Link>
        <div className="eyebrow mb-1">
          Rocket Team / 推演回放 · <span className="font-mono">{state.sim_id}</span>
        </div>
        <h1 className="display-title">{state.config.task_description}</h1>
        <div className="flex gap-4 mt-3 text-caption text-ink-muted">
          <span>
            <span className="font-mono text-ink">{state.config.eligible_agents.length}</span> 位候选成员
          </span>
          <span>·</span>
          <span>
            <span className="font-mono text-ink">{state.config.rounds}</span> 轮推演
          </span>
          <span>·</span>
          <span className={state.status === 'completed' ? 'text-forest' : 'text-amber'}>
            {STATUS_LABEL[state.status] ?? state.status}
          </span>
        </div>
      </div>

      <DecisionSummaryCard simId={state.sim_id} taskId={state.config.task_id} deptMap={deptMap} />

      <div className="mt-10 mb-3">
        <div className="eyebrow">逐轮回放</div>
      </div>

      <div>
        {state.rounds_b.length > 0 ? (
          // Legacy dual-track replays — show both columns.
          <div className="grid grid-cols-2 gap-6">
            <TrackColumn track="optimistic" rounds={state.rounds_a} deptMap={deptMap} />
            <TrackColumn track="skeptical" rounds={state.rounds_b} deptMap={deptMap} />
          </div>
        ) : (
          <TrackColumn track="optimistic" rounds={state.rounds_a} deptMap={deptMap} />
        )}
      </div>

      <ReportChat sim_id={state.sim_id} task_id={state.config.task_id} />
    </div>
  );
}

function DecisionSummaryCard({
  simId,
  taskId,
  deptMap
}: {
  simId: string;
  taskId: string;
  deptMap: DeptMap;
}) {
  const [task, setTask] = useState<{
    decision: {
      task_description?: string;
      top1?: string | null;
      decomposition?: Array<{
        subtask: string;
        assignee: string;
        capability_fit: number;
        load_fit: number;
        collab_fit: number;
        rationale: string;
      }>;
      confidence: number;
      rationale: string;
      track_a_summary: string;
      track_b_summary: string;
      ground_truth_evidence_count: number;
      tracks_agree?: boolean;
      converged?: boolean;
      reason_if_null?: string;
    };
  } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/tasks', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d: { tasks: Array<{ id: string; decision: unknown }> }) => {
        const found = d.tasks.find((t) => t.id === taskId);
        if (found) setTask(found as typeof task);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [taskId, simId]);

  if (loading) {
    return (
      <div className="card-warm p-6 mb-6 animate-pulse">
        <div className="h-6 bg-paper-deep rounded w-1/3 mb-3" />
        <div className="h-4 bg-paper-deep rounded w-1/2" />
      </div>
    );
  }
  if (!task) return null;

  const d = task.decision;
  const decomp = d.decomposition;
  const confidencePct = Math.round((d.confidence ?? 0) * 100);
  const confidenceColor =
    confidencePct >= 80 ? 'text-forest' : confidencePct >= 65 ? 'text-coral' : 'text-amber';

  return (
    <div className="card-warm p-6 shadow-soft animate-fade-in">
      <div className="flex items-start justify-between gap-6 mb-5">
        <div className="min-w-0 flex-1">
          <div className="eyebrow mb-2">最终决策 · 由 Report Agent 整合</div>
          {decomp && decomp.length > 0 ? (
            <h2 className="font-serif text-[24px] leading-tight text-ink">
              拆为 <span className="text-coral-deep">{decomp.length}</span> 个子任务
            </h2>
          ) : d.top1 ? (
            <h2 className="font-serif text-[24px] leading-tight text-ink">
              推荐分配给 <span className="text-coral-deep">{d.top1}</span>
            </h2>
          ) : (
            <h2 className="font-serif text-[24px] leading-tight text-ink-soft">无明确合适人选</h2>
          )}
        </div>
        <div className="shrink-0">
          <ConfidenceExplainer
            confidence={d.confidence ?? 0}
            evidenceCount={d.ground_truth_evidence_count ?? 0}
            trackAgree={d.tracks_agree ?? false}
            converged={d.converged ?? false}
          />
        </div>
      </div>

      {decomp && decomp.length > 0 && (
        <div className="grid grid-cols-2 gap-3 mb-5">
          {decomp.map((s, i) => (
            <div key={i} className="rounded-lg bg-paper-card border border-rule p-3.5">
              <div className="font-serif text-[15px] text-ink leading-snug mb-2">{s.subtask}</div>
              <div className="flex items-center gap-2 mb-2">
                <Avatar name={s.assignee} dept={deptMap[s.assignee]} size="sm" />
                <div>
                  <div className="font-serif text-[13.5px] text-coral-deep font-semibold leading-tight">
                    {s.assignee}
                  </div>
                </div>
              </div>
              <p className="text-[12px] text-ink-muted font-serif leading-relaxed quote-soft">
                {s.rationale}
              </p>
            </div>
          ))}
        </div>
      )}

      {d.track_a_summary && (
        <div className="rounded-lg bg-coral-subtle/40 border border-coral-mute px-4 py-3 mb-4">
          <div className="flex items-center gap-1.5 mb-1.5">
            <Sparkles size={11} className="text-coral" />
            <span className="text-[11px] text-coral-deep font-medium">推演摘要</span>
          </div>
          <p className="text-[12.5px] text-ink-soft font-serif leading-relaxed">{d.track_a_summary}</p>
        </div>
      )}

      {d.rationale && (
        <div className="pt-4 border-t border-rule-soft">
          <RationaleBlock text={d.rationale} />
        </div>
      )}

      <div className="mt-4 pt-4 border-t border-rule-soft flex items-center gap-4 text-[11px] font-mono text-ink-quiet">
        <span>引用 {d.ground_truth_evidence_count} 条证据</span>
        {d.reason_if_null && (
          <>
            <span>·</span>
            <span className="text-amber">{d.reason_if_null}</span>
          </>
        )}
        <span className="ml-auto inline-flex items-center gap-1.5 text-coral">
          <MessageSquare size={11} /> 向 Report Agent 追问 →
        </span>
      </div>
    </div>
  );
}

function TrackColumn({
  track,
  rounds,
  deptMap
}: {
  track: Track;
  rounds: RoundSummary[];
  deptMap: DeptMap;
}) {
  const isOpt = track === 'optimistic';
  const Icon = isOpt ? Sparkles : Shield;
  return (
    <section>
      <header
        className={`flex items-center gap-3 mb-5 pb-3 border-b ${
          isOpt ? 'border-coral-mute' : 'border-rule-strong'
        }`}
      >
        <div
          className={`w-9 h-9 rounded-lg flex items-center justify-center ${
            isOpt ? 'bg-coral-subtle text-coral' : 'bg-paper-deep text-ink-muted'
          }`}
        >
          <Icon size={16} strokeWidth={2.4} />
        </div>
        <div>
          <h2 className="font-serif text-[20px] leading-tight text-ink">推演讨论</h2>
          <div className="text-[12px] text-ink-quiet mt-0.5">
            按 P 优先级策略跑多轮 BID / SPLIT / COMMIT
          </div>
        </div>
      </header>

      {rounds.length === 0 && (
        <div className="text-[13px] text-ink-quiet font-serif">等待动作产生…</div>
      )}

      <div className="space-y-6">
        {rounds.map((round) => (
          <RoundBlock key={round.round_num} round={round} deptMap={deptMap} />
        ))}
      </div>
    </section>
  );
}

function RoundBlock({ round, deptMap }: { round: RoundSummary; deptMap: DeptMap }) {
  return (
    <div>
      <div className="flex items-baseline justify-between mb-2">
        <div className="eyebrow">第 {round.round_num} 轮</div>
        {round.converged && (
          <span className="text-[10px] font-mono text-forest px-2 py-0.5 rounded bg-forest/10">
            已收敛
          </span>
        )}
      </div>
      <div className="space-y-2">
        {round.actions.map((a, i) => (
          <ActionCard key={i} action={a} deptMap={deptMap} />
        ))}
      </div>
    </div>
  );
}

function ActionCard({ action, deptMap }: { action: AgentAction; deptMap: DeptMap }) {
  const p = action.payload;
  const typeColor: Record<string, { text: string; bg: string }> = {
    BID: { text: 'text-coral-deep', bg: 'bg-coral-subtle' },
    DEFER: { text: 'text-amber', bg: 'bg-amber/10' },
    RECOMMEND_SPLIT: { text: 'text-sky', bg: 'bg-sky/10' },
    OBJECT: { text: 'text-rust', bg: 'bg-rust/10' },
    COMMIT: { text: 'text-forest', bg: 'bg-forest/10' }
  };
  const tag = typeColor[action.action_type] ?? { text: 'text-ink-muted', bg: 'bg-paper-subtle' };
  const dept = deptMap[action.agent_name];

  return (
    <article className="card-surface p-3.5 animate-fade-in hover:shadow-soft transition-shadow">
      <header className="flex items-start justify-between gap-2 mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <Avatar name={action.agent_name} dept={dept} size="sm" />
          <span className="font-serif text-[15px] text-ink truncate">{action.agent_name}</span>
        </div>
        <span className={`text-[11px] px-1.5 py-0.5 rounded ${tag.text} ${tag.bg} shrink-0`}>
          {ACTION_LABEL[action.action_type] ?? action.action_type}
        </span>
      </header>

      {p.type === 'BID' && (
        <div className="grid grid-cols-3 gap-2 mb-2">
          <ScoreBar label="能力" value={p.capability_fit} />
          <ScoreBar label="负载" value={p.load_fit} />
          <ScoreBar label="协作" value={p.collab_fit} />
        </div>
      )}

      {p.type === 'RECOMMEND_SPLIT' && (
        <ul className="space-y-1.5 text-[12.5px] text-ink-soft mb-2">
          {p.subtasks.map((s, i) => (
            <li key={i} className="flex items-start gap-2">
              <span className="text-ink-quiet font-mono shrink-0">·</span>
              <div className="min-w-0">
                <span className="font-serif text-ink">{s.subtask}</span>
                <span className="text-ink-quiet"> → </span>
                <MemberInline name={s.assignee} dept={deptMap[s.assignee]} size="xs" emphasis />
              </div>
            </li>
          ))}
        </ul>
      )}

      {p.type === 'DEFER' && (
        <div className="text-[13px] text-ink-soft mb-1.5 inline-flex items-center gap-1.5">
          → 推让给 <MemberInline name={p.recommend} dept={deptMap[p.recommend]} size="xs" emphasis />
        </div>
      )}

      {p.type === 'OBJECT' && (
        <div className="text-[12.5px] text-ink-soft mb-1.5">
          反对 <span className="font-serif text-rust">「{p.against}」</span>
        </div>
      )}

      {p.type === 'COMMIT' && (
        <div className="text-[12.5px] text-ink-soft mb-1.5">
          承接 <span className="font-serif text-forest font-semibold">「{p.subtask}」</span>
        </div>
      )}

      {'reason' in p && p.reason && (
        <p className="text-[12.5px] text-ink-muted leading-relaxed font-serif quote-soft mt-1.5">
          {p.reason}
        </p>
      )}

      {!action.success && (
        <div className="mt-1.5 text-[10px] font-mono text-ink-quiet">
          这位成员未在限时内回复，已用画像默认值代答
        </div>
      )}
    </article>
  );
}

function ScoreBar({ label, value }: { label: string; value: number | null }) {
  const v = value ?? 0;
  const pct = (v / 10) * 100;
  return (
    <div>
      <div className="text-[10px] text-ink-quiet font-medium">{label}</div>
      <div className="flex items-center gap-1.5 mt-0.5">
        <span className="font-mono text-[12px] text-ink w-3">{value === null ? '—' : v}</span>
        <div className="flex-1 h-1 bg-paper-deep rounded-full overflow-hidden">
          <div
            className={`h-full ${v >= 7 ? 'bg-forest' : v >= 4 ? 'bg-coral' : 'bg-amber'}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
    </div>
  );
}
