// Eng review 7A: 5 cases for the deterministic decision rules.

import { describe, it, expect } from 'vitest';
import { decideTop1 } from '../../src/pma/decision';
import type { AgentResponse } from '../../src/types/index';

function r(name: string, cap: number | null, load: number | null, fallback = false): AgentResponse {
  return { agent_name: name, capability_fit: cap, load_fit: load, reason: 'test', fallback };
}

describe('decideTop1', () => {
  it('happy path: clear winner picks top', () => {
    const d = decideTop1({
      task_description: 'task',
      responses: [r('A', 9, 8), r('B', 5, 5), r('C', 6, 6), r('D', 4, 9)],
      rationale: 'test rationale'
    });
    expect(d.top1).toBe('A');
    expect(d.top1_capability).toBe(9);
    expect(d.confidence).toBeCloseTo((9 + 8) / 20, 5);
    expect(d.alternatives).toEqual([]);
  });

  it('all decline: top1 = null', () => {
    const d = decideTop1({
      task_description: 'task',
      responses: [r('A', 3, 9), r('B', 4, 9), r('C', 2, 9), r('D', 1, 9)],
      rationale: 'no fit'
    });
    expect(d.top1).toBeNull();
    expect(d.confidence).toBe(0);
    expect(d.reason_if_null).toBe('no_suitable_assignee');
  });

  it('tie within threshold: alternatives surfaced', () => {
    const d = decideTop1({
      task_description: 'task',
      responses: [r('A', 8, 7), r('B', 8, 5), r('C', 7, 6), r('D', 5, 5)],
      rationale: 'tie'
    });
    expect(d.top1).toBe('A'); // A wins on load_fit tiebreak
    expect(d.alternatives).toContain('B');
    expect(d.alternatives).toContain('C'); // 8-7=1 also within threshold
    expect(d.alternatives).not.toContain('D');
  });

  it('one timeout: skips fallback agents and picks among the rest', () => {
    const d = decideTop1({
      task_description: 'task',
      responses: [r('A', null, null, true), r('B', 8, 7), r('C', 6, 6), r('D', 4, 5)],
      rationale: 'with timeout'
    });
    expect(d.top1).toBe('B');
    expect(d.confidence).toBeCloseTo((8 + 7) / 20, 5);
  });

  it('all fail: service_unavailable', () => {
    const d = decideTop1({
      task_description: 'task',
      responses: [r('A', null, null, true), r('B', null, null, true)],
      rationale: 'all dead'
    });
    expect(d.top1).toBeNull();
    expect(d.confidence).toBe(0);
    expect(d.reason_if_null).toBe('service_unavailable');
  });
});
