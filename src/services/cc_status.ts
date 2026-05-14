// CC work-status rollup.
// Reads events.jsonl, projects per-agent CC activity for the leader.
// Output is plain markdown — no LLM call needed for the rollup itself.
//
// `getAllStatus()`     → status row for every agent that has any CC event
// `getOneStatus(name)` → deeper view: recent sessions, branches, stuck signals

import { readAllEvents } from '../lib/events';
import { promises as fs } from 'node:fs';
import { PATHS } from '../lib/paths';
import { llmCall, stripThinkBlocks } from '../lib/llm';
import { listOpenAnomalies } from '../anomaly/store';
import { getLiveStatusAll, getLiveStatusForName } from './live_cc';
import type { CcLiveSnapshot, CcLiveForAgent } from './live_cc';
import { readCachedSummaries } from './work_summary';
import type { WorkItem } from './work_summary';
import { buildSuppressionMap, isSuppressed } from '../lib/leader_actions';
import {
  PACE_RISK,
  PACE_MIN_PROGRESS,
  PACE_MIN_REMAINING,
  PACE_MIN_UTIL
} from '../lib/cc_thresholds';
import type { Event } from '../types/events';
import type { Anomaly, AnomalySeverityHint } from '../types/events';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

export type ActivityFlag = 'active' | 'idle' | 'dormant' | 'never';

export interface AgentCcStatus {
  name: string;
  resolved: boolean;
  lastSessionAt: string | null;
  activityFlag: ActivityFlag;
  topicHint: string | null;
  cwdHint: string | null;
  gitBranchHint: string | null;
  modelHint: string | null;
  toolsLast24h: Array<{ tool: string; count: number }>;
  tokensWeek: {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreate: number;
  };
  sessionCountWeek: number;
  stuckSignalsLast24h: number;
}

// Per-session aggregate. Used to pick the "current substantive session" so a
// trailing 78-second housekeeping session can't redefine 当前分支 / 工作目录.
interface SessionAgg {
  sessionId: string;
  start: number | null;
  end: number | null;
  lastEventTs: number;
  toolSum: number;
  stuckCount: number;
  toolCounts: Map<string, number>;
  cwd?: string;
  gitBranch?: string;
  model?: string;
  lastQuoteTs: number;
  lastQuote?: string;
}

interface PerAgentBucket {
  sessionStartTs: number[];
  toolCounts: Map<string, number>; // last 24h, for the 24h-tools chips
  tokens: { input: number; output: number; cacheRead: number; cacheCreate: number };
  stuck24h: Event[];
  latestActivityTs: number; // freshest ts of any cc event — drives active/idle/dormant
  sessions: Map<string, SessionAgg>;
}

function emptyBucket(): PerAgentBucket {
  return {
    sessionStartTs: [],
    toolCounts: new Map(),
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
    stuck24h: [],
    latestActivityTs: 0,
    sessions: new Map()
  };
}

function tsMs(iso: string): number {
  return new Date(iso).getTime();
}

const SUBSTANTIVE_MS = 10 * 60_000; // ≥ 10 min
const SUBSTANTIVE_TOOLS = 10; // OR ≥ 10 tool calls

function isSubstantiveSession(s: SessionAgg): boolean {
  const ms = s.start !== null && s.end !== null ? s.end - s.start : 0;
  return ms >= SUBSTANTIVE_MS || s.toolSum >= SUBSTANTIVE_TOOLS || s.stuckCount > 0;
}

// The session that defines "what they're on" — most recent substantive one,
// falling back to the most recent session if nothing substantive exists.
function pickCurrentSession(b: PerAgentBucket): SessionAgg | null {
  const all = [...b.sessions.values()].sort(
    (a, c) => (c.end ?? c.lastEventTs) - (a.end ?? a.lastEventTs)
  );
  return all.find(isSubstantiveSession) ?? all[0] ?? null;
}

