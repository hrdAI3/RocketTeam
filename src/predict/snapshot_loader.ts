// Loads the latest behavior snapshot bundle from private/index/.
//
// If no snapshot exists yet, builds one on-the-fly from events.jsonl —
// useful for the very first prediction before the nightly cron has run.

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { PATHS } from '../lib/paths';
import { readEventsWindow } from '../lib/events';
import { buildSnapshots } from '../index/behavior';
import type { AgentBehaviorSnapshot } from '../index/behavior';
import type { SnapshotsBundle } from './types';

const SNAPSHOT_DIR = join(PATHS.root, 'index');
const STALE_THRESHOLD_MS = 7 * 86400000; // > 7d old = rebuild

export async function loadOrBuildSnapshots(opts?: {
  windowDays?: 30 | 90;
  asOf?: Date;
  forceRebuild?: boolean;
}): Promise<SnapshotsBundle> {
  const windowDays = opts?.windowDays ?? 30;
  const asOf = opts?.asOf ?? new Date();

  if (!opts?.forceRebuild) {
    const latest = await findLatestSnapshotFile();
    if (latest) {
      const raw = await fs.readFile(latest, 'utf8');
      const parsed = JSON.parse(raw) as {
        as_of: string;
        window_days: 30 | 90;
        snapshots: Record<string, AgentBehaviorSnapshot>;
      };
      const ageMs = Date.now() - new Date(parsed.as_of).getTime();
      if (ageMs <= STALE_THRESHOLD_MS && parsed.window_days === windowDays) {
        const map = new Map<string, AgentBehaviorSnapshot>();
        for (const [k, v] of Object.entries(parsed.snapshots)) map.set(k, v);
        return {
          as_of: parsed.as_of,
          window_days: parsed.window_days,
          snapshots: map,
          source_path: latest
        };
      }
    }
  }

  // Build fresh. `windowDays` is a declared per-call bound (max 90), so we
  // stream exactly that window — bounded memory regardless of how large
  // events.jsonl grows. Previously this used readAllEvents() and would soon
  // OOM (file ≈ Node's max-string limit).
  const agentNames = await listAgentNames();
  const sinceIso = new Date(asOf.getTime() - windowDays * 86400000).toISOString();
  const events = await readEventsWindow({ since: sinceIso });
  const snapshots = buildSnapshots({ events, agentNames, asOf, windowDays });
  return {
    as_of: asOf.toISOString(),
    window_days: windowDays,
    snapshots,
    source_path: '(built on demand)'
  };
}

async function findLatestSnapshotFile(): Promise<string | null> {
  try {
    const files = await fs.readdir(SNAPSHOT_DIR);
    const matches = files.filter((f) => /^behavior_\d{4}-\d{2}-\d{2}\.json$/.test(f));
    if (matches.length === 0) return null;
    matches.sort().reverse();
    return join(SNAPSHOT_DIR, matches[0]);
  } catch {
    return null;
  }
}

async function listAgentNames(): Promise<string[]> {
  const entries = await fs.readdir(PATHS.agents);
  return entries
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''))
    .sort();
}
