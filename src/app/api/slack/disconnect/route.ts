import { deleteConfig } from '@/lib/slack';

export const dynamic = 'force-dynamic';

export async function POST(): Promise<Response> {
  await deleteConfig();
  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json' }
  });
}
