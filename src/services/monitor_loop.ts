// Server-side monitor loop. Owns two things:
//   1. Keeping every active/idle agent's `work_summary` cache warm — so the
//      `/status` roster always shows what each person is *currently* working on
//      without waiting on a page click to trigger an LLM call.
//   2. Watching live-derived concerns (quota near / pace projected to exceed /
//      context near full) and pushing the act-now ones to the leader via the
//      existing Slack push pipeline. Same idempotency guard as the engine
//      anomaly pushes so we don't spam.
//
// The loop is module-init: import this file anywhere in the server runtime
// (e.g. instrumentation.ts) and a single interval starts on server boot. A
// global flag guards against dev hot-reload stacking multiple intervals.

import { getAllStatus } from './cc_status';
import { refreshActiveWorkSummaries } from './work_summary';
import { getLiveStatusAll } from './live_cc';
import { notifyActNowIfNew } from './leader_push';
import { buildSuppressionMap, isSuppressed } from '../lib/leader_actions';
import type { Anomaly, AnomalySeverityHint } from '../types/events';
import {
  PACE_RISK,
  PACE_MIN_PROGRESS,
  PACE_MIN_REMAINING,
  PACE_MIN_UTIL
} from '../lib/cc_thresholds';

const POLL_MS = Number(process.env.MONITOR_POLL_MS ?? 5 * 60_000); // 5 min default
const WINDOW_MS_7D = 7 * 24 * 60 * 60 * 1000;

declare global {
  // Hot-reload guard. Cleared on full server restart.
  // eslint-disable-next-line no-var
  var __ccMonitorStarted: boolean | undefined;
  // eslint-disable-next-line no-var
  var __ccMonitorInterval: NodeJS.Timeout | undefined;
}

function quotaPace(
  util: number | undefined,
  resetAtSec: number | undefined,
  windowMs: number,
  nowMs: number
): { progress: number; projection: number } | null {
  if (typeof util !== 'number' || typeof resetAtSec !== 'number') return null;
  const elapsedMs = windowMs - (resetAtSec * 1000 - nowMs);
  const progress = Math.max(0, Math.min(1, elapsedMs / windowMs));
  if (progress <= 0) return { progress: 0, projection: util };
  return { progress, projection: util / progress };
}

// Same shape as live concerns in cc_status.ts but produced here so the loop can
// push them without depending on a request-scoped `getRosterView` call.
async function computeLiveConcerns(): Promise<Anomaly[]> {
  const live = await getLiveStatusAll();
  if (live.size === 0) return [];
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const out: Anomaly[] = [];
  const mk = (
    name: string,
    rule: string,
    severity: AnomalySeverityHint
  ): Anomaly => ({
    id: `live:${rule}:${name}`,
    rule,
    subject: { kind: 'agent', ref: name },
    status: 'open',
    severity_hint: severity,
    triggered_at: nowIso,
    last_seen_at: nowIso,
    evidence_event_seqs: [],
    suggested_actions: [{ id: 'ask', label: `问问 ${name} 在干嘛`, tool: 'team:ask', args: { name } }]
  });
  // Same as cc_status.ts :: liveConcerns — only the 7d pace projection rule
  // is wired. No act-now anywhere.
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
    out.push(mk(name, 'quota.pace_7d', 'next-glance'));
  }
  return out;
}

async function tick(): Promise<void> {
  // 1. Keep work summaries fresh for everyone in an active/idle window. Real
  //    work happens in `refreshActiveWorkSummaries` (cache-marker check → LLM
  //    call only when data changed).
  try {
    const all = await getAllStatus({ onlyWithActivity: true });
    const names = all
      .filter((s) => s.activityFlag === 'active' || s.activityFlag === 'idle')
      .map((s) => s.name);
    if (names.length > 0) await refreshActiveWorkSummaries(names);
  } catch (err) {
    console.warn('[monitor] summary refresh failed:', (err as Error).message);
  }
  // 2. Push act-now live concerns. `notifyActNowIfNew` is idempotent (keyed by
  //    the synthetic anomaly id), so the same quota.near_5h crit fires once,
  //    not every 5 minutes.
  try {
    const [concerns, suppression] = await Promise.all([computeLiveConcerns(), buildSuppressionMap()]);
    const nowIso = new Date().toISOString();
    for (const a of concerns) {
      if (a.severity_hint !== 'act-now') continue;
      if (isSuppressed(suppression.get(a.id), nowIso)) continue;
      await notifyActNowIfNew(a);
    }
  } catch (err) {
    console.warn('[monitor] live concerns push failed:', (err as Error).message);
  }
}

export function startMonitorLoop(): void {
  if (globalThis.__ccMonitorStarted) return;
  globalThis.__ccMonitorStarted = true;
  // Fire one immediately so the cache populates on first request.
  void tick();
  globalThis.__ccMonitorInterval = setInterval(() => void tick(), POLL_MS);
  console.log(`[monitor] loop started; interval=${Math.round(POLL_MS / 1000)}s`);
}
