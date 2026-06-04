// Leader push notifier.
// When the system opens a new attention item, this fires a Slack DM to the
// leader so they see it without having to pull `team:today` or refresh /status.
//
// Coverage: anomalies with severity `act-now` or `next-glance`, plus newly
// blocked projects. `fyi` is ignored — too noisy for DMs.
//
// Idempotency: `data/sync_state/leader_push.json` keeps the set of attention
// ids already notified. Duplicate calls are no-ops. Ids are bounded at 500.
//
// Test-phase target: defaults to 戴昊然 (see LEADER_NAME env). Flip to 安子岩
// by setting `LEADER_NAME=安子岩` once we're confident.

import { readSyncState, writeSyncState } from '../lib/events';
import { getToken, postDM, openConversation } from '../lib/slack';
import { reverseLookup } from '../lib/identity';
import { lookupByName } from '../lib/team_roster';
import { logSlackMessage, type SlackLogIntent } from '../lib/slack_log';
import { isBotPaused } from '../lib/bot_pause';
import type { Anomaly, AnomalySeverityHint } from '../types/events';

// DM by Slack user_id (display names often differ from roster names).
interface LeaderPushDMOpts {
  intent?: SlackLogIntent;
  route?: string;
  recipientName?: string;
}
async function postDMByUserId(
  token: string,
  userId: string,
  text: string,
  opts: LeaderPushDMOpts = {}
): Promise<boolean> {
  const intent: SlackLogIntent = opts.intent ?? 'other';
  const route = opts.route ?? 'leader_push.postDMByUserId';

  if (await isBotPaused()) {
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
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
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

const PUSH_STATE_KEY = 'leader_push';
// Test phase default — push to 戴昊然 until we confirm the pipeline is sane,
// then env-override to 安子岩.
const LEADER_NAME = process.env.LEADER_NAME ?? '戴昊然';

// Eviction is time-based instead of count-based: keep at least PRUNE_AFTER_MS
// of notifications per id so long-lived anomalies (live quota, blocked
// project) don't slip out of dedup and re-DM the leader. Old `notifiedIds: string[]`
// shape is auto-migrated on first load.
const PRUNE_AFTER_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

interface NotifiedRecord {
  id: string;
  at: string; // ISO timestamp of the DM
}
interface PushState {
  notifiedIds?: string[]; // legacy; only read for migration, never written
  notified?: NotifiedRecord[];
}

const SENDER_LABEL = process.env.PUSH_SENDER_LABEL ?? 'RocketTeam';

const SEV_BADGE: Record<AnomalySeverityHint, string> = {
  'act-now': '🚨 Urgent',
  'next-glance': '⚠️ Heads up',
  fyi: 'ℹ️ FYI'
};

const RULE_LABEL: Record<string, string> = {
  'override.spike': 'Override spike',
  'blocked.review_pending': 'PR review overdue',
  'blocked.cc_attested': 'Self-reported stuck',
  'dispatch.uncertain': 'Dispatch unclear',
  'silence.dormant': 'Silent / dormant',
  'quota.near_5h': '5h quota near limit',
  'quota.near_7d': '7d quota near limit',
  'quota.pace_5h': '5h usage pace alert',
  'quota.pace_7d': '7d usage pace alert',
  'context.near_full': 'Context near full',
  'project.unattributed': 'Work not tied to project'
};
function ruleLabel(rule: string): string {
  return RULE_LABEL[rule] ?? rule;
}

export interface FormatAnomalyContext {
  // Project name resolved from §2.4.2 anomaly attribution, when applicable.
  // Drives whether the DM headline reads "*Matrix* — silence" vs the legacy
  // "*silence* — 张三". Optional; falsy → legacy.
  projectName?: string | null;
}

// Terse one-line DM per leader direction. Layout:
//   <sev-emoji> <label> · <project or subject> · <one-line context>
// Followed by a `/status` link on its own line so the leader can drill in.
// Verbose evidence + action lists are gone — they were noise on the phone.
function formatAnomaly(anomaly: Anomaly, ctx: FormatAnomalyContext = {}): string {
  const subject =
    anomaly.subject.kind === 'agent' || anomaly.subject.kind === 'repo'
      ? anomaly.subject.ref
      : `${anomaly.subject.kind}:${anomaly.subject.ref}`;
  const head = ctx.projectName
    ? `${ctx.projectName} · ${ruleLabel(anomaly.rule)}`
    : `${ruleLabel(anomaly.rule)} · ${subject}`;
  const sev = SEV_BADGE[anomaly.severity_hint];
  return `${sev} ${head}\n→ /status`;
}

export interface BlockedProjectPushInfo {
  key: string; // project grouping key — used as idempotency key
  name: string;
  threadCount: number;
  ccCount: number;
  lastActivityAt: string | null;
}

function formatBlockedProject(p: BlockedProjectPushInfo): string {
  return `🔴 ${p.name} · blocked (${p.threadCount} thread${p.threadCount === 1 ? '' : 's'} · CC×${p.ccCount})\n→ /status`;
}

// Aggregate format for unattributed-work digest. Single line + count.
export function formatUnattributedDigest(count: number): string {
  return `⚠️ ${count} work item${count === 1 ? '' : 's'} not tied to any tracked GitHub repo — needs leader review\n→ /status/unclustered`;
}

// Aged-unattributed = an archive reminder. A CC work thread that isn't tied
// to any tracked GitHub repo means the operator is working on something
// un-archived (likely a new/personal repo). We remind the OPERATOR to create
// or register a GitHub repo for it — they're the only one who can. Escalation:
//   stage 1-3 → operator only (one working day apart)
//   stage 4   → operator + leader (cc)
// Note: this is operator-facing by design. The "DM repo owner not operator"
// policy applies to transferring an EXISTING repo; here there's no repo yet,
// so the operator is exactly who must act.
export type EscalationStage = 1 | 2 | 3 | 4;

const ARCHIVE_STAGE_PREFIX: Record<EscalationStage, string> = {
  1: '⚠️ Reminder',
  2: '⚠️ 2nd reminder',
  3: '🟠 3rd reminder',
  4: '🔴 4th reminder · leader cc\'d'
};

export function formatArchiveReminderForOperator(
  title: string,
  daysOld: number,
  stage: EscalationStage
): string {
  const head = ARCHIVE_STAGE_PREFIX[stage];
  return (
    `${head} · A Claude Code work item has been open ${daysOld}d without a tracked GitHub repo:\n` +
    `"${title}"\n` +
    `Please create a GitHub repo for it (or move it into an existing tracked repo) and let the leader know so it joins tracking.\n` +
    `Note: if you're creating a new personal repo, register it under your company email, or transfer ownership to anzy-renlab-ai after creation.`
  );
}
// Per-project archive reminder — batches the work items of one inferred
// untracked project into a single DM (instead of N per-item nags). Includes
// the system's read of WHAT the work is so the operator can confirm whether
// the attribution is right + archive it together. Reply captured by
// slack_collection's feedback path → attribution_feedback.jsonl.
export function formatArchiveReminderForProject(args: {
  projectName: string;
  itemTitles: string[];
  daysOld: number;
  stage: EscalationStage;
}): string {
  const head = ARCHIVE_STAGE_PREFIX[args.stage];
  const lines = args.itemTitles.slice(0, 6).map((t) => `  • ${t}`).join('\n');
  const extra = args.itemTitles.length > 6 ? `\n  …and ${args.itemTitles.length - 6} more` : '';
  return (
    `${head} · ${args.itemTitles.length} Claude Code work item${args.itemTitles.length === 1 ? '' : 's'} ` +
    `${args.itemTitles.length === 1 ? 'has' : 'have'} been open ${args.daysOld}d ` +
    `without a tracked GitHub repo. Looks like the same project: "${args.projectName}"\n` +
    `${lines}${extra}\n` +
    `Please create a GitHub repo (suggested name: ${args.projectName}) and archive these items there, or move them into an existing tracked repo.\n` +
    `Note: if you're creating a new personal repo, register it under your company email, or transfer ownership to anzy-renlab-ai after creation.\n` +
    `👉 Is this project name / item list right? If not (e.g. "it's actually part of X"), reply to this message and we'll fix the attribution.`
  );
}
export function formatAgedUnattributedForLeader(
  operator: string,
  title: string,
  daysOld: number
): string {
  return (
    `🔴 ${operator}'s work has been open ${daysOld}d without a tracked GitHub repo; operator received 3 archive reminders and did not act:\n` +
    `"${title}"\n→ /status/unclustered`
  );
}
export function formatAgedProjectForLeader(
  operator: string,
  projectName: string,
  itemCount: number,
  daysOld: number
): string {
  return (
    `🔴 ${operator}'s "${projectName}" (${itemCount} item${itemCount === 1 ? '' : 's'}) has been open ${daysOld}d without a tracked GitHub repo; operator received 3 archive reminders and did not act.\n→ /status`
  );
}

interface NormalizedState {
  notified: NotifiedRecord[];
}

async function loadState(): Promise<NormalizedState> {
  const raw = ((await readSyncState<PushState>(PUSH_STATE_KEY)) ?? {}) as PushState;
  // Migrate legacy count-based ids into timestamp records dated "now". This
  // gives them a fresh 30-day TTL so we don't lose dedup on the migration tick.
  const seeded: NotifiedRecord[] = Array.isArray(raw.notified) ? raw.notified : [];
  if (Array.isArray(raw.notifiedIds) && seeded.length === 0) {
    const now = new Date().toISOString();
    for (const id of raw.notifiedIds) seeded.push({ id, at: now });
  }
  return { notified: seeded };
}

async function saveState(state: NormalizedState): Promise<void> {
  // Prune by age, not count: anything older than PRUNE_AFTER_MS evicts. Keeps
  // long-lived ids (live concerns, blocked-project keys) in dedup as long as
  // they re-fire within 30d. If size still balloons absurdly (>10k), fall back
  // to a hard cap — that's pathological-data protection only.
  const cutoff = Date.now() - PRUNE_AFTER_MS;
  const pruned = state.notified.filter((r) => {
    const t = Date.parse(r.at);
    return Number.isFinite(t) && t >= cutoff;
  });
  if (pruned.length > 10_000) pruned.splice(0, pruned.length - 10_000);
  await writeSyncState(PUSH_STATE_KEY, { notified: pruned });
}

function isNotified(state: NormalizedState, id: string): boolean {
  return state.notified.some((r) => r.id === id);
}

export interface PushOutcome {
  pushed: boolean;
  reason?: string;
}

async function pushIfNew(id: string, text: string): Promise<PushOutcome> {
  const state = await loadState();
  if (isNotified(state, id)) {
    return { pushed: false, reason: 'already-notified' };
  }
  const token = await getToken();
  if (!token) {
    return { pushed: false, reason: 'no-slack-token' };
  }
  const reverse = await reverseLookup(LEADER_NAME);
  if (!reverse.slack && process.env.STRICT_LEADER_SLACK_ID === '1') {
    return { pushed: false, reason: 'no-slack-id-for-leader' };
  }
  const ok = await postDM(token, LEADER_NAME, text, {
    intent: 'anomaly-push',
    route: 'leader_push.pushIfNew'
  }).catch((err) => {
    console.warn('[leader_push] postDM threw:', (err as Error).message);
    return false;
  });
  if (!ok) {
    return { pushed: false, reason: 'postDM-failed' };
  }
  state.notified.push({ id, at: new Date().toISOString() });
  await saveState(state);
  return { pushed: true };
}

// §3 — Unattributed-work digest. Per leader direction the system should
// surface "N 项工作未归档" as a single signal, not N individual DMs. The
// digest fires when:
//   (a) `count >= UNATTRIBUTED_DIGEST_THRESHOLD` (first cross of the line)
//   (b) AND count grew by ≥ UNATTRIBUTED_GROW_DELTA since the last sent
//       digest (so the leader gets re-pinged only when the backlog gets
//       materially worse, not every cron tick).
// Idempotency / state key encodes the *count band* (rounded to nearest
// UNATTRIBUTED_GROW_DELTA) so a single DM corresponds to a band, not a tick.
const UNATTRIBUTED_DIGEST_THRESHOLD = 5;
const UNATTRIBUTED_GROW_DELTA = 5;

interface DigestState {
  lastSentAt?: string;
  lastCount?: number;
}
const UNATTRIBUTED_DIGEST_KEY = 'leader_push_unattributed';

// §aging — Slack policy: DMs go to repo owners only. Aged-unattributed work
// has no repo owner, so stages 1-3 are no-op for messaging (UI still ages the
// row + monitor_loop advances `notify_count` so we can show progress). Stage
// 4 DMs the leader so they can intervene.
// Return shape stays the same as before — `operator` outcome is always
// reported as `op-skipped-by-policy` so monitor_loop's stage advance logic
// (which keys off the operator branch) continues to march the counter.
export async function notifyAgedUnattributed(
  stableId: string,
  operator: string,
  title: string,
  daysOld: number,
  stage: EscalationStage
): Promise<{ operator: PushOutcome; leader: PushOutcome }> {
  const idOp = `aged:${stableId}:s${stage}:op:${operator}`;
  const idLeader = `aged:${stableId}:s${stage}:leader`;
  const shouldDmLeader = stage === 4;
  const stateOp = await loadState();
  const skipOp = isNotified(stateOp, idOp);
  const skipLeader = shouldDmLeader ? isNotified(stateOp, idLeader) : true;
  if (skipOp && skipLeader) {
    return {
      operator: { pushed: false, reason: 'already-notified' },
      leader: { pushed: false, reason: shouldDmLeader ? 'already-notified' : 'not-this-stage' }
    };
  }
  const token = await getToken();
  if (!token) {
    return {
      operator: { pushed: false, reason: 'no-slack-token' },
      leader: { pushed: false, reason: 'no-slack-token' }
    };
  }

  // Operator DM (archive reminder) — every stage. DM by roster user_id when
  // available (display names ≠ roster names), falling back to name lookup.
  let operatorOutcome: PushOutcome = { pushed: false, reason: 'already-notified' };
  if (!skipOp) {
    const txt = formatArchiveReminderForOperator(title, daysOld, stage);
    const member = await lookupByName(operator);
    const ok = member?.slack.user_id
      ? await postDMByUserId(token, member.slack.user_id, txt, {
          intent: 'archive-reminder',
          route: 'leader_push.notifyAgedUnattributed',
          recipientName: operator
        }).catch(() => false)
      : await postDM(token, operator, txt, {
          intent: 'archive-reminder',
          route: 'leader_push.notifyAgedUnattributed'
        }).catch(() => false);
    operatorOutcome = ok ? { pushed: true } : { pushed: false, reason: 'postDM-failed' };
    if (ok) {
      const s = await loadState();
      s.notified.push({ id: idOp, at: new Date().toISOString() });
      await saveState(s);
    }
  }

  // Leader cc at stage 4.
  let leaderOutcome: PushOutcome = {
    pushed: false,
    reason: shouldDmLeader ? 'already-notified' : 'not-this-stage'
  };
  if (shouldDmLeader && !skipLeader) {
    const txt = formatAgedUnattributedForLeader(operator, title, daysOld);
    const ok = await postDM(token, LEADER_NAME, txt, {
      intent: 'archive-reminder',
      route: 'leader_push.notifyAgedUnattributed.leader'
    }).catch(() => false);
    leaderOutcome = ok ? { pushed: true } : { pushed: false, reason: 'postDM-failed' };
    if (ok) {
      const s = await loadState();
      s.notified.push({ id: idLeader, at: new Date().toISOString() });
      await saveState(s);
    }
  }
  return { operator: operatorOutcome, leader: leaderOutcome };
}

// Per-untracked-project archive escalation. Same 1-4 stage shape as the
// per-item version, but a single DM bundles all work items in one inferred
// project (less noise for a sustained backlog like 黄运樟 Maya 4 threads).
export async function notifyAgedProject(args: {
  stableId: string;
  operator: string;
  projectName: string;
  itemTitles: string[];
  daysOld: number;
  stage: EscalationStage;
}): Promise<{ operator: PushOutcome; leader: PushOutcome }> {
  const { stableId, operator, projectName, itemTitles, daysOld, stage } = args;
  const idOp = `aged-proj:${stableId}:s${stage}:op:${operator}`;
  const idLeader = `aged-proj:${stableId}:s${stage}:leader`;
  const shouldDmLeader = stage === 4;
  const stateOp = await loadState();
  const skipOp = isNotified(stateOp, idOp);
  const skipLeader = shouldDmLeader ? isNotified(stateOp, idLeader) : true;
  if (skipOp && skipLeader) {
    return {
      operator: { pushed: false, reason: 'already-notified' },
      leader: { pushed: false, reason: shouldDmLeader ? 'already-notified' : 'not-this-stage' }
    };
  }
  const token = await getToken();
  if (!token) {
    return {
      operator: { pushed: false, reason: 'no-slack-token' },
      leader: { pushed: false, reason: 'no-slack-token' }
    };
  }

  let operatorOutcome: PushOutcome = { pushed: false, reason: 'already-notified' };
  if (!skipOp) {
    const txt = formatArchiveReminderForProject({ projectName, itemTitles, daysOld, stage });
    const member = await lookupByName(operator);
    const ok = member?.slack.user_id
      ? await postDMByUserId(token, member.slack.user_id, txt, {
          intent: 'archive-reminder',
          route: 'leader_push.notifyAgedProject',
          recipientName: operator
        }).catch(() => false)
      : await postDM(token, operator, txt, {
          intent: 'archive-reminder',
          route: 'leader_push.notifyAgedProject'
        }).catch(() => false);
    operatorOutcome = ok ? { pushed: true } : { pushed: false, reason: 'postDM-failed' };
    if (ok) {
      const s = await loadState();
      s.notified.push({ id: idOp, at: new Date().toISOString() });
      await saveState(s);
    }
  }

  let leaderOutcome: PushOutcome = {
    pushed: false,
    reason: shouldDmLeader ? 'already-notified' : 'not-this-stage'
  };
  if (shouldDmLeader && !skipLeader) {
    const txt = formatAgedProjectForLeader(operator, projectName, itemTitles.length, daysOld);
    const ok = await postDM(token, LEADER_NAME, txt, {
      intent: 'archive-reminder',
      route: 'leader_push.notifyAgedProject.leader'
    }).catch(() => false);
    leaderOutcome = ok ? { pushed: true } : { pushed: false, reason: 'postDM-failed' };
    if (ok) {
      const s = await loadState();
      s.notified.push({ id: idLeader, at: new Date().toISOString() });
      await saveState(s);
    }
  }
  return { operator: operatorOutcome, leader: leaderOutcome };
}

export async function notifyUnattributedDigest(count: number): Promise<PushOutcome> {
  if (count < UNATTRIBUTED_DIGEST_THRESHOLD) {
    return { pushed: false, reason: 'below-threshold' };
  }
  const state = ((await readSyncState<DigestState>(UNATTRIBUTED_DIGEST_KEY)) ?? {}) as DigestState;
  const last = state.lastCount ?? 0;
  if (last > 0 && count - last < UNATTRIBUTED_GROW_DELTA) {
    return { pushed: false, reason: 'no-material-change' };
  }
  const token = await getToken();
  if (!token) return { pushed: false, reason: 'no-slack-token' };
  const text = formatUnattributedDigest(count);
  const ok = await postDM(token, LEADER_NAME, text, {
    intent: 'anomaly-push',
    route: 'leader_push.notifyUnattributedDigest'
  }).catch(() => false);
  if (!ok) return { pushed: false, reason: 'postDM-failed' };
  await writeSyncState(UNATTRIBUTED_DIGEST_KEY, {
    lastSentAt: new Date().toISOString(),
    lastCount: count
  });
  return { pushed: true };
}

// Mark ids as notified WITHOUT actually sending. Used by the first-tick
// seeding flow so leaders coming online don't get blasted with the entire
// existing backlog.
export async function markNotifiedSilent(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const state = await loadState();
  const known = new Set(state.notified.map((r) => r.id));
  const now = new Date().toISOString();
  let added = 0;
  for (const id of ids) {
    if (known.has(id)) continue;
    state.notified.push({ id, at: now });
    known.add(id);
    added++;
  }
  if (added > 0) await saveState(state);
  return added;
}

// Feature flag for project-subject DMs. Off by default during ramp-up so a
// bad attribution can't silently break the existing DM format; flip to "1"
// (or unset env var entirely to disable) once we trust the §2.4.2 path.
const PROJECT_SUBJECT_ENABLED = process.env.WORKBOARD_PUSH_PROJECTS === '1';

// Original entry point kept for callers that explicitly want only act-now
// pushes (e.g. anomaly engine's hot path). Refactored to share state with the
// broader notifier below.
export async function notifyActNowIfNew(
  anomaly: Anomaly,
  ctx: FormatAnomalyContext = {}
): Promise<PushOutcome> {
  if (anomaly.severity_hint !== 'act-now') {
    return { pushed: false, reason: 'not-act-now' };
  }
  const effective: FormatAnomalyContext = PROJECT_SUBJECT_ENABLED ? ctx : {};
  return pushIfNew(anomaly.id, formatAnomaly(anomaly, effective));
}

// Generalized entry point: pushes anomalies of `act-now` OR `next-glance`
// severity. `fyi` is intentionally dropped to avoid DM noise. Caller is the
// monitor loop, which feeds it every attention item per tick — idempotency
// guarantees one DM per id over its lifetime.
export async function notifyAttentionIfNew(
  anomaly: Anomaly,
  ctx: FormatAnomalyContext = {}
): Promise<PushOutcome> {
  if (anomaly.severity_hint === 'fyi') {
    return { pushed: false, reason: 'fyi-skipped' };
  }
  const effective: FormatAnomalyContext = PROJECT_SUBJECT_ENABLED ? ctx : {};
  return pushIfNew(anomaly.id, formatAnomaly(anomaly, effective));
}

// Blocked-project push. Idempotent on `blocked:${project.key}` — leader gets
// one DM the first time a project turns red and stays silent until the key is
// retired (which happens when state.notifiedIds caps at 500 and rolls).
export async function notifyBlockedProjectIfNew(
  project: BlockedProjectPushInfo
): Promise<PushOutcome> {
  return pushIfNew(`blocked:${project.key}`, formatBlockedProject(project));
}

// External-owner repo push. Fires once per (repo, responsible) when a tracked
// GitHub repo lives on a personal account (anything outside -renlab-ai / the
// allowlist orgs). DMs the responsible person directly, asking them to
// transfer the repo to anzy-renlab-ai. The leader is NOT cc'd here — the
// employee gets a chance to act before this escalates.
function formatExternalOwnerForOperator(fullName: string): string {
  return (
    `⚠️ Repo ${fullName} is still under a personal account.\n` +
    `Please transfer it to anzy-renlab-ai (GitHub → Settings → Transfer ownership) ` +
    `so the team audit account keeps access.`
  );
}

export async function notifyExternalOwnerRepoIfNew(args: {
  fullName: string;
  responsible: string | null;
}): Promise<PushOutcome> {
  const { fullName, responsible } = args;
  if (!responsible) {
    return { pushed: false, reason: 'no-responsible' };
  }
  const id = `external-owner:${fullName}:op:${responsible}`;
  const state = await loadState();
  if (isNotified(state, id)) {
    return { pushed: false, reason: 'already-notified' };
  }
  const token = await getToken();
  if (!token) return { pushed: false, reason: 'no-slack-token' };
  // DM by the roster's stored slack.user_id, NOT postDM(name). postDM resolves
  // the name against Slack display names, which routinely differ from the
  // roster's Chinese name (赵艺霖's Slack display ≠ "赵艺霖") → resolveUserId
  // returns null → send "fails" → the notified id never gets saved → the
  // reminder re-fires EVERY monitor tick (5min). Using the known user_id makes
  // delivery reliable and the dedup actually stick.
  const member = await lookupByName(responsible);
  const ok = member?.slack.user_id
    ? await postDMByUserId(token, member.slack.user_id, formatExternalOwnerForOperator(fullName), {
        intent: 'identity-prompt',
        route: 'leader_push.notifyExternalOwnerRepoIfNew',
        recipientName: responsible
      }).catch(() => false)
    : await postDM(token, responsible, formatExternalOwnerForOperator(fullName), {
        intent: 'identity-prompt',
        route: 'leader_push.notifyExternalOwnerRepoIfNew'
      }).catch(() => false);
  if (!ok) {
    // Mark notified anyway when we have NO way to reach them (no user_id and
    // name unresolvable) — otherwise we'd spam the log + retry forever every
    // tick. A genuinely transient failure still retries next tick because the
    // user_id path would have succeeded.
    if (!member?.slack.user_id) {
      const s = await loadState();
      s.notified.push({ id, at: new Date().toISOString() });
      await saveState(s);
    }
    return { pushed: false, reason: 'postDM-failed' };
  }
  const s = await loadState();
  s.notified.push({ id, at: new Date().toISOString() });
  await saveState(s);
  return { pushed: true };
}
