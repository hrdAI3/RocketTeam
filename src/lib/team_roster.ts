// Team roster — single source of truth for every member's three accounts:
// Slack (DM recipient), CC collector identifiers (events.jsonl actor
// resolution), GitHub (login + public email for the @renlab.ai / @nb-ai.com
// internal check).
//
// File: `private/team_roster.json`, mode 0600.
//
// Reads stay fast: in-process cache invalidated only on write. Writes go
// through `writeRoster` which atomically rewrites the file. `refreshRoster`
// (run by monitor_loop on a 30 min cadence) hits Slack `users.info`, scans
// the last 7d of events.jsonl, and calls GH `/users/{login}` to refresh
// per-account health; it then rewrites the roster plus the legacy
// `identity.json` derived file (compat layer for callers not yet migrated).

import { promises as fs } from 'fs';
import path from 'path';

const PRIVATE_DIR = path.join(process.cwd(), 'private');
const ROSTER_PATH = path.join(PRIVATE_DIR, 'team_roster.json');

export type MemberStatus = 'active' | 'inactive' | 'left';

export interface CcIdentifier {
  kind: 'email' | 'machine' | 'display_name';
  value: string;
}

export interface SlackAccount {
  user_id: string | null;
  display_name: string | null;
  ok: boolean;
  checked_at: string | null;
}

export interface CcAccount {
  identifiers: CcIdentifier[];
  last_seen_at: string | null;
  ok: boolean;
}

export interface GithubAccount {
  login: string | null;
  public_email: string | null;
  public_email_suffix_ok: boolean;
  display_name: string | null;       // GH profile `name`, e.g. "hrdai-renlab"
  display_name_ok: boolean;          // company rule: contains "renlab"
  owns_tracked_repo: boolean;        // login owns ≥1 repo in selected_repos
  ok: boolean;
  issues: GithubIssue[];
  checked_at: string | null;
}

export type GithubIssue =
  | 'github-login-not-set'
  | 'public-email-not-set'
  | 'public-email-wrong-domain'
  | 'display-name-not-renlab';

// Compliance decision (policy A — "by repo"):
//   - login required (needed to map repos → people)
//   - corporate public email AND renlab display name required ONLY IF the
//     person owns a tracked repo. The goal is "every tracked repo is managed
//     by a corp-email, renlab-branded account" — not "everyone is".
// A non-owner (never had a tracked repo, or transferred all repos to
// anzy-renlab-ai) needs only a login; personal email + non-renlab nickname
// are fine. If they later acquire a tracked repo, both requirements kick back
// in on the next daily check.
export function githubCompliant(
  g: Pick<GithubAccount, 'login' | 'public_email_suffix_ok' | 'display_name_ok'>,
  ownsTrackedRepo: boolean
): boolean {
  if (!g.login) return false;
  if (ownsTrackedRepo) {
    if (!g.public_email_suffix_ok) return false;
    if (!g.display_name_ok) return false;
  }
  return true;
}

export interface Member {
  name: string;
  status: MemberStatus;
  joined_at: string | null;
  left_at: string | null;
  slack: SlackAccount;
  cc: CcAccount;
  github: GithubAccount;
}

export interface Roster {
  version: 2;
  leader: string;
  members: Member[];
}

let cache: Roster | null = null;

const EMPTY_ROSTER: Roster = {
  version: 2,
  leader: '戴昊然',
  members: []
};

export async function readRoster(): Promise<Roster> {
  if (cache) return cache;
  try {
    const raw = await fs.readFile(ROSTER_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Roster;
    if (!parsed.version || !Array.isArray(parsed.members)) {
      cache = EMPTY_ROSTER;
    } else {
      cache = parsed;
    }
  } catch {
    cache = EMPTY_ROSTER;
  }
  return cache;
}

export async function writeRoster(r: Roster): Promise<void> {
  await fs.mkdir(PRIVATE_DIR, { recursive: true });
  const tmp = ROSTER_PATH + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(r, null, 2), { mode: 0o600 });
  await fs.rename(tmp, ROSTER_PATH);
  cache = r;
}

