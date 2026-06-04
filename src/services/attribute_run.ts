// AgentRun → project attribution.
//
// Pure attribution module: given an already-built AgentRun plus the raw events
// of that one session, return a project attribution decision. No I/O of the
// session itself — caller passes the run + its events so this stays
// unit-testable and free of event-scan cost (agent_run.ts already holds the
// events in memory).
//
// Tries each signal in confidence order; FIRST that resolves wins. The hard
// rule is deterministic joins before fuzzy before LLM, and the safe direction
// is always `none`: a wrong attribution is worse than a null one, so EVERY tier
// abstains to null the moment it is uncertain (closed-set resolution,
// uniqueness/agreement requirements, deny-leaf reuse, evidence clamp).
//
// Reuses confirmed infra: lookupProjectByCwd / readProjects (src/lib/projects.ts),
// llmCall / tryParseJSON (src/lib/llm.ts). Builds its own repo/alias index from
// readProjects() so it does not depend on work_summary internals.

import { readProjects, lookupProjectByCwd } from '../lib/projects';
import { llmCall, tryParseJSON } from '../lib/llm';
import type { Event } from '../types/events';
import type { AgentRun } from '../lib/agent_run';
import type { ProjectEntity } from '../lib/projects';

export type AttributionMethod =
  | 'commit_repo_join' // deterministic: gh.commit_pushed.subject.ref -> project alias
  | 'pr_review_join' // deterministic: gh.pr_opened / gh.review_submitted.subject.ref -> project
  | 'cwd_leaf_repo' // deterministic: cwd's last path segment === a distinctive tracked repo name
  | 'cwd_exact' // deterministic: lookupProjectByCwd exact hit
  | 'cwd_prefix' // deterministic-ish: lookupProjectByCwd longest-prefix hit
  | 'quote_path_repo' // fuzzy: owner/repo or alias token mined from tool quote
  | 'llm_evidence' // last resort: llmCall over surviving quotes/branch
  | 'none'; // unresolved -> project_id stays null

export type AttributionConfidence = 'high' | 'medium' | 'low';

export interface AttributionResult {
  project_id: string | null;
  attribution_method: AttributionMethod;
  attribution_confidence: AttributionConfidence;
  // <=200 char citation of the surviving signal that resolved it (the quote,
  // the repo ref, the cwd). null when method==='none'. Stored for audit so a
  // human can spot a bad attribution.
  attribution_evidence: string | null;
}

export interface AttributeRunOptions {
  // The session's events (same array agent_run.ts already folded). Required for
  // commit/quote signals; cwd signal needs only run.cwd.
  events: Event[];
  // Cost gate for the LLM tier. LLM only fires when run.tool_calls >= this.
  // Default 8 (see signal_pipeline rank 5). Set Infinity to disable LLM tier.
  llmMinToolCalls?: number;
  // Hard cap on LLM calls per buildAgentRuns pass, enforced via a shared counter
  // passed by ref so the module stays stateless.
  llmBudgetRemaining?: { n: number };
  // injectable for tests
  nowMs?: number;
  signal?: AbortSignal;
  // Opt-in to the fuzzy quote-mining tier (RANK 5). Default off: an audit found
  // it net-negative (mostly wrong). Kept behind a flag for future re-enable.
  enableQuoteTier?: boolean;
}

// ATTRIBUTION_VERSION — bump whenever the signal pipeline changes (a new tier,
// a guardrail tweak, a prompt rewrite). agent_run.ts folds this into its cache
// marker so cached runs re-attribute under the new logic, mirroring
// work_summary's ATTRIBUTION_VERSION pattern (a stale cache entry that survives
// a logic change serves wrong attributions forever otherwise).
export const ATTRIBUTION_VERSION = 'v4';

