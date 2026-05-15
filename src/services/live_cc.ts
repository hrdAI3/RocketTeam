// Live CC status overlay.
//
// The collector exposes a richer, near-real-time snapshot per Claude Code
// session at GET /api/cc-status/all (see the data spec — schema_version 1).
// That endpoint is not fully wired on the collector side yet, so this module is
// written to degrade gracefully: if the call fails or returns nothing, callers
// just get an empty map and the rest of the system runs on the events-derived
// view alone.
//
// We DON'T persist these snapshots as events — they're "current state", fetched
// per request (the leader's /status page polls every 60s). The anomaly engine
// keeps working off events.jsonl; live-derived concerns (quota near, context
// near full, tools failing) are computed inline in cc_status.ts.

import { resolveOrUnknown } from '../lib/identity';

const COLLECTOR_BASE = process.env.CC_COLLECTOR_BASE ?? 'http://192.168.22.88:8848';

// One element of the /api/cc-status* response. Every field optional on our side
// — the collector may roll out fields incrementally and old snapshots won't
// have the newest ones.
export interface CcLiveSnapshot {
  schema_version?: number;
  user_id?: string;
  display_name?: string | null;
  machine_id?: string;
  session_id?: string;
  cwd?: string;
  git_branch?: string | null;
  ts?: string; // ISO-8601 UTC — snapshot time
  event?: string; // hook that produced it
  stale_seconds?: number;
  session_started_at?: string;
  model?: string;
  context_tokens?: number;
  context_pct?: number; // 0–1
  session_health?: string; // "OK" | "⚠超长"
  cost_usd?: number;
  tokens_5h?: number;
  tokens_7d?: number;
  subscription_tier?: string;
  five_hour_utilization?: number; // 0–1
  seven_day_utilization?: number; // 0–1
  five_hour_reset_at?: number; // unix seconds
  seven_day_reset_at?: number; // unix seconds
  quota_stale?: boolean;
  turn_count?: number;
  tool_calls_total?: number;
  tool_calls_failed?: number;
  files_touched?: number;
  intercepts_today?: number;
  last_activity_at?: string;
}

export interface CcLiveForAgent {
  // Canonical agent name (same key the events-derived roster uses).
  name: string;
  resolved: boolean;
  // The session that best represents "what they're on right now": freshest ts,
  // tie-broken by lowest stale_seconds.
  current: CcLiveSnapshot;
  // Every active session for this person (current first).
  sessions: CcLiveSnapshot[];
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function normalize(raw: unknown): CcLiveSnapshot | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const uid = str(r.user_id);
  if (!uid) return null;
  return {
    schema_version: num(r.schema_version),
    user_id: uid,
    display_name: typeof r.display_name === 'string' ? r.display_name : null,
    machine_id: str(r.machine_id),
    session_id: str(r.session_id),
    cwd: str(r.cwd),
    git_branch: typeof r.git_branch === 'string' ? r.git_branch : null,
    ts: str(r.ts),
    event: str(r.event),
    stale_seconds: num(r.stale_seconds),
    session_started_at: str(r.session_started_at),
    model: str(r.model),
    context_tokens: num(r.context_tokens),
    context_pct: num(r.context_pct),
    session_health: str(r.session_health),
    cost_usd: num(r.cost_usd),
    tokens_5h: num(r.tokens_5h),
    tokens_7d: num(r.tokens_7d),
    subscription_tier: str(r.subscription_tier),
    five_hour_utilization: num(r.five_hour_utilization),
    seven_day_utilization: num(r.seven_day_utilization),
    five_hour_reset_at: num(r.five_hour_reset_at),
    seven_day_reset_at: num(r.seven_day_reset_at),
    quota_stale: typeof r.quota_stale === 'boolean' ? r.quota_stale : undefined,
    turn_count: num(r.turn_count),
    tool_calls_total: num(r.tool_calls_total),
    tool_calls_failed: num(r.tool_calls_failed),
    files_touched: num(r.files_touched),
    intercepts_today: num(r.intercepts_today),
    last_activity_at: str(r.last_activity_at)
  };
}

