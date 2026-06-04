// Vision registry — `private/vision.json` read/write, mirroring goals.ts
// exactly (PATHS.vision + withMutex(VISION_MUTEX_KEY) + atomicWriteJSON).
//
// A VisionArea is a LEADER-CURATED strategic bet: the top tier of the
// vision → goals → projects hierarchy. The store holds ONLY curated facts —
// title, description, target, status, timestamps. It holds NO activity numbers
// and NO goal list: all rolled-up progress (commits/PRs/momentum/drift) is
// recomputed live per request in vision_progress.ts by aggregating goalsView()
// output, so the file on disk can never go stale or fabricate state.
//
// THE GOAL→AREA LINK LIVES ONLY ON THE GOAL (goals.json's optional
// vision_area_id). A VisionArea deliberately has NO linked_goal_ids field —
// storing the link on both sides would create a sync bug. visionView joins
// goal.vision_area_id → area.id at read time.
//
// Concurrent writers are serialized through withMutex(VISION_MUTEX_KEY) +
// tmp+rename atomic write (never raw fs.writeFile). All mutations go through
// updateVision() (read-modify-write under the mutex) so two writers across an
// await boundary can't lost-update each other.

import { promises as fs } from 'node:fs';
import { PATHS } from './paths';
import { withMutex } from './mutex';
import { atomicWriteJSON } from '../_lib/file-io';

export const VISION_MUTEX_KEY = 'vision:write';

export type VisionStatus = 'active' | 'archived';

export interface VisionArea {
  id: string;          // slug(title) via slugify()+uniqueSlug() from projects.ts
  title: string;       // leader-curated strategic bet, sticky after mint
  description: string;  // optional context, '' allowed
  target?: string;     // optional free-text north-star, e.g. "own the CN market by Q4". No fabricated %.
  status: VisionStatus; // archived = soft-delete (mirror goals)
  created_at: string;  // ISO (store UTC)
  updated_at: string;  // ISO, bumped on every edit
}

export interface VisionFile {
  version: 1;
  areas: VisionArea[];
}

const EMPTY: VisionFile = { version: 1, areas: [] };

export async function readVision(): Promise<VisionFile> {
  try {
    const raw = await fs.readFile(PATHS.vision, 'utf8');
    const parsed = JSON.parse(raw) as Partial<VisionFile>;
    if (parsed?.version === 1 && Array.isArray(parsed.areas)) {
      return parsed as VisionFile;
    }
    return EMPTY;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY;
    throw err;
  }
}

export async function writeVision(file: VisionFile): Promise<void> {
  await withMutex(VISION_MUTEX_KEY, async () => {
    await atomicWriteJSON(PATHS.vision, file);
  });
}

// Concurrent-safe read-modify-write. The mutator receives a fresh copy each
// time, returns the next state. Callers should not retain refs across the
// await boundary. Mutex serializes; tmp+rename guarantees the file never
// observes a half-written state from another process. Mirrors updateGoals.
export async function updateVision(
  mutate: (current: VisionFile) => Promise<VisionFile> | VisionFile
): Promise<VisionFile> {
  return withMutex(VISION_MUTEX_KEY, async () => {
    let current: VisionFile;
    try {
      const raw = await fs.readFile(PATHS.vision, 'utf8');
      const parsed = JSON.parse(raw) as Partial<VisionFile>;
      current =
        parsed?.version === 1 && Array.isArray(parsed.areas)
          ? (parsed as VisionFile)
          : { version: 1, areas: [] };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      current = { version: 1, areas: [] };
    }
    const next = await mutate(current);
    await atomicWriteJSON(PATHS.vision, next);
    return next;
  });
}

// ── Computed (NOT persisted) ───────────────────────────────────────────────
// Derived per request in vision_progress.ts, never written to vision.json. The
// store holds only leader-curated facts; rolled-up numbers are recomputed live
// (by aggregating goalsView()) so there is no stale/fabricated state on disk.

export type VisionMomentum = 'active' | 'quiet'; // OR of linked-goal momentum

// One linked active goal as it rolls up under an area (chip data for the UI).
export interface VisionLinkedGoal {
  goal_id: string;
  title: string;
  momentum: VisionMomentum;
  at_risk: boolean;
}

export interface VisionAreaProgress {
  area_id: string;
  title: string;
  description: string;
  target?: string;
  status: VisionStatus;
  linked_goals: VisionLinkedGoal[]; // ACTIVE goals linked to this area
  commits_7d: number;   // sum of linked-goal commits_7d (this-week)
  prs_7d: number;       // sum of linked-goal prs_7d (this-week)
  commits_prev_7d: number; // sum of linked-goal commits_prev_7d (last week) — for trend
  trend: 'up' | 'flat' | 'down'; // rolled-up commits_7d vs commits_prev_7d (SAME 1.5x rule as goal_progress.ts)
  momentum: VisionMomentum; // 'active' if ANY linked goal momentum==='active', else 'quiet'
  at_risk_count: number;    // count of linked goals with at_risk===true
}

// A goal with real activity that is linked to no area — execution with no strategy.
export interface VisionOrphanGoal {
  goal_id: string;
  title: string;
  momentum: VisionMomentum;
  at_risk: boolean;
  commits_7d: number;
}

export interface VisionView {
  areas: VisionAreaProgress[];
  // Two strategic-drift signals:
  areas_without_goals: VisionAreaProgress[]; // strategy with no execution (0 active linked goals)
  goals_without_area: VisionOrphanGoal[];    // execution with no strategy (active goal, no area link)
  window_days: 7;
  generated_at: string;     // ISO (passed through from goalsView)
}
