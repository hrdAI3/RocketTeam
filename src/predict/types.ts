// Shared types for PMA v2 prediction layer.

import type { AgentBehaviorSnapshot } from '../index/behavior';
import type { TaskFingerprint } from './fingerprint';

export interface AgentEvalLLM {
  capability_fit: number; // 0-10
  load_fit: number;       // 0-10
  reason: string;
}

export interface AgentWalkthrough {
  text: string;          // first-person plan, 200-400 chars
  predicted_first_action: string;
  predicted_collab_pings: string[];
  predicted_blockers: string[];
}

export interface CandidateScore {
  name: string;
  is_ai_agent: boolean;

  // Path A — vector match
  score_vector: number;
  vector_tool_match: number;
  vector_stuck_penalty: number;

  // Path B — LLM grounded eval (null if not evaluated this round)
  score_llm: AgentEvalLLM | null;

  // Path B+ — agent walks through "if I take this, I'd do…" in first
  // person. Only run for top-K candidates after fuse to keep cost down.
  walkthrough?: AgentWalkthrough | null;

  // Path C — Monte Carlo (filled in M3.B; null until then)
  score_trajectory: {
    n_runs: number;
    p_complete_on_time: number;
    duration_p50_d: number;
    duration_p90_d: number;
    predicted_stuck_topics: Array<{ topic: string; p: number }>;
    expected_collab: Array<{ with: string; p: number }>;
    expected_rework: number;
    quota_breach_p: number;
  } | null;

  // Fused values
  fused_capability: number;
  fused_load: number;
  raw_confidence: number;
  calibrated_confidence: number;

  // Provenance
  behavior_snapshot_ref: string;
}

export type ReasonIfNull =
  | 'no_agents'
  | 'no_suitable'
  | 'quota_blocked'
  | 'all_burnt'
  | 'service_unavailable';

export interface SubtaskAssignment {
  subtask: string;
  suggested_owner: string | null;
  alternatives: string[];
  why: string;
}

export interface PMADecisionV2 {
  task_id: string;
  fingerprint: TaskFingerprint;

  top1: string | null;
  alternatives: string[];
  raw_confidence: number;
  calibrated_confidence: number;
  reason_if_null?: ReasonIfNull;
  rationale: string;

  // Per-subtask assignment when fp.splittable. Null when the task is not
  // splittable or LLM couldn't produce a confident split.
  subtask_split?: SubtaskAssignment[] | null;
  // Structured reason when subtask_split is null. Lets the UI render
  // "didn't run" vs "ran but couldn't agree" vs "timeout" distinctly.
  subtask_split_failure_reason?:
    | 'not_splittable'
    | 'no_subtasks'
    | 'gate_blocked'
    | 'parse_failed'
    | 'no_candidates_returned'
    | 'timeout'
    | 'exception'
    | null;

  candidates: CandidateScore[];

  ts: string;
  predictor_version: string;

  // Latency provenance
  latencies: {
    fingerprint_ms: number;
    snapshot_load_ms: number;
    vector_ms: number;
    llm_eval_ms: number;
    total_ms: number;
  };
}

export interface PredictV2Inputs {
  task_id: string;
  description: string;
  importance?: 'high' | 'low';
  urgency?: 'high' | 'low';
  signal?: AbortSignal;
}

// Used by snapshot loader.
export interface SnapshotsBundle {
  as_of: string;
  window_days: 30 | 90;
  snapshots: Map<string, AgentBehaviorSnapshot>;
  source_path: string;
}