function buildBuckets(events: Event[], now: number): Map<string, PerAgentBucket> {
  const out = new Map<string, PerAgentBucket>();
  const weekCutoff = now - WEEK_MS;
  const dayCutoff = now - DAY_MS;
  for (const e of events) {
    if (e.subject.kind !== 'agent') continue;
    if (e.source !== 'cc_session') continue;
    const t = tsMs(e.ts);
    if (t < weekCutoff) continue;
    const name = e.subject.ref;
    let b = out.get(name);
    if (!b) {
      b = emptyBucket();
      out.set(name, b);
    }
    if (t > b.latestActivityTs) b.latestActivityTs = t;

    const f = e.evidence.fields ?? {};
    const sid = typeof f.sessionId === 'string' ? (f.sessionId as string) : null;
    let s: SessionAgg | null = null;
    if (sid) {
      s = b.sessions.get(sid) ?? null;
      if (!s) {
        s = {
          sessionId: sid,
          start: null,
          end: null,
          lastEventTs: t,
          toolSum: 0,
          stuckCount: 0,
          toolCounts: new Map(),
          lastQuoteTs: 0
        };
        b.sessions.set(sid, s);
      }
      if (t > s.lastEventTs) s.lastEventTs = t;
      // Context fields only appear on session_started; backfill if absent.
      if (typeof f.cwd === 'string' && !s.cwd) s.cwd = f.cwd as string;
      if (typeof f.gitBranch === 'string' && !s.gitBranch) s.gitBranch = f.gitBranch as string;
      if (typeof f.model === 'string' && !s.model) s.model = f.model as string;
      if (e.evidence.quote && t >= s.lastQuoteTs) {
        s.lastQuoteTs = t;
        s.lastQuote = e.evidence.quote;
      }
    }

    switch (e.type) {
      case 'cc.session_started':
        b.sessionStartTs.push(t);
        if (s) s.start = t;
        break;
      case 'cc.session_ended':
        if (s) s.end = t;
        break;
      case 'cc.tool_called': {
        const tool = (f.tool as string) ?? 'unknown';
        if (s) {
          s.toolSum++;
          s.toolCounts.set(tool, (s.toolCounts.get(tool) ?? 0) + 1);
        }
        if (t >= dayCutoff) b.toolCounts.set(tool, (b.toolCounts.get(tool) ?? 0) + 1);
        break;
      }
      case 'cc.token_usage': {
        b.tokens.input += (f.input_tokens as number) ?? 0;
        b.tokens.output += (f.output_tokens as number) ?? 0;
        b.tokens.cacheRead += (f.cache_read_input_tokens as number) ?? 0;
        b.tokens.cacheCreate += (f.cache_creation_input_tokens as number) ?? 0;
        break;
      }
      case 'cc.stuck_signal': {
        if (s) s.stuckCount++;
        if (t >= dayCutoff) b.stuck24h.push(e);
        break;
      }
      default:
        break;
    }
  }
  return out;
}

function flagFor(lastTs: number | null, now: number): ActivityFlag {
  if (lastTs === null) return 'never';
  const ageHours = (now - lastTs) / HOUR_MS;
  if (ageHours <= 2) return 'active';
  if (ageHours <= 24) return 'idle';
  return 'dormant';
}

function topTools(map: Map<string, number>, k: number): Array<{ tool: string; count: number }> {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
    .map(([tool, count]) => ({ tool, count }));
}

async function listAllAgentNames(): Promise<string[]> {
  try {
    const files = await fs.readdir(PATHS.agents);
    return files.filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
  } catch {
    return [];
  }
}

export async function getAllStatus(opts?: { onlyWithActivity?: boolean }): Promise<AgentCcStatus[]> {
  const now = Date.now();
  const [events, allNames] = await Promise.all([readAllEvents(), listAllAgentNames()]);
  const buckets = buildBuckets(events, now);
  const names = new Set<string>([...buckets.keys(), ...(opts?.onlyWithActivity ? [] : allNames)]);
  const out: AgentCcStatus[] = [];
  for (const name of names) {
    const b = buckets.get(name) ?? emptyBucket();
    const lastTs = b.latestActivityTs > 0 ? b.latestActivityTs : null;
    const cur = pickCurrentSession(b);
    out.push({
      name,
      resolved: !name.startsWith('unknown:'),
      lastSessionAt: lastTs ? new Date(lastTs).toISOString() : null,
      activityFlag: flagFor(lastTs, now),
      topicHint: cur?.lastQuote ?? null,
      cwdHint: cur?.cwd ?? null,
      gitBranchHint: cur?.gitBranch ?? null,
      modelHint: cur?.model ?? null,
      toolsLast24h: topTools(b.toolCounts, 3),
      tokensWeek: b.tokens,
      sessionCountWeek: b.sessionStartTs.length,
      stuckSignalsLast24h: b.stuck24h.length
    });
  }
  // Sort: active first, then idle, then dormant; within group most-recent first.
  const rank = { active: 0, idle: 1, dormant: 2, never: 3 } as const;
  out.sort((a, b) => {
    const r = rank[a.activityFlag] - rank[b.activityFlag];
    if (r !== 0) return r;
    const ta = a.lastSessionAt ? Date.parse(a.lastSessionAt) : 0;
    const tb = b.lastSessionAt ? Date.parse(b.lastSessionAt) : 0;
    return tb - ta;
  });
  return out;
}

