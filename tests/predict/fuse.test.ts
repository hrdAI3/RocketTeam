import { describe, it, expect } from 'vitest';
import { fuse, applyGates } from '../../src/predict/fuse';
import type { CandidateScore } from '../../src/predict/types';
import type { AgentBehaviorSnapshot } from '../../src/index/behavior';

function emptySnap(name: string, headroom = 1): AgentBehaviorSnapshot {
  return {
    agent_name: name,
    window_days: 30,
    as_of: '',
    tool_usage: {},
    tool_failure_rate: {},
    current_projects: [],
    tool_vector_keys: [],
    tool_vector_normalized: [],
    stuck_topics: [],
    task_outcomes: { n_completed: 0, n_aborted: 0, n_reworked: 0, duration_p50_days: 0, duration_p90_days: 0, rework_rate: 0 },
    collab_pairs: [],
    gh_scope: { avg_loc_per_pr: 0, dirs_touched: {}, ci_failure_rate: 0, avg_review_comments_per_pr: 0 },
    slack_signals: { avg_response_latency_min: 0, unanswered_to_me: 0, decisions_authored: 0, reaction_received_rate: 0 },
    meeting_signals: { attendance_rate: 0, speaker_dominance_p50: 0, action_items_owned: 0, decisions_authored: 0, name_mention_received: 0 },
    quota: { used_cny: 0, limit_cny: 100, period_resets_at: '', headroom_ratio: headroom },
    energy_inferred: 'normal',
    n_events_used: 0,
    n_sessions: 0,
    cc_tokens_input: 0,
    cc_tokens_output: 0,
    cc_tokens_per_hour_p50: 0,
    active_days_in_window: 10,
    index_version: 't'
  };
}

function cand(opts: Partial<CandidateScore> & { name: string }): CandidateScore {
  return {
    name: opts.name,
    is_ai_agent: false,
    score_vector: 0,
    vector_tool_match: 0,
    vector_stuck_penalty: 0,
    score_llm: null,
    score_trajectory: null,
    fused_capability: 0,
    fused_load: 0,
    raw_confidence: 0,
    calibrated_confidence: 0,
    behavior_snapshot_ref: 't',
    ...opts
  };
}

describe('fuse — missing-path penalty', () => {
  it('candidate with explicit low LLM cap outranks vec-only candidate (regression test)', () => {
    // Bug observed on real data: candidate A had higher vector but got LLM
    // capability_fit=2 ("not your area"). Candidate B had slightly lower
    // vector but no LLM eval (was outside top-K). Old fuse renormalized B
    // up and B won. New fuse penalizes missing paths so explicit-low > missing.
    const snaps = new Map<string, AgentBehaviorSnapshot>([
      ['A', emptySnap('A')],
      ['B', emptySnap('B')]
    ]);
    const candidates = [
      cand({
        name: 'A',
        score_vector: 0.74,
        score_llm: { capability_fit: 2, load_fit: 6, reason: 'wrong area' }
      }),
      cand({ name: 'B', score_vector: 0.539, score_llm: null })
    ];
    const ranked = fuse({
      candidates,
      snapshots: snaps,
      applyCalibration: (x) => x
    });
    // We expect A (with explicit low LLM) to still beat B, because B's
    // missing LLM is penalized rather than re-normalized up.
    expect(ranked[0].name).toBe('A');
  });

  it('candidate with high LLM cap dominates a vec-only equal-vector candidate', () => {
    const snaps = new Map<string, AgentBehaviorSnapshot>([
      ['A', emptySnap('A')],
      ['B', emptySnap('B')]
    ]);
    const candidates = [
      cand({
        name: 'A',
        score_vector: 0.5,
        score_llm: { capability_fit: 9, load_fit: 8, reason: 'core strength' }
      }),
      cand({ name: 'B', score_vector: 0.5, score_llm: null })
    ];
    const ranked = fuse({
      candidates,
      snapshots: snaps,
      applyCalibration: (x) => x
    });
    expect(ranked[0].name).toBe('A');
  });
});

describe('applyGates', () => {
  it('returns no_agents when input is empty', () => {
    expect(applyGates([])).toEqual({ top1: null, alternatives: [], reason_if_null: 'no_agents' });
  });

  it('returns no_suitable when top fused_capability below threshold', () => {
    const c = cand({ name: 'A', fused_capability: 0.1, fused_load: 0.9, calibrated_confidence: 0.3 });
    expect(applyGates([c])).toEqual({ top1: null, alternatives: [], reason_if_null: 'no_suitable' });
  });

  it('returns all_burnt when top load below threshold', () => {
    const c = cand({ name: 'A', fused_capability: 0.8, fused_load: 0.1, calibrated_confidence: 0.3 });
    expect(applyGates([c])).toEqual({ top1: null, alternatives: [], reason_if_null: 'all_burnt' });
  });

  it('includes alternatives within ALT_THRESHOLD of top1 calibrated', () => {
    const a = cand({ name: 'A', fused_capability: 0.8, fused_load: 0.7, calibrated_confidence: 0.75 });
    const b = cand({ name: 'B', fused_capability: 0.7, fused_load: 0.7, calibrated_confidence: 0.70 });
    const c = cand({ name: 'C', fused_capability: 0.5, fused_load: 0.5, calibrated_confidence: 0.50 });
    const r = applyGates([a, b, c]);
    expect(r.top1).toBe('A');
    expect(r.alternatives).toContain('B');
    expect(r.alternatives).not.toContain('C');
  });
});
