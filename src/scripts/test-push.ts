// Smoke test: fire act-now push to leader.
// Synthesizes a minimal Anomaly entity and asks the push service to send it.
// Outcome reasons:
//   not-act-now / already-notified / no-slack-token / no-slack-id-for-leader / postDM-failed / pushed=true

import { notifyActNowIfNew } from '../services/leader_push';
import type { Anomaly } from '../types/events';

const fake: Anomaly = {
  id: `anom_test_push_${Date.now()}`,
  rule: 'test.smoke',
  subject: { kind: 'system', ref: 'smoke' },
  status: 'open',
  severity_hint: 'act-now',
  triggered_at: new Date().toISOString(),
  last_seen_at: new Date().toISOString(),
  evidence_event_seqs: [],
  suggested_actions: [
    { id: 'dismiss', label: 'Dismiss this smoke test', tool: 'team:resolve' }
  ]
};

const outcome = await notifyActNowIfNew(fake);
console.log(JSON.stringify(outcome, null, 2));
