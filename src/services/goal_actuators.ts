// Goal actuators — turn the goal layer's read-only signals into action.
//
// Two daily-cadence strategy nudges, wired into monitor_loop's rosterTick like
// the daily brief and gh-compliance:
//   1. notifyAtRiskGoals — DM the leader about each at-risk goal (blocked or
//      went-quiet linked project). Goal has NO owner field (lib/goals.ts), so
//      the recipient is structurally the LEADER until an owner field exists.
//   2. driftNudge — DM the leader the top drift project(s) (active, real recent
//      commits, serving NO active goal) with the EXACT one-action create payload.
//
// HARD CONTRACT — DRY-RUN BY DEFAULT. With no args / {} (or send:false) these
// functions touch NO Slack and write NO marker: they only BUILD + return the
// messages. A real send happens ONLY when send===true AND, per item, the gates
// pass: not-paused + working-day + per-item once-per-day marker not yet set.
//
// All send/gate primitives are REUSED verbatim (no new send or counting logic):
//   - goalsView (goal_progress) — the deduped, memory-bounded at-risk + drift view
//   - postDM (slack) — resolves user_id from roster, logs, honors bot-pause
//   - isWorkingDay (workdays), isBotPaused (bot_pause), beijingDate (daily_brief)
//   - lookupByName / readRoster (team_roster), readSyncState/writeSyncState (events)

import { goalsView } from './goal_progress';
import { beijingDate } from './daily_brief';
import { isWorkingDay } from '../lib/workdays';
import { isBotPaused } from '../lib/bot_pause';
import { lookupByName } from '../lib/team_roster';
import { readSyncState, writeSyncState } from '../lib/events';
import { getToken, postDM } from '../lib/slack';

const LEADER_NAME = process.env.LEADER_NAME ?? '戴昊然';
const AT_RISK_KEY = 'goal_at_risk_notify';
const DRIFT_KEY = 'goal_drift_nudge';
// Only nudge on SUBSTANTIAL drift. goalsView includes any project with >=1
// deduped commit; apply the real threshold here (env knob).
const DRIFT_MIN_COMMITS = Number(process.env.DRIFT_MIN_COMMITS ?? 5);
const DRIFT_TOP_N = Number(process.env.DRIFT_TOP_N ?? 1);

// Per-item once-per-Beijing-day dedup marker, shape mirrors gh_compliance's
// per-member dedup: { byKey: { [goalId|projectId]: { lastDate: 'YYYY-MM-DD' } } }.
interface MarkerState {
  byKey?: Record<string, { lastDate?: string }>;
}

export interface ActuatorMessage {
  key: string;            // goalId or projectId — the dedup key
  recipientName: string;  // who we'd DM (the leader in v1)
  text: string;
}
export interface ActuatorResult {
  messages: ActuatorMessage[];          // every message that WOULD be sent (always populated)
  sent: string[];                       // keys actually DM'd this call (send===true only)
  skipped: Array<{ key: string; reason: string }>;
}

// Resolve the recipient member or a skip reason. v1: always the leader (Goal has
// no owner field). Skips if the leader is absent / departed / has no slack id.
async function resolveLeaderRecipient(): Promise<
  { ok: true; name: string } | { ok: false; reason: string }
> {
  const m = await lookupByName(LEADER_NAME);
  if (!m) return { ok: false, reason: 'no-leader' };
  if (m.status === 'left') return { ok: false, reason: 'leader-left' };
  if (!m.slack.user_id) return { ok: false, reason: 'no-leader-slack-id' };
  return { ok: true, name: m.name };
}

