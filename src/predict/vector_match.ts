// PMA v2 · Path A — Vector match.
//
// Zero-LLM scoring of agent ↔ task fit based on:
//   1. Tool usage overlap (cosine of agent tool_vector vs task tools_needed)
//   2. Stuck topic overlap penalty (history of stuck on risk_topics)
//
// Cheap (microseconds). Used to short-list top-K candidates before the
// expensive LLM and Monte Carlo paths run.

import type { AgentBehaviorSnapshot } from '../index/behavior';
import { CANONICAL_TOOLS } from '../index/behavior';
import type { TaskFingerprint } from './fingerprint';

export interface VectorMatchResult {
  agent_name: string;
  tool_match: number;     // cosine 0..1
  stuck_penalty: number;  // 0..1, higher = more historical stuck on risk topics
  score: number;          // tool_match × (1 - stuck_penalty)
}

export function vectorMatch(
  fp: TaskFingerprint,
  snapshots: Map<string, AgentBehaviorSnapshot>
): VectorMatchResult[] {
  const taskVec = toolNeedsToVector(fp.tools_needed);
  const out: VectorMatchResult[] = [];
  for (const [name, snap] of snapshots) {
    const tool_match = cosine(taskVec, snap.tool_vector_normalized);
    const stuck_penalty = stuckPenalty(fp.risk_topics, snap);
    out.push({
      agent_name: name,
      tool_match,
      stuck_penalty,
      score: tool_match * (1 - stuck_penalty)
    });
  }
  return out.sort((a, b) => b.score - a.score);
}

export function toolNeedsToVector(toolsNeeded: string[]): number[] {
  const set = new Set(toolsNeeded);
  // Use ones (membership vector). Could weight, but presence/absence keeps
  // cosine simple and lets agent tool_vector amplitude do the talking.
  const v: number[] = CANONICAL_TOOLS.map((t) => (set.has(t) ? 1 : 0));
  const norm = Math.sqrt(v.reduce<number>((a, x) => a + x * x, 0));
  if (norm === 0) return v.map(() => 0);
  return v.map((x) => x / norm);
}

export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  // a and b are pre-normalized; cosine == dot.
  // Clamp for floating noise.
  if (dot < 0) return 0;
  if (dot > 1) return 1;
  return dot;
}

// Returns 0 (no historical stuck on these topics) to 1 (very high).
// Logistic: ratio of (sum of stuck counts matching risk topics) / (total stuck count).
// Multiplied by a saturation factor so a tiny absolute count doesn't dominate.
export function stuckPenalty(
  riskTopics: string[],
  snap: AgentBehaviorSnapshot
): number {
  if (riskTopics.length === 0 || snap.stuck_topics.length === 0) return 0;
  const riskSet = new Set(riskTopics);
  let matched = 0;
  let total = 0;
  for (const t of snap.stuck_topics) {
    total += t.count;
    if (riskSet.has(t.topic)) matched += t.count;
  }
  if (total === 0) return 0;
  const ratio = matched / total;
  // Saturation: small absolute counts → discount; ≥ 10 stuck events → full weight.
  const sat = Math.min(1, total / 10);
  return ratio * sat;
}
