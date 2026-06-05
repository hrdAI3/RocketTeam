// /api/plan — the strategic planning engine output (vision/goal tree + real
// execution → leverage-ranked decision cards with forced counter-arguments).
//
// Auth: src/middleware.ts gates /api/*. GET only (on-demand; the leader acts on
// the decision cards, no writes here). Cached (memoTTL inside buildStrategicPlan)
// so the heavy LLM pass amortizes.

import { NextResponse } from 'next/server';
import { buildStrategicPlan } from '../../../services/planning_engine';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const plan = await buildStrategicPlan();
    return NextResponse.json(plan);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
