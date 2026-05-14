// What the leader did with each anomaly — append-only log.
//
// Three actions exist: `resolve` (we're handling it), `dismiss` (not worth my
// time), `snooze` (not now). The log doubles as product feedback — what kinds
// of alerts get acknowledged vs ignored is the signal we need to iterate the
// anomaly engine.
//
// For engine anomalies (persisted in anomalies store), we ALSO call the
// matching `recordResolve` / `recordDismiss` / `recordSnooze` so the store's
// own state is correct. For live-derived concerns (synthetic `live:` ids that
// aren't in the store), this log is the only suppression mechanism — the
// monitor loop and `getRosterView` filter against it.

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { PATHS } from './paths';

const ACTIONS_FILE = join(PATHS.root, 'leader_actions.jsonl');

export type LeaderActionKind = 'resolve' | 'dismiss' | 'snooze';

export interface LeaderActionEntry {
  ts: string; // ISO when the leader clicked
  anomalyId: string;
  rule: string; // copy for analytics (so a deleted anomaly's rule is still on the log)
  subjectRef: string;
  action: LeaderActionKind;
  snoozedUntil?: string; // ISO, only for snooze
  note?: string;
}

export async function recordLeaderAction(entry: LeaderActionEntry): Promise<void> {
  const line = JSON.stringify(entry) + '\n';
  await fs.mkdir(PATHS.root, { recursive: true }).catch(() => undefined);
  await fs.appendFile(ACTIONS_FILE, line, 'utf8');
}

export async function readLeaderActions(): Promise<LeaderActionEntry[]> {
  let raw: string;
  try {
    raw = await fs.readFile(ACTIONS_FILE, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: LeaderActionEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as LeaderActionEntry);
    } catch {
      /* skip malformed lines */
    }
  }
  return out;
}

// The "live" state for each anomaly id: the most recent action (if any) wins.
// Snooze is honored until `snoozedUntil`; resolve/dismiss are sticky.
export interface SuppressionState {
  action: LeaderActionKind;
  snoozedUntil?: string;
}

export async function buildSuppressionMap(): Promise<Map<string, SuppressionState>> {
  const log = await readLeaderActions();
  // Most-recent action per id wins.
  log.sort((a, b) => a.ts.localeCompare(b.ts));
  const out = new Map<string, SuppressionState>();
  const now = new Date().toISOString();
  for (const e of log) {
    if (e.action === 'snooze' && e.snoozedUntil && e.snoozedUntil <= now) {
      // expired snooze — clear suppression unless a later action replaces it
      out.delete(e.anomalyId);
      continue;
    }
    out.set(e.anomalyId, { action: e.action, snoozedUntil: e.snoozedUntil });
  }
  // Final pass: drop expired snoozes (in case the most recent entry is one).
  for (const [id, s] of out) {
    if (s.action === 'snooze' && s.snoozedUntil && s.snoozedUntil <= now) {
      out.delete(id);
    }
  }
  return out;
}

export function isSuppressed(state: SuppressionState | undefined, nowIso: string): boolean {
  if (!state) return false;
  if (state.action === 'resolve' || state.action === 'dismiss') return true;
  if (state.action === 'snooze' && state.snoozedUntil && state.snoozedUntil > nowIso) return true;
  return false;
}
