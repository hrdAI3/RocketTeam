// POST /api/slack/send  { slack_user_id, text }
//
// Manual operator send — bypasses the bot-paused kill-switch. The whole point
// of pausing the bot is so the leader can answer specific threads by hand;
// this route is the hand. Goes straight to chat.postMessage with the existing
// stored token. Logs as direction='out', intent='manual-send'.

import { NextRequest } from 'next/server';
import { getToken, openConversation } from '@/lib/slack';
import { logSlackMessage } from '@/lib/slack_log';
import { lookupBySlack } from '@/lib/team_roster';

export const dynamic = 'force-dynamic';

interface Body {
  slack_user_id?: unknown;
  text?: unknown;
}

export async function POST(req: NextRequest): Promise<Response> {
  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    return json({ error: 'invalid JSON' }, 400);
  }
  const userId = typeof body.slack_user_id === 'string' ? body.slack_user_id.trim() : '';
  const text = typeof body.text === 'string' ? body.text : '';
  if (!userId) return json({ error: 'slack_user_id required' }, 400);
  if (!text.trim()) return json({ error: 'text required' }, 400);

  const token = await getToken();
  if (!token) return json({ error: 'no-slack-token' }, 503);

  // Best-effort roster name for the log row.
  const member = await lookupBySlack(userId).catch(() => null);

  const channel = await openConversation(token, userId);
  if (!channel) {
    await logSlackMessage({
      ts: new Date().toISOString(),
      direction: 'out',
      slack_user_id: userId,
      recipient_name: member?.name,
      text,
      ok: false,
      intent: 'manual-send',
      route: '/api/slack/send',
      reason: 'open-conversation-failed',
      captured_at: new Date().toISOString()
    });
    return json({ ok: false, error: 'open-conversation-failed' }, 502);
  }

  try {
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8'
      },
      body: JSON.stringify({ channel, text })
    });
    const j = (await res.json()) as { ok?: boolean; error?: string; ts?: string };
    const ok = j.ok ?? false;
    await logSlackMessage({
      ts: new Date().toISOString(),
      direction: 'out',
      slack_user_id: userId,
      recipient_name: member?.name,
      channel,
      text,
      ok,
      intent: 'manual-send',
      route: '/api/slack/send',
      reason: ok ? undefined : (j.error ?? 'postMessage-failed'),
      captured_at: new Date().toISOString()
    });
    if (!ok) return json({ ok: false, error: j.error ?? 'postMessage-failed' }, 502);
    return json({ ok: true, ts: j.ts });
  } catch (err) {
    const msg = (err as Error).message;
    await logSlackMessage({
      ts: new Date().toISOString(),
      direction: 'out',
      slack_user_id: userId,
      recipient_name: member?.name,
      channel,
      text,
      ok: false,
      intent: 'manual-send',
      route: '/api/slack/send',
      reason: msg,
      captured_at: new Date().toISOString()
    });
    return json({ ok: false, error: msg }, 502);
  }
}

function json(data: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}
