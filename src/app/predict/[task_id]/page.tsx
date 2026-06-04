'use client';

// Static reasoning trace for a single PMA v2 prediction.
// One candidate per row, full width. No animation, no controls — show the work.
// Page intentionally hides the "winner" verdict. Decision lives in the leader's
// CC chat. This page is "audit the reasoning".

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { Avatar } from '@/components/Avatar';
import type { Task, TeamMemberProfile } from '@/types';
import type { AgentBehaviorSnapshot, CurrentProject } from '@/index/behavior';
import type { PMADecisionV2, CandidateScore, AgentWalkthrough, SubtaskAssignment } from '@/predict/types';

interface TimelineEvt {
  seq: number;
  ts: string;
  source: string;
  type: string;
  actor?: string;
  evidence?: { quote?: string; fields?: Record<string, unknown> };
}

interface TraceResp {
  task: Task;
  events: TimelineEvt[];
  snapshots: Record<string, AgentBehaviorSnapshot>;
  snapshot_meta: { as_of: string; window_days: number; source_path: string };
}

export default function ReplayPage() {
  const params = useParams<{ task_id: string }>();
  const task_id = params?.task_id;
  const [data, setData] = useState<TraceResp | null>(null);
  const [profiles, setProfiles] = useState<Record<string, TeamMemberProfile>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!task_id) return;
    fetch(`/api/predict/v2/trace/${encodeURIComponent(task_id)}`)
      .then((r) => r.json())
      .then((j) => {
        if (j.error) setError(j.error);
        else setData(j);
      })
      .catch((e) => setError(String(e)));
  }, [task_id]);

  useEffect(() => {
    if (!data) return;
    const names = (data.task.decision as PMADecisionV2 | null)?.candidates.map((c) => c.name);
    if (!names) return;
    Promise.all(
      names.map((n) =>
        fetch(`/api/agents/${encodeURIComponent(n)}`)
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null)
      )
    ).then((rs) => {
      const out: Record<string, TeamMemberProfile> = {};
      rs.forEach((r, i) => {
        if (r && !r.error && r.name) out[names[i]] = r;
      });
      setProfiles(out);
    });
  }, [data]);

  if (error) return <Pad><Empty>{error}</Empty></Pad>;
  if (!data) return <Pad><Skeleton /></Pad>;

  const t = data.task;
  const d = t.decision as PMADecisionV2 | null;
  if (!d || !('candidates' in d)) {
    return <Pad><Empty>这是 v1 任务, 没有 v2 推演 trace</Empty></Pad>;
  }

  return (
    <Pad>
      <Header task={t} decision={d} />
      <FusionTrajectoryPanel decision={d} />
      {d.reason_if_null && <RejectedBanner reason={d.reason_if_null} />}
      <FingerprintBoard fp={d.fingerprint} />
      {d.subtask_split && d.subtask_split.length > 0 ? (
        <SubtaskSplitPanel split={d.subtask_split} profiles={profiles} />
      ) : (
        <SubtaskSplitFailureNote reason={d.subtask_split_failure_reason ?? null} />
      )}
      <PathLegend />
      <CandidateRows decision={d} snapshots={data.snapshots} profiles={profiles} />
      <PipelinePanel decision={d} />
      <FuseFormula />
      <TimelinePanel events={data.events} />
    </Pad>
  );
}

function RejectedBanner({ reason }: { reason: string }) {
  const map: Record<string, string> = {
    no_agents: 'No agents available — bootstrap the team first.',
    no_suitable: 'No candidate scored above the capability gate (0.4).',
    quota_blocked: 'Top candidate would breach quota — none of the alternates qualify either.',
    all_burnt: 'Every viable candidate is on a load floor below 0.2.',
    service_unavailable: 'LLM provider unavailable — predict could not score candidates.'
  };
  return (
    <div className="mb-10 rounded-xl border border-coral/40 bg-coral/5 px-5 py-4">
      <div className="eyebrow text-coral-deep mb-1">No assignment</div>
      <div className="text-[14px] text-ink-soft leading-relaxed">{map[reason] ?? reason}</div>
    </div>
  );
}

function SubtaskSplitFailureNote({
  reason
}: {
  reason: PMADecisionV2['subtask_split_failure_reason'] | null;
}) {
  // Quiet when the task simply wasn't splittable — that's expected, not a
  // failure. Loud (subtly) when split was attempted but failed.
  if (!reason || reason === 'not_splittable') return null;
  const map: Record<string, string> = {
    no_subtasks: 'Task marked splittable but fingerprint returned no subtasks.',
    gate_blocked: 'Split skipped — top1 was rejected by a gate, no point splitting.',
    parse_failed: 'LLM returned unparseable output for the split.',
    no_candidates_returned: 'LLM ran but produced an empty subtask list.',
    timeout: 'Split LLM call timed out (30s).',
    exception: 'Split failed with an internal exception.'
  };
  return (
    <section className="mb-12">
      <div className="mb-4 pb-3 border-b border-rule">
        <div className="eyebrow mb-1.5">Subtask split</div>
        <div className="flex items-baseline justify-between gap-4">
          <h2 className="font-serif text-[20px] text-ink leading-snug">Not produced this run</h2>
          <span className="text-[12px] text-ink-muted shrink-0">reason: {reason}</span>
        </div>
      </div>
      <div className="text-[13px] text-ink-muted leading-relaxed">{map[reason] ?? reason}</div>
    </section>
  );
}

function Pad({ children }: { children: React.ReactNode }) {
  return <div className="px-12 py-10 max-w-[1040px] mx-auto">{children}</div>;
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="text-ink-muted text-[14px] py-24 text-center">{children}</div>;
}

