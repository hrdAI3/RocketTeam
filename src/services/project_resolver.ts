// §3.4 Identity resolver.
//
// Maps `ProjectProposal` (from §3.2 extraction, or `"new:<name>"` outputs from
// §3.3 attribution) → stable project id. Two-phase, all writes go through
// `lib/projects.ts` (mutex + atomic). Per spec §0.6 the resolver is the
// gatekeeper of id_stability — once a project mints, its id never changes;
// re-runs only *enrich* (add alias, extend description hint, append evidence).
//
//   1. Deterministic fast path (no LLM, zero risk):
//      - Exact match against any project's id, name, or alias → resolve.
//      - Surface name has a clean prefix relation to an existing alias
//        (e.g. `matrix-recording` <- `matrix`) → resolve + add alias.
//   2. LLM semantic merge (only when fast path misses):
//      - Hand the LLM the proposal + every existing project's
//        {id, name, description, aliases}; ask "is this one of them, or
//        genuinely new?" Constrained output: `{existing-id}` | `"genuinely-new"`.
//      - Existing id → resolve + enrich.
//      - "genuinely-new" → mint with slugified name (de-duped via
//        `uniqueSlug`).
//
// All resolution actions (mint / enrich / fast-name / fast-prefix / merge)
// append a `resolution_log` entry on the affected project — leader can audit
// later via the override panel (§5).
//
// `projects.json` writes are append-mostly: id + name + first_seen_at are
// sticky; everything else can grow. Projects flagged with a manual `overrides`
// entry are passed through untouched so the resolver respects leader fixes.

import { llmCall, stripThinkBlocks } from '../lib/llm';
import {
  readProjects,
  updateProjects,
  slugify,
  uniqueSlug,
  type ProjectEntity,
  type ProjectsFile,
  type ResolutionLogEntry
} from '../lib/projects';
import type { ProjectProposal } from './project_extraction';
import type { EvidenceRef } from '../types';

export interface ResolutionOutcome {
  proposalIndex: number;
  proposed_name: string;
  resolvedId: string;
  action: ResolutionLogEntry['action'];
  reason: string;
  // true when this outcome was a mint that *should have* gone through LLM
  // semantic merge but the merge call failed (or no other path matched and
  // the registry was non-empty). Audit Gate A treats `llmMergeUnreachable:true`
  // mints as suspect — without this signal a bad-LLM-day silently fragments
  // the registry and Gate A would still report 100% id_stability.
  llmMergeUnreachable?: boolean;
}

export interface ResolveResult {
  outcomes: ResolutionOutcome[];
  projects: ProjectEntity[]; // post-resolution snapshot
  llmMergeFailures: number; // count of proposals where the semantic-merge LLM call threw
}

// --------- public entry point ---------

