import { listMeetings } from '@/lib/meetings';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const meetings = await listMeetings();
  return new Response(JSON.stringify({ meetings }), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}
