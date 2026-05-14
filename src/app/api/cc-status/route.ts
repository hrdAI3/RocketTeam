import { getRosterView } from '@/services/cc_status';
import { startMonitorLoop } from '@/services/monitor_loop';

export const dynamic = 'force-dynamic';

// Kick the background monitor loop on first hit. Module-init = once per server
// boot; the loop's own global flag prevents stacking on dev hot-reload.
startMonitorLoop();

// GET /api/cc-status
// Lean leader view: open anomalies + a one-line-per-agent roster + a team
// aggregate (cost, activity counts). Per-agent detail is /api/cc-status/[name].
// Powers the web dashboard at /status and the CLI `team:status`.
export async function GET(): Promise<Response> {
  const { roster, aggregate, anomalies } = await getRosterView();
  return new Response(JSON.stringify({ roster, aggregate, anomalies }), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}
