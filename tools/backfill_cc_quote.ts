// One-shot backfill: events.jsonl was populated when the cc_session extractor
// only captured `quote` for the Bash tool — every WebFetch / WebSearch / Write
// / Read / Edit / Grep / Glob / TodoWrite / TaskCreate / TaskUpdate event
// stored an empty quote, leaving 栾蕊加 (and anyone else who works through
// non-shell tools) as a black box to the LLM. The extractor was fixed
// (cc_session.ts ~line 234) — this tool re-parses each raw blob with the new
// logic and overwrites the `evidence.quote` field on the matching events
// in-place. All other fields (seq, ts, source, type, subject, actor, raw_ref)
// are preserved. Mutex is acquired via the events.ts machinery — but as a
// one-shot tool we just rename atomically.
//
// Run: bun tools/backfill_cc_quote.ts [--dry-run] [--user <email>]
//
// Safety:
//   - Writes to events.jsonl.backfill.tmp first, atomic rename only if line
//     count matches exactly.
//   - Preserves a backup at events.jsonl.bak-<ISO> next to the original.

import { readFile, writeFile, rename, copyFile } from 'node:fs/promises';
import { fetchSessionRaw, parseSession, listSessions } from '../src/extractors/cc_session';
import { PATHS } from '../src/lib/paths';
import { reverseLookup } from '../src/lib/identity';

interface Event {
  seq: number;
  ts: string;
  source: string;
  type: string;
  actor?: string;
  evidence?: { quote?: string; fields?: Record<string, unknown> };
  raw_ref?: string;
}

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const userIdx = args.indexOf('--user');
const onlyUser = userIdx >= 0 ? args[userIdx + 1] : null;

async function main(): Promise<void> {
  console.log('reading events.jsonl from', PATHS.events);
  const raw = await readFile(PATHS.events, 'utf8');
  const lines = raw.split('\n');
  console.log('total lines:', lines.length);

  // Group cc.tool_called events by raw_ref (= "email/date/sessionId").
  // Each event keeps its index into `lines` so we can patch in place.
  const byRef = new Map<string, Array<{ lineIdx: number; ev: Event }>>();
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (!ln) continue;
    let ev: Event;
    try {
      ev = JSON.parse(ln) as Event;
    } catch {
      continue;
    }
    if (ev.source !== 'cc_session' || ev.type !== 'cc.tool_called') continue;
    if (!ev.raw_ref) continue;
    if (ev.evidence?.quote) continue; // already has data; skip
    if (onlyUser && !ev.raw_ref.startsWith(onlyUser + '/')) continue;
    const arr = byRef.get(ev.raw_ref) ?? [];
    arr.push({ lineIdx: i, ev });
    byRef.set(ev.raw_ref, arr);
  }
  console.log('sessions with empty-quote tool events:', byRef.size);

  // The raw_ref doesn't store the file extension, so we need to discover it
  // per (email, date). listSessions returns SessionFileRef[] with ext per id.
  // Cache by (email|date) to avoid hammering the collector.
  const sessionIndex = new Map<string, Map<string, string>>(); // emailDate → sid → ext
  async function extFor(email: string, date: string, sid: string): Promise<string | null> {
    const k = email + '|' + date;
    let idx = sessionIndex.get(k);
    if (!idx) {
      try {
        const refs = await listSessions(email, date);
        idx = new Map(refs.map((r) => [r.id, r.ext]));
        sessionIndex.set(k, idx);
      } catch {
        sessionIndex.set(k, new Map());
        return null;
      }
    }
    return idx.get(sid) ?? null;
  }

  // For each raw_ref: pull raw blob, re-parse, zip new tool_called events to
  // old ones by position-in-session (parseSession iterates the same source in
  // the same order, so the Nth tool_called of session X maps 1:1).
  let patched = 0;
  let unmatched = 0;
  let fetchErrors = 0;
  let sessionsDone = 0;
  for (const [ref, group] of byRef) {
    const [email, date, sessionId] = ref.split('/');
    if (!email || !date || !sessionId) {
      unmatched += group.length;
      continue;
    }
    let parsed;
    try {
      const ext = await extFor(email, date, sessionId);
      if (!ext) {
        fetchErrors++;
        continue; // session no longer listed on collector (rotated out)
      }
      const blob = await fetchSessionRaw(email, date, sessionId, ext);
      const resolved = await reverseLookup(email).catch(() => ({ name: 'unknown' }));
      parsed = parseSession(email, date, sessionId, resolved.name ?? 'unknown', blob);
    } catch (err) {
      fetchErrors++;
      console.warn('  fetch/parse failed for', ref, '-', (err as Error).message);
      continue;
    }
    // Match by (ts, toolName) + occurrence index — robust to raw-blob truncation
    // (the collector sometimes retains only the tail of a long session, so a
    // strict position-zip would skip everything). Each (ts, tool) key gets a
    // numbered slot; old event slot N matches new event slot N if both exist.
    const newTool = parsed.events.filter((e) => e.type === 'cc.tool_called');
    const newByKey = new Map<string, Array<{ quote?: string }>>(); // key → ordered fresh entries
    for (const e of newTool) {
      const key = `${e.ts ?? ''}|${e.evidence?.fields?.tool ?? ''}`;
      const arr = newByKey.get(key) ?? [];
      arr.push({ quote: e.evidence?.quote });
      newByKey.set(key, arr);
    }
    const usedOccurrence = new Map<string, number>(); // key → next slot
    let groupPatched = 0;
    for (const { lineIdx, ev } of group) {
      const key = `${ev.ts ?? ''}|${ev.evidence?.fields?.tool ?? ''}`;
      const slot = usedOccurrence.get(key) ?? 0;
      usedOccurrence.set(key, slot + 1);
      const freshArr = newByKey.get(key);
      if (!freshArr || slot >= freshArr.length) {
        unmatched++;
        continue;
      }
      const freshQuote = freshArr[slot].quote;
      if (!freshQuote) continue; // nothing to write (this slot has no input data)
      ev.evidence = { ...(ev.evidence ?? {}), quote: freshQuote };
      lines[lineIdx] = JSON.stringify(ev);
      patched++;
      groupPatched++;
    }
    sessionsDone++;
    if (sessionsDone % 25 === 0) {
      console.log('  progress: ' + sessionsDone + '/' + byRef.size + ' sessions, ' + patched + ' patched');
    }
  }

  console.log(`done. sessions processed=${sessionsDone}, patched=${patched}, unmatched=${unmatched}, fetchErrors=${fetchErrors}`);

  if (dryRun) {
    console.log('--dry-run: not writing.');
    return;
  }
  if (patched === 0) {
    console.log('nothing to write.');
    return;
  }

  const backup = PATHS.events + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-');
  await copyFile(PATHS.events, backup);
  console.log('backup saved:', backup);

  const tmp = PATHS.events + '.backfill.tmp';
  await writeFile(tmp, lines.join('\n'), 'utf8');

  // Sanity: line count must match
  const newRaw = await readFile(tmp, 'utf8');
  if (newRaw.split('\n').length !== lines.length) {
    throw new Error('line count drift; refusing atomic rename');
  }
  await rename(tmp, PATHS.events);
  console.log('events.jsonl rewritten with', patched, 'patched quotes.');
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
