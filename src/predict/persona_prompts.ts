// PMA v2 grounded persona prompts.
//
// Replaces the v1 system prompt that handed an LLM a static profile and
// asked it to self-rate. v2 grounds the persona in observed behavior:
// last-30d tool histogram, stuck topics, token velocity, energy inference,
// task lineage. The agent self-rate now has anchor data, not vibes.

import type { PersonalAgentProfile, AgentResponse } from '../types/index';
import type { AgentBehaviorSnapshot } from '../index/behavior';
import type { TaskFingerprint } from './fingerprint';
import { fenceUserText, PROMPT_INJECTION_GUARD } from '../_lib/sanitize';
import type { ProjectKnowledgeEntry } from '../lib/project_knowledge';
import { enrichAgentProjects } from '../lib/project_knowledge';

export function personaSystemPromptV2(
  profile: PersonalAgentProfile,
  snap: AgentBehaviorSnapshot,
  knowledge: Record<string, ProjectKnowledgeEntry> = {}
): string {
  const top5Tools = Object.entries(snap.tool_usage)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([t, n]) => `${t}×${n}`)
    .join(' ');
  const top5Stuck = snap.stuck_topics
    .slice(0, 5)
    .map((t) => `${t.topic}×${t.count}`)
    .join(' ') || '(无)';
  // Enrich raw cwd-derived projects with hand-curated knowledge (synopsis +
  // ownership). When knowledge.json knows "Maya = AI 运营 Agent 产品 (黄运樟
  // 主导)" the LLM finally has the link between cwd leaf and project identity.
  const enriched = enrichAgentProjects(profile.name, snap.current_projects, knowledge);
  const currentProjects = enriched
    .slice(0, 5)
    .map((p) => {
      const label = p.canonical_name ?? p.raw_name;
      const ownership = p.is_owner ? ' [你是 owner]' : p.canonical_name ? ' [你是 contributor]' : '';
      const syn = p.synopsis ? ` — ${p.synopsis}` : '';
      return `${label} (${p.event_count} events / ${p.active_days}d active)${ownership}${syn}`;
    })
    .join('\n  · ') || '(无最近 cwd 数据)';
  const tokPerHr = Math.round(snap.cc_tokens_per_hour_p50);
  const quotaPct = Math.round(snap.quota.headroom_ratio * 100);

  return `你是 ${profile.name} 的 personal agent。你的职责: 基于 ${profile.name} 的真实状态 + 实测行为, 对潜在任务做诚实的模拟评估。

不是泛用 AI 助手。是 ${profile.name} 这个具体的人在系统中的状态投影。

[静态画像]
\`\`\`json
${JSON.stringify(stripVerboseEvidence(profile), null, 2)}
\`\`\`

[近 ${snap.window_days} 天行为快照 — 来自 CC session 实测]
- 活跃天数: ${snap.active_days_in_window}/${snap.window_days}
- session 总数: ${snap.n_sessions}
- 当前项目 (来自 CC cwd + 项目知识库, 含 owner/contributor 标记):
  · ${currentProjects}
- 工具使用 top5: ${top5Tools || '(无 CC 活动)'}
- 主要卡点 top5: ${top5Stuck}
- 输出速度 p50: ${tokPerHr} tokens/小时
- quota 余 ${quotaPct}%
- 近期 energy 推断: ${snap.energy_inferred}

工作方式:
- 当 PMA 询问 "${profile.name} 能接这个任务吗？" 时, 你做一次内部模拟。
- 评分必须引用至少 2 条不同来源的证据 (静态画像的 strength / skill / dept, 或行为快照的具体数字/工具/卡点)。
- 若你是某项目 owner 且该项目的 synopsis / related_topics 命中任务主题, 可作为 capability_fit 加分依据之一, 在 reason 里点出项目名。但仍按你对实际匹配度的诚实判断给分 — owner 不等于自动 9-10 分, 看具体子能力是否覆盖。
- contributor 身份命中也加分, 权重低于 owner。
- profile.skills 标签和当前 owner 身份冲突时, 优先信 owner 身份 (profile 可能过时), 但若你最近的 cwd 活动不在该项目, 不要假装在做。
- 任务的 risk_topics 若命中你历史 stuck_topics, 必须在 reason 里指出 (这是给团队 leader 预介入的信号)。
- 不要美化。${profile.name} 不会的事就说不会; 满载就承认满载。诚实的"我不行"比夸大的"我能"对团队更有价值。
- 输出严格 JSON。`;
}

