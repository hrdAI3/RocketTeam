// Unified event timeline.
// Append-only jsonl, mutex-protected. Reads stream from end (reverse-chunk).
// See: docs/superpowers/specs/2026-05-11-anomaly-engine-cc-native-design.md §3.

import { promises as fs, createReadStream } from 'node:fs';
import readline from 'node:readline';
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

// Process-local seq → event cache. Lazy-built on first miss; rebuilt once
// on any cache miss before returning null. Used by anomaly attribution
// (§2.4.2) to look up the cwd that triggered an anomaly without re-scanning
// the whole jsonl. Cache holds Event references, not copies — appendEvent /
// appendEvents do NOT invalidate it; we accept that anomaly attribution
// follows events that exist at index-build time, and the rebuild-on-miss
// catches anything appended since.
let seqIndex: Map<number, Event> | null = null;

async function buildSeqIndex(): Promise<Map<number, Event>> {
  const all = await readAllEvents();
  const m = new Map<number, Event>();
  for (const e of all) m.set(e.seq, e);
  return m;
}

export async function getEventBySeq(seq: number): Promise<Event | null> {
  if (!seqIndex) seqIndex = await buildSeqIndex();
  const hit = seqIndex.get(seq);
  if (hit) return hit;
  seqIndex = await buildSeqIndex();
  return seqIndex.get(seq) ?? null;
}

// HEAVY — full-file load. Use streamEvents() or readEventsWindow() for windowed
// queries; this one materializes the entire JSONL in memory as a single string
// via fs.readFile, which on the 524MB events.jsonl is dangerously close to
// Node's ~512MB max-string limit. Tolerated only for callers that genuinely
// need the full history (anomaly/rules, predict/snapshot_loader, projects);
// every read-time dashboard / API route MUST switch to streamEvents().
//
// New callers: do not add usage here. If you need a time window, use
//   await streamEvents({ since, source, ... }, e => { ... });
// or readEventsWindow(filter) when you genuinely need an array back.
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

// ============== streamEvents — memory-bounded reader ==============
//
// Line-by-line streaming of events.jsonl. Memory cost is one line at a time,
// not the whole file. Filters compiled once before the loop so the per-line
// hot path is a flat sequence of cheap checks.
//
// Use this for ANY caller that only needs a time window / single source /
// trailing slice of events. Reserve readAllEvents() for callers that
// genuinely need the full history.

export interface EventStreamFilter {
  since?: string;                  // ISO; skip events with ts < since
  until?: string;                  // ISO; bail early once ts >= until (file is roughly chronological)
  source?: EventSource | EventSource[];
  type?: string | string[];
  actor?: string;                  // exact actor match (post-resolution)
}

type Predicate = (e: Event) => boolean;

function compileStreamFilter(f: EventStreamFilter): Predicate {
  const sources: Set<string> | null = f.source
    ? new Set(Array.isArray(f.source) ? f.source : [f.source])
    : null;
  const types: Set<string> | null = f.type
    ? new Set(Array.isArray(f.type) ? f.type : [f.type])
    : null;
  const since = f.since;
  const actor = f.actor;
  return (e) => {
    if (since !== undefined && e.ts < since) return false;
    if (sources && !sources.has(e.source)) return false;
    if (types && !types.has(e.type)) return false;
    if (actor !== undefined && e.actor !== actor) return false;
    return true;
  };
}

/**
 * Stream events.jsonl line by line. Memory-bounded regardless of file size.
 * Filters applied per-line so the caller's callback only sees matching events.
 * Tolerates malformed lines (silently skips). The `until` bound short-circuits
 * the read once a line's ts crosses it (events.jsonl is roughly chronological
 * by append order).
 *
 * IMPORTANT: caller MUST NOT mutate the Event object — they're freshly parsed
 * per line, so mutation is just lossy.
 */
export async function streamEvents(
  filter: EventStreamFilter,
  onEvent: (e: Event) => void | Promise<void>
): Promise<void> {
  const predicate = compileStreamFilter(filter);
  const until = filter.until;
  let stream: ReturnType<typeof createReadStream>;
  try {
    stream = createReadStream(PATHS.events, {
      encoding: 'utf8',
      highWaterMark: 1 << 20
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  // Surface ENOENT (and other open-time errors that fire asynchronously) as
  // a no-op rather than an unhandled stream 'error' event.
  await new Promise<void>((resolve, reject) => {
    let rejected = false;
    stream.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        rejected = true;
        resolve();
        return;
      }
      rejected = true;
      reject(err);
    });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    (async () => {
      try {
        for await (const line of rl) {
          if (line.length === 0) continue;
          let event: Event;
          try {
            event = JSON.parse(line);
          } catch {
            continue; // torn / malformed line — skip
          }
          if (until !== undefined && event.ts >= until) {
            rl.close();
            stream.destroy();
            break;
          }
          if (!predicate(event)) continue;
          await onEvent(event);
        }
        if (!rejected) resolve();
      } catch (err) {
        if (!rejected) reject(err);
      }
    })();
  });
}

/**
 * Stream the trailing window of events matching the filter. Returns a fresh
 * array (caller-owned). Use this when you genuinely need an array (avoid for
 * very large windows — prefer streamEvents callback).
 */
export async function readEventsWindow(filter: EventStreamFilter): Promise<Event[]> {
  const out: Event[] = [];
  await streamEvents(filter, (e) => {
    out.push(e);
  });
  return out;
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
