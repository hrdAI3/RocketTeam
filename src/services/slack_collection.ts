// Slack info-collection campaigns + attribution-feedback capture.
//
// The bot DMs a person a question ("你的 GitHub 用户名是？"), records a
// pending entry keyed by their Slack user_id, and when they reply (delivered
// via the Socket Mode client → handleInboundDM) we parse the answer, write it
// into team_roster.json, and DM a confirmation.
//
// Two independent pending states:
//   - github.login campaign (STATE_KEY=slack_collection) — startCollection
//   - attribution feedback (FEEDBACK_STATE_KEY=attribution_feedback_pending)
//     — recordAttributionFeedbackAsk called by leader_push after each
//     archive reminder; reply captured into attribution_feedback.jsonl.
//
// IMPORTANT: when the bot receives a DM with NO pending question (no GH
// campaign, no recent archive reminder), it stays SILENT. Earlier versions
// helpfully answered "你的 GitHub 已登记完成 ✓" to any inbound message —
// that fired even when the leader sent unrelated commentary (e.g. typed a
// design-review note to the bot's DM). Silence-by-default is the correct
// behavior for a notify-only bot.

import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readSyncState, writeSyncState } from '../lib/events';
import { PATHS } from '../lib/paths';
import { getToken, postDM, openConversation } from '../lib/slack';
import { logSlackMessage, type SlackLogIntent } from '../lib/slack_log';
import { isBotPaused } from '../lib/bot_pause';
import {
  readRoster,
  writeRoster,
  clearRosterCache,
  lookupBySlack,
  emailSuffixOk,
  displayNameOk,
  githubCompliant,
  type Member
} from '../lib/team_roster';
import { getToken as getGithubToken, fetchUserProfile } from '../lib/github';
import { trackedRepoOwners } from './repo_ownership';

const STATE_KEY = 'slack_collection';

export type CollectField = 'github.login';

interface PendingEntry {
  field: CollectField;
  name: string;
  prompt: string;
  asked_at: string;
}
interface CollectionState {
  pending?: Record<string, PendingEntry>;
}

async function loadState(): Promise<Required<CollectionState>> {
  const raw = (await readSyncState<CollectionState>(STATE_KEY)) ?? {};
  return { pending: raw.pending ?? {} };
}
async function saveState(s: Required<CollectionState>): Promise<void> {
  await writeSyncState(STATE_KEY, s);
}

// Don't accept stale "GH login asks". If the prompt is older than this, treat
// the inbound reply as ambient chatter, not an answer (avoids the leader's
// follow-up commentary days later getting parsed as a login).
const GITHUB_ASK_TTL_MS = 24 * 60 * 60 * 1000; // 24h

// Kick off a campaign: DM `prompt` to each named member that has a Slack id,
// recording a pending entry so their reply routes to `field`. Returns a
// per-name outcome for logging.
export async function startCollection(
  field: CollectField,
  prompt: string,
  names: string[]
): Promise<Record<string, string>> {
  const token = await getToken();
  if (!token) return Object.fromEntries(names.map((n) => [n, 'no-slack-token']));
  const roster = await readRoster();
  const state = await loadState();
  const out: Record<string, string> = {};
  for (const name of names) {
    const m = roster.members.find((p) => p.name === name);
    if (!m) { out[name] = 'not-in-roster'; continue; }
    if (!m.slack.user_id) { out[name] = 'no-slack-id'; continue; }
    const ok = await postDMById(token, m.slack.user_id, prompt, {
      intent: 'github-login',
      route: 'slack_collection.startCollection',
      recipientName: name
    }).catch(() => false);
    if (!ok) { out[name] = 'dm-failed'; continue; }
    state.pending[m.slack.user_id] = {
      field,
      name,
      prompt,
      asked_at: new Date().toISOString()
    };
    out[name] = 'asked';
  }
  await saveState(state);
  return out;
}