// Reuse projects.ts's deny-leaf intent: a generic / shared / poisoned token
// adds zero binding signal and any project might transiently land in it. We
// keep a local copy (projects.ts does not export it) so quote-token binding and
// alias-leaf indexing both refuse these as binding tokens. Keep in sync with
// WRITEBACK_DENY_LEAVES in projects.ts.
const DENY_TOKENS = new Set([
  'tmp', 'temp', 'var', 'private', 'users', 'user', 'home', 'desktop', 'documents',
  'downloads', 'system32', 'projects', 'workspace', 'workspaces', 'src', 'public',
  '[redacted]', 'redacted', '.claude', '.codex', '.cursor', '.git', '.gstack',
  'worktrees', 'work', 'node_modules', 'dist', 'build', 'out', 'app', 'lib',
  'test', 'tests', 'docs', 'main', 'master', 'index', 'page', 'pages',
  'neuro', 'asus', 'zhangziyi', 'tianhaoxuan'
]);

function isDenyToken(t: string): boolean {
  const low = t.toLowerCase();
  if (DENY_TOKENS.has(low)) return true;
  if (/^\d{1,4}$/.test(low)) return true; // pure-digit
  if (low.length <= 1) return true;
  return false;
}

// Strip the org prefix from an `owner/repo` alias → the distinctive repo leaf
// ('anzy-renlab-ai/mypet' → 'mypet'). Lowercased.
function aliasLeaf(alias: string): string {
  const low = alias.toLowerCase().trim();
  const slash = low.lastIndexOf('/');
  return slash >= 0 ? low.slice(slash + 1) : low;
}

// Exposed for unit tests + reuse. Builds owner/repo + alias -> projectId index
// from readProjects(). Active projects only. Returns lowercased keys.
//
// Keys come from BOTH the alias 'owner/repo' (e.g. 'anzy-renlab-ai/mypet') and
// the evidence_refs source_id 'gh:owner/name' stripped to 'owner/name'. Both
// forms exist on disk (verified), and the commit event's subject.ref is the
// bare 'owner/name', so indexing both lets the commit join hit regardless of
// which surface a given project was registered from.
export async function buildRepoAliasIndex(): Promise<Map<string, string>> {
  const file = await readProjects();
  const idx = new Map<string, string>();
  for (const p of file.projects) {
    if (p.status !== 'active') continue;
    for (const a of p.aliases ?? []) {
      const low = a.toLowerCase().trim();
      if (low.includes('/')) idx.set(low, p.id); // 'owner/repo' form
    }
    for (const ref of p.evidence_refs ?? []) {
      const sid = ref.source_id?.toLowerCase().trim();
      if (sid && sid.startsWith('gh:')) idx.set(sid.slice(3), p.id); // 'owner/name'
    }
  }
  return idx;
}

// alias-leaf token -> projectId, but ONLY for leaves unique to one project.
// A leaf shared by >=2 projects, or a deny-token, is omitted entirely so it can
// never bind. Used by the quote-path tier as the set of DISTINCTIVE tokens.
export async function buildAliasTokenIndex(): Promise<Map<string, string>> {
  const file = await readProjects();
  const owners = new Map<string, Set<string>>(); // leaf -> set of projectIds
  const add = (leaf: string, id: string) => {
    if (!leaf || isDenyToken(leaf)) return;
    let s = owners.get(leaf);
    if (!s) owners.set(leaf, (s = new Set()));
    s.add(id);
  };
  for (const p of file.projects) {
    if (p.status !== 'active') continue;
    add(p.name.toLowerCase(), p.id);
    for (const a of p.aliases ?? []) add(aliasLeaf(a), p.id);
  }
  const idx = new Map<string, string>();
  for (const [leaf, ids] of owners) {
    if (ids.size === 1) idx.set(leaf, [...ids][0]); // unique → bindable
  }
  return idx;
}

function normalizeCwd(s: string): string {
  return s.trim().replace(/[\\/]+$/, '').toLowerCase();
}

// Last path segment of a cwd, lowercased — same form as buildAliasTokenIndex's
// keys (p.name.toLowerCase() / aliasLeaf). Splits on both separators so Windows
// (D:\lll\d2p) and POSIX (/Users/_/projects/pace) leaves resolve identically.
// Returns null for empty / drive-root cwds.
function cwdLeaf(cwd: string): string | null {
  const segs = normalizeCwd(cwd).split(/[\\/]+/).filter(Boolean);
  const leaf = segs[segs.length - 1];
  return leaf && leaf.length > 0 ? leaf : null;
}

