import { listUsers } from '@/extractors/cc_session';
import { readSyncState, readAllEvents } from '@/lib/events';

export const dynamic = 'force-dynamic';

// GET /api/cc-status/source
// Health of the CC SESSIONS collector — the primary data source.
// Tells the leader: is the collector reachable, how many users it knows about,
// how many CC events we've ingested, and when we last synced each user.
export async function GET(): Promise<Response> {
  const base = process.env.CC_COLLECTOR_BASE ?? 'http://192.168.22.88:8848';
  let reachable = false;
  let users: string[] = [];
  let collectorError: string | undefined;
  try {
    users = await listUsers();
    reachable = true;
  } catch (err) {
    collectorError = (err as Error).message;
  }

  const syncState = (await readSyncState<{ users: Record<string, { lastSyncedMtime?: string }> }>(
    'cc_session'
  )) ?? { users: {} };

  // Count cc_session events ingested.
  const events = await readAllEvents();
  let ccEventCount = 0;
  const agentsWithData = new Set<string>();
  for (const e of events) {
    if (e.source === 'cc_session') {
      ccEventCount++;
      if (e.subject.kind === 'agent') agentsWithData.add(e.subject.ref);
    }
  }

  const perUser = users.map((email) => ({
    email,
    lastSyncedMtime: syncState.users[email]?.lastSyncedMtime ?? null
  }));

  return new Response(
    JSON.stringify({
      base,
      reachable,
      collectorError,
      knownUsers: users.length,
      perUser,
      ccEventCount,
      agentsWithData: agentsWithData.size
    }),
    { headers: { 'Content-Type': 'application/json; charset=utf-8' } }
  );
}
