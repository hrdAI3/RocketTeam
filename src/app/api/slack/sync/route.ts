import { NextRequest } from 'next/server';
import { join } from 'node:path';
import {
  getToken,
  readConfig,
  writeConfig,
  fetchChannelMessages,
  listUsers,
  tryJoinChannel,
  type SlackUser
} from '@/lib/slack';
import { PATHS } from '@/lib/paths';
import { appendTimelineEvent } from '@/lib/timeline';
import { writeSlackTranscript } from '@/lib/slack-transcript';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// POST /api/slack/sync
// Body: { channels: [{id, name}], days_back?: number, force_full?: boolean }
// Incremental by default — uses cfg.channel_last_ts[channelId] as cursor.
// Files are stored as slack-{channel}-{YYYY-MM-DD}.txt and APPENDED on auto-sync
// to avoid duplicates. force_full ignores cursor and rewrites.
export async function POST(req: NextRequest): Promise<Response> {
  const token = await getToken();
  if (!token) return json({ error: 'not connected' }, 400);

  let body: { channels?: Array<{ id: string; name: string }>; days_back?: number; force_full?: boolean } = {};
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid JSON' }, 400);
  }
  const selected = body.channels ?? [];
  if (selected.length === 0) return json({ error: 'no channels selected' }, 400);

  const daysBack = body.days_back ?? 30;
  const fallbackSince = Math.floor(Date.now() / 1000) - daysBack * 86400;

  let userMap: Record<string, string> = {};
  try {
    const users = await listUsers(token);
    userMap = Object.fromEntries(
      users.map((u: SlackUser) => [
        u.id,
        u.profile?.display_name || u.real_name || u.profile?.real_name || u.name || u.id
      ])
    );
  } catch {
    /* fall through with empty userMap */
  }

  const slackDir = join(PATHS.context, 'slack');

  const cfg = await readConfig();
  const lastTsMap = cfg?.channel_last_ts ?? {};
  const newLastTsMap: Record<string, string> = { ...lastTsMap };

  const today = new Date().toISOString().slice(0, 10);
  const written: Array<{ channel: string; file: string; messages: number }> = [];
  const errors: Array<{ channel: string; error: string }> = [];

  for (const ch of selected) {
    try {
      await tryJoinChannel(token, ch.id);
      const cursorTs = body.force_full ? undefined : lastTsMap[ch.id];
      const sinceUnix = cursorTs ? parseFloat(cursorTs) : fallbackSince;
      const msgs = await fetchChannelMessages(token, ch.id, sinceUnix, 2000);

      const fresh = msgs.filter((m) => !cursorTs || parseFloat(m.ts) > parseFloat(cursorTs));
      if (fresh.length === 0) continue;

      const result = await writeSlackTranscript({
        channel: ch,
        messages: fresh,
        userMap,
        slackDir
      });
      for (const w of result.files) {
        written.push({ channel: ch.name, file: w.file, messages: w.messages });
      }

      // Advance cursor to newest ts seen (regardless of write outcome — they
      // were observed and a future invocation should not refetch them).
      const newestTs = fresh.reduce(
        (acc, m) => (parseFloat(m.ts) > parseFloat(acc) ? m.ts : acc),
        fresh[0].ts
      );
      newLastTsMap[ch.id] = newestTs;
    } catch (err) {
      const raw = (err as Error).message;
      let friendly = raw;
      if (raw.includes('not_in_channel')) {
        friendly = `Bot 不在 #${ch.name} 中。在 Slack 里运行 /invite @rocket-team 邀请它进去，或在 Slack App 配置中加 channels:join 权限后重新安装。`;
      } else if (raw.includes('missing_scope')) {
        friendly = `权限不足读取 #${ch.name}。检查 OAuth scopes：channels:history / groups:history。`;
      } else if (raw.includes('channel_not_found')) {
        friendly = `频道 #${ch.name} 不存在或 Bot 看不到。`;
      } else if (raw.includes('rate_limited')) {
        friendly = `Slack 限流，稍后重试 #${ch.name}。`;
      }
      errors.push({ channel: ch.name, error: friendly });
    }
  }

  if (cfg) {
    cfg.last_sync_at = new Date().toISOString();
    cfg.selected_channels = selected;
    cfg.channel_last_ts = newLastTsMap;
    await writeConfig(cfg);
  }

  await appendTimelineEvent({
    ts: new Date().toISOString(),
    type: 'bootstrap',
    summary: `Slack 同步完成 · ${written.length} 个文件更新 · 共 ${written.reduce((a, w) => a + w.messages, 0)} 条新消息`,
    detail: { written, errors, today }
  });

  return json({ ok: true, written, errors });
}

function json(data: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}