function Skeleton() {
  return (
    <div className="space-y-6">
      <div className="h-3 w-44 bg-paper-subtle rounded animate-pulse" />
      <div className="h-9 w-3/4 bg-paper-subtle rounded animate-pulse" />
      <div className="h-4 w-1/2 bg-paper-subtle rounded animate-pulse" />
      <div className="h-48 bg-paper-subtle rounded animate-pulse mt-12" />
    </div>
  );
}

// ============ Header ============

function Header({ task, decision }: { task: Task; decision: PMADecisionV2 }) {
  const ts = task.created_at?.slice(0, 16).replace('T', ' ');
  const nCand = decision.candidates.length;
  const nLLM = decision.candidates.filter((c) => c.score_llm).length;
  const nMC = decision.candidates.filter((c) => c.score_trajectory).length;
  const nWk = decision.candidates.filter((c) => c.walkthrough).length;
  return (
    <header className="mb-12">
      <Link
        href="/tasks"
        className="inline-flex items-center gap-1.5 text-[12px] text-ink-quiet hover:text-ink-muted mb-3 transition-colors"
      >
        <ArrowLeft size={13} /> Back to Dispatch
      </Link>
      <div className="eyebrow mb-6">
        Rocket Team / <Link href="/tasks" className="hover:text-ink-muted transition-colors">Dispatch</Link> / <span className="font-mono">{task.id.slice(0, 12)}</span>
      </div>
      <div className="eyebrow flex items-center gap-2 mb-3">
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-coral" />
        Simulation trace
        <span className="text-ink-ghost mx-1">·</span>
        <span className="font-mono">{task.id}</span>
        {ts && (
          <>
            <span className="text-ink-ghost mx-1">·</span>
            <span>{ts}</span>
          </>
        )}
      </div>
      <h1 className="display-title mb-4">{task.description}</h1>
      <p className="text-[13.5px] text-ink-muted max-w-2xl leading-relaxed">
        {nCand} personal agents simulated in parallel · three reasoning paths
        (vector · LLM self-eval ×{nLLM} · Monte&nbsp;Carlo ×{nMC}) fused, plus
        {' '}{nWk} first-person walkthroughs. Reasoning trace only — the
        decision happens in the leader&apos;s Claude Code session via{' '}
        <code className="font-mono text-[12px] px-1 py-0.5 bg-paper-subtle rounded">/dispatch</code>.
        Seeded LLM calls; same task gives same result.
      </p>
    </header>
  );
}

// ============ Fusion trajectory chart (signature lede viz) ============
//
// X-axis is NOT simulation rounds — it is the three independent fusion
// PATHS converging into the fused score, left→right:
//   Vector → LLM → Monte Carlo → Fused
// You literally SEE three independent signals collapse into one number,
// top1 emerging in coral. Visual language mirrors the reference
// TrajectoryChart (dashed gridlines, mono ticks, column guides, circle
// markers, trailing serif TOP1 label) but the data is OURS and honest:
// null LLM / MC nodes are skipped and the line dashes across the gap.

const FUSION_PATHS = [
  { key: 'vector', label: 'Vector' },
  { key: 'llm', label: 'LLM' },
  { key: 'mc', label: 'Monte Carlo' },
  { key: 'fused', label: 'Fused' }
] as const;

function nodeValue(c: CandidateScore, path: (typeof FUSION_PATHS)[number]['key']): number | null {
  switch (path) {
    case 'vector':
      return c.score_vector;
    case 'llm':
      return c.score_llm ? c.score_llm.capability_fit / 10 : null;
    case 'mc':
      return c.score_trajectory ? c.score_trajectory.p_complete_on_time : null;
    case 'fused':
      return c.calibrated_confidence;
  }
}

function FusionTrajectoryPanel({ decision }: { decision: PMADecisionV2 }) {
  return (
    <SubSection
      eyebrow="FUSION TRAJECTORY"
      title="三路融合 · 独立信号汇成最终分"
      caption="向量 → LLM → 蒙特卡洛 → 融合"
    >
      <div className="mt-2 rounded-xl border border-rule bg-paper-card px-5 py-4 flex flex-col items-center">
        <FusionTrajectoryChart decision={decision} />
        <FusionLegend />
      </div>
    </SubSection>
  );
}

// Hex tokens mirror tailwind.config.ts. This codebase paints color via
// Tailwind hex (no CSS custom props like the reference's var(--coral)),
// so SVG fills must use the literal values or they'd render transparent.
const C = {
  coral: '#D97757',
  coralDeep: '#C76A4D',
  forest: '#5C7F5A',
  sky: '#5681A8',
  ink: '#1F1F1C',
  inkGhost: '#B8B5AE',
  inkQuiet: '#8A8782',
  inkMuted: '#5A5A57',
  rule: '#E8E3D5',
  ruleSoft: '#F0EBDC'
} as const;
const FONT_MONO = 'var(--font-geist-mono), monospace';
const FONT_SERIF = '"Source Serif 4", Cambria, Georgia, serif';

function FusionLegend() {
  const items = [
    { color: C.forest, label: 'Vector', cn: '向量匹配' },
    { color: C.sky, label: 'LLM', cn: 'persona自评' },
    { color: C.coral, label: 'MC', cn: '蒙特卡洛' },
    { color: C.ink, label: 'Fused', cn: '融合' }
  ];
  return (
    <div className="mt-3 flex flex-wrap items-center justify-center gap-x-5 gap-y-1.5 text-[10.5px] text-ink-quiet">
      {items.map((it) => (
        <span key={it.label} className="inline-flex items-center gap-1.5">
          <span className="inline-block w-2 h-2 rounded-full" style={{ background: it.color }} />
          <span className="font-mono tracking-wide text-ink-muted">{it.label}</span>
          <span className="text-ink-ghost">{it.cn}</span>
        </span>
      ))}
    </div>
  );
}

