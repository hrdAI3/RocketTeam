// Token-based Slack integration. No OAuth dance — user pastes a Bot Token
// (xoxb-...) from a manually-installed Slack App. We persist it locally
// (encrypted via Node crypto + a key derived from the existing project secret).
// Calls Slack Web API directly; no SDK needed for the read-only ops we use.

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import crypto from 'node:crypto';
import { PATHS } from './paths';
import { atomicWriteJSON } from '../_lib/file-io';
import { logSlackMessage, type SlackLogIntent } from './slack_log';
import { isBotPaused } from './bot_pause';

const CONFIG_FILE = join(PATHS.configs, 'slack.config.json');
// Cache decrypted token in module scope. Re-read from disk on cold start.
let cachedToken: string | null = null;

export interface SlackConfig {
  bot_token_encrypted: string;
  team_id?: string;
  team_name?: string;
  bot_user_id?: string;
  connected_at: string;
  last_sync_at?: string;
  selected_channels?: Array<{ id: string; name: string }>;
  auto_sync_enabled?: boolean;
  auto_sync_interval_min?: number; // 5-60
  // Per-channel last seen ts (Slack epoch with fraction). Used for incremental sync.
  channel_last_ts?: Record<string, string>;
}

function getKey(): Buffer {
  // M0 hardening: vault key MUST be explicit. The previous fallback chain
  // (MINIMAX_API_KEY ?? 'rocket-team-vault') let an LLM-key leak double as a
  // token-vault leak, and the literal default is plaintext in source control.
  const seed = process.env.SLACK_VAULT_KEY;
  if (!seed) {
    throw new Error(
      'SLACK_VAULT_KEY environment variable is required for Slack token encryption. ' +
        'Set it to a long random string and keep it stable across deployments.'
    );
  }
  return crypto.createHash('sha256').update(seed).digest();
}

export function encrypt(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join('.');
}

export function decrypt(payload: string): string {
  const [ivB, tagB, encB] = payload.split('.');
  if (!ivB || !tagB || !encB) throw new Error('malformed encrypted token');
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(ivB, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB, 'base64'));
  const dec = Buffer.concat([decipher.update(Buffer.from(encB, 'base64')), decipher.final()]);
  return dec.toString('utf8');
}

