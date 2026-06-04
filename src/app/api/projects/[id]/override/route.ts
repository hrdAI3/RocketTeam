// §3.4 leader override — writes a manual decision into `projects.json`:
//
//   POST /api/projects/<id>/override
//   Body: { kind: 'split' | 'merge' | 'rename', target_id?, new_name?, reason }
//
// The resolver respects overrides on later runs: once a project has a single
// `overrides` entry, the auto-resolver leaves it alone (`isOverrideLocked`).
// Leader can always add more overrides later — the lock is at "any override
// present", not at a specific entry.
//
// Atomic: the write goes through `updateProjects` (mutex + tmp+rename).

import { NextRequest } from 'next/server';
import { updateProjects, type ProjectOverride } from '@/lib/projects';

export const dynamic = 'force-dynamic';

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
): Promise<Response> {
  const id = decodeURIComponent(params.id);
  let body: {
    kind?: ProjectOverride['kind'];
    target_id?: string;
    new_name?: string;
    reason?: string;
  } = {};
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid JSON' }, 400);
  }
  const kind = body.kind;
  if (kind !== 'split' && kind !== 'merge' && kind !== 'rename') {
    return json({ error: 'kind must be one of split|merge|rename' }, 400);
  }
  if (kind === 'merge' && (!body.target_id || typeof body.target_id !== 'string')) {
    return json({ error: 'merge requires target_id' }, 400);
  }
  if (kind === 'rename' && (!body.new_name || typeof body.new_name !== 'string')) {
    return json({ error: 'rename requires new_name' }, 400);
  }
  const reason = (body.reason ?? '').trim().slice(0, 200);
  if (!reason) return json({ error: 'reason required' }, 400);

  const nowIso = new Date().toISOString();
  const entry: ProjectOverride = {
    at: nowIso,
    kind,
    ...(body.target_id ? { target_id: body.target_id } : {}),
    ...(body.new_name ? { new_name: body.new_name } : {}),
    reason
  };

  let found = false;
  await updateProjects((file) => {
    const p = file.projects.find((q) => q.id === id);
    if (!p) return file;
    found = true;
    p.overrides.push(entry);
    // Side effects per kind, kept simple — heavier semantics (actual merging
    // of work items, archival sweep) happen in the resolver on the next sync.
    if (kind === 'rename' && body.new_name) {
      p.name = body.new_name.slice(0, 80);
    }
    if (kind === 'split') {
      // Resolver locks the project from auto-touch but doesn't itself split.
      // Caller's expected followup: manually edit projects.json, or wait for
      // the next extraction pass to mint the carved-out aliases as new ids.
    }
    if (kind === 'merge' && body.target_id) {
      // Mark this project as archived; preserve its evidence. The target_id
      // becomes the canonical project; future attributions flowing through
      // the resolver will fall onto this id only via override-aware logic.
      p.status = 'archived';
    }
    return file;
  });

  return found
    ? json({ ok: true, entry })
    : json({ error: `project ${id} not found` }, 404);
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}
