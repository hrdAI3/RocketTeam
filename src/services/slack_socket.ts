// Slack Socket Mode client — inbound DM channel without a public webhook.
//
// Why Socket Mode: the team server runs on a LAN IP (192.168.22.48) that
// Slack's servers can't reach, so the HTTP Events API is out. Socket Mode has
// the bot dial OUT to Slack over a WebSocket, so no inbound port / public URL
// is needed.
//
// Requires an app-level token (xapp-...) with `connections:write`, provided
// via env `SLACK_APP_TOKEN`. Generate it in the Slack app dashboard under
// Basic Information → App-Level Tokens.
//
// Lifecycle: `apps.connections.open` returns a short-lived wss URL; we connect,
// ACK every events_api envelope within 3s, and reconnect on close/disconnect
// with backoff. A global guard prevents duplicate sockets across dev HMR.

import { handleInboundDM } from './slack_collection';

declare global {
  // eslint-disable-next-line no-var
  var __slackSocketStarted: boolean | undefined;
  // eslint-disable-next-line no-var
  var __slackSocket: WebSocket | undefined;
}

const APP_TOKEN = process.env.SLACK_APP_TOKEN;

interface ConnOpenResp {
  ok: boolean;
  url?: string;
  error?: string;
}

async function openConnection(): Promise<string | null> {
  if (!APP_TOKEN) return null;
  const res = await fetch('https://slack.com/api/apps.connections.open', {
    method: 'POST',
    headers: { Authorization: `Bearer ${APP_TOKEN}` }
  });
  const j = (await res.json()) as ConnOpenResp;
  if (!j.ok || !j.url) {
    console.warn('[slack-socket] apps.connections.open failed:', j.error ?? 'unknown');
    return null;
  }
  return j.url;
}

interface SocketEnvelope {
  type: string;
  envelope_id?: string;
  payload?: {
    event?: {
      type?: string;
      channel_type?: string;
      user?: string;
      text?: string;
      bot_id?: string;
      subtype?: string;
    };
  };
}

function wireSocket(url: string, reconnect: () => void): void {
  const ws = new WebSocket(url);
  globalThis.__slackSocket = ws;
  let alive = true;

  ws.addEventListener('message', (ev: MessageEvent) => {
    let env: SocketEnvelope;
    try {
      env = JSON.parse(String(ev.data)) as SocketEnvelope;
    } catch {
      return;
    }
    if (env.type === 'hello') {
      console.log('[slack-socket] connected');
      return;
    }
    if (env.type === 'disconnect') {
      // Slack asks us to reconnect (token refresh / server cycling).
      alive = false;
      try { ws.close(); } catch {}
      return;
    }
    if (env.type === 'events_api' && env.envelope_id) {
      // ACK within 3s or Slack retries.
      ws.send(JSON.stringify({ envelope_id: env.envelope_id }));
      const e = env.payload?.event;
      if (
        e &&
        e.type === 'message' &&
        e.channel_type === 'im' &&
        !e.bot_id && // ignore our own / other bots
        !e.subtype && // ignore edits/joins/etc
        typeof e.user === 'string' &&
        typeof e.text === 'string'
      ) {
        void handleInboundDM(e.user, e.text).catch((err) =>
          console.warn('[slack-socket] handleInboundDM failed:', (err as Error).message)
        );
      }
    }
  });

  ws.addEventListener('close', () => {
    if (alive) console.warn('[slack-socket] closed; reconnecting');
    reconnect();
  });
  ws.addEventListener('error', () => {
    // 'close' fires after 'error'; reconnect handled there.
  });
}

async function connectLoop(): Promise<void> {
  let backoff = 1000;
  const attempt = async (): Promise<void> => {
    const url = await openConnection().catch(() => null);
    if (!url) {
      const wait = Math.min(backoff, 30_000);
      setTimeout(() => void attempt(), wait);
      backoff = Math.min(backoff * 2, 30_000);
      return;
    }
    backoff = 1000; // reset on success
    wireSocket(url, () => {
      setTimeout(() => void attempt(), 1500);
    });
  };
  await attempt();
}

export function startSlackSocket(): void {
  if (globalThis.__slackSocketStarted) return;
  if (!APP_TOKEN) {
    console.log('[slack-socket] SLACK_APP_TOKEN not set — inbound DM disabled');
    return;
  }
  globalThis.__slackSocketStarted = true;
  void connectLoop();
  console.log('[slack-socket] starting Socket Mode client');
}