// Parse + persist an answer for a given field. Returns a confirmation string
// to DM back, or null if the answer was rejected (caller re-prompts).
async function applyAnswer(
  member: Member,
  field: CollectField,
  text: string
): Promise<string | null> {
  if (field === 'github.login') {
    const login = extractGithubLogin(text);
    if (!login) return null;
    clearRosterCache();
    const roster = await readRoster();
    const m = roster.members.find((p) => p.name === member.name);
    if (!m) return null;
    m.github.login = login;

    const ghToken = await getGithubToken();
    let email: string | null = null;
    let name: string | null = null;
    if (ghToken) {
      const prof = await fetchUserProfile(ghToken, login).catch(() => ({ email: null, name: null }));
      email = prof.email;
      name = prof.name;
    }
    const eOk = emailSuffixOk(email);
    const nOk = displayNameOk(name, login);
    const owners = await trackedRepoOwners();
    const ownsRepo = owners.has(login.toLowerCase());
    m.github.public_email = email;
    m.github.public_email_suffix_ok = eOk;
    m.github.display_name = name;
    m.github.display_name_ok = nOk;
    m.github.owns_tracked_repo = ownsRepo;
    const issues: Member['github']['issues'] = [];
    if (ownsRepo) {
      if (!email) issues.push('public-email-not-set');
      else if (!eOk) issues.push('public-email-wrong-domain');
      if (!nOk) issues.push('display-name-not-renlab');
    }
    m.github.ok = githubCompliant(m.github, ownsRepo);
    m.github.issues = issues;
    m.github.checked_at = new Date().toISOString();
    await writeRoster(roster);

    if (m.github.ok) {
      return `Registered ✓ GitHub: ${login}\nYou're all set, thanks! 🎉`;
    }
    // Repo owner with a personal email/nickname — present Option A (transfer)
    // vs Option B (set company email + display name). Listing the specific
    // repos makes the ask concrete instead of "you own a tracked team repo".
    const lines = [`Registered GitHub: ${login} ✓`];
    if (ownsRepo) {
      const { readConfig } = await import('../lib/github');
      const cfg = await readConfig();
      const owned = (cfg?.selected_repos ?? [])
        .filter((r) => r.owner.toLowerCase() === login.toLowerCase())
        .map((r) => `${r.owner}/${r.name}`);
      lines.push('');
      lines.push(
        `You own ${owned.length} tracked team repo${owned.length === 1 ? '' : 's'} under this account:`
      );
      for (const r of owned.slice(0, 8)) lines.push(`  • ${r}`);
      if (owned.length > 8) lines.push(`  • …and ${owned.length - 8} more`);
      lines.push('');
      lines.push('Pick one of the two paths:');
      lines.push('');
      lines.push(
        '*Option A — transfer the repos to `anzy-renlab-ai`* (GitHub → repo Settings → Transfer ownership). Once done, no email or display-name change is needed on your side.'
      );
      lines.push('');
      lines.push('*Option B — keep them under your account.* Then please:');
      if (!eOk) {
        lines.push(
          '  • Set a company public email: GitHub → Settings → Public profile → Public email → choose your @renlab.ai or @nb-ai.com address.'
        );
      }
      if (!nOk) {
        const cur = name ? `(currently "${name}")` : '(not set)';
        lines.push(
          `  • Set the display name: GitHub → Settings → Public profile → Name, include "renlab" ${cur}.`
        );
      }
    }
    lines.push('');
    lines.push('Once it\'s fixed the system auto-confirms ✓, no need to reply.');
    return lines.join('\n');
  }
  return null;
}

// Pull a plausible GitHub username out of a free-text reply. Restricted to:
//   - A bare github.com/<login> URL (whole message), OR
//   - A bare username (≤ 39 chars, A-Za-z0-9-) optionally prefixed with @.
// Long multi-line messages, messages with extra commentary, or messages where
// the github.com URL is mid-sentence are REJECTED — those are not someone
// answering a "what's your GH?" question, they're chatter that happens to
// mention a github URL. Without this, the leader pasting a third-party link
// ("看一下 https://github.com/666ghj/MiroFish") got their roster.github.login
// silently overwritten to `666ghj`.
export function extractGithubLogin(text: string): string | null {
  const t = text.trim();
  // Reject obvious chatter: multi-line or unusually long replies aren't a
  // direct answer to a one-line question.
  if (t.includes('\n')) return null;
  if (t.length > 80) return null;
  // github.com/<login>?... — must be the only meaningful content. Tolerate a
  // single trailing slash / path component, but reject if the message has
  // commentary outside the URL.
  const urlOnly = t.match(/^@?https?:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38})(?:\/[\w.-]*)?\/?$/i);
  if (urlOnly) return urlOnly[1];
  const ghOnly = t.match(/^@?github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38})(?:\/[\w.-]*)?\/?$/i);
  if (ghOnly) return ghOnly[1];
  // Bare username (with optional @).
  const bare = t.replace(/^@/, '');
  if (/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(bare)) return bare;
  return null;
}

