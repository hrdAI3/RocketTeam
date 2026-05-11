import { NextRequest, NextResponse } from 'next/server';
import { readSimReplay } from '@/sim/runner';

export const dynamic = 'force-dynamic';

interface Params {
  params: { id: string };
}

export async function GET(_req: NextRequest, { params }: Params): Promise<Response> {
  const state = await readSimReplay(params.id);
  if (!state) {
    return NextResponse.json({ error: 'sim not found' }, { status: 404 });
  }
  return NextResponse.json(state);
}
