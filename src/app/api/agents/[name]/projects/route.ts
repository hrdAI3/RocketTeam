// §S6 — per-agent project chips. Returns the registered projects this person
// has contributed to in their cached work-summary, ordered by recency. The
// `/team/[name]` hero renders these as chips linking to project detail.
//
// Source: `cc_summary_cache.json` (work_summary's per-agent breakdown) keyed
// by name. Distinct projectIds → registry name lookup. `unclear` / `new:*` /
// archived ids are dropped — those wouldn't be navigable from the chip.

import { readCachedSummaries } from '@/services/work_summary';
import { readProjects } from '@/lib/projects';

export const dynamic = 'force-dynamic';

interface ChipResponse {
  projects: Array<{ id: string; name: string }>;
}

export async function GET(
  _req: Request,
  { params }: { params: { name: string } }
): Promise<Response> {
  const name = decodeURIComponent(params.name);
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    return json({ error: 'invalid name' }, 400);
  }
  const [summaries, registry] = await Promise.all([readCachedSummaries(), readProjects()]);
  const summ = summaries.get(name);
  if (!summ) return json({ projects: [] } satisfies ChipResponse);

  const idByName = new Map(
    registry.projects
      .filter((p) => p.status !== 'archived')
      .map((p) => [p.id, p.name])
  );
  const seen = new Set<string>();
  const out: ChipResponse['projects'] = [];
  for (const it of summ.items) {
    const pid = it.projectId;
    if (!pid || pid === 'unclear' || pid.startsWith('new:')) continue;
    if (seen.has(pid)) continue;
    const display = idByName.get(pid);
    if (!display) continue; // archived or otherwise unknown — skip
    seen.add(pid);
    out.push({ id: pid, name: display });
  }
  return json({ projects: out } satisfies ChipResponse);
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}
