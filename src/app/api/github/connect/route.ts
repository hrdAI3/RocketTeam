import { NextRequest } from 'next/server';
import { authVerify, encrypt, writeConfig } from '@/lib/github';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest): Promise<Response> {
  let body: { pat?: string } = {};
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid JSON' }, 400);
  }
  const token = (body.pat ?? '').trim();
  if (!token.startsWith('ghp_') && !token.startsWith('github_pat_')) {
    return json({ error: 'PAT 应以 ghp_ 或 github_pat_ 开头' }, 400);
  }
  let user;
  try {
    user = await authVerify(token);
  } catch (err) {
    return json({ error: `验证失败: ${(err as Error).message}` }, 400);
  }
  await writeConfig({
    pat_encrypted: encrypt(token),
    org_or_user: user.login,
    login: user.login,
    connected_at: new Date().toISOString()
  });
  return json({ ok: true, login: user.login, type: user.type });
}

function json(d: unknown, s = 200): Response {
  return new Response(JSON.stringify(d), {
    status: s,
    headers: { 'Content-Type': 'application/json' }
  });
}
