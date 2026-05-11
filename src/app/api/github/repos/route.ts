import { getToken, listRepos } from '@/lib/github';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const token = await getToken();
  if (!token) return json({ error: 'not connected' }, 400);
  try {
    const repos = await listRepos(token, 'user');
    return json({
      repos: repos.map((r) => ({
        id: r.id,
        owner: r.owner.login,
        name: r.name,
        full_name: r.full_name,
        private: r.private,
        description: r.description,
        pushed_at: r.pushed_at,
        open_issues_count: r.open_issues_count
      }))
    });
  } catch (err) {
    return json({ error: (err as Error).message }, 500);
  }
}

function json(d: unknown, s = 200): Response {
  return new Response(JSON.stringify(d), {
    status: s,
    headers: { 'Content-Type': 'application/json' }
  });
}
