// Print today's briefing to stdout.
// Usage:
//   bun run src/scripts/today.ts

import { runToday } from '../services/today';

async function main(): Promise<void> {
  const r = await runToday({});
  process.stdout.write(r.markdown + '\n');
  process.stderr.write(`\n[meta] anomalies=${r.inputSummary.anomalies} signals=${r.inputSummary.signals}\n`);
}

void main();