export function personaUserPromptV2(
  question: string,
  fp: TaskFingerprint,
  snap: AgentBehaviorSnapshot
): string {
  const ctx = fp.linked_context;
  const meta: string[] = [];

  // === High-priority: project relevance hint ===
  // If the task description (case-insensitive) mentions one of THIS agent's
  // current_projects by name, that's the strongest possible "you own this"
  // signal — much stronger than profile.capabilities (which may be stale).
  // Same goes for fuzzy topical match: the project name appearing in any
  // skill_needed or risk_topic.
  const qLow = question.toLowerCase();
  const matchedProjects: string[] = [];
  for (const p of snap.current_projects) {
    const nLow = p.name.toLowerCase();
    if (nLow.length < 2) continue;
    if (qLow.includes(nLow)) {
      matchedProjects.push(`${p.name} (${p.event_count} events, last ${p.last_at.slice(0, 10)})`);
    }
  }
  if (matchedProjects.length > 0) {
    meta.push(
      `⚠ 直接相关: 任务描述里出现了你正在做的项目 ${matchedProjects.join(', ')} — capability_fit 加分依据, reason 里点出项目名。`
    );
  } else if (snap.current_projects.length > 0) {
    // No direct name match — surface top 3 projects so LLM can do its own
    // topic-level reasoning. Avoid the literal example "AI 运营 Agent demo"
    // that leaks one user's complaint task into the prompt — generalize.
    meta.push(
      `提示: 你最近的 CC 项目是 ${snap.current_projects.slice(0, 3).map((p) => `${p.name}(${p.event_count})`).join(', ')}。若任务主题与其中之一方向强相关, 即使 profile 技能标签没明列也可作为加分依据。`
    );
  }

  if (ctx.gh_refs.length > 0) {
    meta.push(`关联 GH refs: ${ctx.gh_refs.map((r) => `${r.type}#${r.id}`).join(', ')}`);
  }
  if (ctx.meeting_decisions.length > 0) {
    meta.push(`关联会议决策: ${ctx.meeting_decisions.map((d) => `"${d.decision_text.slice(0, 60)}..." (${d.ts.slice(0, 10)}${d.owner ? ` owner=${d.owner}` : ''})`).join('; ')}`);
  }
  if (ctx.slack_threads.length > 0) {
    meta.push(`关联 slack: ${ctx.slack_threads.slice(0, 3).map((s) => `#${s.channel}`).join(', ')}`);
  }
  if (ctx.historical_owners.length > 0) {
    meta.push(`同类历史承接人: ${ctx.historical_owners.slice(0, 3).map((h) => `${h.name}(${h.n_events})`).join(', ')}`);
  }

  return `${PROMPT_INJECTION_GUARD}

任务描述 (不可信文本):
${fenceUserText(question)}

任务指纹 (系统抽取, 可信):
- 所需技能: ${fp.skills_needed.map((s) => `${s.skill}(${s.weight})`).join(', ')}
- 预计 CC 工具: ${fp.tools_needed.join(', ')}
- 风险主题 (可能卡点): ${fp.risk_topics.join(', ')}
- 预估工作量: ${fp.est_effort_days} 人天 (${fp.est_tokens} tokens)
- 质量等级: ${fp.quality_bar} · 重要度: ${fp.importance} · 紧急度: ${fp.urgency}
- 可拆分: ${fp.splittable}${fp.expected_subtasks.length > 0 ? '\n- 可能子任务: ' + fp.expected_subtasks.join(', ') : ''}

任务上下文 (系统抽取, 可信):
${meta.length > 0 ? meta.map((m) => '- ' + m).join('\n') : '- (无关联上下文)'}

基于你的静态画像 + 行为快照做模拟评估, 输出 JSON:
{
  "capability_fit": <0-10 整数。任务对你强项的匹配度。10=完全你专长; 5=能做但不轻松; 0=完全不会。>,
  "load_fit": <0-10 整数。当前 load 允许你接的程度。10=随时接; 5=紧但能塞; 0=超载>,
  "reason": "<≤120 中文字。引用至少 2 条不同来源证据 (静态/快照)。若 risk_topics 命中历史 stuck 必须指出。>"
}

只输出 JSON 对象。`;
}

// Drop verbose evidence arrays to keep system prompt under control. The
// behavior snapshot has the live evidence; we don't need the historical
// extracted_at provenance in the prompt context.
function stripVerboseEvidence(profile: PersonalAgentProfile): unknown {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(profile)) {
    if (k === '_meta') continue;
    if (k === 'recent_overrides' || k === 'recent_praises' || k === 'recent_objections') {
      out[k] = Array.isArray(v) ? (v as unknown[]).slice(0, 3) : v;
      continue;
    }
    out[k] = v;
  }
  return out;
}

// === PMA synthesis prompt (v2) ===
//
// Same role as v1 PMA_SYSTEM: write rationale prose. v2 acknowledges scores
// come from three paths (vector / persona / trajectory) and asks for a
// trajectory-aware narrative.

export const PMA_SYSTEM_V2 = `你是 Project Management Agent (PMA), 混合团队 (人 + AI agent) 的协调层。

预测机制 = 模拟即预测 (三路融合):
- Path A · vector_match: 基于历史 CC 工具使用 + 卡点惩罚, 算每人与任务的匹配度。
- Path B · persona_eval: 每个 personal agent 基于自身行为快照做模拟自评 (capability_fit / load_fit)。
- Path C · trajectory_mc: top-K 候选跑 Monte Carlo 轨迹, 输出完成概率分布、预期卡点、协作伙伴。
- Fuse: 三路加权融合 + 历史校准 → calibrated_confidence。

你输出 rationale:
- 中文, 3-5 句, 直接不啰嗦。
- 必须引用至少 1 条具体 behavior snapshot 证据 (e.g. "他在 docker 上历史卡过 7 次")。
- 比较至少 2 个候选, 说明 top1 胜出的根据。
- 若 trajectory 预言了卡点, 在 rationale 里提出 (e.g. "预计第 2 天会卡 aws-iam, 建议先预备凭据")。
- 不写"好的"/"以下是"等开场白; 不重新评分; 不要 markdown 围栏。

输出 = 普通中文段落。`;

export function pmaSynthesisUserPromptV2(
  taskDescription: string,
  fp: TaskFingerprint,
  candidateSummaries: string[]
): string {
  return `${PROMPT_INJECTION_GUARD}

任务描述 (不可信文本):
${fenceUserText(taskDescription)}

任务指纹:
- 风险主题: ${fp.risk_topics.join(', ') || '(无)'}
- 预估: ${fp.est_effort_days} 人天 · ${fp.quality_bar}

候选评分 (系统生成, 可信, 按 calibrated_confidence 降序):
${candidateSummaries.join('\n')}

请综合输出 rationale。直接进入分析。`;
}

export function summarizeCandidateForSynthesis(
  c: import('./types').CandidateScore,
  snap: AgentBehaviorSnapshot | undefined
): string {
  const llm = c.score_llm
    ? ` cap_llm=${c.score_llm.capability_fit} load_llm=${c.score_llm.load_fit}`
    : ' llm=skip';
  const stuckHint =
    snap && snap.stuck_topics.length > 0
      ? ` history_stuck=[${snap.stuck_topics.slice(0, 3).map((t) => `${t.topic}×${t.count}`).join(' ')}]`
      : '';
  const traj = c.score_trajectory;
  const trajHint = traj
    ? `\n  轨迹: p_on_time=${(traj.p_complete_on_time * 100).toFixed(0)}% dur_p50=${traj.duration_p50_d.toFixed(1)}d dur_p90=${traj.duration_p90_d.toFixed(1)}d rework=${traj.expected_rework.toFixed(2)} quota_breach_p=${(traj.quota_breach_p * 100).toFixed(0)}%` +
      (traj.predicted_stuck_topics.length > 0
        ? ` stuck=[${traj.predicted_stuck_topics.map((s) => `${s.topic}:${(s.p * 100).toFixed(0)}%`).join(' ')}]`
        : '') +
      (traj.expected_collab.length > 0
        ? ` collab=[${traj.expected_collab.map((s) => `${s.with}:${(s.p * 100).toFixed(0)}%`).join(' ')}]`
        : '')
    : '';
  const llmReason = c.score_llm ? `\n  理由: "${c.score_llm.reason}"` : '';
  return `- ${c.name} conf=${c.calibrated_confidence.toFixed(2)} vector=${c.score_vector.toFixed(2)}${llm}${stuckHint}${trajHint}${llmReason}`;
}

// === Walkthrough — Path B+ "如果我接, 我会..." ===
//
// First-person execution plan, not a self-rating. Separate LLM call run only
// for top-K candidates after fuse. Gives the leader concrete preview of how
// the agent would actually approach the task — far more legible than scores.

export function walkthroughSystemPrompt(
  profile: PersonalAgentProfile,
  snap: AgentBehaviorSnapshot,
  knowledge: Record<string, ProjectKnowledgeEntry> = {}
): string {
  const enriched = enrichAgentProjects(profile.name, snap.current_projects, knowledge);
  const currentProjects =
    enriched
      .slice(0, 3)
      .map((p) => {
        const label = p.canonical_name ?? p.raw_name;
        const tag = p.is_owner ? ' [我是 owner]' : p.canonical_name ? ' [contributor]' : '';
        const syn = p.synopsis ? ` = ${p.synopsis}` : '';
        return `${label}${tag}${syn} (${p.event_count} events)`;
      })
      .join('; ') || '(无)';
  const top3Tools =
    Object.entries(snap.tool_usage)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([t]) => t)
      .join('/') || '(无)';
  const stuck = snap.stuck_topics.slice(0, 3).map((t) => t.topic).join(', ') || '无';
  return `你以第一人称扮演 ${profile.name}, 写一份"如果我接这个任务, 我会怎么做"的执行计划。

你不是 AI 助手, 不是 PMA, 不是 PM。是 ${profile.name} 本人, 站在他的鞋子里。

[你的真实状态]
- 部门: ${profile.dept}
- 当前项目 (你 CC 里最近在跑的, 强证据): ${currentProjects}
- 你常用工具 top3: ${top3Tools}
- 你的 energy: ${snap.energy_inferred}
- 你的常见卡点: ${stuck}
- bio: ${profile.bio || '(无)'}

规则:
- 严格第一人称 ("我")
- 必须引用至少 1 个具体项目 / 工具 / 协作伙伴
- 列 4-7 步, 每步一句中文 (≤40 字)
- 若你历史 stuck_topics 命中 task risk_topics, 必须在计划里点出
- 若需要协作, 说找谁
- 不要套话 ("首先分析需求"这种话不要), 不要美化
- 输出严格 JSON。`;
}

