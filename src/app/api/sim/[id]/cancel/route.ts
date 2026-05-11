import { NextRequest } from 'next/server';
import { requestCancel } from '@/sim/event_bus';

export const dynamic = 'force-dynamic';

interface Params {
  params: { id: string };
}

// POST /api/sim/[id]/cancel
// Marks sim cancelled. Runner checks isCancelled() between rounds and aborts.
export async function POST(_req: NextRequest, { params }: Params): Promise<Response> {
  requestCancel(params.id);
  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json' }
  });
}
