// /api/evaluation — per-member auto-dashboard for the Evaluation page.
//
// Surfaces best-effort proxy metrics for the AI-Native Builder evaluation
// standard (see /evaluation):
//   - PRs opened in the trailing 7 days
//   - Commits in the trailing 7 days (best-effort — falls back when our event
//     stream doesn't carry commit-level data)
//   - Median PR close time over the trailing 14 days (in hours)
//   - Most recent CC session activity
//   - Consecutive silent working days (drives the status pill)
//   - Untracked work item count (from the workboard untrackedProjects rollup)
//
// All members marked status='active' in the roster appear. Members with no
// GitHub login AND no Slack id are skipped (nothing to surface).
//
// Wrapped in memoTTL — the underlying snapshot view + 14d gh slice are still
// non-trivial; the standard doc is "daily dashboard" cadence.

import { streamEvents } from '@/lib/events';
import { getMemberSnapshots, isMemberEvent, type MemberSnapshot } from '@/services/member_view';
import { memoTTL } from '@/lib/ttl_cache';
import type { Event } from '@/types/events';

export const dynamic = 'force-dynamic';

export type EvalStatus = 'green' | 'yellow' | 'orange' | 'red';

// Builder unit per the standard doc: solo / pair (2) / pod (3). No roster
// field for this today — we default 'solo' and surface that as a metadata
// gap on the page (cta to wire up).
export type BuilderUnit = 'solo' | 'pair' | 'pod';

export interface EvalRow {
  name: string;
  prsThisWeek: number;
  commitsThisWeek: number;
  medianPrCloseHours: number | null;
  lastActivityIso: string | null;
  silentWorkdays: number;
  untrackedCount: number;
  status: EvalStatus;

  // 14-day daily CC activity (event count per day, oldest → newest).
  // Empty array = no events in window (still a valid signal: dormant).
  cc14d: number[];

  // Builder unit — default 'solo' (no roster field yet). Used by the row
  // tag, not by status derivation.
  unit: BuilderUnit;
}

interface EvalPayload {
  rows: EvalRow[];
  notes: {
    hasCommitEvents: boolean;
    // True if roster has any explicit `unit` field. False today — the page
    // uses this to surface a one-time CTA to wire up unit metadata.
    hasUnitMetadata: boolean;
  };
}

const STATUS_RANK: Record<EvalStatus, number> = {
  red: 0,
  orange: 1,
  yellow: 2,
  green: 3
};

const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// Status derivation per the standard doc gates:
//   YELLOW = 2 silent working days OR (no PR + no commit + no cc activity in
//            the last 2 working days)
//   ORANGE = 5 silent working days
//   RED    = 10 silent working days
//   GREEN  = default
function deriveStatus(args: {
  silentWorkdays: number;
  prsThisWeek: number;
  commitsThisWeek: number;
  lastActivityIso: string | null;
}): EvalStatus {
  if (args.silentWorkdays >= 10) return 'red';
  if (args.silentWorkdays >= 5) return 'orange';
  if (args.silentWorkdays >= 2) return 'yellow';
  // No CC activity AND zero PRs/commits despite some recent activity → yellow.
  if (args.prsThisWeek === 0 && args.commitsThisWeek === 0 && args.silentWorkdays >= 2) {
    return 'yellow';
  }
  return 'green';
}

interface GhBucket {
  prsThisWeek: number;
  commitsThisWeek: number;
  openedInWindow: Map<string, number>; // prRef → open ts (ms)
  closedTs: Map<string, number>;       // prRef → first close ts (ms)
}

function emptyGhBucket(): GhBucket {
  return {
    prsThisWeek: 0,
    commitsThisWeek: 0,
    openedInWindow: new Map(),
    closedTs: new Map()
  };
}

// 14d CC activity bucket — one int per UTC day, oldest → newest. We count
// any cc.* event as activity (session_started / token_usage / tool_called),
// not just session boundaries: that's a more honest "rhythm" signal because
// long sessions still surface as a tall day instead of a single tick.
const CC14D_BINS = 14;
function emptyCc14d(): number[] {
  return new Array<number>(CC14D_BINS).fill(0);
}
function dayIndexFor(tsMs: number, nowMs: number): number {
  // Bin into [0..13] where 13 is "today". Anything older returns -1.
  const dayMs = MS_PER_DAY;
  const ageDays = Math.floor((nowMs - tsMs) / dayMs);
  if (ageDays < 0 || ageDays >= CC14D_BINS) return -1;
  return CC14D_BINS - 1 - ageDays;
}