// Re-derived copy of projects.ts's cwd→project affinity gate (not exported
// there). A cwd may bind to a project only if ANY of its path segments is one of
// that project's DISTINCTIVE name/alias-leaf tokens (deny-tokens excluded). Used
// as a guard on cwd attribution: the observed_cwds file was ~85% poisoned by
// pre-guard LLM writeback, so an "exact" hit on an unrelated dir (D:\renlab,
// C:\Users\neuro) must abstain. Mirrors projectBindingTokens/cwdBindsToProject
// in projects.ts so the read-side guard and the write-side gate agree.
function cwdBindsToProjectGuard(cwd: string, project: ProjectEntity): boolean {
  const tokens = new Set<string>();
  const addLeaf = (t: string) => {
    const low = t.toLowerCase().trim();
    if (low && !isDenyToken(low)) tokens.add(low);
  };
  addLeaf(project.name);
  for (const a of project.aliases ?? []) addLeaf(aliasLeaf(a));
  if (tokens.size === 0) return false;
  const norm = normalizeCwd(cwd);
  for (const seg of norm.split(/[\\/]+/).filter(Boolean)) {
    if (tokens.has(seg.toLowerCase())) return true;
  }
  return false;
}

// True when ANY active project (other than `selfId`) observed this exact cwd or
// has it as a prefix root — i.e. the matched observed_cwd is a parent dir shared
// by >=2 projects (the 'd:\hrdai' sibling trap). Used to drop ambiguous prefix
// hits to none.
function observedCwdIsSharedParent(
  projects: ProjectEntity[],
  observed: string,
  selfId: string
): boolean {
  const obsNorm = normalizeCwd(observed);
  let owners = 0;
  for (const p of projects) {
    if (p.status !== 'active') continue;
    for (const c of p.observed_cwds ?? []) {
      const cn = normalizeCwd(c);
      // Another project lives AT or UNDER this observed dir → it is a shared
      // parent, not a project-specific root.
      if (p.id !== selfId && (cn === obsNorm || cn.startsWith(obsNorm + '/') || cn.startsWith(obsNorm + '\\'))) {
        owners++;
        break;
      }
    }
  }
  return owners >= 1;
}

// Deterministic commit->repo->project join over this session's events.
// Looks at gh.commit_pushed events whose actor === run.operator (canonical name,
// already resolved by buildActorIndex) AND whose ts is within the run window
// [started_at, ended_at||now]. Maps subject.ref (owner/name) via repoIndex.
// Returns null unless ALL matched commits agree on exactly one project_id.
export function resolveByCommitRepo(
  run: AgentRun,
  events: Event[],
  repoIndex: Map<string, string>,
  nowMs: number
): { project_id: string; evidence: string } | null {
  const startMs = Date.parse(run.started_at);
  const endMs = run.ended_at ? Date.parse(run.ended_at) : nowMs;
  if (!Number.isFinite(startMs)) return null;

  const matched = new Set<string>(); // project_ids the commits map to
  let evidence = '';
  for (const e of events) {
    if (e.type !== 'gh.commit_pushed') continue;
    // ACTOR + WINDOW gate — a commit counts only if its resolved actor is this
    // run's operator and its push ts falls in the run window. Without this we
    // would cross-attribute another person's push that happened to land in the
    // same event slice.
    if (e.actor !== run.operator) continue;
    const tsMs = Date.parse(e.ts);
    if (!Number.isFinite(tsMs) || tsMs < startMs || tsMs > endMs) continue;
    const ref = e.subject?.ref?.toLowerCase().trim();
    if (!ref) continue;
    const pid = repoIndex.get(ref);
    if (!pid) continue; // commit to an untracked repo → no signal, skip
    matched.add(pid);
    if (!evidence) evidence = `commit ${e.subject.ref}`;
  }
  // AGREEMENT: every matched commit must point at exactly one project. Zero
  // matches OR disagreement → null (safe direction).
  if (matched.size !== 1) return null;
  return { project_id: [...matched][0], evidence: evidence.slice(0, 200) };
}

