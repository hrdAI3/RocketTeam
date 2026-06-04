#!/usr/bin/env bun
// Purge events whose actor is NOT a current team member.
//
// Definition of "current team member" = name appears as a value in
// identity.json email map (which is the canonical 8933 ↔ identity sync).
// Anything else — including `unknown:email:*` actors and historical real
// names that have rolled off collector — gets dropped.
//
// Also prunes sync_state to only emails currently on the collector.
//
// Backups created automatically. Pass --apply to commit; otherwise dry-run.

import { promises as fs } from 'node:fs';
import { createReadStream, createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { PATHS } from '../src/lib/paths';

const COLLECTOR = process.env.CC_COLLECTOR_BASE ?? 'http://192.168.22.88:8933';

async function fetchCollectorUsers(): Promise<string[]> {
  const r = await fetch(`${COLLECTOR}/api/users`);
  if (!r.ok) throw new Error(`collector ${r.status}`);
  const j = (await r.json()) as { users?: string[] };
  return j.users ?? [];
}

async function loadKeepNames(): Promise<Set<string>> {
  try {
    const raw = await fs.readFile(PATHS.identityMap, 'utf8');
    const j = JSON.parse(raw) as { email?: Record<string, string> };
    return new Set(Object.values(j.email ?? {}));
  } catch {
    return new Set();
  }
}

async function main() {
  const apply = process.argv.includes('--apply');

  const keepNames = await loadKeepNames();
  const collectorEmails = new Set(await fetchCollectorUsers());

  console.error(`[purge] keep set = ${keepNames.size} team names: ${[...keepNames].join(', ')}`);
  console.error(`[purge] collector emails = ${collectorEmails.size}`);

  // === events.jsonl ===
  const src = PATHS.events;
  const tmp = src + '.tmp.' + process.pid;

  let total = 0;
  let kept = 0;
  let dropped = 0;
  const dropByActor = new Map<string, number>();

  const outStream = apply ? createWriteStream(tmp, 'utf8') : null;
  const rl = createInterface({
    input: createReadStream(src, { encoding: 'utf8' }),
    crlfDelay: Infinity
  });

  for await (const line of rl) {
    total += 1;
    if (line.length === 0) {
      outStream?.write('\n');
      continue;
    }
    let e: { actor?: string; source?: string };
    try {
      e = JSON.parse(line);
    } catch {
      outStream?.write(line + '\n');
      kept += 1;
      continue;
    }

    // Keep events with no actor (system events, anomalies, predictions, etc.)
    if (!e.actor) {
      outStream?.write(line + '\n');
      kept += 1;
      continue;
    }

    // Drop unknown:* actors
    // Drop real names not in keep set
    if (e.actor.startsWith('unknown:') || !keepNames.has(e.actor)) {
      dropped += 1;
      dropByActor.set(e.actor, (dropByActor.get(e.actor) ?? 0) + 1);
      continue;
    }

    outStream?.write(line + '\n');
    kept += 1;
  }
  outStream?.end();
  await new Promise<void>((res, rej) => {
    if (!outStream) return res();
    outStream.on('finish', () => res());
    outStream.on('error', (err) => rej(err));
  });

  console.error('\n=== events.jsonl ===');
  console.error(`total:   ${total}`);
  console.error(`kept:    ${kept}`);
  console.error(`dropped: ${dropped}`);
  console.error('\ndrop-by-actor:');
  for (const [a, n] of [...dropByActor.entries()].sort((x, y) => y[1] - x[1])) {
    console.error(`  ${String(n).padStart(7)}  ${a}`);
  }

  // === sync_state/cc_session.json ===
  const syncPath = `${PATHS.syncState}/cc_session.json`;
  let syncBefore = 0;
  let syncDropped: string[] = [];
  let syncJson: { users: Record<string, { lastSyncedMtime?: string }> } | null = null;
  try {
    const raw = await fs.readFile(syncPath, 'utf8');
    syncJson = JSON.parse(raw);
    if (syncJson) {
      syncBefore = Object.keys(syncJson.users ?? {}).length;
      for (const email of Object.keys(syncJson.users ?? {})) {
        if (!collectorEmails.has(email)) syncDropped.push(email);
      }
    }
  } catch {
    /* ignore */
  }

  console.error('\n=== sync_state/cc_session.json ===');
  console.error(`emails before: ${syncBefore}`);
  console.error(`would drop:    ${syncDropped.length}`);
  for (const e of syncDropped) console.error(`  ${e}`);

  if (!apply) {
    console.error('\n(dry-run — pass --apply to commit, with backups)');
    return;
  }

  // Backup + replace events.jsonl
  const evBak = src + '.bak.purge.' + Date.now();
  await fs.copyFile(src, evBak);
  // Try rename then fall back to copy+unlink (Windows lock workaround)
  try {
    await fs.rename(tmp, src);
  } catch {
    await fs.copyFile(tmp, src);
    await fs.unlink(tmp);
  }
  console.error(`\n[apply] events.jsonl backup → ${evBak}`);
  console.error(`[apply] events.jsonl rewritten`);

  // Backup + clean sync_state
  if (syncJson && syncDropped.length > 0) {
    const syncBak = syncPath + '.bak.purge.' + Date.now();
    await fs.copyFile(syncPath, syncBak);
    for (const e of syncDropped) delete syncJson.users[e];
    await fs.writeFile(syncPath, JSON.stringify(syncJson, null, 2) + '\n', 'utf8');
    console.error(`[apply] sync_state backup → ${syncBak}`);
    console.error(`[apply] sync_state cleaned`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
