import { NextRequest } from 'next/server';
import { recordLeaderAction, type LeaderActionKind } from '@/lib/leader_actions';
import { recordResolve, recordDismiss, recordSnooze, getAnomaly } from '@/anomaly/store';

export const dynamic = 'force-dynamic';

// POST /api/anomalies/action
// Body: { id: string, rule: string, subjectRef: string, action: 'resolve' | 'dismiss' | 'snooze', minutes?: number, note?: string }
//
// Appends the leader's action to `private/leader_actions.jsonl` (product
// feedback). For engine anomalies (persisted in the store), ALSO updates the
// store's own state via the matching recordResolve / recordDismiss /
// recordSnooze. Live-derived anomalies (synthetic `live:` ids) only live in
// the action log; the roster + monitor loop check the log to suppress them.
export async function POST(req: NextRequest): Promise<Response> {
  let body: { id?: string; rule?: string; subjectRef?: string; action?: LeaderActionKind; minutes?: number; note?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return new Response(JSON.stringify({ error: 'invalid json' }), { status: 400 });
  }
  const { id, rule, subjectRef, action, minutes, note } = body;
  if (!id || !rule || !subjectRef || !action) {
    return new Response(JSON.stringify({ error: 'missing id / rule / subjectRef / action' }), { status: 400 });
  }
  if (action !== 'resolve' && action !== 'dismiss' && action !== 'snooze') {
    return new Response(JSON.stringify({ error: 'invalid action' }), { status: 400 });
  }
  const now = new Date();
  let snoozedUntil: string | undefined;
  if (action === 'snooze') {
    const mins = typeof minutes === 'number' && minutes > 0 ? minutes : 240; // default 4h
    snoozedUntil = new Date(now.getTime() + mins * 60_000).toISOString();
  }
  await recordLeaderAction({
    ts: now.toISOString(),
    anomalyId: id,
    rule,
    subjectRef,
    action,
    snoozedUntil,
    note
  });
  // Engine anomalies also get their store state updated so the engine's own
  // listOpenAnomalies filters them out. Synthetic live ids (starting `live:`)
  // are not in the store; the action log alone suppresses them.
  if (!id.startsWith('live:')) {
    const existing = await getAnomaly(id);
    if (existing) {
      if (action === 'resolve') await recordResolve(id, 'leader', 'acknowledged_by_leader');
      else if (action === 'dismiss') await recordDismiss(id, 'leader');
      else if (action === 'snooze' && snoozedUntil) await recordSnooze(id, snoozedUntil);
    }
  }
  return new Response(JSON.stringify({ ok: true, snoozedUntil }), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}
