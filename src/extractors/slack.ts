// Slack extractor.
// Reads new messages from selected channels and emits typed events:
//   slack.mention             — message containing <@U...> mentions
//   slack.question_unanswered — thread root with `?`/`？` and no reply > 12h
//   slack.channel_activity    — per-channel daily volume summary
//
// Cursor: per-channel last_ts (Slack epoch with fraction), stored in
// slack.config.json's channel_last_ts. We persist updates back through
// writeConfig so the existing /api/slack/sync UI stays consistent.

import { join } from 'node:path';
import { appendEvents, readSyncState, writeSyncState } from '../lib/events';
import { resolveOrUnknown } from '../lib/identity';
import {
  getToken,
  readConfig,
  writeConfig,
  fetchChannelMessages,
  listUsers,
  reconcileSlackChannels,
  type SlackMessage,
  type SlackUser
} from '../lib/slack';
import { writeSlackTranscript } from '../lib/slack-transcript';
import { PATHS } from '../lib/paths';
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
  transcriptFilesWritten: number;
  errors: Array<{ channel?: string; error: string }>;
}

export async function syncSlack(): Promise<SlackSyncSummary> {
  const summary: SlackSyncSummary = {
    channels: 0,
    newMessages: 0,
    eventsEmitted: 0,
    transcriptFilesWritten: 0,
    errors: []
  };
  const token = await getToken();
  const cfg = await readConfig();
  if (!token || !cfg) {
    summary.errors.push({ error: 'slack not connected' });
    return summary;
  }
  // Reconcile stored channel snapshots against live Slack BEFORE iterating:
  // refresh renamed channels (stale name leaks into emitted event refs) and
  // drop archived/deleted ones (else we keep polling a dead channel). Keys on
  // stable ch.id; transient failures keep the entry. Re-read config after so we
  // iterate the reconciled list.
  try {
    const { renamed, removed } = await reconcileSlackChannels(token);
    for (const r of renamed) console.warn(`[slack] channel renamed: ${r.from} → ${r.to}`);
    for (const r of removed) console.warn(`[slack] channel archived/gone, untracked: ${r.name}`);
    if (renamed.length > 0 || removed.length > 0) {
      const fresh = await readConfig();
      if (fresh) cfg.selected_channels = fresh.selected_channels;
    }
  } catch (err) {
    summary.errors.push({ error: `channel reconcile failed: ${(err as Error).message}` });
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

  // Resolve Slack user IDs → display names for the transcript writer. Best
  // effort: missing map just means raw `Uxxx` ids show up in .txt.
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
    /* fall through with empty map */
  }
  const slackDir = join(PATHS.context, 'slack');

  for (const ch of channels) {
    try {
      const sinceTs = channelLastTs[ch.id];
      const sinceUnix = sinceTs ? Math.floor(Number(sinceTs)) : undefined;
      const messages = await fetchChannelMessages(token, ch.id, sinceUnix, 200);
      let newest = sinceTs ?? '0';
      const fresh: SlackMessage[] = [];
      const channelEmits: NewEvent[] = [];
      for (const m of messages) {
        if (sinceTs && Number(m.ts) <= Number(sinceTs)) continue;
        summary.newMessages++;
        fresh.push(m);
        const emitted = await transformMessage(m, ch);
        channelEmits.push(...emitted);
        if (Number(m.ts) > Number(newest)) newest = m.ts;
      }
      let transcriptOk = true;
      if (fresh.length > 0) {
        try {
          const written = await writeSlackTranscript({
            channel: ch,
            messages: fresh,
            userMap,
            slackDir
          });
          summary.transcriptFilesWritten += written.files.length;
        } catch (err) {
          transcriptOk = false;
          summary.errors.push({
            channel: ch.name,
            error: `transcript write: ${(err as Error).message}`
          });
        }
      }
      // Atomic commit per channel: cursor advance + event emit happen together,
      // or neither. Otherwise a transcript-write failure would either leave the
      // cursor behind (next tick re-emits duplicate events into events.jsonl)
      // or advance the cursor (messages drop out of Slack's history window,
      // leaving the .txt permanently incomplete). Gate both on `transcriptOk`.
      if (transcriptOk) {
        toEmit.push(...channelEmits);
        if (newest !== (sinceTs ?? '0')) channelLastTs[ch.id] = newest;
        // Daily activity summary (cheap rolling counter — one event per sync
        // per channel).
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