// Freshness key for picking the "current" session.
function freshness(s: CcLiveSnapshot): number {
  const t = s.ts ? Date.parse(s.ts) : 0;
  // Subtract stale_seconds so a fresher snapshot of an older session loses to a
  // slightly-older snapshot of a session that's actively producing events.
  return (Number.isNaN(t) ? 0 : t) - (s.stale_seconds ?? 0) * 1000;
}

// Dev-only preview fixture. The collector's /api/cc-status/all endpoint isn't
// wired yet, so to actually *see* the live UI (the per-agent 实时 section, the
// roster hot-chips, the quota anomalies) set CC_LIVE_FIXTURE=1 when running the
// dev server. This is OFF by default — production / the real leader's view
// never sees this; it's a visual harness, nothing more. Timestamps are
// generated relative to "now" so it always reads as a fresh snapshot.
function devFixture(): CcLiveSnapshot[] {
  if (!process.env.CC_LIVE_FIXTURE) return [];
  const now = Date.now();
  const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
  const unixIn = (msAhead: number) => Math.floor((now + msAhead) / 1000);
  return [
    // 戴昊然: matches the user's local CC display — 5h 10% with 47m left, 7d
    // 93% with 1d4h left. With the new thresholds neither fires (5h util too
    // low, 7d window almost over — reset imminent, no need to flag).
    {
      schema_version: 1,
      user_id: 'hrdai@qq.com',
      display_name: '戴昊然',
      machine_id: 'm-d1',
      session_id: 'a1b2c3d4e5f6',
      cwd: 'D:/hrdai/team',
      git_branch: 'master',
      ts: iso(95_000),
      stale_seconds: 95,
      session_started_at: iso(2 * 3_600_000),
      model: 'claude-opus-4-7',
      tokens_5h: 1_500_000,
      tokens_7d: 86_000_000,
      subscription_tier: 'max',
      five_hour_utilization: 0.10,
      seven_day_utilization: 0.93,
      five_hour_reset_at: unixIn(47 * 60_000),
      seven_day_reset_at: unixIn(28 * 3_600_000),
      quota_stale: false,
      turn_count: 12,
      files_touched: 4
    },
    // 李博泽: the "day 2 already at 35% of 7d" case the user described — a
    // predictive flag that the reactive threshold wouldn't catch.
    {
      schema_version: 1,
      user_id: 'liboze2026@163.com',
      display_name: '李博泽',
      machine_id: 'm-l1',
      session_id: '9f8e7d6c5b4a',
      cwd: 'D:/work/TeamBrain/.claude/worktrees/worktree-quiet-sage',
      git_branch: 'worktree-quiet-sage',
      ts: iso(40_000),
      stale_seconds: 40,
      session_started_at: iso(3 * 3_600_000),
      model: 'claude-opus-4-7',
      tokens_5h: 4_000_000,
      tokens_7d: 32_000_000,
      subscription_tier: 'max',
      five_hour_utilization: 0.40,
      seven_day_utilization: 0.35,
      five_hour_reset_at: unixIn(2 * 3_600_000),
      seven_day_reset_at: unixIn(5 * 24 * 3_600_000),
      quota_stale: false,
      turn_count: 18,
      files_touched: 6
    }
  ];
}

async function fetchAllSnapshots(path: string): Promise<CcLiveSnapshot[]> {
  const fixture = devFixture();
  if (fixture.length > 0) return fixture;
  let res: Response;
  try {
    res = await fetch(`${COLLECTOR_BASE}${path}`, { signal: AbortSignal.timeout(4000) });
  } catch {
    return [];
  }
  if (!res.ok) return [];
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return [];
  }
  // /api/cc-status/all returns an array; /api/cc-status?user= returns an array
  // too; /api/cc-status?user=&session= returns a single object.
  const arr = Array.isArray(body) ? body : [body];
  return arr.map(normalize).filter((s): s is CcLiveSnapshot => s !== null);
}

