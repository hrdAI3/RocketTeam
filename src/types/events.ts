// Unified event timeline + Anomaly entity.
// Source of truth for the new 4-source ingest → Anomaly Engine → team:today pipeline.
// See: docs/superpowers/specs/2026-05-11-anomaly-engine-cc-native-design.md §3, §5.

// ============== Event ==============

export type EventSource =
  | 'github'
  | 'slack'
  | 'meeting'
  | 'cc_session'
  | 'system'
  | 'leader';

export type EventSubjectKind =
  | 'agent'
  | 'task'
  | 'sim'
  | 'repo'
  | 'channel'
  | 'meeting'
  | 'pr'
  | 'session'
  | 'anomaly'
  | 'system';

export interface EventSubject {
  kind: EventSubjectKind;
  ref: string;
}

export interface EventEvidence {
  quote?: string;
  fields?: Record<string, unknown>;
}

export interface Event {
  seq: number;
  ts: string; // ISO8601
  source: EventSource;
  type: string;
  subject: EventSubject;
  actor?: string;
  evidence: EventEvidence;
  raw_ref?: string;
}

// Catalogue of well-known event types. Use string for the Event.type field so
// extractors can emit new variants without a schema migration, but reference
// these constants where possible.
export const EVENT_TYPE = {
  // GitHub
  GH_PR_OPENED: 'gh.pr_opened',
  GH_PR_MERGED: 'gh.pr_merged',
  GH_PR_CLOSED: 'gh.pr_closed',
  GH_REVIEW_REQUESTED: 'gh.review_requested',
  GH_REVIEW_SUBMITTED: 'gh.review_submitted',
  GH_COMMIT_PUSHED: 'gh.commit_pushed',
  GH_CI_FAILED: 'gh.ci_failed',

  // Slack
  SLACK_MENTION: 'slack.mention',
  SLACK_QUESTION_UNANSWERED: 'slack.question_unanswered',
  SLACK_CHANNEL_ACTIVITY: 'slack.channel_activity',

  // Meeting
  MEETING_ACTION_ITEM: 'meeting.action_item',
  MEETING_NAME_MENTIONED: 'meeting.name_mentioned',
  MEETING_DECISION: 'meeting.decision',

  // CC SESSIONS
  CC_SESSION_STARTED: 'cc.session_started',
  CC_SESSION_ENDED: 'cc.session_ended',
  CC_TOKEN_USAGE: 'cc.token_usage',
  CC_TOOL_CALLED: 'cc.tool_called',
  CC_STUCK_SIGNAL: 'cc.stuck_signal',
  CC_TOPIC_EXTRACTED: 'cc.topic_extracted',
  CC_RAW_BLOB: 'cc.raw_blob', // unknown line shapes, defensive fallback

  // System / task lifecycle
  TASK_CREATED: 'task.created',
  TASK_DISPATCHED: 'task.dispatched',
  TASK_ACCEPTED: 'task.accepted',
  TASK_OVERRIDDEN: 'task.overridden',
  TASK_COMPLETED: 'task.completed',
  SIM_PREDICTED: 'sim.predicted',
  SIM_COMMITTED: 'sim.committed',
  AGENT_EVOLVED: 'agent.evolved',

  // Anomaly state machine
  ANOMALY_OPENED: 'anomaly.opened',
  ANOMALY_SNOOZED: 'anomaly.snoozed',
  ANOMALY_RESOLVED: 'anomaly.resolved',
  ANOMALY_DISMISSED: 'anomaly.dismissed',

  // Source health
  SOURCE_ERROR: 'system.source_error'
} as const;

// ============== Anomaly ==============

export type AnomalySeverityHint = 'act-now' | 'next-glance' | 'fyi';
export type AnomalyStatus = 'open' | 'snoozed' | 'resolved' | 'dismissed';

export interface SuggestedAction {
  id: string;
  label: string;
  tool: string; // MCP tool name
  args?: Record<string, unknown>;
}

export interface Anomaly {
  id: string;
  rule: string;
  subject: EventSubject;
  status: AnomalyStatus;
  severity_hint: AnomalySeverityHint;
  triggered_at: string;
  last_seen_at: string;
  evidence_event_seqs: number[];
  suggested_actions: SuggestedAction[];
  snoozed_until?: string;
  resolution?: {
    action: string;
    by: 'leader' | 'system';
    at: string;
    outcome?: string;
  };
}
