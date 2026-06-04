// GitHub account compliance engine.
//
// Goal: every team member's GitHub account is fully registered + corporate —
//   1. login known (so we can map repos → people)
//   2. Public email is @renlab.ai or @nb-ai.com (so repo ownership is tied to
//      a corporate identity), OR the repo is transferred to anzy-renlab-ai
//   3. profile display name contains "renlab" (company naming rule)
//
// The engine runs once per working day (weekends/holidays skipped via
// workdays.ts). For each member still missing any field it DMs a reminder
// listing ONLY the missing items. Escalation mirrors the rest of the system:
//   stage 1-3 → the person only
//   stage 4   → the person + leader (cc), then stop
// One working day between stages. State in sync_state/gh_compliance.json.
//
// `login` is collectable: if it's missing we register a pending entry so the
// person's reply is captured by the Socket Mode handler (slack_collection).
// `email` and `nickname` are self-serve GitHub profile settings — verified
// automatically by refreshRoster's API pull, no reply needed.

import { readSyncState, writeSyncState } from '../lib/events';
import { getToken, openConversation } from '../lib/slack';
import { readRoster, clearRosterCache, type Member } from '../lib/team_roster';
import { workingDaysBetween } from '../lib/workdays';
import { readConfig } from '../lib/github';
import { logSlackMessage, type SlackLogIntent } from '../lib/slack_log';
import { isBotPaused } from '../lib/bot_pause';

// All currently-tracked repos owned by this login (case-insensitive). Used so
// the compliance DM names the specific repos that triggered the ask instead
// of saying "you own a tracked team repo" in the abstract.
async function ownedReposFor(login: string): Promise<string[]> {
  if (!login) return [];
  const cfg = await readConfig();
  const lc = login.toLowerCase();
  return (cfg?.selected_repos ?? [])
    .filter((r) => r.owner.toLowerCase() === lc)
    .map((r) => `${r.owner}/${r.name}`);
}

const STATE_KEY = 'gh_compliance';
const COLLECTION_KEY = 'slack_collection';
const LEADER_NAME = process.env.LEADER_NAME ?? '戴昊然';
const STAGE_GAP_WORKDAYS = 1;

interface ComplianceEntry {
  notify_count: number;        // 0..4; 4 = leader cc'd, stop
  last_notified_at: string | null;
}
interface ComplianceState {
  entries?: Record<string, ComplianceEntry>;
  last_run_date?: string; // Beijing YYYY-MM-DD of the last non-forced run
}

function beijingDate(): string {
  return new Date()
    .toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' })
    .slice(0, 10);
}

interface PendingEntry {
  field: 'github.login';
  name: string;
  prompt: string;
  asked_at: string;
}
interface CollectionState {
  pending?: Record<string, PendingEntry>;
}

type MissingField = 'login' | 'email' | 'nickname';

function missingFields(m: Member): MissingField[] {
  const out: MissingField[] = [];
  if (!m.github.login) out.push('login');
  else if (m.github.owns_tracked_repo) {
    // Policy A: corp email + renlab nickname only required for repo owners.
    if (!m.github.public_email_suffix_ok) out.push('email');
    if (!m.github.display_name_ok) out.push('nickname');
  }
  return out;
}

function buildMessage(
  m: Member,
  missing: MissingField[],
  stage: number,
  ownedRepos: string[]
): string {
  // Stage-aware opener so the first line itself signals urgency (older
  // version added a separate "Nth reminder" line that contradicted the
  // friendly "hi" opener).
  const head =
    stage >= 4
      ? '🔴 4th reminder · leader cc\'d. We still need these GitHub bits from you:'
      : stage === 3
        ? '🟠 3rd reminder — please act, or this gets escalated to the leader:'
        : stage === 2
          ? '⚠️ Reminder #2 — still need these GitHub bits:'
          : 'Hi! Rocket Team is registering everyone\'s GitHub. We still need:';
  const lines: string[] = [head];

  // 1) Login is independent of the repo-ownership branch — always ask first
  // if missing, since we can't resolve repos until we know the login.
  if (missing.includes('login')) {
    lines.push('• GitHub username — reply with what comes after `github.com/` (or paste your profile URL).');
  }

  // 2) Email + nickname only matter if this person owns ≥1 tracked repo on a
  // personal account. Present it as a single Option A / Option B choice
  // (rather than two independent line items) so the trade-off is obvious:
  // transfer everything → done; or keep the repos under your name → set
  // email + nickname.
  const needsEmail = missing.includes('email');
  const needsNickname = missing.includes('nickname');
  if ((needsEmail || needsNickname) && ownedRepos.length > 0) {
    lines.push('');
    lines.push(
      `You own ${ownedRepos.length} tracked team ` +
        `repo${ownedRepos.length === 1 ? '' : 's'} under this account:`
    );
    for (const r of ownedRepos.slice(0, 8)) lines.push(`  • ${r}`);
    if (ownedRepos.length > 8) lines.push(`  • …and ${ownedRepos.length - 8} more`);
    lines.push('');
    lines.push('Pick one of the two paths:');
    lines.push('');
    lines.push(
      '*Option A — transfer the repos to `anzy-renlab-ai`* ' +
        '(GitHub → repo Settings → Transfer ownership). Once done, ' +
        'no email or display-name change is needed on your side.'
    );
    lines.push('');
    lines.push('*Option B — keep them under your account.* Then please:');
    if (needsEmail) {
      lines.push(
        '  • Set a company public email: GitHub → Settings → Public profile → Public email → choose your @renlab.ai or @nb-ai.com address.'
      );
    }
    if (needsNickname) {
      const cur = m.github.display_name ? `(currently "${m.github.display_name}")` : '(not set)';
      lines.push(
        `  • Set the display name: GitHub → Settings → Public profile → Name, include "renlab" ${cur}.`
      );
    }
  }

  // 3) Closing line tells them whether we need a reply or it'll auto-confirm.
  const onlyLogin = missing.length === 1 && missing[0] === 'login';
  lines.push('');
  if (onlyLogin) lines.push('Just reply with your username and we\'ll register it.');
  else if (missing.includes('login')) lines.push('Reply with your username; everything else the system auto-confirms ✓.');
  else lines.push('Once fixed the system auto-confirms ✓ — no need to reply.');
  return lines.join('\n');
}

