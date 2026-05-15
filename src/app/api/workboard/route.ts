import { getWorkboardView } from '@/services/workboard';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  return Response.json(await getWorkboardView());
}
