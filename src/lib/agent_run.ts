// AgentRun — the agent-native primary entity.
//
// Rocket Team's pivot: the first-class unit of work is NOT the person, it's a
// single Claude Code session (an "AgentRun"). A person is just the operator
// attribute. events.jsonl is already session-keyed (every cc.* event carries
// evidence.fields.sessionId), so this is a re-aggregation over existing data —
// no new collector work.
//
// One AgentRun = all events sharing a sessionId, folded into a record with:
//   identity   — run_id (= sessionId), operator (resolved human name), project
//   context    — repo/cwd, branch, model
//   lifecycle  — started_at, ended_at, status (live | done | stalled)
//   activity   — tool_calls, tool_counts, files_touched, stuck_count
//   outputs    — commits/PRs produced (v1; v0 leaves [] and counts file writes)
//
// Windowed by default (last N days) so we don't fold 98k historical sessions.

import { readAllEvents } from './events';
import { buildActorIndex } from './team_roster';
import {
  attributeRun,
  type AttributionMethod,
  type AttributionConfidence
} from '../services/attribute_run';
import type { Event } from '../types/events';

// Re-export the attribution types so consumers of AgentRun can name the new
// fields without reaching into the service module.
export type { AttributionMethod, AttributionConfidence } from '../services/attribute_run';

export type AgentRunStatus = 'live' | 'done' | 'stalled';

export interface AgentRunOutput {
  kind: 'commit' | 'pr' | 'deploy' | 'file';
  ref: string;        // sha / PR url / path
  at: string;         // ISO
}

export interface AgentRun {
  run_id: string;            // = sessionId
  operator: string;          // resolved human name (or raw actor if unresolved)
  project_id: string | null; // attributed project (see attribute_run.ts pipeline)
  // How project_id was decided + how much to trust it. 'none'/null when
  // unattributed — that is the intended safe-failure floor, not a bug.
  attribution_method: AttributionMethod;
  attribution_confidence: AttributionConfidence | null;
  // <=200 char citation of the signal that resolved it. null when unattributed.
  attribution_evidence: string | null;
  repo: string | null;       // owner/name if derivable, else null
  cwd: string | null;
  branch: string | null;
  model: string | null;
  started_at: string;
  ended_at: string | null;
  last_activity_at: string;
  status: AgentRunStatus;
  tool_calls: number;
  tool_counts: Record<string, number>;
  files_touched: number;     // Write + Edit + NotebookEdit calls
  stuck_count: number;
  outputs: AgentRunOutput[];
}

// A session is "stalled" if its last activity is older than this but it never
// emitted a session_ended (i.e. it didn't finish, it just went quiet — a
// candidate for "agent is waiting / abandoned").
const STALL_MS = 30 * 60_000; // 30 min
// "live" = last activity within this and no session_ended.
const LIVE_MS = 15 * 60_000; // 15 min

interface SessionAccumulator {
  run_id: string;
  actorRaw: string;
  cwd: string | null;
  branch: string | null;
  model: string | null;
  firstTs: string;
  lastTs: string;
  endedTs: string | null;
  toolCalls: number;
  toolCounts: Record<string, number>;
  filesTouched: number;
  stuckCount: number;
  // The session's cc.* events, kept so attributeRun can mine surviving
  // tool-call quotes (the 96%-redacted-cwd workhorse). Capped to the last
  // EVENTS_PER_SESSION to bound memory — quote signals only need recent ones.
  events: Event[];
}

const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);
// Cap retained events per session — buildAgentRuns folds up to 98k historical
// sessions; keeping every cc.* event for each would blow memory. Quote/branch
// signals are recency-biased, so the tail is what matters.
const EVENTS_PER_SESSION = 200;
// Per-pass LLM call budget for the attribution tier. A hard ceiling so one
// buildAgentRuns pass over a large window can never fan out to thousands of LLM
// calls — the tier is gated on tool_calls>=8 AND this shared counter.
const LLM_BUDGET = 60;

function sessionIdOf(e: Event): string | null {
  const f = e.evidence?.fields as Record<string, unknown> | undefined;
  const sid = f?.sessionId;
  return typeof sid === 'string' && sid.length > 0 ? sid : null;
}

export interface BuildAgentRunsOptions {
  windowDays?: number;   // default 7
  nowMs?: number;        // injectable for tests
  minToolCalls?: number; // drop trivial sessions (default 1)
  // Skip the cost-bounded LLM attribution tier. Deterministic-only — fast and
  // free, for cheap coverage measurement and the Fleet View hot path where an
  // LLM call per run is unacceptable. Default false (LLM tier may fire).
  disableLLM?: boolean;
}

