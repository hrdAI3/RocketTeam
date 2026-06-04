// GET /api/slack/messages?limit=200&direction=out|in|all
// Returns the most recent rows from private/slack_messages.jsonl, newest first.
// Tolerates a missing file (returns rows:[]). Cookie-auth via middleware.

import { NextRequest } from 'next/server';
import { tailSlackLog, type SlackLogRecord } from '@/lib/slack_log';
import { readRoster } from '@/lib/team_roster';

export const dynamic = 'force-dynamic';

// slack_user_id → display name (member.name) for joining log rows. Built per
// request from the roster — small enough not to need caching.
async function buildSlackIdToNameMap(): Promise<Map<string, string>> {
  const roster = await readRoster();
  const m = new Map<string, string>();
  for (const member of roster.members) {
    const sid = member.slack?.user_id;
    if (sid) m.set(sid, member.name);
  }
  return m;
}

export async function GET(req: NextRequest): Promise<Response> {
  const url = new URL(req.url);
  const limitRaw = url.searchParams.get('limit');
  const direction = url.searchParams.get('direction') ?? 'all';
  let limit = Number.parseInt(limitRaw ?? '200', 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = 200;
  // Cap; the log file is operator-facing and not paginated.
  if (limit > 2000) limit = 2000;

  // Over-fetch when filtering so that direction-filtering doesn't starve the
  // page (e.g. asking for 200 inbound and finding only 30 in the last 200 rows).
  const fetchLimit = direction === 'out' || direction === 'in' ? limit * 4 : limit;
  let rows: SlackLogRecord[];
  try {
    rows = await tailSlackLog(fetchLimit);
  } catch (err) {
    return json({ error: 'read-failed', detail: (err as Error).message }, 500);
  }

  let filtered = rows;
  if (direction === 'out' || direction === 'in') {
    filtered = rows.filter((r) => r.direction === direction);
  }
  if (filtered.length > limit) filtered = filtered.slice(0, limit);

  // Join slack_user_id → roster display name. The backfill writer didn't fill
  // `recipient_name` (it only had the slack id), so rows arrived showing raw
  // U0B0EJRMLHK. Resolve at read time so the UI sees real names without a
  // re-write. Doesn't overwrite an existing recipient_name (the canonical
  // logger already sets it when caller passed it in).
  const idToName = await buildSlackIdToNameMap();
  const joined = filtered.map((r) => {
    if (r.recipient_name) return r;
    const sid = r.slack_user_id;
    if (!sid) return r;
    const name = idToName.get(sid);
    return name ? { ...r, recipient_name: name } : r;
  });
  return json({ rows: joined });
}

function json(data: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}
