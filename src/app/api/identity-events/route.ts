// GET /api/identity-events — lightweight slice of /api/team/context for the
// Sources page. Returns ONLY { identity, events } — no agent snapshots, no
// buildMergedProjects. /api/team/context takes ~27s (full snapshot load +
// project merge) which made /sources crawl even though it only needs the
// identity maps + event-source counts. This route skips all the heavy work:
// identity is a single file read; event counts are a regex scan (no per-line
// JSON.parse over 234k lines).

import { promises as fs } from 'node:fs';
import { NextResponse } from 'next/server';
import { PATHS } from '@/lib/paths';
import { memoTTL } from '@/lib/ttl_cache';

export const dynamic = 'force-dynamic';

interface IdentityFile {
  email?: Record<string, string>;
  github?: Record<string, string>;
  slack?: Record<string, string>;
}

async function loadIdentity() {
  try {
    const j = JSON.parse(await fs.readFile(PATHS.identityMap, 'utf8')) as IdentityFile;
    return {
      email: Object.entries(j.email ?? {}),
      github: Object.entries(j.github ?? {}),
      slack: Object.entries(j.slack ?? {})
    };
  } catch {
    return { email: [], github: [], slack: [] };
  }
}

// Regex scan instead of JSON.parse per line — `"source":"x"` and `"ts":"…"`
// are stable in the event schema, so we count them directly. ~10× faster than
// parsing every one of the 200k+ lines.
async function loadEventCounts() {
  try {
    const raw = await fs.readFile(PATHS.events, 'utf8');
    const by_source: Record<string, number> = {};
    let total = 0;
    let latest_ts: string | null = null;
    const srcRe = /"source":"([^"]+)"/;
    const tsRe = /"ts":"([^"]+)"/;
    for (const line of raw.split('\n')) {
      if (line.length < 8) continue;
      total += 1;
      const s = srcRe.exec(line);
      if (s) by_source[s[1]] = (by_source[s[1]] ?? 0) + 1;
      const t = tsRe.exec(line);
      if (t && (!latest_ts || t[1] > latest_ts)) latest_ts = t[1];
    }
    return { total, by_source, latest_ts };
  } catch {
    return { total: 0, by_source: {}, latest_ts: null };
  }
}

export async function GET(): Promise<Response> {
  const data = await memoTTL('identity-events', 90_000, async () => {
    const [identity, events] = await Promise.all([loadIdentity(), loadEventCounts()]);
    return { identity, events };
  });
  return NextResponse.json(data);
}
