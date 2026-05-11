// Round 0 · Sim Config Generator.
// Picks the eligible agent pool for this task and decides splittable.
//
// The LLM call is the smart piece: given task + brief team graph summary,
// it returns who's eligible, who's excluded with reason, and whether the
// task should be decomposed.
//
// If the LLM call fails, we fall back to a deterministic heuristic:
// - all tier=deep are eligible
// - tier=lite are eligible if they have any praise/active task evidence
// - tier=stub are excluded
// - 老板 dept is always excluded

import { listAgents, getState } from '../lib/agents';
import { llmJSON } from '../lib/llm';
import {
  computePriority,
  STRATEGY_BY_PRIORITY,
  STRATEGY_ROUNDS,
  STRATEGY_LABEL,
  STRATEGY_DESCRIPTION,
  canInterrupt
} from '../types/index';
import type { SimulationConfig, TeamMemberProfile, ActionType, Priority } from '../types/index';

const ELIGIBLE_CAP = 8;

export interface ConfigGenInput {
  task_id: string;
  task_description: string;
  importance?: 'high' | 'low';
  urgency?: 'high' | 'low';
  estimated_effort_days?: number;
  quality_bar?: 'demo' | 'internal' | 'external';
}

export async function generateSimConfig(input: ConfigGenInput): Promise<SimulationConfig> {
  const agents = await listAgents();
  const profiles: TeamMemberProfile[] = [];
  for (const name of agents) {
    try {
      profiles.push(await getState(name));
    } catch {
      /* skip corrupted */
    }
  }

  // Heuristic fallback. Try LLM first; if it fails, use this.
  const heuristic = heuristicEligible(profiles, input.task_description);

  interface LlmConfigResult {
    eligible: string[];
    excluded: Record<string, string>;
    splittable: boolean;
    expected_subtasks: string[];
  }
  let llmResult: LlmConfigResult | null = null;
  try {
    llmResult = await llmJSON<LlmConfigResult>({
      system: `你是 PMA。基于任务和团队画像选出 eligible 候选。

**核心原则：AI agent (Claude Code) 是一等公民。如果一个工作 Claude Code 可以完成，优先交给 AI agent，不要默认给人。** 每位成员都拥有自己的 Claude Code 实例 (在 profile.agents.claude_code 字段)，看其 quota 余额、past_tasks 风格、collaboration_style 决定是否合适。

按 P0/P1/P2/P3 优先级分配偏好：
- P0 (重要+紧急)：可中断他人当前工作。挑最稳的承接人单点突破。Claude Code 作为辅助加速。
- P1 (重要+不紧急)：战略级。给成长曲线上的人 stretch 机会主做。Claude Code 视作助力。
- P2 (不重要+紧急)：可中断。优先 Claude Code；若必须人来，挑当前 load 最低的。
- P3 (不重要+不紧急)：默认全交给 Claude Code。除非真人主动想学。`,
      user: buildPrompt(input, profiles),
      maxTokens: 1500,
      temperature: 0.3,
      maxRetries: 1
    });
  } catch (err) {
    console.warn('[sim-config] LLM failed, using heuristic:', (err as Error).message);
  }

  const eligibleNames = (llmResult?.eligible ?? heuristic.eligible).slice(0, ELIGIBLE_CAP);
  const excluded = llmResult?.excluded ?? heuristic.excluded;

  const actionTypes: ActionType[] = ['BID', 'DEFER', 'RECOMMEND_SPLIT', 'OBJECT', 'COMMIT', 'REFINED_BID'];

  // Priority + strategy. Defaults to P2 / stretch_review when missing — matches
  // the original "balanced thinking" before users started classifying.
  const priority: Priority =
    input.importance && input.urgency
      ? computePriority(input.importance, input.urgency)
      : 'P2';
  const strategy = STRATEGY_BY_PRIORITY[priority];
  const rounds = STRATEGY_ROUNDS[strategy];

  return {
    task_id: input.task_id,
    task_description: input.task_description,
    rounds,
    eligible_agents: eligibleNames,
    excluded_with_reason: excluded,
    action_types: actionTypes,
    splittable: llmResult?.splittable ?? guessSplittable(input.task_description),
    expected_subtasks: llmResult?.expected_subtasks ?? [],
    tracks: ['optimistic'], // single track; strategy replaces dual-perspective
    per_round_timeout_ms: 25000,
    total_budget_ms: 90000,
    priority,
    strategy,
    can_interrupt: canInterrupt(priority)
  };
}

