// §2.4.2 — anomaly → project attribution.
//
// Anomalies don't carry a projectId of their own (they're rule-triggered, not
// LLM-derived), so we look one up from the event that fired the rule. Two
// fallback paths, both cheap (no LLM):
//
//   Step 1. Anomaly has `evidence_event_seqs`. Pull the most recent event from
//           the seq index; pluck cwd; query `lookupProjectByCwd`. If hit, done.
//   Step 2. Anomaly is agent-subjected and the roster knows that agent's
//           current cwd. Same lookup. Covers live-derived anomalies whose
//           `evidence_event_seqs` is empty (e.g. quota.pace_7d).
//   Step 3. Nothing matched → null → caller renders the anomaly at the top
//           level. Spec §2.4.2 explicitly calls this the "safe failure
//           direction" — better unattributed than wrongly attributed.
//
// A small whitelist of rules ALWAYS goes to top level regardless (config /
// quota / danger / dispatch override), per §2.4.1.

import { getEventBySeq } from '../lib/events';
import { lookupProjectByCwd } from '../lib/projects';
import type { Anomaly } from '../types/events';

export type AttributionReason =
  | 'top-level'
  | 'cwd-from-event'
  | 'cwd-from-current-session'
  | 'unknown';

export interface AttributionResult {
  projectId: string | null;
  reason: AttributionReason;
}

// Rules that always go top-level. Configuration-like, intentional — leader
// shouldn't see "quota.pace_7d on project Foo" because quota is per-person,
// not per-project. Likewise danger commands and dispatch issues are about the
// flow, not the project they happened in.
const TOP_LEVEL_RULES: ReadonlySet<string> = new Set([
  'override.spike',
  'quota.near_5h',
  'quota.near_7d',
  'quota.pace_5h',
  'quota.pace_7d',
  'context.near_full'
]);

function isTopLevelRule(rule: string): boolean {
  if (TOP_LEVEL_RULES.has(rule)) return true;
  if (rule.startsWith('danger.command.')) return true;
  return false;
}

export interface AgentCwdLookup {
  // Map of agent name → that agent's current session cwd, if any. Built by
  // the caller from `getRosterView().roster`. Optional — when missing the
  // attribution falls through to step 3.
  cwdByAgent?: Map<string, string | null | undefined>;
}

export async function attributeAnomalyToProject(
  anomaly: Anomaly,
  lookup: AgentCwdLookup = {}
): Promise<AttributionResult> {
  if (isTopLevelRule(anomaly.rule)) {
    return { projectId: null, reason: 'top-level' };
  }
  // Step 1: walk evidence_event_seqs from the tail; take the first event with
  // a cwd field that resolves to a registered project.
  const seqs = anomaly.evidence_event_seqs;
  for (let i = seqs.length - 1; i >= 0; i--) {
    const seq = seqs[i];
    if (typeof seq !== 'number') continue;
    const ev = await getEventBySeq(seq);
    if (!ev) continue;
    const cwd = typeof ev.evidence.fields?.cwd === 'string' ? ev.evidence.fields.cwd : '';
    if (!cwd) continue;
    const pid = await lookupProjectByCwd(cwd);
    if (pid) return { projectId: pid, reason: 'cwd-from-event' };
  }
  // Step 2: agent-subjected → check the roster's current cwd.
  if (anomaly.subject.kind === 'agent' && lookup.cwdByAgent) {
    const cwd = lookup.cwdByAgent.get(anomaly.subject.ref);
    if (typeof cwd === 'string' && cwd.length > 0) {
      const pid = await lookupProjectByCwd(cwd);
      if (pid) return { projectId: pid, reason: 'cwd-from-current-session' };
    }
  }
  return { projectId: null, reason: 'unknown' };
}
