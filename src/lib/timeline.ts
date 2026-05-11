// Append-only timeline log. Every PMA decision, evolution, override,
// and bootstrap event lands here. Used by /timeline view + as audit trail.
//
// JSONL format. One event per line.
//
// M0 hardening:
//   - appendTimelineEvent now serialised through a process-wide mutex so two
//     concurrent writers cannot interleave a partial line into the file.
//     fs.appendFile alone is NOT atomic for arbitrary line sizes.
//   - readTimeline uses a reverse-chunk reader so we only materialise the
//     last N events instead of slurping the whole file. Bounded memory and
//     latency at any timeline size.

import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { PATHS } from './paths';
import { withMutex } from './mutex';
import type { TimelineEvent } from '../types/index';

const TIMELINE_MUTEX_KEY = 'timeline:append';

export async function appendTimelineEvent(event: TimelineEvent): Promise<void> {
  await withMutex(TIMELINE_MUTEX_KEY, async () => {
    await fs.mkdir(dirname(PATHS.timeline), { recursive: true });
    const line = JSON.stringify(event) + '\n';
    await fs.appendFile(PATHS.timeline, line, 'utf8');
  });
}

const READ_CHUNK = 64 * 1024;
const NEWLINE_BYTE = 0x0a;

// Read the last `limit` JSON-line events without loading the entire file.
// Strategy: open the file, read fixed-size BYTE chunks from the end backwards
// until we have at least `limit + 1` newlines (or hit the start), then decode
// the accumulated bytes ONCE as UTF-8. Decoding per-chunk would split multi-byte
// CJK characters straddling chunk boundaries into U+FFFD pairs — fatal for a
// Chinese-content app.
async function readLastLines(filePath: string, limit: number): Promise<string[]> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(filePath, 'r');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  try {
    const stat = await handle.stat();
    let position = stat.size;
    const pieces: Buffer[] = [];
    let newlineCount = 0;
    while (position > 0 && newlineCount <= limit) {
      const readSize = Math.min(READ_CHUNK, position);
      position -= readSize;
      const buf = Buffer.alloc(readSize);
      const { bytesRead } = await handle.read(buf, 0, readSize, position);
      const slice = buf.subarray(0, bytesRead);
      pieces.unshift(slice);
      for (let i = 0; i < slice.length; i++) {
        if (slice[i] === NEWLINE_BYTE) newlineCount++;
      }
    }
    const decoded = Buffer.concat(pieces).toString('utf8');
    const lines = decoded.split('\n').filter((l) => l.trim().length > 0);
    return lines.slice(-limit);
  } finally {
    await handle.close();
  }
}

export async function readTimeline(limit = 200): Promise<TimelineEvent[]> {
  const lines = await readLastLines(PATHS.timeline, limit);
  const events: TimelineEvent[] = [];
  for (const line of lines) {
    try {
      events.push(JSON.parse(line));
    } catch {
      // Skip corrupted lines rather than failing the whole read.
    }
  }
  return events.reverse(); // newest first
}
