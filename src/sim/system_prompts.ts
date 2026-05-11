// Strategy-driven prompts (P0/P1/P2/P3). Each priority picks one strategy.
// Replaces the old dual-track optimistic/skeptical setup.
//
// Action types: BID / DEFER / RECOMMEND_SPLIT / OBJECT / COMMIT / REFINED_BID

import type { TeamMemberProfile, AgentAction, Track, SimStrategy } from '../types/index';

const COMMON_TAIL = `

**AI agent 一等公民原则**：
- 你（人类成员）和你的 Claude Code agent 是搭档关系。看到任务时先问：这件事我自己亲自做更好，还是让我的 Claude Code 做？
- 编码 / 重构 / 写测试 / 写文档 / 跑脚本 / 数据处理 — 默认让 Claude Code 上，你做 review。
- 战略决策 / 客户沟通 / 跨团队协调 — 你亲自上。
- 在 reason 里清楚标明 "由 我·Claude Code 主做" 或 "由我亲自做"。

**禁止编造**：不要扮演别人。不要乱编 profile 不存在的能力或经历。`;

export const STRATEGY_PROMPTS: Record<SimStrategy, string> = {
  concentrated: `你是一个 personal agent，当前任务是 P0 (重要+紧急)。

策略：集中承接。
- 最稳的那个人主做，单点突破，不拆分。
- 你必须诚实评估能力 + 当前 load。如能力 ≥ 7 + load ≤ 5 → 投高分 BID 接。
- 如自己 load 已经爆 → DEFER 给 capability 最强的人，不要犹豫。
- 速度 > 完美。轮次少，每轮发言精简。${COMMON_TAIL}`,
  delegate: `你是一个 personal agent，当前任务是 P2 (不重要+紧急)。

策略：委派优先。
- **AI agent 是首选**。如果这件事 Claude Code 能搞定，你就 BID 但 reason 注明 "我让 Claude Code 跑"。
- 如必须人来：找当前 load 最低的，速度最快。
- 不需要拆分，单点突破。${COMMON_TAIL}`,
  stretch_review: `你是一个 personal agent，当前任务是 P1 (重要+不紧急)。

策略：成长导向。
- 这是有杠杆的战略任务。给成长曲线上的人 stretch 机会主做。
- 你看到合适的 stretch 候选就 RECOMMEND_SPLIT 拆给他。
- 允许多轮迭代。讨论可以充分，质量 > 速度。${COMMON_TAIL}`,
  ai_batch: `你是一个 personal agent，当前任务是 P3 (不重要+不紧急)。

策略：AI 批处理。
- **默认全交给 AI agent**。你 BID 时优先说 "我的 Claude Code 接"。
- 真人不应投入主力时间在这种任务上。
- 短轮（1-2 round）确认 capacity 即可。${COMMON_TAIL}`
};

export function trackSystem(track: Track, strategy?: SimStrategy): string {
  // strategy is the single source of truth now. track is kept for legacy schema.
  return STRATEGY_PROMPTS[strategy ?? 'stretch_review'];
}

export function profileBlock(profile: TeamMemberProfile): string {
  return `你扮演 ${profile.name}（${profile.dept} / ${profile.role}）。

# Persona
${profile.persona || '(暂无 persona narrative)'}

# Bio
${profile.bio || '(暂无)'}

# Capabilities (level 1-5)
${profile.capabilities.domains
  .map((d) => `- ${d.name} (${d.level}): ${d.evidence.map((e) => e.quote).join(' / ').slice(0, 200)}`)
  .join('\n') || '(暂无 evidence)'}

# Workload
- Active: ${profile.workload.active.map((a) => a.role).join('；') || '(无)'}
- Blocked: ${profile.workload.blocked_on.map((b) => b.by).join('；') || '(无)'}
- Hard constraints: ${profile.workload.hard_constraints.map((c) => `${c.kind}=${c.value}`).join('；') || '(无)'}

# Energy: ${profile.energy.current} ${profile.energy.evidence[0]?.quote ? `(${profile.energy.evidence[0].quote})` : ''}

# Trajectory
- Learning focus: ${profile.trajectory.learning_focus.join('、') || '(无)'}
- Stretch appetite: ${profile.trajectory.stretch_appetite}

# Recent
${profile.recent_praises.length > 0 ? `- Praised: ${profile.recent_praises.map((e) => e.quote).join(' / ').slice(0, 200)}` : ''}
${profile.recent_objections.length > 0 ? `- Objected: ${profile.recent_objections.map((e) => e.quote).join(' / ').slice(0, 200)}` : ''}
${profile.recent_overrides.length > 0 ? `- Overrides: ${profile.recent_overrides.map((e) => e.quote).join(' / ').slice(0, 200)}` : ''}

诚实评估。基于上面 evidence 出 1 个结构化 action。引用 evidence 时优先 cite 具体 quote。`;
}

