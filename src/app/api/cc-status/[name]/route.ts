import { getOneStatus } from '@/services/cc_status';

export const dynamic = 'force-dynamic';

// GET /api/cc-status/:name
// Per-agent CC detail: recent sessions, tools, token usage, stuck quotes.
// This is drill-down — the leader only opens it when they have a concern about
// a specific person. The roster row links here.
export async function GET(
  _req: Request,
  { params }: { params: { name: string } }
): Promise<Response> {
  const name = decodeURIComponent(params.name);
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    return new Response(JSON.stringify({ error: 'invalid name' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  const detail = await getOneStatus(name);
  if (!detail) {
    return new Response(JSON.stringify({ error: 'not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  return new Response(JSON.stringify(detail), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}
