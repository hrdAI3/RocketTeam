import { NextRequest } from 'next/server';
import { revealCredential } from '@/lib/resources';

export const dynamic = 'force-dynamic';

interface Params {
  params: { id: string };
}

// POST /api/resources/[id]/reveal
// Returns plaintext credential. Separate endpoint so we can audit-log access.
export async function POST(_req: NextRequest, { params }: Params): Promise<Response> {
  const secret = await revealCredential(params.id);
  if (secret === null) {
    return new Response(JSON.stringify({ error: 'no credential or not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  return new Response(JSON.stringify({ credential: secret }), {
    headers: { 'Content-Type': 'application/json' }
  });
}
