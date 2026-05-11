import { NextRequest } from 'next/server';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import {
  getToken,
  readConfig,
  writeConfig,
  fetchChannelMessages,
  listUsers,
  tryJoinChannel,
  type SlackUser,
  type SlackMessage
} from '@/lib/slack';
import { PATHS } from '@/lib/paths';
import { appendTimelineEvent } from '@/lib/timeline';

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
  await fs.mkdir(slackDir, { recursive: true });

  const cfg = await readConfig();
  const lastTsMap = cfg?.channel_last_ts ?? {};
  const newLastTsMap: Record<string, string> = { ...lastTsMap };

  const today = new Date().toISOString().slice(0, 10);
  const written: Array<{ channel: string; file: string; messages: number }> = [];
  const errors: Array<{ channel: string; error: string }> = [];

  for (const ch of selected) {
    try {
      await tryJoinChannel(token, ch.id);
      // Use stored last_ts if available + not force_full; else fallback days_back.
      const cursorTs = body.force_full ? undefined : lastTsMap[ch.id];
      const sinceUnix = cursorTs ? parseFloat(cursorTs) : fallbackSince;
      const msgs = await fetchChannelMessages(token, ch.id, sinceUnix, 500);

      // Slack inclusive ts boundary — drop messages with ts === cursor (already synced).
      const fresh = msgs.filter((m) => !cursorTs || parseFloat(m.ts) > parseFloat(cursorTs));
      if (fresh.length === 0) {
        continue;
      }
      const ordered = [...fresh].reverse(); // oldest first

      // Group ordered messages by date so each day gets its own file.
      const byDate: Record<string, SlackMessage[]> = {};
      for (const m of ordered) {
        const date = new Date(parseFloat(m.ts) * 1000).toISOString().slice(0, 10);
        (byDate[date] ??= []).push(m);
      }

      for (const [date, dayMsgs] of Object.entries(byDate)) {
        const fileName = `slack-${ch.name}-${date}.txt`;
        const filePath = join(slackDir, fileName);
        // Read existing body if any. Build header only if file is new.
        let existing = '';
        try {
          existing = await fs.readFile(filePath, 'utf8');
        } catch {
          existing = `# Slack #${ch.name}\n频道: ${ch.name} · 日期: ${date}\n`;
        }
        const newLines: string[] = [];
        for (const m of dayMsgs) {
          if (!m.text || !m.text.trim()) continue;
          const speaker = m.user ? userMap[m.user] ?? m.user : 'unknown';
          const ts = new Date(parseFloat(m.ts) * 1000).toISOString();
          const cleaned = m.text.replace(/<@([A-Z0-9]+)>/g, (_, id) => `@${userMap[id] ?? id}`);
          // Use Slack ts as the dedup key, embedded in the line.
          newLines.push(`[${ts.slice(0, 19).replace('T', ' ')} #${m.ts}] ${speaker}: ${cleaned}`);
        }
        if (newLines.length === 0) continue;
        // Dedup: skip lines whose `#${m.ts}` already appears in file.
        const filtered = newLines.filter((line) => {
          const m = line.match(/#(\d+\.\d+)\]/);
          if (!m) return true;
          return !existing.includes(`#${m[1]}]`);
        });
        if (filtered.length === 0) continue;
        const updated = existing.trimEnd() + '\n' + filtered.join('\n') + '\n';
        await fs.writeFile(filePath, updated, 'utf8');
        written.push({ channel: ch.name, file: fileName, messages: filtered.length });
      }

      // Update cursor to newest ts seen.
      const newest = ordered[ordered.length - 1];
      if (newest?.ts) newLastTsMap[ch.id] = newest.ts;
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
