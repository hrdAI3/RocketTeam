// Leader-driven project archive — soft delete.
//
//   POST /api/projects/<id>/archive
//   Body: { reason?: string }     // optional, default "leader archived from /team"
//
// Sets `status: 'archived'` so the registry stops surfacing the project on
// /team and stops considering it during auto-attribution. Evidence
// (observed_cwds, overrides history, last_attributed_at) is preserved — the
// archive can be reversed by hand-editing projects.json back to 'active'.
// Audit trail: appends an `ProjectOverride { kind:'archive' }` entry so the
// reason and timestamp survive future re-attribution sweeps.

import { NextRequest } from 'next/server';
import { updateProjects, readProjects } from '@/lib/projects';
import { loadProjectKnowledge } from '@/lib/project_knowledge';
import { bustTTL } from '@/lib/ttl_cache';

export const dynamic = 'force-dynamic';

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
): Promise<Response> {
  const id = decodeURIComponent(params.id);
  let body: { reason?: string } = {};
  try {
    body = await req.json();
  } catch {
    /* body optional */
  }
  const reason = (body.reason ?? 'leader archived from /team').trim().slice(0, 200);

  // Curated projects are leader-blessed in private/project_knowledge.json.
  // Archiving the canonical registry row would just trigger Step 3 of
  // buildMergedProjects to re-synthesize the project as `virtual:<name>` on
  // the next /team render — confusing flip with no real effect. Refuse here
  // so the UI gate isn't the only line of defense (CLI / curl / scripts
  // hit this endpoint too). To retire a curated project the leader edits
  // private/project_knowledge.json by hand.
  const [registry, knowledge] = await Promise.all([readProjects(), loadProjectKnowledge()]);
  const candidate = registry.projects.find((q) => q.id === id);
  if (candidate) {
    // Mirror the matching in buildMergedProjects (src/app/api/team/context):
    // a canonical row is "curated" if its name OR any alias OR any
    // observed_cwds leaf matches a knownName or alias in
    // project_knowledge.json. The observed_cwds path matters — e.g.
    // canonical `agent-game-platform` maps to curated `Maya` because its
    // cwds include `maya`, `maya内容生产` even though the canonical name
    // and aliases never mention "maya".
    const curatedAliases = new Set<string>();
    for (const [knownName, entry] of Object.entries(knowledge)) {
      curatedAliases.add(knownName.toLowerCase());
      for (const a of entry.aliases ?? []) curatedAliases.add(a.toLowerCase());
    }
    const candidateKeys: string[] = [
      candidate.name.toLowerCase(),
      ...(candidate.aliases ?? []).map((s) => s.toLowerCase())
    ];
    for (const cwd of candidate.observed_cwds ?? []) {
      const leaf = cwd.replace(/\\/g, '/').split('/').filter(Boolean).pop();
      if (leaf) candidateKeys.push(leaf.toLowerCase());
    }
    if (candidateKeys.some((n) => curatedAliases.has(n))) {
      return json(
        {
          error: 'project is curated in project_knowledge.json — refusing to archive (would trigger virtual: re-synthesis); edit the knowledge file by hand to retire'
        },
        409
      );
    }
  }

  let found = false;
  let alreadyArchived = false;
  await updateProjects((file) => {
    const p = file.projects.find((q) => q.id === id);
    if (!p) return file;
    found = true;
    if (p.status === 'archived') {
      alreadyArchived = true;
      return file;
    }
    p.status = 'archived';
    p.overrides.push({
      at: new Date().toISOString(),
      kind: 'archive',
      reason
    });
    return file;
  });

  if (!found) return json({ error: `project ${id} not found` }, 404);
  if (alreadyArchived) return json({ ok: true, already_archived: true });
  // Archive changes what /team + /status show — bust their caches so the
  // project disappears immediately instead of lingering for up to the TTL.
  bustTTL('team-context');
  bustTTL('workboard');
  return json({ ok: true });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}
