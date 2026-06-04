// PMA v2 · L1 Behavior Index.
//
// Aggregates the unified event timeline into per-agent AgentBehaviorSnapshot.
// Pure functions. Synchronous. Input is already-loaded events array.
//
// First cut focuses on CC data (which has resolved actor names). Slack /
// meeting / GitHub fields are scaffolded but populated only when identity
// mappings exist (private/identity.json {slack:{}, github:{}}). Today those
// maps are empty for rocket team → those fields stay at neutral defaults.
//
// Snapshots are by design idempotent given (events, asOf, windowDays) — they
// can be rebuilt nightly and historical snapshots replayed for calibration.

import type { Event } from '../types/events';

export type EnergyLevel = 'high' | 'normal' | 'low' | 'burnt' | 'unknown';

export interface StuckTopic {
  topic: string;
  count: number;
  sources: Array<'cc' | 'gh' | 'slack' | 'meeting'>;
  last_at: string;
  sample_quote: string;
}

export interface CollabEdgeWeights {
  gh_coauthor: number;
  gh_review_back_forth: number;
  slack_mention: number;
  slack_reaction: number;
  meeting_co_attended: number;
}

export interface CollabPair {
  with: string;
  success_rate: number;
  n: number;
  edge_weights: CollabEdgeWeights;
}

export interface GhScope {
  avg_loc_per_pr: number;
  dirs_touched: Record<string, number>;
  ci_failure_rate: number;
  avg_review_comments_per_pr: number;
}

export interface SlackSignals {
  avg_response_latency_min: number;
  unanswered_to_me: number;
  decisions_authored: number;
  reaction_received_rate: number;
}

export interface MeetingSignals {
  attendance_rate: number;
  speaker_dominance_p50: number;
  action_items_owned: number;
  decisions_authored: number;
  name_mention_received: number;
}

export interface QuotaState {
  used_cny: number;
  limit_cny: number;
  period_resets_at: string;
  headroom_ratio: number; // 1.0 if no data
}

export interface TaskOutcomes {
  n_completed: number;
  n_aborted: number;
  n_reworked: number;
  duration_p50_days: number;
  duration_p90_days: number;
  rework_rate: number;
}

export interface CurrentProject {
  name: string;          // leaf directory of cwd, e.g. "Maya" or "TeamBrain"
  event_count: number;   // CC tool_called events with this cwd
  session_count: number;
  active_days: number;
  last_at: string;
  // Sample paths so the leader can sanity-check the inferred name.
  sample_cwd: string;
}

export interface AgentBehaviorSnapshot {
  agent_name: string;
  window_days: 30 | 90;
  as_of: string;

  // CC source (rich)
  tool_usage: Record<string, number>;
  tool_failure_rate: Record<string, number>; // 0 until cc.tool_result lands
  tool_vector_keys: string[];
  tool_vector_normalized: number[];

  // What the agent is actively working on, derived from cc cwd. The strongest
  // "what's on their plate" signal we have — much more concrete than
  // profile.workload which is hand-curated and goes stale.
  current_projects: CurrentProject[];

  stuck_topics: StuckTopic[];

  task_outcomes: TaskOutcomes;
  collab_pairs: CollabPair[];

  gh_scope: GhScope;
  slack_signals: SlackSignals;
  meeting_signals: MeetingSignals;
  quota: QuotaState;

  energy_inferred: EnergyLevel;

  // Provenance — for debugging/UI
  n_events_used: number;
  n_sessions: number;
  cc_tokens_input: number;
  cc_tokens_output: number;
  cc_tokens_per_hour_p50: number;
  active_days_in_window: number;
  index_version: string;
}

// Canonical tool list. New tools are appended; order is stable so vector
// comparisons across snapshots remain meaningful.
export const CANONICAL_TOOLS: string[] = [
  'Bash',
  'Edit',
  'Read',
  'Write',
  'Grep',
  'Glob',
  'WebFetch',
  'WebSearch',
  'Task',
  'Skill',
  'NotebookEdit',
  'TodoWrite',
  'BashOutput',
  'KillShell',
  'ExitPlanMode',
  'AskUserQuestion',
  'MultiEdit',
  'NotebookRead'
];

