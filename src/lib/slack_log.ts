// Append-only message log for bot Slack DMs (outbound + inbound).
//
// One JSONL line per send / receive. Operator-facing — not production-grade.
// Rotate manually if the file gets unwieldy. Lives under private/ which is
// git-ignored.
//
// Wiring: every place that calls chat.postMessage (src/lib/slack.ts :: postDM,
// src/services/slack_collection.ts :: postDMById, src/services/leader_push.ts
// :: postDMByUserId) writes a record here on both success and failure. Inbound
// DMs are logged from src/services/slack_collection.ts :: handleInboundDM with
// the resolved disposition.
//
// `text` is kept intact (no truncation) — see spec.

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PATHS } from './paths';

export const SLACK_LOG_FILE = join(PATHS.root, 'slack_messages.jsonl');

export type SlackLogDirection = 'out' | 'in';
export type SlackLogIntent =
  | 'archive-reminder'
  | 'feedback-ask'
  | 'feedback-ack'
  | 'github-login'
  | 'github-confirm'
  | 'anomaly-push'
  | 'identity-prompt'
  | 'manual-send'
  | 'other';
export type SlackLogHandledAs =
  | 'github-login'
  | 'feedback-capture'
  | 'silent'
  | 'paused';

export interface SlackLogRecord {
  ts: string;                    // ISO of the actual send/receive moment
  direction: SlackLogDirection;
  slack_user_id?: string;
  recipient_name?: string;
  channel?: string;
  text: string;
  ok?: boolean;                  // outbound: did chat.postMessage succeed
  intent?: SlackLogIntent;       // outbound: classify the send
  route?: string;                // function/site that fired it
  reason?: string;               // optional failure / skip reason
  handled_as?: SlackLogHandledAs;// inbound: how we routed the DM
  captured_at: string;           // ISO at the moment of logging
}

export async function logSlackMessage(rec: SlackLogRecord): Promise<void> {
  try {
    await mkdir(PATHS.root, { recursive: true }).catch(() => {});
    const line = JSON.stringify(rec) + '\n';
    await appendFile(SLACK_LOG_FILE, line, 'utf8');
  } catch (err) {
    // Logging must NEVER throw out of the caller. Failure here is annoying,
    // not fatal — the bot still sent/received the message.
    console.warn('[slack_log] write failed:', (err as Error).message);
  }
}

// Tail the most recent `limit` records by ACTUAL ts, newest first. The log
// is append-only but writes don't arrive in ts order (the Slack-history
// backfill appends one channel at a time, with each channel's messages in
// their own chronological order — so the file is interleaved, not globally
// sorted). Read the whole file (small enough), parse, sort by ts desc, slice.
export async function tailSlackLog(limit: number = 200): Promise<SlackLogRecord[]> {
  let raw: string;
  try {
    raw = await readFile(SLACK_LOG_FILE, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const lines = raw.split('\n').filter((l) => l.length > 0);
  const out: SlackLogRecord[] = [];
  for (const ln of lines) {
    try {
      out.push(JSON.parse(ln) as SlackLogRecord);
    } catch {
      // Skip malformed lines silently.
    }
  }
  out.sort((a, b) => (b.ts ?? '').localeCompare(a.ts ?? ''));
  return out.slice(0, limit);
}
