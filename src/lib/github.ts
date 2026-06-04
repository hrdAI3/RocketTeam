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
  // `responsible` is the team member name (canonical, from identity.json) the
  // leader holds accountable for this repo. Optional during migration; the UI
  // prompts the leader to fill it in when missing. Per the leader's direction
  // a tracked repo IS a project, and every project has exactly one owner.
  selected_repos?: Array<{ owner: string; name: string; responsible?: string }>;
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

// Reconcile selected_repos owners against GitHub's live state. When a repo is
// TRANSFERRED on GitHub (e.g. Upp-Ljl/Pace → anzy-renlab-ai/Pace), the API
// follows the redirect and reports the new owner; our config keeps the stale
// owner forever otherwise, which makes the external-owner-transfer rule lie
// ("please transfer" for a repo already transferred). Run this before
// computing owns_tracked_repo so ownership truth comes from GitHub, not a
// frozen config string. Returns the list of moves applied.
export async function reconcileTrackedRepoOwners(
  token: string
): Promise<{ moves: Array<{ from: string; to: string }>; removed: string[] }> {
  const cfg = await readConfig();
  if (!cfg?.selected_repos?.length) return { moves: [], removed: [] };
  const moves: Array<{ from: string; to: string }> = [];
  const removed: string[] = [];
  const seen = new Set<string>();
  const next: Array<{ owner: string; name: string }> = [];
  for (const r of cfg.selected_repos) {
    let owner = r.owner;
    let name = r.name;
    try {
      const j = await ghCall<{ owner: { login: string }; name: string }>(
        `/repos/${r.owner}/${r.name}`,
        token
      );
      if (j?.owner?.login && j.name) {
        owner = j.owner.login;
        name = j.name;
        if (owner !== r.owner || name !== r.name) {
          moves.push({ from: `${r.owner}/${r.name}`, to: `${owner}/${name}` });
        }
      }
    } catch (err) {
      // 404 = repo deleted or made private → drop from tracked (it can't be
      // managed/attributed anymore, and keeping it seeds phantom projects +
      // false compliance flags). 451 = blocked. Any OTHER error (network,
      // rate-limit, 5xx) → KEEP the entry; a transient failure must not drop
      // a real tracked repo.
      const msg = (err as Error).message;
      if (/HTTP 4(04|51)\b/.test(msg)) {
        removed.push(`${r.owner}/${r.name}`);
        continue; // skip pushing into next → removed from tracked set
      }
      /* transient — keep stale entry */
    }
    const key = `${owner}/${name}`.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      next.push({ owner, name });
    }
  }
  if (moves.length > 0 || removed.length > 0) {
    cfg.selected_repos = next;
    await writeConfig(cfg);
  }
  return { moves, removed };
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
  fork: boolean;
  archived: boolean;
  description: string | null;
  default_branch: string;
  pushed_at: string;
  open_issues_count: number;
}

// One-shot repo metadata. Used by project_seed to surface the repo's real
// description (the GH-set "About" blurb) into the registry entry — gives the
// attribution LLM something semantic to match against beyond just the slug.
export async function fetchRepoMeta(
  token: string,
  owner: string,
  name: string
): Promise<GithubRepo | null> {
  try {
    return await ghCall<GithubRepo>(`/repos/${owner}/${name}`, token);
  } catch {
    return null;
  }
}

