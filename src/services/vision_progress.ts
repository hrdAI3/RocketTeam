// Vision alignment service — rolls per-goal progress up into vision areas and
// surfaces the two strategic-drift signals, all numbers recomputed LIVE.
//
// MEMORY-BOUNDED — HARD CONSTRAINT: visionView aggregates goalsView() output. It
// calls goalsView() EXACTLY ONCE (which already pays the single windowed
// streamEvents pass) plus two cheap file reads (readVision/readGoals). It MUST
// NEVER import streamEvents / readAllEvents / buildAgentRuns / buildRepoAliasIndex
// — re-scanning events here would re-pay the ~850MB→~4GB RSS cost goalsView
// exists to avoid.
//
// The goal→area link lives ONLY on the Goal (goals.json's optional
// vision_area_id). goalsView()'s GoalProgress does NOT carry that field, so we
// readGoals() here purely to build the goal_id → vision_area_id join, then
// aggregate the matching GoalProgress rows from goalsView().goals.

import { goalsView } from './goal_progress';
import { readGoals, type Goal } from '../lib/goals';
import { readVision } from '../lib/vision';
import type { GoalProgress } from '../lib/goals';
import type {
  VisionView,
  VisionAreaProgress,
  VisionLinkedGoal,
  VisionOrphanGoal,
  VisionMomentum
} from '../lib/vision';

const WINDOW_DAYS = 7 as const;

// Treat undefined / '' / whitespace-only as "no area" consistently so the
// 'execution with no strategy' drift signal never misses a blank link.
function linkedAreaId(g: Goal | undefined): string {
  const v = g?.vision_area_id;
  return typeof v === 'string' ? v.trim() : '';
}

export async function visionView(): Promise<VisionView> {
  // ONE goalsView() (single windowed event pass) + two cheap file reads.
  const [view, visionFile, goalsFile] = await Promise.all([
    goalsView(),
    readVision(),
    readGoals()
  ]);

  // goal_id → raw Goal, for the vision_area_id join (GoalProgress lacks it).
  const goalById = new Map<string, Goal>();
  for (const g of goalsFile.goals) goalById.set(g.id, g);

  // Roll a set of GoalProgress rows up into one area aggregate. Trend re-derived
  // from summed commits vs summed prev using the SAME 1.5x threshold as
  // goal_progress.ts — do NOT invent a new formula. Momentum = OR of linked.
  function rollUp(
    area: { id: string; title: string; description: string; target?: string; status: 'active' | 'archived' },
    rows: GoalProgress[]
  ): VisionAreaProgress {
    let commits = 0;
    let prevCommits = 0;
    let prs = 0;
    let atRisk = 0;
    let anyActive = false;
    const linked_goals: VisionLinkedGoal[] = [];
    for (const g of rows) {
      commits += g.commits_7d;
      prevCommits += g.commits_prev_7d;
      prs += g.prs_7d;
      if (g.at_risk) atRisk += 1;
      if (g.momentum === 'active') anyActive = true;
      linked_goals.push({
        goal_id: g.goal_id,
        title: g.title,
        momentum: g.momentum as VisionMomentum,
        at_risk: g.at_risk
      });
    }
    let trend: 'up' | 'flat' | 'down';
    if (commits + prevCommits < 1) trend = 'flat';
    else if (commits > prevCommits * 1.5) trend = 'up';
    else if (commits * 1.5 < prevCommits) trend = 'down';
    else trend = 'flat';
    const momentum: VisionMomentum = anyActive ? 'active' : 'quiet';
    return {
      area_id: area.id,
      title: area.title,
      description: area.description,
      ...(typeof area.target === 'string' && area.target ? { target: area.target } : {}),
      status: area.status,
      linked_goals,
      commits_7d: commits,
      prs_7d: prs,
      commits_prev_7d: prevCommits,
      trend,
      momentum,
      at_risk_count: atRisk
    };
  }

  // ── Per-area rollup (ACTIVE areas only) ──────────────────────────────────
  // goalsView().goals already excludes archived goals, so linked rows are all
  // active by construction → an area linked only to archived goals correctly
  // rolls up to zero linked goals (and is flagged as 'no execution').
  const areas: VisionAreaProgress[] = [];
  const areas_without_goals: VisionAreaProgress[] = [];
  for (const area of visionFile.areas) {
    if (area.status !== 'active') continue;
    const rows = view.goals.filter((g) => linkedAreaId(goalById.get(g.goal_id)) === area.id);
    const agg = rollUp(area, rows);
    areas.push(agg);
    // Signal (a) — strategy with no execution: active area, 0 active linked goals.
    if (rows.length === 0) areas_without_goals.push(agg);
  }

  // ── Signal (b) — execution with no strategy: active goal, no area link ────
  const goals_without_area: VisionOrphanGoal[] = view.goals
    .filter((g) => !linkedAreaId(goalById.get(g.goal_id)))
    .map((g) => ({
      goal_id: g.goal_id,
      title: g.title,
      momentum: g.momentum as VisionMomentum,
      at_risk: g.at_risk,
      commits_7d: g.commits_7d
    }));

  return {
    areas,
    areas_without_goals,
    goals_without_area,
    window_days: WINDOW_DAYS,
    generated_at: view.generated_at
  };
}
