// Strategic planning engine — the "AI leader produces planning + guidance" core.
//
// Turns the vision → goal → project tree + REAL execution data into a forward-
// looking strategic plan: what each bet needs this week, where effort is
// misaligned, and the leverage-ranked next moves — each as a signable decision
// card. This is the 舵 (rudder), not the 镜子 (mirror): the daily brief recaps
// "what happened"; this answers "what should happen next, to advance the bets".
//
// Design (grounded in research on Linear / OKR tools / AI planners / AI chief-of
// -staff, esp. the HBS "trendslop" finding):
//   1. GAP AS MEASUREMENT — we compute the deterministic gap (desired vs current)
//      in code from real commits. The plan is the diff, not free advice.
//   2. GROUNDED BY CITATION — every fact fed to the LLM is a real number; the
//      LLM may only synthesize over them, never invent projects/products.
//   3. ⭐ FORCED COUNTER-ARGUMENT — the ONE empirically-proven antidote to generic
//      "trendslop" strategic advice: every recommendation MUST carry "why this
//      might be wrong". Context/prompt tuning barely move the bias; this does.
//   4. ⭐ LEADER ORIENTATION — the same data is filtered through the leader's
//      tenets/priorities/risk (private/leader_profile.json) so the output is "the
//      decision the boss would make", not a textbook recommendation.
//   5. LEVERAGE RANKING (Grove) — next moves ranked by reach / long-term compounding
//      / key-info-spread, so only the top few surface.
//   6. STARVING-BET + UNMAPPED detection — a vision area with little/no execution,
//      and high-activity work serving NO bet (the blind spot), are the highest-
//      value single signals; both computed deterministically.
//   7. HONEST — sparse data is flagged, never dressed as precision.
//
// MEMORY: reuses the cached visionView() (bounded). Adds ONE windowed 7d scan for
// the unmapped-repo blind spot. Never readAllEvents.

import { streamEvents } from '../lib/events';
import { memoTTL } from '../lib/ttl_cache';
import { llmCall } from '../lib/llm';
import { buildRepoAliasIndex } from './attribute_run';
import { visionView } from './vision_progress';
import { goalsView } from './goal_progress';
import { beijingDate, beijingDayBounds } from './daily_brief';
import { promises as fs } from 'node:fs';
import { PATHS } from '../lib/paths';
import type { Event } from '../types/events';

const PLAN_KEY = 'strategic-plan';

export interface DecisionCard {
  recommendation: string; // signable: "do X"
  evidence: string; // grounded citation (real numbers)
  counter_argument: string; // ⭐ why this might be wrong — the trendslop antidote
  leverage: 'high' | 'medium' | 'low';
  severity: 'high' | 'medium' | 'low';
}
export interface BetGap {
  area: string;
  desired: string; // target / deadline
  current: string; // real this-week state
  status: 'on-track' | 'starving' | 'at-risk' | 'quiet';
}
export interface UnmappedWork {
  repo: string;
  commits_7d: number;
  note: string; // track+goal, or deprioritize
}
export interface StrategicPlan {
  bluf: string; // bottom-line-up-front: the single most important move this week
  gaps: BetGap[];
  decisions: DecisionCard[];
  starving: string[]; // bets with no/low execution support
  unmapped: UnmappedWork[]; // high-activity work serving no bet
  generated_at: string;
  degraded?: 'llm-down'; // deterministic facts still returned, no LLM synthesis
}

interface LeaderProfile {
  name?: string;
  tenets?: string[];
  priorities?: string[];
  risk_appetite?: string;
  decision_criteria?: string;
}

async function readLeaderProfile(): Promise<LeaderProfile> {
  try {
    const raw = await fs.readFile(`${PATHS.root}/leader_profile.json`, 'utf8');
    return JSON.parse(raw) as LeaderProfile;
  } catch {
    return {};
  }
}

// ── Unmapped-active-repo blind spot ──────────────────────────────────────────
// Repos with real commits this week that are NOT a tracked project — invisible to
// the goal layer entirely (worse than tracked-but-ungoaled drift). ONE windowed
// 7d scan, sha-deduped, mapped against the active-project alias index.
const UNMAPPED_MIN_COMMITS = Number(process.env.PLAN_UNMAPPED_MIN ?? 5);

