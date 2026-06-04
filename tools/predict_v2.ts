#!/usr/bin/env bun
// PMA v2 CLI smoke test.
//
// Usage:
//   bun tools/predict_v2.ts "task description in Chinese"
//   bun tools/predict_v2.ts --importance high --urgency low "..."
//
// Prints the full PMADecisionV2 as JSON (decorated summary at top).

import { pmaPredictV2 } from '../src/pma/coordinator_v2';

function parseArgs() {
  const argv = process.argv.slice(2);
  let importance: 'high' | 'low' | undefined;
  let urgency: 'high' | 'low' | undefined;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--importance') importance = argv[++i] as 'high' | 'low';
    else if (a === '--urgency') urgency = argv[++i] as 'high' | 'low';
    else rest.push(a);
  }
  if (rest.length === 0) {
    console.error('usage: bun tools/predict_v2.ts [--importance high|low] [--urgency high|low] "<task>"');
    process.exit(2);
  }
  return { importance, urgency, description: rest.join(' ') };
}

async function main() {
  const args = parseArgs();
  const taskId = `cli-${Date.now().toString(36)}`;
  console.error(`[predict-v2] task=${taskId}`);
  console.error(`[predict-v2] description=${args.description}`);

  const result = await pmaPredictV2({
    task_id: taskId,
    description: args.description,
    importance: args.importance,
    urgency: args.urgency,
    onSynthesisToken: (t) => process.stderr.write(t)
  });

  console.error('\n\n--- decision summary ---');
  console.log(JSON.stringify(
    {
      task_id: result.task_id,
      top1: result.top1,
      alternatives: result.alternatives,
      calibrated_confidence: result.calibrated_confidence,
      reason_if_null: result.reason_if_null,
      latencies: result.latencies,
      rationale: result.rationale,
      fingerprint: {
        skills_needed: result.fingerprint.skills_needed,
        tools_needed: result.fingerprint.tools_needed,
        risk_topics: result.fingerprint.risk_topics,
        est_effort_days: result.fingerprint.est_effort_days,
        importance: result.fingerprint.importance,
        urgency: result.fingerprint.urgency,
        linked_context: {
          gh_refs: result.fingerprint.linked_context.gh_refs,
          n_meeting_decisions: result.fingerprint.linked_context.meeting_decisions.length,
          n_slack_threads: result.fingerprint.linked_context.slack_threads.length,
          historical_owners: result.fingerprint.linked_context.historical_owners
        }
      },
      candidates: result.candidates.map((c) => ({
        name: c.name,
        score_vector: +c.score_vector.toFixed(3),
        vector_tool_match: +c.vector_tool_match.toFixed(3),
        vector_stuck_penalty: +c.vector_stuck_penalty.toFixed(3),
        llm: c.score_llm
          ? {
              cap: c.score_llm.capability_fit,
              load: c.score_llm.load_fit,
              reason: c.score_llm.reason
            }
          : null,
        trajectory: c.score_trajectory
          ? {
              p_complete_on_time: +c.score_trajectory.p_complete_on_time.toFixed(3),
              duration_p50_d: +c.score_trajectory.duration_p50_d.toFixed(2),
              duration_p90_d: +c.score_trajectory.duration_p90_d.toFixed(2),
              predicted_stuck_topics: c.score_trajectory.predicted_stuck_topics,
              expected_collab: c.score_trajectory.expected_collab,
              expected_rework: +c.score_trajectory.expected_rework.toFixed(3),
              quota_breach_p: +c.score_trajectory.quota_breach_p.toFixed(3)
            }
          : null,
        fused_capability: +c.fused_capability.toFixed(3),
        fused_load: +c.fused_load.toFixed(3),
        calibrated_confidence: +c.calibrated_confidence.toFixed(3)
      }))
    },
    null,
    2
  ));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
