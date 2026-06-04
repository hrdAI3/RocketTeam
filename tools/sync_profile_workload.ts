#!/usr/bin/env bun
// Auto-sync each agent's profile.workload.active from their behavior snapshot's
// current_projects. Hand-curated workload goes stale; CC cwd is ground truth
// for "what's on their plate right now". Non-destructive: only fills empty
// workload.active and inserts an "auto" tag so the leader knows it's derived.
//
// Dry-run by default. --apply to write.

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { PATHS } from '../src/lib/paths';
import { loadOrBuildSnapshots } from '../src/predict/snapshot_loader';

interface ActiveAssignment {
  role: string;
  ts_start?: string;
  source?: string;
  evidence?: Array<{ source: string; source_id?: string; quote?: string; extracted_at?: string }>;
}

const MIN_EVENTS = 100;     // floor to filter noise dirs
const TOP_N = 4;            // top N current projects pulled into workload

async function main() {
  const apply = process.argv.includes('--apply');
  const bundle = await loadOrBuildSnapshots({ windowDays: 30 });
  const agents = await fs.readdir(PATHS.agents);

  let changed = 0;
  let skipped_hand = 0;
  for (const file of agents) {
    if (!file.endsWith('.json')) continue;
    const name = file.replace(/\.json$/, '');
    const snap = bundle.snapshots.get(name);
    if (!snap) continue;
    const projects = (snap.current_projects ?? []).filter((p) => p.event_count >= MIN_EVENTS).slice(0, TOP_N);
    if (projects.length === 0) continue;

    const path = join(PATHS.agents, file);
    const raw = await fs.readFile(path, 'utf8');
    const profile = JSON.parse(raw) as {
      workload?: { active?: ActiveAssignment[] };
    };
    const hand = (profile.workload?.active ?? []).filter((a) => a.source !== 'auto_cc_cwd');
    if (hand.length > 0) {
      // Don't touch hand-curated entries; just refresh the auto block.
      skipped_hand += 1;
    }

    const autoEntries: ActiveAssignment[] = projects.map((p) => ({
      role: `${p.name} (CC ${p.event_count} events / ${p.active_days}d active)`,
      ts_start: p.last_at,
      source: 'auto_cc_cwd',
      evidence: [
        {
          source: 'cc_session',
          source_id: 'behavior_snapshot',
          quote: `cwd=${p.sample_cwd}`,
          extracted_at: bundle.as_of
        }
      ]
    }));
    const nextActive = [...hand, ...autoEntries];

    if (!apply) {
      console.log(`would update ${name}: ${autoEntries.length} auto entries (${autoEntries.map((a) => a.role.split(' (')[0]).join(', ')})`);
      changed += 1;
      continue;
    }

    profile.workload = { ...(profile.workload ?? {}), active: nextActive } as typeof profile.workload;
    await fs.writeFile(path, JSON.stringify(profile, null, 2) + '\n', 'utf8');
    changed += 1;
    console.log(`updated ${name}: +${autoEntries.length} auto entries`);
  }

  console.error(`\n[sync_profile_workload] ${changed} agents touched, ${skipped_hand} kept hand-curated alongside auto`);
  if (!apply) console.error('(dry-run; pass --apply)');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
