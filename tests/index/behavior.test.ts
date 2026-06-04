// Pure-function tests for the L1 behavior index.

import { describe, it, expect } from 'vitest';
import {
  buildSnapshots,
  aggregateToolUsage,
  extractStuckTopics,
  aggregateTokens,
  inferEnergy,
  toToolVector,
  CANONICAL_TOOLS
} from '../../src/index/behavior';
import type { Event } from '../../src/types/events';

function ccEvt(type: string, actor: string, ts: string, evidence: Event['evidence'] = {}): Event {
  return {
    seq: 0,
    ts,
    source: 'cc_session',
    type,
    subject: { kind: 'agent', ref: actor },
    actor,
    evidence
  };
}

describe('aggregateToolUsage', () => {
  it('counts cc.tool_called per tool', () => {
    const evts: Event[] = [
      ccEvt('cc.tool_called', 'A', '2026-05-10T00:00:00Z', { fields: { tool: 'Bash' } }),
      ccEvt('cc.tool_called', 'A', '2026-05-10T00:00:01Z', { fields: { tool: 'Bash' } }),
      ccEvt('cc.tool_called', 'A', '2026-05-10T00:00:02Z', { fields: { tool: 'Edit' } }),
      ccEvt('cc.session_started', 'A', '2026-05-10T00:00:03Z', {})
    ];
    expect(aggregateToolUsage(evts)).toEqual({ Bash: 2, Edit: 1 });
  });

  it('returns empty when no tool calls', () => {
    expect(aggregateToolUsage([])).toEqual({});
  });
});

describe('extractStuckTopics', () => {
  it('clusters by keyword', () => {
    const evts: Event[] = [
      ccEvt('cc.stuck_signal', 'A', '2026-05-10T00:00:00Z', { quote: 'permission denied to ssh' }),
      ccEvt('cc.stuck_signal', 'A', '2026-05-11T00:00:00Z', { quote: 'cannot connect to docker compose' }),
      ccEvt('cc.stuck_signal', 'A', '2026-05-12T00:00:00Z', { quote: '我等运维开通权限' })
    ];
    const topics = extractStuckTopics(evts);
    const topicNames = topics.map((t) => t.topic);
    expect(topicNames).toContain('permission');
    expect(topicNames).toContain('docker');
    expect(topics.find((t) => t.topic === 'permission')!.count).toBeGreaterThanOrEqual(1);
  });

  it('skips events without quote', () => {
    expect(extractStuckTopics([ccEvt('cc.stuck_signal', 'A', '2026-05-10T00:00:00Z')])).toEqual([]);
  });

  it('keeps the latest sample_quote per topic', () => {
    const evts: Event[] = [
      ccEvt('cc.stuck_signal', 'A', '2026-05-10T00:00:00Z', { quote: 'permission denied early' }),
      ccEvt('cc.stuck_signal', 'A', '2026-05-15T00:00:00Z', { quote: 'permission denied later' })
    ];
    const topics = extractStuckTopics(evts);
    expect(topics[0].sample_quote).toContain('later');
    expect(topics[0].count).toBe(2);
  });
});

describe('aggregateTokens', () => {
  it('sums input/output tokens and computes per-session output rate', () => {
    const evts: Event[] = [
      ccEvt('cc.token_usage', 'A', '2026-05-10T10:00:00Z', {
        fields: { sessionId: 's1', input_tokens: 100, output_tokens: 60000 }
      }),
      ccEvt('cc.token_usage', 'A', '2026-05-10T11:00:00Z', {
        fields: { sessionId: 's1', input_tokens: 50, output_tokens: 60000 }
      })
    ];
    const r = aggregateTokens(evts);
    expect(r.cc_tokens_input).toBe(150);
    expect(r.cc_tokens_output).toBe(120000);
    // session lasted 1hr → 120k/hr
    expect(r.cc_tokens_per_hour_p50).toBeCloseTo(120000, -2);
  });

  it('returns zeros on empty input', () => {
    const r = aggregateTokens([]);
    expect(r.cc_tokens_input).toBe(0);
    expect(r.cc_tokens_output).toBe(0);
    expect(r.cc_tokens_per_hour_p50).toBe(0);
  });
});

