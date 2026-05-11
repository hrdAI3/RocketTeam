import { readConfig } from '@/lib/slack';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const cfg = await readConfig();
  if (!cfg) {
    return new Response(JSON.stringify({ connected: false }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
  return new Response(
    JSON.stringify({
      connected: true,
      team: cfg.team_name,
      team_id: cfg.team_id,
      bot_user_id: cfg.bot_user_id,
      connected_at: cfg.connected_at,
      last_sync_at: cfg.last_sync_at,
      selected_channels: cfg.selected_channels ?? [],
      auto_sync_enabled: cfg.auto_sync_enabled ?? false,
      auto_sync_interval_min: cfg.auto_sync_interval_min ?? 15
    }),
    { headers: { 'Content-Type': 'application/json' } }
  );
}
