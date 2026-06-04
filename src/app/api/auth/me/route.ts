import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { SESSION_COOKIE_NAME, verifySession } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const store = cookies();
  const token = store.get(SESSION_COOKIE_NAME)?.value;
  const session = verifySession(token);
  if (!session) return NextResponse.json({ ok: false }, { status: 401 });
  return NextResponse.json({ ok: true, username: session.username });
}
