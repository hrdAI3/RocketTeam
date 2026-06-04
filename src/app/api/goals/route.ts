// /api/goals — the Goal layer's single endpoint.
//
// Auth is automatic: src/middleware.ts already gates all /api/* (401 JSON
// without a team-session), so no middleware edit is needed here.
//
// GET  → the full computed view (goals + live progress + drift) so the page is
//        one fetch. All numbers recomputed live in goalsView() — nothing stale
//        on disk.
// POST → create / edit / link / archive. All writes go through updateGoals()
//        (mutex + atomic read-modify-write); never readGoals()+writeGoals()
//        across an await (lost-update risk #7).

import { NextRequest, NextResponse } from 'next/server';
import { goalsView } from '../../../services/goal_progress';
import { updateGoals, type Goal } from '../../../lib/goals';
import { readProjects, slugify, uniqueSlug } from '../../../lib/projects';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const view = await goalsView();
    return NextResponse.json(view);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

interface GoalBody {
  id?: string;
  title?: string;
  description?: string;
  linked_project_ids?: string[];
  status?: 'active' | 'archived';
  target?: string;
  vision_area_id?: string; // optional area linkage; keeps goals.json the single source of the goal→area link
}

function bad(message: string, status = 400): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' } as const;

export async function POST(req: NextRequest): Promise<Response> {
  let body: GoalBody;
  try {
    body = (await req.json()) as GoalBody;
  } catch {
    return bad('invalid json');
  }

  // Validate that every supplied linked id exists AND is an active project.
  // Resolution is fresh-from-disk each call so an archived/renamed project is
  // caught at write time. Returns null on success, an error string otherwise.
  async function validateLinks(ids: string[] | undefined): Promise<string | null> {
    if (!Array.isArray(ids) || ids.length < 1) {
      return 'linked_project_ids must have at least 1 active project id';
    }
    const projects = (await readProjects()).projects;
    const activeIds = new Set(projects.filter((p) => p.status === 'active').map((p) => p.id));
    for (const id of ids) {
      if (typeof id !== 'string' || !activeIds.has(id)) {
        return `unknown or archived project id: ${String(id)}`;
      }
    }
    return null;
  }

  const now = new Date().toISOString();

  // ── EDIT / LINK / ARCHIVE (id present) ───────────────────────────────────
  if (typeof body.id === 'string' && body.id.length > 0) {
    const targetId = body.id;
    // Pre-validate links if the caller is changing them (outside the mutex so a
    // 400 doesn't hold the lock; the patch itself re-reads under the mutex).
    if (body.linked_project_ids !== undefined) {
      const err = await validateLinks(body.linked_project_ids);
      if (err) return bad(err);
    }
    let found: Goal | undefined;
    await updateGoals((file) => {
      const g = file.goals.find((x) => x.id === targetId);
      if (!g) return file; // unknown → no-op; reported as 404 below
      if (typeof body.title === 'string' && body.title.trim()) g.title = body.title.trim();
      if (typeof body.description === 'string') g.description = body.description;
      if (body.linked_project_ids !== undefined) g.linked_project_ids = body.linked_project_ids;
      if (body.status === 'active' || body.status === 'archived') g.status = body.status;
      if (typeof body.target === 'string') g.target = body.target;
      if (typeof body.vision_area_id === 'string') {
        const v = body.vision_area_id.trim();
        if (v) g.vision_area_id = v;
        else delete g.vision_area_id; // blank → unlink
      }
      g.updated_at = now;
      found = g;
      return file;
    });
    if (!found) return bad('unknown goal id', 404);
    return new NextResponse(JSON.stringify(found), { headers: JSON_HEADERS });
  }

  // ── CREATE (no id) ───────────────────────────────────────────────────────
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (!title) return bad('title is required');
  const linkErr = await validateLinks(body.linked_project_ids);
  if (linkErr) return bad(linkErr);

  let created: Goal | undefined;
  await updateGoals((file) => {
    const taken = new Set(file.goals.map((g) => g.id));
    const id = uniqueSlug(slugify(title), taken);
    const goal: Goal = {
      id,
      title,
      description: typeof body.description === 'string' ? body.description : '',
      linked_project_ids: body.linked_project_ids as string[],
      status: 'active',
      created_at: now,
      updated_at: now,
      ...(typeof body.target === 'string' && body.target ? { target: body.target } : {}),
      ...(typeof body.vision_area_id === 'string' && body.vision_area_id.trim()
        ? { vision_area_id: body.vision_area_id.trim() }
        : {})
    };
    file.goals.push(goal);
    created = goal;
    return file;
  });
  // created is always set here (mutator runs synchronously inside updateGoals).
  if (!created) return bad('failed to create goal', 500);
  return new NextResponse(JSON.stringify(created), { headers: JSON_HEADERS });
}
