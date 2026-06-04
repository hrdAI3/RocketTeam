// Smoke test: stream the full events.jsonl with a no-op callback and report
// memory + counts. Validates that streamEvents() actually stays bounded on
// the 500MB+ events.jsonl (the bug this whole refactor exists to fix).
//
// Run: bun run tools/check_events_memory.ts
//      or: npx tsx tools/check_events_memory.ts

import { promises as fs } from 'node:fs';
import { streamEvents } from '../src/lib/events';
import { PATHS } from '../src/lib/paths';

function fmtBytes(n: number): string {
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${u[i]}`;
}

async function main(): Promise<void> {
  const stat = await fs.stat(PATHS.events);
  console.log(`[check_events_memory] events.jsonl: ${fmtBytes(stat.size)}`);

  const start = Date.now();
  let maxRssBytes = process.memoryUsage().rss;
  let lineCount = 0;
  let bytesRoughlyProcessed = 0;
  const sampleEvery = 50_000;

  await streamEvents({}, (e) => {
    lineCount++;
    // Track approximate processed bytes — useful when comparing against file
    // size to spot early bailout bugs.
    bytesRoughlyProcessed += JSON.stringify(e).length + 1;
    if (lineCount % sampleEvery === 0) {
      const rss = process.memoryUsage().rss;
      if (rss > maxRssBytes) maxRssBytes = rss;
    }
  });

  const rssEnd = process.memoryUsage().rss;
  if (rssEnd > maxRssBytes) maxRssBytes = rssEnd;
  const elapsedMs = Date.now() - start;
  console.log(`[check_events_memory] streamed ${lineCount.toLocaleString()} events`);
  console.log(`[check_events_memory] elapsed: ${(elapsedMs / 1000).toFixed(1)}s`);
  console.log(`[check_events_memory] processed bytes (approx): ${fmtBytes(bytesRoughlyProcessed)}`);
  console.log(`[check_events_memory] max RSS: ${fmtBytes(maxRssBytes)}`);
  console.log(`[check_events_memory] final RSS: ${fmtBytes(rssEnd)}`);
  // Pass / fail heuristic: max RSS should be well under the file size — if it
  // tracks the file size we're effectively buffering, which defeats the point.
  const ok = maxRssBytes < stat.size * 0.6;
  console.log(`[check_events_memory] bounded: ${ok ? 'PASS' : 'FAIL'}`);
  if (!ok) process.exit(2);
}

main().catch((err) => {
  console.error('[check_events_memory] ERROR', err);
  process.exit(1);
});
