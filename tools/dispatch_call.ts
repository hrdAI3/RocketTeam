#!/usr/bin/env bun
// Cross-platform UTF-8-safe wrapper for the PMA v2 dispatch flow.
//
// Why this exists: on Windows, curl -d '...' under PowerShell/cmd corrupts
// Chinese in the request body (uses codepage 936/GBK instead of UTF-8).
// Bun's fetch + JSON.stringify always emit UTF-8, so this script is the
// stable entry point.
//
// Usage:
//   bun tools/dispatch_call.ts predict --description "<task>" [--importance high] [--urgency low]
//   bun tools/dispatch_call.ts notify  --task-id <id> [--override-to <name>] [--note "<text>"]
//
// Prints JSON response on stdout. Non-zero exit on HTTP error.

const BASE = process.env.TEAM_BASE_URL ?? 'http://localhost:3000';

function getArg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx < 0) return undefined;
  return process.argv[idx + 1];
}

function need(name: string): string {
  const v = getArg(name);
  if (!v) {
    console.error(`missing required --${name}`);
    process.exit(2);
  }
  return v;
}

async function callJSON(path: string, body: Record<string, unknown>): Promise<void> {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body)
  });
  const text = await r.text();
  if (!r.ok) {
    console.error(`HTTP ${r.status}: ${text.slice(0, 500)}`);
    process.exit(1);
  }
  // Pretty-print so Claude can parse it.
  try {
    const j = JSON.parse(text);
    console.log(JSON.stringify(j, null, 2));
  } catch {
    console.log(text);
  }
}

async function main() {
  const sub = process.argv[2];
  if (sub === 'predict') {
    const description = need('description');
    const importance = getArg('importance') as 'high' | 'low' | undefined;
    const urgency = getArg('urgency') as 'high' | 'low' | undefined;
    const body: Record<string, unknown> = { description };
    if (importance) body.importance = importance;
    if (urgency) body.urgency = urgency;
    await callJSON('/api/predict/v2', body);
  } else if (sub === 'notify') {
    const task_id = need('task-id');
    const override_to = getArg('override-to');
    const note = getArg('note');
    const body: Record<string, unknown> = { task_id };
    if (override_to) body.override_to = override_to;
    if (note) body.note = note;
    await callJSON('/api/predict/v2/notify', body);
  } else {
    console.error('usage: predict --description "<text>" | notify --task-id <id>');
    process.exit(2);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
