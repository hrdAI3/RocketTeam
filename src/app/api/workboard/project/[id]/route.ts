import { getProjectDetail } from '@/services/workboard';

export const dynamic = 'force-dynamic';

export async function GET(
  _req: Request,
  { params }: { params: { id: string } }
): Promise<Response> {
  const detail = await getProjectDetail(decodeURIComponent(params.id));
  return detail ? Response.json(detail) : new Response('Not found', { status: 404 });
}
