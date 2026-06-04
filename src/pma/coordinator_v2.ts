// PMA v2 coordinator — three-path fusion: vector + grounded persona LLM
// + (future) trajectory Monte Carlo. v1 (coordinator.ts) stays alive for
// A/B during M3.B; both live behind a feature flag in route.ts.
//
// Flow:
//   1. buildFingerprint(task)                — LLM + local lookups (≤24h cache)
//   2. loadOrBuildSnapshots()                — read disk or rebuild fresh
//   3. eligiblePool()                        — drop unknown energy / 老板
//   4. vectorMatch() over all eligible       — cosine, instant
//   5. top-K=5 by vector → parallel grounded LLM persona eval
//   6. fuse() → applyGates()                 — deterministic decision
//   7. synthesis LLM writes rationale
//   8. emit prediction.made event
//
// Monte Carlo (Path C) slot is reserved on every CandidateScore (null until M3.B).

import { promises as fs } from 'node:fs';
import { llmCall, llmStream, stripThinkBlocks } from '../lib/llm';
import { getState } from '../lib/agents';
import { appendEvent } from '../lib/events';
import { saveTask } from '../lib/tasks';
import { appendTimelineEvent } from '../lib/timeline';
import { loadProjectKnowledge, enrichAgentProjects } from '../lib/project_knowledge';
import type { ProjectKnowledgeEntry } from '../lib/project_knowledge';
import type { Task } from '../types/index';
import { buildFingerprint } from '../predict/fingerprint';
import { loadOrBuildSnapshots } from '../predict/snapshot_loader';
import { vectorMatch } from '../predict/vector_match';
import { fuse, applyGates } from '../predict/fuse';
import { simulateTrajectory } from '../predict/trajectory_sim';
import {
  personaSystemPromptV2,
  personaUserPromptV2,
  walkthroughSystemPrompt,
  walkthroughUserPrompt,
  SUBTASK_SPLIT_SYSTEM,
  subtaskSplitUserPrompt,
  PMA_SYSTEM_V2,
  pmaSynthesisUserPromptV2,
  summarizeCandidateForSynthesis
} from '../predict/persona_prompts';
import type {
  PMADecisionV2,
  CandidateScore,
  PredictV2Inputs,
  AgentEvalLLM,
  AgentWalkthrough,
  SubtaskAssignment,
  SnapshotsBundle
} from '../predict/types';
import type { AgentBehaviorSnapshot } from '../index/behavior';
import type { PersonalAgentProfile } from '../types/index';

const PREDICTOR_VERSION = 'pma-v2.1.0';
// Top-K by vector that get a grounded LLM eval. Set higher than rocket team's
// active-agent count so today (~12 active) every eligible agent always gets
// LLM-scored — avoids "no LLM = optimistic vec-only" gaming the fuse.
const TOP_K_FOR_LLM = 12;
// Top-K post-LLM that get Monte Carlo trajectory simulation. Smaller because
// Monte Carlo only differentiates the final few; running it on everyone is
// waste.
const TOP_K_FOR_MC = 3;
const MC_RUNS = 20;
// Top-K that get a "如果我接, 我会..." walkthrough. Bumped to 5 so candidates
// whose project ownership > skill-label match (e.g. someone who's literally
// building the product but missing the right profile tag) still get to show
// their plan.
const TOP_K_FOR_WALKTHROUGH = 5;
const WALKTHROUGH_TIMEOUT_MS = parseInt(process.env.WALKTHROUGH_TIMEOUT_MS ?? '60000', 10);
// Minimum CC events on a current_project for it to count as "ownership".
const PROJECT_OWNER_MIN_EVENTS = 1000;
const ASK_TIMEOUT_MS = parseInt(process.env.ASK_AGENT_TIMEOUT_MS ?? '12000', 10);
const SYNTH_TIMEOUT_MS = parseInt(process.env.PMA_SYNTHESIS_TIMEOUT_MS ?? '20000', 10);

export interface CoordinateV2Options extends PredictV2Inputs {
  onSynthesisToken?: (token: string) => void;
}