// Deterministic PR/review->repo->project join over this session's events.
// Looks at gh.pr_opened and gh.review_submitted events whose actor === run.operator
// (canonical name, already resolved by the github extractor's resolveOrUnknown)
// AND whose ts is within the run window [started_at, ended_at||now]. PR/review
// subject.ref is 'owner/repo#number'; we strip '#number' to the bare 'owner/repo'
// and map it via repoIndex. Returns null unless ALL matched events agree on
// exactly one project_id. Mirrors resolveByCommitRepo's actor+window gate and
// agreement rule — a slightly weaker signal (work-in-progress vs. pushed code)
// but equally deterministic, so it sits right below the commit tier.
export function resolveByPrReview(
  run: AgentRun,
  events: Event[],
  repoIndex: Map<string, string>,
  nowMs: number
): { project_id: string; evidence: string } | null {
  const startMs = Date.parse(run.started_at);
  const endMs = run.ended_at ? Date.parse(run.ended_at) : nowMs;
  if (!Number.isFinite(startMs)) return null;

  const matched = new Set<string>(); // project_ids the PR/review events map to
  let evidence = '';
  for (const e of events) {
    if (e.type !== 'gh.pr_opened' && e.type !== 'gh.review_submitted') continue;
    // ACTOR + WINDOW gate — a PR/review counts only if its resolved actor is this
    // run's operator and its ts falls in the run window. Bots (coderabbitai,
    // dependabot) are never the operator, so they drop out here.
    if (e.actor !== run.operator) continue;
    const tsMs = Date.parse(e.ts);
    if (!Number.isFinite(tsMs) || tsMs < startMs || tsMs > endMs) continue;
    // subject.ref is 'owner/repo#number' — strip '#number' to the bare repo ref.
    const ref = e.subject?.ref?.toLowerCase().trim();
    if (!ref) continue;
    const repoRef = ref.split('#')[0];
    if (!repoRef) continue;
    const pid = repoIndex.get(repoRef);
    if (!pid) continue; // PR/review on an untracked repo → no signal, skip
    matched.add(pid);
    if (!evidence) {
      const action = e.type === 'gh.pr_opened' ? 'opened PR' : 'reviewed PR';
      evidence = `${action} ${e.subject.ref}`;
    }
  }
  // AGREEMENT: every matched PR/review must point at exactly one project. Zero
  // matches OR disagreement → null (safe direction, mirrors commit_repo_join).
  if (matched.size !== 1) return null;
  return { project_id: [...matched][0], evidence: evidence.slice(0, 200) };
}

// Fuzzy: mine owner/repo refs and alias tokens from cc.tool_called evidence.quote
// of THIS session. Only resolves when a single project's alias/repo token appears
// and no competing project token appears (see guardrails). Returns null otherwise.
//
// medium confidence: a quoted path may be a file READ/grepped, not the repo
// worked — uniqueness across the WHOLE session (no competing project token
// anywhere) is what keeps the 'grep -r socialmind' read-not-done trap out.
export function resolveByQuotePath(
  events: Event[],
  repoIndex: Map<string, string>,
  aliasTokenIndex: Map<string, string>
): { project_id: string; evidence: string } | null {
  const implicated = new Set<string>(); // distinct project_ids seen
  let evidence = '';
  for (const e of events) {
    if (e.type !== 'cc.tool_called') continue;
    const quote = e.evidence?.quote;
    if (typeof quote !== 'string' || quote.length === 0) continue;
    const low = quote.toLowerCase();

    // (a) explicit 'owner/repo' substring matching a repoIndex key.
    for (const [key, pid] of repoIndex) {
      if (key.includes('/') && low.includes(key)) {
        implicated.add(pid);
        if (!evidence) evidence = `quote ref ${key}`;
      }
    }
    // (b) a DISTINCTIVE alias-leaf token (unique to one project, not generic).
    // Tokenize the quote on path / word separators and test each segment so we
    // bind on a real 'mypet' segment, never on a substring inside another word.
    for (const tok of low.split(/[^a-z0-9]+/)) {
      if (!tok || isDenyToken(tok)) continue;
      const pid = aliasTokenIndex.get(tok);
      if (pid) {
        implicated.add(pid);
        if (!evidence) evidence = `quote token "${tok}"`;
      }
    }
  }
  // UNIQUENESS: exactly one project implicated across all quotes AND no
  // competing project token anywhere → resolve. Else none.
  if (implicated.size !== 1) return null;
  return { project_id: [...implicated][0], evidence: evidence.slice(0, 200) };
}

