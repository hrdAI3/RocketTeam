// GET /api/brief — today's leader brief for the /status page top card.
// Cached by Beijing date in sync_state, so this is cheap after the first build.

import { NextResponse } from 'next/server';
import { getTodayBrief } from '../../../services/daily_brief';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const brief = await getTodayBrief();
    return NextResponse.json(brief);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