export async function resolveProposals(proposals: ProjectProposal[]): Promise<ResolveResult> {
  if (proposals.length === 0) {
    const cur = await readProjects();
    return { outcomes: [], projects: cur.projects, llmMergeFailures: 0 };
  }

  // Snapshot first so the LLM merge step sees a stable baseline. Resolver may
  // mint new projects during the loop; each mint is incorporated into the
  // working snapshot so later proposals in the same batch can resolve to a
  // freshly-minted id.
  const snapshot = await readProjects();
  const working: ProjectEntity[] = snapshot.projects.map(cloneProject);
  const outcomes: ResolutionOutcome[] = [];
  let llmMergeFailures = 0;
  const nowIso = new Date().toISOString();

  for (let i = 0; i < proposals.length; i++) {
    const p = proposals[i];
    // 1. Deterministic fast path: exact id / name / alias match.
    const exact = findExactMatch(working, p);
    if (exact) {
      enrich(exact, p, 'fast-name', `exact match on ${matchedSurface(exact, p)}`, nowIso);
      outcomes.push({
        proposalIndex: i,
        proposed_name: p.proposed_name,
        resolvedId: exact.id,
        action: 'fast-name',
        reason: `exact match on ${matchedSurface(exact, p)}`
      });
      continue;
    }
    // 2. Deterministic fast path: prefix relation (matrix-recording <- matrix).
    const prefix = findPrefixMatch(working, p);
    if (prefix) {
      enrich(prefix.project, p, 'fast-prefix', `prefix of ${prefix.alias}`, nowIso);
      outcomes.push({
        proposalIndex: i,
        proposed_name: p.proposed_name,
        resolvedId: prefix.project.id,
        action: 'fast-prefix',
        reason: `prefix relation to ${prefix.alias}`
      });
      continue;
    }
    // 3. LLM semantic merge — only when no deterministic match. Empty registry
    //    skips straight to mint.
    let semantic: { id: string; reason: string } | null = null;
    let mergeUnreachable = false;
    if (working.length > 0) {
      try {
        semantic = await llmSemanticMerge(p, working);
      } catch (err) {
        // LLM down → mark this proposal's mint as "unreachable" so audit
        // gate A can flag the run. Without this, an LLM-down day silently
        // fragments the registry and gate A still reports 100% stability.
        mergeUnreachable = true;
        llmMergeFailures++;
        console.warn(
          '[project_resolver] LLM merge failed, falling through to mint:',
          (err as Error).message
        );
      }
    }
    if (semantic) {
      const target = working.find((q) => q.id === semantic.id);
      if (target && !isOverrideLocked(target)) {
        enrich(target, p, 'merge', semantic.reason, nowIso);
        outcomes.push({
          proposalIndex: i,
          proposed_name: p.proposed_name,
          resolvedId: target.id,
          action: 'merge',
          reason: semantic.reason
        });
        continue;
      }
    }
    // 4. Mint a new project.
    const minted = mintProject(p, working, nowIso);
    working.push(minted);
    outcomes.push({
      proposalIndex: i,
      proposed_name: p.proposed_name,
      resolvedId: minted.id,
      action: 'mint',
      reason: mergeUnreachable
        ? 'LLM merge unreachable; minted defensively (audit should flag)'
        : 'no match in registry; minted new id',
      llmMergeUnreachable: mergeUnreachable || undefined
    });
  }

  // Persist via the standard updateProjects path so the write goes through the
  // mutex+atomic. The resolver computed `working` from a clean snapshot, but
  // we still need to merge sensibly if a concurrent writer raced (e.g. the
  // observed_cwds appender from §3.5). Merge strategy: prefer the most recent
  // `last_attributed_at` per project; append fresh resolution_log entries.
  await updateProjects((current) => {
    const byId = new Map(current.projects.map((p) => [p.id, p]));
    for (const updated of working) {
      const existing = byId.get(updated.id);
      if (!existing) {
        byId.set(updated.id, updated);
        continue;
      }
      // Keep the existing project's sticky fields; merge enrichments.
      mergeEnrichmentsInPlace(existing, updated);
    }
    return {
      version: 1,
      projects: Array.from(byId.values())
    } satisfies ProjectsFile;
  });

  const after = await readProjects();
  return { outcomes, projects: after.projects, llmMergeFailures };
}

// --------- deterministic match helpers ---------

function normalize(s: string): string {
  return s.trim().toLowerCase();
}

