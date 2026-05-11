// Minimal placeholder seed. Replace with real persona seed data in
// ../private/seed/seed.ts (gitignored). This stub demonstrates the shape and
// lets `bun run seed` succeed on a fresh clone.
//
// Run with: bun run seed
//
// The real seed file in private/seed/seed.ts is loaded automatically by the
// `seed` package.json script when present.

import { writeProfile } from '../../src/lib/agents';
import type { TeamMemberProfile } from '../../src/types';

function ev(source_id: string, quote: string, speaker?: string) {
  return { source_id, quote, ...(speaker ? { speaker } : {}) };
}

const PROFILES: TeamMemberProfile[] = [
  {
    name: '张三',
    dept: '研发',
    role: '研发负责人',
    capabilities: {
      domains: [
        { name: '示例领域', level: 3, evidence: [ev('seed/example.txt', '示例证据')] }
      ],
      skills: [
        { name: '示例技能', level: 3, evidence: [ev('seed/example.txt', '示例证据')] }
      ]
    },
    workload: {
      active: [],
      blocked_on: [],
      hard_constraints: []
    },
    energy: { current: 'normal', evidence: [] },
    collab: { pairs_well_with: [], pairs_poorly_with: [] },
    trajectory: {
      learning_focus: [],
      stretch_appetite: 'medium',
      evidence: []
    },
    transcript_misspellings: [],
    recent_overrides: [],
    recent_praises: [],
    recent_objections: [],
    _meta: {
      schema_version: 2,
      bootstrapped_at: new Date().toISOString(),
      evolution_count: 0,
      source_files: ['seed/example.txt'],
      eligible_for_query: true
    }
  }
];

async function main(): Promise<void> {
  for (const p of PROFILES) {
    await writeProfile(p);
    console.log(`seeded ${p.name}`);
  }
}

void main();