// ── Attribution-feedback loop ────────────────────────────────────────────
// Registered by leader_push right after an archive reminder DM lands. The
// operator's next inbound DM (if it arrives within FEEDBACK_TTL_MS and there's
// no live GH question taking priority) is captured into the feedback log.

const FEEDBACK_STATE_KEY = 'attribution_feedback_pending';
const FEEDBACK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const FEEDBACK_LOG = join(PATHS.root, 'attribution_feedback.jsonl');

interface FeedbackPending {
  operator: string;
  title: string;
  detail?: string;
  project?: string;
  stable_id: string;
  asked_at: string;
}
interface FeedbackState {
  pending?: Record<string, FeedbackPending>;
}

async function loadFeedbackState(): Promise<Required<FeedbackState>> {
  const raw = (await readSyncState<FeedbackState>(FEEDBACK_STATE_KEY)) ?? {};
  return { pending: raw.pending ?? {} };
}

export async function recordAttributionFeedbackAsk(
  slackUserId: string,
  ctx: { operator: string; title: string; detail?: string; project?: string; stableId: string }
): Promise<void> {
  const state = await loadFeedbackState();
  state.pending[slackUserId] = {
    operator: ctx.operator,
    title: ctx.title,
    detail: ctx.detail,
    project: ctx.project,
    stable_id: ctx.stableId,
    asked_at: new Date().toISOString()
  };
  await writeSyncState(FEEDBACK_STATE_KEY, state);
}

async function captureAttributionFeedback(record: {
  operator: string;
  title: string;
  detail?: string;
  project?: string;
  stable_id: string;
  reply: string;
}): Promise<void> {
  const line = JSON.stringify({ ...record, captured_at: new Date().toISOString() }) + '\n';
  await mkdir(PATHS.root, { recursive: true }).catch(() => {});
  await appendFile(FEEDBACK_LOG, line, 'utf8');
}

async function tryCaptureFeedbackReply(
  token: string,
  slackUserId: string,
  text: string
): Promise<boolean> {
  const state = await loadFeedbackState();
  const fb = state.pending[slackUserId];
  if (!fb) return false;
  const fresh = Date.now() - Date.parse(fb.asked_at) < FEEDBACK_TTL_MS;
  delete state.pending[slackUserId];
  await writeSyncState(FEEDBACK_STATE_KEY, state);
  if (!fresh) return false;
  await captureAttributionFeedback({
    operator: fb.operator,
    title: fb.title,
    detail: fb.detail,
    project: fb.project,
    stable_id: fb.stable_id,
    reply: text.trim()
  });
  await postDMById(token, slackUserId, 'Got it, thanks for the feedback 🙏 we\'ll use it to fix the attribution.', {
    intent: 'feedback-ack',
    route: 'slack_collection.tryCaptureFeedbackReply'
  }).catch(() => {});
  return true;
}