export async function buildAgentRuns(opts: BuildAgentRunsOptions = {}): Promise<AgentRun[]> {
  const windowDays = opts.windowDays ?? 7;
  const nowMs = opts.nowMs ?? Date.now();
  const minToolCalls = opts.minToolCalls ?? 1;
  const cutoffMs = nowMs - windowDays * 24 * 60 * 60 * 1000;

  const [events, actorIndex] = await Promise.all([readAllEvents(), buildActorIndex()]);

  // gh.commit_pushed is source==='github', not cc.*, so the per-session loop
  // below (which only folds cc.* events) drops it. Slice the commit events ONCE
  // here; attributeRun matches them by operator + run-window, not by sessionId
  // (commits carry no sessionId). Built once and shared across all runs.
  const commitEvents = events.filter((e) => e.type === 'gh.commit_pushed');
  // gh.pr_opened / gh.review_submitted are likewise source==='github' with no
  // sessionId, so the per-session cc.* loop drops them too. Slice them ONCE
  // (mirror commitEvents); attributeRun's pr_review_join tier matches them by
  // operator + run-window. Built once and shared across all runs.
  const prEvents = events.filter(
    (e) => e.type === 'gh.pr_opened' || e.type === 'gh.review_submitted'
  );
  // Per-pass LLM budget — built ONCE, reused by every attributeRun call so we
  // don't re-read projects.json 1487 times. disableLLM zeroes it so the LLM
  // tier never fires (deterministic-only, fast + free).
  const llmBudget = { n: opts.disableLLM ? 0 : LLM_BUDGET };

  const acc = new Map<string, SessionAccumulator>();
  for (const e of events) {
    if (!e.type.startsWith('cc.')) continue;
    if (e.type === 'cc.raw_blob') continue; // noise; fields are samples not signal
    const tsMs = Date.parse(e.ts);
    if (!Number.isFinite(tsMs) || tsMs < cutoffMs) continue;
    const sid = sessionIdOf(e);
    if (!sid) continue;

    let s = acc.get(sid);
    const f = (e.evidence?.fields ?? {}) as Record<string, unknown>;
    if (!s) {
      s = {
        run_id: sid,
        actorRaw: e.actor ?? '',
        cwd: typeof f.cwd === 'string' ? f.cwd : null,
        branch: typeof f.gitBranch === 'string' ? f.gitBranch : null,
        model: typeof f.model === 'string' ? f.model : null,
        firstTs: e.ts,
        lastTs: e.ts,
        endedTs: null,
        toolCalls: 0,
        toolCounts: {},
        filesTouched: 0,
        stuckCount: 0,
        events: []
      };
      acc.set(sid, s);
    }
    // Retain this cc.* event for attribution (bounded tail — see
    // EVENTS_PER_SESSION). tool_called quotes are the main surviving signal.
    s.events.push(e);
    if (s.events.length > EVENTS_PER_SESSION) s.events.shift();
    // Earliest / latest timestamps.
    if (e.ts < s.firstTs) s.firstTs = e.ts;
    if (e.ts > s.lastTs) s.lastTs = e.ts;
    // Backfill context fields from whichever event carries them.
    if (!s.cwd && typeof f.cwd === 'string') s.cwd = f.cwd;
    if (!s.branch && typeof f.gitBranch === 'string') s.branch = f.gitBranch;
    if (!s.model && typeof f.model === 'string') s.model = f.model;
    if (!s.actorRaw && e.actor) s.actorRaw = e.actor;

    if (e.type === 'cc.tool_called') {
      s.toolCalls++;
      const tool = typeof f.tool === 'string' ? f.tool : '?';
      s.toolCounts[tool] = (s.toolCounts[tool] ?? 0) + 1;
      if (WRITE_TOOLS.has(tool)) s.filesTouched++;
    } else if (e.type === 'cc.session_ended') {
      s.endedTs = e.ts;
      // session_ended carries authoritative toolCounts — prefer it.
      const tc = f.toolCounts as Record<string, number> | undefined;
      if (tc && typeof tc === 'object') {
        s.toolCounts = tc;
        s.toolCalls = Object.values(tc).reduce((a, b) => a + (Number(b) || 0), 0);
        s.filesTouched = (tc.Write ?? 0) + (tc.Edit ?? 0) + (tc.NotebookEdit ?? 0);
      }
    } else if (e.type === 'cc.stuck_signal') {
      s.stuckCount++;
    }
  }

  const runs: AgentRun[] = [];
  for (const s of acc.values()) {
    if (s.toolCalls < minToolCalls && !s.endedTs) continue;
    const lastMs = Date.parse(s.lastTs);
    const operator = actorIndex.get((s.actorRaw || '').toLowerCase()) ?? s.actorRaw ?? 'unknown';
    const status: AgentRunStatus = s.endedTs
      ? 'done'
      : nowMs - lastMs <= LIVE_MS
        ? 'live'
        : nowMs - lastMs >= STALL_MS
          ? 'stalled'
          : 'done'; // quiet but recent-ish, treat as wrapped

    // Build the run FIRST (attributeRun needs run.operator + run-window +
    // run.tool_calls), then attribute. The attributor needs this session's cc
    // events PLUS the pass-level gh.commit_pushed slice (commits have no
    // sessionId, matched by operator+window inside attributeRun).
    const run: AgentRun = {
      run_id: s.run_id,
      operator,
      project_id: null, // filled by attributeRun below
      attribution_method: 'none',
      attribution_confidence: null,
      attribution_evidence: null,
      repo: null, // v1: derive owner/name from cwd↔repo map
      cwd: s.cwd,
      branch: s.branch,
      model: s.model,
      started_at: s.firstTs,
      ended_at: s.endedTs,
      last_activity_at: s.lastTs,
      status,
      tool_calls: s.toolCalls,
      tool_counts: s.toolCounts,
      files_touched: s.filesTouched,
      stuck_count: s.stuckCount,
      outputs: [] // v1: join GitHub commits/PRs by operator+repo+window
    };

    // Attribute via the full signal pipeline (commit→pr→cwd→quote→LLM),
    // replacing the old bare lookupProjectByCwd that failed for redacted cwds.
    // The cc events are this session's; commitEvents + prEvents are the shared
    // pass-level GitHub slices (matched by operator+window inside attributeRun).
    const attr = await attributeRun(run, {
      events: s.events.concat(commitEvents, prEvents),
      llmBudgetRemaining: llmBudget,
      nowMs
    });
    run.project_id = attr.project_id;
    run.attribution_method = attr.attribution_method;
    // null confidence when unattributed — keeps summarizeFleet's `!project_id`
    // count honest and avoids implying low-confidence on a non-attribution.
    run.attribution_confidence = attr.project_id ? attr.attribution_confidence : null;
    run.attribution_evidence = attr.attribution_evidence;

    runs.push(run);
  }

  // Newest activity first.
  runs.sort((a, b) => Date.parse(b.last_activity_at) - Date.parse(a.last_activity_at));
  return runs;
}

