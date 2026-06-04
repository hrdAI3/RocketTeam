// GET /api/roster/health — leader-confirmed "roster health" detections.
// NEVER mutates member status. Surfaces two signals for the leader to confirm:
//   - departureSuspects: members still status:'active' that LOOK like they left
//     (Slack deactivated, or CC-silent for >30 days). A slack glitch / vacation
//     must NOT auto-retire anyone — this is detect-only; the leader confirms via
//     POST /api/roster/[name]/mark-left.
//   - unmappedCcActors: CC events in the last 7d whose `actor` string doesn't
//     resolve to any roster identity, so the leader can map them instead of
//     letting them show as unknown:* forever.

import { NextResponse } from 'next/server';
import { readRoster, buildActorIndex } from '@/lib/team_roster';
import { streamEvents } from '@/lib/events';
import { memoTTL } from '@/lib/ttl_cache';
import { getBriefDeliveryHealth } from '@/services/daily_brief';

export const dynamic = 'force-dynamic';

type DepartureReason = 'slack-deactivated' | 'cc-silent-30d';

interface DepartureSuspect {
  name: string;
  reason: DepartureReason;
  detail: string;
}

interface UnmappedCcActor {
  actor: string;
  event_count: number;
  last_seen: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export async function GET(): Promise<Response> {
  try {
    const data = await memoTTL('roster-health', 90_000, async () => {
    const now = Date.now();
    const roster = await readRoster();

    // --- Feature #1: departure suspects (active members that look gone) ---
    const departureSuspects: DepartureSuspect[] = [];
    for (const m of roster.members) {
      if (m.status !== 'active') continue;

      // Slack deactivated — strongest signal. But ONLY when the member was
      // previously mapped to a real Slack user_id. `ok===false` with
      // user_id===null means we never resolved a Slack account for them
      // (new joiner not yet invited, or a display-name mismatch) — that's a
      // "needs Slack mapping" gap, NOT a departure. 徐云昊 (joined 2026-05-29,
      // user_id=null) was wrongly flagged "Slack 账号已停用 / possible
      // departure" by the old unconditional check.
      if (m.slack.ok === false && m.slack.user_id) {
        departureSuspects.push({
          name: m.name,
          reason: 'slack-deactivated',
          detail: 'Slack 账号已停用'
        });
        continue;
      }

      // CC silent for >30 days (or never seen but joined >30d ago).
      const lastSeen = m.cc.last_seen_at;
      let ccSilent = false;
      let detail = '';
      if (lastSeen) {
        const age = now - Date.parse(lastSeen);
        if (Number.isFinite(age) && age > 30 * DAY_MS) {
          ccSilent = true;
          detail = `CC 已静默 ${Math.round(age / DAY_MS)} 天`;
        }
      } else if (m.joined_at) {
        const since = now - Date.parse(m.joined_at);
        if (Number.isFinite(since) && since > 30 * DAY_MS) {
          ccSilent = true;
          detail = 'CC 从未有活动（入职已超 30 天）';
        }
      }
      if (ccSilent) {
        departureSuspects.push({ name: m.name, reason: 'cc-silent-30d', detail });
      }
    }

    // --- Feature #4: unmapped CC actors in the last 7 days ---
    // Stream the 7d cc_session window; full-file scan via readAllEvents() was
    // OOM-risky on the 500MB events.jsonl.
    const actorIndex = await buildActorIndex();
    const cutoffTs = new Date(now - 7 * DAY_MS).toISOString();
    const agg = new Map<string, { count: number; last: string }>();
    await streamEvents({ source: 'cc_session', since: cutoffTs }, (e) => {
      if (typeof e.actor !== 'string' || e.actor.length === 0) return;
      if (actorIndex.get(e.actor.toLowerCase()) !== undefined) return; // known
      const cur = agg.get(e.actor);
      if (cur) {
        cur.count += 1;
        if (e.ts > cur.last) cur.last = e.ts;
      } else {
        agg.set(e.actor, { count: 1, last: e.ts });
      }
    });
    const unmappedCcActors: UnmappedCcActor[] = Array.from(agg.entries())
      .map(([actor, v]) => ({ actor, event_count: v.count, last_seen: v.last }))
      .sort((a, b) => b.event_count - a.event_count)
      .slice(0, 10);

    // Daily-brief delivery health — cheap reads of the attempt/gate/heartbeat
    // sync_state markers. `deliveryHealth.stale===true` is the one-glance "brief
    // is wedged" flag (working-day AND >=8am Beijing AND not delivered today),
    // computed against the SAME gate predicate the delivery path uses so it
    // never false-alarms on weekends / before 8am. Best-effort: degrade to null
    // rather than 500 the whole health surface.
    const deliveryHealth = await getBriefDeliveryHealth().catch(() => null);

    return { departureSuspects, unmappedCcActors, deliveryHealth };
    });
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message, departureSuspects: [], unmappedCcActors: [] },
      { status: 500 }
    );
  }
}
