// Unified event timeline.
// Append-only jsonl, mutex-protected. Reads stream from end (reverse-chunk).
// See: docs/superpowers/specs/2026-05-11-anomaly-engine-cc-native-design.md §3.

import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { PATHS } from './paths';
import { withMutex } from './mutex';
import type { Event, EventSource } from '../types/events';

const EVENTS_MUTEX_KEY = 'events:append';
const SEQ_FILE = PATHS.events + '.seq';

async function nextSeq(): Promise<number> {
  // Sequence persisted in a sibling .seq file. Single-process safe via mutex
  // wrapping the read-modify-write. We do not read the JSONL to derive seq
  // because that's O(file size).
  try {
    const raw = await fs.readFile(SEQ_FILE, 'utf8');
    const n = Number.parseInt(raw.trim(), 10);
    const next = Number.isFinite(n) ? n + 1 : 1;
    await fs.writeFile(SEQ_FILE, String(next), 'utf8');
    return next;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      await fs.writeFile(SEQ_FILE, '1', 'utf8');
      return 1;
    }
    throw err;
  }
}

export interface NewEvent {
  ts?: string;
  source: Event['source'];
  type: string;
  subject: Event['subject'];
  actor?: string;
  evidence?: Event['evidence'];
  raw_ref?: string;
}

export async function appendEvent(input: NewEvent): Promise<Event> {
  return withMutex(EVENTS_MUTEX_KEY, async () => {
    await fs.mkdir(dirname(PATHS.events), { recursive: true });
    const seq = await nextSeq();
    const event: Event = {
      seq,
      ts: input.ts ?? new Date().toISOString(),
      source: input.source,
      type: input.type,
      subject: input.subject,
      actor: input.actor,
      evidence: input.evidence ?? {},
      raw_ref: input.raw_ref
    };
    await fs.appendFile(PATHS.events, JSON.stringify(event) + '\n', 'utf8');
    return event;
  });
}

export async function appendEvents(inputs: NewEvent[]): Promise<Event[]> {
  // Single mutex acquisition for a batch. Avoids n round-trips when an
  // extractor emits many events at once.
  return withMutex(EVENTS_MUTEX_KEY, async () => {
    await fs.mkdir(dirname(PATHS.events), { recursive: true });
    const out: Event[] = [];
    let lines = '';
    for (const input of inputs) {
      const seq = await nextSeq();
      const event: Event = {
        seq,
        ts: input.ts ?? new Date().toISOString(),
        source: input.source,
        type: input.type,
        subject: input.subject,
        actor: input.actor,
        evidence: input.evidence ?? {},
        raw_ref: input.raw_ref
      };
      out.push(event);
      lines += JSON.stringify(event) + '\n';
    }
    if (lines.length > 0) await fs.appendFile(PATHS.events, lines, 'utf8');
    return out;
  });
}

// Full scan reader. Memory cost is the JSONL line count.
// For multi-MB files we should add an indexed reader, but at one event per
// significant action this stays manageable for months.
export async function readAllEvents(): Promise<Event[]> {
  try {
    const raw = await fs.readFile(PATHS.events, 'utf8');
    const out: Event[] = [];
    for (const line of raw.split('\n')) {
      if (line.trim().length === 0) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        // skip corrupt lines
      }
    }
    return out;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

export interface EventFilter {
  source?: EventSource;
  type?: string | string[];
  sinceSeq?: number;
  sinceTs?: string;
  subjectKind?: Event['subject']['kind'];
  subjectRef?: string;
  limit?: number;
}

export async function readEvents(filter: EventFilter = {}): Promise<Event[]> {
  const all = await readAllEvents();
  const typeSet = Array.isArray(filter.type)
    ? new Set(filter.type)
    : filter.type
      ? new Set([filter.type])
      : null;
  let out = all.filter((e) => {
    if (filter.source && e.source !== filter.source) return false;
    if (typeSet && !typeSet.has(e.type)) return false;
    if (filter.sinceSeq !== undefined && e.seq <= filter.sinceSeq) return false;
    if (filter.sinceTs !== undefined && e.ts < filter.sinceTs) return false;
    if (filter.subjectKind && e.subject.kind !== filter.subjectKind) return false;
    if (filter.subjectRef && e.subject.ref !== filter.subjectRef) return false;
    return true;
  });
  if (filter.limit !== undefined && filter.limit > 0) {
    out = out.slice(-filter.limit);
  }
  return out;
}

// Cursor state — used by extractors to remember "what did I last sync".
// Stored as JSON file per source under PATHS.syncState.
export async function readSyncState<T = unknown>(source: string): Promise<T | null> {
  const path = `${PATHS.syncState}/${source}.json`;
  try {
    const raw = await fs.readFile(path, 'utf8');
    return JSON.parse(raw) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function writeSyncState(source: string, state: unknown): Promise<void> {
  await fs.mkdir(PATHS.syncState, { recursive: true });
  const path = `${PATHS.syncState}/${source}.json`;
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
  await fs.rename(tmp, path);
}
