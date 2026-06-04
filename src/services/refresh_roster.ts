// Periodic roster health refresh — see team_roster.ts module doc.
//
// Each pass:
//   1. Slack — `users.info` per member (or batched users.list scan) updates
//      `display_name` and flips `ok` to true if the user is present + active.
//   2. CC    — walks the last 7d of events.jsonl and looks for the member's
//      name as actor, plus any cc.identifier value as actor; sets
//      `last_seen_at` to the newest hit.
//   3. GitHub — `/users/{login}.email` fetch; flips ok/issues based on
//      whether the email's suffix is in the allowlist.
//
// After the in-memory roster is updated, write team_roster.json AND derive
// `identity.json` (compat for non-migrated callers).

import { promises as fs } from 'fs';
import path from 'path';
import {
  readRoster,
  writeRoster,
  clearRosterCache,
  deriveLegacyIdentity,
  emailSuffixOk,
  displayNameOk,
  githubCompliant,
  type Member,
  type GithubIssue
} from '../lib/team_roster';
import { getToken as getSlackToken, listUsers as listSlackUsers } from '../lib/slack';
import { getToken as getGithubToken, fetchUserProfile, reconcileTrackedRepoOwners } from '../lib/github';
import { trackedRepoOwners } from './repo_ownership';

const PRIVATE_DIR = path.join(process.cwd(), 'private');
const EVENTS_PATH = path.join(PRIVATE_DIR, 'events.jsonl');
const IDENTITY_PATH = path.join(PRIVATE_DIR, 'identity.json');
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

interface RawEvent {
  ts?: string;
  actor?: string;
  evidence?: { fields?: Record<string, unknown> };
}

async function refreshSlack(members: Member[]): Promise<void> {
  const token = await getSlackToken();
  if (!token) return;
  const users = await listSlackUsers(token).catch(() => []);
  if (users.length === 0) return;
  const byId = new Map<string, (typeof users)[number]>();
  for (const u of users) byId.set(u.id, u);
  const nowIso = new Date().toISOString();
  for (const m of members) {
    if (!m.slack.user_id) {
      m.slack.ok = false;
      m.slack.checked_at = nowIso;
      continue;
    }
    const u = byId.get(m.slack.user_id);
    if (!u || (u as { deleted?: boolean }).deleted) {
      m.slack.ok = false;
    } else {
      m.slack.ok = true;
      m.slack.display_name =
        (u.profile?.display_name ?? u.profile?.real_name ?? u.name ?? null) || null;
    }
    m.slack.checked_at = nowIso;
  }
}

async function refreshCcFromEvents(members: Member[]): Promise<void> {
  let raw: string;
  try {
    raw = await fs.readFile(EVENTS_PATH, 'utf8');
  } catch {
    return;
  }
  const cutoffMs = Date.now() - SEVEN_DAYS_MS;
  // Latest-seen-at per actor string. Walks line-by-line to avoid loading the
  // full file structure when only the tail matters.
  const lastSeenByActor = new Map<string, number>();
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let e: RawEvent;
    try {
      e = JSON.parse(line) as RawEvent;
    } catch {
      continue;
    }
    const tsMs = e.ts ? Date.parse(e.ts) : NaN;
    if (!Number.isFinite(tsMs) || tsMs < cutoffMs) continue;
    if (typeof e.actor === 'string' && e.actor.length > 0) {
      const cur = lastSeenByActor.get(e.actor);
      if (cur === undefined || tsMs > cur) lastSeenByActor.set(e.actor, tsMs);
    }
  }
  for (const m of members) {
    let newest: number | null = null;
    const consider = (key: string): void => {
      const t = lastSeenByActor.get(key);
      if (typeof t === 'number' && (newest === null || t > newest)) newest = t;
    };
    consider(m.name);
    for (const id of m.cc.identifiers) {
      consider(id.value);
      consider(`unknown:email:${id.value}`);
    }
    m.cc.ok = newest !== null;
    m.cc.last_seen_at = newest !== null ? new Date(newest).toISOString() : null;
  }
}

async function refreshGithub(members: Member[]): Promise<void> {
  const token = await getGithubToken();
  // Self-heal: follow GitHub transfers so a repo moved to anzy-renlab-ai
  // stops being flagged as "on a personal account" and the now-repo-less
  // member auto-passes Policy A. Must run BEFORE trackedRepoOwners() so the
  // owner set reflects live ownership, not a frozen config string.
  if (token) {
    try {
      const { moves, removed } = await reconcileTrackedRepoOwners(token);
      for (const mv of moves) console.warn(`[roster] repo transfer detected: ${mv.from} → ${mv.to}`);
      for (const r of removed) console.warn(`[roster] tracked repo gone (404/451), untracked: ${r}`);
    } catch (err) {
      console.warn('[roster] repo-owner reconcile failed:', (err as Error).message);
    }
  }
  const owners = await trackedRepoOwners();
  const nowIso = new Date().toISOString();
  for (const m of members) {
    const issues: GithubIssue[] = [];
    if (!m.github.login) {
      issues.push('github-login-not-set');
      m.github.public_email = null;
      m.github.public_email_suffix_ok = false;
      m.github.display_name = null;
      m.github.display_name_ok = false;
      m.github.owns_tracked_repo = false;
      m.github.ok = false;
      m.github.issues = issues;
      m.github.checked_at = nowIso;
      continue;
    }
    const ownsRepo = owners.has(m.github.login.toLowerCase());
    m.github.owns_tracked_repo = ownsRepo;
    let email: string | null = null;
    let name: string | null = null;
    if (token) {
      const prof = await fetchUserProfile(token, m.github.login).catch(() => ({
        email: null,
        name: null
      }));
      email = prof.email;
      name = prof.name;
    }
    m.github.public_email = email;
    const suffixOk = emailSuffixOk(email);
    m.github.public_email_suffix_ok = suffixOk;
    // Email issue only matters for repo owners (policy A).
    if (ownsRepo) {
      if (!email) issues.push('public-email-not-set');
      else if (!suffixOk) issues.push('public-email-wrong-domain');
    }

    m.github.display_name = name;
    const nameOk = displayNameOk(name, m.github.login);
    m.github.display_name_ok = nameOk;
    // Nickname rule only matters for repo owners (policy A).
    if (ownsRepo && !nameOk) issues.push('display-name-not-renlab');

    m.github.ok = githubCompliant(m.github, ownsRepo);
    m.github.issues = issues;
    m.github.checked_at = nowIso;
  }
}

async function writeDerivedIdentity(): Promise<void> {
  const id = await deriveLegacyIdentity();
  const tmp = IDENTITY_PATH + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(id, null, 2), { mode: 0o600 });
  await fs.rename(tmp, IDENTITY_PATH);
}

export async function refreshRoster(): Promise<void> {
  // Always operate on the latest on-disk roster. Without this, a long-running
  // process (dev server / monitor loop) would refresh its stale in-memory
  // copy and write it back, clobbering edits made by other processes (CLI
  // patches, the Socket Mode reply handler in a different worker, etc).
  clearRosterCache();
  const roster = await readRoster();
  await Promise.all([
    refreshSlack(roster.members),
    refreshCcFromEvents(roster.members),
    refreshGithub(roster.members)
  ]);
  await writeRoster(roster);
  await writeDerivedIdentity();
}