async function unmappedActiveRepos(): Promise<Array<{ repo: string; commits_7d: number }>> {
  const todayYmd = beijingDate();
  const endMs = beijingDayBounds(todayYmd).endMs;
  const startMs = beijingDayBounds(beijingDate(new Date(beijingDayBounds(todayYmd).startMs - 6 * 864e5 + 1000))).startMs;
  const commitBySha = new Map<string, Event>();
  const [repoIndex] = await Promise.all([
    buildRepoAliasIndex(),
    streamEvents(
      {
        since: new Date(startMs).toISOString(),
        until: new Date(endMs).toISOString(),
        type: ['gh.commit_pushed']
      },
      (e) => {
        const t = Date.parse(e.ts);
        if (!Number.isFinite(t) || t < startMs || t >= endMs) return;
        const sha = (e.evidence?.fields as { sha?: string } | undefined)?.sha;
        const key = sha || `${e.subject?.ref}@${e.ts}`;
        if (!commitBySha.has(key)) commitBySha.set(key, e);
      }
    ).catch(() => {})
  ]);
  const byRepo = new Map<string, number>();
  for (const e of commitBySha.values()) {
    const ref = String(e.subject?.ref ?? '').toLowerCase();
    if (!ref) continue;
    if (repoIndex.get(ref)) continue; // tracked → not our blind spot (drift handles it)
    const leaf = ref.split('/').pop()?.split('#')[0] ?? ref;
    byRepo.set(leaf, (byRepo.get(leaf) ?? 0) + 1);
  }
  return [...byRepo.entries()]
    .filter(([, n]) => n >= UNMAPPED_MIN_COMMITS)
    .map(([repo, commits_7d]) => ({ repo, commits_7d }))
    .sort((a, b) => b.commits_7d - a.commits_7d);
}

const SYSTEM = `你是团队 leader 的首席参谋(AI chief of staff)。给你一棵「战略赌注(vision area)→ 目标(goal)→ 项目」的树,加上每个节点的真实执行数据(本周 / 上周 commit、趋势、是否 at-risk),以及两类缺口:挨饿的赌注、未服务任何赌注的高产工作。

你的任务:产出一份「本周战略计划 / 指导」。这是给一把手看的「舵」,不是复盘镜子。

铁律(违反任意一条都算失败):
1. **每条建议必须可签字执行**:第一句就是「建议做 X」,而不是「可以考虑」。
2. **每条建议必须挂真实证据**(引我给你的具体数字),禁止编造项目或产品。
3. **⭐ 每条建议必须自带「反方论证」**:这条建议为什么可能是错的 / 最强的反对理由。这是硬性要求 —— 不许只给单边肯定。没有反方论证的建议无效。
4. **过 leader 的视角**:我会给你 leader 的信条 / 优先级 / 风险偏好。你的建议必须是「这个 leader 会拍的决定」,引用他的信条,而不是教科书式通用建议。
5. **高杠杆优先**(Grove):排序按「影响很多人 / 长期复利 / 关键信息扩散」,只给 Top 3-4,不要列全。
6. **前瞻不复盘**:说「本周该纠偏什么、怎么纠」,不说「上周发生了什么」。
7. **诚实**:数据稀疏就说不确定,不编造精确。绝不输出「正确的废话」(generic 战略建议)——研究证明喂上下文也救不了,只有具体 + 反方论证能戳穿。

只输出一个 JSON 对象,不要 markdown 围栏:
{
  "bluf": "<一句话:本周唯一最重要的战略动作,不带句号>",
  "decisions": [
    { "recommendation": "<建议做 X,可签字>", "evidence": "<引真实数字的依据>", "counter_argument": "<这条为什么可能错 / 最强反对>", "leverage": "high|medium|low", "severity": "high|medium|low" }
  ]
}`;

// The reasoning model often returns Chinese severity/leverage (高/中/低) instead
// of high/medium/low. Normalize both forms; default medium.
function normLevel(v: unknown): 'high' | 'medium' | 'low' {
  const s = String(v ?? '').trim().toLowerCase();
  if (s === 'high' || s === '高') return 'high';
  if (s === 'low' || s === '低') return 'low';
  return 'medium';
}

