#!/usr/bin/env bun
// Trigger the GitHub extractor (src/extractors/github.ts:syncGithub) once.
// Pulls recent PR / commit / review events from the selected_repos in
// private/configs/github.config.json and appends them to events.jsonl.

import { syncGithub } from '../src/extractors/github';

async function main() {
  console.error('[gh-sync] starting...');
  const t0 = Date.now();
  const summary = await syncGithub();
  console.error(`[gh-sync] done in ${Date.now() - t0}ms`);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