export async function pmaPredictV2(opts: CoordinateV2Options): Promise<PMADecisionV2> {
  const tStart = Date.now();

  // === Phase 1: fingerprint ===
  const fpStart = Date.now();
  const fp = await buildFingerprint({
    task_id: opts.task_id,
    description: opts.description,
    importance: opts.importance,
    urgency: opts.urgency
  });
  const fingerprint_ms = Date.now() - fpStart;

  // === Phase 2: snapshots + project knowledge ===
  const snapStart = Date.now();
  const [bundle, projectKnowledge] = await Promise.all([
    loadOrBuildSnapshots({ windowDays: 30 }),
    loadProjectKnowledge()
  ]);
  const snapshot_load_ms = Date.now() - snapStart;

  // === Phase 3: eligibility ===
  const profiles = await loadProfilesFor(Array.from(bundle.snapshots.keys()));
  const eligibleNames = filterEligible(bundle, profiles);
  if (eligibleNames.length === 0) {
    return emptyDecision(opts, fp, 'no_agents', tStart, {
      fingerprint_ms,
      snapshot_load_ms,
      vector_ms: 0,
      llm_eval_ms: 0
    });
  }

  // === Phase 4: vector match ===
  const vecStart = Date.now();
  const eligibleSnaps = new Map<string, AgentBehaviorSnapshot>();
  for (const n of eligibleNames) eligibleSnaps.set(n, bundle.snapshots.get(n)!);
  const ranked = vectorMatch(fp, eligibleSnaps);
  const vector_ms = Date.now() - vecStart;

  const candidates: CandidateScore[] = ranked.map((r) => ({
    name: r.agent_name,
    is_ai_agent: profiles.get(r.agent_name)?.kind === 'ai',
    score_vector: r.score,
    vector_tool_match: r.tool_match,
    vector_stuck_penalty: r.stuck_penalty,
    score_llm: null,
    walkthrough: null,
    score_trajectory: null,
    fused_capability: 0,
    fused_load: 0,
    raw_confidence: 0,
    calibrated_confidence: 0,
    behavior_snapshot_ref: `${bundle.source_path}#${r.agent_name}`
  }));

  // === Phase 5: top-K grounded LLM eval (parallel) ===
  // Seed per (task_id, candidate name) so same task → same persona answers,
  // killing run-to-run jitter on cap/load integers.
  const llmStart = Date.now();
  const topK = candidates.slice(0, TOP_K_FOR_LLM);
  await Promise.all(
    topK.map(async (c) => {
      c.score_llm = await groundedAskAgent(
        c.name,
        opts.description,
        fp,
        profiles.get(c.name)!,
        bundle.snapshots.get(c.name)!,
        projectKnowledge,
        hashSeed(`${opts.task_id}:${c.name}:persona`),
        opts.signal
      );
    })
  );
  const llm_eval_ms = Date.now() - llmStart;

  // === Phase 5.5: pick Monte Carlo targets from vector+LLM, NOT from
  // owner-boosted fuse. Avoids picking MC candidates because they got
  // an ownership boost (which then re-enters fuse and stacks). ===
  // Per-candidate "neutral" score = vector + LLM eval, no missing-path
  // penalty and no ownership boost. Just rank by (vector ⊕ LLM) for MC.
  const neutralScored = [...candidates]
    .map((c) => ({
      c,
      neutral:
        c.score_vector * 0.35 +
        (c.score_llm ? c.score_llm.capability_fit / 10 : 0.4) * 0.65
    }))
    .sort((a, b) => b.neutral - a.neutral);
  const mcTargets = new Set(neutralScored.slice(0, TOP_K_FOR_MC).map((x) => x.c.name));

  // Compute project ownership relevance for the upcoming structural boost.
  const projectRelationship = computeProjectRelationship(
    candidates,
    bundle.snapshots,
    projectKnowledge,
    opts.description,
    fp
  );

  // === Phase 5.6: Monte Carlo on the neutrally-selected top-K-MC ===
  const mcStart = Date.now();
  const baseSeed = hashSeed(opts.task_id);
  for (const c of candidates) {
    if (!mcTargets.has(c.name)) continue;
    const snap = bundle.snapshots.get(c.name);
    if (!snap) continue;
    c.score_trajectory = simulateTrajectory(snap, fp, {
      n_runs: MC_RUNS,
      seed: baseSeed ^ hashSeed(c.name)
    });
  }
  // Now run provisional fuse (with owner boost + trajectory) for the
  // walkthrough top-K selection.
  fuse({
    candidates,
    snapshots: bundle.snapshots,
    applyCalibration: (raw) => raw,
    projectRelationship
  });
  const mc_ms = Date.now() - mcStart;

  // === Phase 5.7: walkthrough — first-person "如果我接, 我会…" ===
  // Run for top-K-WALKTHROUGH by current rank, PLUS any candidate who owns
  // a RELEVANT project. "Relevant" means: project ≥ PROJECT_OWNER_MIN_EVENTS
  // AND task description mentions the project name (case-insensitive) OR the
  // candidate already surfaced in fingerprint.linked_context.historical_owners
  // (which was keyword-matched against task tokens).
  //
  // Earlier version promoted on raw event count alone — surfaced "whoever's
  // currently busiest" regardless of topic match. Bad signal: someone deep
  // in unrelated work would always get pulled into the recommendation pool.
  const walkthroughTargets = new Set<string>();
  for (const c of candidates.slice(0, TOP_K_FOR_WALKTHROUGH)) walkthroughTargets.add(c.name);
  const taskLow = opts.description.toLowerCase();
  const histOwners = new Set(fp.linked_context.historical_owners.map((h) => h.name));
  for (const c of candidates) {
    if (walkthroughTargets.size >= 8) break;
    if (walkthroughTargets.has(c.name)) continue;
    const snap = bundle.snapshots.get(c.name);
    if (!snap) continue;
    const projectMatchesTask = snap.current_projects.some(
      (p) =>
        p.event_count >= PROJECT_OWNER_MIN_EVENTS &&
        p.name.length >= 2 &&
        taskLow.includes(p.name.toLowerCase())
    );
    const isRelevantHistoricalOwner = histOwners.has(c.name);
    if (projectMatchesTask || isRelevantHistoricalOwner) {
      walkthroughTargets.add(c.name);
    }
  }
  const wkStart = Date.now();
  await Promise.all(
    candidates
      .filter((c) => walkthroughTargets.has(c.name))
      .map(async (c) => {
        const snap = bundle.snapshots.get(c.name);
        const profile = profiles.get(c.name);
        if (!snap || !profile) return;
        c.walkthrough = await runWalkthrough(
          profile,
          snap,
          opts.description,
          fp,
          projectKnowledge,
          hashSeed(`${opts.task_id}:${c.name}:wk`),
          opts.signal
        );
      })
  );
  const walkthrough_ms = Date.now() - wkStart;
  void walkthrough_ms;

  // === Phase 6: re-fuse with trajectory + gate (same ownership boost) ===
  fuse({
    candidates,
    snapshots: bundle.snapshots,
    applyCalibration: (raw) => raw, // identity until M3.C calibration table exists
    projectRelationship
  });
  const gate = applyGates(candidates);

  // === Phase 7: synthesis rationale ===
  const top1Cand =
    gate.top1 != null ? candidates.find((c) => c.name === gate.top1) ?? null : null;
  const summaries = candidates
    .slice(0, TOP_K_FOR_LLM)
    .map((c) => summarizeCandidateForSynthesis(c, bundle.snapshots.get(c.name)));

  let rationale = '';
  try {
    rationale = await llmStream({
      system: PMA_SYSTEM_V2,
      user: pmaSynthesisUserPromptV2(opts.description, fp, summaries),
      signal: opts.signal,
      temperature: 0.4,
      maxTokens: 800,
      seed: hashSeed(`synthesis:${opts.task_id}`),
      onToken: (t) => opts.onSynthesisToken?.(t)
    });
    rationale = stripThinkBlocks(rationale);
  } catch (err) {
    rationale = `[synthesis failed: ${(err as Error).message}]`;
  }

  // === Phase 7.5: subtask split (only when splittable + has expected_subtasks) ===
  let subtask_split: SubtaskAssignment[] | null = null;
  let subtask_split_failure_reason:
    | 'not_splittable'
    | 'no_subtasks'
    | 'gate_blocked'
    | 'parse_failed'
    | 'no_candidates_returned'
    | 'timeout'
    | 'exception'
    | null = null;
  if (!fp.splittable) {
    subtask_split_failure_reason = 'not_splittable';
  } else if (!fp.expected_subtasks || fp.expected_subtasks.length === 0) {
    subtask_split_failure_reason = 'no_subtasks';
  } else if (gate.reason_if_null) {
    subtask_split_failure_reason = 'gate_blocked';
  } else {
    try {
      const result = await runSubtaskSplit(
        opts.description,
        fp.expected_subtasks,
        candidates,
        bundle.snapshots,
        profiles,
        projectKnowledge,
        opts.signal
      );
      if (result === null) {
        subtask_split_failure_reason = 'parse_failed';
      } else if (result.length === 0) {
        subtask_split_failure_reason = 'no_candidates_returned';
      } else {
        subtask_split = result;
      }
    } catch (err) {
      const isAbort = (err as Error).name === 'AbortError';
      subtask_split_failure_reason = isAbort ? 'timeout' : 'exception';
      console.warn('[pma-v2] subtask split failed:', (err as Error).message);
    }
  }

  const decision: PMADecisionV2 = {
    task_id: opts.task_id,
    fingerprint: fp,
    top1: gate.top1,
    alternatives: gate.alternatives,
    raw_confidence: top1Cand?.raw_confidence ?? 0,
    calibrated_confidence: top1Cand?.calibrated_confidence ?? 0,
    reason_if_null: gate.reason_if_null,
    rationale,
    subtask_split,
    subtask_split_failure_reason,
    candidates,
    ts: new Date().toISOString(),
    predictor_version: PREDICTOR_VERSION,
    latencies: {
      fingerprint_ms,
      snapshot_load_ms,
      vector_ms,
      llm_eval_ms,
      total_ms: Date.now() - tStart
    }
  };
  // Stash mc_ms in console; types schema doesn't carry it yet.
  void mc_ms;

  // === Phase 8a: persist Task record so the team UI workboard / status pages
  // can show this prediction. v1 did this in persistTask(); v2 had silently
  // skipped it, so /dispatch decisions never surfaced in the dashboard.
  const now = new Date().toISOString();
  const task: Task = {
    id: opts.task_id,
    description: opts.description,
    decision,
    status: decision.top1 ? 'predicted' : 'predicting',
    importance: fp.importance,
    urgency: fp.urgency,
    quality_bar: fp.quality_bar,
    estimated_effort_days: fp.est_effort_days,
    required_skills: fp.skills_needed.map((s) => s.skill),
    created_at: now,
    updated_at: now
  };
  await saveTask(task);

  // === Phase 8b: emit prediction.made event for closed loop ===
  await appendEvent({
    source: 'system',
    type: 'prediction.made',
    subject: { kind: 'task', ref: opts.task_id },
    evidence: {
      fields: {
        top1: decision.top1,
        alternatives: decision.alternatives,
        calibrated_confidence: decision.calibrated_confidence,
        reason_if_null: decision.reason_if_null,
        predictor_version: PREDICTOR_VERSION
      }
    }
  });

  // === Phase 8c: timeline event so the workboard timeline shows it ===
  await appendTimelineEvent({
    ts: decision.ts,
    type: 'task_predicted',
    task_id: opts.task_id,
    agent_name: decision.top1 ?? undefined,
    summary: decision.top1
      ? `${opts.task_id} → ${decision.top1} (置信度 ${(decision.calibrated_confidence * 100).toFixed(0)}%, v2)`
      : `${opts.task_id} → 无明确合适人选 (v2)`,
    detail: { reason_if_null: decision.reason_if_null, alternatives: decision.alternatives }
  });

  console.log(
    `[pma-v2] task=${opts.task_id} top1=${decision.top1 ?? 'null'} conf=${decision.calibrated_confidence.toFixed(2)} ` +
      `fp=${fingerprint_ms}ms snap=${snapshot_load_ms}ms vec=${vector_ms}ms llm=${llm_eval_ms}ms mc=${mc_ms}ms total=${decision.latencies.total_ms}ms`
  );

  return decision;
}

