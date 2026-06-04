// Canonical per-member view. ALL consumers (UI / API / monitor) of per-member
// state MUST go through this module — do NOT recompute "last CC activity" or
// "untracked items by owner" or "is this event mine" from raw events in your
// route handler. Every time we've done that we've shipped a different filter
// and a different bug. One place, one rule.
//
// Source of truth:
//   - roster.cc.last_seen_at      → last CC activity (refreshRoster keeps it
//                                    fresh from the collector + events feed).
//   - github.config.selected_repos → which repos count as "owned" by a login.
//   - workboard view              → untracked work attribution + tracked
//                                    project membership.
//
// We deliberately do NOT scan events.jsonl from here. If roster.cc.last_seen_at
// is null and a caller really needs a backfill, that's a refreshRoster bug to
// fix at the source, not something to paper over with a one-off event scan.
// See: PART B refactor in 2026-05-27 architectural refactor brief.

import { memoTTL } from '../lib/ttl_cache';
import { readRoster, type Member } from '../lib/team_roster';
import { readConfig as readGithubConfig } from '../lib/github';
import { getWorkboardView } from './workboard';
import { workingDaysBetween } from '../lib/workdays';

export type MemberActivityFlag = 'active' | 'idle' | 'dormant';

export interface MemberSnapshot {
  name: string;
  status: 'active' | 'left';
  // Last CC activity — source-of-truth lookup order:
  //   1. roster.cc.last_seen_at  (canonical, maintained by refreshRoster)
  //   2. null (do NOT recompute by scanning all events; that's a refreshRoster
  //      concern — see member_view.ts header comment).
  lastCcAt: string | null;
  activityFlag: MemberActivityFlag;   // derived from lastCcAt (matches cc_status rule)
  silentWorkdays: number;             // derived; 0 if active today; 30 floor when lastCcAt null

  // Identity / Slack
  slackUserId: string | null;

  // GitHub
  githubLogin: string | null;
  ownedTrackedRepos: string[];        // ["owner/name", ...]
  githubCompliant: boolean;           // = m.github.ok

  // Work attribution (joined from getWorkboardView)
  untrackedItems: number;             // sum of workItems across untracked projects owned by this member
  trackedProjectKeys: string[];       // tracked project ids/names this member contributes to

  // The roster member for callers that need more fields (avoid encouraging
  // direct event scans — give them the model instead).
  member: Member;
}

export interface MemberSnapshotsView {
  snapshots: MemberSnapshot[];        // sorted by activity (newest first)
  generatedAt: string;
}

const HOUR_MS = 60 * 60 * 1000;

function activityFlagFor(lastCcAt: string | null, now: number): MemberActivityFlag {
  if (!lastCcAt) return 'dormant';
  const ageHours = (now - Date.parse(lastCcAt)) / HOUR_MS;
  if (ageHours <= 24) return 'active';
  if (ageHours <= 72) return 'idle';
  return 'dormant';
}

export async function getMemberSnapshots(opts?: {
  includeLeft?: boolean;
}): Promise<MemberSnapshotsView> {
  return memoTTL('member-snapshots', 30_000, async () => {
    const includeLeft = opts?.includeLeft ?? false;
    const [roster, ghCfg, workboard] = await Promise.all([
      readRoster(),
      readGithubConfig(),
      getWorkboardView()
    ]);

    const now = Date.now();
    const nowDate = new Date(now);
    const selectedRepos = ghCfg?.selected_repos ?? [];

    // Untracked work item count by owner name. Sum work items across all
    // untracked projects this member owns. Tracked project keys: every
    // tracked project this member contributes to.
    const untrackedByOwner = new Map<string, number>();
    for (const up of workboard.untrackedProjects ?? []) {
      if (!up.owner) continue;
      untrackedByOwner.set(
        up.owner,
        (untrackedByOwner.get(up.owner) ?? 0) + up.workItems.length
      );
    }
    // For tracked projects we don't currently emit per-member contributor
    // lists from the workboard. The view exposes a `owner` field per card;
    // surface that as a coarse signal. (When workboard grows per-card
    // contributor lists this is the join point to upgrade.)
    const trackedByOwner = new Map<string, string[]>();
    for (const p of workboard.projects ?? []) {
      if (!p.owner) continue;
      const arr = trackedByOwner.get(p.owner) ?? [];
      arr.push(p.key);
      trackedByOwner.set(p.owner, arr);
    }

    const snapshots: MemberSnapshot[] = [];
    for (const m of roster.members) {
      if (!includeLeft && m.status !== 'active') continue;
      const ghLogin = m.github.login;
      const ghLoginLc = ghLogin?.toLowerCase() ?? null;
      const ownedTrackedRepos: string[] = [];
      if (ghLoginLc) {
        for (const r of selectedRepos) {
          if (r.owner.toLowerCase() === ghLoginLc) {
            ownedTrackedRepos.push(`${r.owner}/${r.name}`);
          }
        }
      }

      const lastCcAt = m.cc?.last_seen_at ?? null;
      const activityFlag = activityFlagFor(lastCcAt, now);
      const silentWorkdays = lastCcAt
        ? await workingDaysBetween(lastCcAt, nowDate)
        : 30;

      snapshots.push({
        name: m.name,
        status: m.status === 'left' ? 'left' : 'active',
        lastCcAt,
        activityFlag,
        silentWorkdays,
        slackUserId: m.slack?.user_id ?? null,
        githubLogin: ghLogin ?? null,
        ownedTrackedRepos,
        githubCompliant: !!m.github?.ok,
        untrackedItems: untrackedByOwner.get(m.name) ?? 0,
        trackedProjectKeys: trackedByOwner.get(m.name) ?? [],
        member: m
      });
    }

    // Sort: most recently active first; nulls last.
    snapshots.sort((a, b) => {
      const ta = a.lastCcAt ? Date.parse(a.lastCcAt) : 0;
      const tb = b.lastCcAt ? Date.parse(b.lastCcAt) : 0;
      return tb - ta;
    });

    return { snapshots, generatedAt: new Date(now).toISOString() };
  });
}

/**
 * Single canonical "is this event mine?" matcher. Matches an event's `actor`
 * field against the member's canonical name, GitHub login, or the
 * `unknown:github:<login>` placeholder events carry when ingested before the
 * roster mapping caught up. Use this anywhere you would have hand-rolled the
 * three-way OR — historically every hand-roll has had a subtly different bug.
 *
 * Case-insensitive. Returns false for nullish / empty actor.
 */
export function isMemberEvent(
  snapshot: MemberSnapshot,
  actor: string | undefined | null
): boolean {
  if (!actor) return false;
  const a = actor.toLowerCase();
  if (a === snapshot.name.toLowerCase()) return true;
  const login = snapshot.githubLogin?.toLowerCase();
  if (login) {
    if (a === login) return true;
    if (a === `unknown:github:${login}`) return true;
  }
  return false;
}