export async function GET(): Promise<Response> {
  const payload = await memoTTL<EvalPayload>('evaluation', 90_000, async () => {
    const { snapshots } = await getMemberSnapshots();

    const now = Date.now();
    const sevenDaysAgoMs = now - 7 * MS_PER_DAY;
    const fourteenDaysAgoMs = now - 14 * MS_PER_DAY;
    const fourteenDaysAgoIso = new Date(fourteenDaysAgoMs).toISOString();

    // Active members only. Skip ghosts that have no contact handle at all —
    // they would render an empty row with nothing to surface.
    const activeSnapshots = snapshots.filter((s) => {
      if (s.status !== 'active') return false;
      if (!s.githubLogin && !s.slackUserId) return false;
      return true;
    });

    // Per-member gh bucket. Single pass over the 14d gh slice: bucket each
    // event into the member whose isMemberEvent() returns true. This replaces
    // the old N*M loop over the full event log.
    const buckets = new Map<string, GhBucket>();
    const cc14dByMember = new Map<string, number[]>();
    for (const s of activeSnapshots) {
      buckets.set(s.name, emptyGhBucket());
      cc14dByMember.set(s.name, emptyCc14d());
    }

    let hasCommitEvents = false;

    await streamEvents(
      { source: 'github', since: fourteenDaysAgoIso },
      (e: Event) => {
        if (e.type === 'gh.commit_pushed' || e.type === 'gh.commit') hasCommitEvents = true;
        if (typeof e.actor !== 'string' || e.actor.length === 0) return;
        // Find the snapshot this event belongs to. activeSnapshots is small
        // (one row per active member); a linear scan via the canonical
        // matcher beats maintaining yet another stale index.
        let owner: MemberSnapshot | null = null;
        for (const s of activeSnapshots) {
          if (isMemberEvent(s, e.actor)) {
            owner = s;
            break;
          }
        }
        if (!owner) return;
        const b = buckets.get(owner.name);
        if (!b) return;
        const ms = Date.parse(e.ts);
        if (!Number.isFinite(ms)) return;
        if (e.type === 'gh.pr_opened') {
          if (ms >= sevenDaysAgoMs) b.prsThisWeek += 1;
          b.openedInWindow.set(e.subject.ref, ms);
        } else if (
          e.type === 'gh.commit_pushed' ||
          e.type === 'gh.commit' ||
          e.type === 'gh.push'
        ) {
          if (ms >= sevenDaysAgoMs) b.commitsThisWeek += 1;
        } else if (e.type === 'gh.pr_merged' || e.type === 'gh.pr_closed') {
          // Keep the EARLIEST close timestamp per PR — a PR can be reopened
          // and closed again; we measure to the first resolution.
          const prev = b.closedTs.get(e.subject.ref);
          if (prev === undefined || ms < prev) b.closedTs.set(e.subject.ref, ms);
        }
      }
    );

    // Second pass: 14d CC slice → per-day activity bins for the sparkline.
    // Separate pass because the gh slice above only filters source=github.
    // Filter on source=cc_session keeps memory bounded to that slice.
    await streamEvents(
      { source: 'cc_session', since: fourteenDaysAgoIso },
      (e: Event) => {
        if (typeof e.actor !== 'string' || e.actor.length === 0) return;
        let owner: MemberSnapshot | null = null;
        for (const s of activeSnapshots) {
          if (isMemberEvent(s, e.actor)) {
            owner = s;
            break;
          }
        }
        if (!owner) return;
        const ms = Date.parse(e.ts);
        if (!Number.isFinite(ms)) return;
        const idx = dayIndexFor(ms, now);
        if (idx < 0) return;
        const bins = cc14dByMember.get(owner.name);
        if (bins) bins[idx] += 1;
      }
    );

    const rows: EvalRow[] = [];
    for (const s of activeSnapshots) {
      const b = buckets.get(s.name) ?? emptyGhBucket();
      // Compute close-time samples by joining opened→closed on subject.ref.
      const closeSamples: number[] = [];
      for (const [ref, openedMs] of b.openedInWindow) {
        const cMs = b.closedTs.get(ref);
        if (cMs === undefined) continue;
        if (cMs <= openedMs) continue;
        closeSamples.push((cMs - openedMs) / MS_PER_HOUR);
      }
      const medianPrCloseHours = median(closeSamples);

      const lastActivityIso = s.lastCcAt;
      const silentWorkdays = s.silentWorkdays;

      const status = deriveStatus({
        silentWorkdays,
        prsThisWeek: b.prsThisWeek,
        commitsThisWeek: b.commitsThisWeek,
        lastActivityIso
      });

      rows.push({
        name: s.name,
        prsThisWeek: b.prsThisWeek,
        commitsThisWeek: b.commitsThisWeek,
        medianPrCloseHours,
        lastActivityIso,
        silentWorkdays,
        untrackedCount: s.untrackedItems,
        status,
        cc14d: cc14dByMember.get(s.name) ?? emptyCc14d(),
        // No roster.unit field today — everyone defaults to solo. The page
        // surfaces this as a metadata gap via the hasUnitMetadata note.
        unit: 'solo'
      });
    }

    rows.sort((a, b) => {
      const r = STATUS_RANK[a.status] - STATUS_RANK[b.status];
      if (r !== 0) return r;
      return b.silentWorkdays - a.silentWorkdays;
    });

    return {
      rows,
      notes: {
        hasCommitEvents,
        // Will flip to true once roster_v2 grows a `unit` field per member.
        hasUnitMetadata: false
      }
    };
  });

  return Response.json(payload);
}