// === Helpers ===

async function loadProfilesFor(names: string[]): Promise<Map<string, PersonalAgentProfile>> {
  const out = new Map<string, PersonalAgentProfile>();
  await Promise.all(
    names.map(async (n) => {
      try {
        out.set(n, await getState(n));
      } catch {
        /* skip missing */
      }
    })
  );
  return out;
}

function filterEligible(
  bundle: SnapshotsBundle,
  profiles: Map<string, PersonalAgentProfile>
): string[] {
  const out: string[] = [];
  for (const [name, snap] of bundle.snapshots) {
    const p = profiles.get(name);
    if (!p) continue;
    if (p.dept === '老板') continue;
    if ((p.role ?? '').includes('老板')) continue;
    // Skip "unknown" energy — no observed behavior, vector_match would
    // produce score=0 anyway. They stay in profiles but are not eligible
    // candidates until they start using CC and we have something to ground on.
    if (snap.energy_inferred === 'unknown') continue;
    if (snap.energy_inferred === 'burnt') continue;
    out.push(name);
  }
  return out;
}

// Compute task-relevant project relationship per candidate. A candidate is:
//   - 'owner' if any of their current_projects is an alias of a knowledge
//     entry whose owners include them AND task topic overlaps the entry's
//     synopsis/related_topics or the task description mentions the name.
//   - 'contributor' if same as above but they're in contributors[].
//   - undefined otherwise.
//
// Topic overlap: a) project name appears in task description, or b) any
// related_topic token appears in task description, or c) any related_topic
// appears in fingerprint.skills_needed[].skill / risk_topics.
function computeProjectRelationship(
  candidates: CandidateScore[],
  snapshots: Map<string, AgentBehaviorSnapshot>,
  knowledge: Record<string, ProjectKnowledgeEntry>,
  description: string,
  fp: import('../predict/fingerprint').TaskFingerprint
): Map<string, 'owner' | 'contributor_active' | 'contributor_known'> {
  const out = new Map<string, 'owner' | 'contributor_active' | 'contributor_known'>();
  if (Object.keys(knowledge).length === 0) return out;

  const descLow = description.toLowerCase();
  const skillBlob = fp.skills_needed.map((s) => s.skill.toLowerCase()).join(' ');
  const riskBlob = fp.risk_topics.map((t) => t.toLowerCase()).join(' ');
  const taskBlob = `${descLow} ${skillBlob} ${riskBlob}`;

  // Priority order so we don't downgrade: owner > contributor_active >
  // contributor_known. Helper enforces.
  const setIfStronger = (
    name: string,
    level: 'owner' | 'contributor_active' | 'contributor_known'
  ) => {
    const rank: Record<string, number> = {
      owner: 3,
      contributor_active: 2,
      contributor_known: 1
    };
    const existing = out.get(name);
    if (!existing || rank[level] > rank[existing]) out.set(name, level);
  };

  for (const [projectName, entry] of Object.entries(knowledge)) {
    let matched = taskBlob.includes(projectName.toLowerCase());
    if (!matched) {
      for (const topic of entry.related_topics ?? []) {
        if (taskBlob.includes(topic.toLowerCase())) {
          matched = true;
          break;
        }
      }
    }
    if (!matched) continue;

    const aliasSet = new Set([projectName.toLowerCase(), ...(entry.aliases ?? []).map((a) => a.toLowerCase())]);
    for (const c of candidates) {
      const snap = snapshots.get(c.name);
      const hasEvents = !!snap && snap.current_projects.some((p) => aliasSet.has(p.name.toLowerCase()));
      if (entry.owners.includes(c.name) && hasEvents) {
        setIfStronger(c.name, 'owner');
      } else if (entry.contributors.includes(c.name)) {
        setIfStronger(c.name, hasEvents ? 'contributor_active' : 'contributor_known');
      } else if (entry.owners.includes(c.name) && !hasEvents) {
        // Listed as owner but no CC events — they're known but stale.
        // Treat as known contributor; they may have stepped away.
        setIfStronger(c.name, 'contributor_known');
      }
    }
  }
  return out;
}