function FusionTrajectoryChart({ decision }: { decision: PMADecisionV2 }) {
  const w = 460;
  const h = 240;
  const padL = 36;
  const padR = 100; // reserve room for trailing TOP1 label
  const padT = 18;
  const padB = 32;
  const innerW = w - padL - padR;
  const innerH = h - padT - padB;
  const n: number = FUSION_PATHS.length;
  const xFor = (i: number) => padL + (n <= 1 ? 0 : (i / (n - 1)) * innerW);
  const yFor = (s: number) => padT + (1 - Math.min(1, Math.max(0, s))) * innerH;

  const top1 = decision.top1;
  // Only label top1 + top-3 by calibrated_confidence to avoid clutter at 12 candidates.
  const ranked = [...decision.candidates].sort(
    (a, b) => b.calibrated_confidence - a.calibrated_confidence
  );
  const labelSet = new Set(ranked.slice(0, 3).map((c) => c.name));
  if (top1) labelSet.add(top1);

  // Draw top1 last so it sits on top.
  const ordered = [...decision.candidates].sort((a) =>
    a.name === top1 ? 1 : -1
  );

  return (
    <svg width={w} height={h} style={{ display: 'block', overflow: 'visible' }}>
      {/* y-axis dashed gridlines 0.25 / 0.50 / 0.75 / 1.00 */}
      {[0.25, 0.5, 0.75, 1.0].map((v) => (
        <g key={v}>
          <line
            x1={padL}
            y1={yFor(v)}
            x2={w - padR}
            y2={yFor(v)}
            stroke={C.ruleSoft}
            strokeDasharray="2 3"
          />
          <text
            x={padL - 8}
            y={yFor(v) + 3}
            textAnchor="end"
            fontSize="9.5"
            fill={C.inkQuiet}
            fontFamily={FONT_MONO}
          >
            {v === 1 ? '1.0' : v.toFixed(2)}
          </text>
        </g>
      ))}
      <line x1={padL} y1={yFor(0)} x2={w - padR} y2={yFor(0)} stroke={C.rule} />

      {/* vertical column guides — one per fusion path */}
      {FUSION_PATHS.map((p, i) => (
        <g key={p.key}>
          <line
            x1={xFor(i)}
            y1={padT - 4}
            x2={xFor(i)}
            y2={h - padB + 2}
            stroke={C.ruleSoft}
            strokeDasharray="2 3"
          />
          <text
            x={xFor(i)}
            y={h - 14}
            textAnchor="middle"
            fontSize="10"
            fill={C.inkMuted}
            fontFamily={FONT_MONO}
            fontWeight="500"
          >
            {p.label}
          </text>
        </g>
      ))}
      <text
        x={(padL + w - padR) / 2}
        y={h - 2}
        textAnchor="middle"
        fontSize="9.5"
        fill={C.inkQuiet}
        fontFamily={FONT_MONO}
      >
        three paths → fused →
      </text>

      {/* candidate lines */}
      {ordered.map((c) => {
        const isTop = c.name === top1;
        // collect [x, y, hasValue] for each path
        const nodes = FUSION_PATHS.map((p, i) => {
          const v = nodeValue(c, p.key);
          return { i, x: xFor(i), v, y: v === null ? null : yFor(v) };
        });
        const present = nodes.filter((nd) => nd.v !== null) as Array<{
          i: number;
          x: number;
          v: number;
          y: number;
        }>;
        if (present.length === 0) return null;

        // Build a path that dashes across gaps: solid segment between two
        // present nodes that are adjacent columns, dashed when a node was
        // skipped (null) in between.
        const segments: Array<{ d: string; dashed: boolean }> = [];
        for (let k = 0; k < present.length - 1; k++) {
          const a = present[k];
          const b = present[k + 1];
          const dashed = b.i - a.i > 1; // a column was skipped
          segments.push({
            d: `M${a.x.toFixed(1)} ${a.y.toFixed(1)} L${b.x.toFixed(1)} ${b.y.toFixed(1)}`,
            dashed
          });
        }

        const lineColor = isTop ? C.coral : C.inkGhost;
        const lineWidth = isTop ? 2 : 1.2;
        const lineOpacity = isTop ? 1 : 0.55;
        const last = present[present.length - 1];

        return (
          <g key={c.name} opacity={isTop ? 1 : 0.85}>
            {segments.map((seg, si) => (
              <path
                key={si}
                d={seg.d}
                fill="none"
                stroke={lineColor}
                strokeWidth={lineWidth}
                strokeLinejoin="round"
                strokeLinecap="round"
                strokeDasharray={seg.dashed ? '3 3' : undefined}
                opacity={lineOpacity}
              />
            ))}
            {present.map((nd) => (
              <circle
                key={nd.i}
                cx={nd.x}
                cy={nd.y}
                r={isTop ? 2.6 : 1.8}
                fill={isTop ? C.coral : C.inkGhost}
                opacity={lineOpacity}
              />
            ))}
            {isTop ? (
              <text
                x={last.x + 8}
                y={last.y + 3}
                fontSize="11"
                fontFamily={FONT_SERIF}
                fontWeight="600"
                fill={C.coralDeep}
              >
                {c.name}
                <tspan
                  dx="6"
                  fontSize="9"
                  fontFamily={FONT_MONO}
                  fill={C.coral}
                  letterSpacing="0.06em"
                >
                  TOP1
                </tspan>
              </text>
            ) : labelSet.has(c.name) ? (
              <text
                x={last.x + 7}
                y={last.y + 3}
                fontSize="9.5"
                fontFamily={FONT_SERIF}
                fill={C.inkQuiet}
              >
                {c.name}
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

// ============ Fingerprint board ============

function FingerprintBoard({ fp }: { fp: PMADecisionV2['fingerprint'] }) {
  return (
    <SubSection eyebrow="L2 · 任务指纹" title="LLM 抽取" caption="24h cache · 同任务复用">
      <div className="grid grid-cols-3 gap-x-8 gap-y-6 mt-2">
        <Pillar dot="bg-sky" label="所需技能">
          <ChipRow>
            {fp.skills_needed.map((s) => (
              <Chip key={s.skill} tone="sky" weight={s.weight}>{s.skill}</Chip>
            ))}
          </ChipRow>
        </Pillar>
        <Pillar dot="bg-forest" label="预计 CC 工具">
          <ChipRow>
            {fp.tools_needed.length === 0 ? (
              <span className="text-ink-quiet text-[12px]">—</span>
            ) : (
              fp.tools_needed.map((t) => <Chip key={t} tone="forest">{t}</Chip>)
            )}
          </ChipRow>
        </Pillar>
        <Pillar dot="bg-coral" label="风险主题">
          <ChipRow>
            {fp.risk_topics.length === 0 ? (
              <span className="text-ink-quiet text-[12px]">无</span>
            ) : (
              fp.risk_topics.map((r) => <Chip key={r} tone="coral">{r}</Chip>)
            )}
          </ChipRow>
        </Pillar>
        <Pillar dot="bg-amber" label="规模 · 节奏">
          <dl className="space-y-1 text-[12.5px] leading-relaxed">
            <KV k="工作量" v={`${fp.est_effort_days} 人天 · ${fp.quality_bar}`} />
            <KV k="优先级" v={`${fp.importance === 'high' ? '战略级' : '维持'} · ${fp.urgency === 'high' ? '紧急' : '不急'}`} />
            <KV k="可拆分" v={fp.splittable ? '是' : '否'} />
          </dl>
        </Pillar>
        {fp.linked_context.historical_owners.length > 0 && (
          <Pillar dot="bg-ink-ghost" label="同类历史承接">
            <ChipRow>
              {fp.linked_context.historical_owners.slice(0, 5).map((h) => (
                <Chip key={h.name} tone="neutral">
                  {h.name}
                  <span className="ml-1 text-ink-quiet tabular-nums">×{h.n_events}</span>
                </Chip>
              ))}
            </ChipRow>
          </Pillar>
        )}
        {fp.expected_subtasks && fp.expected_subtasks.length > 0 && (
          <Pillar dot="bg-ink-ghost" label="LLM 建议子任务">
            <ul className="list-decimal list-inside text-[12.5px] text-ink-muted space-y-1 leading-relaxed">
              {fp.expected_subtasks.slice(0, 3).map((s, i) => <li key={i}>{s}</li>)}
            </ul>
          </Pillar>
        )}
      </div>
    </SubSection>
  );
}

// ============ Subtask split ============

function SubtaskSplitPanel({
  split,
  profiles
}: {
  split: SubtaskAssignment[];
  profiles: Record<string, TeamMemberProfile>;
}) {
  return (
    <SubSection
      eyebrow="建议拆分"
      title="LLM 基于全体 walkthrough 为子任务匹配承接人"
      caption={`${split.length} 个子任务`}
    >
      <div className="mt-2 space-y-3">
        {split.map((row, i) => (
          <div
            key={i}
            className="rounded-xl border border-rule bg-paper-card px-5 py-4 grid grid-cols-[1fr_auto] gap-x-5 gap-y-2 items-start"
          >
            <div>
              <div className="text-[10.5px] uppercase tracking-[0.16em] text-ink-quiet mb-1">
                子任务 {i + 1}
              </div>
              <div className="font-serif text-[15px] text-ink leading-snug mb-1.5">
                {row.subtask}
              </div>
              <div className="text-[12px] text-ink-muted leading-relaxed">{row.why}</div>
            </div>
            <div className="text-right min-w-[160px]">
              {row.suggested_owner ? (
                <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-coral/8 border border-coral/30">
                  <Avatar name={row.suggested_owner} dept={profiles[row.suggested_owner]?.dept ?? '产品'} size="sm" />
                  <span className="font-serif text-[13.5px] text-coral-deep">{row.suggested_owner}</span>
                </div>
              ) : (
                <span className="text-[12px] text-ink-quiet italic">无合适人选</span>
              )}
              {row.alternatives.length > 0 && (
                <div className="mt-1.5 text-[11px] text-ink-quiet">
                  备选: {row.alternatives.join(' · ')}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </SubSection>
  );
}

// ============ Path legend ============

function PathLegend() {
  return (
    <SubSection eyebrow="L3 · 三路证据" title="独立信号, 透明加权融合" caption="每路一种独立角度, 互相校验">
      <div className="grid grid-cols-3 gap-4 mt-2">
        <LegendCard
          color="bg-forest"
          label="Path A · 向量"
          oneliner="0 token · cosine"
          detail="任务 tools_needed × agent 30d 工具直方图 cosine, 历史卡点扣分。"
        />
        <LegendCard
          color="bg-sky"
          label="Path B · LLM 自评"
          oneliner="grounded persona"
          detail="每个 agent 用自己 30d 行为快照 role-play, LLM 评 capability_fit / load_fit (0-10) 并写理由。"
        />
        <LegendCard
          color="bg-coral"
          label="Path C · Monte Carlo"
          oneliner="N=20 平行轨迹"
          detail="top-K=3 候选跑 20 条轨迹, 输出 p_on_time / 时长分布 / 预测卡点 / 预期 rework。"
        />
      </div>
    </SubSection>
  );
}

function LegendCard({
  color,
  label,
  oneliner,
  detail
}: {
  color: string;
  label: string;
  oneliner: string;
  detail: string;
}) {
  return (
    <div className="rounded-xl border border-rule bg-paper-card px-4 py-3.5">
      <div className="flex items-center gap-2 mb-2">
        <span className={`inline-block w-2 h-2 rounded-full ${color}`} />
        <span className="font-serif text-[14px] text-ink">{label}</span>
      </div>
      <div className="text-[11px] text-ink-quiet uppercase tracking-wider mb-1.5">{oneliner}</div>
      <div className="text-[12.5px] text-ink-muted leading-relaxed">{detail}</div>
    </div>
  );
}

// ============ Candidate rows (one per row, wide) ============

function CandidateRows({
  decision,
  snapshots,
  profiles
}: {
  decision: PMADecisionV2;
  snapshots: Record<string, AgentBehaviorSnapshot>;
  profiles: Record<string, TeamMemberProfile>;
}) {
  const candidates = useMemo(
    () => [...decision.candidates].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN')),
    [decision.candidates]
  );
  const fpRisk = new Set(decision.fingerprint.risk_topics);
  const fpTools = new Set(decision.fingerprint.tools_needed);
  return (
    <SubSection
      eyebrow={`12 人推演`}
      title="按姓名字母序排"
      caption="不暗示排名 — 三路证据并列, leader 自己判"
    >
      <div className="mt-2 space-y-4">
        {candidates.map((c) => (
          <CandidateRow
            key={c.name}
            cand={c}
            snap={snapshots[c.name]}
            profile={profiles[c.name]}
            fpRisk={fpRisk}
            fpTools={fpTools}
          />
        ))}
      </div>
    </SubSection>
  );
}

function CandidateRow({
  cand,
  snap,
  profile,
  fpRisk,
  fpTools
}: {
  cand: CandidateScore;
  snap: AgentBehaviorSnapshot | undefined;
  profile: TeamMemberProfile | undefined;
  fpRisk: Set<string>;
  fpTools: Set<string>;
}) {
  const dept = profile?.dept ?? '产品';
  return (
    <article className="rounded-xl bg-paper-card border border-rule px-6 py-5 hover:border-rule-strong transition-colors">
      {/* Identity strip — current_projects surfaced as primary signal,
          right under the name. NO big conf number anywhere; ranking lives
          in the leader's CC chat decision. */}
      <div className="flex items-center gap-4 pb-4 border-b border-rule-soft">
        <Avatar name={cand.name} dept={dept} size="xl" />
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-3 mb-1.5">
            <h3 className="font-serif text-[20px] text-ink leading-none">{cand.name}</h3>
            {cand.is_ai_agent && (
              <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-paper-subtle text-ink-muted border border-rule">
                AI
              </span>
            )}
          </div>
          {snap && snap.current_projects.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 mb-1.5">
              <span className="text-[10px] uppercase tracking-wider text-ink-quiet">在做</span>
              {snap.current_projects.slice(0, 3).map((p) => (
                <CurrentProjectChip key={p.name} p={p} />
              ))}
            </div>
          )}
          {snap && (
            <div className="flex items-center gap-3 text-[11.5px] text-ink-quiet">
              <span className="flex items-center gap-1.5">
                <EnergyDot energy={snap.energy_inferred} />
                {ENERGY_LABEL[snap.energy_inferred]}
              </span>
              <span className="text-ink-ghost">·</span>
              <span>{snap.active_days_in_window} 天活跃 / 30d</span>
              <span className="text-ink-ghost">·</span>
              <span>{snap.n_sessions} sessions</span>
              <span className="text-ink-ghost">·</span>
              <span>{(snap.cc_tokens_per_hour_p50 / 1000).toFixed(0)}k tok/h</span>
            </div>
          )}
        </div>
      </div>

      {/* 3-path grid */}
      <div className="grid grid-cols-3 gap-6 pt-5">
        {/* Path A · Vector */}
        <PathBox tone="forest" label="A · vector" stat={cand.score_vector.toFixed(2)}>
          <Bar value={cand.score_vector} accent="forest" />
          {snap && (
            <ToolHistogram
              snap={snap}
              fpTools={fpTools}
            />
          )}
          {cand.vector_stuck_penalty > 0 && (
            <div className="mt-2 text-[10.5px] text-coral-deep">
              历史 stuck 命中 risk · 扣分 −{(cand.vector_stuck_penalty * 100).toFixed(0)}%
            </div>
          )}
        </PathBox>

        {/* Path B · LLM */}
        <PathBox
          tone="sky"
          label="B · LLM 自评"
          stat={cand.score_llm
            ? `cap ${cand.score_llm.capability_fit} · load ${cand.score_llm.load_fit}`
            : '—'}
        >
          {cand.score_llm?.reason ? (
            <blockquote className="text-[12px] leading-relaxed text-ink-muted bg-paper-subtle/60 rounded-md border-l-2 border-sky/40 pl-3 pr-2 py-2 max-h-44 overflow-y-auto">
              {cand.score_llm.reason}
            </blockquote>
          ) : (
            <div className="text-[12px] text-ink-quiet italic">未做 LLM 评估 (vector 太低或超 top-K)</div>
          )}
        </PathBox>

        {/* Path C · MC */}
        <PathBox
          tone="coral"
          label="C · Monte Carlo"
          stat={cand.score_trajectory
            ? `p_on_time ${(cand.score_trajectory.p_complete_on_time * 100).toFixed(0)}%`
            : '—'}
        >
          {cand.score_trajectory ? (
            <MCBox traj={cand.score_trajectory} fpRisk={fpRisk} seedKey={cand.name} />
          ) : (
            <div className="text-[12px] text-ink-quiet italic">不在 top-3 vector, 未跑 MC</div>
          )}
        </PathBox>
      </div>

      {/* Walkthrough — "如果我接, 我会..." first-person plan (top-3 only) */}
      {cand.walkthrough && <WalkthroughBox wk={cand.walkthrough} name={cand.name} />}

      {/* Snapshot signals (current projects / stuck / meeting / slack) */}
      {snap && <SnapshotFooter snap={snap} fpRisk={fpRisk} />}
    </article>
  );
}

function WalkthroughBox({ wk, name }: { wk: AgentWalkthrough; name: string }) {
  return (
    <div className="mt-5 pt-4 border-t border-rule-soft">
      <div className="flex items-center gap-2 mb-3">
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-coral" />
        <span className="eyebrow">{name} 第一人称模拟 · 如果我接, 我会…</span>
      </div>
      <div className="grid grid-cols-[1fr_240px] gap-5">
        <blockquote className="text-[13px] leading-relaxed text-ink-soft bg-paper-subtle/50 border-l-2 border-coral/40 rounded-r-md pl-4 pr-3 py-3 whitespace-pre-wrap">
          {wk.text}
        </blockquote>
        <div className="space-y-3 text-[11.5px]">
          {wk.predicted_first_action && (
            <WKChip label="预计第 1 步" value={wk.predicted_first_action} tone="forest" />
          )}
          {wk.predicted_collab_pings.length > 0 && (
            <WKChip
              label="可能找的人"
              value={wk.predicted_collab_pings.join(', ')}
              tone="sky"
            />
          )}
          {wk.predicted_blockers.length > 0 && (
            <WKChip
              label="预计卡点"
              value={wk.predicted_blockers.join(', ')}
              tone="coral"
            />
          )}
        </div>
      </div>
    </div>
  );
}

function WKChip({ label, value, tone }: { label: string; value: string; tone: 'forest' | 'sky' | 'coral' }) {
  const map = {
    forest: 'border-forest/30 bg-forest/5',
    sky: 'border-sky/30 bg-sky/5',
    coral: 'border-coral/30 bg-coral/5'
  };
  return (
    <div className={`border ${map[tone]} rounded-md px-2.5 py-1.5`}>
      <div className="text-[9.5px] uppercase tracking-wider text-ink-quiet mb-0.5">{label}</div>
      <div className="text-ink-soft leading-snug">{value}</div>
    </div>
  );
}

const ENERGY_LABEL: Record<AgentBehaviorSnapshot['energy_inferred'], string> = {
  high: '高产能',
  normal: '稳定',
  low: '低产能',
  burnt: '透支',
  unknown: '无数据'
};

function PathBox({
  tone,
  label,
  stat,
  children
}: {
  tone: 'forest' | 'sky' | 'coral';
  label: string;
  stat: string;
  children: React.ReactNode;
}) {
  const dotMap = { forest: 'bg-forest', sky: 'bg-sky', coral: 'bg-coral' };
  return (
    <div>
      <div className="flex items-baseline justify-between mb-2.5">
        <div className="flex items-center gap-1.5">
          <span className={`inline-block w-1.5 h-1.5 rounded-full ${dotMap[tone]}`} />
          <span className="text-[10.5px] uppercase tracking-[0.16em] text-ink-quiet">{label}</span>
        </div>
        <span className="text-[11.5px] tabular-nums text-ink-muted">{stat}</span>
      </div>
      {children}
    </div>
  );
}

function ToolHistogram({
  snap,
  fpTools
}: {
  snap: AgentBehaviorSnapshot;
  fpTools: Set<string>;
}) {
  const tools = Object.entries(snap.tool_usage).sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (tools.length === 0) {
    return <div className="mt-2 text-[11px] text-ink-quiet italic">30d 无工具记录</div>;
  }
  const max = Math.max(1, ...tools.map((t) => t[1]));
  return (
    <div className="mt-3 space-y-1">
      {tools.map(([tool, n]) => {
        const hit = fpTools.has(tool);
        return (
          <div key={tool} className="flex items-center gap-2 text-[11px]">
            <div className={`w-16 truncate ${hit ? 'font-medium text-ink' : 'text-ink-muted'}`}>
              {tool}
            </div>
            <div className="flex-1 h-1.5 bg-paper-subtle rounded-full overflow-hidden">
              <div
                className={`h-full ${hit ? 'bg-forest' : 'bg-ink/15'} rounded-full`}
                style={{ width: `${(n / max) * 100}%` }}
              />
            </div>
            <div className="w-10 text-right tabular-nums text-ink-quiet">{n}</div>
          </div>
        );
      })}
    </div>
  );
}

function MCBox({
  traj,
  fpRisk,
  seedKey
}: {
  traj: NonNullable<CandidateScore['score_trajectory']>;
  fpRisk: Set<string>;
  seedKey: string;
}) {
  return (
    <div className="space-y-2.5">
      <MCTrajectorySpark traj={traj} fpRisk={fpRisk} seedKey={seedKey} />
      <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11.5px]">
        <Stat label="p_on_time" v={`${(traj.p_complete_on_time * 100).toFixed(0)}%`} />
        <Stat label="rework" v={traj.expected_rework.toFixed(2)} />
        <Stat label="p50" v={`${traj.duration_p50_d.toFixed(1)}d`} />
        <Stat label="p90" v={`${traj.duration_p90_d.toFixed(1)}d`} />
      </div>
      {traj.predicted_stuck_topics.length > 0 && (
        <div className="pt-1">
          <div className="text-[10px] uppercase tracking-wider text-ink-quiet mb-1">预测卡点</div>
          <div className="flex flex-wrap gap-1">
            {traj.predicted_stuck_topics.slice(0, 3).map((s) => (
              <span
                key={s.topic}
                className="text-[10.5px] px-1.5 py-0.5 rounded bg-coral/8 text-coral-deep border border-coral/20"
              >
                {s.topic} {(s.p * 100).toFixed(0)}%
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, v }: { label: string; v: string }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="text-ink-quiet">{label}</span>
      <span className="tabular-nums text-ink">{v}</span>
    </div>
  );
}

function MCTrajectorySpark({
  traj,
  fpRisk,
  seedKey
}: {
  traj: NonNullable<CandidateScore['score_trajectory']>;
  fpRisk: Set<string>;
  seedKey: string;
}) {
  const w = 140;
  const h = 30;
  const p50 = traj.duration_p50_d;
  const p90 = traj.duration_p90_d;
  const spread = Math.max(0.3, p90 - p50);
  // Per-candidate seed so every spark draws a distinct wiggle, not a
  // stamped pattern across rows.
  let seed = 2166136261;
  for (let i = 0; i < seedKey.length; i++) {
    seed ^= seedKey.charCodeAt(i);
    seed = (seed * 16777619) >>> 0;
  }
  const rand = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const paths: string[] = [];
  for (let i = 0; i < 20; i++) {
    const offY = (rand() - 0.5) * 8;
    const ctrlY = h / 2 + (rand() - 0.5) * 12;
    const ctrlX = w * (0.25 + rand() * 0.5);
    const off = (rand() - 0.5) * spread;
    const endX = Math.min(w, Math.max(w * 0.15, ((p50 + off) / Math.max(p90 * 1.3, 1)) * w));
    paths.push(`M0,${h / 2} Q${ctrlX},${ctrlY} ${endX},${h / 2 + offY * 0.4}`);
  }
  const stuckHits = traj.predicted_stuck_topics.filter((s) => fpRisk.has(s.topic));
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-8 block">
      <line x1={0} y1={h / 2} x2={w} y2={h / 2} stroke="rgba(31,31,28,0.06)" strokeWidth="0.5" />
      {paths.map((d, i) => (
        <path
          key={i}
          d={d}
          stroke={stuckHits.length > 0 ? 'rgba(217,119,87,0.42)' : 'rgba(56,79,93,0.38)'}
          strokeWidth="0.6"
          fill="none"
        />
      ))}
    </svg>
  );
}

function SnapshotFooter({
  snap,
  fpRisk
}: {
  snap: AgentBehaviorSnapshot;
  fpRisk: Set<string>;
}) {
  const stuckHit = snap.stuck_topics.filter((t) => fpRisk.has(t.topic));
  return (
    <div className="mt-5 pt-4 border-t border-rule-soft">
      <div className="grid grid-cols-3 gap-6 text-[11.5px]">
        <FooterCol label="历史 stuck">
        {snap.stuck_topics.length === 0 ? (
          <span className="text-ink-quiet italic">无</span>
        ) : (
          <div className="flex flex-wrap gap-1">
            {snap.stuck_topics.slice(0, 5).map((t) => (
              <span
                key={t.topic}
                className={`px-1.5 py-0.5 rounded text-[10.5px] ${
                  fpRisk.has(t.topic)
                    ? 'bg-coral/12 text-coral-deep border border-coral/25'
                    : 'bg-paper-subtle text-ink-muted border border-rule'
                }`}
              >
                {t.topic} ×{t.count}
              </span>
            ))}
          </div>
        )}
        {stuckHit.length > 0 && (
          <div className="text-[10.5px] text-coral-deep mt-1.5">
            ↑ {stuckHit.length} 条命中本任务 risk_topics
          </div>
        )}
      </FooterCol>
      <FooterCol label="会议参与 (30d)">
        <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-ink-muted">
          <KVMini k="action" v={snap.meeting_signals.action_items_owned} />
          <KVMini k="decision" v={snap.meeting_signals.decisions_authored} />
          <KVMini k="mention" v={snap.meeting_signals.name_mention_received} />
          <KVMini k="attend" v={snap.meeting_signals.attendance_rate.toFixed(1)} />
        </dl>
      </FooterCol>
      <FooterCol label="Slack (30d)">
        <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-ink-muted">
          <KVMini k="@mention" v={snap.slack_signals.decisions_authored} />
          <KVMini k="unanswered" v={snap.slack_signals.unanswered_to_me} />
        </dl>
      </FooterCol>
      </div>
    </div>
  );
}

function CurrentProjectChip({ p }: { p: CurrentProject }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-coral/30 bg-coral/8 text-[11.5px]"
      title={p.sample_cwd}
    >
      <span className="font-serif text-coral-deep">{p.name}</span>
      <span className="text-ink-quiet tabular-nums">
        {p.event_count}e · {p.active_days}d
      </span>
    </span>
  );
}

function FooterCol({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-ink-quiet mb-1.5">{label}</div>
      {children}
    </div>
  );
}

function KVMini({ k, v }: { k: string; v: number | string }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <dt className="text-ink-quiet shrink-0">{k}</dt>
      <dd className="tabular-nums text-ink-soft">{v}</dd>
    </div>
  );
}

// ============ Pipeline (latency bars) ============

function PipelinePanel({ decision }: { decision: PMADecisionV2 }) {
  const lat = decision.latencies;
  const nLLM = decision.candidates.filter((c) => c.score_llm).length;
  const nMC = decision.candidates.filter((c) => c.score_trajectory).length;
  const mcMs = Math.max(0, lat.total_ms - lat.fingerprint_ms - lat.snapshot_load_ms - lat.vector_ms - lat.llm_eval_ms);
  const steps = [
    { name: 'L2 fingerprint', ms: lat.fingerprint_ms, color: 'bg-sky' },
    { name: 'L1 snapshot load', ms: lat.snapshot_load_ms, color: 'bg-forest' },
    { name: `Path A · vector (×${decision.candidates.length})`, ms: lat.vector_ms, color: 'bg-forest' },
    { name: `Path B · LLM eval (×${nLLM})`, ms: lat.llm_eval_ms, color: 'bg-sky/60' },
    { name: `Path C · MC (×${nMC})`, ms: mcMs, color: 'bg-coral' }
  ];
  const total = steps.reduce((a, s) => a + s.ms, 0);
  return (
    <SubSection
      eyebrow="L3 · 真实推演耗时"
      title={`predictor ${decision.predictor_version}`}
      caption={`total ${total}ms`}
    >
      <div className="space-y-2.5 mt-2">
        {steps.map((s) => (
          <div key={s.name} className="flex items-center gap-3 text-[12.5px]">
            <div className="w-48 text-ink-muted">{s.name}</div>
            <div className="flex-1 h-2 bg-paper-subtle rounded-full overflow-hidden">
              <div
                className={`h-full ${s.color} rounded-full`}
                style={{ width: `${total > 0 ? Math.min(100, (s.ms / total) * 100) : 0}%` }}
              />
            </div>
            <div className="w-20 text-right tabular-nums text-ink-quiet">{s.ms}ms</div>
          </div>
        ))}
      </div>
    </SubSection>
  );
}

// ============ Fuse formula ============

function FuseFormula() {
  return (
    <SubSection
      eyebrow="Fuse"
      title="三路加权融合 + 校准"
      caption="缺失路径施加 missing-path penalty (×0.5)"
    >
      <pre className="mt-2 text-[12px] bg-paper-subtle border border-rule rounded-lg px-4 py-3 overflow-x-auto font-mono leading-relaxed text-ink-soft">
{`fused_capability = 0.25 × vector + 0.45 × (llm_cap / 10) + 0.30 × p_on_time
fused_load       = 0.50 × quota_headroom + 0.30 × (llm_load / 10) + 0.20 × (1 − quota_breach_p)
raw_confidence   = √(fused_capability × fused_load)
calibrated_confidence = isotonic_calibration(raw_confidence)   ← M3.C 待落, 当前 identity

Gates:
  top1.fused_capability < 0.4  → reason = "no_suitable"
  top1.fused_load       < 0.2  → reason = "all_burnt"
  top1.quota_breach_p   > 0.6  → swap or "quota_blocked"
  alternatives = within 0.08 of top1 calibrated_confidence`}
      </pre>
    </SubSection>
  );
}

// ============ Timeline ============

function TimelinePanel({ events }: { events: TimelineEvt[] }) {
  if (!events.length) return null;
  return (
    <SubSection eyebrow="Timeline" title="该任务事件流" caption={`${events.length} 条`}>
      <div className="mt-2 space-y-1.5">
        {events.map((e) => (
          <div key={e.seq} className="flex gap-3 items-baseline text-[12px]">
            <code className="font-mono text-ink-quiet whitespace-nowrap">
              {e.ts.replace('T', ' ').slice(0, 19)}
            </code>
            <span className="text-ink">{e.type}</span>
            {e.actor && <span className="text-ink-muted">— {e.actor}</span>}
            {e.evidence?.fields && (
              <span className="text-ink-quiet truncate">
                {Object.entries(e.evidence.fields)
                  .slice(0, 3)
                  .map(([k, v]) => `${k}=${JSON.stringify(v).slice(0, 40)}`)
                  .join(' · ')}
              </span>
            )}
          </div>
        ))}
      </div>
    </SubSection>
  );
}

// ============ Layout primitives ============

function SubSection({
  eyebrow,
  title,
  caption,
  children
}: {
  eyebrow: string;
  title: string;
  caption?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-12">
      <div className="mb-4 pb-3 border-b border-rule">
        <div className="eyebrow mb-1.5">{eyebrow}</div>
        <div className="flex items-baseline justify-between gap-4">
          <h2 className="font-serif text-[20px] text-ink leading-snug">{title}</h2>
          {caption && <span className="text-[12px] text-ink-muted shrink-0">{caption}</span>}
        </div>
      </div>
      {children}
    </section>
  );
}

function Pillar({
  dot,
  label,
  children
}: {
  dot: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-2.5">
        <span className={`inline-block w-1.5 h-1.5 rounded-full ${dot}`} />
        <span className="eyebrow">{label}</span>
      </div>
      {children}
    </div>
  );
}

function ChipRow({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-wrap gap-1.5">{children}</div>;
}

function Chip({
  children,
  tone,
  weight
}: {
  children: React.ReactNode;
  tone: 'sky' | 'forest' | 'coral' | 'amber' | 'neutral';
  weight?: number;
}) {
  const m = {
    sky: 'bg-sky/8 text-sky border-sky/25',
    forest: 'bg-forest/8 text-forest border-forest/25',
    coral: 'bg-coral/8 text-coral-deep border-coral/25',
    amber: 'bg-amber/10 text-amber border-amber/25',
    neutral: 'bg-paper-subtle text-ink-muted border-rule'
  };
  return (
    <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-[12px] border ${m[tone]}`}>
      {children}
      {weight !== undefined && (
        <span className="ml-1.5 text-[10.5px] opacity-60 tabular-nums">{weight}</span>
      )}
    </span>
  );
}

function Bar({ value, accent }: { value: number; accent: 'forest' | 'sky' | 'coral' | 'ink' }) {
  const fill = { forest: 'bg-forest', sky: 'bg-sky', coral: 'bg-coral', ink: 'bg-ink' }[accent];
  return (
    <div className="h-1.5 bg-paper-subtle rounded-full overflow-hidden">
      <div className={`h-full ${fill} rounded-full`} style={{ width: `${Math.min(100, Math.max(0, value * 100))}%` }} />
    </div>
  );
}

function EnergyDot({ energy }: { energy: AgentBehaviorSnapshot['energy_inferred'] }) {
  const c = {
    high: 'bg-forest',
    normal: 'bg-ink-ghost',
    low: 'bg-amber',
    burnt: 'bg-coral',
    unknown: 'bg-ink-ghost'
  }[energy];
  return <span className={`inline-block w-1.5 h-1.5 rounded-full ${c}`} aria-label={energy} />;
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-baseline gap-2.5">
      <span className="text-ink-quiet w-14 shrink-0">{k}</span>
      <span className="text-ink-soft">{v}</span>
    </div>
  );
}