// Stuck topic keyword map. Each cc.stuck_signal.evidence.quote is matched
// against these regexes; matched topic names become StuckTopic.topic.
// Multiple topics may fire on one quote; counted once per topic per event.
const STUCK_TOPIC_KEYWORDS: Array<{ topic: string; re: RegExp }> = [
  { topic: 'permission', re: /权限|permission|forbidden|unauthorized|403/i },
  { topic: 'auth', re: /认证|登录|sign[\s-]?in|log[\s-]?in|credential|token|api[\s_-]?key|oauth/i },
  { topic: 'network', re: /网络|超时|timeout|connection|refused|unreachable|dns|proxy/i },
  { topic: 'docker', re: /docker|容器|container|compose|dockerfile|k8s|kubernetes/i },
  { topic: 'aws', re: /aws|amazon|s3|iam|ec2|lambda|cloudfront/i },
  { topic: 'env', re: /环境变量|env\s|\.env\b|环境配置/i },
  { topic: 'install', re: /安装|install\b|npm\s+install|yarn\s|pip\s|cargo\s|brew\s+install|apt\s+install/i },
  { topic: 'database', re: /数据库|mysql|postgres|mongo|sqlite|sql\s|table|schema/i },
  { topic: 'build', re: /编译|build\b|compile|webpack|tsc\b|vite|bundler/i },
  { topic: 'deploy', re: /部署|deploy|发布上线|publish.*prod|production.*deploy/i },
  { topic: 'types', re: /类型错误|type[\s_]?error|typescript|tsc|无法分配类型/i },
  { topic: 'ssh', re: /\bssh\b|远程登录|remote\s+login|host key/i },
  { topic: 'git', re: /git\s+(?:push|pull|merge|rebase)|conflict|分支冲突/i },
  { topic: 'access', re: /\bcannot\s+access\b|无法访问|file\s+not\s+found|no such file/i }
];

const INDEX_VERSION = 'behavior.v1.2.0-cc-meeting-projects';

// Directory names that should NEVER be treated as project names — too generic
// to be discriminative when they appear as the leaf of a cwd.
const NON_PROJECT_DIR_NAMES = new Set([
  '', '.', '..', 'src', 'lib', 'app', 'test', 'tests', 'node_modules',
  'dist', 'build', 'public', 'static', 'home', 'Desktop', 'Documents',
  'Downloads', 'Users', 'C:', 'D:', 'E:', 'F:', 'tmp', 'temp', 'workspace',
  'projects', 'code', 'work', 'repo', 'repos', 'git', 'github',
  'one', '001', 'main', 'master', 'dev', 'develop', 'feature', 'feat',
  'fix', 'bugfix', 'chore', 'docs', 'doc'
]);

// === Public entry ===

export interface BuildSnapshotsArgs {
  events: Event[];
  agentNames: string[];
  asOf: Date;
  windowDays: 30 | 90;
  // Optional name aliases per agent (e.g. profile.transcript_misspellings).
  // Used to attribute meeting/slack quotes that mention partial names.
  aliases?: Record<string, string[]>;
}