// ============== Lean roster — the attention-scarce leader view ==============
//
// One line per agent. Deliberately minimal: an anomaly flag (the only thing the
// leader is supposed to act on), when they were last active, and what repo they
// are in. Everything else (tokens, tools, session counts, stuck quotes) lives in
// the per-agent detail view — drill-down, not roster.

export interface RosterRow {
  name: string;
  resolved: boolean;
  // Anomalies whose subject is this agent. Empty = nothing to look at.
  anomalies: Array<{ id: string; rule: string; severity: 'act-now' | 'next-glance' | 'fyi' }>;
  lastSessionAt: string | null;
  activityFlag: ActivityFlag;
  currentRepo: string | null; // gitBranch preferred, else cwd basename
  // One-line "在做什么" for active/idle agents, from the cached work-summary
  // headline (no LLM call on the roster path). Undefined for dormant/no-data
  // agents and for anyone with no cached summary yet.
  workHint?: string;
  // Per-thread "what they're working on in parallel" — small list of ongoing
  // items (title + status) lifted from the cached work summary. The /status
  // roster shows these as a vertical list under the name to reflect that one
  // person often has several streams in flight at once.
  workItems?: Array<{ title: string; status: '进行中' | '卡住' | '调研中' | '已完成'; repo: string }>;
  // Live overlay — present only when the collector's near-real-time
  // /api/cc-status/all is wired and this person is running CC right now. The
  // /status roster surfaces just a couple of "hot" signals from it (context
  // near full, quota near limit); the full object is here for the detail page.
  live?: CcLiveSnapshot;
}

export interface TeamAggregate {
  // Activity counts.
  active: number;
  idle: number;
  dormant: number;
  noData: number;
  // Anomalies.
  openAnomalies: number;
  actNow: number;
  // When was the most recent CC activity anywhere.
  lastActivityAt: string | null;
}

const WINDOW_MS_7D = 7 * 24 * 60 * 60 * 1000;

// Compute (progress, projection) for a quota window. Returns null when we lack
// the inputs to compute meaningfully.
function quotaPace(
  util: number | undefined,
  resetAtSec: number | undefined,
  windowMs: number,
  nowMs: number
): { progress: number; projection: number } | null {
  if (typeof util !== 'number' || typeof resetAtSec !== 'number') return null;
  const windowEnd = resetAtSec * 1000;
  const elapsedMs = windowMs - (windowEnd - nowMs);
  const progress = Math.max(0, Math.min(1, elapsedMs / windowMs));
  if (progress <= 0) return { progress: 0, projection: util }; // window just rolled — projection ≈ util
  return { progress, projection: util / progress };
}

function pathParts(p: string): string[] {
  return p.replace(/[\\/]+$/, '').split(/[\\/]/).filter((s) => s.length > 0);
}

// Extract the repo name from a Claude Code cwd. Worktrees live under
// `<repo>/.claude/worktrees/<wt>` or `<repo>/.codex/worktrees/<wt>`; main
// checkout is just `<repo>`. Returns the repo dir name, or the last path
// segment as a fallback.
function repoFromCwd(cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  const parts = pathParts(cwd);
  if (parts.length === 0) return null;
  const markerIdx = parts.findIndex((s) => s === '.claude' || s === '.codex' || s === 'worktrees');
  if (markerIdx > 0) return parts[markerIdx - 1];
  return parts[parts.length - 1] ?? null;
}

// Branch names like "worktree-jiggly-launching-hinton" carry a redundant
// "worktree-" prefix; "HEAD" means detached — neither is useful to a leader.
export function tidyBranch(branch: string | null | undefined): string | null {
  if (!branch) return null;
  if (branch === 'HEAD') return null;
  return branch.replace(/^worktree-/, '');
}


// ---- live overlay helpers --------------------------------------------------
// Thresholds live in src/lib/cc_thresholds.ts so the roster chips, the
// aggregate strip, and these anomalies all agree.

function pct(n: number | undefined): number | null {
  return typeof n === 'number' ? Math.round(n * 100) : null;
}

