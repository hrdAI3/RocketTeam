import { NextRequest } from 'next/server';
import { readConfig, writeConfig } from '@/lib/slack';

export const dynamic = 'force-dynamic';

// POST /api/slack/auto-sync
// Body: { enabled: boolean, interval_min?: number }
// Persists toggle. Frontend reads via /api/slack/status to know whether to poll.
export async function POST(req: NextRequest): Promise<Response> {
  let body: { enabled?: boolean; interval_min?: number } = {};
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid JSON' }, 400);
  }
  const cfg = await readConfig();
  if (!cfg) return json({ error: 'not connected' }, 400);

  cfg.auto_sync_enabled = Boolean(body.enabled);
  const interval = body.interval_min ?? 15;
  cfg.auto_sync_interval_min = Math.max(5, Math.min(60, Math.round(interval)));
  await writeConfig(cfg);

  return json({
    ok: true,
    enabled: cfg.auto_sync_enabled,
    interval_min: cfg.auto_sync_interval_min
  });
}

function json(data: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}
