// Anomaly persistence layer.
// Two files:
//   - anomalies.jsonl    : append-only state log (open / snooze / resolve / dismiss)
//   - anomalies.current.json : current open snapshot, refreshed on every engine tick
//
// Snapshot regen comes from reducing the jsonl log; the .current.json is only a
// fast-read view. Anomaly entity shape: src/types/events.ts.

import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { PATHS } from '../lib/paths';
import { withMutex } from '../lib/mutex';
import type { Anomaly, AnomalyStatus } from '../types/events';

const MUTEX_KEY = 'anomalies:append';

type LogRecord =
  | { kind: 'open'; anomaly: Anomaly }
  | { kind: 'seen'; id: string; ts: string; seqs: number[] }
  | { kind: 'snooze'; id: string; until: string; ts: string }
  | { kind: 'resolve'; id: string; ts: string; by: 'leader' | 'system'; action: string; outcome?: string }
  | { kind: 'dismiss'; id: string; ts: string; by: 'leader' | 'system' };

async function appendRecord(rec: LogRecord): Promise<void> {
  await withMutex(MUTEX_KEY, async () => {
    await fs.mkdir(dirname(PATHS.anomalies), { recursive: true });
    await fs.appendFile(PATHS.anomalies, JSON.stringify(rec) + '\n', 'utf8');
  });
}

export async function recordOpen(anomaly: Anomaly): Promise<void> {
  await appendRecord({ kind: 'open', anomaly });
}

export async function recordSeen(id: string, seqs: number[]): Promise<void> {
  await appendRecord({ kind: 'seen', id, ts: new Date().toISOString(), seqs });
}

export async function recordSnooze(id: string, until: string): Promise<void> {
  await appendRecord({ kind: 'snooze', id, ts: new Date().toISOString(), until });
}

export async function recordResolve(
  id: string,
  by: 'leader' | 'system',
  action: string,
  outcome?: string
): Promise<void> {
  await appendRecord({ kind: 'resolve', id, ts: new Date().toISOString(), by, action, outcome });
}

export async function recordDismiss(id: string, by: 'leader' | 'system'): Promise<void> {
  await appendRecord({ kind: 'dismiss', id, ts: new Date().toISOString(), by });
}

async function readLog(): Promise<LogRecord[]> {
  try {
    const raw = await fs.readFile(PATHS.anomalies, 'utf8');
    const out: LogRecord[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as LogRecord);
      } catch {
        // skip corrupt
      }
    }
    return out;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

// Materialize current anomaly map from log.
export async function reduceAnomalies(): Promise<Map<string, Anomaly>> {
  const log = await readLog();
  const m = new Map<string, Anomaly>();
  for (const r of log) {
    if (r.kind === 'open') {
      m.set(r.anomaly.id, { ...r.anomaly });
    } else {
      const existing = m.get(r.id);
      if (!existing) continue;
      if (r.kind === 'seen') {
        existing.last_seen_at = r.ts;
        const set = new Set([...existing.evidence_event_seqs, ...r.seqs]);
        existing.evidence_event_seqs = [...set].sort((a, b) => a - b);
      } else if (r.kind === 'snooze') {
        existing.status = 'snoozed';
        existing.snoozed_until = r.until;
      } else if (r.kind === 'resolve') {
        existing.status = 'resolved';
        existing.resolution = { action: r.action, by: r.by, at: r.ts, outcome: r.outcome };
      } else if (r.kind === 'dismiss') {
        existing.status = 'dismissed';
        existing.resolution = { action: 'dismiss', by: r.by, at: r.ts };
      }
    }
  }
  return m;
}

export async function listOpenAnomalies(): Promise<Anomaly[]> {
  const m = await reduceAnomalies();
  const out: Anomaly[] = [];
  const now = new Date().toISOString();
  for (const a of m.values()) {
    let status: AnomalyStatus = a.status;
    if (status === 'snoozed' && a.snoozed_until && a.snoozed_until <= now) {
      status = 'open';
    }
    if (status === 'open') out.push(a);
  }
  out.sort((x, y) => (x.triggered_at < y.triggered_at ? 1 : -1));
  return out;
}

export async function getAnomaly(id: string): Promise<Anomaly | null> {
  const m = await reduceAnomalies();
  return m.get(id) ?? null;
}

export async function writeCurrentSnapshot(anomalies: Anomaly[]): Promise<void> {
  await fs.mkdir(dirname(PATHS.anomaliesCurrent), { recursive: true });
  const tmp = `${PATHS.anomaliesCurrent}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify({ updated_at: new Date().toISOString(), anomalies }, null, 2), 'utf8');
  await fs.rename(tmp, PATHS.anomaliesCurrent);
}
