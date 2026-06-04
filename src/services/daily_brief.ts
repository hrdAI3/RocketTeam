// Daily leader brief — the first "digest + predict" step (vs the existing
// "detect + nudge"). Once per working day we synthesize ONE narrative for the
// leader answering: what happened across the team yesterday + what needs your
// attention today + a prioritized suggestion.
//
// Built entirely on data that already works today (no dependency on AgentRun
// attribution coverage, which is still climbing):
//   - workboard view (projects, anomalies, blocked, unclustered)
//   - cached per-person work summaries (who's working on what)
//   - yesterday's commits / PRs per project (from events, Beijing-day window)
//   - roster health (compliance gaps, departure suspects)
//
// Delivery (wired by monitor_loop + /api/brief): Slack DM to the leader each
// working-day morning, AND a card at the top of /status. Cached by Beijing
// date in sync_state/daily_brief.json so the page is instant and the DM fires
// exactly once per day.

import { readSyncState, writeSyncState, streamEvents } from '../lib/events';
import { getWorkboardView } from './workboard';
import { goalsView } from './goal_progress';
import { readCachedSummaries } from './work_summary';
import { readRoster, lookupByName } from '../lib/team_roster';
import { llmCall } from '../lib/llm';
import { getToken, openConversation } from '../lib/slack';
import { isBotPaused } from '../lib/bot_pause';
import { isWorkingDay } from '../lib/workdays';
import type { Event } from '../types/events';

const STATE_KEY = 'daily_brief';
const DELIVER_KEY = 'daily_brief_deliver';
// Diagnostics-only marker — written on EVERY deliverDailyBriefIfDue return path
// (incl. no-ops and errors). KEPT DISTINCT from DELIVER_KEY: DELIVER_KEY stays a
// clean {lastDate} once-per-day idempotency gate and must never be entangled
// with diagnostics (a malformed merge could miss a brief or double-send).
const DELIVER_ATTEMPT_KEY = 'daily_brief_attempt';
const LEADER_NAME = process.env.LEADER_NAME ?? '戴昊然';
// Don't push the morning brief before this Beijing hour (avoid a 03:00 ping if
// the monitor restarts overnight). Default 8am.
const BRIEF_MIN_HOUR = Number(process.env.BRIEF_MIN_HOUR ?? 8);

export interface BriefAttentionItem {
  text: string;            // one-line, what to look at
  why: string;             // one phrase, why it matters
  severity: 'high' | 'medium' | 'low';
}
export interface DailyBrief {
  date: string;            // Beijing YYYY-MM-DD this brief covers
  headline: string;        // <= 1 line, the day in a phrase
  yesterday: string;       // 2-3 sentences: activity + what moved
  attention: BriefAttentionItem[]; // prioritized, 3-6 items
  suggestion: string;      // one prioritized next action for the leader
  signals: BriefSignals;   // the raw numbers we fed the LLM (for the UI + audit)
  generated_at: string;    // ISO
}
export interface BriefSignals {
  active_people: number;
  commits_yesterday: number;
  prs_yesterday: number;
  top_projects: Array<{ name: string; commits: number }>;
  blocked_projects: string[];
  open_anomalies: number;
  unattributed_threads: number;
  compliance_gaps: number;
  // ── goal layer (grounded from goalsView; goals are strategy, not hygiene) ──
  goals_total: number;     // active goals
  goals_at_risk: number;   // goals with a blocked or went-quiet linked project
  drift_count: number;     // active projects with recent commits serving no goal
}
interface BriefState {
  byDate?: Record<string, DailyBrief>;
}

// Exported so other now-anchored consumers (goal_progress.ts) reuse the SAME
// Beijing-day windowing instead of re-deriving the UTC±8 offset (a second
// copy drifts). beijingDate → 'YYYY-MM-DD' for a Beijing wall clock instant;
// beijingDayBounds → the UTC [start,end) ms of that Beijing calendar day.
export function beijingDate(d = new Date()): string {
  return d.toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(0, 10);
}
export function beijingDayBounds(ymd: string): { startMs: number; endMs: number } {
  // ymd is a Beijing calendar date. Beijing = UTC+8, so the day starts at
  // ymd 00:00 +08:00 = (ymd-1) 16:00 UTC.
  const [y, m, d] = ymd.split('-').map(Number);
  const startMs = Date.UTC(y, m - 1, d, 0, 0, 0) - 8 * 60 * 60 * 1000;
  return { startMs, endMs: startMs + 24 * 60 * 60 * 1000 };
}
// Full Beijing wall-clock datetime 'YYYY-MM-DD HH:mm:ss' for logging/observability.
export function beijingDateTime(d = new Date()): string {
  return d.toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' });
}