export function clearRosterCache(): void {
  cache = null;
}

export async function lookupBySlack(userId: string): Promise<Member | null> {
  const r = await readRoster();
  return r.members.find((m) => m.slack.user_id === userId) ?? null;
}

export async function lookupByGithub(login: string): Promise<Member | null> {
  if (!login) return null;
  const r = await readRoster();
  const lc = login.toLowerCase();
  return r.members.find((m) => m.github.login?.toLowerCase() === lc) ?? null;
}

export async function lookupByCcIdentifier(value: string): Promise<Member | null> {
  if (!value) return null;
  const r = await readRoster();
  const lc = value.toLowerCase();
  return (
    r.members.find((m) =>
      m.cc.identifiers.some((id) => id.value.toLowerCase() === lc)
    ) ?? null
  );
}

export async function lookupByName(name: string): Promise<Member | null> {
  if (!name) return null;
  const r = await readRoster();
  return r.members.find((m) => m.name === name) ?? null;
}

export function emailSuffixOk(email: string | null): boolean {
  if (!email) return false;
  const lc = email.toLowerCase();
  return lc.endsWith('@renlab.ai') || lc.endsWith('@nb-ai.com');
}

// Company rule: the name GitHub actually DISPLAYS must contain "renlab"
// (case-insensitive). GitHub shows the profile `name` if set, otherwise falls
// back to the `login`. So we check `name || login` — matching what a human
// sees on the profile page. (A login like "sunrf-renlab-ai" with an empty
// name still reads as renlab-affiliated on GitHub, so it passes.)
export function displayNameOk(name: string | null, login: string | null): boolean {
  const effective = (name && name.trim()) || login || '';
  return /renlab/i.test(effective);
}

// Derived view: emit the legacy identity.json 3-map shape from the roster.
// Lets non-migrated callers (workboard, leader_push, etc.) keep working
// during the rollout. Should be invoked by `refreshRoster` and any explicit
// roster mutation that touches one of these three account fields.
export interface LegacyIdentity {
  email: Record<string, string>;
  github: Record<string, string>;
  slack: Record<string, string>;
}

// Actor-string → canonical name index for resolving events.jsonl `actor`
// fields at READ time. Events ingested before a member's identifier was
// added to the roster carry a raw `unknown:email:<id>` (or raw id / login)
// actor baked in. This index folds every known variant back to the real
// name so slices don't miss work. Includes `left` members — their historical
// CC work still needs attribution. Keys lowercased for case-insensitive
// match (machine identifiers like `Dwl@DESKTOP-3HJ28SG` are mixed-case).
export async function buildActorIndex(): Promise<Map<string, string>> {
  const r = await readRoster();
  const idx = new Map<string, string>();
  const put = (key: string | null | undefined, name: string): void => {
    if (!key) return;
    const k = key.toLowerCase();
    if (!idx.has(k)) idx.set(k, name);
  };
  for (const m of r.members) {
    put(m.name, m.name);
    for (const id of m.cc.identifiers) {
      put(id.value, m.name);
      put(`unknown:email:${id.value}`, m.name);
    }
    if (m.github.login) {
      put(m.github.login, m.name);
      put(`unknown:github:${m.github.login}`, m.name);
    }
    if (m.slack.user_id) {
      put(m.slack.user_id, m.name);
      put(`unknown:slack:${m.slack.user_id}`, m.name);
    }
  }
  return idx;
}

export async function deriveLegacyIdentity(): Promise<LegacyIdentity> {
  const r = await readRoster();
  const out: LegacyIdentity = { email: {}, github: {}, slack: {} };
  for (const m of r.members) {
    if (m.status === 'left') continue;
    for (const id of m.cc.identifiers) {
      if (id.kind === 'email' || id.kind === 'machine') out.email[id.value] = m.name;
    }
    if (m.github.login) out.github[m.github.login] = m.name;
    if (m.slack.user_id) out.slack[m.slack.user_id] = m.name;
  }
  return out;
}