// ── Actuator #1: at-risk goal notifier ──────────────────────────────────────
export async function notifyAtRiskGoals(
  opts: { send?: boolean } = {}
): Promise<ActuatorResult> {
  const send = opts.send === true;
  const today = beijingDate();
  const messages: ActuatorMessage[] = [];
  const sent: string[] = [];
  const skipped: Array<{ key: string; reason: string }> = [];

  const view = await goalsView().catch(() => null);
  const atRisk = (view?.goals ?? []).filter((g) => g.at_risk);
  if (atRisk.length === 0) return { messages, sent, skipped };

  const recipient = await resolveLeaderRecipient();

  // Build every message first (DRY-RUN must always return them).
  for (const g of atRisk) {
    const text =
      `⚠️ 目标「${g.title}」有风险\n` +
      `${g.at_risk_reason ?? ''}\n` +
      `本周 ${g.commits_7d} commit · 趋势 ${g.trend}\n` +
      `→ /goals\n` +
      `(${today} 北京时间)`;
    messages.push({ key: g.goal_id, recipientName: recipient.ok ? recipient.name : LEADER_NAME, text });
  }

  if (!send) return { messages, sent, skipped };

  // ── REAL SEND PATH (send===true) ──
  if (!recipient.ok) {
    for (const m of messages) skipped.push({ key: m.key, reason: recipient.reason });
    return { messages, sent, skipped };
  }
  if (await isBotPaused()) {
    for (const m of messages) skipped.push({ key: m.key, reason: 'paused' });
    return { messages, sent, skipped };
  }
  if (!(await isWorkingDay(new Date()))) {
    for (const m of messages) skipped.push({ key: m.key, reason: 'non-working-day' });
    return { messages, sent, skipped };
  }

  const token = await getToken();
  if (!token) {
    for (const m of messages) skipped.push({ key: m.key, reason: 'no-slack-token' });
    return { messages, sent, skipped };
  }

  const state = ((await readSyncState<MarkerState>(AT_RISK_KEY)) ?? {}) as MarkerState;
  const byKey = state.byKey ?? {};
  for (const m of messages) {
    if (byKey[m.key]?.lastDate === today) {
      skipped.push({ key: m.key, reason: 'already-notified-today' });
      continue;
    }
    const ok = await postDM(token, m.recipientName, m.text, {
      intent: 'anomaly-push',
      route: 'goal_actuators.atRisk'
    }).catch(() => false);
    if (ok) {
      byKey[m.key] = { lastDate: today };
      sent.push(m.key);
    } else {
      skipped.push({ key: m.key, reason: 'send-failed' });
    }
  }
  await writeSyncState(AT_RISK_KEY, { byKey }).catch(() => {});
  return { messages, sent, skipped };
}

// ── Actuator #2: drift nudge ─────────────────────────────────────────────────
export async function driftNudge(
  opts: { send?: boolean } = {}
): Promise<ActuatorResult> {
  const send = opts.send === true;
  const today = beijingDate();
  const messages: ActuatorMessage[] = [];
  const sent: string[] = [];
  const skipped: Array<{ key: string; reason: string }> = [];

  const view = await goalsView().catch(() => null);
  const top = (view?.drift ?? [])
    .filter((d) => d.commits_7d >= DRIFT_MIN_COMMITS)
    .slice(0, DRIFT_TOP_N);
  if (top.length === 0) return { messages, sent, skipped };

  const recipient = await resolveLeaderRecipient();

  for (const d of top) {
    const payload = JSON.stringify({ title: d.name, linked_project_ids: [d.project_id] });
    const text =
      `📌 ${d.name} ${d.commits_7d} commits/7d 未目标化 — 建目标?\n` +
      `POST /api/goals ${payload}\n` +
      `→ /goals\n` +
      `(${today} 北京时间)`;
    messages.push({ key: d.project_id, recipientName: recipient.ok ? recipient.name : LEADER_NAME, text });
  }

  if (!send) return { messages, sent, skipped };

  // ── REAL SEND PATH (send===true) ──
  if (!recipient.ok) {
    for (const m of messages) skipped.push({ key: m.key, reason: recipient.reason });
    return { messages, sent, skipped };
  }
  if (await isBotPaused()) {
    for (const m of messages) skipped.push({ key: m.key, reason: 'paused' });
    return { messages, sent, skipped };
  }
  if (!(await isWorkingDay(new Date()))) {
    for (const m of messages) skipped.push({ key: m.key, reason: 'non-working-day' });
    return { messages, sent, skipped };
  }

  const token = await getToken();
  if (!token) {
    for (const m of messages) skipped.push({ key: m.key, reason: 'no-slack-token' });
    return { messages, sent, skipped };
  }

  const state = ((await readSyncState<MarkerState>(DRIFT_KEY)) ?? {}) as MarkerState;
  const byKey = state.byKey ?? {};
  for (const m of messages) {
    if (byKey[m.key]?.lastDate === today) {
      skipped.push({ key: m.key, reason: 'already-notified-today' });
      continue;
    }
    const ok = await postDM(token, m.recipientName, m.text, {
      intent: 'anomaly-push',
      route: 'goal_actuators.drift'
    }).catch(() => false);
    if (ok) {
      byKey[m.key] = { lastDate: today };
      sent.push(m.key);
    } else {
      skipped.push({ key: m.key, reason: 'send-failed' });
    }
  }
  await writeSyncState(DRIFT_KEY, { byKey }).catch(() => {});
  return { messages, sent, skipped };
}