// Slug-form normalization: lower + collapse whitespace/slashes/underscores to
// hyphens + strip everything else. Mirrors `slugify` so a freshly minted id
// (slug form) matches against an unsligified proposed_name with spaces or
// slashes (e.g. id "goalcast-replay-demo-system" must catch "Goalcast Replay/Demo System").
function normalizeSlug(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[\s_/\\]+/g, '-')
    .replace(/[^a-z0-9-]+/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function aliasesOf(p: ProjectEntity): string[] {
  return [p.id, p.name, ...p.aliases].map(normalize);
}

function findExactMatch(
  projects: ProjectEntity[],
  proposal: ProjectProposal
): ProjectEntity | null {
  const candNames = [proposal.proposed_name, ...proposal.observed_surface_names];
  // Build both raw-lowercase and slug-form variants of the proposal surfaces.
  // The slug form catches the freshly-minted id whose source had spaces or
  // slashes (e.g. id="goalcast-replay-demo-system" vs proposed "Goalcast Replay/Demo System").
  const surfaces = new Set<string>();
  for (const c of candNames) {
    const n = normalize(c);
    if (n.length >= 2) surfaces.add(n);
    const slug = normalizeSlug(c);
    if (slug.length >= 2) surfaces.add(slug);
  }
  for (const p of projects) {
    if (isOverrideLocked(p)) continue;
    // The registry side gets both forms too, so an alias like "Goalcast" still
    // matches the slug "goalcast" from a fresh proposal.
    const known = new Set<string>();
    for (const a of aliasesOf(p)) {
      known.add(a);
      const slug = normalizeSlug(a);
      if (slug.length >= 2) known.add(slug);
    }
    for (const s of surfaces) {
      if (known.has(s)) return p;
    }
  }
  return null;
}

function findPrefixMatch(
  projects: ProjectEntity[],
  proposal: ProjectProposal
): { project: ProjectEntity; alias: string } | null {
  // Prefix relation: A is "B + (`-` or `/`) + suffix". Treat both directions:
  //  - proposal "matrix-recording" against existing alias "matrix" → match.
  //  - proposal "matrix" against existing alias "matrix-recording" → no match
  //    (would over-collapse; the broader name takes priority via mint).
  const surfaces = [proposal.proposed_name, ...proposal.observed_surface_names]
    .map(normalize)
    .filter((s) => s.length >= 3);
  for (const p of projects) {
    if (isOverrideLocked(p)) continue;
    for (const a of aliasesOf(p)) {
      if (a.length < 3) continue;
      for (const s of surfaces) {
        if (s === a) continue;
        if (s.startsWith(a + '-') || s.startsWith(a + '/') || s.startsWith(a + '_')) {
          return { project: p, alias: a };
        }
      }
    }
  }
  return null;
}

function matchedSurface(p: ProjectEntity, proposal: ProjectProposal): string {
  const known = new Set(aliasesOf(p));
  const cands = [proposal.proposed_name, ...proposal.observed_surface_names];
  for (const c of cands) if (known.has(normalize(c))) return c;
  return proposal.proposed_name;
}

function isOverrideLocked(p: ProjectEntity): boolean {
  // Leader overrides act as fences; the auto-resolver doesn't touch a project
  // once leader has labeled it (split / merge / rename). The override panel
  // (§5) is the only writer to that project afterwards.
  return Array.isArray(p.overrides) && p.overrides.length > 0;
}

// --------- LLM semantic merge ---------

const MERGE_SYSTEM = `你是项目身份解析器。我会给你一个项目提议（proposal）和当前登记表里已有的项目清单。判断这个 proposal 是某个已有项目（漂移、聚合、别名），还是确实是新项目。

约束输出：严格 JSON，无 markdown：
{
  "resolved_to": "<已有项目的 id>" | "genuinely-new",
  "reason": "<≤200 字符的判断理由，必须只引用 proposal 的 description / evidence 和登记表的 description / aliases>"
}

判断要点：
- proposal.proposed_name / observed_surface_names 与已有 aliases 不同字但语义近（"teambrain" 之于 "matrix"，"季度文章" 之于 "Q2内容"）→ 倾向已有 id。
- proposal.description 跟某项目 description 讲的是同一件事 → 倾向已有 id。
- 真的是新方向、新仓库、新主题 → "genuinely-new"。
- 无把握 → "genuinely-new"（安全方向，宁可错分也不错并；split 比 merge 容易）。`;

interface MergeResponse {
  resolved_to: string;
  reason: string;
}

async function llmSemanticMerge(
  proposal: ProjectProposal,
  registry: ProjectEntity[]
): Promise<{ id: string; reason: string } | null> {
  const userPrompt = formatMergePrompt(proposal, registry);
  const raw = await llmCall({
    system: MERGE_SYSTEM,
    user: userPrompt,
    temperature: 0.1,
    maxTokens: 600,
    jsonMode: true
  });
  const parsed = parseMergeResponse(raw);
  if (!parsed) return null;
  if (parsed.resolved_to === 'genuinely-new') return null;
  // Constrain output: must be an existing id (§0.5 discipline 1).
  const valid = registry.find((p) => p.id === parsed.resolved_to);
  if (!valid) {
    console.warn(
      `[project_resolver] LLM returned non-registry id ${parsed.resolved_to}; treating as new`
    );
    return null;
  }
  const reason = parsed.reason.slice(0, 200);
  return { id: parsed.resolved_to, reason };
}

function formatMergePrompt(proposal: ProjectProposal, registry: ProjectEntity[]): string {
  const lines: string[] = [];
  lines.push('# 待解析 proposal');
  lines.push(`proposed_name: ${proposal.proposed_name}`);
  lines.push(`description: ${proposal.description || '（无）'}`);
  if (proposal.observed_surface_names.length > 0) {
    lines.push(`observed_surface_names: ${proposal.observed_surface_names.join(' / ')}`);
  }
  const top = proposal.evidence_refs.slice(0, 3);
  if (top.length > 0) {
    lines.push('evidence (前 3 条):');
    for (const e of top) {
      lines.push(`  - [${e.source} ${e.source_id}] ${e.quote.slice(0, 160)}`);
    }
  }
  lines.push('');
  lines.push('# 已有登记表项目');
  if (registry.length === 0) {
    lines.push('（空）');
  } else {
    for (const p of registry) {
      if (p.status === 'archived') continue;
      lines.push(
        `- id=${p.id} name=${p.name}` +
          (p.aliases.length > 0 ? ` aliases=${p.aliases.slice(0, 6).join(',')}` : '')
      );
      if (p.description) lines.push(`  描述: ${p.description.slice(0, 240)}`);
    }
  }
  lines.push('');
  lines.push('按规定 JSON 输出。');
  return lines.join('\n');
}

function parseMergeResponse(raw: string): MergeResponse | null {
  const text = stripThinkBlocks(raw).trim();
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  let end = -1;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end === -1) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end)) as Partial<MergeResponse>;
    if (typeof parsed.resolved_to !== 'string' || parsed.resolved_to.length === 0) return null;
    return {
      resolved_to: parsed.resolved_to,
      reason: typeof parsed.reason === 'string' ? parsed.reason : ''
    };
  } catch {
    return null;
  }
}