// Re-derive cwd tier (exact vs prefix) since lookupProjectByCwd collapses both
// into one return. Returns the matched observed_cwd so the prefix guardrail can
// inspect whether it is a shared parent.
async function deriveCwdTier(
  cwd: string,
  projects: ProjectEntity[]
): Promise<{ project_id: string; tier: 'exact' | 'prefix'; observed: string } | null> {
  const norm = normalizeCwd(cwd);
  let exact: { id: string; observed: string } | null = null;
  const prefixHits: Array<{ id: string; observed: string }> = [];
  for (const p of projects) {
    if (p.status !== 'active') continue;
    for (const c of p.observed_cwds ?? []) {
      const cn = normalizeCwd(c);
      if (cn === norm) {
        exact = { id: p.id, observed: cn };
        break;
      }
      if (norm.startsWith(cn + '/') || norm.startsWith(cn + '\\')) {
        prefixHits.push({ id: p.id, observed: cn });
      }
    }
    if (exact) break;
  }
  if (exact) return { project_id: exact.id, tier: 'exact', observed: exact.observed };
  if (prefixHits.length === 0) return null;
  // longest-prefix wins (matches lookupProjectByCwd ordering)
  prefixHits.sort((a, b) => b.observed.length - a.observed.length);
  const top = prefixHits[0];
  return { project_id: top.id, tier: 'prefix', observed: top.observed };
}

const LLM_SYSTEM =
  'You attribute a Claude Code coding session to exactly one tracked project, ' +
  'or answer "unclear". You are given a CLOSED registry of projects and a set ' +
  'of surviving file-path / branch signals from the session. ' +
  'Rules: (1) The project_id MUST be one of the registry ids verbatim, else ' +
  'answer "unclear". (2) Attribute to the repo the session EDITED or EXECUTED ' +
  'in, NOT a file that was merely grepped, read, or referenced. (3) Ignore ' +
  'branch names as weak signals. (4) If the signals are ambiguous or point at ' +
  'no registry project, answer "unclear". Reply with JSON only: ' +
  '{"project_id": "<id>"|"unclear", "evidence": "<=200 char citation of the ' +
  'exact input signal that decided it>"}.';

// LLM tier (cost-bounded last resort). Builds the closed registry label set
// + up to ~30 deduped surviving signals, calls llmCall, then CLAMPS the output:
// the id must be an exact active-registry id AND the cited evidence must be a
// substring of an actual input signal (anti-hallucination, mirrors
// work_summary clampAttributionEvidence). Anything else → none.
async function resolveByLLM(
  run: AgentRun,
  events: Event[],
  projects: ProjectEntity[],
  opts: AttributeRunOptions
): Promise<{ project_id: string; evidence: string } | null> {
  const active = projects.filter((p) => p.status === 'active');
  if (active.length === 0) return null;

  // Surviving signals: deduped tool-call quotes (recent first) + branch.
  const signals: string[] = [];
  const seen = new Set<string>();
  for (let i = events.length - 1; i >= 0 && signals.length < 30; i--) {
    const e = events[i];
    if (e.type !== 'cc.tool_called') continue;
    const q = e.evidence?.quote;
    if (typeof q !== 'string' || q.length === 0) continue;
    const trimmed = q.slice(0, 200);
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    signals.push(trimmed);
  }
  if (run.branch) signals.push(`branch: ${run.branch}`);
  if (signals.length === 0) return null;

  const registryLines = active.map((p) => {
    const leaves = [p.name.toLowerCase(), ...(p.aliases ?? []).map(aliasLeaf)]
      .filter((t) => !isDenyToken(t));
    const desc = p.description ? ` — ${p.description.slice(0, 120)}` : '';
    return `- id=${p.id}  aliases=${[...new Set(leaves)].slice(0, 6).join(',')}${desc}`;
  });

  const user =
    `PROJECT REGISTRY (closed set, attribute to one id or "unclear"):\n` +
    registryLines.join('\n') +
    `\n\nSESSION SIGNALS (file paths edited/read, branch):\n` +
    signals.map((s) => `  • ${s}`).join('\n');

  let raw: string;
  try {
    raw = await llmCall({
      system: LLM_SYSTEM,
      user,
      jsonMode: true,
      temperature: 0,
      seed: 7,
      maxTokens: 256,
      signal: opts.signal
    });
  } catch (err) {
    // Never throw on LLM failure — degrade to none (caller already has best
    // deterministic result, which here is none since LLM is the last tier).
    if (err instanceof Error && err.name === 'AbortError') throw err;
    return null;
  }

  const parsed = tryParseJSON<{ project_id?: unknown; evidence?: unknown }>(raw);
  if (!parsed) return null;
  const pid = typeof parsed.project_id === 'string' ? parsed.project_id.trim() : '';
  if (!pid || pid === 'unclear') return null;
  // CLOSED-SET clamp: id must be a live active registry id, never minted.
  const activeIds = new Set(active.map((p) => p.id));
  if (!activeIds.has(pid)) return null;
  // EVIDENCE clamp: cited evidence must be a substring of an actual input
  // signal, else force none (anti-hallucination).
  const evid = typeof parsed.evidence === 'string' ? parsed.evidence.trim().slice(0, 200) : '';
  if (!evid) return null;
  const evidLow = evid.toLowerCase();
  const grounded = signals.some(
    (s) => s.toLowerCase().includes(evidLow) || evidLow.includes(s.toLowerCase())
  );
  if (!grounded) return null;
  return { project_id: pid, evidence: evid };
}