async function runSubtaskSplit(
  description: string,
  subtasks: string[],
  candidates: CandidateScore[],
  snapshots: Map<string, AgentBehaviorSnapshot>,
  profiles: Map<string, PersonalAgentProfile>,
  knowledge: Record<string, ProjectKnowledgeEntry>,
  signal: AbortSignal | undefined
): Promise<SubtaskAssignment[] | null> {
  // Build candidate evidence digest. Each entry packs four signal sources so
  // the LLM can do skill-by-subtask matching rather than defaulting to the
  // project owner for everything:
  //   1. profile.dept                  — dept-level fit hint
  //   2. profile.capabilities domains/skills — what tags they self-attest
  //   3. current_projects (canonical)  — what they're literally building
  //   4. walkthrough text              — first-person plan declaring intent
  // Include all candidates who got a walkthrough (those are the
  // implementation-grounded views) + fill up to 10 by rank if any slot
  // remains. Avoids cutting niche-skill candidates outside top-8.
  const subtaskDigestSet = new Set<string>();
  for (const c of candidates) if (c.walkthrough) subtaskDigestSet.add(c.name);
  for (const c of candidates) {
    if (subtaskDigestSet.size >= 10) break;
    subtaskDigestSet.add(c.name);
  }
  const digestCandidates = candidates.filter((c) => subtaskDigestSet.has(c.name));
  const summaries = digestCandidates.map((c) => {
    const snap = snapshots.get(c.name);
    const profile = profiles.get(c.name);
    let projects = '';
    if (snap && snap.current_projects.length > 0) {
      const enriched = enrichAgentProjects(c.name, snap.current_projects, knowledge).slice(0, 3);
      projects = ` 当前项目: ${enriched
        .map((p) => {
          const label = p.canonical_name ?? p.raw_name;
          const own = p.is_owner ? ' [owner]' : p.canonical_name ? ' [contrib]' : '';
          const syn = p.synopsis ? ` = ${p.synopsis.slice(0, 60)}` : '';
          return `${label}${own}${syn}(${p.event_count}e)`;
        })
        .join('; ')}`;
    }
    const role = profile ? ` dept=${profile.dept}` : '';
    const skills = profile
      ? ' 技能=[' +
        [
          ...(profile.capabilities?.domains ?? []).map((d) => d.name),
          ...(profile.capabilities?.skills ?? []).map((s) => s.name)
        ]
          .slice(0, 6)
          .join(', ') +
        ']'
      : '';
    const llm = c.score_llm
      ? ` cap_llm=${c.score_llm.capability_fit} load_llm=${c.score_llm.load_fit}`
      : '';
    const wk = c.walkthrough ? `\n  walkthrough: "${c.walkthrough.text.slice(0, 280)}"` : '';
    return `- ${c.name}${role}${skills}${projects}${llm} conf=${(c.calibrated_confidence * 100).toFixed(0)}%${wk}`;
  });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener('abort', () => ctrl.abort(), { once: true });
  }
  try {
    const text = await llmCall({
      system: SUBTASK_SPLIT_SYSTEM,
      user: subtaskSplitUserPrompt(description, subtasks, summaries),
      signal: ctrl.signal,
      maxTokens: 2000,
      temperature: 0.2,
      seed: hashSeed(`subtask_split:${description}`)
    });
    const cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
    const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
    const candidate = fence ? fence[1] : cleaned;
    const start = candidate.indexOf('[');
    const end = candidate.lastIndexOf(']');
    if (start === -1 || end <= start) {
      console.warn('[pma-v2] subtask_split LLM output had no [...] array, first 300 chars:', candidate.slice(0, 300));
      return null;
    }
    let parsed: Array<{
      subtask?: unknown;
      suggested_owner?: unknown;
      alternatives?: unknown;
      why?: unknown;
    }>;
    try {
      parsed = JSON.parse(candidate.slice(start, end + 1));
    } catch (e) {
      console.warn(
        '[pma-v2] subtask_split JSON.parse failed:',
        (e as Error).message,
        'snippet:',
        candidate.slice(start, Math.min(end + 1, start + 400))
      );
      return null;
    }
    const knownNames = new Set(candidates.map((c) => c.name));
    return parsed
      .map((row): SubtaskAssignment | null => {
        const subtask = typeof row.subtask === 'string' ? row.subtask.slice(0, 200) : '';
        if (!subtask) return null;
        const own =
          typeof row.suggested_owner === 'string' && knownNames.has(row.suggested_owner)
            ? row.suggested_owner
            : null;
        const alts = Array.isArray(row.alternatives)
          ? row.alternatives.filter((x): x is string => typeof x === 'string' && knownNames.has(x)).slice(0, 3)
          : [];
        const why = typeof row.why === 'string' ? row.why.slice(0, 200) : '';
        return { subtask, suggested_owner: own, alternatives: alts, why };
      })
      .filter((x): x is SubtaskAssignment => x !== null);
  } catch (err) {
    console.warn('[pma-v2] runSubtaskSplit failed:', (err as Error).message ?? err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function runWalkthrough(
  profile: PersonalAgentProfile,
  snap: AgentBehaviorSnapshot,
  description: string,
  fp: import('../predict/fingerprint').TaskFingerprint,
  knowledge: Record<string, ProjectKnowledgeEntry>,
  seed: number,
  signal: AbortSignal | undefined
): Promise<AgentWalkthrough | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), WALKTHROUGH_TIMEOUT_MS);
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener('abort', () => ctrl.abort(), { once: true });
  }
  try {
    const text = await llmCall({
      system: walkthroughSystemPrompt(profile, snap, knowledge),
      user: walkthroughUserPrompt(description, fp),
      signal: ctrl.signal,
      maxTokens: 1500,
      temperature: 0.5,
      seed
    });
    const obj = parseAgentJSON(text) as
      | {
          text?: unknown;
          predicted_first_action?: unknown;
          predicted_collab_pings?: unknown;
          predicted_blockers?: unknown;
        }
      | null;
    if (!obj || typeof obj.text !== 'string' || obj.text.length === 0) return null;
    return {
      text: obj.text.slice(0, 800),
      predicted_first_action:
        typeof obj.predicted_first_action === 'string' ? obj.predicted_first_action.slice(0, 120) : '',
      predicted_collab_pings: arrAtStrings(obj.predicted_collab_pings).slice(0, 3),
      predicted_blockers: arrAtStrings(obj.predicted_blockers).slice(0, 3)
    };
  } catch (err) {
    console.warn(`[pma-v2] walkthrough failed for ${profile.name}:`, (err as Error).message ?? err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function arrAtStrings(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && x.length > 0).map((s) => s.slice(0, 80));
}

async function groundedAskAgent(
  name: string,
  question: string,
  fp: import('../predict/fingerprint').TaskFingerprint,
  profile: PersonalAgentProfile,
  snap: AgentBehaviorSnapshot,
  knowledge: Record<string, ProjectKnowledgeEntry>,
  seed: number,
  signal: AbortSignal | undefined
): Promise<AgentEvalLLM> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ASK_TIMEOUT_MS);
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener('abort', () => ctrl.abort(), { once: true });
  }
  try {
    const text = await llmCall({
      system: personaSystemPromptV2(profile, snap, knowledge),
      user: personaUserPromptV2(question, fp, snap),
      signal: ctrl.signal,
      maxTokens: 4000,
      temperature: 0.3,
      seed
    });
    const obj = parseAgentJSON(text);
    if (!obj) return { capability_fit: 0, load_fit: 0, reason: 'no valid JSON returned' };
    return {
      capability_fit: clamp10(obj.capability_fit),
      load_fit: clamp10(obj.load_fit),
      reason: typeof obj.reason === 'string' ? obj.reason.slice(0, 600) : ''
    };
  } catch (err) {
    const msg = (err as Error).message || String(err);
    return { capability_fit: 0, load_fit: 0, reason: `agent eval failed: ${msg}` };
  } finally {
    clearTimeout(timer);
  }
}

