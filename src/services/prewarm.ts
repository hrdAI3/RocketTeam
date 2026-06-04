// Dashboard cache prewarmer.
//
// The heavy GET routes memoize their result (memoTTL) so warm hits are <0.3s,
// but a COLD hit (first visit, or after the TTL lapses) still pays the full
// 3-25s build. The monitor loop runs every ~5min; if we force-refresh each
// route's cache on every tick AND the route TTL is ≥ the tick interval, the
// cache is ALWAYS warm — a leader opening any page never waits.
//
// Implementation: invoke each route's own GET handler. With the SWR memoTTL,
// the FIRST tick does a blocking build (cold) to seed the cache; every later
// tick sees a stale-but-usable entry and triggers a background revalidate —
// so the cache is permanently warm and a user's page open is always instant.
// We do NOT bustTTL first (that would leave a cold gap a user request could
// fall into). Errors are swallowed per-route.

// Each entry: the memoTTL cache key + a lazy import of the route's GET. Lazy
// so this module doesn't eagerly pull every route's dependency graph at boot.
const TARGETS: Array<{ key: string; load: () => Promise<{ GET: () => Promise<Response> }> }> = [
  { key: 'workboard', load: () => import('../app/api/workboard/route') },
  { key: 'cc-status', load: () => import('../app/api/cc-status/route') },
  { key: 'team-context', load: () => import('../app/api/team/context/route') },
  { key: 'unclustered', load: () => import('../app/api/unclustered/route') },
  { key: 'roster-health', load: () => import('../app/api/roster/health/route') },
  { key: 'evaluation', load: () => import('../app/api/evaluation/route') },
  { key: 'identity-events', load: () => import('../app/api/identity-events/route') },
  { key: 'cc-source', load: () => import('../app/api/cc-status/source/route') },
  // Goals/Vision both scan the windowed event log via goalsView (cached under
  // 'goals-view'); warming /api/goals keeps that key hot so the page poll is
  // instant. /api/vision reuses the same cached goalsView.
  { key: 'goals', load: () => import('../app/api/goals/route') },
  { key: 'vision', load: () => import('../app/api/vision/route') }
];

export async function prewarmDashboards(): Promise<{ warmed: number; failed: number }> {
  let warmed = 0;
  let failed = 0;
  for (const t of TARGETS) {
    try {
      const mod = await t.load();
      await mod.GET(); // fresh → noop; stale → bg-revalidate; cold → blocking seed
      warmed += 1;
    } catch (err) {
      failed += 1;
      console.warn(`[prewarm] ${t.key} failed:`, (err as Error).message);
    }
  }
  return { warmed, failed };
}
