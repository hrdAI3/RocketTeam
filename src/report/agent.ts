// Report Agent — synthesizes the dual-track simulation into a PMADecisionV2.
//
// Input:  SimulationRunState with rounds_a + rounds_b populated.
// Output: PMADecisionV2 with decomposition[] (if splittable) or top1.
//
// Confidence formula:
//   - both tracks converged on same assignee, evidence_count >= 5  → 0.85+
//   - tracks agree but evidence thin                                → 0.65–0.85
//   - tracks disagree                                               → 0.50–0.65 + risk note
//   - no convergence                                                → null

import { llmCall } from '../lib/llm';
import { newTaskId } from '../lib/tasks';
import { REPORT_AGENT_RATIONALE_EXAMPLE } from '@private/source-data/prompt-examples';
import type {
  SimulationRunState,
  PMADecisionV2,
  AgentAction,
  RoundSummary,
  SubtaskAssignment,
  TaskBrief,
  ExecutionMode
} from '../types/index';

export async function synthesizeDecision(
  state: SimulationRunState,
  signal?: AbortSignal,
  brief?: TaskBrief
): Promise<PMADecisionV2> {
  // Single-track mode: rounds_b is unused/empty, only analyse rounds_a.
  const taskA = analyseTrack(state.rounds_a);
  const singleTrack = state.rounds_b.length === 0;
  const taskB = singleTrack ? { assignments: [], converged: true } : analyseTrack(state.rounds_b);

  // Combine: prefer assignments that appear in both tracks.
  let assignments = mergeAssignments(taskA.assignments, taskB.assignments);
  const evidenceCount = countEvidence(state);
  const tracksAgree = singleTrack ? true : assignmentsOverlap(taskA.assignments, taskB.assignments);
  const converged = singleTrack ? taskA.converged : taskA.converged && taskB.converged;

  const confidence = computeConfidence({
    singleTrack,
    tracksAgree,
    evidenceCount,
    converged,
    assignmentCount: assignments.length,
    bidCount: countR1Bids(state)
  });

  // **No-null-top1 guarantee**: if rounds had no clean BID->COMMIT path, fall back
  // to the highest-scoring R1 BID. We never hand back "无明确人选".
  if (assignments.length === 0) {
    const allR1Bids = [...state.rounds_a, ...state.rounds_b]
      .filter((r) => r.round_num === 1)
      .flatMap((r) => r.actions)
      .filter((a) => a.payload.type === 'BID')
      .map((a) => ({
        agent_name: a.agent_name,
        bid: a.payload as Extract<typeof a.payload, { type: 'BID' }>
      }))
      .sort((a, b) => b.bid.capability_fit + b.bid.load_fit - (a.bid.capability_fit + a.bid.load_fit));
    if (allR1Bids[0]) {
      const top = allR1Bids[0];
      assignments = [
        {
          subtask: '主负责',
          assignee: top.agent_name,
          capability_fit: top.bid.capability_fit,
          load_fit: top.bid.load_fit,
          collab_fit: top.bid.collab_fit,
          rationale: `R1 BID 综合分最高 (${top.bid.capability_fit + top.bid.load_fit})`,
          evidence_cited: []
        }
      ];
    }
  }

  const top1 = assignments[0]?.assignee ?? null;

  // Pick ExecutionMode based on TaskBrief signals + assignment shape.
  // Pair-aware: agent_led = "由 X 的 Claude Code 主做".
  const mode: ExecutionMode = pickMode(brief, assignments);

  // Build summary (single track in current mode).
  let rationale = '';
  const trackASummary = summarizeTrack(state.rounds_a, 'optimistic');
  const trackBSummary = singleTrack ? '' : summarizeTrack(state.rounds_b, 'skeptical');

  try {
    const summary = await llmCall({
      system: `你是 Report Agent。综合多轮推演讨论，输出结构化的最终决策说明。

**关键一致性约束**：
- 你看到的 final assignment 是基于 R1-R3 中真实 BID/COMMIT 的承接人。
- 如果 final assignment 显示某人承接，**rationale 里必须支持这个选择**，不能既说 X 承接又论证 X 不应承接。
- 若你认为推演结果矛盾（agent 在 BID 时投标但 rationale 又否定），按 BID 行为为准 —— agent 自己的话比你的 meta 评注权威。

严格按以下 4 段格式输出。每段一行 (允许 60-100 字)，**不用任何 markdown / 不写"以下是"等开场白**：

推荐：[1 句话说明最终分工方案，引用 final assignment 里的 assignee 名字。**禁止用否定语气**]
论据：[2-3 个支持当前推荐的关键证据，cite 具体 round + agent 动作，比如 ${REPORT_AGENT_RATIONALE_EXAMPLE}]
分歧：[推演中出现的不同意见或被 OBJECT 的方案。如全员一致写 "讨论中无明显分歧"]
风险：[1-2 个潜在隐患，针对当前推荐方案，不要说"X 不应该承接"]`,
      user: `任务：${state.config.task_description}

完整 actions：
${formatTrackForPrompt(state.rounds_a)}
${singleTrack ? '' : `\n第二路径 actions：\n${formatTrackForPrompt(state.rounds_b)}`}

最终拆解：
${assignments.map((a) => `- ${a.subtask} → ${a.assignee}`).join('\n') || '(top1: ' + (top1 ?? '无') + ')'}

请按 4 段格式输出 rationale。`,
      signal,
      temperature: 0.5,
      maxTokens: 1200
    });
    rationale = stripThink(summary).trim();
    // Validate rationale-action consistency: if 推荐 line names someone who isn't
    // top1, the LLM contradicted itself. Override the 推荐 line with a fact-grounded
    // sentence based on actual top1.
    if (top1) {
      const m = rationale.match(/^\s*推荐[:：]\s*(.+?)$/m);
      if (m && m[1] && !m[1].includes(top1)) {
        // Mismatch — patch the 推荐 line.
        const factual = `推荐：由 ${top1} 主做（基于 R1 BID 综合分最高）`;
        rationale = rationale.replace(/^\s*推荐[:：]\s*.+?$/m, factual);
      } else if (!m) {
        // No 推荐 line at all — prepend.
        rationale = `推荐：由 ${top1} 主做\n${rationale}`;
      }
    }
  } catch (err) {
    rationale = `推荐：（生成失败）\n论据：${(err as Error).message}\n分歧：—\n风险：—`;
  }

  const decomposition: SubtaskAssignment[] | undefined =
    state.config.splittable && assignments.length > 1 ? assignments : undefined;

  // Alternates = top R1 BIDs whose agent is NOT in the final assignments.
  // (Previously the field carried subtask assignees, which was meaningless.)
  const assigneeSet = new Set(assignments.map((a) => a.assignee));
  const altCandidates = (state.rounds_a.find((r) => r.round_num === 1)?.actions ?? [])
    .filter((a) => a.payload.type === 'BID')
    .map((a) => ({
      name: a.agent_name,
      score: a.payload.type === 'BID' ? a.payload.capability_fit + a.payload.load_fit + a.payload.collab_fit : 0
    }))
    .filter((c) => !assigneeSet.has(c.name))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((c) => c.name);

  const decision: PMADecisionV2 = {
    task_id: state.config.task_id,
    task_description: state.config.task_description,
    decomposition,
    top1: !decomposition ? top1 : undefined,
    top1_subtask: !decomposition && assignments[0] ? assignments[0] : undefined,
    alternatives: altCandidates,
    confidence,
    rationale,
    sim_replay_id: state.sim_id,
    track_a_summary: trackASummary,
    // Drop legacy track_b in single-track mode so UI doesn't render stale "Skeptical" line.
    track_b_summary: singleTrack ? '' : trackBSummary,
    ground_truth_evidence_count: evidenceCount,
    // tracks_agree only meaningful when there ARE two tracks. Omit when single.
    ...(singleTrack ? {} : { tracks_agree: tracksAgree }),
    converged,
    mode,
    reason_if_null: top1 ? undefined : 'no_convergence',
    ts: new Date().toISOString()
  };

  return decision;
}