// One attempt record — purely additive observability, written on EVERY
// deliverDailyBriefIfDue return path. Never gates delivery.
export interface DeliverAttempt {
  at: string;          // ISO UTC of the attempt
  at_beijing: string;  // 'YYYY-MM-DD HH:mm:ss' Beijing wall clock
  date: string;        // Beijing YMD the attempt targeted
  delivered: boolean;
  reason?: string;
}

// SINGLE SOURCE OF TRUTH for the brief delivery window predicate — reused by
// the health route's `stale` flag so the health view agrees with the real gate
// (working-day AND now >= BRIEF_MIN_HOUR Beijing) and never false-alarms on
// weekends / before 8am. Mirrors the >=8am + isWorkingDay gates in
// deliverDailyBriefIfDue (semantics identical; the actual delivery gate is
// unchanged — this is a read-only mirror).
export async function isBriefDueWindow(now = new Date()): Promise<boolean> {
  const nowHour = Number(
    now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai', hour: '2-digit', hour12: false })
  );
  if (Number.isFinite(nowHour) && nowHour < BRIEF_MIN_HOUR) return false;
  return isWorkingDay(now);
}

function repoNameOf(ref: string | undefined): string {
  if (!ref) return '?';
  const bare = ref.split('#')[0]; // strip PR number
  const slash = bare.lastIndexOf('/');
  return slash >= 0 ? bare.slice(slash + 1) : bare;
}

