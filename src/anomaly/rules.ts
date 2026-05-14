// Anomaly rules — pure functions that read events + state and emit candidate
// anomalies. Engine handles de-dupe / opening / resolving.
//
// Each rule returns a list of Candidate; engine matches by `keyHash` to avoid
// re-opening the same anomaly in a 24h window.

import { promises as fs } from 'node:fs';
import { PATHS } from '../lib/paths';
import { readAllEvents } from '../lib/events';
import type { Event, EventSubject, SuggestedAction, AnomalySeverityHint, Anomaly } from '../types/events';
import type { Task } from '../types/index';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export interface Candidate {
  rule: string;
  subject: EventSubject;
  severity_hint: AnomalySeverityHint;
  triggered_at: string;
  evidence_event_seqs: number[];
  suggested_actions: SuggestedAction[];
}

export interface RuleContext {
  events: Event[];
  now: number;
}

export type RuleFn = (ctx: RuleContext) => Promise<Candidate[]> | Candidate[];

// ============== override.spike ==============
//
// 7d override rate > 40% across all PMA decisions in window.
// Fires once per "spike window" — engine's 24h de-dupe handles repeats.

const OVERRIDE_RATE_THRESHOLD = 0.4;
const MIN_TOTAL = 3; // do not fire on tiny denominators

export const overrideSpike: RuleFn = ({ events, now }) => {
  const windowStart = now - 7 * DAY;
  const overrides = events.filter(
    (e) =>
      e.type === 'task.overridden' &&
      new Date(e.ts).getTime() >= windowStart
  );
  const accepts = events.filter(
    (e) => e.type === 'task.accepted' && new Date(e.ts).getTime() >= windowStart
  );
  const total = overrides.length + accepts.length;
  if (total < MIN_TOTAL) return [];
  const rate = overrides.length / total;
  if (rate < OVERRIDE_RATE_THRESHOLD) return [];
  return [
    {
      rule: 'override.spike',
      subject: { kind: 'system', ref: 'pma_decisions' },
      severity_hint: 'next-glance',
      triggered_at: new Date(now).toISOString(),
      evidence_event_seqs: overrides.map((e) => e.seq).slice(-10),
      suggested_actions: [
        {
          id: 'open_trend',
          label: 'View override trend',
          tool: 'open_url',
          args: { url: '/tasks?filter=overridden' }
        },
        {
          id: 'dismiss_week',
          label: 'Dismiss for the week',
          tool: 'team:resolve',
          args: { action: 'dismiss', outcome: 'dismiss_week' }
        }
      ]
    }
  ];
};

// ============== blocked.review_pending ==============
//
// PR review-requested but no review_submitted within 24h.
// Subject: pr (so de-dupe scopes per-PR).

export const blockedReviewPending: RuleFn = ({ events, now }) => {
  const threshold = now - 24 * HOUR;
  // Map review_requested → most recent ts per pr; then check if any review_submitted later.
  const requestedByPR = new Map<string, { ts: number; reviewer?: string; quote?: string; seq: number }>();
  const reviewedByPR = new Map<string, number>(); // last review_submitted ts
  for (const e of events) {
    if (e.subject.kind !== 'pr') continue;
    const t = new Date(e.ts).getTime();
    if (e.type === 'gh.review_requested') {
      const cur = requestedByPR.get(e.subject.ref);
      if (!cur || cur.ts < t) {
        requestedByPR.set(e.subject.ref, {
          ts: t,
          reviewer: (e.evidence.fields?.reviewer as string) ?? undefined,
          quote: e.evidence.quote,
          seq: e.seq
        });
      }
    } else if (e.type === 'gh.review_submitted') {
      const cur = reviewedByPR.get(e.subject.ref) ?? 0;
      if (cur < t) reviewedByPR.set(e.subject.ref, t);
    } else if (e.type === 'gh.pr_merged' || e.type === 'gh.pr_closed') {
      // PR is closed → no longer blocked. Mark as having a 'review'.
      reviewedByPR.set(e.subject.ref, t);
    }
  }
  const out: Candidate[] = [];
  for (const [prRef, req] of requestedByPR) {
    if (req.ts > threshold) continue; // not old enough
    const reviewedTs = reviewedByPR.get(prRef) ?? 0;
    if (reviewedTs >= req.ts) continue;
    out.push({
      rule: 'blocked.review_pending',
      subject: { kind: 'pr', ref: prRef },
      severity_hint: 'next-glance',
      triggered_at: new Date(req.ts).toISOString(),
      evidence_event_seqs: [req.seq],
      suggested_actions: [
        {
          id: 'ping_reviewer',
          label: req.reviewer ? `Ping ${req.reviewer}` : 'Ping reviewer',
          tool: 'team:ask',
          args: { agent: req.reviewer, question: `麻烦看一下 ${prRef}` }
        },
        {
          id: 'open_pr',
          label: 'Open PR',
          tool: 'open_url',
          args: { ref: prRef }
        }
      ]
    });
  }
  return out;
};

