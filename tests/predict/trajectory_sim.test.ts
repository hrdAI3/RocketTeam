import { describe, it, expect } from 'vitest';
import { simulateTrajectory } from '../../src/predict/trajectory_sim';
import type { AgentBehaviorSnapshot } from '../../src/index/behavior';
import type { TaskFingerprint } from '../../src/predict/fingerprint';

function mkSnap(overrides: Partial<AgentBehaviorSnapshot> = {}): AgentBehaviorSnapshot {
  return {
    agent_name: 'A',
    window_days: 30,
    as_of: '2026-05-19T00:00:00Z',
    tool_usage: { Bash: 100 },
    tool_failure_rate: {},
    current_projects: [],
    tool_vector_keys: [],
    tool_vector_normalized: [],
    stuck_topics: [],
    task_outcomes: { n_completed: 5, n_aborted: 0, n_reworked: 1, duration_p50_days: 2, duration_p90_days: 4, rework_rate: 0.2 },
    collab_pairs: [],
    gh_scope: { avg_loc_per_pr: 0, dirs_touched: {}, ci_failure_rate: 0, avg_review_comments_per_pr: 0 },
    slack_signals: { avg_response_latency_min: 0, unanswered_to_me: 0, decisions_authored: 0, reaction_received_rate: 0 },
    meeting_signals: { attendance_rate: 0, speaker_dominance_p50: 0, action_items_owned: 0, decisions_authored: 0, name_mention_received: 0 },
    quota: { used_cny: 0, limit_cny: 100, period_resets_at: '', headroom_ratio: 1 },
    energy_inferred: 'normal',
    n_events_used: 100,
    n_sessions: 10,
    cc_tokens_input: 0,
    cc_tokens_output: 0,
    cc_tokens_per_hour_p50: 30000,
    active_days_in_window: 10,
    index_version: 't',
    ...overrides
  };
}

function mkFp(overrides: Partial<TaskFingerprint> = {}): TaskFingerprint {
  return {
    task_id: 'T1',
    description_hash: 'h',
    skills_needed: [],
    tools_needed: ['Bash'],
    risk_topics: [],
    est_effort_days: 2,
    est_tokens: 200_000,
    quality_bar: 'internal',
    importance: 'high',
    urgency: 'low',
    splittable: false,
    expected_subtasks: [],
    linked_context: { gh_refs: [], meeting_decisions: [], slack_threads: [], historical_owners: [] },
    extracted_at: '',
    extractor_version: 't',
    ...overrides
  };
}

describe('simulateTrajectory — basic shape', () => {
  it('returns expected aggregate fields', () => {
    const r = simulateTrajectory(mkSnap(), mkFp(), { n_runs: 20, seed: 42 });
    expect(r.n_runs).toBe(20);
    expect(r.p_complete_on_time).toBeGreaterThanOrEqual(0);
    expect(r.p_complete_on_time).toBeLessThanOrEqual(1);
    expect(r.duration_p50_d).toBeGreaterThan(0);
    expect(r.duration_p90_d).toBeGreaterThanOrEqual(r.duration_p50_d);
  });

  it('is deterministic with same seed', () => {
    const a = simulateTrajectory(mkSnap(), mkFp(), { n_runs: 20, seed: 42 });
    const b = simulateTrajectory(mkSnap(), mkFp(), { n_runs: 20, seed: 42 });
    expect(a).toEqual(b);
  });
});

describe('simulateTrajectory — stuck prediction', () => {
  it('predicts stuck topics that overlap with risk_topics + agent history', () => {
    const snap = mkSnap({
      stuck_topics: [
        { topic: 'docker', count: 15, sources: ['cc'], last_at: '', sample_quote: '' },
        { topic: 'aws', count: 10, sources: ['cc'], last_at: '', sample_quote: '' }
      ]
    });
    const fp = mkFp({ risk_topics: ['docker', 'aws', 'unrelated_topic'] });
    const r = simulateTrajectory(snap, fp, { n_runs: 50, seed: 7 });
    const topics = r.predicted_stuck_topics.map((s) => s.topic);
    expect(topics).toContain('docker');
    expect(topics).not.toContain('unrelated_topic');
  });

  it('predicts no stuck when risk_topics is empty', () => {
    const snap = mkSnap({
      stuck_topics: [{ topic: 'docker', count: 15, sources: ['cc'], last_at: '', sample_quote: '' }]
    });
    const r = simulateTrajectory(snap, mkFp({ risk_topics: [] }), { n_runs: 30, seed: 1 });
    expect(r.predicted_stuck_topics.length).toBe(0);
  });
});

describe('simulateTrajectory — energy effect', () => {
  it('burnt agent has higher duration than high-energy agent', () => {
    const burnt = simulateTrajectory(mkSnap({ energy_inferred: 'burnt' }), mkFp(), {
      n_runs: 40,
      seed: 5
    });
    const high = simulateTrajectory(mkSnap({ energy_inferred: 'high' }), mkFp(), {
      n_runs: 40,
      seed: 5
    });
    expect(burnt.duration_p50_d).toBeGreaterThan(high.duration_p50_d);
    expect(burnt.p_complete_on_time).toBeLessThan(high.p_complete_on_time);
  });
});

describe('simulateTrajectory — quality_bar effect on rework', () => {
  it('external quality bar produces higher expected_rework than demo', () => {
    const ext = simulateTrajectory(
      mkSnap({ task_outcomes: { n_completed: 5, n_aborted: 0, n_reworked: 2, duration_p50_days: 2, duration_p90_days: 4, rework_rate: 0.4 } }),
      mkFp({ quality_bar: 'external' }),
      { n_runs: 60, seed: 11 }
    );
    const demo = simulateTrajectory(
      mkSnap({ task_outcomes: { n_completed: 5, n_aborted: 0, n_reworked: 2, duration_p50_days: 2, duration_p90_days: 4, rework_rate: 0.4 } }),
      mkFp({ quality_bar: 'demo' }),
      { n_runs: 60, seed: 11 }
    );
    expect(ext.expected_rework).toBeGreaterThan(demo.expected_rework);
  });
});

describe('simulateTrajectory — collab', () => {
  it('reports collab partner probabilities when collab_pairs has data', () => {
    const snap = mkSnap({
      collab_pairs: [
        {
          with: '李博泽',
          success_rate: 0.8,
          n: 10,
          edge_weights: { gh_coauthor: 0, gh_review_back_forth: 0, slack_mention: 0, slack_reaction: 0, meeting_co_attended: 0 }
        }
      ]
    });
    const r = simulateTrajectory(snap, mkFp({ est_effort_days: 5 }), { n_runs: 50, seed: 3 });
    expect(r.expected_collab.length).toBeGreaterThan(0);
    expect(r.expected_collab[0].with).toBe('李博泽');
    expect(r.expected_collab[0].p).toBeGreaterThan(0);
  });
});
