// Token-based Slack integration. No OAuth dance — user pastes a Bot Token
// (xoxb-...) from a manually-installed Slack App. We persist it locally
// (encrypted via Node crypto + a key derived from the existing project secret).
// Calls Slack Web API directly; no SDK needed for the read-only ops we use.

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import crypto from 'node:crypto';
import { PATHS } from './paths';
import { atomicWriteJSON } from '../_lib/file-io';

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

async function slackCall<T = Record<string, unknown>>(
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
export async function postDM(token: string, name: string, text: string): Promise<boolean> {
  const userId = await resolveUserId(token, name);
  if (!userId) {
    console.warn(`[slack] no slack user matches name=${name}`);
    return false;
  }
  const channel = await openConversation(token, userId);
  if (!channel) return false;
  try {
    const r = (await slackCall<PostMessageResult>('chat.postMessage', token, {
      channel,
      text
    })) as PostMessageResult;
    return r.ok ?? true;
  } catch (err) {
    console.warn(`[slack] postDM ${name} failed:`, (err as Error).message);
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
