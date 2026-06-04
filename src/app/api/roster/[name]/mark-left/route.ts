// POST /api/roster/:name/mark-left — leader-confirmed departure.
// This is the ONLY path that sets status='left'; it runs only after the leader
// explicitly confirms in the UI. Detection (GET /api/roster/health) never
// mutates. Uses the SAFE roster mutation pattern: clear cache → re-read fresh →
// mutate → write (which repopulates the cache).

import { NextResponse } from 'next/server';
import { clearRosterCache, readRoster, writeRoster } from '@/lib/team_roster';
import { bustTTL } from '@/lib/ttl_cache';

export const dynamic = 'force-dynamic';

export async function POST(
  _req: Request,
  { params }: { params: { name: string } }
): Promise<Response> {
  const name = decodeURIComponent(params.name);
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    return NextResponse.json({ error: 'invalid name' }, { status: 400 });
  }

  // Safe mutation: discard any stale in-process cache, read the freshest roster,
  // mutate the one member, persist atomically.
  clearRosterCache();
  const roster = await readRoster();
  const member = roster.members.find((m) => m.name === name);
  if (!member) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  member.status = 'left';
  member.left_at = new Date().toISOString();
  await writeRoster(roster);

  // Departure affects compliance + the health rail — bust cached views.
  bustTTL('roster-health');
  bustTTL('team-context');

  return NextResponse.json({ ok: true });
}
