import { readMeeting } from '@/lib/meetings';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: { file: string } }): Promise<Response> {
  const file = decodeURIComponent(params.file);
  const content = await readMeeting(file);
  if (content === null) {
    return new Response(JSON.stringify({ error: 'meeting not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json; charset=utf-8' }
    });
  }
  return new Response(JSON.stringify({ file, content }), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}