export function buildSnapshots(
  args: BuildSnapshotsArgs
): Map<string, AgentBehaviorSnapshot> {
  const { events, agentNames, asOf, windowDays, aliases } = args;
  const windowStartTs = new Date(
    asOf.getTime() - windowDays * 86400000
  ).toISOString();
  const asOfTs = asOf.toISOString();

  const knownAgents = new Set(agentNames);
  const byAgent = new Map<string, Event[]>();
  for (const name of agentNames) byAgent.set(name, []);

  // Pre-build alias → canonical name reverse map (lowercase for matching).
  // Canonical name always aliases to itself.
  const aliasToName = new Map<string, string>();
  for (const name of agentNames) aliasToName.set(name.toLowerCase(), name);
  if (aliases) {
    for (const [name, aliasList] of Object.entries(aliases)) {
      if (!knownAgents.has(name)) continue;
      for (const a of aliasList) {
        if (a && a.length >= 2) aliasToName.set(a.toLowerCase(), name);
      }
    }
  }

  const meetingByAgent = new Map<string, Event[]>();
  const slackByAgent = new Map<string, Event[]>();
  // Mentions where the agent is the target (subject.ref = agent name).
  const slackMentionsReceived = new Map<string, number>();
  for (const name of agentNames) {
    meetingByAgent.set(name, []);
    slackByAgent.set(name, []);
    slackMentionsReceived.set(name, 0);
  }

  for (const e of events) {
    if (e.ts < windowStartTs) continue;
    if (e.ts > asOfTs) continue;

    // Primary path: actor-attributed events (CC + Slack with mapped author).
    const actor = e.actor;
    if (actor && knownAgents.has(actor)) {
      if (e.source === 'slack') slackByAgent.get(actor)!.push(e);
      else byAgent.get(actor)!.push(e);
    }

    // Slack mention target — count for "name_mention_received" equivalent.
    if (e.source === 'slack' && e.type === 'slack.mention') {
      const target = e.subject?.ref;
      if (target && knownAgents.has(target)) {
        slackMentionsReceived.set(target, (slackMentionsReceived.get(target) ?? 0) + 1);
      }
    }

    // Cross-source path: meeting events reference people via subject.ref or
    // evidence.fields.owner. Attribute by alias match.
    if (e.source === 'meeting') {
      const matched = matchMeetingAgent(e, aliasToName);
      for (const name of matched) meetingByAgent.get(name)!.push(e);
    }
  }

  const out = new Map<string, AgentBehaviorSnapshot>();
  for (const name of agentNames) {
    out.set(
      name,
      buildOne(
        name,
        byAgent.get(name) ?? [],
        meetingByAgent.get(name) ?? [],
        slackByAgent.get(name) ?? [],
        slackMentionsReceived.get(name) ?? 0,
        asOfTs,
        windowDays
      )
    );
  }
  return out;
}

// Match a meeting event to one or more team-member agents. Checks:
//   - subject.ref against alias map (exact lowercase)
//   - evidence.fields.owner against alias map
//   - evidence.quote substring contains alias
function matchMeetingAgent(e: Event, aliasToName: Map<string, string>): string[] {
  const hits = new Set<string>();
  const subjRef = e.subject?.ref;
  if (subjRef) {
    const n = aliasToName.get(subjRef.toLowerCase());
    if (n) hits.add(n);
  }
  const fields = (e.evidence?.fields ?? {}) as Record<string, unknown>;
  const owner = typeof fields.owner === 'string' ? (fields.owner as string) : null;
  if (owner) {
    const n = aliasToName.get(owner.toLowerCase());
    if (n) hits.add(n);
  }
  const quote = e.evidence?.quote;
  if (quote) {
    const lower = quote.toLowerCase();
    for (const [alias, name] of aliasToName) {
      // require alias ≥ 2 chars to avoid spurious single-char hits; alias map
      // already filters that, but be defensive.
      if (alias.length >= 2 && lower.includes(alias)) hits.add(name);
    }
  }
  return Array.from(hits);
}