// ============== blocked.cc_attested ==============
//
// CC stuck signal in last 24h ∧ no commit / pr.merged on same agent within
// the same window. Subject: agent (per agent).

export const blockedCcAttested: RuleFn = ({ events, now }) => {
  const windowStart = now - 24 * HOUR;
  const stuckByAgent = new Map<string, Event[]>();
  const progressByAgent = new Map<string, number>(); // latest commit / pr_merged ts
  for (const e of events) {
    if (e.subject.kind !== 'agent') continue;
    const t = new Date(e.ts).getTime();
    if (t < windowStart) continue;
    if (e.type === 'cc.stuck_signal') {
      const list = stuckByAgent.get(e.subject.ref) ?? [];
      list.push(e);
      stuckByAgent.set(e.subject.ref, list);
    } else if (e.type === 'gh.commit_pushed' || e.type === 'gh.pr_merged') {
      const cur = progressByAgent.get(e.actor ?? e.subject.ref) ?? 0;
      if (cur < t) progressByAgent.set(e.actor ?? e.subject.ref, t);
    }
  }
  const out: Candidate[] = [];
  for (const [agent, stucks] of stuckByAgent) {
    const lastStuck = Math.max(...stucks.map((s) => new Date(s.ts).getTime()));
    const lastProgress = progressByAgent.get(agent) ?? 0;
    if (lastProgress > lastStuck) continue; // they've moved on
    const newest = stucks[stucks.length - 1];
    out.push({
      rule: 'blocked.cc_attested',
      subject: { kind: 'agent', ref: agent },
      severity_hint: 'act-now',
      triggered_at: new Date(lastStuck).toISOString(),
      evidence_event_seqs: stucks.map((s) => s.seq),
      suggested_actions: [
        {
          id: 'ask_agent',
          label: `Ask ${agent}`,
          tool: 'team:ask',
          args: { agent, question: newest.evidence.quote ?? '你那边阻塞具体卡在哪？' }
        },
        {
          id: 'reassign',
          label: 'Reassign',
          tool: 'team:resolve',
          args: { action: 'reassign' }
        }
      ]
    });
  }
  return out;
};

// ============== dispatch.uncertain ==============
//
// Reads tasks/*.json directly. A task with status=predicted and a sim decision
// confidence < 60% that is older than the spec's "pending lag" threshold (e.g.
// 30 min — leader had time to look) becomes an anomaly.

const PENDING_LAG_MIN = 30;

