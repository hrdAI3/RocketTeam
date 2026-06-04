// Goal registry — `private/goals.json` read/write, mirroring projects.ts
// exactly (PATHS.goals + withMutex(GOALS_MUTEX_KEY) + atomicWriteJSON).
//
// A Goal is a LEADER-CURATED objective: a title the leader minted, plus the
// project ids that serve it. The store holds ONLY curated facts — title,
// description, linked_project_ids, status, target, timestamps. It holds NO
// activity numbers: all progress (commits/PRs/live-runs/momentum/drift) is
// recomputed live per request in goal_progress.ts against the current events +
// project registry, so the file on disk can never go stale or fabricate state.
//
// Concurrent writers — the leader API (create/edit/link/archive) and any
// future monitor write — are serialized through withMutex(GOALS_MUTEX_KEY) +
// tmp+rename atomic write (never raw fs.writeFile). All mutations go through
// updateGoals() (read-modify-write under the mutex) so two writers across an
// await boundary can't lost-update each other.
//
// linked_project_ids store RAW project ids. Resolution to names/active-status
// happens at read time against readProjects(), so an archived or renamed
// project never corrupts a stored goal.

import { promises as fs } from 'node:fs';
import { PATHS } from './paths';
import { withMutex } from './mutex';
import { atomicWriteJSON } from '../_lib/file-io';

export const GOALS_MUTEX_KEY = 'goals:write';

export type GoalStatus = 'active' | 'archived';

export interface Goal {
  id: string;                   // slug(title) via slugify()+uniqueSlug() from projects.ts
  title: string;                // leader-curated objective, sticky after mint
  description: string;          // optional context, '' allowed
  linked_project_ids: string[]; // >=1 ProjectEntity.id (validated against readProjects on write)
  status: GoalStatus;           // archived = soft-delete (mirror projects)
  created_at: string;           // ISO (store UTC)
  updated_at: string;           // ISO, bumped on every edit
  target?: string;              // optional free-text milestone, e.g. "ship v2 by Jun 30". No fabricated %.
  vision_area_id?: string;      // optional area linkage; absent on legacy rows. Single source of the goal→area link (the vision route writes it via updateGoals).
}

export interface GoalsFile {
  version: 1;
  goals: Goal[];
}

const EMPTY: GoalsFile = { version: 1, goals: [] };

export async function readGoals(): Promise<GoalsFile> {
  try {
    const raw = await fs.readFile(PATHS.goals, 'utf8');
    const parsed = JSON.parse(raw) as Partial<GoalsFile>;
    if (parsed?.version === 1 && Array.isArray(parsed.goals)) {
      return parsed as GoalsFile;
    }
    return EMPTY;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY;
    throw err;
  }
}

export async function writeGoals(file: GoalsFile): Promise<void> {
  await withMutex(GOALS_MUTEX_KEY, async () => {
    await atomicWriteJSON(PATHS.goals, file);
  });
}

// Concurrent-safe read-modify-write. The mutator receives a fresh copy each
// time, returns the next state. Callers should not retain refs across the
// await boundary. Mutex serializes; tmp+rename guarantees the file never
// observes a half-written state from another process. Mirrors updateProjects.
export async function updateGoals(
  mutate: (current: GoalsFile) => Promise<GoalsFile> | GoalsFile
): Promise<GoalsFile> {
  return withMutex(GOALS_MUTEX_KEY, async () => {
    let current: GoalsFile;
    try {
      const raw = await fs.readFile(PATHS.goals, 'utf8');
      const parsed = JSON.parse(raw) as Partial<GoalsFile>;
      current =
        parsed?.version === 1 && Array.isArray(parsed.goals)
          ? (parsed as GoalsFile)
          : { version: 1, goals: [] };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      current = { version: 1, goals: [] };
    }
    const next = await mutate(current);
    await atomicWriteJSON(PATHS.goals, next);
    return next;
  });
}

// ── Computed (NOT persisted) ───────────────────────────────────────────────
// Derived per request in goal_progress.ts, never written to goals.json. The
// store holds only leader-curated facts; activity numbers are recomputed live
// so there is no stale/fabricated state on disk.

export type Momentum = 'active' | 'quiet'; // grounded signal, NOT a percentage

export interface GoalProgress {
  goal_id: string;
  title: string;
  description: string;
  status: GoalStatus;
  linked_projects: Array<{ id: string; name: string; active: boolean }>; // resolved; active=status==='active'
  commits_7d: number;   // deduped-by-sha commits on linked active projects, 7d Beijing window
  prs_7d: number;       // deduped pr_opened+review_submitted on linked projects
  live_runs: number;    // AgentRun.status==='live' attributed to a linked project
  last_activity_at: string | null; // ISO of most-recent linked commit/pr/run
  momentum: Momentum;   // 'active' if commits_7d>0 || live_runs>0, else 'quiet'
  // ── goal-intelligence v1 (grounded ONLY in confirmed data) ──────────────
  commits_prev_7d: number; // deduped commits on linked active projects, PREVIOUS 7d (last week)
  trend: 'up' | 'flat' | 'down'; // this-week vs last-week commit comparison (1.5x threshold)
  at_risk: boolean;     // true iff a linked active project is blocked OR went quiet this week
  at_risk_reason: string | null; // exact grounded reason (blocked / went-quiet), null when not at risk
}

export interface DriftItem {
  project_id: string;
  name: string;
  commits_7d: number;       // deduped, >0 by definition of drift
  last_commit_at: string | null;
}

export interface GoalsView {
  goals: GoalProgress[];
  drift: DriftItem[];
  window_days: 7;
  generated_at: string;     // ISO
}
