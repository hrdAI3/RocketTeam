// Pure-function tests for fingerprint helpers (no LLM calls).

import { describe, it, expect } from 'vitest';
import { extractGhRefs, extractKeywords } from '../../src/predict/fingerprint';

describe('extractGhRefs', () => {
  it('finds PR-123 / PR#123 / pr 123', () => {
    const r = extractGhRefs('修复 PR-123 和 PR#456 还有 pr 789');
    expect(r.map((x) => x.id).sort()).toEqual(['123', '456', '789']);
    expect(r.every((x) => x.type === 'pr')).toBe(true);
  });

  it('finds bare #123 as issue', () => {
    const r = extractGhRefs('关联 issue #350 那个');
    expect(r).toContainEqual({ type: 'issue', repo: '', id: '350' });
  });

  it('finds owner/repo#123', () => {
    const r = extractGhRefs('See teambrain/core#42 for context');
    expect(r).toContainEqual({ type: 'issue', repo: 'teambrain/core', id: '42' });
  });

  it('dedupes refs', () => {
    const r = extractGhRefs('PR-100 PR-100 #100 PR-100');
    expect(r.filter((x) => x.id === '100').length).toBeLessThanOrEqual(2);
  });
});

describe('extractKeywords', () => {
  it('returns Chinese 2+ char tokens and English 4+ char words', () => {
    const k = extractKeywords('实现 docker compose 部署 demo 给 React 用户');
    expect(k).toContain('docker');
    expect(k).toContain('compose');
    expect(k).toContain('react');
    expect(k).toContain('部署');
  });

  it('drops stop words', () => {
    const k = extractKeywords('we need this task today 任务 需要');
    expect(k).not.toContain('this');
    expect(k).not.toContain('task');
    expect(k).not.toContain('任务');
  });

  it('caps at 15 tokens', () => {
    const long = Array.from({ length: 30 }, (_, i) => `keyword${i}`).join(' ');
    expect(extractKeywords(long).length).toBeLessThanOrEqual(15);
  });
});
