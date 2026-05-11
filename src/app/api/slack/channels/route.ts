import { getToken, listChannels } from '@/lib/slack';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const token = await getToken();
  if (!token) {
    return json({ error: 'not connected' }, 400);
  }
  try {
    const channels = await listChannels(token);
    return json({
      channels: channels.map((c) => ({
        id: c.id,
        name: c.name,
        is_private: c.is_private,
        num_members: c.num_members,
        topic: c.topic?.value ?? ''
      }))
    });
  } catch (err) {
    return json({ error: (err as Error).message }, 500);
  }
}

function json(data: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}