interface TrackAnalysis {
  assignments: SubtaskAssignment[];
  converged: boolean;
}

function analyseTrack(rounds: RoundSummary[]): TrackAnalysis {
  // Pull SPLIT actions from R2; merge COMMITs from R3.
  const r2 = rounds.find((r) => r.round_num === 2);
  const r3 = rounds.find((r) => r.round_num === 3);
  if (!r2 || !r3) return { assignments: [], converged: false };

  // Find a SPLIT action — prefer the most recent in R2 (last word).
  const splits = r2.actions.filter((a) => a.payload.type === 'RECOMMEND_SPLIT');
  const split = splits[splits.length - 1];

  const assignments: SubtaskAssignment[] = [];
  if (split && split.payload.type === 'RECOMMEND_SPLIT') {
    for (const s of split.payload.subtasks) {
      // Find a BID for this assignee in R1 to get cap/load/collab.
      const r1 = rounds.find((r) => r.round_num === 1);
      const bid = r1?.actions.find((a) => a.agent_name === s.assignee && a.payload.type === 'BID');
      const fits = bid && bid.payload.type === 'BID' ? bid.payload : null;
      assignments.push({
        subtask: s.subtask,
        assignee: s.assignee,
        capability_fit: fits?.capability_fit ?? 5,
        load_fit: fits?.load_fit ?? 5,
        collab_fit: fits?.collab_fit ?? 5,
        rationale: s.reason,
        evidence_cited: bid?.evidence_cited ?? []
      });
    }
  } else {
    // No split — pick highest BID from R1.
    const r1 = rounds.find((r) => r.round_num === 1);
    const bids =
      r1?.actions
        .filter((a): a is AgentAction & { payload: { type: 'BID' } } => a.payload.type === 'BID')
        .sort((a, b) => {
          const ap = a.payload.type === 'BID' ? a.payload.capability_fit + a.payload.load_fit : 0;
          const bp = b.payload.type === 'BID' ? b.payload.capability_fit + b.payload.load_fit : 0;
          return bp - ap;
        }) ?? [];
    if (bids[0] && bids[0].payload.type === 'BID') {
      const top = bids[0];
      assignments.push({
        subtask: '主负责',
        assignee: top.agent_name,
        capability_fit: top.payload.capability_fit,
        load_fit: top.payload.load_fit,
        collab_fit: top.payload.collab_fit,
        rationale: top.payload.reason,
        evidence_cited: top.evidence_cited
      });
    }
  }

  const converged = r3.converged;
  return { assignments, converged };
}