export const dispatchUncertain: RuleFn = async () => {
  let entries: string[];
  try {
    entries = await fs.readdir(PATHS.tasks);
  } catch {
    return [];
  }
  const out: Candidate[] = [];
  const now = Date.now();
  for (const fname of entries) {
    if (!fname.endsWith('.json')) continue;
    try {
      const raw = await fs.readFile(`${PATHS.tasks}/${fname}`, 'utf8');
      const t = JSON.parse(raw) as Task;
      if (t.status !== 'predicted') continue;
      const decision = t.decision as { confidence?: number } | undefined;
      const conf = decision?.confidence;
      if (typeof conf !== 'number') continue;
      if (conf >= 0.6) continue;
      const ageMin = (now - new Date(t.updated_at ?? t.created_at).getTime()) / 60_000;
      if (ageMin < PENDING_LAG_MIN) continue;
      out.push({
        rule: 'dispatch.uncertain',
        subject: { kind: 'task', ref: t.id },
        severity_hint: 'act-now',
        triggered_at: new Date(t.updated_at ?? t.created_at).toISOString(),
        evidence_event_seqs: [],
        suggested_actions: [
          {
            id: 'accept_top1',
            label: 'Accept PMA top pick',
            tool: 'team:resolve',
            args: { action: 'accept', task_id: t.id }
          },
          {
            id: 'open_sim',
            label: 'Open sim',
            tool: 'open_url',
            args: { ref: `/sim/${t.sim_id}` }
          }
        ]
      });
    } catch {
      // skip corrupted task
    }
  }
  return out;
};

// ============== danger.command ==============
//
// Scans cc.tool_called Bash commands (quote field holds the command text) for
// destructive / risky patterns: rm -rf, force push, prod targets, secrets.
// Fires per agent per pattern-class within the dedupe window.