// Use these when prompting per-strategy in agent_executor.
export { STRATEGY_LABEL, STRATEGY_DESCRIPTION };

function heuristicEligible(profiles: TeamMemberProfile[], _task: string): {
  eligible: string[];
  excluded: Record<string, string>;
} {
  const eligible: string[] = [];
  const excluded: Record<string, string> = {};

  for (const p of profiles) {
    if (p.dept === '老板') {
      excluded[p.name] = '决策权人，不分配执行';
      continue;
    }
    if (p.tier === 'deep') {
      eligible.push(p.name);
      continue;
    }
    if (p.tier === 'lite') {
      const hasSignal =
        p.recent_praises.length > 0 ||
        p.workload.active.length > 0 ||
        p.capabilities.domains.length > 0;
      if (hasSignal) eligible.push(p.name);
      else excluded[p.name] = 'tier=lite 但 evidence 信号薄';
      continue;
    }
    excluded[p.name] = 'tier=stub，evidence 空';
  }
  // 强制 AI agent 一等公民: 把每位 deep tier 拥有 Claude Code 的成员之 agent 实例
  // 也作为可选承接者（用 "成员名 的 Claude Code" 形式纳入候选名义）。
  // 这里只在 prompt 层提示，名字仍是人。Report Agent 负责区分人/agent 承接。
  return { eligible, excluded };
}

function guessSplittable(task: string): boolean {
  const splitHints = ['评审会', 'PPT', 'demo', '发布', '运营矩阵', '内容', '视频'];
  return splitHints.some((h) => task.includes(h));
}

function buildPrompt(input: ConfigGenInput, profiles: TeamMemberProfile[]): string {
  const summary = profiles
    .map((p) => {
      const ev =
        p.recent_praises.map((e) => `praised: ${e.quote}`).join(' / ') ||
        p.workload.active.map((a) => `active: ${a.role}`).join(' / ') ||
        '';
      const aiTag = p.kind === 'ai' ? ' [AI agent]' : '';
      return `- ${p.name} [${p.tier}] ${p.dept}/${p.role}${aiTag}${ev ? ` · ${ev}` : ''}`;
    })
    .join('\n');

  const meta: string[] = [];
  if (input.importance && input.urgency) {
    const q =
      input.importance === 'high' && input.urgency === 'high'
        ? 'P0 重要+紧急'
        : input.importance === 'high'
          ? 'P1 重要+不紧急'
          : input.urgency === 'high'
            ? 'P2 不重要+紧急'
            : 'P3 不重要+不紧急';
    meta.push(`优先级：${q}`);
  }
  if (input.estimated_effort_days) meta.push(`预估工作量：${input.estimated_effort_days} 人天`);
  if (input.quality_bar) meta.push(`质量等级：${input.quality_bar}`);

  return `任务：${input.task_description}
${meta.length > 0 ? meta.map((m) => `· ${m}`).join('\n') + '\n' : ''}
团队画像（含人 + AI agent）：
${summary}

请输出 JSON：
{
  "eligible": ["<姓名>", ...],   // 上限 8 人，优先 deep tier 和与优先级匹配的人
  "excluded": {"<姓名>":"<原因>"},
  "splittable": <bool>,           // 是否需要拆任务（含主讲+视觉+内容等多模态时 true）
  "expected_subtasks": ["..."]    // 如 splittable，列出可能的子任务（不强制）
}

约束：
- 老板 永远 excluded（决策权人，由 dept === '老板' 或 role.includes('老板') 识别）
- tier=stub 默认 excluded（evidence 空）
- eligible 上限 8 人
- 每个候选人在被选中后，其 Claude Code agent 也作为搭档默认加入 — 在 reason 字段里说明 "由 X 主做 / 由 X·Claude Code 主做"
- 新人 (入职 < 30 天) 可纳入但 reason 标 stretch

只输出 JSON。`;
}
