// CLI: bun run bootstrap
//
// Standalone bootstrap entry point. Useful in Day 1 EOD checkpoint to
// regenerate profiles without spinning up the full Next.js dev server.

import { runBootstrap, DEFAULT_TARGETS, parseOrgChart } from '../bootstrap/extract';
import { deleteAllAgents } from '../lib/agents';

async function main() {
  const args = process.argv.slice(2);
  const clear = args.includes('--clear');
  if (clear) {
    const n = await deleteAllAgents();
    console.log(`[bootstrap] cleared ${n} existing agents`);
  }

  const org = await parseOrgChart();
  const targetNames = DEFAULT_TARGETS.map((t) => t.name);
  const targets =
    org.length > 0
      ? DEFAULT_TARGETS.map((t) => {
          const match = org.find((e) => e.name === t.name);
          return match ? { ...t, dept: match.dept, role: match.role } : t;
        })
      : DEFAULT_TARGETS;

  console.log(`[bootstrap] targets: ${targetNames.join(', ')}`);
  const result = await runBootstrap({
    targets,
    onProgress: (status) => {
      console.log(`[bootstrap] ${status.phase} ${status.current}/${status.total} - ${status.message}`);
    }
  });
  console.log(`[bootstrap] done. profiles: ${result.profiles.map((p) => p.name).join(', ')}`);
  if (result.errors.length > 0) {
    console.warn(`[bootstrap] ${result.errors.length} warnings:`);
    for (const e of result.errors) console.warn(`  - ${e}`);
  }
}

main().catch((err) => {
  console.error('[bootstrap] fatal:', err);
  process.exit(1);
});