interface LeaderEscalationRow {
  name: string;
  missing: MissingField[];
  repos: string[]; // tracked repos this person owns on a personal account
}

// Leader escalation. The ask is NOT "make them fix their email/nickname" —
// that framing misleads (it sounds mandatory when it isn't). The real ask is
// "these team repos sit on personal accounts; get them transferred to the org
// so we don't lose them on departure." Email/nickname is only the fallback if
// someone insists on keeping the repo personal — so we don't even lead with it.
function buildLeaderMessage(rows: LeaderEscalationRow[]): string {
  const lines: string[] = [];
  lines.push('🔴 *Team repos on personal accounts — needs your nudge*');
  lines.push('');
  lines.push(
    `${rows.length} member${rows.length === 1 ? '' : 's'} own team repos under a *personal GitHub account*. ` +
      "`anzy-renlab-ai` is only a collaborator, not the owner — if they leave, the repo goes with them " +
      '(the handoff scramble we hit with the last 3 departures). The bot has nudged each of them 4× with no action.'
  );
  lines.push('');
  for (const r of rows) {
    const repoList = r.repos.length > 0 ? r.repos.join(', ') : '(no tracked repo resolved)';
    lines.push(`• *${r.name}* — ${repoList}`);
  }
  lines.push('');
  lines.push('*What to ask them:* transfer the repo to `anzy-renlab-ai` (repo → Settings → Transfer ownership). One step, done.');
  lines.push('_(If they have a reason to keep it personal, setting a company public email is an acceptable fallback — but transfer is what we actually want.)_');
  lines.push('');
  lines.push('→ /status');
  return lines.join('\n');
}

// Logged + pause-aware DM. Earlier this was a bare fetch that bypassed both
// the bot-pause flag AND the message log — that's why the gh-compliance
// reminders + the "🔴 4th reminder" leader escalation never showed up on
// /messages. Now every send (and every skip) is logged like the rest.
async function dmByUserId(
  token: string,
  userId: string,
  text: string,
  meta: { intent: SlackLogIntent; recipientName?: string } = { intent: 'github-login' }
): Promise<boolean> {
  const base = {
    ts: new Date().toISOString(),
    direction: 'out' as const,
    slack_user_id: userId,
    recipient_name: meta.recipientName,
    text,
    intent: meta.intent,
    route: 'gh_compliance.dmByUserId',
    captured_at: new Date().toISOString()
  };
  if (await isBotPaused()) {
    await logSlackMessage({ ...base, ok: false, reason: 'paused' });
    return false;
  }
  const channel = await openConversation(token, userId);
  if (!channel) {
    await logSlackMessage({ ...base, ok: false, reason: 'open-conversation-failed' });
    return false;
  }
  try {
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ channel, text })
    });
    const j = (await res.json()) as { ok?: boolean; error?: string };
    const ok = j.ok ?? false;
    await logSlackMessage({ ...base, channel, ok, reason: ok ? undefined : (j.error ?? 'postMessage-failed') });
    return ok;
  } catch (err) {
    await logSlackMessage({ ...base, channel, ok: false, reason: (err as Error).message });
    return false;
  }
}

// Register a login-collection pending so the Socket Mode handler routes the
// person's reply into roster.github.login.
async function ensureLoginPending(userId: string, name: string): Promise<void> {
  const raw = (await readSyncState<CollectionState>(COLLECTION_KEY)) ?? {};
  const pending = raw.pending ?? {};
  pending[userId] = {
    field: 'github.login',
    name,
    prompt: 'GitHub 用户名登记',
    asked_at: new Date().toISOString()
  };
  await writeSyncState(COLLECTION_KEY, { pending });
}