// Recompute the activity flag from a live snapshot's staleness — a person can
// be "dormant" by the events feed (last ingested session > 24h old) but in fact
// running CC right now.
function liveFlag(stale: number | undefined): ActivityFlag | null {
  if (typeof stale !== 'number') return null;
  const h = stale / 3600;
  if (h <= 2) return 'active';
  if (h <= 24) return 'idle';
  return 'dormant';
}

// Live-derived concerns the leader should see — same shape as engine anomalies
// so the roster / CLI render them uniformly. Computed per request (the source
// is "current state", not the event log), with synthetic ids.
function liveConcerns(live: Map<string, CcLiveForAgent>, nowIso: string): Anomaly[] {
  const out: Anomaly[] = [];
  const mk = (
    name: string,
    rule: string,
    severity: AnomalySeverityHint,
    actions: Array<{ id: string; label: string; tool: string; args?: Record<string, unknown> }>
  ): Anomaly => ({
    id: `live:${rule}:${name}`,
    rule,
    subject: { kind: 'agent', ref: name },
    status: 'open',
    severity_hint: severity,
    triggered_at: nowIso,
    last_seen_at: nowIso,
    evidence_event_seqs: [],
    suggested_actions: actions
  });
  const nowMs = Date.parse(nowIso);
  // ONLY one rule live right now: 7d quota pace projection. If, at the team
  // member's current average burn rate, they'll exceed their 7d limit before
  // the window resets, raise a 提醒 (next-glance). No 警告 (act-now) source
  // wired — the leader doesn't want it yet.
  for (const [name, lf] of live) {
    const c = lf.current;
    const util = c.seven_day_utilization;
    if (typeof util !== 'number') continue;
    const pace = quotaPace(util, c.seven_day_reset_at, WINDOW_MS_7D, nowMs);
    if (!pace) continue;
    const remaining = 1 - pace.progress;
    const onPace =
      pace.progress >= PACE_MIN_PROGRESS &&
      remaining >= PACE_MIN_REMAINING &&
      util >= PACE_MIN_UTIL &&
      pace.projection >= PACE_RISK;
    if (!onPace) continue;
    out.push(mk(name, 'quota.pace_7d', 'next-glance', [{ id: 'ask', label: `问问 ${name} 在干嘛`, tool: 'team:ask', args: { name } }]));
  }
  return out;
}

