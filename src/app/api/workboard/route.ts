import { getWorkboardView } from '@/services/workboard';
import { startMonitorLoop } from '@/services/monitor_loop';
import { memoTTL } from '@/lib/ttl_cache';

export const dynamic = 'force-dynamic';

// Same as /api/cc-status: kick the monitor loop on first hit. The /status page
// (the leader's primary landing page) loads /api/workboard, not /api/cc-status,
// so without this the background source-sync loop never starts if the leader
// never visits the per-person page. Idempotent via the global guard in
// monitor_loop.ts.
startMonitorLoop();

export async function GET(): Promise<Response> {
  // 30s cache — /status + /status/projects both hit this; the underlying
  // getWorkboardView (roster + work_summary + project rollup) is ~3.5s.
  return Response.json(await memoTTL('workboard', 90_000, () => getWorkboardView()));
}
