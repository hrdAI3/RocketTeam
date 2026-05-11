import { readConfig } from '@/lib/github';

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
      org_or_user: cfg.org_or_user,
      login: cfg.login,
      connected_at: cfg.connected_at,
      last_sync_at: cfg.last_sync_at,
      selected_repos: cfg.selected_repos ?? []
    }),
    { headers: { 'Content-Type': 'application/json' } }
  );
}
