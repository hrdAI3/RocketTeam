#!/usr/bin/env bun
// Rewrite events.jsonl in place: apply current identity.json email map to
// historical events that were captured with actor/subject.ref as
// `unknown:email:<address>`. After this runs, downstream readers don't need
// the in-memory remap fallback.
//
// Safety:
//   - Backup the file before touching it (events.jsonl.bak.<ts>)
//   - Stream line-by-line, write to a sibling .tmp, atomic rename at end
//   - Skip lines that fail to parse (leave the raw line untouched in output)
//   - Print before/after histogram of actor coverage
//
// Usage:
//   bun tools/rewrite_events_with_identity.ts          # dry-run (count + sample diffs)
//   bun tools/rewrite_events_with_identity.ts --apply  # actually rewrite

import { promises as fs } from 'node:fs';
import { createReadStream, createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { PATHS } from '../src/lib/paths';

interface IdentityMap {
  email?: Record<string, string>;
  github?: Record<string, string>;
  slack?: Record<string, string>;
}

interface ChannelMaps {
  email: Record<string, string>;
  github: Record<string, string>;
  slack: Record<string, string>;
}

async function loadIdentity(): Promise<ChannelMaps> {
  try {
    const raw = await fs.readFile(PATHS.identityMap, 'utf8');
    const j = JSON.parse(raw) as IdentityMap;
    return {
      email: j.email ?? {},
      github: j.github ?? {},
      slack: j.slack ?? {}
    };
  } catch {
    return { email: {}, github: {}, slack: {} };
  }
}

const PREFIXES = ['unknown:email:', 'unknown:github:', 'unknown:slack:'] as const;
type ChannelKind = 'email' | 'github' | 'slack';

function maybeRemap(value: string, maps: ChannelMaps): string | null {
  if (typeof value !== 'string') return null;
  for (const prefix of PREFIXES) {
    if (!value.startsWith(prefix)) continue;
    const kind = prefix.slice('unknown:'.length, -1) as ChannelKind;
    const id = value.slice(prefix.length);
    return maps[kind][id] ?? null;
  }
  return null;
}

interface RemapStats {
  total_lines: number;
  parse_failed: number;
  actor_remapped: number;
  subject_ref_remapped: number;
  by_email: Record<string, number>;
  samples: Array<{ before: string; after: string }>;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const srcFlagIdx = process.argv.indexOf('--src');
  const customSrc = srcFlagIdx >= 0 ? process.argv[srcFlagIdx + 1] : null;
  const maps = await loadIdentity();
  const totalMappings = Object.keys(maps.email).length + Object.keys(maps.github).length + Object.keys(maps.slack).length;
  if (totalMappings === 0) {
    console.error('identity.json all channel maps empty; nothing to do');
    process.exit(1);
  }
  console.error(`[rewrite] loaded ${Object.keys(maps.email).length} email + ${Object.keys(maps.github).length} github + ${Object.keys(maps.slack).length} slack mappings`);

  const src = customSrc ?? PATHS.events;
  const stat = await fs.stat(src);
  console.error(`[rewrite] source ${src} size=${stat.size} bytes`);

  const tmp = src + '.tmp.' + process.pid;
  const bak = src + '.bak.' + Date.now();

  const stats: RemapStats = {
    total_lines: 0,
    parse_failed: 0,
    actor_remapped: 0,
    subject_ref_remapped: 0,
    by_email: {},
    samples: []
  };

  const outStream = apply ? createWriteStream(tmp, 'utf8') : null;
  const rl = createInterface({
    input: createReadStream(src, { encoding: 'utf8' }),
    crlfDelay: Infinity
  });

  for await (const line of rl) {
    stats.total_lines += 1;
    if (line.length === 0) {
      outStream?.write('\n');
      continue;
    }
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(line);
    } catch {
      stats.parse_failed += 1;
      outStream?.write(line + '\n');
      continue;
    }

    let mutated = false;

    // actor field
    if (typeof e.actor === 'string') {
      const remapped = maybeRemap(e.actor, maps);
      if (remapped !== null) {
        const original = e.actor as string;
        stats.by_email[original] = (stats.by_email[original] ?? 0) + 1;
        if (stats.samples.length < 5) {
          stats.samples.push({ before: original, after: remapped });
        }
        e.actor = remapped;
        stats.actor_remapped += 1;
        mutated = true;
      }
    }

    // subject.ref field
    const subj = e.subject as { kind?: string; ref?: string } | undefined;
    if (subj && typeof subj.ref === 'string') {
      const remapped = maybeRemap(subj.ref, maps);
      if (remapped !== null) {
        subj.ref = remapped;
        stats.subject_ref_remapped += 1;
        mutated = true;
      }
    }

    outStream?.write((mutated ? JSON.stringify(e) : line) + '\n');
  }
  outStream?.end();
  await new Promise<void>((res, rej) => {
    if (!outStream) return res();
    outStream.on('finish', () => res());
    outStream.on('error', (e) => rej(e));
  });

  console.error('\n=== summary ===');
  console.error(`lines total:              ${stats.total_lines}`);
  console.error(`lines parse failed:       ${stats.parse_failed}`);
  console.error(`actor remapped:           ${stats.actor_remapped}`);
  console.error(`subject.ref remapped:     ${stats.subject_ref_remapped}`);
  console.error(`\nby unmapped source id:`);
  function resolveAfter(id: string): string | null {
    for (const prefix of PREFIXES) {
      if (!id.startsWith(prefix)) continue;
      const kind = prefix.slice('unknown:'.length, -1) as ChannelKind;
      return maps[kind][id.slice(prefix.length)] ?? null;
    }
    return null;
  }
  for (const [id, n] of Object.entries(stats.by_email).sort((a, b) => b[1] - a[1])) {
    console.error(`  ${String(n).padStart(7)}  ${id} → ${resolveAfter(id) ?? '?'}`);
  }
  console.error('\nfirst remap samples:');
  for (const s of stats.samples) console.error(`  ${s.before} → ${s.after}`);

  if (!apply) {
    console.error('\n(dry-run — pass --apply to commit, with backup)');
    return;
  }

  await fs.copyFile(src, bak);
  console.error(`\n[apply] backup → ${bak}`);
  await fs.rename(tmp, src);
  console.error(`[apply] rewrote ${src}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