// FNV-1a 32-bit hash to derive replay-safe seeds from task_id + agent name.
function hashSeed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function clamp10(n: unknown): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(10, Math.round(n)));
}

function parseAgentJSON(text: string): {
  capability_fit?: unknown;
  load_fit?: unknown;
  reason?: unknown;
} | null {
  let cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  const openOnly = cleaned.indexOf('<think>');
  if (openOnly !== -1) cleaned = cleaned.slice(0, openOnly);
  const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fence ? fence[1] : cleaned;
  const start = candidate.indexOf('{');
  if (start === -1) return null;
  for (let end = candidate.lastIndexOf('}'); end > start; end = candidate.lastIndexOf('}', end - 1)) {
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {
      /* try smaller */
    }
    if (end <= start) break;
  }
  return null;
}

function emptyDecision(
  opts: CoordinateV2Options,
  fp: import('../predict/fingerprint').TaskFingerprint,
  reason: import('../predict/types').ReasonIfNull,
  tStart: number,
  partial: { fingerprint_ms: number; snapshot_load_ms: number; vector_ms: number; llm_eval_ms: number }
): PMADecisionV2 {
  return {
    task_id: opts.task_id,
    fingerprint: fp,
    top1: null,
    alternatives: [],
    raw_confidence: 0,
    calibrated_confidence: 0,
    reason_if_null: reason,
    rationale: '当前没有符合条件的候选 (无 CC 行为快照或全部 burnt)。',
    candidates: [],
    ts: new Date().toISOString(),
    predictor_version: PREDICTOR_VERSION,
    latencies: { ...partial, total_ms: Date.now() - tStart }
  };
}
