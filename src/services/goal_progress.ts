// Goal alignment service — computes per-goal progress, trend, at-risk + team-wide
// drift in a single deterministic pass, all numbers recomputed LIVE (never
// persisted).
//
// MEMORY-BOUNDED: ONE windowed streamEvents pass over a 14-Beijing-day window.
// NEVER readAllEvents (it loads ~850MB into RSS ≈4GB) and NEVER buildAgentRuns
// (a second full load) — the earlier version paired both and never completed.
// streamEvents retains only the in-window gh.* events; RSS stays ~400MB.
//
// Reuses the AUDITED helpers verbatim — no new counting logic:
//   - streamEvents (src/lib/events) — since/until-bounded raw event stream
//   - buildRepoAliasIndex (src/services/attribute_run.ts) — 'owner/name' →
//     project_id, ACTIVE projects only, lowercased keys
//   - getWorkboardView (src/services/workboard) — cached; supplies the 'blocked'
//     status used as an at-risk reason
//   - beijingDate / beijingDayBounds (src/services/daily_brief) — the SAME
//     Beijing-day window the brief uses
//   - sha-dedup + pr-key-dedup — copied verbatim from daily_brief (raw events
//     hold ~20x duplicate gh.commit_pushed; counting raw events lies)
//
// The 14d window splits at midMs (== the 7d window start, provably equal) into
// this-week / last-week buckets. this-week drives commits_7d / drift / momentum
// (semantics byte-identical to the prior 7d-only version); the bucket pair drives
// trend (this vs last, 1.5x threshold) + went-quiet at-risk. Now-anchored by
// design — progress/drift are conservative FLOORS of recent activity.

import { streamEvents } from '../lib/events';
import { buildRepoAliasIndex } from './attribute_run';
import { readGoals } from '../lib/goals';
import { readProjects } from '../lib/projects';
import { beijingDate, beijingDayBounds } from './daily_brief';
import { getWorkboardView } from './workboard';
import type { Event } from '../types/events';
import type { GoalsView, GoalProgress, DriftItem, Momentum } from '../lib/goals';
import type { ProjectEntity } from '../lib/projects';

const WINDOW_DAYS = 7 as const;

// Compute the now-anchored 7-Beijing-day window in UTC ms.
// [ start of (today-6d) , end of today ) — exactly 7 calendar days inclusive
// of today, matching daily_brief's day-bounds math (no re-derived offset).
function sevenDayWindow(now = new Date()): { startMs: number; endMs: number } {
  const todayYmd = beijingDate(now);
  const endMs = beijingDayBounds(todayYmd).endMs;
  // 6 Beijing days before today: step back 6 day-lengths from today's start
  // and re-resolve the calendar date (DST-free for Asia/Shanghai, but we go
  // through beijingDate so the date label is always correct).
  const sixDaysAgo = new Date(beijingDayBounds(todayYmd).startMs - 6 * 24 * 60 * 60 * 1000 + 1000);
  const startMs = beijingDayBounds(beijingDate(sixDaysAgo)).startMs;
  return { startMs, endMs };
}

// 14-Beijing-day window for the trend lens. midMs is the this-week boundary and
// is provably EQUAL to sevenDayWindow().startMs (same expression: start of
// today-6d), so this-week counts stay byte-identical to commits_7d — no
// double-count, no drift. startMs steps back to start of (today-13d).
// [ startMs (last-week start) , midMs (this-week start) , endMs (end of today) )
function fourteenDayWindow(now = new Date()): { startMs: number; midMs: number; endMs: number } {
  const todayYmd = beijingDate(now);
  const endMs = beijingDayBounds(todayYmd).endMs;
  const todayStart = beijingDayBounds(todayYmd).startMs;
  // start of (today-6d) == sevenDayWindow().startMs EXACTLY
  const midMs = beijingDayBounds(beijingDate(new Date(todayStart - 6 * 864e5 + 1000))).startMs;
  // start of (today-13d)
  const startMs = beijingDayBounds(beijingDate(new Date(todayStart - 13 * 864e5 + 1000))).startMs;
  return { startMs, midMs, endMs };
}