// --------- mutation helpers ---------

function cloneProject(p: ProjectEntity): ProjectEntity {
  return {
    ...p,
    aliases: [...p.aliases],
    evidence_refs: p.evidence_refs.map((e) => ({ ...e })),
    observed_cwds: [...p.observed_cwds],
    resolution_log: p.resolution_log.map((e) => ({ ...e })),
    overrides: p.overrides.map((o) => ({ ...o }))
  };
}

function enrich(
  project: ProjectEntity,
  proposal: ProjectProposal,
  action: ResolutionLogEntry['action'],
  reason: string,
  nowIso: string
): void {
  const known = new Set(aliasesOf(project));
  const newAliases: string[] = [];
  for (const s of [proposal.proposed_name, ...proposal.observed_surface_names]) {
    const n = normalize(s);
    if (n.length < 2 || known.has(n)) continue;
    newAliases.push(s.trim());
    known.add(n);
  }
  if (newAliases.length > 0) project.aliases.push(...newAliases);

  // Description grows additively only when the existing one is short — avoid
  // unbounded balloon. The merged value never shrinks past the original
  // (mint is sticky). Dedupe: if the proposal's description already appears
  // verbatim in the existing description, skip the append. Without this, a
  // recurring seed (every sync re-issues the same "GitHub repo X · 负责人未指定"
  // proposal) snowballs into "X · X · X · …" on each fast-name hit.
  if (
    proposal.description &&
    project.description.length < 300 &&
    !project.description.includes(proposal.description.trim())
  ) {
    const sep = project.description.length > 0 ? ' · ' : '';
    project.description = (project.description + sep + proposal.description).slice(0, 500);
  }

  // Append fresh evidence refs (dedupe by source_id+quote).
  const seenEv = new Set(project.evidence_refs.map(evKey));
  for (const e of proposal.evidence_refs) {
    const k = evKey(e);
    if (seenEv.has(k)) continue;
    project.evidence_refs.push({ ...e });
    seenEv.add(k);
    if (project.evidence_refs.length >= 50) break; // cap
  }

  project.last_attributed_at = nowIso;
  project.status = 'active';
  project.resolution_log.push({
    at: nowIso,
    action,
    proposed_name: proposal.proposed_name,
    resolved_id: project.id,
    reason: reason.slice(0, 200)
  });
}