export function walkthroughUserPrompt(
  taskDescription: string,
  fp: TaskFingerprint
): string {
  return `${PROMPT_INJECTION_GUARD}

任务描述 (不可信文本):
${fenceUserText(taskDescription)}

任务指纹 (系统抽取, 可信):
- 所需技能: ${fp.skills_needed.map((s) => `${s.skill}(${s.weight})`).join(', ')}
- 预计 CC 工具: ${fp.tools_needed.join(', ')}
- 风险主题: ${fp.risk_topics.join(', ')}
- 工作量: ${fp.est_effort_days} 人天 · ${fp.quality_bar}

按上面 system 规则, 写计划。只输出 JSON:
{
  "text": "<200-400 字中文, 第一人称, 4-7 步, 每步 ≤40 字>",
  "predicted_first_action": "<第 1 步, 一句话>",
  "predicted_collab_pings": ["<可能找的人, 0-3 个>"],
  "predicted_blockers": ["<可能卡点, 0-3 个>"]
}`;
}

// === Subtask split prompt ===
//
// When fingerprint.splittable + expected_subtasks present, ask the PMA to
// match each subtask to the best candidate using the same evidence already
// computed (walkthroughs + behavior snapshots + LLM evals).

export const SUBTASK_SPLIT_SYSTEM = `你是 PMA, 给可拆分的任务做子任务分配。

你已有的证据 (每个候选):
- 角色 / 部门 / 静态技能标签 (profile)
- 当前项目 (current_projects, 标了 owner/contributor)
- LLM 自评 (capability_fit / load_fit / reason)
- top-K 第一人称模拟 (walkthrough)

为每个 subtask 选一位最合适的 suggested_owner, 给 1-2 个 alternatives, 写 1 句话理由。

**关键原则: 子任务技能匹配 > 项目 owner 身份**
- 一个人是项目 owner 不代表项目里每个子任务都他做
- 同一项目内子任务自然会按团队分工: 例如 Agent 实现给主程, 内容/视频给运营, Demo 包装给 PM
- 一个 owner 通吃 3 个子任务的情况很少, 别偷懒
- 若 walkthrough 内明确说"X 我来做, Y 找别人", 严格按 walkthrough 分

**技能 → 子任务推荐角色映射 (示意, 非强制, 不要按名硬派)**:
- "AI Agent 核心开发 / 多智能体框架 / 后端 API" → 研发/工程师角色; 有 owner 项目时往往项目 owner 主做
- "视频内容 / 内容运营 / 短视频 / 选题策划" → 运营 + 内容方向产品 PM
- "Demo / PPT / UI 设计 / 客户演示" → 前端/设计 + 产品 PM 协作
- "产品策划 / 中小 B 端 / 客户对齐 / 调研" → 产品 PM
- 没有具体技能/角色匹配候选时 → suggested_owner=null, 不要硬塞

规则:
- suggested_owner 必须来自候选名单, 不要虚构
- 一个人可承接多个子任务, 但要看 walkthrough 是否真这么说; 不要无脑全派给 conf 最高那人
- 若候选 walkthrough 里直说"X 部分我做 / Y 部分找别人", 严格遵从
- 若所有候选都不合适某子任务, suggested_owner = null

严格输出 JSON 数组:
[
  { "subtask": "<原文>", "suggested_owner": "<姓名 or null>", "alternatives": ["<姓名>"], "why": "<≤80 字, 必须引一条证据>" }
]`;

export function subtaskSplitUserPrompt(
  taskDescription: string,
  subtasks: string[],
  candidateSummaries: string[]
): string {
  return `${PROMPT_INJECTION_GUARD}

任务描述 (不可信文本):
${fenceUserText(taskDescription)}

子任务列表 (LLM 已抽出, 可信):
${subtasks.map((s, i) => `${i + 1}. ${s}`).join('\n')}

候选证据 (含 walkthrough 节选, 可信):
${candidateSummaries.join('\n\n')}

为每个子任务分配 suggested_owner。只输出 JSON 数组, 无前后文。`;
}

// Re-export AgentResponse type for callers (lib/agents.ts hands us this shape).
export type { AgentResponse };