function buildOne(
  name: string,
  evts: Event[],
  meetingEvts: Event[],
  slackEvts: Event[],
  slackMentionsReceived: number,
  asOf: string,
  windowDays: 30 | 90
): AgentBehaviorSnapshot {
  const tool_usage = aggregateToolUsage(evts);
  const stuck_topics = extractStuckTopics(evts);
  const tokenStats = aggregateTokens(evts);
  const sessionStats = countSessions(evts);
  const activeDays = countActiveDays(evts);
  const meeting_signals = aggregateMeetingSignals(meetingEvts);
  const slack_signals = aggregateSlackSignals(slackEvts, slackMentionsReceived);
  const current_projects = extractCurrentProjects(evts);
  const energy_inferred = inferEnergy({
    evts,
    asOf,
    stuck_count: stuck_topics.reduce((a, t) => a + t.count, 0),
    tokens_per_hour_p50: tokenStats.cc_tokens_per_hour_p50,
    activeDays,
    windowDays
  });

  return {
    agent_name: name,
    window_days: windowDays,
    as_of: asOf,

    tool_usage,
    tool_failure_rate: {},
    tool_vector_keys: CANONICAL_TOOLS,
    tool_vector_normalized: toToolVector(tool_usage),

    current_projects,

    stuck_topics,

    task_outcomes: zeroTaskOutcomes(),
    collab_pairs: [],

    gh_scope: zeroGhScope(),
    slack_signals,
    meeting_signals,
    quota: { used_cny: 0, limit_cny: 0, period_resets_at: '', headroom_ratio: 1 },

    energy_inferred,

    n_events_used: evts.length + meetingEvts.length,
    n_sessions: sessionStats.n_sessions,
    cc_tokens_input: tokenStats.cc_tokens_input,
    cc_tokens_output: tokenStats.cc_tokens_output,
    cc_tokens_per_hour_p50: tokenStats.cc_tokens_per_hour_p50,
    active_days_in_window: activeDays,
    index_version: INDEX_VERSION
  };
}

export function aggregateMeetingSignals(meetingEvts: Event[]): MeetingSignals {
  let action_items_owned = 0;
  let decisions_authored = 0;
  let name_mention_received = 0;
  const meetingsAttended = new Set<string>();

  for (const e of meetingEvts) {
    if (e.type === 'meeting.action_item') action_items_owned += 1;
    else if (e.type === 'meeting.decision') decisions_authored += 1;
    else if (e.type === 'meeting.name_mentioned') name_mention_received += 1;
    const meetingId =
      ((e.evidence?.fields ?? {}) as Record<string, unknown>).meeting ??
      ((e.evidence?.fields ?? {}) as Record<string, unknown>).file;
    if (typeof meetingId === 'string') meetingsAttended.add(meetingId);
  }
  // attendance_rate: distinct meetings touched / total team meetings is
  // unknown here without a global meeting count. Use a proxy: clamp at 1.0
  // when the agent appeared in 5+ meetings.
  const attendance_rate = Math.min(1, meetingsAttended.size / 5);
  // speaker_dominance — not computable without per-speaker char counts.
  // Leave 0 until meeting.speaker_time event lands.
  return {
    attendance_rate,
    speaker_dominance_p50: 0,
    action_items_owned,
    decisions_authored,
    name_mention_received
  };
}

// === Pure aggregators ===

export function extractCurrentProjects(evts: Event[]): CurrentProject[] {
  // Group cc tool events by inferred project name = the leaf segment of cwd,
  // skipping generic dir names (src, dist, etc.). Returns top 5 by event count.
  const acc = new Map<
    string,
    {
      count: number;
      sessions: Set<string>;
      days: Set<string>;
      last_at: string;
      sample_cwd: string;
    }
  >();
  for (const e of evts) {
    if (e.type !== 'cc.tool_called') continue;
    const fields = (e.evidence?.fields ?? {}) as Record<string, unknown>;
    const cwd = typeof fields.cwd === 'string' ? (fields.cwd as string) : '';
    if (!cwd) continue;
    const name = inferProjectName(cwd);
    if (!name) continue;
    const sid = typeof fields.sessionId === 'string' ? (fields.sessionId as string) : '';
    const day = e.ts.slice(0, 10);
    let row = acc.get(name);
    if (!row) {
      row = { count: 0, sessions: new Set(), days: new Set(), last_at: e.ts, sample_cwd: cwd };
      acc.set(name, row);
    }
    row.count += 1;
    if (sid) row.sessions.add(sid);
    row.days.add(day);
    if (e.ts > row.last_at) row.last_at = e.ts;
  }
  return Array.from(acc.entries())
    .map(([name, v]) => ({
      name,
      event_count: v.count,
      session_count: v.sessions.size,
      active_days: v.days.size,
      last_at: v.last_at,
      sample_cwd: v.sample_cwd
    }))
    .sort((a, b) => b.event_count - a.event_count)
    .slice(0, 5);
}