export async function getRosterView(): Promise<{ roster: RosterRow[]; aggregate: TeamAggregate; anomalies: Anomaly[] }> {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const [all, engineAnomalies, live, summaries, suppression] = await Promise.all([
    getAllStatus(),
    listOpenAnomalies(),
    getLiveStatusAll(),
    readCachedSummaries(),
    buildSuppressionMap()
  ]);
  // Engine (event-derived) anomalies + live-derived concerns. De-dupe by id;
  // then drop anything the leader already resolved/dismissed/snoozed.
  const seen = new Set(engineAnomalies.map((a) => a.id));
  const merged: Anomaly[] = [...engineAnomalies];
  for (const c of liveConcerns(live, nowIso)) {
    if (!seen.has(c.id)) {
      merged.push(c);
      seen.add(c.id);
    }
  }
  const anomalies = merged.filter((a) => !isSuppressed(suppression.get(a.id), nowIso));
  // Index anomalies by agent ref.
  const byAgent = new Map<string, Anomaly[]>();
  for (const a of anomalies) {
    if (a.subject.kind === 'agent') {
      const list = byAgent.get(a.subject.ref) ?? [];
      list.push(a);
      byAgent.set(a.subject.ref, list);
    }
  }
  const roster: RosterRow[] = all.map((s) => {
    const lf = live.get(s.name);
    const lc = lf?.current;
    // Live wins for "where they are" and for the activity flag, since it's
    // strictly fresher than the last ingested session.
    const lf2 = liveFlag(lc?.stale_seconds);
    const liveLastTs = lc?.stale_seconds != null ? now - lc.stale_seconds * 1000 : null;
    const eventsLastTs = s.lastSessionAt ? Date.parse(s.lastSessionAt) : null;
    const effLastTs =
      liveLastTs != null && (eventsLastTs == null || liveLastTs > eventsLastTs) ? liveLastTs : eventsLastTs;
    return {
      name: s.name,
      resolved: s.resolved,
      anomalies: (byAgent.get(s.name) ?? []).map((a) => ({
        id: a.id,
        rule: a.rule,
        severity: a.severity_hint
      })),
      lastSessionAt: effLastTs != null ? new Date(effLastTs).toISOString() : s.lastSessionAt,
      activityFlag: lf2 ?? s.activityFlag,
      // Roster shows the repo name only ("teamagent"), not the branch — the
      // branch on the literal last cwd can be a 1-minute housekeeping session
      // that misrepresents what they were actually working on. Branch lives on
      // the detail page, derived from the most recent substantive session.
      currentRepo: repoFromCwd(lc?.cwd ?? s.cwdHint),
      // Headline + parallel work threads for active/idle agents only — for
      // dormant/no-data the repo name (or nothing) is the right amount of
      // detail on the glance.
      ...(() => {
        const eff = lf2 ?? s.activityFlag;
        if (eff !== 'active' && eff !== 'idle') return {};
        const summ = summaries.get(s.name);
        if (!summ) return {};
        // Ongoing only (skip 已完成) — leader's glance is "what's in flight".
        // Cap at 3 so a busy person doesn't stretch the row indefinitely.
        const ongoing = summ.items
          .filter((it) => it.status !== '已完成')
          .slice(0, 3)
          .map((it) => ({ title: it.title, status: it.status, repo: it.repo }));
        return { workHint: summ.headline, workItems: ongoing };
      })(),
      live: lc
    };
  });
  // Sort: agents with anomalies first (act-now before next-glance), then by
  // recency. Zero-anomaly agents fall to the bottom regardless of activity.
  const sevRank = { 'act-now': 0, 'next-glance': 1, fyi: 2 } as const;
  roster.sort((a, b) => {
    const aSev = a.anomalies.length ? Math.min(...a.anomalies.map((x) => sevRank[x.severity])) : 9;
    const bSev = b.anomalies.length ? Math.min(...b.anomalies.map((x) => sevRank[x.severity])) : 9;
    if (aSev !== bSev) return aSev - bSev;
    const ta = a.lastSessionAt ? Date.parse(a.lastSessionAt) : 0;
    const tb = b.lastSessionAt ? Date.parse(b.lastSessionAt) : 0;
    return tb - ta;
  });

  // Aggregate.
  let wIn = 0;
  let wOut = 0;
  let lastActivityAt: string | null = null;
  for (const r of roster) {
    if (r.lastSessionAt && (!lastActivityAt || r.lastSessionAt > lastActivityAt)) {
      lastActivityAt = r.lastSessionAt;
    }
  }
  const counts = { active: 0, idle: 0, dormant: 0, never: 0 };
  for (const r of roster) counts[r.activityFlag]++;
  const actNow = anomalies.filter((a) => a.severity_hint === 'act-now').length;
  const aggregate: TeamAggregate = {
    active: counts.active,
    idle: counts.idle,
    dormant: counts.dormant,
    noData: counts.never,
    openAnomalies: anomalies.length,
    actNow,
    lastActivityAt
  };
  void wIn;
  void wOut;
  void now;
  return { roster, aggregate, anomalies };
}

export interface OneAgentDetail extends AgentCcStatus {
  // "<repo> / <branch>" — what the leader can map to a project. Null when no
  // CC data. (currentBranch/currentRepoName broken out for the detail rows.)
  currentRepo: string | null;
  currentRepoName: string | null;
  currentBranch: string | null;
  recentSessions: Array<{
    sessionId: string;
    startedAt: string | null;
    endedAt: string | null;
    cwd?: string;
    gitBranch?: string;
    tools: Array<{ tool: string; count: number }>;
    stuck: string[];
    stuckCount: number;
  }>;
  recentStuckQuotes: string[];
  // Live overlay — the near-real-time snapshot of this person's current CC
  // session (context %, session health, cost, quota windows, turns, tool
  // calls, files touched, …). Undefined when the collector's /api/cc-status
  // feed isn't wired / they're not running CC.
  live?: CcLiveSnapshot;
  // Every active session, freshest first (usually one).
  liveSessions?: CcLiveSnapshot[];
}

