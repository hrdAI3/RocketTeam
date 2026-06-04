// PMA v2 · Path-fusion + decision gates.
//
// Combines vector_match (Path A), LLM eval (Path B), trajectory MC (Path C
// when present) into a single capability + load score, then applies decision
// gates to pick top1.
//
// Weights live here, version-tagged. Tunable; calibration job may adjust
// after enough outcome history accrues.

import type { CandidateScore, ReasonIfNull } from './types';
import type { AgentBehaviorSnapshot } from '../index/behavior';

// === Weights ===

export const FUSE_WEIGHTS = {
  // capability = w_vec * vector + w_llm * llm_cap + w_traj * traj_success
  capability: { vec: 0.25, llm: 0.45, traj: 0.30 },
  // load = w_quota * headroom + w_llm * llm_load + w_traj * (1 - quota_breach_p)
  load: { quota: 0.5, llm: 0.3, traj: 0.2 }
} as const;

export const GATES = {
  MIN_FUSED_CAPABILITY: 0.4,
  MIN_FUSED_LOAD: 0.2,
  MAX_TRAJ_QUOTA_BREACH_P: 0.6,
  ALT_THRESHOLD: 0.08, // alternatives within 8% of top1 calibrated confidence
  // Loose threshold: surface candidates with strong walkthrough/project signal
  // even if conf gap > 0.08. Lets the leader see "but X is literally building
  // this — consider them" rather than only the conf-leader.
  ALT_THRESHOLD_FOR_PROJECT_OWNER: 0.25
} as const;

export interface FuseInput {
  candidates: CandidateScore[];
  snapshots: Map<string, AgentBehaviorSnapshot>;
  applyCalibration: (raw: number) => number; // identity if no calibration data
  // Per-candidate ownership of a project matching task topic. Derived from
  // project_knowledge.json + task description in coordinator. Adds a
  // structural capability boost so ownership outranks LLM jitter.
  projectRelationship?: Map<string, 'owner' | 'contributor_active' | 'contributor_known'>;
}

// Penalty applied when a path is missing. Conservative: missing signal !=
// neutral, it should pull a candidate DOWN since we have less basis to
// recommend. Without this, vector-only candidates appeared more confident
// than those who got an explicit (low) LLM score.
const MISSING_PATH_PENALTY = 0.5;

// Structural ownership boost — 3 tiers.
// owner             — listed in project_knowledge.owners[] + has recent CC
//                     events on the project. Strongest signal.
// contributor_active — listed in contributors[] + has CC events. Real but
//                     not core.
// contributor_known — listed in contributors[] but no CC events recently.
//                     Light bump so the signal isn't ignored.
const OWNER_BOOST = 0.15;
const CONTRIBUTOR_ACTIVE_BOOST = 0.05;
const CONTRIBUTOR_KNOWN_BOOST = 0.02;

export function fuse(input: FuseInput): CandidateScore[] {
  const { candidates, snapshots, applyCalibration, projectRelationship } = input;
  for (const c of candidates) {
    const snap = snapshots.get(c.name);
    const traj = c.score_trajectory;

    // === capability ===
    let capability = FUSE_WEIGHTS.capability.vec * c.score_vector;
    if (c.score_llm) {
      capability += FUSE_WEIGHTS.capability.llm * (c.score_llm.capability_fit / 10);
    } else {
      // missing → contribute as if neutral 0.5 minus penalty
      capability += FUSE_WEIGHTS.capability.llm * 0.5 * MISSING_PATH_PENALTY;
    }
    if (traj) {
      capability += FUSE_WEIGHTS.capability.traj * traj.p_complete_on_time;
    } else {
      capability += FUSE_WEIGHTS.capability.traj * 0.5 * MISSING_PATH_PENALTY;
    }

    // === ownership boost (structural, not subject to LLM jitter) ===
    const rel = projectRelationship?.get(c.name);
    if (rel === 'owner') capability += OWNER_BOOST;
    else if (rel === 'contributor_active') capability += CONTRIBUTOR_ACTIVE_BOOST;
    else if (rel === 'contributor_known') capability += CONTRIBUTOR_KNOWN_BOOST;

    // === load ===
    const headroom = snap?.quota.headroom_ratio ?? 1;
    let load = FUSE_WEIGHTS.load.quota * headroom;
    if (c.score_llm) {
      load += FUSE_WEIGHTS.load.llm * (c.score_llm.load_fit / 10);
    } else {
      load += FUSE_WEIGHTS.load.llm * 0.5 * MISSING_PATH_PENALTY;
    }
    if (traj) {
      load += FUSE_WEIGHTS.load.traj * (1 - traj.quota_breach_p);
    } else {
      load += FUSE_WEIGHTS.load.traj * 0.5 * MISSING_PATH_PENALTY;
    }

    c.fused_capability = clamp01(capability);
    c.fused_load = clamp01(load);
    c.raw_confidence = Math.sqrt(c.fused_capability * c.fused_load);
    c.calibrated_confidence = applyCalibration(c.raw_confidence);
  }
  return candidates.sort((a, b) => b.calibrated_confidence - a.calibrated_confidence);
}

export interface GateResult {
  top1: string | null;
  alternatives: string[];
  reason_if_null?: ReasonIfNull;
}

export function applyGates(
  ranked: CandidateScore[]
): GateResult {
  if (ranked.length === 0) {
    return { top1: null, alternatives: [], reason_if_null: 'no_agents' };
  }
  const top = ranked[0];

  if (top.fused_capability < GATES.MIN_FUSED_CAPABILITY) {
    return { top1: null, alternatives: [], reason_if_null: 'no_suitable' };
  }
  if (top.fused_load < GATES.MIN_FUSED_LOAD) {
    return { top1: null, alternatives: [], reason_if_null: 'all_burnt' };
  }
  if (top.score_trajectory && top.score_trajectory.quota_breach_p > GATES.MAX_TRAJ_QUOTA_BREACH_P) {
    // Swap with next eligible if available.
    const alt = ranked.find(
      (c) =>
        c !== top &&
        c.fused_capability >= GATES.MIN_FUSED_CAPABILITY &&
        c.fused_load >= GATES.MIN_FUSED_LOAD &&
        (!c.score_trajectory || c.score_trajectory.quota_breach_p <= GATES.MAX_TRAJ_QUOTA_BREACH_P)
    );
    if (!alt) return { top1: null, alternatives: [], reason_if_null: 'quota_blocked' };
    return {
      top1: alt.name,
      alternatives: ranked
        .filter((c) => c !== alt && c.calibrated_confidence >= alt.calibrated_confidence - GATES.ALT_THRESHOLD)
        .map((c) => c.name)
    };
  }

  // Tight alt set: within ALT_THRESHOLD of top1 confidence.
  const tightAlts = ranked
    .slice(1)
    .filter((c) => top.calibrated_confidence - c.calibrated_confidence <= GATES.ALT_THRESHOLD)
    .map((c) => c.name);

  // Loose extension: candidates who got a walkthrough (i.e. they ran the
  // first-person plan) AND are within a wider band — these are the
  // "implementation candidates" leader should see even when conf is below
  // the strict bar.
  const looseAlts = ranked
    .slice(1)
    .filter(
      (c) =>
        c.walkthrough != null &&
        !tightAlts.includes(c.name) &&
        top.calibrated_confidence - c.calibrated_confidence <= GATES.ALT_THRESHOLD_FOR_PROJECT_OWNER
    )
    .map((c) => c.name);

  return { top1: top.name, alternatives: [...tightAlts, ...looseAlts] };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