// Gather the deterministic signal block — the numbers + facts we hand the LLM.
async function gatherSignals(yesterdayYmd: string): Promise<{
  signals: BriefSignals;
  facts: string;
}> {
  // MEMORY-BOUNDED windowed read. Was readAllEvents() (loads ~850MB into RSS
  // ≈4GB) — but the brief builds on /status page load + /api/brief, so that was
  // an on-demand 4GB spike. gatherSignals only consumes yesterday's gh.* commits
  // /PRs, so stream a since/until-bounded pass (same proven pattern as goalsView)
  // and dedup inline. SHA-DEDUP IS MANDATORY (events.jsonl holds ~20x duplicate
  // gh.commit_pushed): key by sha, fall back to ref@ts. PRs by type+ref+actor.
  const { startMs, endMs } = beijingDayBounds(yesterdayYmd);
  const inDay = (e: Event): boolean => {
    const t = Date.parse(e.ts);
    return Number.isFinite(t) && t >= startMs && t < endMs;
  };
  const commitBySha = new Map<string, Event>();
  const prByKey = new Map<string, Event>();
  const [view, summaries, roster, , gview] = await Promise.all([
    getWorkboardView().catch(() => null),
    readCachedSummaries().catch(() => new Map()),
    readRoster().catch(() => ({ members: [] as never[] })),
    streamEvents(
      {
        since: new Date(startMs).toISOString(),
        until: new Date(endMs).toISOString(),
        type: ['gh.commit_pushed', 'gh.pr_opened', 'gh.review_submitted']
      },
      (e) => {
        if (!inDay(e)) return;
        if (e.type === 'gh.commit_pushed') {
          const sha = (e.evidence?.fields as { sha?: string } | undefined)?.sha;
          const key = sha || `${(e.subject as { ref?: string }).ref}@${e.ts}`;
          if (!commitBySha.has(key)) commitBySha.set(key, e);
        } else {
          const key = `${e.type}:${(e.subject as { ref?: string }).ref}:${e.actor}`;
          if (!prByKey.has(key)) prByKey.set(key, e);
        }
      }
    ).catch(() => {}),
    // goalsView is its own bounded 14d streamEvents pass. Amortized: the brief is
    // cached once per Beijing day. import direction is daily_brief→goal_progress
    // (goal_progress imports beijingDate/bounds FROM here), no circular import.
    goalsView().catch(() => ({ goals: [], drift: [], window_days: 7 as const, generated_at: '' }))
  ]);

  // Exclude departed members. The brief draws "who's working on what" from
  // cached work summaries (keyed by name), which persist after someone leaves —
  // so without this filter a left member (status==='left') keeps showing up
  // "working" in the brief. Drop them from the active count + headlines.
  const leftNames = new Set(
    (roster.members as Array<{ name: string; status: string }>)
      .filter((m) => m.status === 'left')
      .map((m) => m.name)
  );
  const activeSummaries = new Map(
    [...(summaries as Map<string, { headline: string; staleAt?: string }>).entries()].filter(
      ([name]) => !leftNames.has(name)
    )
  );

  // commitBySha / prByKey populated by the windowed streamEvents pass above
  // (read-side sha-dedup is mandatory — events.jsonl holds ~20x duplicate
  // gh.commit_pushed; counting raw events reports absurd numbers like 801 vs ~40).
  const commits = [...commitBySha.values()];
  const prs = [...prByKey.values()];
  // commits per repo name
  const perRepo = new Map<string, number>();
  for (const c of commits) {
    const n = repoNameOf((c.subject as { ref?: string } | undefined)?.ref);
    perRepo.set(n, (perRepo.get(n) ?? 0) + 1);
  }
  const topProjects = [...perRepo.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([name, count]) => ({ name, commits: count }));

  const blocked = (view?.projects ?? []).filter((p) => p.status === 'blocked').map((p) => p.name);
  // Exclude our OWN plumbing noise from the anomaly stream the brief sees:
  // project.unattributed fires once per un-clustered thread (it's a symptom of
  // attribution coverage, not a team problem) and would otherwise dominate the
  // brief as "urgent". The unattributed COUNT still flows in as a single
  // low-key hygiene signal below; the per-thread anomalies are dropped here so
  // the LLM focuses on real blockers/quota/danger anomalies.
  const anomalies = (view?.anomalies ?? []).filter(
    (a) => a.severity_hint !== 'fyi' && a.rule !== 'project.unattributed'
  );
  const unattributed = (view?.unclustered ?? []).length;

  // compliance gaps: roster members (active, with slack) not github-compliant
  const gaps = (roster.members as Array<{ status: string; slack?: { user_id?: string | null }; github?: { ok?: boolean; login?: string | null } }>)
    .filter((m) => m.status !== 'left' && m.slack?.user_id && !m.github?.ok)
    .map((m) => m.github?.login ?? '');

  const signals: BriefSignals = {
    active_people: activeSummaries.size,
    commits_yesterday: commits.length,
    prs_yesterday: prs.length,
    top_projects: topProjects,
    blocked_projects: blocked,
    open_anomalies: anomalies.length,
    unattributed_threads: unattributed,
    compliance_gaps: gaps.length,
    goals_total: gview.goals.length,
    goals_at_risk: gview.goals.filter((g) => g.at_risk).length,
    drift_count: gview.drift.length
  };

  // Human-readable facts block for the LLM. Keep it dense + grounded.
  const lines: string[] = [];
  lines.push(`# 昨天(${yesterdayYmd}, 北京时间)团队信号`);
  lines.push(`活跃成员(有 work summary): ${activeSummaries.size}`);
  lines.push(`昨日 commit: ${commits.length} · PR/review: ${prs.length}`);
  if (topProjects.length) lines.push(`commit 最多的项目: ${topProjects.map((p) => `${p.name}(${p.commits})`).join(', ')}`);
  if (blocked.length) lines.push(`blocked 项目: ${blocked.join(', ')}`);
  lines.push(`待处理异常(非 fyi): ${anomalies.length}`);
  if (anomalies.length) {
    for (const a of anomalies.slice(0, 8)) {
      const subj = a.subject?.ref ?? '';
      lines.push(`  - [${a.severity_hint}] ${a.rule} · ${subj}`);
    }
  }
  lines.push(`未归项目的工作线: ${unattributed}`);
  lines.push(`GitHub 合规未配齐: ${gaps.length}${gaps.length ? ' (' + gaps.filter(Boolean).slice(0, 8).join(', ') + ')' : ''}`);
  // ── 目标层 — are we progressing toward our goals? (strategy, not hygiene) ──
  if (gview.goals.length) {
    const onTrack = gview.goals.filter((g) => !g.at_risk && g.momentum === 'active');
    const atRisk = gview.goals.filter((g) => g.at_risk);
    lines.push(`\n# 目标层(7d)`);
    lines.push(`活跃目标 ${gview.goals.length} · 推进中 ${onTrack.length} · 风险 ${atRisk.length}`);
    for (const g of atRisk) {
      lines.push(`  - [风险·高] 目标「${g.title}」: ${g.at_risk_reason ?? ''} (本周 ${g.commits_7d} commit, 趋势 ${g.trend})`);
    }
    if (onTrack.length) {
      lines.push(`  推进中: ${onTrack.map((g) => `${g.title}(${g.commits_7d},${g.trend})`).join(', ')}`);
    }
    const drift = gview.drift.slice(0, 2);
    if (drift.length) {
      lines.push(`  未目标化的活跃项目(可考虑建目标,低优): ${drift.map((d) => `${d.name}(${d.commits_7d})`).join(', ')}`);
    }
  }
  // who's working on what (cached headlines)
  if (activeSummaries.size) {
    lines.push(`\n# 每人在做什么(work summary headline)`);
    for (const [name, s] of activeSummaries) {
      lines.push(`  - ${name}: ${s.headline}${s.staleAt ? ' (stale)' : ''}`);
    }
  }
  return { signals, facts: lines.join('\n') };
}

