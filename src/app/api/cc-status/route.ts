import { getRosterView } from '@/services/cc_status';
import { startMonitorLoop } from '@/services/monitor_loop';
import { memoTTL } from '@/lib/ttl_cache';

export const dynamic = 'force-dynamic';

// Kick the background monitor loop on first hit. Module-init = once per server
// boot; the loop's own global flag prevents stacking on dev hot-reload.
startMonitorLoop();

// GET /api/cc-status
// Lean leader view: open anomalies + a one-line-per-agent roster + a team
// aggregate (cost, activity counts). Per-agent detail is /api/cc-status/[name].
// 30s memoTTL — `getRosterView` streams a 7d window of cc_session events
// (≈ hundreds of MB on disk); without the cache every page navigation rebuilt
// the rollup from scratch (warm latency was 8.8s, matched cold). The page
// auto-refreshes every minute so 30s is fresh enough.
export async function GET(): Promise<Response> {
  const payload = await memoTTL('cc-status', 90_000, async () => {
    const { roster, aggregate, anomalies } = await getRosterView();
    return { roster, aggregate, anomalies };
  });
  return new Response(JSON.stringify(payload), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}
