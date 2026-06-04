// PMA v2 · Path C — Monte Carlo trajectory simulation.
//
// Per candidate runs N forward trajectories; each trajectory simulates day-by-day
// outcomes given the agent's behavior snapshot and the task fingerprint.
// Pure math, zero LLM cost.
//
// Outputs aggregated distribution:
//   - p_complete_on_time, duration p50/p90
//   - predicted_stuck_topics (topic → probability across runs)
//   - expected_collab partners
//   - expected_rework count
//   - quota_breach_p (cost > remaining quota)
//
// Seedable PRNG so calibration replays are deterministic.

import type { AgentBehaviorSnapshot } from '../index/behavior';
import type { TaskFingerprint } from './fingerprint';
import type { CandidateScore } from './types';

export interface TrajectorySimOptions {
  n_runs?: number;       // default 20
  seed?: number;         // default Date.now()
  daily_collab_p?: number; // default 0.3
}

interface RunOutcome {
  duration_days: number;
  completed: boolean;
  stucks: Map<string, number>;  // topic → count
  collabs: Map<string, number>;  // partner → count
  rework_count: number;
  estimated_token_cost: number;
}

export type TrajectoryAgg = NonNullable<CandidateScore['score_trajectory']>;

export function simulateTrajectory(
  snap: AgentBehaviorSnapshot,
  fp: TaskFingerprint,
  opts: TrajectorySimOptions = {}
): TrajectoryAgg {
  const n_runs = opts.n_runs ?? 20;
  const daily_collab_p = opts.daily_collab_p ?? 0.3;
  const rng = mulberry32(opts.seed ?? Date.now());

  const runs: RunOutcome[] = [];
  for (let i = 0; i < n_runs; i++) {
    runs.push(simulateOneRun(snap, fp, rng, daily_collab_p));
  }
  return aggregate(runs, fp);
}

function simulateOneRun(
  snap: AgentBehaviorSnapshot,
  fp: TaskFingerprint,
  rng: () => number,
  daily_collab_p: number
): RunOutcome {
  // Duration bias from historical p50 (if data exists). When no history,
  // jitter ±30% around the task estimate.
  const histP50 = snap.task_outcomes.duration_p50_days;
  const baseDuration = histP50 > 0 ? histP50 : fp.est_effort_days;
  const jitter = 0.7 + rng() * 0.6; // 0.7..1.3
  const plannedDuration = Math.max(0.25, baseDuration * jitter);

  // Energy effect — burnt/low slow down completion probability and add days.
  // unknown is treated as normal (we won't simulate unknown candidates).
  const energyMul: Record<string, number> = {
    high: 0.85,
    normal: 1.0,
    low: 1.3,
    burnt: 1.8,
    unknown: 1.1
  };
  const energyDuration = plannedDuration * (energyMul[snap.energy_inferred] ?? 1.0);

  // Stuck probability per risk topic per day, derived from agent's history.
  // total stuck signals in window determine "stuck propensity"; per-topic
  // share gates which topic likely fires.
  const totalStuck = snap.stuck_topics.reduce((a, t) => a + t.count, 0);
  const topicShare = new Map<string, number>();
  for (const t of snap.stuck_topics) topicShare.set(t.topic, t.count);
  // Per-day stuck base rate: scale total stucks by active days, then
  // multiply by share of matched topics among risk_topics.
  const stuckPerDay = snap.active_days_in_window > 0
    ? totalStuck / snap.active_days_in_window
    : 0;

  const stucks = new Map<string, number>();
  const collabs = new Map<string, number>();
  let rework_count = 0;

  // Daily roll.
  const days = Math.ceil(energyDuration);
  for (let d = 0; d < days; d++) {
    // Stuck rolls: each risk topic checked
    for (const topic of fp.risk_topics) {
      const share = topicShare.get(topic) ?? 0;
      if (share === 0) continue;
      const p_stuck = Math.min(0.6, (share / Math.max(1, totalStuck)) * (stuckPerDay / 2));
      if (rng() < p_stuck) {
        stucks.set(topic, (stucks.get(topic) ?? 0) + 1);
      }
    }
    // Collab roll — pick one well-paired partner (weighted by edge weight sum)
    if (snap.collab_pairs.length > 0 && rng() < daily_collab_p) {
      const partner = weightedPickPartner(snap.collab_pairs, rng);
      if (partner) collabs.set(partner, (collabs.get(partner) ?? 0) + 1);
    }
  }

  // Rework: bernoulli per run using historical rework_rate, +epsilon when
  // quality_bar is external/internal vs demo.
  const reworkBase = snap.task_outcomes.rework_rate || 0.15;
  const reworkMul =
    fp.quality_bar === 'external' ? 1.5 : fp.quality_bar === 'internal' ? 1.0 : 0.6;
  if (rng() < reworkBase * reworkMul) rework_count += 1;

  // Completed-on-time = simulated duration ≤ planned task budget × 1.2 grace.
  const onTimeBudget = fp.est_effort_days * 1.2;
  const completed = energyDuration <= onTimeBudget && stuckCountTotal(stucks) < 4;

  // Token cost estimate — fp.est_tokens + 30% per stuck event, ±20% noise.
  const stuckTotal = stuckCountTotal(stucks);
  const noise = 0.8 + rng() * 0.4;
  const estimated_token_cost = fp.est_tokens * noise * (1 + 0.3 * stuckTotal);

  return {
    duration_days: energyDuration,
    completed,
    stucks,
    collabs,
    rework_count,
    estimated_token_cost
  };
}