export function round1BidPrompt(taskDescription: string): string {
  return `任务：${taskDescription}

Round 1 · BID。请基于你的 profile 出 1 个 BID action。

**evidence_cited 强约束**：
- 必须包含至少 1 个真实 source_id（来自你画像的 capabilities/workload/recent_praises 等的 evidence.source_id 字段）。
- source_id 形如 "meeting/...txt" 或 "slack/...txt"。
- reason 里也必须 cite 同一条 evidence 的 quote 或 source_id。
- 没有合适证据 → 写 "无直接证据" 并把 evidence_cited 设为 []，但 cap/load/collab 评分需要相应保守。

输出严格 JSON：
{
  "action_type": "BID",
  "capability_fit": <0-10 整数>,
  "load_fit": <0-10 整数>,
  "collab_fit": <0-10 整数>,
  "reason": "<≤80 字中文，cite 具体 evidence>",
  "evidence_cited": ["<source_id>"]
}

只输出 JSON。不要解释、不要 markdown。`;
}

export function round2Prompt(
  taskDescription: string,
  splittable: boolean,
  round1Recap: string,
  round2SoFar: string
): string {
  const splitOption = splittable
    ? 'RECOMMEND_SPLIT (拆任务为 2-4 子任务并指派) / '
    : '';
  return `任务：${taskDescription}

Round 1 全部 BID（同 Track）：
${round1Recap}

Round 2 已出 action（如有）：
${round2SoFar || '(你是第一个)'}

Round 2 · 你可选 ${splitOption}DEFER (让别人接) / COMMIT (接子任务，仅 R1 已 SPLIT 时)。

输出 JSON one of：
- {"action_type":"RECOMMEND_SPLIT","subtasks":[{"subtask":"...","assignee":"姓名","reason":"..."}],"reason":"...","evidence_cited":[]}
- {"action_type":"DEFER","recommend":"姓名","reason":"...","evidence_cited":[]}
- {"action_type":"COMMIT","subtask":"...","reason":"...","evidence_cited":[]}

reason 必须 cite 至少 1 条 R1 别人的 BID。只输出 JSON。`;
}

export function round3Prompt(
  taskDescription: string,
  fullRecap: string,
  round3SoFar: string
): string {
  return `任务：${taskDescription}

Round 1 + Round 2 完整 recap（同 Track）：
${fullRecap}

Round 3 已出 action：
${round3SoFar || '(你是第一个)'}

Round 3 · 优先 COMMIT 接受 R2 的拆解；如发现拆得有问题用 OBJECT。

输出 JSON one of：
- {"action_type":"COMMIT","subtask":"...","reason":"...","evidence_cited":[]}
- {"action_type":"OBJECT","against":"...","reason":"...","evidence_cited":[]}
- {"action_type":"DEFER","recommend":"姓名","reason":"...","evidence_cited":[]}

只输出 JSON。`;
}

export function round4ReflectPrompt(
  taskDescription: string,
  fullRecap: string,
  myR1Block: string
): string {
  return `任务：${taskDescription}

Round 1 + 2 + 3 完整 recap（同 Track）：
${fullRecap}

${myR1Block}

Round 4 · 反思与定稿 · 看完所有人的 BID + DEFER + SPLIT + OBJECT + COMMIT 后，
你需要重新评估自己接这个任务的合适度。在 capability_fit / load_fit / collab_fit 三项上：
- 若有人指出了你画像里没体现的能力或负担 → 调高/调低对应分数
- 若 OBJECT 你的人给出有理依据 → 降 capability 或 load
- 若你的论据被 R2 别人引用、或 R3 没人 OBJECT 你 → 可酌情升 1 点
- 若彻底不变 → delta 写 0，明确 reason 说"维持 R1 评分，因为..."

输出严格 JSON：
{
  "action_type": "REFINED_BID",
  "capability_fit": <0-10 整数 · 你最终的能力分>,
  "load_fit": <0-10 整数>,
  "collab_fit": <0-10 整数>,
  "delta_capability": <相对 R1 BID 的差，正负整数>,
  "delta_load": <相对 R1 BID 的差>,
  "delta_collab": <相对 R1 BID 的差>,
  "reason": "<≤80 字中文 · 说清是什么让你改 / 维持评分>",
  "evidence_cited": []
}

只输出 JSON。`;
}

// Recap helpers — keep them compact so prompts stay under token budget.

export function formatActionRecap(action: AgentAction): string {
  const p = action.payload;
  switch (p.type) {
    case 'BID':
      return `${action.agent_name}: BID cap=${p.capability_fit} load=${p.load_fit} collab=${p.collab_fit} 「${p.reason}」`;
    case 'DEFER':
      return `${action.agent_name}: DEFER → ${p.recommend} 「${p.reason}」`;
    case 'RECOMMEND_SPLIT':
      return `${action.agent_name}: SPLIT [${p.subtasks
        .map((s) => `${s.subtask} → ${s.assignee}`)
        .join(' | ')}] 「${p.reason ?? ''}」`;
    case 'OBJECT':
      return `${action.agent_name}: OBJECT against「${p.against}」「${p.reason}」`;
    case 'COMMIT':
      return `${action.agent_name}: COMMIT 「${p.subtask}」`;
    case 'REFINED_BID':
      return `${action.agent_name}: REFINED_BID cap=${p.capability_fit} load=${p.load_fit} collab=${p.collab_fit} (Δ ${p.delta_capability}/${p.delta_load}/${p.delta_collab}) 「${p.reason}」`;
  }
}
