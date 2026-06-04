#!/usr/bin/env bun
// One-shot: strip `role` field from all private/agents/*.json. After
// 2026-05-21 the system no longer enforces a single role label per person.

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { PATHS } from '../src/lib/paths';

async function main() {
  const files = await fs.readdir(PATHS.agents);
  let touched = 0;
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const p = join(PATHS.agents, f);
    const raw = await fs.readFile(p, 'utf8');
    const j = JSON.parse(raw) as Record<string, unknown>;
    if ('role' in j) {
      delete j.role;
      await fs.writeFile(p, JSON.stringify(j, null, 2) + '\n', 'utf8');
      console.log(`stripped role: ${f}`);
      touched += 1;
    }
  }
  console.log(`\n[strip_role] ${touched} profiles touched`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