// Only the genuinely catastrophic shapes. `rm -rf <some-dir>` is everyday dev
// housekeeping (build caches, failed clones, worktrees) — flagging it just
// trains the leader to ignore the alert. Flag `rm -rf` only when the target is
// the filesystem root / home / cwd / a wildcard.
const DANGER_PATTERNS: Array<{ id: string; label: string; re: RegExp }> = [
  {
    id: 'rm_rf_dangerous',
    label: 'rm -rf 根目录 / home / 当前目录',
    re: /\brm\s+(?:-[a-zA-Z]*\s+)*-?[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\b\s+(?:-[a-zA-Z]+\s+)*["']?(?:\/(?:\s|$|["';&|])|~(?:\s|$|\/|["';&|])|\$HOME\b|\$PWD\b|\.(?:\s|$|["';&|])|\*(?:\s|$|["';&|])|[A-Za-z]:[\\/]?(?:\s|$|["';&|]))/i
  },
  // Force-pushing a feature branch (esp. with --force-with-lease, after a
  // rebase) is routine and safe — not leader-actionable. Only flag a force-push
  // that names a protected branch (main / master / prod / release). `git reset
  // --hard` is intentionally NOT flagged: agents discard local changes with it
  // constantly; at worst it loses uncommitted work, which the agent notices.
  {
    id: 'force_push_protected',
    label: 'force-push 到 main / master',
    re: /git\s+push\b[^\n]*(--force\b|-f\b|--force-with-lease\b)[^\n]*\b(main|master|prod|production|release)\b|git\s+push\b[^\n]*\b(origin\s+)?(main|master|prod|production|release)\b[^\n]*(--force\b|-f\b|--force-with-lease\b)/
  },
  { id: 'prod_target', label: '操作 prod', re: /\b(prod|production)\b[^\n]*\b(deploy|kubectl|migrate|drop|delete|truncate)\b|\b(kubectl|psql|mysql)\b[^\n]*\bprod\b/i },
  { id: 'secret_echo', label: '命令里出现密钥', re: /\b(API_KEY|SECRET|TOKEN|PASSWORD|PRIVATE_KEY)\s*=\s*['"]?[A-Za-z0-9_\-]{12,}/ },
  { id: 'drop_table', label: 'DROP TABLE / DELETE FROM', re: /\b(DROP\s+TABLE|DELETE\s+FROM|TRUNCATE\s+TABLE)\b/i }
];

export const dangerCommand: RuleFn = ({ events, now }) => {
  const windowStart = now - 24 * HOUR;
  // group hits by agent → set of pattern ids, keep the most recent matching event
  const byAgent = new Map<string, Map<string, { ts: number; seq: number; quote: string }>>();
  for (const e of events) {
    if (e.type !== 'cc.tool_called') continue;
    if ((e.evidence.fields?.tool as string) !== 'Bash') continue;
    const cmd = e.evidence.quote;
    if (!cmd) continue;
    const t = new Date(e.ts).getTime();
    if (t < windowStart) continue;
    const agent = e.subject.ref;
    for (const p of DANGER_PATTERNS) {
      if (p.re.test(cmd)) {
        let m = byAgent.get(agent);
        if (!m) {
          m = new Map();
          byAgent.set(agent, m);
        }
        const cur = m.get(p.id);
        if (!cur || cur.ts < t) m.set(p.id, { ts: t, seq: e.seq, quote: cmd.slice(0, 120) });
      }
    }
  }
  const out: Candidate[] = [];
  for (const [agent, pats] of byAgent) {
    for (const [patId, hit] of pats) {
      const meta = DANGER_PATTERNS.find((p) => p.id === patId)!;
      out.push({
        rule: `danger.command.${patId}`,
        subject: { kind: 'agent', ref: agent },
        severity_hint: 'act-now',
        triggered_at: new Date(hit.ts).toISOString(),
        evidence_event_seqs: [hit.seq],
        suggested_actions: [
          { id: 'ask_agent', label: `问 ${agent} 这条命令`, tool: 'team:ask', args: { agent, question: `你跑了 \`${hit.quote}\`，确认一下是有意的？` } }
        ]
      });
    }
  }
  return out;
};

// ============== silence.dormant ==============
//
// Agent has CC activity in the last 30 days but nothing in the last 3 days,
// AND has open workload (workload.active) — i.e. they should be doing something
// but their CC has gone quiet. Without the workload gate every dormant agent
// would fire; with it, only the ones with an assignment on the books.

const DORMANT_DAYS = 3;

export const silenceDormant: RuleFn = async ({ events, now }) => {
  const lastByAgent = new Map<string, number>();
  for (const e of events) {
    if (e.subject.kind !== 'agent') continue;
    if (e.source !== 'cc_session') continue;
    const t = new Date(e.ts).getTime();
    const cur = lastByAgent.get(e.subject.ref) ?? 0;
    if (t > cur) lastByAgent.set(e.subject.ref, t);
  }
  const dormantThreshold = now - DORMANT_DAYS * DAY;
  const staleThreshold = now - 30 * DAY;
  const out: Candidate[] = [];
  for (const [agent, lastTs] of lastByAgent) {
    if (lastTs >= dormantThreshold) continue; // still active recently
    if (lastTs < staleThreshold) continue; // hasn't been active for over a month — not "newly dormant"
    if (agent.startsWith('unknown:')) continue;
    // workload gate: only fire if the agent's profile shows an open assignment.
    let hasOpenWork = false;
    try {
      const raw = await fs.readFile(`${PATHS.agents}/${agent}.json`, 'utf8');
      const profile = JSON.parse(raw) as { workload?: { active?: unknown[] } };
      hasOpenWork = (profile.workload?.active?.length ?? 0) > 0;
    } catch {
      hasOpenWork = false;
    }
    if (!hasOpenWork) continue;
    out.push({
      rule: 'silence.dormant',
      subject: { kind: 'agent', ref: agent },
      severity_hint: 'next-glance',
      triggered_at: new Date(lastTs).toISOString(),
      evidence_event_seqs: [],
      suggested_actions: [
        { id: 'ask_agent', label: `问 ${agent} 进展`, tool: 'team:ask', args: { agent, question: '你手头那个任务现在怎么样？CC 这边几天没动静了。' } }
      ]
    });
  }
  return out;
};

// Engine rules disabled — the only anomaly the leader wants right now is the
// 7d quota pace projection (live, computed in src/services/cc_status.ts ::
// liveConcerns). Keep the rule implementations above so we can re-enable any
// of them later, but the engine wires up none of them.
export const ALL_RULES: Record<string, RuleFn> = {};
void overrideSpike;
void blockedReviewPending;
void blockedCcAttested;
void dispatchUncertain;
void dangerCommand;
void silenceDormant;

// Helper for de-dupe — engine uses (rule + subject.ref) as key.
export function candidateKey(c: { rule: string; subject: EventSubject }): string {
  return `${c.rule}::${c.subject.kind}::${c.subject.ref}`;
}

export async function loadAllEvents(): Promise<Event[]> {
  return readAllEvents();
}

// Re-export for engine convenience.
export type { Anomaly };