export async function goalsView(): Promise<GoalsView> {
  const now = new Date();
  // 14d read (this-week + last-week) — ONE windowed pass, never a second load.
  // midMs == sevenDayWindow().startMs, so this-week stays identical to 7d math.
  const { startMs, midMs, endMs } = fourteenDayWindow(now);
  const inWindow = (e: Event): boolean => {
    const t = Date.parse(e.ts);
    return Number.isFinite(t) && t >= startMs && t < endMs;
  };

  // Memory-bounded windowed read. The original used readAllEvents() which loads
  // the full ~850MB events.jsonl into an Event[] (≈4GB RSS) — and pairing it
  // with buildAgentRuns (a SECOND full load) blew memory and never completed.
  // streamEvents only retains the gh.* events inside the 7d window, so RSS stays
  // small. The `until` lets it bail early (file is roughly chronological).
  // SHA-DEDUP IS MANDATORY (raw events hold ~20x duplicate gh.commit_pushed):
  // key by sha, fall back to ref@ts. PRs dedup by type+ref+actor.
  const commitBySha = new Map<string, Event>();
  const prByKey = new Map<string, Event>();
  // Workboard is cached/cheap — one read for the 'blocked' at-risk reason.
  // Degrade to no-blocked on failure (never throws the whole view).
  const [repoIndex, goalsFile, projectsFile, , workboard] = await Promise.all([
    buildRepoAliasIndex(),
    readGoals(),
    readProjects(),
    streamEvents(
      {
        since: new Date(startMs).toISOString(), // 14d back (this-week + last-week)
        until: new Date(endMs).toISOString(),
        type: ['gh.commit_pushed', 'gh.pr_opened', 'gh.review_submitted']
      },
      (e) => {
        if (!inWindow(e)) return;
        if (e.type === 'gh.commit_pushed') {
          const sha = (e.evidence?.fields as { sha?: string } | undefined)?.sha;
          const key = sha || `${e.subject?.ref}@${e.ts}`;
          if (!commitBySha.has(key)) commitBySha.set(key, e);
        } else {
          const key = `${e.type}:${e.subject?.ref}:${e.actor}`;
          if (!prByKey.has(key)) prByKey.set(key, e);
        }
      }
    ).catch(() => {}),
    getWorkboardView().catch(() => null)
  ]);

  // ── Blocked key set from the workboard (VERIFIED fact: a registry project
  // produces a ProjectCard whose card.key === project.id, workboard.ts:260-261).
  // Add both the key (== project id) and the lowercased trimmed name so the
  // REPO_ALIASES case (e.g. matrix-* clustering into card.key 'matrix', not the
  // raw id) is still matched via the project's display name fallback below.
  const blocked = new Set<string>();
  for (const c of workboard?.projects ?? []) {
    if (c.status === 'blocked') {
      blocked.add(c.key);
      blocked.add(c.name.trim().toLowerCase());
    }
  }

  // Map each UNIQUE commit / PR to a project via repoIndex (active projects
  // only, lowercased keys). PR refs are 'owner/repo#number' → strip '#…'.
  //
  // The 14d read is split by ts vs midMs. commitsByProject holds ONLY this-week
  // commits (ts>=midMs) so commits_7d / drift / momentum / last_activity stay
  // byte-identical to today's 7d semantics. The bucketed COUNT maps (thisWk /
  // lastWk) drive trend + went-quiet only.
  const commitsByProject = new Map<string, Event[]>(); // this-week events (unchanged semantics)
  const thisWk = new Map<string, number>(); // per-project this-week deduped commit count
  const lastWk = new Map<string, number>(); // per-project last-week deduped commit count
  for (const e of commitBySha.values()) {
    const ref = String(e.subject?.ref ?? '').toLowerCase();
    const pid = repoIndex.get(ref);
    if (!pid) continue;
    const t = Date.parse(e.ts);
    if (t >= midMs) {
      (commitsByProject.get(pid) ?? commitsByProject.set(pid, []).get(pid)!).push(e);
      thisWk.set(pid, (thisWk.get(pid) ?? 0) + 1);
    } else {
      lastWk.set(pid, (lastWk.get(pid) ?? 0) + 1);
    }
  }
  // PRs: keep prs_7d windowed to THIS week only (ts>=midMs) so prs_7d semantics
  // are unchanged from today.
  const prsByProject = new Map<string, Event[]>();
  for (const e of prByKey.values()) {
    if (Date.parse(e.ts) < midMs) continue;
    const ref = String(e.subject?.ref ?? '').toLowerCase().split('#')[0];
    const pid = repoIndex.get(ref);
    if (!pid) continue;
    (prsByProject.get(pid) ?? prsByProject.set(pid, []).get(pid)!).push(e);
  }
  // live_runs is dropped from v1: it required buildAgentRuns (a full 850MB
  // events load) which is the perf killer above. Momentum is driven by commits
  // alone (commits>0 ⇒ active), which is the grounded signal anyway. Re-add
  // live counts later via a cheap windowed cc.session_started−ended pass.

  // Project lookup by id (for name + status resolution at read time).
  const projById = new Map<string, ProjectEntity>();
  for (const p of projectsFile.projects) projById.set(p.id, p);
  const maxTs = (evts: Event[] | undefined): number => {
    let m = 0;
    for (const e of evts ?? []) {
      const t = Date.parse(e.ts);
      if (Number.isFinite(t) && t > m) m = t;
    }
    return m;
  };

  // ── Per-goal progress ────────────────────────────────────────────────────
  // Archived goals are hidden by default (only active goals shown). The set of
  // project ids that any ACTIVE goal covers — used by drift below.
  const goaledProjectIds = new Set<string>();
  const goals: GoalProgress[] = [];
  for (const g of goalsFile.goals) {
    if (g.status !== 'active') continue;
    const linked_projects: Array<{ id: string; name: string; active: boolean }> = [];
    const activePids: string[] = []; // active linked project ids (for at-risk passes)
    let commits = 0;
    let prevCommits = 0;
    let prs = 0;
    const live = 0; // v1: see note above (live_runs dropped to keep reads bounded)
    let lastMs = 0;
    for (const pid of g.linked_project_ids) {
      const p = projById.get(pid);
      const active = p?.status === 'active';
      linked_projects.push({ id: pid, name: p?.name ?? pid, active });
      // Risk #4 guard: ONLY active linked projects contribute counts. An
      // archived link can't ghost-count, and only active links confer goal
      // coverage for the drift inverse.
      if (!active) continue;
      activePids.push(pid);
      goaledProjectIds.add(pid);
      const cEvts = commitsByProject.get(pid);
      const pEvts = prsByProject.get(pid);
      commits += cEvts?.length ?? 0;
      prevCommits += lastWk.get(pid) ?? 0; // last-week count over the SAME active pids
      prs += pEvts?.length ?? 0;
      lastMs = Math.max(lastMs, maxTs(cEvts), maxTs(pEvts));
    }
    const momentum: Momentum = commits > 0 || live > 0 ? 'active' : 'quiet';

    // ── Trend (this-week vs last-week commits, 1.5x threshold) ──────────────
    let trend: 'up' | 'flat' | 'down';
    if (commits + prevCommits < 1) trend = 'flat';        // no commits either week → not meaningful
    else if (commits > prevCommits * 1.5) trend = 'up';   // >50% growth (prev 0 & cur>0 ⇒ up)
    else if (commits * 1.5 < prevCommits) trend = 'down'; // >50% decline (cur 0 & prev>0 ⇒ down)
    else trend = 'flat';

    // ── At-risk (grounded ONLY in confirmed data; blocked > went-quiet) ─────
    // Loop body only runs over ACTIVE linked pids, so a goal with no active
    // links → at_risk=false (never fabricated). went-quiet requires lastWeek>0.
    let at_risk = false;
    let at_risk_reason: string | null = null;
    const blockedFor = (pid: string): boolean =>
      blocked.has(pid) || blocked.has((projById.get(pid)?.name ?? '').trim().toLowerCase());
    // pass 1 — blocked (priority, louder, reported first)
    for (const pid of activePids) {
      if (blockedFor(pid)) {
        at_risk = true;
        at_risk_reason = `项目「${projById.get(pid)?.name ?? pid}」blocked`;
        break;
      }
    }
    // pass 2 — went-quiet (only if not already blocked): committing last week,
    // silent this week — a real stall (dormant-both-weeks is never flagged).
    if (!at_risk) {
      for (const pid of activePids) {
        const cur = thisWk.get(pid) ?? 0;
        const prev = lastWk.get(pid) ?? 0;
        if (cur === 0 && prev > 0) {
          at_risk = true;
          at_risk_reason = `项目「${projById.get(pid)?.name ?? pid}」上周 ${prev} commit 本周归零`;
          break;
        }
      }
    }

    goals.push({
      goal_id: g.id,
      title: g.title,
      description: g.description,
      status: g.status,
      linked_projects,
      commits_7d: commits,
      prs_7d: prs,
      live_runs: live,
      last_activity_at: lastMs > 0 ? new Date(lastMs).toISOString() : null,
      momentum,
      commits_prev_7d: prevCommits,
      trend,
      at_risk,
      at_risk_reason
    });
  }

  // ── Drift — active projects with real recent commits serving NO goal ──────
  // Inverse of the same commitsByProject map (zero extra data loads). Keys on
  // COMMITS only (deterministically attributed); live runs under disableLLM
  // may be unattributed so they'd make drift noisy — drift is a conservative
  // FLOOR (risk #5). Archived / non-existent projects are excluded so a stale
  // link can't ghost-count and an archived repo can't show as drift (risk #4).
  const drift: DriftItem[] = [];
  for (const [pid, cEvts] of commitsByProject) {
    if (cEvts.length < 1) continue; // threshold: any deduped commit in window
    if (goaledProjectIds.has(pid)) continue; // already serves an active goal
    const p = projById.get(pid);
    if (!p || p.status !== 'active') continue;
    const lastMs = maxTs(cEvts);
    drift.push({
      project_id: pid,
      name: p.name,
      commits_7d: cEvts.length,
      last_commit_at: lastMs > 0 ? new Date(lastMs).toISOString() : null
    });
  }
  drift.sort((a, b) => b.commits_7d - a.commits_7d);

  return {
    goals,
    drift,
    window_days: WINDOW_DAYS,
    generated_at: now.toISOString()
  };
}
