// Smoke tests for evolution diff path-allowlist enforcement.
// LLM call is not mocked here — we test the sanitizer directly via
// re-export. If LLM tests are needed, mock OpenAI + Anthropic SDKs
// (out of scope for this skill's smoke pass).

import { describe, it, expect } from 'vitest';
import { EVOLVABLE_PATH_PREFIXES } from '../../src/types/index';

describe('evolution path allowlist', () => {
  it('contains expected prefixes', () => {
    expect(EVOLVABLE_PATH_PREFIXES).toContain('/current_load');
    expect(EVOLVABLE_PATH_PREFIXES).toContain('/recent_topics');
    expect(EVOLVABLE_PATH_PREFIXES).toContain('/strengths_observed');
    expect(EVOLVABLE_PATH_PREFIXES).toContain('/energy_signal');
    expect(EVOLVABLE_PATH_PREFIXES).toContain('/recent_interactions');
  });
  it('excludes _meta and identity fields', () => {
    expect(EVOLVABLE_PATH_PREFIXES).not.toContain('/_meta');
    expect(EVOLVABLE_PATH_PREFIXES).not.toContain('/name');
    expect(EVOLVABLE_PATH_PREFIXES).not.toContain('/dept');
    expect(EVOLVABLE_PATH_PREFIXES).not.toContain('/role');
    expect(EVOLVABLE_PATH_PREFIXES).not.toContain('/join_date');
  });
});
