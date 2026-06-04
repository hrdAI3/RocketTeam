import { describe, it, expect } from 'vitest';
import { vectorMatch, toolNeedsToVector, cosine, stuckPenalty } from '../../src/predict/vector_match';
import { CANONICAL_TOOLS } from '../../src/index/behavior';
import type { AgentBehaviorSnapshot } from '../../src/index/behavior';
import type { TaskFingerprint } from '../../src/predict/fingerprint';

function snap(name: string, tool_usage: Record<string, number>, stuck: Array<{topic: string; count: number}> = []): AgentBehaviorSnapshot {
  const v = CANONICAL_TOOLS.map((t) => tool_usage[t] ?? 0);
  const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0));
  const normalized = norm === 0 ? v.map(() => 0) : v.map((x) => x / norm);
  return {
    agent_name: name,
    window_days: 30,
    as_of: '2026-05-18T00:00:00Z',
    tool_usage,
    tool_failure_rate: {},
    current_projects: [],
    tool_vector_keys: CANONICAL_TOOLS,
    tool_vector_normalized: normalized,
    stuck_topics: stuck.map((s) => ({ ...s, sources: ['cc' as const], last_at: '2026-05-15T00:00:00Z', sample_quote: '' })),
    task_outcomes: { n_completed: 0, n_aborted: 0, n_reworked: 0, duration_p50_days: 0, duration_p90_days: 0, rework_rate: 0 },
    collab_pairs: [],
    gh_scope: { avg_loc_per_pr: 0, dirs_touched: {}, ci_failure_rate: 0, avg_review_comments_per_pr: 0 },
    slack_signals: { avg_response_latency_min: 0, unanswered_to_me: 0, decisions_authored: 0, reaction_received_rate: 0 },
    meeting_signals: { attendance_rate: 0, speaker_dominance_p50: 0, action_items_owned: 0, decisions_authored: 0, name_mention_received: 0 },
    quota: { used_cny: 0, limit_cny: 0, period_resets_at: '', headroom_ratio: 1 },
    energy_inferred: 'normal',
    n_events_used: 100,
    n_sessions: 5,
    cc_tokens_input: 0,
    cc_tokens_output: 0,
    cc_tokens_per_hour_p50: 30000,
    active_days_in_window: 10,
    index_version: 'test'
  };
}

function fp(tools_needed: string[], risk_topics: string[] = []): TaskFingerprint {
  return {
    task_id: 'T1',
    description_hash: 'h',
    skills_needed: [],
    tools_needed,
    risk_topics,
    est_effort_days: 1,
    est_tokens: 100000,
    quality_bar: 'internal',
    importance: 'low',
    urgency: 'low',
    splittable: false,
    expected_subtasks: [],
    linked_context: { gh_refs: [], meeting_decisions: [], slack_threads: [], historical_owners: [] },
    extracted_at: '2026-05-18T00:00:00Z',
    extractor_version: 'test'
  };
}

describe('cosine', () => {
  it('returns 1 for identical normalized vectors', () => {
    const v = toolNeedsToVector(['Bash', 'Edit']);
    expect(cosine(v, v)).toBeCloseTo(1);
  });

  it('returns 0 for orthogonal vectors', () => {
    const a = toolNeedsToVector(['Bash']);
    const b = toolNeedsToVector(['Grep']);
    expect(cosine(a, b)).toBeCloseTo(0);
  });
});

describe('vectorMatch', () => {
  it('ranks agent with matching tool history above one with mismatch', () => {
    const snaps = new Map<string, AgentBehaviorSnapshot>([
      ['A', snap('A', { Bash: 100, Edit: 80 })],
      ['B', snap('B', { Grep: 100, Glob: 80 })]
    ]);
    const res = vectorMatch(fp(['Bash', 'Edit']), snaps);
    expect(res[0].agent_name).toBe('A');
    expect(res[0].score).toBeGreaterThan(res[1].score);
  });

  it('applies stuck penalty when agent historically stuck on task risk topic', () => {
    const snaps = new Map<string, AgentBehaviorSnapshot>([
      ['A', snap('A', { Bash: 100 }, [{ topic: 'permission', count: 20 }])],
      ['B', snap('B', { Bash: 100 })]
    ]);
    const res = vectorMatch(fp(['Bash'], ['permission']), snaps);
    expect(res[0].agent_name).toBe('B');
    expect(res.find((r) => r.agent_name === 'A')!.stuck_penalty).toBeGreaterThan(0);
  });

  it('returns zero match for agent with no tool history', () => {
    const snaps = new Map<string, AgentBehaviorSnapshot>([
      ['A', snap('A', {})]
    ]);
    expect(vectorMatch(fp(['Bash']), snaps)[0].score).toBe(0);
  });
});

describe('stuckPenalty', () => {
  it('returns 0 when risk_topics is empty', () => {
    expect(stuckPenalty([], snap('A', {}, [{ topic: 'permission', count: 10 }]))).toBe(0);
  });

  it('caps at 1', () => {
    expect(
      stuckPenalty(['permission'], snap('A', {}, [{ topic: 'permission', count: 100 }]))
    ).toBeCloseTo(1);
  });

  it('saturates: tiny stuck count is discounted', () => {
    const small = stuckPenalty(['permission'], snap('A', {}, [{ topic: 'permission', count: 1 }]));
    const big = stuckPenalty(['permission'], snap('A', {}, [{ topic: 'permission', count: 50 }]));
    expect(small).toBeLessThan(big);
  });
});
