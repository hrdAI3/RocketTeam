// Leader push notifier.
// When the Anomaly Engine opens a new `act-now` anomaly, this fires a Slack
// DM to the leader so they see it without having to pull `team:today`.
//
// Idempotency: `data/sync_state/leader_push.json` keeps the set of anomaly ids
// already notified. The engine calls `notifyActNowIfNew` after every open;
// duplicate calls are no-ops.

import { readSyncState, writeSyncState } from '../lib/events';
import { getToken, postDM } from '../lib/slack';
import { reverseLookup } from '../lib/identity';
import type { Anomaly } from '../types/events';

const PUSH_STATE_KEY = 'leader_push';
const LEADER_NAME = process.env.LEADER_NAME ?? '安子岩';

interface PushState {
  notifiedIds: string[];
}

const SENDER_LABEL = process.env.PUSH_SENDER_LABEL ?? 'RocketTeam';

function formatMessage(anomaly: Anomaly): string {
  const subject =
    anomaly.subject.kind === 'agent' ? anomaly.subject.ref : `${anomaly.subject.kind}:${anomaly.subject.ref}`;
  const lines: string[] = [];
  lines.push(`🚀 *${SENDER_LABEL}* · CC 异常`);
  lines.push(`⚠️ *${anomaly.rule}* — ${subject}`);
  lines.push(`触发: ${anomaly.triggered_at}`);
  if (anomaly.evidence_event_seqs.length > 0) {
    lines.push(`证据 events: ${anomaly.evidence_event_seqs.slice(-5).join(', ')}`);
  }
  if (anomaly.suggested_actions.length > 0) {
    lines.push('');
    lines.push('可能的处理方向:');
    for (const s of anomaly.suggested_actions) {
      lines.push(`• ${s.label}`);
    }
  }
  lines.push('');
  lines.push('在 CC 里看详情: `team:today` 或 `team:status <成员>`。问那人最近在干啥: `team:ask <成员> "..."`。');
  return lines.join('\n');
}

async function loadState(): Promise<PushState> {
  return ((await readSyncState<PushState>(PUSH_STATE_KEY)) ?? { notifiedIds: [] }) as PushState;
}

async function saveState(state: PushState): Promise<void> {
  // Bound the set so we do not grow indefinitely. Keep last 500 ids — enough
  // to suppress repeats for weeks while not turning into an unbounded log.
  if (state.notifiedIds.length > 500) {
    state.notifiedIds = state.notifiedIds.slice(-500);
  }
  await writeSyncState(PUSH_STATE_KEY, state);
}

export interface PushOutcome {
  pushed: boolean;
  reason?: string;
}

export async function notifyActNowIfNew(anomaly: Anomaly): Promise<PushOutcome> {
  if (anomaly.severity_hint !== 'act-now') {
    return { pushed: false, reason: 'not-act-now' };
  }
  const state = await loadState();
  if (state.notifiedIds.includes(anomaly.id)) {
    return { pushed: false, reason: 'already-notified' };
  }
  const token = await getToken();
  if (!token) {
    return { pushed: false, reason: 'no-slack-token' };
  }
  // Look up the leader's Slack id from identity.json reverse map. If absent
  // we fall back to slack.resolveUserId by display name (already supported by
  // postDM).
  const reverse = await reverseLookup(LEADER_NAME);
  if (!reverse.slack && process.env.STRICT_LEADER_SLACK_ID === '1') {
    return { pushed: false, reason: 'no-slack-id-for-leader' };
  }
  const text = formatMessage(anomaly);
  const ok = await postDM(token, LEADER_NAME, text).catch((err) => {
    console.warn('[leader_push] postDM threw:', (err as Error).message);
    return false;
  });
  if (!ok) {
    return { pushed: false, reason: 'postDM-failed' };
  }
  state.notifiedIds.push(anomaly.id);
  await saveState(state);
  return { pushed: true };
}