// Main entry. Tries each signal in confidence order; FIRST that resolves wins.
// Never throws on LLM failure — degrades to the best deterministic result or
// none.
export async function attributeRun(
  run: AgentRun,
  opts: AttributeRunOptions
): Promise<AttributionResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const events = opts.events ?? [];
  const file = await readProjects();
  const projects = file.projects;
  const repoIndex = await buildRepoAliasIndex();

  // RANK 1 — commit -> repo -> project deterministic join (ground truth).
  const commit = resolveByCommitRepo(run, events, repoIndex, nowMs);
  if (commit) {
    return {
      project_id: commit.project_id,
      attribution_method: 'commit_repo_join',
      attribution_confidence: 'high',
      attribution_evidence: commit.evidence
    };
  }

  // RANK 2 — PR/review -> repo -> project deterministic join. Same actor+window
  // gate and agreement rule as commits, slightly weaker signal (work-in-progress
  // vs. pushed code) so it runs right after the commit tier. Still HIGH: the
  // owner/repo→project map is ground truth and the actor+window+agreement guards
  // make a wrong attribution near-impossible.
  const prReview = resolveByPrReview(run, events, repoIndex, nowMs);
  if (prReview) {
    return {
      project_id: prReview.project_id,
      attribution_method: 'pr_review_join',
      attribution_confidence: 'high',
      attribution_evidence: prReview.evidence
    };
  }

  // RANK 2.5 — cwd LEAF === a distinctive tracked repo name (deterministic).
  // The single strongest cwd signal now that the collector no longer redacts
  // cwd: a session working in `…/d2p` or `C:\Users\_\projects\Pace` has a leaf
  // that IS the repo name. We map it via buildAliasTokenIndex, which holds only
  // leaf tokens UNIQUE to one active project (shared/deny leaves are omitted),
  // so a leaf hit can't collide across projects — hence HIGH confidence. Unlike
  // cwd_exact/cwd_prefix this needs no observed_cwds (which were poisoned), so
  // it works the moment real cwd flows in. Skips redacted cwds.
  if (run.cwd && !run.cwd.includes('[redacted]')) {
    const leaf = cwdLeaf(run.cwd);
    if (leaf) {
      const aliasTokenIndex = await buildAliasTokenIndex();
      const pid = aliasTokenIndex.get(leaf);
      if (pid) {
        return {
          project_id: pid,
          attribution_method: 'cwd_leaf_repo',
          attribution_confidence: 'high',
          attribution_evidence: `cwd leaf "${leaf}" === tracked repo`.slice(0, 200)
        };
      }
    }
  }

  // RANK 3 + 4 — cwd exact (medium) / longest-prefix (low). Skip entirely when
  // the cwd is redacted or a deny-leaf (partial-redaction poison). Confidence is
  // DOWNGRADED from the old high/medium: observed_cwds were ~85% poisoned by
  // pre-guard LLM writeback (unrelated personal dirs, shared parents, home-dir
  // roots), so even an "exact" cwd hit is only as trustworthy as the binding
  // that put the cwd there. The extra guard predicates below (cwdBindsToProject
  // re-check + shared-parent + home-root) make a poisoned match ABSTAIN to none
  // rather than mis-attribute.
  if (run.cwd && !run.cwd.includes('[redacted]')) {
    const tier = await deriveCwdTier(run.cwd, projects);
    if (tier) {
      // GUARD A — the matched observed_cwd must itself still bind to the project
      // (a path segment that is one of the project's distinctive name/alias
      // tokens). A poisoned cwd (D:\renlab, C:\Users\neuro) shares no such token
      // and is rejected here, regardless of exact/prefix tier.
      const self = projects.find((p) => p.id === tier.project_id);
      const bound = self ? cwdBindsToProjectGuard(tier.observed, self) : false;
      // GUARD B — home-directory roots (C:\Users\X) are never a project root.
      const homeRoot = /^[a-z]:[\\/]users[\\/][^\\/]+$/.test(normalizeCwd(tier.observed));
      if (bound && !homeRoot) {
        if (tier.tier === 'exact') {
          // Cross-check the existing fn agrees (recency tiebreak safety, etc.).
          const looked = await lookupProjectByCwd(run.cwd);
          if (looked === tier.project_id) {
            return {
              project_id: tier.project_id,
              attribution_method: 'cwd_exact',
              attribution_confidence: 'medium',
              attribution_evidence: `cwd ${run.cwd}`.slice(0, 200)
            };
          }
        } else {
          // prefix tier — GUARDRAIL: drop to none if the matched observed_cwd is a
          // parent dir shared by >=2 active projects (the 'd:\hrdai' sibling trap).
          const shared = observedCwdIsSharedParent(projects, tier.observed, tier.project_id);
          if (!shared) {
            const looked = await lookupProjectByCwd(run.cwd);
            // Inherit lookupProjectByCwd's recency-tie→null safety: only accept
            // when it lands on the same id we derived.
            if (looked === tier.project_id) {
              return {
                project_id: tier.project_id,
                attribution_method: 'cwd_prefix',
                attribution_confidence: 'low',
                attribution_evidence: `cwd ${run.cwd}`.slice(0, 200)
              };
            }
          }
        }
      }
    }
  }

  // RANK 5 — repo/alias token mined from surviving tool-call quotes (fuzzy).
  // DISABLED by default: an adversarial precision audit found this tier was
  // net-negative — 12/16 of its attributions were WRONG (a quoted file path is
  // often a file READ/grepped, not the repo being worked, and a bare alias
  // token over-matches). A wrong attribution is worse than null. The function
  // is kept (it may return with stronger guards later) but only fires when
  // explicitly opted in via opts.enableQuoteTier.
  if (opts.enableQuoteTier) {
    const aliasTokenIndex = await buildAliasTokenIndex();
    const quote = resolveByQuotePath(events, repoIndex, aliasTokenIndex);
    if (quote) {
      return {
        project_id: quote.project_id,
        attribution_method: 'quote_path_repo',
        attribution_confidence: 'low',
        attribution_evidence: quote.evidence
      };
    }
  }

  // RANK 6 — LLM over surviving evidence (cost-bounded last resort). Fires ONLY
  // when all above returned none AND tool_calls >= gate AND budget remains.
  const minToolCalls = opts.llmMinToolCalls ?? 8;
  const budget = opts.llmBudgetRemaining;
  if (run.tool_calls >= minToolCalls && (!budget || budget.n > 0)) {
    const llm = await resolveByLLM(run, events, projects, opts);
    // Decrement budget regardless of outcome — the call was spent.
    if (budget) budget.n--;
    if (llm) {
      return {
        project_id: llm.project_id,
        attribution_method: 'llm_evidence',
        attribution_confidence: 'low',
        attribution_evidence: llm.evidence
      };
    }
  }

  // Nothing resolved → null BY DESIGN (the intended safe-failure floor).
  return {
    project_id: null,
    attribution_method: 'none',
    attribution_confidence: 'low',
    attribution_evidence: null
  };
}
