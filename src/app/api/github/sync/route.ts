import { NextRequest } from 'next/server';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { getToken, readConfig, writeConfig, fetchRecentPRs } from '@/lib/github';
import { PATHS } from '@/lib/paths';
import { appendTimelineEvent } from '@/lib/timeline';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// POST /api/github/sync
// Body: { repos: [{owner, name}], days_back?: number }
// Pulls recent PRs into team/context/github/{owner}-{repo}-{date}.txt
export async function POST(req: NextRequest): Promise<Response> {
  const token = await getToken();
  if (!token) return json({ error: 'not connected' }, 400);

  let body: { repos?: Array<{ owner: string; name: string }>; days_back?: number } = {};
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid JSON' }, 400);
  }
  const selected = body.repos ?? [];
  if (selected.length === 0) return json({ error: 'no repos selected' }, 400);
  const daysBack = body.days_back ?? 30;

  const ghDir = join(PATHS.context, 'github');
  await fs.mkdir(ghDir, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const written: Array<{ repo: string; file: string; prs: number }> = [];
  const errors: Array<{ repo: string; error: string }> = [];

  for (const r of selected) {
    try {
      const prs = await fetchRecentPRs(token, r.owner, r.name, daysBack);
      const lines: string[] = [
        `# GitHub ${r.owner}/${r.name}`,
        `导出于 ${today} · 过去 ${daysBack} 天 · 共 ${prs.length} 个 PR`,
        ''
      ];
      for (const p of prs) {
        const ts = p.created_at.slice(0, 10);
        const status = p.merged_at ? 'merged' : p.state === 'closed' ? 'closed' : 'open';
        lines.push(`[${ts}] @${p.user.login} #${p.number} (${status}): ${p.title}`);
        if (p.body) {
          const body = p.body.replace(/\r?\n+/g, ' ').slice(0, 240);
          lines.push(`  ${body}`);
        }
      }
      const fileName = `gh-${r.owner}-${r.name}-${today}.txt`;
      await fs.writeFile(join(ghDir, fileName), lines.join('\n'), 'utf8');
      written.push({ repo: `${r.owner}/${r.name}`, file: fileName, prs: prs.length });
    } catch (err) {
      errors.push({ repo: `${r.owner}/${r.name}`, error: (err as Error).message });
    }
  }

  const cfg = await readConfig();
  if (cfg) {
    cfg.last_sync_at = new Date().toISOString();
    cfg.selected_repos = selected;
    await writeConfig(cfg);
  }

  await appendTimelineEvent({
    ts: new Date().toISOString(),
    type: 'bootstrap',
    summary: `GitHub 同步完成 · ${written.length} 仓库 · 共 ${written.reduce((a, w) => a + w.prs, 0)} 个 PR`,
    detail: { written, errors }
  });

  return json({ ok: true, written, errors });
}

function json(d: unknown, s = 200): Response {
  return new Response(JSON.stringify(d), {
    status: s,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}
