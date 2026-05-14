// Token-based GitHub integration. Mirrors the Slack approach: user pastes a
// Personal Access Token (PAT, classic or fine-grained) with read scopes for
// the org/user; we encrypt + persist locally; calls api.github.com directly.

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import crypto from 'node:crypto';
import { PATHS } from './paths';
import { atomicWriteJSON } from '../_lib/file-io';

const CONFIG_FILE = join(PATHS.configs, 'github.config.json');
let cachedToken: string | null = null;

export interface GithubConfig {
  pat_encrypted: string;
  org_or_user?: string;
  login?: string;
  connected_at: string;
  last_sync_at?: string;
  selected_repos?: Array<{ owner: string; name: string }>;
  auto_sync_enabled?: boolean;
  auto_sync_interval_min?: number;
}

function vaultKey(): Buffer {
  // M0 hardening: explicit vault key only. Prefer GITHUB_VAULT_KEY (independent
  // from Slack's vault); fall back to SLACK_VAULT_KEY transitionally so existing
  // encrypted configs still decrypt. Hard fail if neither is set — never derive
  // from MINIMAX_API_KEY (would couple LLM-key leak to token-vault leak) and
  // never fall back to a plaintext default.
  const seed = process.env.GITHUB_VAULT_KEY ?? process.env.SLACK_VAULT_KEY;
  if (!seed) {
    throw new Error(
      'GITHUB_VAULT_KEY (or SLACK_VAULT_KEY transitional fallback) environment variable ' +
        'is required for GitHub token encryption. Set it to a long random string and ' +
        'keep it stable across deployments.'
    );
  }
  return crypto.createHash('sha256').update(seed).digest();
}

export function encrypt(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', vaultKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join('.');
}

export function decrypt(payload: string): string {
  const [ivB, tagB, encB] = payload.split('.');
  if (!ivB || !tagB || !encB) throw new Error('malformed encrypted token');
  const decipher = crypto.createDecipheriv('aes-256-gcm', vaultKey(), Buffer.from(ivB, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB, 'base64'));
  const dec = Buffer.concat([decipher.update(Buffer.from(encB, 'base64')), decipher.final()]);
  return dec.toString('utf8');
}

export async function readConfig(): Promise<GithubConfig | null> {
  try {
    const raw = await fs.readFile(CONFIG_FILE, 'utf8');
    return JSON.parse(raw) as GithubConfig;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function writeConfig(cfg: GithubConfig): Promise<void> {
  await atomicWriteJSON(CONFIG_FILE, cfg);
  cachedToken = null;
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
    cachedToken = decrypt(cfg.pat_encrypted);
    return cachedToken;
  } catch {
    return null;
  }
}

export async function ghCall<T = unknown>(endpoint: string, token: string, params?: Record<string, string | number>): Promise<T> {
  const url = new URL(`https://api.github.com${endpoint}`);
  if (params) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    }
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub ${endpoint} HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

export interface GithubUser {
  login: string;
  id: number;
  type: 'User' | 'Organization';
}

export async function authVerify(token: string): Promise<GithubUser> {
  return ghCall<GithubUser>('/user', token);
}

export interface GithubRepo {
  id: number;
  name: string;
  full_name: string;
  owner: { login: string; type: string };
  private: boolean;
  description: string | null;
  default_branch: string;
  pushed_at: string;
  open_issues_count: number;
}

export async function listRepos(token: string, scope: 'user' | 'org', orgName?: string): Promise<GithubRepo[]> {
  const all: GithubRepo[] = [];
  let page = 1;
  while (true) {
    const path = scope === 'user' ? '/user/repos' : `/orgs/${orgName}/repos`;
    const params = { per_page: 100, page, sort: 'pushed' };
    const batch = await ghCall<GithubRepo[]>(path, token, params);
    all.push(...batch);
    if (batch.length < 100) break;
    page++;
    if (page > 10) break; // safety cap
  }
  return all;
}

export interface GithubPullRequest {
  number: number;
  title: string;
  state: string;
  user: { login: string };
  created_at: string;
  closed_at: string | null;
  merged_at: string | null;
  body: string | null;
  html_url: string;
}

export async function fetchRecentPRs(
  token: string,
  owner: string,
  name: string,
  sinceDays: number = 30
): Promise<GithubPullRequest[]> {
  const since = Date.now() - sinceDays * 86400 * 1000;
  const all: GithubPullRequest[] = [];
  let page = 1;
  while (true) {
    const batch = await ghCall<GithubPullRequest[]>(
      `/repos/${owner}/${name}/pulls`,
      token,
      { state: 'all', sort: 'updated', direction: 'desc', per_page: 100, page }
    );
    if (batch.length === 0) break;
    all.push(...batch.filter((p) => new Date(p.created_at).getTime() >= since));
    if (batch.length < 100) break;
    if (new Date(batch[batch.length - 1].created_at).getTime() < since) break;
    page++;
    if (page > 5) break;
  }
  return all;
}