// Fleet-level rollup for the Fleet View header + grouping.
export interface FleetSummary {
  total: number;
  live: number;
  stalled: number;
  done: number;
  byProject: Array<{ project_id: string | null; count: number; live: number }>;
  unattributed: number;
  // Attribution observability: how the attributed runs were resolved. Lets the
  // Fleet View surface "how much of coverage is high-confidence commit/cwd vs
  // fuzzy quote/LLM" at a glance.
  byMethod: Record<AttributionMethod, number>;
}

export function summarizeFleet(runs: AgentRun[]): FleetSummary {
  const byProject = new Map<string | null, { count: number; live: number }>();
  const byMethod: Record<AttributionMethod, number> = {
    commit_repo_join: 0,
    pr_review_join: 0,
    cwd_leaf_repo: 0,
    cwd_exact: 0,
    cwd_prefix: 0,
    quote_path_repo: 0,
    llm_evidence: 0,
    none: 0
  };
  let live = 0,
    stalled = 0,
    done = 0,
    unattributed = 0;
  for (const r of runs) {
    if (r.status === 'live') live++;
    else if (r.status === 'stalled') stalled++;
    else done++;
    if (!r.project_id) unattributed++;
    byMethod[r.attribution_method] = (byMethod[r.attribution_method] ?? 0) + 1;
    const key = r.project_id;
    const g = byProject.get(key) ?? { count: 0, live: 0 };
    g.count++;
    if (r.status === 'live') g.live++;
    byProject.set(key, g);
  }
  return {
    total: runs.length,
    live,
    stalled,
    done,
    unattributed,
    byMethod,
    byProject: [...byProject.entries()]
      .map(([project_id, v]) => ({ project_id, ...v }))
      .sort((a, b) => b.count - a.count)
  };
}
