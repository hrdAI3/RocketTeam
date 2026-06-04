// /api/unclustered — enriched feed for the /status/unclustered drill-down.
// Joins workboard's unclustered items with the aging tracker so the UI can
// show "X hours unattributed" + the operator + a one-line detail.

import { getWorkboardView } from '@/services/workboard';
import { readSyncState } from '@/lib/events';
import { memoTTL } from '@/lib/ttl_cache';

export const dynamic = 'force-dynamic';

interface AgingEntry {
  title: string;
  operator: string;
  first_seen: string;
}
interface AgingState {
  entries?: Record<string, AgingEntry>;
}

interface EnrichedItem {
  id: string; // stable hash of title
  title: string;
  status: '进行中' | '卡住' | '已完成';
  ownerName: string | null;
  detail: string | null;
  repo: string | null;
  firstSeenAt: string | null;
  ageHours: number | null;
  // true once age ≥ 24h — UI uses to flag rows the aging tracker will DM
  // about. Mirrors `AGE_THRESHOLD_MS` in monitor_loop.ts.
  aging: boolean;
}

function stableId(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export async function GET(): Promise<Response> {
  return Response.json(await memoTTL('unclustered', 90_000, computeUnclustered));
}

async function computeUnclustered(): Promise<{ items: EnrichedItem[]; aggregate: { total: number; blocked: number; aging: number; fresh: number } }> {
  const [view, aging] = await Promise.all([
    getWorkboardView(),
    readSyncState<AgingState>('unattributed_aging').then((s) => s ?? {})
  ]);
  const agingEntries = aging.entries ?? {};
  const now = Date.now();
  const items: EnrichedItem[] = view.unclustered.map((u) => {
    const id = stableId(u.title);
    const a = agingEntries[id];
    const firstSeenAt = a?.first_seen ?? null;
    const ageHours = firstSeenAt
      ? Math.max(0, (now - Date.parse(firstSeenAt)) / 3_600_000)
      : null;
    return {
      id,
      title: u.title,
      status: u.status,
      ownerName: u.ownerName ?? null,
      detail: u.detail ?? null,
      repo: u.repo ?? null,
      firstSeenAt,
      ageHours,
      aging: ageHours !== null && ageHours >= 24
    };
  });
  // Severity sort: 卡住 first, then ongoing aging, then ongoing fresh, then 已完成.
  items.sort((a, b) => {
    const rank = (it: EnrichedItem): number => {
      if (it.status === '已完成') return 3;
      if (it.status === '卡住') return 0;
      if (it.aging) return 1;
      return 2;
    };
    const r = rank(a) - rank(b);
    if (r !== 0) return r;
    // Within tier, oldest first (most urgent).
    return (b.ageHours ?? 0) - (a.ageHours ?? 0);
  });
  return {
    items,
    aggregate: {
      total: items.length,
      blocked: items.filter((i) => i.status === '卡住').length,
      aging: items.filter((i) => i.aging && i.status !== '已完成').length,
      fresh:
        items.filter((i) => !i.aging && i.status === '进行中').length
    }
  };
}
