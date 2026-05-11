// PMA decision rules. Eng review 7A.
//
// These rules are deterministic — they do NOT depend on the LLM. The LLM
// produces rationale prose; the PMA logic produces the structured decision.
//
//   - capability_fit < 5 → top1 = null, reason = "无明确合适人选"
//   - top1.capability_fit - top2.capability_fit ≤ 1 → alternatives = [top2.agent_name]
//   - confidence = (top1_capability + top1_load) / 20  (0-1 range)
//   - all agents fail / null → top1 = null, reason = explicit cause
//
// Tested in tests/pma/decision.test.ts (5 cases).

import type { AgentResponse, PMADecision } from '../types/index';

export interface DecisionInput {
  task_description: string;
  responses: AgentResponse[];
  rationale: string;
}

const MIN_CAPABILITY_FIT = 5;
const TIE_THRESHOLD = 1;

export function decideTop1(input: DecisionInput): PMADecision {
  const { task_description, responses, rationale } = input;
  const ts = new Date().toISOString();

  const successful = responses.filter(
    (r) => r.capability_fit !== null && r.load_fit !== null && !r.fallback
  );

  if (successful.length === 0) {
    return {
      task_description,
      top1: null,
      top1_capability: null,
      top1_load: null,
      confidence: 0,
      rationale: rationale || 'All agents failed to respond.',
      alternatives: [],
      all_responses: responses,
      reason_if_null: 'service_unavailable',
      ts
    };
  }

  // Sort by capability_fit desc, tiebreak by load_fit desc.
  const sorted = [...successful].sort((a, b) => {
    const c = (b.capability_fit ?? 0) - (a.capability_fit ?? 0);
    if (c !== 0) return c;
    return (b.load_fit ?? 0) - (a.load_fit ?? 0);
  });

  const top = sorted[0];
  const topCap = top.capability_fit ?? 0;
  const topLoad = top.load_fit ?? 0;

  if (topCap < MIN_CAPABILITY_FIT) {
    return {
      task_description,
      top1: null,
      top1_capability: topCap,
      top1_load: topLoad,
      confidence: 0,
      rationale: rationale || `No agent reaches the minimum capability_fit threshold of ${MIN_CAPABILITY_FIT}.`,
      alternatives: [],
      all_responses: responses,
      reason_if_null: 'no_suitable_assignee',
      ts
    };
  }

  // Find ties within the threshold.
  const alternatives = sorted
    .slice(1)
    .filter((r) => topCap - (r.capability_fit ?? 0) <= TIE_THRESHOLD)
    .map((r) => r.agent_name);

  const confidence = clamp01((topCap + topLoad) / 20);

  return {
    task_description,
    top1: top.agent_name,
    top1_capability: topCap,
    top1_load: topLoad,
    confidence,
    rationale,
    alternatives,
    all_responses: responses,
    ts
  };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