export async function readConfig(): Promise<SlackConfig | null> {
  try {
    const raw = await fs.readFile(CONFIG_FILE, 'utf8');
    return JSON.parse(raw) as SlackConfig;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function writeConfig(cfg: SlackConfig): Promise<void> {
  await atomicWriteJSON(CONFIG_FILE, cfg);
  cachedToken = null; // invalidate
}

export async function deleteConfig(): Promise<void> {
  try {
    await fs.unlink(CONFIG_FILE);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  cachedToken = null;
}

export async function getToken(): Promise<string | null> {
  if (cachedToken) return cachedToken;
  const cfg = await readConfig();
  if (!cfg) return null;
  try {
    cachedToken = decrypt(cfg.bot_token_encrypted);
    return cachedToken;
  } catch {
    return null;
  }
}

interface SlackResponse<T> {
  ok: boolean;
  error?: string;
  warning?: string;
  response_metadata?: { next_cursor?: string };
  data?: T;
}

export async function slackCall<T = Record<string, unknown>>(
  endpoint: string,
  token: string,
  params: Record<string, string | number | undefined> = {}
): Promise<T> {
  const url = new URL(`https://slack.com/api/${endpoint}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }
  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    }
  });
  if (!res.ok) throw new Error(`Slack ${endpoint} HTTP ${res.status}`);
  const json = (await res.json()) as SlackResponse<T> & T;
  if (!json.ok) throw new Error(`Slack ${endpoint} error: ${json.error ?? 'unknown'}`);
  return json as T;
}

export interface AuthTestResult {
  ok: boolean;
  url: string;
  team: string;
  user: string;
  team_id: string;
  user_id: string;
  bot_id?: string;
}

export async function authTest(token: string): Promise<AuthTestResult> {
  return slackCall<AuthTestResult>('auth.test', token);
}

export interface SlackChannel {
  id: string;
  name: string;
  is_private: boolean;
  is_archived: boolean;
  num_members?: number;
  topic?: { value: string };
}

export async function listChannels(token: string): Promise<SlackChannel[]> {
  // Public + private channels the bot is member of.
  const out: SlackChannel[] = [];
  let cursor: string | undefined;
  do {
    const resp = await slackCall<{ channels: SlackChannel[]; response_metadata?: { next_cursor?: string } }>(
      'conversations.list',
      token,
      {
        types: 'public_channel,private_channel',
        exclude_archived: 'true',
        limit: 200,
        cursor
      }
    );
    out.push(...resp.channels);
    cursor = resp.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return out;
}

// Live single-channel lookup. Used by reconcileSlackChannels to detect
// renames/archives. Throws on Slack errors (incl. channel_not_found) following
// the slackCall pattern so callers can branch on the error string.
export async function getChannelInfo(token: string, channelId: string): Promise<SlackChannel> {
  const resp = await slackCall<{ channel: SlackChannel }>('conversations.info', token, {
    channel: channelId
  });
  return resp.channel;
}

// Re-fetch live state for every tracked channel and reconcile the stored
// snapshot. Mirrors github.ts::reconcileTrackedRepoOwners: stored {id,name}
// snapshots go stale when channels are RENAMED (the old name leaks into emitted
// events) or ARCHIVED/deleted (sync keeps polling a dead channel). We key on the
// stable ch.id for ingestion, but the name must be refreshed and dead channels
// dropped. Defensive: only a definitive archive / channel_not_found drops an
// entry; any transient error (network, rate-limit, 5xx) KEEPS it.
export async function reconcileSlackChannels(
  token: string
): Promise<{ renamed: Array<{ id: string; from: string; to: string }>; removed: Array<{ id: string; name: string }> }> {
  const cfg = await readConfig();
  if (!cfg?.selected_channels?.length) return { renamed: [], removed: [] };
  const renamed: Array<{ id: string; from: string; to: string }> = [];
  const removed: Array<{ id: string; name: string }> = [];
  const next: Array<{ id: string; name: string }> = [];
  for (const c of cfg.selected_channels) {
    let name = c.name;
    try {
      const live = await getChannelInfo(token, c.id);
      if (live.is_archived === true) {
        removed.push({ id: c.id, name: c.name });
        continue; // archived → drop from tracked set
      }
      if (live.name && live.name !== c.name) {
        name = live.name;
        renamed.push({ id: c.id, from: c.name, to: name });
      }
    } catch (err) {
      // channel_not_found = deleted or bot removed → drop; it can't be
      // synced/attributed anymore. Any OTHER error (network, rate-limit, 5xx,
      // missing scope) → KEEP the entry; a transient failure must not drop a
      // real tracked channel.
      const msg = (err as Error).message;
      if (/channel_not_found/.test(msg)) {
        removed.push({ id: c.id, name: c.name });
        continue;
      }
      /* transient — keep stale entry */
    }
    next.push({ id: c.id, name });
  }
  if (renamed.length > 0 || removed.length > 0) {
    cfg.selected_channels = next;
    await writeConfig(cfg);
  }
  return { renamed, removed };
}

export interface SlackMessage {
  ts: string; // unix epoch with fraction
  user?: string;
  text: string;
  type: string;
  thread_ts?: string;
  reply_count?: number;
}

// Best-effort auto-join. Requires channels:join scope. Returns true if joined
// or already a member; false if scope missing / private channel / fatal error.
export async function tryJoinChannel(token: string, channelId: string): Promise<boolean> {
  try {
    await slackCall('conversations.join', token, { channel: channelId });
    return true;
  } catch (err) {
    const msg = (err as Error).message;
    // Already in channel = success in the spirit of "can read now"
    if (msg.includes('already_in_channel')) return true;
    return false;
  }
}

export async function fetchChannelMessages(
  token: string,
  channelId: string,
  sinceUnix?: number,
  limit: number = 200
): Promise<SlackMessage[]> {
  const out: SlackMessage[] = [];
  let cursor: string | undefined;
  let fetched = 0;
  do {
    const resp = await slackCall<{
      messages: SlackMessage[];
      has_more?: boolean;
      response_metadata?: { next_cursor?: string };
    }>('conversations.history', token, {
      channel: channelId,
      limit: 100,
      oldest: sinceUnix ? String(sinceUnix) : undefined,
      cursor
    });
    out.push(...resp.messages);
    fetched += resp.messages.length;
    cursor = resp.response_metadata?.next_cursor || undefined;
    if (fetched >= limit) break;
  } while (cursor);
  return out.slice(0, limit);
}

export interface SlackUser {
  id: string;
  name: string;
  real_name?: string;
  profile?: { display_name?: string; real_name?: string };
}

// Resolve a Chinese display name to a Slack user_id by scanning user list.
// Cached for the lifetime of the process so repeated lookups are cheap.
let userMapCache: { token: string; map: Record<string, string> } | null = null;
export async function resolveUserId(token: string, name: string): Promise<string | null> {
  if (!userMapCache || userMapCache.token !== token) {
    const users = await listUsers(token);
    const map: Record<string, string> = {};
    for (const u of users) {
      const candidates = [
        u.profile?.display_name,
        u.profile?.real_name,
        u.real_name,
        u.name
      ].filter((x): x is string => typeof x === 'string' && x.length > 0);
      for (const c of candidates) {
        map[c] = u.id;
        // Also index 2-char given name (Chinese 3-char surname-given pattern)
        if (c.length === 3) map[c.slice(1)] = u.id;
      }
    }
    userMapCache = { token, map };
  }
  return userMapCache.map[name] ?? null;
}

interface PostMessageResult { ok: boolean; channel?: string; ts?: string; error?: string }

export async function openConversation(token: string, userId: string): Promise<string | null> {
  try {
    const r = await slackCall<{ channel?: { id: string } }>('conversations.open', token, { users: userId });
    return r.channel?.id ?? null;
  } catch {
    return null;
  }
}

// Post DM to a member by name. Resolves Slack user_id, opens IM channel,
// posts message. Returns true on success.
//
// `opts` is purely for logging metadata + (in the future) bypass overrides.
// Backwards-compatible: every existing call site keeps working without
// touching it. `intent` defaults to 'other'; `route` defaults to 'slack.postDM'.
export interface PostDMOptions {
  intent?: SlackLogIntent;
  route?: string;
  // Bypass the global bot-paused kill-switch. Reserved for explicit operator
  // actions (e.g. POST /api/slack/send). Default false: automated sends honor
  // the pause flag.
  bypassPause?: boolean;
}

export async function postDM(
  token: string,
  name: string,
  text: string,
  opts: PostDMOptions = {}
): Promise<boolean> {
  const intent: SlackLogIntent = opts.intent ?? 'other';
  const route = opts.route ?? 'slack.postDM';

  // Pause gate — record the suppressed intent and bail BEFORE we open a DM
  // channel so we don't even touch Slack.
  if (!opts.bypassPause && (await isBotPaused())) {
    await logSlackMessage({
      ts: new Date().toISOString(),
      direction: 'out',
      recipient_name: name,
      text,
      ok: false,
      intent,
      route,
      reason: 'paused',
      captured_at: new Date().toISOString()
    });
    return false;
  }

  // Resolve the recipient's Slack user_id. Roster FIRST: the roster stores a
  // confirmed slack.user_id per member, which is authoritative. The old path
  // only did resolveUserId() (a Slack display-name search) — and Chinese
  // display names routinely differ from the roster name (赵艺霖's Slack
  // display ≠ "赵艺霖"), so the lookup failed, the send "failed", and any
  // dedup-on-success caller re-fired every tick. Fall back to display-name
  // search only when the roster has no id (e.g. a name not in the roster).
  // Lazy import to avoid a static lib→service-ish cycle.
  let userId: string | null = null;
  try {
    const { lookupByName } = await import('./team_roster');
    const m = await lookupByName(name);
    userId = m?.slack.user_id ?? null;
  } catch {
    userId = null;
  }
  if (!userId) userId = await resolveUserId(token, name);
  if (!userId) {
    console.warn(`[slack] no slack user matches name=${name}`);
    await logSlackMessage({
      ts: new Date().toISOString(),
      direction: 'out',
      recipient_name: name,
      text,
      ok: false,
      intent,
      route,
      reason: 'no-user-id',
      captured_at: new Date().toISOString()
    });
    return false;
  }
  const channel = await openConversation(token, userId);
  if (!channel) {
    await logSlackMessage({
      ts: new Date().toISOString(),
      direction: 'out',
      slack_user_id: userId,
      recipient_name: name,
      text,
      ok: false,
      intent,
      route,
      reason: 'open-conversation-failed',
      captured_at: new Date().toISOString()
    });
    return false;
  }
  try {
    const r = (await slackCall<PostMessageResult>('chat.postMessage', token, {
      channel,
      text
    })) as PostMessageResult;
    const ok = r.ok ?? true;
    await logSlackMessage({
      ts: new Date().toISOString(),
      direction: 'out',
      slack_user_id: userId,
      recipient_name: name,
      channel,
      text,
      ok,
      intent,
      route,
      reason: ok ? undefined : (r.error ?? 'postMessage-failed'),
      captured_at: new Date().toISOString()
    });
    return ok;
  } catch (err) {
    const msg = (err as Error).message;
    console.warn(`[slack] postDM ${name} failed:`, msg);
    await logSlackMessage({
      ts: new Date().toISOString(),
      direction: 'out',
      slack_user_id: userId,
      recipient_name: name,
      channel,
      text,
      ok: false,
      intent,
      route,
      reason: msg,
      captured_at: new Date().toISOString()
    });
    return false;
  }
}

export async function listUsers(token: string): Promise<SlackUser[]> {
  const out: SlackUser[] = [];
  let cursor: string | undefined;
  do {
    const resp = await slackCall<{ members: SlackUser[]; response_metadata?: { next_cursor?: string } }>(
      'users.list',
      token,
      { limit: 200, cursor }
    );
    out.push(...resp.members);
    cursor = resp.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return out;
}