function aggregate(runs: RunOutcome[], fp: TaskFingerprint): TrajectoryAgg {
  const durations = runs.map((r) => r.duration_days).sort((a, b) => a - b);
  const p50 = percentile(durations, 0.5);
  const p90 = percentile(durations, 0.9);
  const p_complete_on_time = runs.filter((r) => r.completed).length / runs.length;

  // Aggregate stuck topics: count runs in which topic fired, normalize by N.
  const stuckP: Record<string, number> = {};
  for (const r of runs) {
    for (const topic of r.stucks.keys()) {
      stuckP[topic] = (stuckP[topic] ?? 0) + 1;
    }
  }
  const predicted_stuck_topics = Object.entries(stuckP)
    .map(([topic, n]) => ({ topic, p: n / runs.length }))
    .sort((a, b) => b.p - a.p)
    .slice(0, 6);

  // Collab partners similarly.
  const collabP: Record<string, number> = {};
  for (const r of runs) {
    for (const partner of r.collabs.keys()) {
      collabP[partner] = (collabP[partner] ?? 0) + 1;
    }
  }
  const expected_collab = Object.entries(collabP)
    .map(([w, n]) => ({ with: w, p: n / runs.length }))
    .sort((a, b) => b.p - a.p)
    .slice(0, 4);

  const expected_rework = runs.reduce((a, r) => a + r.rework_count, 0) / runs.length;

  // Quota breach: assume rough budget = fp.est_tokens × 2 grace; flag if
  // any run estimated_token_cost > 2× est. Adjust once we have quota model
  // wired to agent quota.headroom_ratio.
  const quotaBudget = fp.est_tokens * 2;
  const quota_breach_p = runs.filter((r) => r.estimated_token_cost > quotaBudget).length / runs.length;

  return {
    n_runs: runs.length,
    p_complete_on_time,
    duration_p50_d: p50,
    duration_p90_d: p90,
    predicted_stuck_topics,
    expected_collab,
    expected_rework,
    quota_breach_p
  };
}

// === Helpers ===

function weightedPickPartner(
  pairs: AgentBehaviorSnapshot['collab_pairs'],
  rng: () => number
): string | null {
  let total = 0;
  for (const p of pairs) total += p.n * (p.success_rate || 0.5);
  if (total <= 0) return null;
  let r = rng() * total;
  for (const p of pairs) {
    const w = p.n * (p.success_rate || 0.5);
    if (r < w) return p.with;
    r -= w;
  }
  return pairs[0]?.with ?? null;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
}

function stuckCountTotal(m: Map<string, number>): number {
  let n = 0;
  for (const v of m.values()) n += v;
  return n;
}

// Mulberry32 deterministic PRNG. Replaces Math.random for replay-safety.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
