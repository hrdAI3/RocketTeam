// Bootstrap util tests. Doesn't hit LLM — just tests the org chart parser.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(join(tmpdir(), 'hrdai-org-'));
  process.env.TEAM_ROOT = tempRoot;
  process.env.CONTEXT_DIR = join(tempRoot, 'context');
  await fs.mkdir(join(tempRoot, 'context', 'org'), { recursive: true });
  vi.resetModules();
});

afterEach(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

describe('parseOrgChart', () => {
  it('parses dept + member structure', async () => {
    const orgFile = join(tempRoot, 'context', 'org', '组织架构.txt');
    await fs.writeFile(
      orgFile,
      `产品
-张三
-李四
研发
-王五（产品负责人、研发负责人）
-赵六
钱七（老板）
`,
      'utf8'
    );
    const { parseOrgChart } = await import('../../src/bootstrap/extract.js');
    const entries = await parseOrgChart();
    expect(entries.length).toBeGreaterThanOrEqual(4);
    const lead = entries.find((e) => e.name === '王五');
    expect(lead).toBeDefined();
    expect(lead?.dept).toBe('研发');
    expect(lead?.role).toContain('负责人');
    const boss = entries.find((e) => e.name === '钱七');
    expect(boss?.role).toBe('老板');
  });

  it('returns [] when org chart missing', async () => {
    const { parseOrgChart } = await import('../../src/bootstrap/extract.js');
    expect(await parseOrgChart()).toEqual([]);
  });
});