async function clearLoginPending(userId: string): Promise<void> {
  const raw = (await readSyncState<CollectionState>(COLLECTION_KEY)) ?? {};
  const pending = raw.pending ?? {};
  if (pending[userId]) {
    delete pending[userId];
    await writeSyncState(COLLECTION_KEY, { pending });
  }
}

// One compliance pass. `opts.seedOnly` marks everyone's current stage without
// DMing — used right after a manual campaign so the engine doesn't immediately
// re-DM. `opts.force` ignores the working-day gap (manual trigger).
export async function runComplianceTick(
  opts: { seedOnly?: boolean; force?: boolean } = {}
): Promise<{ dmed: string[]; leaderNotified: string[]; compliant: string[] }> {
  clearRosterCache();
  const roster = await readRoster();
  const token = await getToken();
  const state = ((await readSyncState<ComplianceState>(STATE_KEY)) ?? {}) as ComplianceState;
  const entries = state.entries ?? {};
  const nowIso = new Date().toISOString();
  const today = beijingDate();

  // Once per day. The monitor calls this every roster tick (~30min); the
  // daily guard makes it actually run a single pass per calendar day. seedOnly
  // and force bypass the guard.
  if (!opts.seedOnly && !opts.force && state.last_run_date === today) {
    return { dmed: [], leaderNotified: [], compliant: [] };
  }

  const dmed: string[] = [];
  const leaderEscalations: LeaderEscalationRow[] = [];
  const compliant: string[] = [];

  for (const m of roster.members) {
    if (m.status === 'left') {
      // Departed → purge any stale compliance entry so they stop showing up
      // in the compliance state with frozen-at-departure text (李博泽 stuck at
      // notify_count=2 "non-compliant" vs 刘师宇 at 4 "compliant" — both left,
      // but the table showed inconsistent zombie rows). Their repos are the
      // handoff queue's job (responsibleLeft), not compliance's.
      if (entries[m.name]) delete entries[m.name];
      continue;
    }
    if (!m.slack.user_id) continue;
    const missing = missingFields(m);

    if (missing.length === 0) {
      // Fully compliant — clear any tracking + pending.
      if (entries[m.name]) delete entries[m.name];
      await clearLoginPending(m.slack.user_id);
      compliant.push(m.name);
      continue;
    }

    const e = entries[m.name] ?? { notify_count: 0, last_notified_at: null };

    if (opts.seedOnly) {
      // Mark as already-reminded once (stage 1) without sending.
      e.notify_count = Math.max(e.notify_count, 1);
      e.last_notified_at = nowIso;
      entries[m.name] = e;
      if (missing.includes('login')) await ensureLoginPending(m.slack.user_id, m.name);
      continue;
    }

    if (e.notify_count >= 4) continue; // already escalated to leader; stop

    if (!opts.force) {
      const anchor = e.last_notified_at ?? null;
      if (anchor) {
        const wd = await workingDaysBetween(anchor, new Date(nowIso));
        if (wd < STAGE_GAP_WORKDAYS) continue; // not yet a working day later
      }
    }

    const nextStage = e.notify_count + 1;
    if (token) {
      if (missing.includes('login')) await ensureLoginPending(m.slack.user_id, m.name);
      const ownedRepos = m.github.login ? await ownedReposFor(m.github.login) : [];
      const sent = await dmByUserId(
        token,
        m.slack.user_id,
        buildMessage(m, missing, nextStage, ownedRepos),
        { intent: 'github-login', recipientName: m.name }
      ).catch(() => false);
      if (sent) {
        e.notify_count = nextStage;
        e.last_notified_at = nowIso;
        entries[m.name] = e;
        dmed.push(m.name);
        if (nextStage === 4) leaderEscalations.push({ name: m.name, missing, repos: ownedRepos });
      }
    }
  }

  // Stage-4 leader summary (one DM listing everyone who just hit stage 4).
  const leaderNotified: string[] = [];
  if (leaderEscalations.length > 0 && token) {
    const rosterLeader = roster.members.find((p) => p.name === LEADER_NAME);
    const leaderId = rosterLeader?.slack.user_id;
    if (leaderId) {
      const ok = await dmByUserId(
        token,
        leaderId,
        buildLeaderMessage(leaderEscalations),
        { intent: 'anomaly-push', recipientName: LEADER_NAME }
      ).catch(() => false);
      if (ok) leaderNotified.push(...leaderEscalations.map((r) => r.name));
    }
  }

  // Record the run date only for real (non-seed) passes so the daily guard
  // engages. seedOnly preserves whatever date was there.
  const last_run_date = opts.seedOnly ? state.last_run_date : today;
  await writeSyncState(STATE_KEY, { entries, last_run_date });
  return { dmed, leaderNotified, compliant };
}
