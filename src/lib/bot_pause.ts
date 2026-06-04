// Runtime kill-switch for the Slack bot's automated DMs and auto-replies.
//
// When paused:
//   - outbound automated sends (postDM, postDMById, postDMByUserId) skip the
//     real Slack call. They still LOG the would-have-sent record with
//     ok=false + reason='paused' so the operator can audit what was suppressed.
//   - inbound DM auto-replies (GH-login parse, feedback capture) skip their
//     reply. The inbound DM itself is still logged (handled_as='paused') so
//     the leader can answer it manually via /api/slack/send.
//   - manual sends through /api/slack/send BYPASS this flag. That's the whole
//     point: leader pauses the bot to take over a thread by hand.
//
// State lives at `private/sync_state/bot_paused.json`. Lightweight on purpose
// — no DB, no migration, single file the operator can `rm` to nuke.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { PATHS } from './paths';

const PAUSE_FILE = join(PATHS.syncState, 'bot_paused.json');

export interface BotPauseState {
  paused: boolean;
  paused_at?: string;   // ISO when last toggled into paused state
  paused_by?: string;   // username that flipped it (best-effort)
}

const DEFAULT_STATE: BotPauseState = { paused: false };

// Cache the last-read state for a short window. The hot path is `isBotPaused`
// called on every outbound message; reading the file every time is needless
// syscall churn. Cache is invalidated on writes from this process; the worst
// case for a foreign writer is a CACHE_TTL_MS window of staleness, which is
// fine for an operator-facing toggle (you flipped it, you wait < 1s).
const CACHE_TTL_MS = 1000;
let cache: { at: number; state: BotPauseState } | null = null;

async function readState(): Promise<BotPauseState> {
  try {
    const raw = await readFile(PAUSE_FILE, 'utf8');
    const parsed = JSON.parse(raw) as Partial<BotPauseState>;
    return {
      paused: parsed.paused === true,
      paused_at: typeof parsed.paused_at === 'string' ? parsed.paused_at : undefined,
      paused_by: typeof parsed.paused_by === 'string' ? parsed.paused_by : undefined
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ...DEFAULT_STATE };
    // Malformed file → fail-safe to "not paused" rather than block all DMs on
    // a parse error. Bot continuing is less bad than bot silent-failing.
    console.warn('[bot_pause] read failed; defaulting to not-paused:', (err as Error).message);
    return { ...DEFAULT_STATE };
  }
}

export async function getBotPauseState(): Promise<BotPauseState> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.state;
  const state = await readState();
  cache = { at: Date.now(), state };
  return state;
}

export async function isBotPaused(): Promise<boolean> {
  const s = await getBotPauseState();
  return s.paused;
}

export async function setBotPaused(paused: boolean, by: string): Promise<BotPauseState> {
  const next: BotPauseState = paused
    ? { paused: true, paused_at: new Date().toISOString(), paused_by: by }
    : { paused: false, paused_at: new Date().toISOString(), paused_by: by };
  await mkdir(dirname(PAUSE_FILE), { recursive: true }).catch(() => {});
  await writeFile(PAUSE_FILE, JSON.stringify(next, null, 2) + '\n', 'utf8');
  cache = { at: Date.now(), state: next };
  return next;
}