// Entry point from the Socket Mode client when a DM arrives. Resolution
// order — first match wins:
//   1. Fresh github.login campaign pending for this user → try to parse
//      a login. Stale (> TTL) is auto-dropped.
//   2. Recent attribution-feedback ask → log + ack.
//   3. Otherwise → SILENT. The bot is notify-only; chatter doesn't get a
//      reply (and certainly never a "已登记完成 ✓" — that fired on the leader
//      pasting third-party github URLs).
export async function handleInboundDM(slackUserId: string, text: string): Promise<void> {
  const token = await getToken();
  if (!token) return;

  // Log every inbound DM, regardless of how we route it. `handled_as` is
  // resolved below; default 'silent' covers the no-context fall-through.
  const nowIso = new Date().toISOString();
  let handledAs: 'github-login' | 'feedback-capture' | 'silent' | 'paused' = 'silent';

  // Pause gate — log the inbound, skip the auto-reply paths so the leader can
  // answer manually. We still want the leader to SEE the inbound message in
  // the UI, so logging happens regardless.
  const paused = await isBotPaused();
  if (paused) {
    handledAs = 'paused';
    await logSlackMessage({
      ts: nowIso,
      direction: 'in',
      slack_user_id: slackUserId,
      text,
      handled_as: handledAs,
      route: 'slack_collection.handleInboundDM',
      captured_at: new Date().toISOString()
    });
    return;
  }

  const state = await loadState();
  const pending = state.pending[slackUserId];

  // 1. Live github.login campaign — only if asked recently.
  if (pending) {
    const fresh = Date.now() - Date.parse(pending.asked_at) < GITHUB_ASK_TTL_MS;
    if (!fresh) {
      // Drop the stale ask so it doesn't intercept future chatter.
      delete state.pending[slackUserId];
      await saveState(state);
    } else {
      const member = await lookupBySlack(slackUserId);
      if (!member) {
        await logSlackMessage({
          ts: nowIso,
          direction: 'in',
          slack_user_id: slackUserId,
          text,
          handled_as: 'silent',
          route: 'slack_collection.handleInboundDM',
          reason: 'unknown-slack-user',
          captured_at: new Date().toISOString()
        });
        return;
      }
      const confirm = await applyAnswer(member, pending.field, text);
      if (confirm === null) {
        // Chatter that didn't parse — log as silent (no auto-reply fires).
        await logSlackMessage({
          ts: nowIso,
          direction: 'in',
          slack_user_id: slackUserId,
          recipient_name: member.name,
          text,
          handled_as: 'silent',
          route: 'slack_collection.handleInboundDM',
          reason: 'no-parse',
          captured_at: new Date().toISOString()
        });
        return;
      }
      delete state.pending[slackUserId];
      await saveState(state);
      handledAs = 'github-login';
      await logSlackMessage({
        ts: nowIso,
        direction: 'in',
        slack_user_id: slackUserId,
        recipient_name: member.name,
        text,
        handled_as: handledAs,
        route: 'slack_collection.handleInboundDM',
        captured_at: new Date().toISOString()
      });
      await postDM(token, member.name, confirm, {
        intent: 'github-confirm',
        route: 'slack_collection.handleInboundDM'
      }).catch(() => {});
      return;
    }
  }

  // 2. Attribution-feedback reply (within 7d of an archive reminder).
  if (await tryCaptureFeedbackReply(token, slackUserId, text)) {
    await logSlackMessage({
      ts: nowIso,
      direction: 'in',
      slack_user_id: slackUserId,
      text,
      handled_as: 'feedback-capture',
      route: 'slack_collection.handleInboundDM',
      captured_at: new Date().toISOString()
    });
    return;
  }

  // 3. No context — stay silent. Log so the leader can see the chatter.
  await logSlackMessage({
    ts: nowIso,
    direction: 'in',
    slack_user_id: slackUserId,
    text,
    handled_as: 'silent',
    route: 'slack_collection.handleInboundDM',
    captured_at: new Date().toISOString()
  });
  return;
}

// postMessage to a user_id directly (handleInboundDM has the id, not always
// a roster name).
interface PostDMByIdOptions {
  intent?: SlackLogIntent;
  route?: string;
  recipientName?: string;
  bypassPause?: boolean;
}
async function postDMById(
  token: string,
  userId: string,
  text: string,
  opts: PostDMByIdOptions = {}
): Promise<boolean> {
  const intent: SlackLogIntent = opts.intent ?? 'other';
  const route = opts.route ?? 'slack_collection.postDMById';

  if (!opts.bypassPause && (await isBotPaused())) {
    await logSlackMessage({
      ts: new Date().toISOString(),
      direction: 'out',
      slack_user_id: userId,
      recipient_name: opts.recipientName,
      text,
      ok: false,
      intent,
      route,
      reason: 'paused',
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
      recipient_name: opts.recipientName,
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
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8'
      },
      body: JSON.stringify({ channel, text })
    });
    const j = (await res.json()) as { ok?: boolean; error?: string };
    const ok = j.ok ?? false;
    await logSlackMessage({
      ts: new Date().toISOString(),
      direction: 'out',
      slack_user_id: userId,
      recipient_name: opts.recipientName,
      channel,
      text,
      ok,
      intent,
      route,
      reason: ok ? undefined : (j.error ?? 'postMessage-failed'),
      captured_at: new Date().toISOString()
    });
    return ok;
  } catch (err) {
    await logSlackMessage({
      ts: new Date().toISOString(),
      direction: 'out',
      slack_user_id: userId,
      recipient_name: opts.recipientName,
      channel,
      text,
      ok: false,
      intent,
      route,
      reason: (err as Error).message,
      captured_at: new Date().toISOString()
    });
    return false;
  }
}