export async function getOneStatus(name: string): Promise<OneAgentDetail | null> {
  const now = Date.now();
  const [events, lf] = await Promise.all([readAllEvents(), getLiveStatusForName(name)]);
  const buckets = buildBuckets(events, now);
  const b = buckets.get(name);
  const lc = lf?.current;
  if (!b) {
    // No ingested CC traffic for this name. If they're live right now, build a
    // detail from the live snapshot alone; otherwise the all-null empty state.
    const liveLastTs = lc?.stale_seconds != null ? now - lc.stale_seconds * 1000 : null;
    return {
      name,
      resolved: !name.startsWith('unknown:'),
      lastSessionAt: liveLastTs != null ? new Date(liveLastTs).toISOString() : null,
      activityFlag: liveFlag(lc?.stale_seconds) ?? 'never',
      topicHint: null,
      cwdHint: lc?.cwd ?? null,
      gitBranchHint: (lc?.git_branch && lc.git_branch !== 'HEAD' ? lc.git_branch : null) ?? null,
      modelHint: lc?.model ?? null,
      toolsLast24h: [],
      tokensWeek: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
      sessionCountWeek: 0,
      stuckSignalsLast24h: 0,
      currentRepo: repoFromCwd(lc?.cwd) && tidyBranch(lc?.git_branch)
        ? `${repoFromCwd(lc?.cwd)} / ${tidyBranch(lc?.git_branch)}`
        : repoFromCwd(lc?.cwd) ?? tidyBranch(lc?.git_branch) ?? null,
      currentRepoName: repoFromCwd(lc?.cwd),
      currentBranch: tidyBranch(lc?.git_branch),
      recentSessions: [],
      recentStuckQuotes: [],
      live: lc,
      liveSessions: lf?.sessions
    };
  }
  // Recent sessions for the detail list — drop pure no-op sessions (opened then
  // closed, < 60s, no tools, no stuck).
  const recentSessions = [...b.sessions.values()]
    .filter((s) => {
      const ms = s.start !== null && s.end !== null ? s.end - s.start : null;
      const trivial = (ms === null || ms < 60_000) && s.toolSum === 0 && s.stuckCount === 0;
      return !trivial;
    })
    .sort((a, c) => (c.end ?? c.lastEventTs) - (a.end ?? a.lastEventTs))
    .slice(0, 5)
    .map((s) => ({
      sessionId: s.sessionId,
      startedAt: s.start ? new Date(s.start).toISOString() : null,
      endedAt: s.end ? new Date(s.end).toISOString() : null,
      cwd: s.cwd,
      // "HEAD" = detached — not a meaningful branch name; suppress it.
      gitBranch: s.gitBranch && s.gitBranch !== 'HEAD' ? s.gitBranch : undefined,
      tools: [...s.toolCounts.entries()].sort((a, c) => c[1] - a[1]).slice(0, 5).map(([tool, count]) => ({ tool, count })),
      stuck: [] as string[],
      stuckCount: s.stuckCount
    }));

  const eventsLastTs = b.latestActivityTs > 0 ? b.latestActivityTs : null;
  // "current repo / branch / cwd" reflects the most recent SUBSTANTIVE session,
  // so a trailing 78-second housekeeping blip never redefines "当前分支".
  // Live data, when present, is strictly fresher and wins.
  const cur = pickCurrentSession(b);
  const liveBranch = lc?.git_branch && lc.git_branch !== 'HEAD' ? lc.git_branch : undefined;
  const repoName = repoFromCwd(lc?.cwd ?? cur?.cwd);
  const branch = tidyBranch(liveBranch ?? cur?.gitBranch);
  const liveLastTs = lc?.stale_seconds != null ? now - lc.stale_seconds * 1000 : null;
  const lastTs =
    liveLastTs != null && (eventsLastTs == null || liveLastTs > eventsLastTs) ? liveLastTs : eventsLastTs;
  return {
    name,
    resolved: !name.startsWith('unknown:'),
    lastSessionAt: lastTs ? new Date(lastTs).toISOString() : null,
    activityFlag: liveFlag(lc?.stale_seconds) ?? flagFor(lastTs, now),
    topicHint: cur?.lastQuote ?? null,
    cwdHint: lc?.cwd ?? cur?.cwd ?? null,
    gitBranchHint: liveBranch ?? cur?.gitBranch ?? null,
    modelHint: lc?.model ?? cur?.model ?? null,
    toolsLast24h: topTools(b.toolCounts, 5),
    tokensWeek: b.tokens,
    sessionCountWeek: b.sessionStartTs.length,
    stuckSignalsLast24h: b.stuck24h.length,
    currentRepo: repoName && branch ? `${repoName} / ${branch}` : repoName ?? branch ?? null,
    currentRepoName: repoName,
    currentBranch: branch,
    recentSessions,
    recentStuckQuotes: b.stuck24h.map((e) => e.evidence.quote ?? '').filter((q) => q.length > 0),
    live: lc,
    liveSessions: lf?.sessions
  };
}

