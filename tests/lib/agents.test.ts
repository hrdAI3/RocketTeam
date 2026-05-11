// Smoke tests for the file-based personal-agent state layer.
// We monkey-patch TEAM_ROOT to a temp dir per test so the team's real
// agents/ directory is never touched.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(join(tmpdir(), 'hrdai-test-'));
  process.env.TEAM_ROOT = tempRoot;
  process.env.AGENTS_DIR = join(tempRoot, 'agents');
  process.env.TASKS_DIR = join(tempRoot, 'tasks');
  process.env.TIMELINE_FILE = join(tempRoot, 'timeline.jsonl');
  process.env.CONTEXT_DIR = join(tempRoot, 'context');
  // paths.ts resolves env at module load time, so we must reset module cache
  // between tests so each test gets a fresh paths.ts pointing at its temp dir.
  vi.resetModules();
});

afterEach(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

const sampleProfile = (name: string) => ({
  name,
  dept: '产品',
  role: 'PM',
  join_date: null,
  current_load: { active_tasks: [], estimated_hours_left_this_week: null, blocked_on: [] },
  recent_topics: [],
  strengths_observed: [],
  energy_signal: { level: 'normal' as const, last_updated: '2026-05-06T10:00:00Z', evidence: 'test' },
  recent_interactions: [],
  _meta: {
    schema_version: 0,
    bootstrapped_at: '2026-05-06T10:00:00Z',
    evolution_count: 0,
    source_files: []
  }
});

describe('agents lib', () => {
  it('listAgents returns [] for empty dir', async () => {
    const { listAgents } = await import('../../src/lib/agents.js');
    expect(await listAgents()).toEqual([]);
  });

  it('writeProfile + getState round-trip', async () => {
    const { writeProfile, getState, listAgents } = await import('../../src/lib/agents.js');
    await writeProfile(sampleProfile('alpha'));
    const profile = await getState('alpha');
    expect(profile.name).toBe('alpha');
    expect(profile._meta.schema_version).toBe(0);
    expect(await listAgents()).toContain('alpha');
  });

  it('updateState rejects _meta paths', async () => {
    const { writeProfile, updateState } = await import('../../src/lib/agents.js');
    await writeProfile(sampleProfile('beta'));
    await expect(
      updateState('beta', [{ op: 'replace', path: '/_meta/schema_version', value: 99 }])
    ).rejects.toThrow(/not allowed/);
  });

  it('updateState allows /current_load updates and bumps evolution_count', async () => {
    const { writeProfile, updateState } = await import('../../src/lib/agents.js');
    await writeProfile(sampleProfile('gamma'));
    const next = await updateState('gamma', [
      { op: 'replace', path: '/current_load/estimated_hours_left_this_week', value: 12 }
    ]);
    expect(next.current_load.estimated_hours_left_this_week).toBe(12);
    expect(next._meta.evolution_count).toBe(1);
  });

  it('getState throws when profile missing', async () => {
    const { getState } = await import('../../src/lib/agents.js');
    await expect(getState('does-not-exist')).rejects.toThrow(/not found/);
  });

  it('deleteAllAgents removes all .json profiles', async () => {
    const { writeProfile, deleteAllAgents, listAgents } = await import('../../src/lib/agents.js');
    await writeProfile(sampleProfile('delta'));
    await writeProfile(sampleProfile('epsilon'));
    expect(await deleteAllAgents()).toBe(2);
    expect(await listAgents()).toEqual([]);
  });
});