// Per-user quota fallback. The rich /api/cc-status/all is still #350; the
// collector's /api/quota is LIVE today. So when the rich endpoint is empty,
// fall back to fetching real quota per user and synthesising a minimal
// snapshot — enough to populate the leader's `配额预警` card and per-agent
// quota bars with REAL numbers, not nothing (and not the dev fixture).
async function fetchQuotaForUser(email: string): Promise<CcLiveSnapshot | null> {
  const today = new Date().toISOString().slice(0, 10);
  let res: Response;
  try {
    res = await fetch(
      `${COLLECTOR_BASE}/api/quota?user=${encodeURIComponent(email)}&date=${today}`,
      { signal: AbortSignal.timeout(3000) }
    );
  } catch {
    return null;
  }
  if (!res.ok) return null;
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return null;
  }
  if (typeof body !== 'object' || body === null) return null;
  const r = body as Record<string, unknown>;
  const snap: CcLiveSnapshot = {
    user_id: email,
    tokens_5h: num(r.tokens_5h),
    tokens_7d: num(r.tokens_7d),
    subscription_tier: str(r.subscription_tier),
    five_hour_utilization: num(r.five_hour_utilization),
    seven_day_utilization: num(r.seven_day_utilization),
    five_hour_reset_at: num(r.five_hour_reset_at),
    seven_day_reset_at: num(r.seven_day_reset_at),
    quota_stale: typeof r.quota_stale === 'boolean' ? r.quota_stale : undefined,
    // We don't know the session's locus / stats — only quota came back. Leave
    // session-level fields undefined; the UI degrades to "quota only".
    ts: new Date().toISOString()
  };
  if (snap.five_hour_utilization === undefined && snap.seven_day_utilization === undefined) {
    return null;
  }
  return snap;
}

async function fetchQuotaFallback(): Promise<CcLiveSnapshot[]> {
  let res: Response;
  try {
    res = await fetch(`${COLLECTOR_BASE}/api/users`, { signal: AbortSignal.timeout(3000) });
  } catch {
    return [];
  }
  if (!res.ok) return [];
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return [];
  }
  const users = Array.isArray((body as { users?: unknown[] }).users)
    ? ((body as { users: string[] }).users.filter((u) => typeof u === 'string') as string[])
    : [];
  if (users.length === 0) return [];
  const snaps = await Promise.all(users.map((u) => fetchQuotaForUser(u)));
  return snaps.filter((s): s is CcLiveSnapshot => s !== null);
}

async function groupByAgent(snapshots: CcLiveSnapshot[]): Promise<Map<string, CcLiveForAgent>> {
  // Resolve each distinct user_id once.
  const ids = [...new Set(snapshots.map((s) => s.user_id!).filter(Boolean))];
  const resolved = new Map<string, { name: string; resolved: boolean }>();
  await Promise.all(
    ids.map(async (id) => {
      const r = await resolveOrUnknown('email', id);
      resolved.set(id, { name: r.name, resolved: !r.unresolved });
    })
  );
  const byName = new Map<string, CcLiveSnapshot[]>();
  for (const s of snapshots) {
    const r = resolved.get(s.user_id!);
    if (!r) continue;
    const list = byName.get(r.name) ?? [];
    list.push(s);
    byName.set(r.name, list);
  }
  const out = new Map<string, CcLiveForAgent>();
  for (const [name, list] of byName) {
    const sorted = [...list].sort((a, b) => freshness(b) - freshness(a));
    const r = resolved.get(sorted[0].user_id!)!;
    out.set(name, { name, resolved: r.resolved, current: sorted[0], sessions: sorted });
  }
  return out;
}

// Roster overlay: name → live status for every person the collector knows.
// Priority:
//   1. Dev fixture (CC_LIVE_FIXTURE=1) — preview UI before the collector ships.
//   2. /api/cc-status/all — the rich snapshot (#350, not yet wired).
//   3. /api/quota fallback — per-user quota only, LIVE today; what the leader
//      gets to see now.
// Empty map if none of the above produces anything.
export async function getLiveStatusAll(): Promise<Map<string, CcLiveForAgent>> {
  let snaps = await fetchAllSnapshots('/api/cc-status/all');
  if (snaps.length === 0) snaps = await fetchQuotaFallback();
  if (snaps.length === 0) return new Map();
  return groupByAgent(snaps);
}

// Per-agent live overlay. Tries the cheaper per-user endpoint first, then falls
// back to filtering the all-snapshot. Returns null when nothing is live.
export async function getLiveStatusForName(name: string): Promise<CcLiveForAgent | null> {
  // We don't have a name→user_id reverse here cheaply for the per-user call, so
  // just fetch all and pick. (24-person team, 60s poll — fine.)
  const all = await getLiveStatusAll();
  return all.get(name) ?? null;
}
