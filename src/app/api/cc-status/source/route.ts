import { listUsers } from '@/extractors/cc_session';
import { readSyncState, streamEvents } from '@/lib/events';
import { memoTTL } from '@/lib/ttl_cache';

export const dynamic = 'force-dynamic';

// GET /api/cc-status/source
// Health of the CC SESSIONS collector — the primary data source.
// Tells the leader: is the collector reachable, how many users it knows about,
// how many CC events we've ingested, and when we last synced each user.
export async function GET(): Promise<Response> {
  const data = await memoTTL('cc-source', 90_000, async () => {
    const base = process.env.CC_COLLECTOR_BASE ?? 'http://192.168.22.88:8933';
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

    // Count cc_session events ingested. Streams the file (bounded memory) and
    // accumulates a counter + agents-with-data set; previously this was a
    // full-file readAllEvents() that materialized 500MB+ in memory just to
    // bump two counters.
    let ccEventCount = 0;
    const agentsWithData = new Set<string>();
    await streamEvents({ source: 'cc_session' }, (e) => {
      ccEventCount++;
      if (e.subject.kind === 'agent') agentsWithData.add(e.subject.ref);
    });

    const perUser = users.map((email) => ({
      email,
      lastSyncedMtime: syncState.users[email]?.lastSyncedMtime ?? null
    }));

    return {
      base,
      reachable,
      collectorError,
      knownUsers: users.length,
      perUser,
      ccEventCount,
      agentsWithData: agentsWithData.size
    };
  });

  return new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}
