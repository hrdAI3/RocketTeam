// Anomaly Engine.
// Runs each rule, opens new anomalies, marks still-firing ones as 'seen',
// auto-resolves anomalies whose rule no longer fires, persists state.

import {
  reduceAnomalies,
  recordOpen,
  recordResolve,
  recordSeen,
  writeCurrentSnapshot
} from './store';
import { ALL_RULES, candidateKey, loadAllEvents, type Candidate } from './rules';
import { notifyActNowIfNew } from '../services/leader_push';
import type { Anomaly, AnomalyStatus } from '../types/events';

const REOPEN_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface EngineSummary {
  candidatesByRule: Record<string, number>;
  newlyOpened: number;
  stillSeen: number;
  autoResolved: number;
  currentOpen: number;
  pushed: number;
  pushSkipped: number;
}

function anomalyId(c: Candidate, ts: number): string {
  // Stable per (rule, subject, day). Same rule on the same subject within the
  // same day produces the same anomaly id — the engine then upgrades to 'seen'
  // instead of creating a duplicate.
  const dayKey = new Date(ts).toISOString().slice(0, 10);
  return `anom_${c.rule}_${c.subject.kind}_${c.subject.ref}_${dayKey}`.replace(/[^a-zA-Z0-9_:.-]/g, '_');
}

export async function evaluateAll(): Promise<EngineSummary> {
  const events = await loadAllEvents();
  const now = Date.now();
  const ctx = { events, now };

  const candidates: Candidate[] = [];
  const candidatesByRule: Record<string, number> = {};
  for (const [ruleName, fn] of Object.entries(ALL_RULES)) {
    try {
      const result = await fn(ctx);
      candidates.push(...result);
      candidatesByRule[ruleName] = result.length;
    } catch (err) {
      console.warn(`[anomaly] rule ${ruleName} failed:`, (err as Error).message);
      candidatesByRule[ruleName] = -1;
    }
  }

  const current = await reduceAnomalies();
  const openByKey = new Map<string, Anomaly>();
  for (const a of current.values()) {
    if (a.status === 'open' || a.status === 'snoozed') {
      openByKey.set(candidateKey(a), a);
    }
  }

  let newlyOpened = 0;
  let stillSeen = 0;
  let pushed = 0;
  let pushSkipped = 0;
  const stillFiringIds = new Set<string>();

  for (const c of candidates) {
    const k = candidateKey(c);
    const existing = openByKey.get(k);
    const triggeredMs = new Date(c.triggered_at).getTime();
    if (existing) {
      stillFiringIds.add(existing.id);
      await recordSeen(existing.id, c.evidence_event_seqs);
      stillSeen++;
    } else {
      const id = anomalyId(c, triggeredMs);
      if (current.has(id) && current.get(id)?.status === 'resolved') {
        // resolved within the same day → require new evidence to re-open
        const resolved = current.get(id)!;
        const lastSeenMs = new Date(resolved.last_seen_at).getTime();
        if (now - lastSeenMs < REOPEN_WINDOW_MS) continue;
      }
      const a: Anomaly = {
        id,
        rule: c.rule,
        subject: c.subject,
        status: 'open',
        severity_hint: c.severity_hint,
        triggered_at: c.triggered_at,
        last_seen_at: new Date(now).toISOString(),
        evidence_event_seqs: c.evidence_event_seqs,
        suggested_actions: c.suggested_actions
      };
      await recordOpen(a);
      stillFiringIds.add(id);
      newlyOpened++;
      // Fire act-now push to the leader. Best-effort, async, never throws —
      // if Slack is down or the leader has no slack identity mapped, the
      // engine still completes cleanly.
      try {
        const outcome = await notifyActNowIfNew(a);
        if (outcome.pushed) pushed++;
        else pushSkipped++;
      } catch (err) {
        console.warn('[anomaly] push failed:', (err as Error).message);
        pushSkipped++;
      }
    }
  }

  // Auto-resolve anomalies whose rule no longer fires.
  let autoResolved = 0;
  for (const a of openByKey.values()) {
    if (!stillFiringIds.has(a.id) && a.status === 'open') {
      await recordResolve(a.id, 'system', 'auto_cleared', 'rule no longer fires');
      autoResolved++;
    }
  }

  // Write snapshot.
  const refreshed = await reduceAnomalies();
  const open: Anomaly[] = [];
  for (const a of refreshed.values()) {
    const status: AnomalyStatus = a.status;
    if (status === 'open') open.push(a);
  }
  await writeCurrentSnapshot(open);

  return {
    candidatesByRule,
    newlyOpened,
    stillSeen,
    autoResolved,
    currentOpen: open.length,
    pushed,
    pushSkipped
  };
}
