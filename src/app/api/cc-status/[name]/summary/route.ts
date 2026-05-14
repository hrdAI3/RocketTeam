import { readCachedSummaries } from '@/services/work_summary';

export const dynamic = 'force-dynamic';

// GET /api/cc-status/:name/summary
// Cache-only read. The monitor loop (src/services/monitor_loop.ts) regenerates
// summaries on a 5-minute timer for every active/idle agent — clicking into a
// detail page is NOT a trigger. This route just hands back whatever's in the
// cache so the page paints instantly. Returns { items: null } when the loop
// hasn't yet warmed the cache for this name (very cold start).
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
  const all = await readCachedSummaries();
  const hit = all.get(name);
  return new Response(
    JSON.stringify(
      hit
        ? { headline: hit.headline, items: hit.items, generatedAt: hit.generatedAt }
        : { items: null }
    ),
    { headers: { 'Content-Type': 'application/json; charset=utf-8' } }
  );
}