describe('toToolVector', () => {
  it('places counts in canonical order and L2-normalizes', () => {
    const v = toToolVector({ Bash: 3, Edit: 4 });
    const idxBash = CANONICAL_TOOLS.indexOf('Bash');
    const idxEdit = CANONICAL_TOOLS.indexOf('Edit');
    // 3,4 → norm 5 → 0.6, 0.8
    expect(v[idxBash]).toBeCloseTo(0.6);
    expect(v[idxEdit]).toBeCloseTo(0.8);
  });

  it('returns all zeros for empty usage', () => {
    const v = toToolVector({});
    expect(v.every((x) => x === 0)).toBe(true);
  });
});

describe('inferEnergy', () => {
  it('returns normal when no signals', () => {
    expect(
      inferEnergy({
        evts: [],
        asOf: '2026-05-18T00:00:00Z',
        stuck_count: 0,
        tokens_per_hour_p50: 30000,
        activeDays: 20,
        windowDays: 30
      })
    ).toBe('normal');
  });

  it('returns unknown when zero active days (no CC data)', () => {
    expect(
      inferEnergy({
        evts: [],
        asOf: '2026-05-18T00:00:00Z',
        stuck_count: 0,
        tokens_per_hour_p50: 0,
        activeDays: 0,
        windowDays: 30
      })
    ).toBe('unknown');
  });

  it('returns burnt when many stuck and dormant', () => {
    expect(
      inferEnergy({
        evts: [],
        asOf: '2026-05-18T00:00:00Z',
        stuck_count: 60, // ~30/day on 2 active days = double-low + dormant
        tokens_per_hour_p50: 1000,
        activeDays: 2,
        windowDays: 30
      })
    ).toBe('burnt');
  });

  it('returns high when hot + no stuck + many active days', () => {
    expect(
      inferEnergy({
        evts: [],
        asOf: '2026-05-18T00:00:00Z',
        stuck_count: 0,
        tokens_per_hour_p50: 100000,
        activeDays: 25,
        windowDays: 30
      })
    ).toBe('high');
  });

  it('bursty worker (5 active days, healthy tokens) is normal not low', () => {
    expect(
      inferEnergy({
        evts: [],
        asOf: '2026-05-18T00:00:00Z',
        stuck_count: 0,
        tokens_per_hour_p50: 50000,
        activeDays: 5,
        windowDays: 30
      })
    ).toBe('normal');
  });
});

describe('buildSnapshots integration', () => {
  it('builds per-agent snapshot from mixed event stream', () => {
    const asOf = new Date('2026-05-18T00:00:00Z');
    const evts: Event[] = [
      ccEvt('cc.session_started', 'A', '2026-05-10T00:00:00Z', { fields: { sessionId: 's1' } }),
      ccEvt('cc.tool_called', 'A', '2026-05-10T00:01:00Z', { fields: { tool: 'Bash', sessionId: 's1' } }),
      ccEvt('cc.tool_called', 'A', '2026-05-10T00:02:00Z', { fields: { tool: 'Edit', sessionId: 's1' } }),
      ccEvt('cc.stuck_signal', 'A', '2026-05-10T00:03:00Z', { quote: 'permission denied' }),
      ccEvt('cc.token_usage', 'A', '2026-05-10T01:00:00Z', {
        fields: { sessionId: 's1', input_tokens: 100, output_tokens: 50000 }
      }),
      // Out-of-window
      ccEvt('cc.tool_called', 'A', '2025-01-01T00:00:00Z', { fields: { tool: 'Bash' } }),
      // Other actor
      ccEvt('cc.tool_called', 'B', '2026-05-10T00:00:00Z', { fields: { tool: 'Grep' } })
    ];
    const snaps = buildSnapshots({
      events: evts,
      agentNames: ['A', 'B'],
      asOf,
      windowDays: 30
    });
    const a = snaps.get('A')!;
    expect(a.tool_usage).toEqual({ Bash: 1, Edit: 1 });
    expect(a.stuck_topics[0].topic).toBe('permission');
    expect(a.n_sessions).toBe(1);
    expect(a.cc_tokens_output).toBe(50000);
    expect(a.tool_vector_normalized.some((x) => x > 0)).toBe(true);

    const b = snaps.get('B')!;
    expect(b.tool_usage).toEqual({ Grep: 1 });
    expect(b.stuck_topics.length).toBe(0);
  });
});
