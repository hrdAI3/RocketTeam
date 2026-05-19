import { describe, it, expect } from 'vitest';
import { isGhostUserId, canonicalSessionId } from '../../src/lib/ghost_user';

describe('isGhostUserId', () => {
  it('returns false for real email TLDs', () => {
    expect(isGhostUserId('hrdai@qq.com')).toBe(false);
    expect(isGhostUserId('charleyplztrybest@outlook.com')).toBe(false);
    expect(isGhostUserId('liboze2026@163.com')).toBe(false);
    expect(isGhostUserId('chenjr@nb-ai.com')).toBe(false);
    expect(isGhostUserId('witkowskiloeser@gmail.com')).toBe(false);
    expect(isGhostUserId('2383145798@qq.com')).toBe(false);
    // `users.noreply.github.com` ends in `.com` → real email TLD → not ghost.
    expect(isGhostUserId('horton2048@users.noreply.github.com')).toBe(false);
  });

  it('returns true for hostname-fallback shape (bare hostname, no TLD)', () => {
    expect(isGhostUserId('19723@hut')).toBe(true);
    expect(isGhostUserId('asus@yilinFormula1')).toBe(true);
  });

  it('returns true for .local mDNS hostname suffix', () => {
    expect(isGhostUserId('blink@BlinkdeMacBook-Air.local')).toBe(true);
    expect(isGhostUserId('lv@lvjiawendeMacBook-Air.local')).toBe(true);
    expect(isGhostUserId('zhangziyi@zhangziyideMacBook-Air-2.local')).toBe(true);
    expect(isGhostUserId('alexpeng@pengchengdeMacBook-Air.local')).toBe(true);
  });

  it('handles edge cases', () => {
    expect(isGhostUserId('')).toBe(false);
    expect(isGhostUserId('no-at-sign')).toBe(false);
    expect(isGhostUserId('user@')).toBe(false);
  });

  it('leans conservative on unknown TLDs (dot present, not in allowlist → real)', () => {
    // An exotic TLD we don't recognise — better to ingest than to drop.
    expect(isGhostUserId('person@company.example')).toBe(false);
  });
});

describe('canonicalSessionId', () => {
  it('strips trailing .cc-status', () => {
    expect(canonicalSessionId('8c7b8e3b-ea8d-4482-9d52-c78cc302c35c.cc-status')).toBe(
      '8c7b8e3b-ea8d-4482-9d52-c78cc302c35c',
    );
  });

  it('leaves transcript ids unchanged', () => {
    expect(canonicalSessionId('8c7b8e3b-ea8d-4482-9d52-c78cc302c35c')).toBe(
      '8c7b8e3b-ea8d-4482-9d52-c78cc302c35c',
    );
  });

  it('leaves unknown suffixes alone', () => {
    expect(canonicalSessionId('foo.bar')).toBe('foo.bar');
  });
});
