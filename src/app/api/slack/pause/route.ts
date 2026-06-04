// GET  /api/slack/pause            → { paused, paused_at, paused_by }
// POST /api/slack/pause  { paused } → toggles; records paused_by from session.
//
// Cookie-auth via middleware. Reading the session user lets us attribute the
// flip; falls back to 'leader' if the cookie can't be verified server-side.

import { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { SESSION_COOKIE_NAME, verifySession } from '@/lib/auth';
import { getBotPauseState, setBotPaused } from '@/lib/bot_pause';

export const dynamic = 'force-dynamic';

function getSessionUser(): string {
  try {
    const store = cookies();
    const token = store.get(SESSION_COOKIE_NAME)?.value;
    const session = verifySession(token);
    if (session?.username) return session.username;
  } catch {
    // Fall through
  }
  return 'leader';
}

export async function GET(): Promise<Response> {
  const state = await getBotPauseState();
  return json(state);
}

export async function POST(req: NextRequest): Promise<Response> {
  let body: { paused?: unknown } = {};
  try {
    body = (await req.json()) as { paused?: unknown };
  } catch {
    return json({ error: 'invalid JSON' }, 400);
  }
  if (typeof body.paused !== 'boolean') {
    return json({ error: 'body.paused must be boolean' }, 400);
  }
  const by = getSessionUser();
  const next = await setBotPaused(body.paused, by);
  return json(next);
}

function json(data: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}
