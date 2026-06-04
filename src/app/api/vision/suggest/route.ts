// /api/vision/suggest — on-demand, LLM-backed goal proposals that close the two
// strategic-drift gaps (drift projects → goals, mapped to vision areas).
//
// Auth: src/middleware.ts already gates /api/*. GET only (no writes here — the
// leader Accepts a suggestion via POST /api/goals create). Kept OFF the main
// /api/vision GET so the cheap view never pays the LLM/latency cost.

import { NextResponse } from 'next/server';
import { suggestGoals } from '../../../../services/vision_suggest';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const view = await suggestGoals();
    return NextResponse.json(view);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