function evKey(e: EvidenceRef): string {
  return `${e.source}|${e.source_id}|${e.quote.slice(0, 60)}`;
}

function mintProject(
  proposal: ProjectProposal,
  working: ProjectEntity[],
  nowIso: string
): ProjectEntity {
  const taken = new Set(working.map((p) => p.id));
  const id = uniqueSlug(slugify(proposal.proposed_name), taken);
  const aliases = Array.from(
    new Set(
      [proposal.proposed_name, ...proposal.observed_surface_names]
        .map((s) => s.trim())
        .filter((s) => s.length > 0 && normalize(s) !== id)
    )
  );
  return {
    id,
    name: proposal.proposed_name.trim(),
    status: 'active',
    aliases,
    description: proposal.description.slice(0, 500),
    evidence_refs: proposal.evidence_refs.map((e) => ({ ...e })),
    observed_cwds: [],
    first_seen_at: nowIso,
    last_attributed_at: nowIso,
    resolution_log: [
      {
        at: nowIso,
        action: 'mint',
        proposed_name: proposal.proposed_name,
        resolved_id: id,
        reason: 'no match in registry; minted new id'
      }
    ],
    overrides: []
  };
}

// Used by `updateProjects(mutate)` to fold the resolver's `working` state
// back onto whatever's on disk. Sticky fields (id/name/first_seen_at) come
// from `existing`; everything additive merges.
function mergeEnrichmentsInPlace(existing: ProjectEntity, updated: ProjectEntity): void {
  const aliasKnown = new Set(existing.aliases.map(normalize));
  for (const a of updated.aliases) {
    if (!aliasKnown.has(normalize(a))) {
      existing.aliases.push(a);
      aliasKnown.add(normalize(a));
    }
  }
  const seenEv = new Set(existing.evidence_refs.map(evKey));
  for (const e of updated.evidence_refs) {
    const k = evKey(e);
    if (!seenEv.has(k)) {
      existing.evidence_refs.push(e);
      seenEv.add(k);
    }
  }
  if (existing.evidence_refs.length > 50) {
    existing.evidence_refs.length = 50;
  }
  const cwdKnown = new Set(existing.observed_cwds.map(normalize));
  for (const c of updated.observed_cwds) {
    if (!cwdKnown.has(normalize(c))) existing.observed_cwds.push(c);
  }
  if (updated.description && existing.description.length < 300) {
    existing.description = updated.description.slice(0, 500);
  }
  if (updated.last_attributed_at > existing.last_attributed_at) {
    existing.last_attributed_at = updated.last_attributed_at;
  }
  if (updated.status === 'active') existing.status = 'active';
  // Dedupe resolution_log entries. The working clone carries the on-disk log
  // by virtue of cloneProject; if we naively append, every batch doubles the
  // historical mint entries. Key on (at, action, proposed_name, resolved_id)
  // so legitimate new entries from this batch still land.
  const logKey = (r: ResolutionLogEntry): string =>
    `${r.at}|${r.action}|${r.proposed_name}|${r.resolved_id}`;
  const seenLog = new Set(existing.resolution_log.map(logKey));
  for (const r of updated.resolution_log) {
    const k = logKey(r);
    if (seenLog.has(k)) continue;
    seenLog.add(k);
    existing.resolution_log.push(r);
  }
  if (existing.resolution_log.length > 200) {
    existing.resolution_log = existing.resolution_log.slice(-200);
  }
}