const SYSTEM = `你是团队 leader 安子岩的参谋长。每个工作日早晨给他一份「昨天发生了什么 + 今天该看什么」的简报。
读给你的团队信号(commit/PR、项目状态、异常、每人在做什么、合规缺口),综合成一段对 leader 有用的叙事。

只输出一个 JSON 对象,不要 markdown 围栏,结构:
{
  "headline": "<不超过 20 字一句话,概括这一天的整体态势,不带句号>",
  "yesterday": "<2-3 句中文:昨天团队整体活跃度 + 哪些项目有明显推进。只引用给的数据,不许编进度百分比>",
  "attention": [
    { "text": "<一句话,今天 leader 该看的一件事>", "why": "<一个短语,为什么重要>", "severity": "<high|medium|low>" }
  ],
  "suggestion": "<一句话,今天最该先做的一件事(从 attention 里挑最高杠杆的)>"
}

要求:
- 聚焦**真实的团队 / 项目进展和卡点**:哪些项目在推进、哪些真卡住了(blocked)、谁可能需要帮助、有没有重要产出。这才是 leader 关心的。
- **以下是系统内务(hygiene),系统已自动处理,不要当成紧急事项、不要主导简报**:「未归项目的工作线 / unattributed 异常」「GitHub 合规未配齐」「未映射 CC actor」「project.unattributed 规则」。这些最多在末尾一句带过、severity 一律 low,且只在数量很大时才提。它们是我们系统自己的管线指标,不是团队的问题。
- **目标层是战略,不是 hygiene**:at-risk 目标(linked 项目 blocked 或上周有 commit 本周归零)是真实的战略卡点,放进 attention 最前面、severity=high。drift(未目标化的活跃项目)只是建议,最多末尾一条 severity=low『可为 X 建立目标』。推进中的目标提一句即可,不占 attention。
- attention 按重要性排,3-6 条:blocked 项目、act-now 异常、某人异常状态(高活跃零产出 / stale 摘要)排最前。
- 只引用给的数据。真没有值得 leader 看的就如实说「团队运转正常,无需特别关注」,别用 hygiene 硬凑紧急感。
- 中文,简洁,像参谋长对一把手汇报,不啰嗦。`;