function inferProjectName(cwd: string): string | null {
  // Normalize Windows + POSIX separators; walk leaf → root, skip generic names.
  const parts = cwd
    .replace(/\\/g, '/')
    .split('/')
    .filter((p) => p.length > 0);
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    if (NON_PROJECT_DIR_NAMES.has(p)) continue;
    // Skip absolute disk roots / pure numbers
    if (/^[A-Z]:$/i.test(p)) continue;
    if (/^\d+$/.test(p)) continue;
    if (p.length < 2) continue;
    return p;
  }
  return null;
}

export function aggregateToolUsage(evts: Event[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const e of evts) {
    if (e.type !== 'cc.tool_called') continue;
    const tool = e.evidence?.fields?.tool as string | undefined;
    if (!tool) continue;
    counts[tool] = (counts[tool] ?? 0) + 1;
  }
  return counts;
}

export function toToolVector(usage: Record<string, number>): number[] {
  const v = CANONICAL_TOOLS.map((t) => usage[t] ?? 0);
  // L2 normalize
  const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0));
  if (norm === 0) return v.map(() => 0);
  return v.map((x) => x / norm);
}

export function extractStuckTopics(evts: Event[]): StuckTopic[] {
  const map = new Map<
    string,
    { count: number; last_at: string; sample_quote: string }
  >();
  for (const e of evts) {
    if (e.type !== 'cc.stuck_signal') continue;
    const quote = e.evidence?.quote ?? '';
    if (!quote) continue;
    for (const { topic, re } of STUCK_TOPIC_KEYWORDS) {
      if (!re.test(quote)) continue;
      const cur = map.get(topic);
      if (!cur) {
        map.set(topic, { count: 1, last_at: e.ts, sample_quote: quote.slice(0, 200) });
      } else {
        cur.count += 1;
        if (e.ts > cur.last_at) {
          cur.last_at = e.ts;
          cur.sample_quote = quote.slice(0, 200);
        }
      }
    }
  }
  // Sort by count desc, top 20.
  return Array.from(map.entries())
    .map(([topic, v]) => ({
      topic,
      count: v.count,
      sources: ['cc' as const],
      last_at: v.last_at,
      sample_quote: v.sample_quote
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);
}

export function aggregateTokens(evts: Event[]): {
  cc_tokens_input: number;
  cc_tokens_output: number;
  cc_tokens_per_hour_p50: number;
} {
  let inTok = 0;
  let outTok = 0;
  // collect per-session output rates
  const perSession = new Map<string, { tokens: number; firstTs: number; lastTs: number }>();
  for (const e of evts) {
    if (e.type !== 'cc.token_usage') continue;
    const f = e.evidence?.fields as Record<string, unknown> | undefined;
    const input = (f?.input_tokens as number) ?? 0;
    const output = (f?.output_tokens as number) ?? 0;
    inTok += input;
    outTok += output;
    const sid = f?.sessionId as string | undefined;
    if (!sid) continue;
    const ts = new Date(e.ts).getTime();
    const cur = perSession.get(sid);
    if (!cur) {
      perSession.set(sid, { tokens: output, firstTs: ts, lastTs: ts });
    } else {
      cur.tokens += output;
      if (ts < cur.firstTs) cur.firstTs = ts;
      if (ts > cur.lastTs) cur.lastTs = ts;
    }
  }
  const rates: number[] = [];
  for (const { tokens, firstTs, lastTs } of perSession.values()) {
    const hours = Math.max((lastTs - firstTs) / 3600_000, 0.1);
    rates.push(tokens / hours);
  }
  return {
    cc_tokens_input: inTok,
    cc_tokens_output: outTok,
    cc_tokens_per_hour_p50: percentile(rates, 0.5)
  };
}

export function countSessions(evts: Event[]): { n_sessions: number } {
  const sids = new Set<string>();
  for (const e of evts) {
    const sid = (e.evidence?.fields as Record<string, unknown> | undefined)?.sessionId as
      | string
      | undefined;
    if (sid) sids.add(sid);
  }
  return { n_sessions: sids.size };
}

export function countActiveDays(evts: Event[]): number {
  const days = new Set<string>();
  for (const e of evts) {
    if (e.source !== 'cc_session') continue;
    days.add(e.ts.slice(0, 10));
  }
  return days.size;
}

// === Energy inference ===
//
// Multi-source rule (per §5.1 of PMA-V2.md). For first cut we only have CC
// signals; rules below act on stuck rate + tokens/hr. Once slack/meeting
// fields populate they get added as additional "low contributors".

export interface EnergyInputs {
  evts: Event[];
  asOf: string;
  stuck_count: number;
  tokens_per_hour_p50: number;
  activeDays: number;
  windowDays: 30 | 90;
}

export function inferEnergy(args: EnergyInputs): EnergyLevel {
  const { stuck_count, tokens_per_hour_p50, activeDays, windowDays } = args;

  // No CC data at all → cannot infer. Distinguishes "we don't know" from
  // "burnt out" — both look like silence to a naive rule.
  if (activeDays === 0) return 'unknown';

  let lowContributors = 0;

  const stuckPerDay = stuck_count / activeDays;
  if (stuckPerDay > 3) lowContributors += 1;
  if (stuckPerDay > 6) lowContributors += 1; // double-count

  // Severe dormancy: <10% active days. 20% was too tight for bursty workers
  // (≈5 active days/month = perfectly normal weekly contributor cadence).
  if (activeDays / windowDays < 0.1) lowContributors += 1;

  // Productive-but-slow rule. Only flag if engineer was active enough that
  // we should expect throughput. Threshold derived from collector samples;
  // calibrate against per-agent 90d baseline once available.
  if (activeDays >= 10 && tokens_per_hour_p50 < 5000) lowContributors += 1;

  if (lowContributors >= 3) return 'burnt';
  if (lowContributors >= 1) return 'low';
  if (tokens_per_hour_p50 > 80000 && stuckPerDay < 1 && activeDays >= 10) return 'high';
  return 'normal';
}

// === Helpers ===

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
}

function zeroTaskOutcomes(): TaskOutcomes {
  return {
    n_completed: 0,
    n_aborted: 0,
    n_reworked: 0,
    duration_p50_days: 0,
    duration_p90_days: 0,
    rework_rate: 0
  };
}

function zeroGhScope(): GhScope {
  return { avg_loc_per_pr: 0, dirs_touched: {}, ci_failure_rate: 0, avg_review_comments_per_pr: 0 };
}

function zeroSlackSignals(): SlackSignals {
  return {
    avg_response_latency_min: 0,
    unanswered_to_me: 0,
    decisions_authored: 0,
    reaction_received_rate: 0
  };
}

export function aggregateSlackSignals(
  slackEvts: Event[],
  mentionsReceived: number
): SlackSignals {
  // First-pass slack signal aggregation. Today we have slack.mention,
  // slack.question_unanswered, and slack.channel_activity (no author).
  // Mention-author-side authorship is the strongest signal we can compute
  // without slack.reaction events; latency/decision come later.
  let mentions_sent = 0;
  let unanswered_to_me = 0;
  for (const e of slackEvts) {
    if (e.type === 'slack.mention') mentions_sent += 1;
    else if (e.type === 'slack.question_unanswered') unanswered_to_me += 1;
  }
  // No `slack.thread_resolved` events yet — avg_response_latency stays 0.
  // No `slack.decision_marker` events yet — decisions_authored stays 0.
  // Pack mentions_sent into decisions_authored slot as proxy "outbound
  // initiative" until we have a true decision marker. Will rename next pass.
  void mentions_sent;
  return {
    avg_response_latency_min: 0,
    unanswered_to_me,
    decisions_authored: mentionsReceived, // proxy: how often team @-mentions you
    reaction_received_rate: 0
  };
}

function zeroMeetingSignals(): MeetingSignals {
  return {
    attendance_rate: 0,
    speaker_dominance_p50: 0,
    action_items_owned: 0,
    decisions_authored: 0,
    name_mention_received: 0
  };
}
