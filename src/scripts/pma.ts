// CLI: bun run pma "<task description>"
//
// Used in Day 2 EOD HARD CHECKPOINT to verify PMA quality on real tasks.
// Prints the decision JSON to stdout.

import { pmaPredictAssignee } from '../pma/coordinator';

async function main() {
  const desc = process.argv.slice(2).join(' ').trim();
  if (!desc) {
    console.error('Usage: bun run pma "<task description>"');
    process.exit(1);
  }
  const result = await pmaPredictAssignee({
    taskDescription: desc,
    onSynthesisToken: (t) => process.stdout.write(t)
  });
  process.stdout.write('\n\n');
  console.log(JSON.stringify(result.decision, null, 2));
  console.error(
    `[pma] ask=${result.latencies.ask_phase_ms}ms synth=${result.latencies.synthesis_ms}ms total=${result.latencies.total_ms}ms`
  );
}

main().catch((err) => {
  console.error('[pma] fatal:', err);
  process.exit(1);
});