function clampLine(s: unknown, max: number): string {
  const t = String(s ?? '').replace(/\*\*|__|`|^#+\s+/g, '').replace(/[。.\s]+$/, '').trim();
  return t.length <= max ? t : t.slice(0, max) + '…';
}

export async function buildDailyBrief(opts: { force?: boolean } = {}): Promise<DailyBrief> {
  const today = beijingDate();
  const state = ((await readSyncState<BriefState>(STATE_KEY)) ?? {}) as BriefState;
  const byDate = state.byDate ?? {};
  if (!opts.force && byDate[today]) return byDate[today];

  // The brief covers YESTERDAY's activity (it's a morning recap). yesterday =
  // today - 1 Beijing day.
  const ymdToday = today;
  const yd = new Date(beijingDayBounds(ymdToday).startMs - 1000); // a moment before today 00:00 CST → yesterday
  const yesterdayYmd = beijingDate(yd);

  const { signals, facts } = await gatherSignals(yesterdayYmd);

  let parsed: { headline?: string; yesterday?: string; attention?: unknown[]; suggestion?: string } = {};
  try {
    const raw = await llmCall({
      system: SYSTEM,
      user: facts + `\n\n按规定 JSON 结构输出今天(${ymdToday})给 leader 的简报。`,
      jsonMode: true,
      temperature: 0.3,
      maxTokens: 1200
    });
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    // LLM down → deterministic fallback from signals only.
    parsed = {};
  }

  const attention: BriefAttentionItem[] = Array.isArray(parsed.attention)
    ? parsed.attention
        .map((it) => {
          const r = it as Record<string, unknown>;
          const sev = r.severity === 'high' || r.severity === 'medium' || r.severity === 'low' ? r.severity : 'medium';
          return { text: clampLine(r.text, 80), why: clampLine(r.why, 40), severity: sev as BriefAttentionItem['severity'] };
        })
        .filter((a) => a.text.length > 0)
        .slice(0, 6)
    : [];

  // Deterministic fallback headline/yesterday if LLM gave nothing.
  const fbHeadline =
    signals.goals_at_risk > 0
      ? `${signals.goals_at_risk} 个目标有风险,${signals.blocked_projects.length} 个项目卡住`
      : signals.blocked_projects.length > 0
        ? `${signals.blocked_projects.length} 个项目卡住待处理`
        : signals.open_anomalies > 0
          ? `${signals.open_anomalies} 个异常待看`
          : '团队运转正常';
  const fbYesterday = `昨天 ${signals.active_people} 人活跃,${signals.commits_yesterday} 个 commit 进 ${signals.top_projects.length} 个项目${
    signals.top_projects[0] ? `(最活跃:${signals.top_projects[0].name})` : ''
  }。`;

  const brief: DailyBrief = {
    date: ymdToday,
    headline: clampLine(parsed.headline, 40) || fbHeadline,
    yesterday: clampLine(parsed.yesterday, 200) || fbYesterday,
    attention: attention.length
      ? attention
      : [
          ...signals.blocked_projects.map((p) => ({ text: `项目「${p}」卡住`, why: '需要解卡', severity: 'high' as const })),
          ...(signals.compliance_gaps > 0
            ? [{ text: `${signals.compliance_gaps} 人 GitHub 合规未配齐`, why: 'hygiene', severity: 'low' as const }]
            : [])
        ],
    suggestion:
      clampLine(parsed.suggestion, 80) ||
      (signals.blocked_projects[0] ? `先解「${signals.blocked_projects[0]}」的卡点` : '今天无明显优先项,关注新动向'),
    signals,
    generated_at: new Date().toISOString()
  };

  byDate[today] = brief;
  // keep last 30 days
  const keep = Object.keys(byDate).sort().slice(-30);
  const pruned: Record<string, DailyBrief> = {};
  for (const k of keep) pruned[k] = byDate[k];
  await writeSyncState(STATE_KEY, { byDate: pruned });
  return brief;
}

// Cheap read for the /status page — returns today's brief if already built,
// else builds it. (force=false so the page never re-runs the LLM once cached.)
export async function getTodayBrief(): Promise<DailyBrief> {
  return buildDailyBrief();
}

// Deliver the morning brief to the leader once per working day. Self-gated:
//   - skip weekends/holidays (workdays.ts)
//   - skip before BRIEF_MIN_HOUR Beijing time
//   - skip if already delivered today (DELIVER_KEY marker, Beijing date)
//   - skip if the bot is paused
// Safe to call every monitor tick — it no-ops until all gates pass, then DMs
// once. Returns the outcome for logging.
export async function deliverDailyBriefIfDue(
  opts: { force?: boolean } = {}
): Promise<{ delivered: boolean; reason?: string }> {
  const today = beijingDate();

  // Inner gate ladder — UNCHANGED semantics (>=8am, working-day, once-per-day
  // via DELIVER_KEY, not-paused, slack/leader present). The success path still
  // writes DELIVER_KEY (the idempotency gate) EXACTLY as before. The outer fn
  // only adds an attempt record on every return path — pure observability.
  const _compute = async (): Promise<{ delivered: boolean; reason?: string }> => {
    if (!opts.force) {
      const nowHour = Number(new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai', hour: '2-digit', hour12: false }));
      if (Number.isFinite(nowHour) && nowHour < BRIEF_MIN_HOUR) return { delivered: false, reason: 'too-early' };
      if (!(await isWorkingDay(new Date()))) return { delivered: false, reason: 'non-working-day' };
      const dstate = ((await readSyncState<{ lastDate?: string }>(DELIVER_KEY)) ?? {}) as { lastDate?: string };
      if (dstate.lastDate === today) return { delivered: false, reason: 'already-delivered' };
    }
    if (await isBotPaused()) return { delivered: false, reason: 'paused' };

    const token = await getToken();
    if (!token) return { delivered: false, reason: 'no-slack-token' };
    const leader = await lookupByName(LEADER_NAME);
    if (!leader?.slack.user_id) return { delivered: false, reason: 'no-leader-slack-id' };

    const brief = await buildDailyBrief();
    const channel = await openConversation(token, leader.slack.user_id);
    if (!channel) return { delivered: false, reason: 'open-conversation-failed' };
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ channel, text: formatBriefForSlack(brief) })
    });
    const j = (await res.json()) as { ok?: boolean; error?: string };
    if (!j.ok) return { delivered: false, reason: j.error ?? 'postMessage-failed' };
    await writeSyncState(DELIVER_KEY, { lastDate: today });
    return { delivered: true };
  };

  let r: { delivered: boolean; reason?: string };
  try {
    r = await _compute();
  } catch (err) {
    // A throw inside the gate ladder / send is itself an attempt outcome — record
    // it (so 'why no brief today' is answerable) then re-throw to preserve the
    // caller's existing try/catch contract in rosterTick.
    const now = new Date();
    await writeSyncState(DELIVER_ATTEMPT_KEY, {
      at: now.toISOString(),
      at_beijing: beijingDateTime(now),
      date: today,
      delivered: false,
      reason: `error:${(err as Error).message}`
    } satisfies DeliverAttempt).catch(() => {});
    throw err;
  }

  // Best-effort attempt persistence — its own catch so a disk hiccup writing the
  // diagnostic record can NEVER wedge or throw out of the delivery path.
  const now = new Date();
  await writeSyncState(DELIVER_ATTEMPT_KEY, {
    at: now.toISOString(),
    at_beijing: beijingDateTime(now),
    date: today,
    delivered: r.delivered,
    reason: r.reason
  } satisfies DeliverAttempt).catch(() => {});
  return r;
}

// Tiny read for observability surfaces (e.g. /api/roster/health). Reads the
// attempt record, the once-per-day gate marker, and the rosterTick heartbeat,
// then derives a one-glance `stale` flag using the REAL gate predicate
// (isBriefDueWindow) so it never false-alarms on weekends / before 8am.
export interface BriefDeliveryHealth {
  last_attempt: DeliverAttempt | null;
  last_delivered_date: string | null;
  today_beijing: string;
  delivered_today: boolean;
  stale: boolean; // working-day AND now>=8am Beijing AND not delivered today
  roster_tick_heartbeat: { at: string; at_beijing: string; reached: string } | null;
}
export async function getBriefDeliveryHealth(): Promise<BriefDeliveryHealth> {
  const now = new Date();
  const today = beijingDate(now);
  const [attempt, deliver, heartbeat, due] = await Promise.all([
    readSyncState<DeliverAttempt>(DELIVER_ATTEMPT_KEY).catch(() => null),
    readSyncState<{ lastDate?: string }>(DELIVER_KEY).catch(() => null),
    readSyncState<{ at: string; at_beijing: string; reached: string }>('monitor_roster_heartbeat').catch(
      () => null
    ),
    isBriefDueWindow(now).catch(() => false)
  ]);
  const last_delivered_date = deliver?.lastDate ?? null;
  const delivered_today = last_delivered_date === today;
  return {
    last_attempt: attempt ?? null,
    last_delivered_date,
    today_beijing: today,
    delivered_today,
    stale: due && !delivered_today,
    roster_tick_heartbeat: heartbeat ?? null
  };
}

// Format the brief as a terse Slack DM for the leader.
export function formatBriefForSlack(b: DailyBrief): string {
  const sevEmoji: Record<BriefAttentionItem['severity'], string> = { high: '🔴', medium: '🟠', low: '⚪' };
  const lines: string[] = [];
  lines.push(`📋 ${b.date} 团队简报`);
  lines.push(b.headline);
  lines.push('');
  lines.push(b.yesterday);
  if (b.attention.length) {
    lines.push('');
    lines.push('今天该看:');
    for (const a of b.attention) lines.push(`${sevEmoji[a.severity]} ${a.text} · ${a.why}`);
  }
  if (b.suggestion) {
    lines.push('');
    lines.push(`👉 ${b.suggestion}`);
  }
  lines.push('→ /status');
  return lines.join('\n');
}
