import { NextRequest, NextResponse } from 'next/server';
import { readTimeline } from '@/lib/timeline';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  try {
    const limit = parseInt(new URL(req.url).searchParams.get('limit') ?? '200', 10);
    const events = await readTimeline(Math.min(Math.max(limit, 1), 1000));
    return NextResponse.json({ events });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