export async function listRepos(token: string, scope: 'user' | 'org', orgName?: string): Promise<GithubRepo[]> {
  if (scope === 'org') {
    return paginateRepos(`/orgs/${orgName}/repos`, token, { per_page: 100, sort: 'pushed' });
  }
  // scope === 'user'. The old call hit `/user/repos` with no `affiliation`,
  // which GitHub defaults to `owner,collaborator,organization_member` — but in
  // practice it under-reports outside-collaborator repos (e.g. it returned
  // article-to-social-media but NOT the equally-public ZeroProgramer that the
  // token can read fine). So we explicitly enumerate each affiliation and
  // dedupe by id. `affiliation=collaborator` is what surfaces repos owned by
  // OTHER accounts where this token's user is a collaborator — the ones the
  // selectable list was missing.
  //
  // NOTE on private repos: a fine-grained PAT can't read private repos owned
  // by a different personal account even as collaborator (hrdAI3/WhatIf →
  // 404). Surfacing those needs a classic PAT with the `repo` scope. This
  // function returns whatever the token can see; the UI can't conjure repos
  // the token has no permission for.
  const byId = new Map<number, GithubRepo>();
  for (const affiliation of ['owner', 'collaborator', 'organization_member']) {
    const batch = await paginateRepos('/user/repos', token, {
      per_page: 100,
      sort: 'pushed',
      affiliation
    });
    for (const r of batch) byId.set(r.id, r);
  }
  return [...byId.values()];
}

async function paginateRepos(
  path: string,
  token: string,
  baseParams: Record<string, string | number>
): Promise<GithubRepo[]> {
  const all: GithubRepo[] = [];
  let page = 1;
  while (true) {
    const batch = await ghCall<GithubRepo[]>(path, token, { ...baseParams, page });
    all.push(...batch);
    if (batch.length < 100) break;
    page++;
    if (page > 10) break; // safety cap (1000 repos)
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

// Repo collaborators (push-or-better permission). Used to auto-resolve
// "负责人" by intersecting with identity.json email map. Anzy-renlab-ai is
// always present as a collaborator (it's the leader's audit token) and is
// filtered upstream.
export interface GithubCollaborator {
  login: string;
  id: number;
  email?: string | null;
  type: 'User' | 'Organization';
  permissions?: { admin?: boolean; push?: boolean; pull?: boolean };
}

export async function listCollaborators(
  token: string,
  owner: string,
  name: string
): Promise<GithubCollaborator[]> {
  try {
    return await ghCall<GithubCollaborator[]>(
      `/repos/${owner}/${name}/collaborators`,
      token,
      { per_page: 100, affiliation: 'all' }
    );
  } catch {
    // Some repos don't expose collaborators API to non-admin tokens
    // (private fork, etc.). Caller falls back to commit-author email.
    return [];
  }
}

// Recent commits — used to harvest author emails when collaborators API
// returns no usable mapping (login alone doesn't carry email; commit.author
// in the API response does).
export interface GithubCommitAuthor {
  name?: string;
  email?: string;
  date?: string;
  login?: string;
}
export interface GithubCommit {
  sha: string;
  commit: {
    author?: GithubCommitAuthor;
    committer?: GithubCommitAuthor;
    message?: string;
  };
  author: { login: string } | null;
  committer: { login: string } | null;
}

export async function fetchRecentCommits(
  token: string,
  owner: string,
  name: string,
  perPage: number = 30
): Promise<GithubCommit[]> {
  try {
    return await ghCall<GithubCommit[]>(`/repos/${owner}/${name}/commits`, token, {
      per_page: perPage
    });
  } catch {
    return [];
  }
}

// Map a GitHub login → public email when the user has set it publicly.
// Most users don't, so this is best-effort.
export async function fetchUserEmail(token: string, login: string): Promise<string | null> {
  try {
    const u = await ghCall<{ email?: string | null }>(`/users/${login}`, token);
    return u.email ?? null;
  } catch {
    return null;
  }
}

// Full public profile snapshot — email + display name. Single API call so the
// roster refresh doesn't hit /users/{login} twice. `name` is the profile
// display name (e.g. "hrdai-renlab"), distinct from the immutable login.
export async function fetchUserProfile(
  token: string,
  login: string
): Promise<{ email: string | null; name: string | null }> {
  try {
    const u = await ghCall<{ email?: string | null; name?: string | null }>(
      `/users/${login}`,
      token
    );
    return { email: u.email ?? null, name: u.name ?? null };
  } catch {
    return { email: null, name: null };
  }
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