function flagIcon(f: ActivityFlag): string {
  return f === 'active' ? '🟢' : f === 'idle' ? '🟡' : f === 'dormant' ? '⚪' : '·';
}

function fmtAge(iso: string | null): string {
  if (!iso) return 'never';
  const diff = (Date.now() - Date.parse(iso)) / 60_000;
  if (diff < 1) return 'just now';
  if (diff < 60) return `${Math.round(diff)}m ago`;
  if (diff < 24 * 60) return `${Math.round(diff / 60)}h ago`;
  return `${Math.round(diff / 60 / 24)}d ago`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

// Lean roster render for the CLI (`team:status` with no arg). Mirrors the web
// /status page: anomalies first, then a one-line-per-agent roster, then a team
// aggregate footer. NO per-person tokens/tools/session-count columns — those
// live in `team:status <name>`.
const SEV_TAG: Record<'act-now' | 'next-glance' | 'fyi', string> = {
  'act-now': '🔴',
  'next-glance': '🟠',
  fyi: '⚪'
};
// Only one rule wired right now — kept as a map so adding rules later doesn't
// reshape the call site.
const RULE_LABEL_CLI: Record<string, string> = {
  'quota.pace_7d': '7d 用量节奏过快'
};
function ruleLabelCli(rule: string): string {
  return RULE_LABEL_CLI[rule] ?? rule;
}

export function renderRosterMarkdown(view: {
  roster: RosterRow[];
  aggregate: TeamAggregate;
  anomalies: Anomaly[];
}): string {
  const out: string[] = [];
  out.push('# 团队工作状态');
  out.push('');

  // 1 — Anomalies (the only thing to act on).
  if (view.anomalies.length > 0) {
    out.push('## 要看的');
    const sevRank = { 'act-now': 0, 'next-glance': 1, fyi: 2 } as const;
    const sorted = [...view.anomalies].sort((a, b) => sevRank[a.severity_hint] - sevRank[b.severity_hint]);
    for (const a of sorted) {
      const subj = a.subject.kind === 'agent' ? a.subject.ref : `${a.subject.kind}:${a.subject.ref}`;
      out.push(`${SEV_TAG[a.severity_hint]} **${subj}** · ${ruleLabelCli(a.rule)} · 触发 ${fmtAge(a.triggered_at)}`);
      for (const s of a.suggested_actions) out.push(`   - ${s.label}`);
    }
    out.push('');
  } else {
    out.push('## 今天无异常 ✓');
    if (view.aggregate.lastActivityAt) out.push(`最近活动 ${fmtAge(view.aggregate.lastActivityAt)}`);
    out.push('');
  }

  // 2 — Activity aggregate.
  const agg = view.aggregate;
  out.push(`活跃 ${agg.active} / 空闲 ${agg.idle} / 休眠 ${agg.dormant}${agg.noData ? ` / 无数据 ${agg.noData}` : ''}`);
  out.push('');

  // 3 — Roster: agents with anomalies first, then the rest with activity.
  const withAnom = view.roster.filter((r) => r.anomalies.length > 0);
  const clean = view.roster.filter((r) => r.anomalies.length === 0 && r.activityFlag !== 'never');
  const noData = view.roster.filter((r) => r.activityFlag === 'never');

  // The anomaly list above already names the agents-with-anomalies; the roster
  // section just lists the ones with activity and no anomaly (everyone else is
  // "no data"). Keeps the output from saying "要看的" twice.
  if (clean.length > 0) {
    out.push(`### 有活动、无异常 · ${clean.length}`);
    for (const r of clean) {
      out.push(`${flagIcon(r.activityFlag)} ${r.resolved ? r.name : '⚠ ' + r.name} — 最近 ${fmtAge(r.lastSessionAt)}${r.currentRepo ? ' · ' + r.currentRepo : ''}`);
    }
    out.push('');
  }
  if (withAnom.length > 0 && clean.length === 0) {
    out.push('_（其他成员无 Claude Code 数据）_');
    out.push('');
  }
  if (noData.length > 0) {
    out.push(`无 Claude Code 数据 · ${noData.length} 人: ${noData.map((r) => (r.resolved ? r.name : '⚠ ' + r.name)).join('、')}`);
    out.push('');
  }
  out.push('_🟢 活跃(≤2h) · 🟡 空闲(2-24h) · ⚪ 休眠(>24h) · 单人详情: `team:status <名字>`_');
  return out.join('\n');
}

// ============== team:ask — natural-language Q&A about one agent's CC work ==============

const ASK_SYSTEM = `你是 leader 安子岩的助手。leader 问某个团队成员的 Claude Code 最近在做什么。
你只能引用我给你的事件数据（session、工具调用、卡点信号、commit、PR、会议 action item），不许编造时长、进度、状态。
回答简洁，中文，2-5 句，必要时列要点。如果数据不足以回答，直说「数据不足」。`;

function buildAskContext(name: string, events: Event[]): string {
  const cutoff = Date.now() - 7 * DAY_MS;
  const relevant = events.filter((e) => {
    const t = tsMs(e.ts);
    if (t < cutoff) return false;
    if (e.subject.kind === 'agent' && e.subject.ref === name) return true;
    if (e.actor === name) return true;
    return false;
  });
  if (relevant.length === 0) return `（近 7 天没有任何关于 ${name} 的事件）`;
  const lines: string[] = [];
  for (const e of relevant.slice(-120)) {
    const q = (e.evidence.quote ?? '').slice(0, 100).replace(/\s+/g, ' ');
    const f = e.evidence.fields ?? {};
    const extra =
      e.type === 'cc.tool_called'
        ? ` tool=${f.tool}`
        : e.type === 'cc.session_started'
          ? ` branch=${f.gitBranch ?? ''} cwd=${f.cwd ?? ''}`
          : e.type === 'cc.token_usage'
            ? ` in=${f.input_tokens} out=${f.output_tokens}`
            : '';
    lines.push(`- ${e.ts} ${e.source}/${e.type}${extra}${q ? ' | ' + q : ''}`);
  }
  return lines.join('\n');
}

export async function askAboutAgentCC(
  name: string,
  question: string,
  opts?: { signal?: AbortSignal }
): Promise<string> {
  const events = await readAllEvents();
  const ctx = buildAskContext(name, events);
  const raw = await llmCall({
    system: ASK_SYSTEM,
    user: `成员: ${name}\n问题: ${question}\n\n# 近 7 天事件\n${ctx}\n\n请回答。`,
    temperature: 0.3,
    maxTokens: 800,
    signal: opts?.signal
  });
  return stripThinkBlocks(raw).trim();
}

export function renderOneStatusMarkdown(d: OneAgentDetail): string {
  const out: string[] = [];
  out.push(`# ${d.resolved ? d.name : '⚠ ' + d.name}  ${flagIcon(d.activityFlag)} ${d.activityFlag}`);
  out.push('');
  out.push(`- 最近 session: ${fmtAge(d.lastSessionAt)}${d.lastSessionAt ? ' (' + d.lastSessionAt + ')' : ''}`);
  if (d.cwdHint) out.push(`- 工作目录: \`${d.cwdHint}\``);
  if (d.gitBranchHint) out.push(`- 分支: \`${d.gitBranchHint}\``);
  if (d.modelHint) out.push(`- 模型: ${d.modelHint}`);
  out.push(`- 周内 session: ${d.sessionCountWeek}`);
  out.push(
    `- 周 tokens: in=${fmtTokens(d.tokensWeek.input)} out=${fmtTokens(d.tokensWeek.output)} cache_read=${fmtTokens(d.tokensWeek.cacheRead)}`
  );
  if (d.toolsLast24h.length > 0) {
    out.push(`- 24h 主用工具: ${d.toolsLast24h.map((t) => `${t.tool}×${t.count}`).join(' / ')}`);
  }
  if (d.stuckSignalsLast24h > 0) {
    out.push(`- 24h 卡点 ⚠ ${d.stuckSignalsLast24h}：`);
    for (const q of d.recentStuckQuotes.slice(0, 3)) {
      out.push(`  > ${q.replace(/\s+/g, ' ').slice(0, 120)}`);
    }
  }
  if (d.recentSessions.length > 0) {
    out.push('');
    out.push('## 近 5 个 session');
    for (const s of d.recentSessions) {
      const head = `- \`${s.sessionId.slice(0, 8)}\` ${fmtAge(s.endedAt ?? s.startedAt)}`;
      out.push(head);
      if (s.gitBranch) out.push(`  · 分支 \`${s.gitBranch}\``);
      if (s.tools.length > 0) {
        out.push(`  · 工具 ${s.tools.map((t) => `${t.tool}×${t.count}`).join(' / ')}`);
      }
      if (s.stuck.length > 0) {
        out.push(`  · ⚠ 卡点 ${s.stuck.length}`);
      }
    }
  }
  return out.join('\n');
}
