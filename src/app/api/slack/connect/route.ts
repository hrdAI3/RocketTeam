import { NextRequest } from 'next/server';
import { authTest, encrypt, writeConfig } from '@/lib/slack';

export const dynamic = 'force-dynamic';

// POST /api/slack/connect
// Body: { bot_token: 'xoxb-...' }
// Verifies via auth.test, encrypts + persists to slack.config.json.
export async function POST(req: NextRequest): Promise<Response> {
  let body: { bot_token?: string } = {};
  try {
    body = (await req.json()) as { bot_token?: string };
  } catch {
    return json({ error: 'invalid JSON' }, 400);
  }
  const token = (body.bot_token ?? '').trim();
  if (!token.startsWith('xoxb-')) {
    return json({ error: 'Bot token 必须以 xoxb- 开头' }, 400);
  }

  let auth;
  try {
    auth = await authTest(token);
  } catch (err) {
    return json({ error: `Slack 验证失败: ${(err as Error).message}` }, 400);
  }

  await writeConfig({
    bot_token_encrypted: encrypt(token),
    team_id: auth.team_id,
    team_name: auth.team,
    bot_user_id: auth.user_id,
    connected_at: new Date().toISOString()
  });

  return json({
    ok: true,
    team: auth.team,
    team_id: auth.team_id,
    bot_user: auth.user
  });
}

function json(data: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}
