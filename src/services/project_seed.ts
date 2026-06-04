// Seed the project registry from the leader's tracked GitHub repos.
//
// Rationale: the registry is the ground truth for "what counts as a project".
// Letting it bootstrap only from LLM extraction means most CC work shows up
// as `unclear` or `new:*` until the LLM happens to surface the project on
// its own — slow, lossy, and (per the leader) wrong. The leader already
// declared what the team's projects are when picking repos in
// /sources/github; treat that list as the authoritative seed.
//
// Each selected repo becomes a `ProjectProposal` that flows through the
// existing identity resolver (§3.4). The resolver's deterministic fast-path
// catches duplicates between this seed and the LLM extraction pass — a repo
// `Matrix-Riven` minted from GH and a proposal `Matrix-Riven 项目调研` from
// extraction collapse into one project.
//
// Evidence: every seeded proposal carries a synthetic `EvidenceRef` pointing
// at the GitHub repo's html_url (so the registry's evidence_refs still
// satisfy §0.5 discipline 2). source = 'github'.

import { fetchRepoMeta, getToken, readConfig as readGithubConfig } from '../lib/github';
import { resolveRepoResponsible } from './repo_responsible';
import type { ProjectProposal } from './project_extraction';

export async function seedProposalsFromGithub(): Promise<ProjectProposal[]> {
  const cfg = await readGithubConfig();
  const repos = cfg?.selected_repos ?? [];
  if (repos.length === 0) return [];
  const now = new Date().toISOString();
  // Resolve "responsible" + real GH `description` per repo. Without the GH
  // description the attribution LLM has nothing semantic to bind to — work
  // titled "推送到 GitHub" with body "配置了 Upp-Ljl/Pace remote" wouldn't
  // tie back to `pace` from a slug alone. The repo's actual "About" blurb
  // (e.g. "AI agent simulating love-game scenarios") fixes that.
  const proposals: ProjectProposal[] = [];
  const token = await getToken();
  for (const r of repos) {
    let responsible = r.responsible ?? null;
    if (!responsible) {
      try {
        const auto = await resolveRepoResponsible(r.owner, r.name);
        if (auto.name) responsible = auto.name;
      } catch {
        /* best effort; fall through to "未指定" */
      }
    }
    let ghDescription: string | null = null;
    if (token) {
      try {
        const meta = await fetchRepoMeta(token, r.owner, r.name);
        ghDescription = meta?.description ?? null;
      } catch {
        /* leave null */
      }
    }
    const respLabel = responsible ? `负责人 ${responsible}` : '负责人未指定';
    const semantic = ghDescription
      ? `${ghDescription.trim().slice(0, 250)} · ${r.owner}/${r.name} · ${respLabel}`
      : `GitHub repo ${r.owner}/${r.name} · ${respLabel}`;
    proposals.push({
      proposed_name: r.name,
      description: semantic,
      evidence_refs: [
        {
          source: 'github' as const,
          source_id: `gh:${r.owner}/${r.name}`,
          quote: ghDescription
            ? `GH About: "${ghDescription.trim().slice(0, 160)}"`
            : `Repo selected by leader for tracking: ${r.owner}/${r.name}`,
          extracted_at: now
        }
      ],
      observed_surface_names: [r.name, `${r.owner}/${r.name}`]
    });
  }
  return proposals;
}
