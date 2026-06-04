import { NextRequest, NextResponse } from 'next/server';
import {
  findUser,
  verifyPassword,
  issueSession,
  sessionCookieValue
} from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest): Promise<Response> {
  let body: { username?: string; password?: string };
  try {
    body = (await req.json()) as { username?: string; password?: string };
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }
  const username = (body.username ?? '').trim();
  const password = body.password ?? '';
  if (!username || !password) {
    return NextResponse.json({ error: 'username and password required' }, { status: 400 });
  }
  const user = await findUser(username);
  if (!user || !verifyPassword(password, user)) {
    // Generic message — don't leak whether user exists
    return NextResponse.json({ error: 'invalid credentials' }, { status: 401 });
  }
  const { token, expiresAt } = issueSession(username);
  return new NextResponse(JSON.stringify({ ok: true, username }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': sessionCookieValue(token, expiresAt)
    }
  });
}