async function compute(): Promise<StrategicPlan> {
  const [vv, gv, unmapped, leader] = await Promise.all([
    visionView(),
    goalsView(),
    unmappedActiveRepos(),
    readLeaderProfile()
  ]);
  const generated_at = new Date().toISOString();

  // ── Deterministic gaps per bet (desired vs current), grounded ──────────────
  const gaps: BetGap[] = vv.areas.map((a) => {
    const targets = a.linked_goals.length;
    const atRisk = a.at_risk_count;
    let status: BetGap['status'] = 'on-track';
    if (a.linked_goals.length === 0) status = 'starving';
    else if (atRisk > 0) status = 'at-risk';
    else if (a.momentum !== 'active') status = 'quiet';
    return {
      area: a.title,
      desired: a.target ?? '(未设 target)',
      current: `本周 ${a.commits_7d} commit(上周 ${a.commits_prev_7d},趋势 ${a.trend})· ${targets} 目标 · ${atRisk} 风险 · ${a.momentum}`,
      status
    };
  });

  // Starving: areas with no execution OR no linked goals. Plus areas vastly
  // out-effort'd by a sibling (effort imbalance is a strategic signal).
  const starving: string[] = [];
  for (const a of vv.areas_without_goals) starving.push(`${a.title}:没有任何活跃目标在推进`);
  const active = vv.areas.filter((a) => a.linked_goals.length > 0);
  if (active.length >= 2) {
    const sorted = [...active].sort((x, y) => y.commits_7d - x.commits_7d);
    const top = sorted[0], bottom = sorted[sorted.length - 1];
    if (top.commits_7d >= 4 * Math.max(1, bottom.commits_7d) && bottom.commits_7d <= top.commits_7d * 0.25) {
      starving.push(`${bottom.title}:本周仅 ${bottom.commits_7d} commit,而 ${top.title} 有 ${top.commits_7d} — 力气严重偏向后者`);
    }
  }

  const unmappedWork: UnmappedWork[] = unmapped.map((u) => ({
    repo: u.repo,
    commits_7d: u.commits_7d,
    note: '未跟踪 + 不服务任何赌注 — 纳入跟踪并归到赌注,或明确判为支线 deprioritize'
  }));

  // ── Build grounded facts for the LLM ───────────────────────────────────────
  const lines: string[] = [];
  lines.push(`# Leader 视角(必须据此过滤建议)`);
  if (leader.name) lines.push(`leader: ${leader.name}`);
  if (leader.tenets?.length) lines.push(`信条:\n${leader.tenets.map((t) => '  - ' + t).join('\n')}`);
  if (leader.priorities?.length) lines.push(`优先级:\n${leader.priorities.map((t) => '  - ' + t).join('\n')}`);
  if (leader.risk_appetite) lines.push(`风险偏好:${leader.risk_appetite}`);
  if (leader.decision_criteria) lines.push(`决策标准:${leader.decision_criteria}`);

  lines.push(`\n# 战略赌注(vision)→ 目标 → 执行现状(本周, 北京时间)`);
  for (const a of vv.areas) {
    lines.push(`\n## 赌注「${a.title}」 [${gaps.find((g) => g.area === a.title)?.status}]`);
    lines.push(`  target: ${a.target ?? '(未设)'}`);
    lines.push(`  本周 ${a.commits_7d} commit · 上周 ${a.commits_prev_7d} · 趋势 ${a.trend} · momentum ${a.momentum} · ${a.at_risk_count} 个目标 at-risk`);
    for (const g of a.linked_goals) {
      lines.push(`    - 目标「${g.title}」 momentum=${g.momentum}${g.at_risk ? ' ⚠AT-RISK' : ''}`);
    }
    if (a.linked_goals.length === 0) lines.push(`    (无活跃目标 — 战略无执行)`);
  }

  // per-goal commit detail (from goalsView) for sharper evidence
  if (gv.goals.length) {
    lines.push(`\n# 目标级执行明细`);
    for (const g of gv.goals) {
      lines.push(`  - ${g.title}: 本周 ${g.commits_7d} commit(上周 ${g.commits_prev_7d}, 趋势 ${g.trend})${g.at_risk ? ` ⚠ ${g.at_risk_reason}` : ''}`);
    }
  }

  if (gv.drift.length) {
    lines.push(`\n# 已跟踪但未目标化(drift,执行无战略)`);
    for (const d of gv.drift.slice(0, 6)) lines.push(`  - ${d.name}: 本周 ${d.commits_7d} commit`);
  }
  if (unmappedWork.length) {
    lines.push(`\n# 未跟踪的高产工作(盲区,完全不在战略树里)`);
    for (const u of unmappedWork.slice(0, 8)) lines.push(`  - ${u.repo}: 本周 ${u.commits_7d} commit — 未跟踪`);
  }
  if (starving.length) {
    lines.push(`\n# 挨饿信号(战略有、执行无 / 力气失衡)`);
    for (const s of starving) lines.push(`  - ${s}`);
  }

  const facts = lines.join('\n');

  // ── LLM synthesis: BLUF + leverage-ranked decision cards (with counter-args) ─
  let bluf = '';
  let decisions: DecisionCard[] = [];
  let degraded: StrategicPlan['degraded'];
  try {
    const raw = await llmCall({
      system: SYSTEM,
      user: facts + `\n\n按规定 JSON 输出本周战略计划。记住:每条 decision 必须有 counter_argument,必须可签字,必须引真实数字,必须符合 leader 信条。`,
      jsonMode: true,
      temperature: 0.35,
      // Generous: the active provider is a reasoning model (<think> precedes the
      // JSON); too small a budget truncates the decision-card array → empty plan.
      maxTokens: 4500
    });
    const clean = raw.replace(/<think>[\s\S]*?<\/think>/gi, '');
    const start = clean.indexOf('{');
    const end = clean.lastIndexOf('}');
    if (start >= 0 && end > start) {
      const parsed = JSON.parse(clean.slice(start, end + 1)) as {
        bluf?: string;
        decisions?: unknown[];
      };
      bluf = typeof parsed.bluf === 'string' ? parsed.bluf.trim().slice(0, 120) : '';
      const rawD = Array.isArray(parsed.decisions) ? parsed.decisions : [];
      for (const it of rawD) {
        const r = it as Record<string, unknown>;
        const rec = typeof r.recommendation === 'string' ? r.recommendation.trim() : '';
        const ca = typeof r.counter_argument === 'string' ? r.counter_argument.trim() : '';
        // ENFORCE the rule: a decision without a counter-argument is invalid (dropped).
        if (!rec || !ca) continue;
        const lev = normLevel(r.leverage);
        const sev = normLevel(r.severity);
        decisions.push({
          recommendation: rec.slice(0, 200),
          evidence: typeof r.evidence === 'string' ? r.evidence.slice(0, 200) : '',
          counter_argument: ca.slice(0, 200),
          leverage: lev as DecisionCard['leverage'],
          severity: sev as DecisionCard['severity']
        });
      }
      // leverage-rank: high → low
      const order = { high: 0, medium: 1, low: 2 } as const;
      decisions.sort((a, b) => order[a.leverage] - order[b.leverage]);
      decisions = decisions.slice(0, 5);
    }
  } catch {
    degraded = 'llm-down';
  }

  // Deterministic fallback BLUF if the LLM gave nothing.
  if (!bluf) {
    const starvedBet = vv.areas.find((a) => a.linked_goals.length === 0 || a.momentum !== 'active');
    bluf = starving.length
      ? `战略失衡:${starving[0]}`
      : unmappedWork.length
        ? `${unmappedWork[0].repo} 本周 ${unmappedWork[0].commits_7d} commit 却不在任何赌注里 — 先定位`
        : starvedBet
          ? `赌注「${starvedBet.title}」执行不足,需补人力`
          : '两个赌注都在推进,本周保持节奏';
  }

  return { bluf, gaps, decisions, starving, unmapped: unmappedWork, generated_at, degraded };
}

export function buildStrategicPlan(): Promise<StrategicPlan> {
  return memoTTL(PLAN_KEY, 180_000, compute);
}
export const STRATEGIC_PLAN_KEY = PLAN_KEY;
