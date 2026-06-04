// /api/vision — the Vision layer's single endpoint. Mirrors /api/goals.
//
// Auth is automatic: src/middleware.ts already gates all /api/* (401 JSON
// without a team-session), so no middleware edit is needed here.
//
// GET  → the full computed view (areas + rolled-up progress + the two drift
//        signals) so the page is one fetch. All numbers recomputed live in
//        visionView() (which aggregates goalsView()) — nothing stale on disk.
// POST → create / edit / archive an area (via updateVision), OR link/unlink a
//        goal to an area (via updateGoals — the goal is the SINGLE source of the
//        link). All writes go through the mutex'd read-modify-write helpers;
//        never readVision()+writeVision() across an await (lost-update risk).

import { NextRequest, NextResponse } from 'next/server';
import { visionView } from '../../../services/vision_progress';
import { updateVision, readVision, type VisionArea } from '../../../lib/vision';
import { updateGoals } from '../../../lib/goals';
import { slugify, uniqueSlug } from '../../../lib/projects';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const view = await visionView();
    return NextResponse.json(view);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

interface VisionBody {
  // area create / edit / archive
  id?: string;
  title?: string;
  description?: string;
  target?: string;
  status?: 'active' | 'archived';
  // link-goal path (distinguished by presence of goal_id)
  goal_id?: string;
  vision_area_id?: string; // '' to unlink
}

function bad(message: string, status = 400): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' } as const;

export async function POST(req: NextRequest): Promise<Response> {
  let body: VisionBody;
  try {
    body = (await req.json()) as VisionBody;
  } catch {
    return bad('invalid json');
  }

  const now = new Date().toISOString();

  // ── LINK / UNLINK a goal to an area (goal_id present) ────────────────────
  // The link lives ONLY on the Goal (goals.json's vision_area_id). This is the
  // ONLY writer of that field, keeping goals.json the single source of truth.
  if (typeof body.goal_id === 'string' && body.goal_id.length > 0) {
    const goalId = body.goal_id;
    const areaId = typeof body.vision_area_id === 'string' ? body.vision_area_id.trim() : '';
    // Validate the target area exists + is active (skip when unlinking with '').
    // Done outside the mutex; the goal patch re-reads under updateGoals' mutex.
    if (areaId) {
      const vis = await readVision();
      const area = vis.areas.find((a) => a.id === areaId);
      if (!area) return bad(`unknown vision area id: ${areaId}`);
      if (area.status !== 'active') return bad(`vision area is archived: ${areaId}`);
    }
    let found = false;
    await updateGoals((file) => {
      const g = file.goals.find((x) => x.id === goalId);
      if (!g) return file; // unknown → no-op, reported as 404 below
      if (areaId) g.vision_area_id = areaId;
      else delete g.vision_area_id; // unlink: drop the field entirely
      g.updated_at = now;
      found = true;
      return file;
    });
    if (!found) return bad('unknown goal id', 404);
    return new NextResponse(JSON.stringify({ goal_id: goalId, vision_area_id: areaId }), {
      headers: JSON_HEADERS
    });
  }

  // ── EDIT / ARCHIVE an area (id present) ──────────────────────────────────
  if (typeof body.id === 'string' && body.id.length > 0) {
    const targetId = body.id;
    let found: VisionArea | undefined;
    await updateVision((file) => {
      const a = file.areas.find((x) => x.id === targetId);
      if (!a) return file; // unknown → no-op; reported as 404 below
      if (typeof body.title === 'string' && body.title.trim()) a.title = body.title.trim();
      if (typeof body.description === 'string') a.description = body.description;
      if (typeof body.target === 'string') a.target = body.target;
      if (body.status === 'active' || body.status === 'archived') a.status = body.status;
      a.updated_at = now;
      found = a;
      return file;
    });
    if (!found) return bad('unknown vision area id', 404);
    return new NextResponse(JSON.stringify(found), { headers: JSON_HEADERS });
  }

  // ── CREATE an area (no id) ───────────────────────────────────────────────
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (!title) return bad('title is required');

  let created: VisionArea | undefined;
  await updateVision((file) => {
    const taken = new Set(file.areas.map((a) => a.id));
    const id = uniqueSlug(slugify(title), taken);
    const area: VisionArea = {
      id,
      title,
      description: typeof body.description === 'string' ? body.description : '',
      status: 'active',
      created_at: now,
      updated_at: now,
      ...(typeof body.target === 'string' && body.target ? { target: body.target } : {})
    };
    file.areas.push(area);
    created = area;
    return file;
  });
  if (!created) return bad('failed to create vision area', 500);
  return new NextResponse(JSON.stringify(created), { headers: JSON_HEADERS });
}
