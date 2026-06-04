// One-shot backfill: pull the bot's full Slack DM history from the Slack API
// and append to `private/slack_messages.jsonl`. The on-disk log only started
// populating when the messages page shipped (a few hours ago) — everything
// older lives only in Slack. This script reconstructs the missing history.
//
// Run: bun tools/backfill_slack_history.ts [--days 30] [--dry-run]
//
// Dedup is by (ts, slack_user_id, direction). Re-runnable: a second run on the
// same day produces zero new lines (already-imported messages are skipped).

import { readFile, appendFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { PATHS } from '../src/lib/paths';
import { getToken, fetchChannelMessages, slackCall } from '../src/lib/slack';
import { logSlackMessage, type SlackLogRecord, type SlackLogIntent } from '../src/lib/slack_log';
import { join } from 'node:path';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const daysIdx = args.indexOf('--days');
const lookbackDays = daysIdx >= 0 ? Number(args[daysIdx + 1]) : 30;
const LOG_FILE = join(PATHS.root, 'slack_messages.jsonl');

interface SlackMsg {
  ts: string;          // unix seconds "1748395712.000400"
  user?: string;       // sender slack user id
  bot_id?: string;
  text?: string;
  subtype?: string;
}
interface IMChannel { id: string; user: string; }

// Heuristic intent classification from message text (outbound only — inbound
// stays 'other'). Catches the four well-known bot voices so the messages page
// filter tabs work for the backfilled rows.
function inferIntent(text: string): SlackLogIntent {
  if (/Reminder.*?(没归到|GitHub repo|tracked repo)|🟠 3rd reminder|🔴 4th reminder|2nd reminder|Archive/i.test(text)) return 'archive-reminder';
  if (/GitHub 用户名|github\.com\/ 后面|Registered ✓ GitHub|GitHub login/i.test(text)) return 'github-login';
  if (/这条归纳|这个项目名 \/ 工作清单|反馈|feedback/i.test(text)) return 'feedback-ask';
  if (/🚨|⚠️ Heads up|🔴.*?blocked/i.test(text)) return 'anomaly-push';
  if (/Repo .* still under a personal account|个人账号下/i.test(text)) return 'identity-prompt';
  return 'other';
}

async function existingDedupKeys(): Promise<Set<string>> {
  const keys = new Set<string>();
  if (!existsSync(LOG_FILE)) return keys;
  const raw = await readFile(LOG_FILE, 'utf8');
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as SlackLogRecord;
      keys.add(`${r.ts}|${r.slack_user_id ?? ''}|${r.direction}`);
    } catch {}
  }
  return keys;
}

interface AuthTest { ok: boolean; user_id?: string; team_id?: string; bot_id?: string; }

async function main(): Promise<void> {
  const token = await getToken();
  if (!token) { console.error('no slack token'); process.exit(1); }

  const auth = await slackCall<AuthTest>('auth.test', token);
  if (!auth.ok || !auth.user_id) { console.error('auth.test failed'); process.exit(1); }
  const botUserId = auth.user_id;
  console.log('bot user_id:', botUserId);

  // List all IM channels the bot is in. users.conversations with types=im.
  const ims: IMChannel[] = [];
  let cursor: string | undefined;
  do {
    const r = await slackCall<{ channels: IMChannel[]; response_metadata?: { next_cursor?: string } }>(
      'users.conversations',
      token,
      { types: 'im', limit: 200, cursor }
    );
    ims.push(...(r.channels ?? []));
    cursor = r.response_metadata?.next_cursor || undefined;
  } while (cursor);
  console.log('DM channels found:', ims.length);

  const sinceUnix = Math.floor((Date.now() - lookbackDays * 86400_000) / 1000);
  const dedup = await existingDedupKeys();
  console.log('existing log entries (dedup keys):', dedup.size);

  let appended = 0;
  let skipped = 0;
  for (const im of ims) {
    const peer = im.user; // the human on the other side
    let msgs: SlackMsg[];
    try {
      msgs = (await fetchChannelMessages(token, im.id, sinceUnix, 500)) as unknown as SlackMsg[];
    } catch (err) {
      console.warn('  history fetch failed for', im.id, '-', (err as Error).message);
      continue;
    }
    for (const m of msgs) {
      if (!m.ts) continue;
      if (m.subtype && m.subtype !== '' && m.subtype !== 'bot_message') continue; // skip join/leave/edits
      const direction: 'out' | 'in' = m.user === botUserId || m.bot_id ? 'out' : 'in';
      const text = m.text ?? '';
      if (!text) continue;
      const isoTs = new Date(Number(m.ts) * 1000).toISOString();
      const key = `${isoTs}|${peer}|${direction}`;
      if (dedup.has(key)) { skipped++; continue; }
      const record: SlackLogRecord = {
        ts: isoTs,
        direction,
        slack_user_id: peer,
        channel: im.id,
        text,
        ok: direction === 'out' ? true : undefined,
        intent: direction === 'out' ? inferIntent(text) : undefined,
        route: 'backfill_slack_history',
        handled_as: direction === 'in' ? 'backfill' : undefined,
        captured_at: new Date().toISOString()
      };
      if (!dryRun) {
        await mkdir(PATHS.root, { recursive: true }).catch(() => {});
        await appendFile(LOG_FILE, JSON.stringify(record) + '\n', 'utf8');
        // Also log via the canonical logger so any consumer caching the file
        // (next dev memo) is invalidated next read.
        void logSlackMessage; // noop reference
      }
      dedup.add(key);
      appended++;
    }
    console.log(`  ${peer} (${im.id}): ${msgs.length} messages, +${msgs.length - skipped} new`);
  }
  console.log(`done. appended=${appended} skipped=${skipped} dryRun=${dryRun}`);
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