function mergeAssignments(a: SubtaskAssignment[], b: SubtaskAssignment[]): SubtaskAssignment[] {
  // Prefer Track A (Optimistic); use B to supplement when A missing.
  if (a.length === 0) return b;
  if (b.length === 0) return a;

  const merged = a.map((x) => ({ ...x }));
  for (const ba of b) {
    const matchIdx = merged.findIndex((m) => m.assignee === ba.assignee || m.subtask === ba.subtask);
    if (matchIdx === -1) {
      // Skeptical introduced something Optimistic missed — append.
      merged.push(ba);
    }
  }
  return merged;
}

function assignmentsOverlap(a: SubtaskAssignment[], b: SubtaskAssignment[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  const aNames = new Set(a.map((x) => x.assignee));
  const bNames = new Set(b.map((x) => x.assignee));
  let overlap = 0;
  for (const n of aNames) if (bNames.has(n)) overlap++;
  return overlap / Math.max(aNames.size, bNames.size) >= 0.5;
}

function countEvidence(state: SimulationRunState): number {
  let c = 0;
  for (const r of [...state.rounds_a, ...state.rounds_b]) {
    for (const a of r.actions) c += a.evidence_cited.length;
  }
  return c;
}

function countR1Bids(state: SimulationRunState): number {
  return [...state.rounds_a, ...state.rounds_b]
    .filter((r) => r.round_num === 1)
    .flatMap((r) => r.actions)
    .filter((a) => a.payload.type === 'BID').length;
}

interface ConfidenceInputs {
  singleTrack: boolean;
  tracksAgree: boolean;
  evidenceCount: number;
  converged: boolean;
  assignmentCount: number;
  bidCount: number;
}

// Confidence model:
// - Single-track mode (current): score by R3 convergence + assignments built +
//   eligible-pool participation rate. No more tracks_agree gate.
// - Dual-track mode (legacy): keep cross-track agreement gate.
// Floor 0.70 (UX promise: never show < 70%).
function computeConfidence(c: ConfidenceInputs): number {
  let raw: number;
  if (c.singleTrack) {
    // Build score from internal sim health.
    let score = 0.55;
    if (c.assignmentCount > 0) score += 0.15;
    if (c.converged) score += 0.10;
    if (c.bidCount >= 4) score += 0.05;
    if (c.evidenceCount >= 5) score += 0.10;
    else if (c.evidenceCount >= 2) score += 0.05;
    raw = Math.min(0.95, score);
  } else {
    if (!c.tracksAgree && !c.converged) raw = 0.45;
    else if (!c.tracksAgree) raw = 0.55;
    else if (c.evidenceCount < 3) raw = 0.65;
    else if (c.evidenceCount < 5) raw = 0.75;
    else if (c.converged) raw = 0.88;
    else raw = 0.78;
  }
  if (raw < 0.70) raw = 0.70;
  return raw;
}

function summarizeTrack(rounds: RoundSummary[], track: 'optimistic' | 'skeptical'): string {
  const splits = rounds
    .find((r) => r.round_num === 2)
    ?.actions.filter((a) => a.payload.type === 'RECOMMEND_SPLIT');
  const split = splits?.[splits.length - 1];
  const objections =
    rounds
      .flatMap((r) => r.actions)
      .filter((a) => a.payload.type === 'OBJECT')
      .map((a) => a.agent_name) ?? [];
  const baseLabel = track === 'optimistic' ? 'Optimistic' : 'Skeptical';

  if (split && split.payload.type === 'RECOMMEND_SPLIT') {
    const summary = split.payload.subtasks
      .map((s) => `${s.subtask}→${s.assignee}`)
      .join('；');
    return `${baseLabel}: 拆 ${split.payload.subtasks.length} 子任务（${summary}）${
      objections.length > 0 ? ` · ${objections.length} objection` : ''
    }`;
  }
  return `${baseLabel}: 未拆 · ${objections.length} objection`;
}

function formatTrackForPrompt(rounds: RoundSummary[]): string {
  return rounds
    .map((r) => {
      const lines = r.actions
        .map((a) => {
          const p = a.payload;
          switch (p.type) {
            case 'BID':
              return `  ${a.agent_name}: BID cap=${p.capability_fit} load=${p.load_fit} collab=${p.collab_fit} 「${p.reason}」`;
            case 'DEFER':
              return `  ${a.agent_name}: DEFER → ${p.recommend} 「${p.reason}」`;
            case 'RECOMMEND_SPLIT':
              return `  ${a.agent_name}: SPLIT [${p.subtasks
                .map((s) => `${s.subtask}→${s.assignee}`)
                .join(' | ')}]`;
            case 'OBJECT':
              return `  ${a.agent_name}: OBJECT against「${p.against}」「${p.reason}」`;
            case 'COMMIT':
              return `  ${a.agent_name}: COMMIT「${p.subtask}」`;
          }
        })
        .join('\n');
      return `# Round ${r.round_num}\n${lines}`;
    })
    .join('\n');
}

// Pick ExecutionMode from TaskBrief + assignments. Pair-aware logic:
// - split: multiple subtasks
// - agent_led: ai_eligibility=full OR (task_kind in code/ops + quality_bar != external)
// - human_only: ai_eligibility=human_only OR task_kind=strategy/comms
// - co_pilot: ai_eligibility=assisted (default for research/writing/design)
function pickMode(brief: TaskBrief | undefined, assignments: SubtaskAssignment[]): ExecutionMode {
  if (assignments.length > 1) return 'split';
  if (!brief) return 'co_pilot';
  if (brief.ai_eligibility === 'human_only') return 'human_only';
  if (brief.ai_eligibility === 'full') return 'agent_led';
  if (brief.task_kind === 'strategy' || brief.task_kind === 'comms') return 'human_only';
  if (brief.task_kind === 'code' || brief.task_kind === 'ops') {
    return brief.quality_bar === 'external' ? 'co_pilot' : 'agent_led';
  }
  return 'co_pilot';
}

function stripThink(text: string): string {
  let s = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  const open = s.indexOf('<think>');
  if (open !== -1) s = s.slice(open + 7);
  return s.trim();
}

export { newTaskId };
