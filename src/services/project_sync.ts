// S1 orchestrator: extract → resolve.
//
// Public entry for periodic registry maintenance. Used by `bun run sync` tail
// (cron) and by `tools/audit-resolver.ts` (gate A). Pure compose — extraction
// and resolver each own their own concurrency story.

import { runProjectExtraction, type ProjectProposal } from './project_extraction';
import { resolveProposals, type ResolutionOutcome } from './project_resolver';
import { seedProposalsFromGithub } from './project_seed';
import type { ProjectEntity } from '../lib/projects';

export interface ProjectSyncSummary {
  proposals: ProjectProposal[];
  outcomes: ResolutionOutcome[];
  projects: ProjectEntity[];
  llmMergeFailures: number;
  errors: Array<{ stage: 'extract' | 'resolve'; error: string }>;
}

export async function runProjectSync(opts?: {
  windowDays?: number;
  // LLM extraction adds fuzzy-named projects from events. The leader's
  // directive: tracked GH repo IS the project; LLM-only projects are noise.
  // Default OFF. Set `enableLlmExtraction: true` (or env
  // `PROJECT_LLM_EXTRACTION=1`) to opt back in.
  enableLlmExtraction?: boolean;
}): Promise<ProjectSyncSummary> {
  const errors: ProjectSyncSummary['errors'] = [];
  // Phase 1: seed from GH tracked repos. Authoritative. The set of registered
  // projects is exactly `cfg.selected_repos`. Cheap (no LLM call).
  let seedProposals: ProjectProposal[] = [];
  try {
    seedProposals = await seedProposalsFromGithub();
  } catch (err) {
    errors.push({ stage: 'extract', error: `seed: ${(err as Error).message}` });
  }
  // Phase 2: optional LLM extraction. Disabled by default per leader
  // direction — keep code path live for opt-in use, but don't pollute the
  // registry with synthetic projects.
  let llmProposals: ProjectProposal[] = [];
  const llmEnabled = opts?.enableLlmExtraction ?? process.env.PROJECT_LLM_EXTRACTION === '1';
  if (llmEnabled) {
    try {
      llmProposals = await runProjectExtraction(opts);
    } catch (err) {
      errors.push({ stage: 'extract', error: (err as Error).message });
    }
  }
  const proposals = [...seedProposals, ...llmProposals];
  let outcomes: ResolutionOutcome[] = [];
  let projects: ProjectEntity[] = [];
  let llmMergeFailures = 0;
  try {
    const r = await resolveProposals(proposals);
    outcomes = r.outcomes;
    projects = r.projects;
    llmMergeFailures = r.llmMergeFailures;
  } catch (err) {
    errors.push({ stage: 'resolve', error: (err as Error).message });
  }
  return { proposals, outcomes, projects, llmMergeFailures, errors };
}
