// Slack extractor.
// Reads new messages from selected channels and emits typed events:
//   slack.mention             — message containing <@U...> mentions
//   slack.question_unanswered — thread root with `?`/`？` and no reply > 12h
//   slack.channel_activity    — per-channel daily volume summary
//
// Cursor: per-channel last_ts (Slack epoch with fraction), stored in
// slack.config.json's channel_last_ts. We persist updates back through
// writeConfig so the existing /api/slack/sync UI stays consistent.

import { appendEvents, readSyncState, writeSyncState } from '../lib/events';
import { resolveOrUnknown } from '../lib/identity';
import {
  getToken,
  readConfig,
  writeConfig,
  fetchChannelMessages,
  type SlackMessage
} from '../lib/slack';
import type { NewEvent } from '../lib/events';

const SYNC_STATE_KEY = 'slack';
const UNANSWERED_HOURS = 12;

interface SyncState {
  last_run_at?: string;
  last_question_scan_at?: string;
}

export interface SlackSyncSummary {
  channels: number;
  newMessages: number;
  eventsEmitted: number;
  errors: Array<{ channel?: string; error: string }>;
}

export async function syncSlack(): Promise<SlackSyncSummary> {
  const summary: SlackSyncSummary = {
    channels: 0,
    newMessages: 0,
    eventsEmitted: 0,
    errors: []
  };
  const token = await getToken();
  const cfg = await readConfig();
  if (!token || !cfg) {
    summary.errors.push({ error: 'slack not connected' });
    return summary;
  }
  const channels = cfg.selected_channels ?? [];
  if (channels.length === 0) {
    summary.errors.push({ error: 'no selected channels' });
    return summary;
  }
  summary.channels = channels.length;
  const state = (await readSyncState<SyncState>(SYNC_STATE_KEY)) ?? {};
  const channelLastTs = cfg.channel_last_ts ?? {};
  const toEmit: NewEvent[] = [];

  for (const ch of channels) {
    try {
      const sinceTs = channelLastTs[ch.id];
      const sinceUnix = sinceTs ? Math.floor(Number(sinceTs)) : undefined;
      const messages = await fetchChannelMessages(token, ch.id, sinceUnix, 200);
      let newest = sinceTs ?? '0';
      for (const m of messages) {
        if (sinceTs && Number(m.ts) <= Number(sinceTs)) continue;
        summary.newMessages++;
        const emitted = await transformMessage(m, ch);
        toEmit.push(...emitted);
        if (Number(m.ts) > Number(newest)) newest = m.ts;
      }
      if (newest !== (sinceTs ?? '0')) channelLastTs[ch.id] = newest;
      // Daily activity summary (cheap rolling counter — one event per sync per channel)
      if (messages.length > 0) {
        toEmit.push({
          source: 'slack',
          type: 'slack.channel_activity',
          subject: { kind: 'channel', ref: ch.name },
          evidence: {
            fields: {
              channel_id: ch.id,
              messages_synced: messages.length,
              window_since_ts: sinceTs ?? null
            }
          }
        });
      }
    } catch (err) {
      summary.errors.push({ channel: ch.name, error: (err as Error).message });
    }
  }

  if (toEmit.length > 0) await appendEvents(toEmit);
  summary.eventsEmitted = toEmit.length;

  // Persist cursor back into slack config so the existing sync UI sees it.
  await writeConfig({ ...cfg, channel_last_ts: channelLastTs, last_sync_at: new Date().toISOString() });
  state.last_run_at = new Date().toISOString();
  await writeSyncState(SYNC_STATE_KEY, state);

  return summary;
}

const MENTION_RE = /<@([A-Z0-9]+)>/g;

async function transformMessage(
  m: SlackMessage,
  ch: { id: string; name: string }
): Promise<NewEvent[]> {
  if (m.type !== 'message') return [];
  const out: NewEvent[] = [];
  const tsIso = new Date(Math.floor(Number(m.ts) * 1000)).toISOString();
  const authorRes = m.user
    ? await resolveOrUnknown('slack', m.user)
    : { name: 'unknown:slack:none', unresolved: true };

  // Mentions — one event per distinct user mentioned.
  const mentions = new Set<string>();
  let match: RegExpExecArray | null;
  MENTION_RE.lastIndex = 0;
  while ((match = MENTION_RE.exec(m.text ?? '')) !== null) {
    mentions.add(match[1]);
  }
  for (const slackUserId of mentions) {
    const mentionedRes = await resolveOrUnknown('slack', slackUserId);
    out.push({
      ts: tsIso,
      source: 'slack',
      type: 'slack.mention',
      subject: { kind: 'agent', ref: mentionedRes.name },
      actor: authorRes.name,
      evidence: {
        quote: (m.text ?? '').slice(0, 280),
        fields: {
          channel: ch.name,
          channel_id: ch.id,
          slack_ts: m.ts,
          thread_ts: m.thread_ts
        }
      },
      raw_ref: `slack://channel/${ch.id}/${m.ts}`
    });
  }

  // Unanswered question detection: thread root, ends with ? or ？, no replies yet.
  const looksLikeQuestion = /[?？]/.test(m.text ?? '');
  const isThreadRoot = !m.thread_ts || m.thread_ts === m.ts;
  if (looksLikeQuestion && isThreadRoot) {
    const ageHours = (Date.now() - Number(m.ts) * 1000) / 3_600_000;
    const noReplies = (m.reply_count ?? 0) === 0;
    if (ageHours >= UNANSWERED_HOURS && noReplies) {
      out.push({
        ts: tsIso,
        source: 'slack',
        type: 'slack.question_unanswered',
        subject: { kind: 'channel', ref: ch.name },
        actor: authorRes.name,
        evidence: {
          quote: (m.text ?? '').slice(0, 280),
          fields: {
            channel_id: ch.id,
            age_hours: Math.round(ageHours * 10) / 10,
            slack_ts: m.ts
          }
        },
        raw_ref: `slack://channel/${ch.id}/${m.ts}`
      });
    }
  }
  return out;
}
