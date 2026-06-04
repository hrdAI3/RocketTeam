// "What is this person's Claude Code working on" — a structured, system-built
// digest read off the raw event stream (sessions, tool calls, Bash commands,
// stuck signals, commits, PRs, meeting action items) + the live snapshot.
//
// The model returns an itemized JSON breakdown: a one-line headline (used on the
// /status roster) plus a list of work threads, each tagged with the repo and a
// status (进行中 / 卡住 / 已完成). The per-agent detail page renders the
// items grouped by repo; the roster shows just the headline.
//
// LLM cost: one call per data change, cached by a (newest-event-ts | live-ts)
// marker. Fetched lazily by the detail page; on a model outage we serve the
// last cached value (marked stale) or hide the section entirely.

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { readAllEvents } from '../lib/events';
import { PATHS } from '../lib/paths';
import { llmCall, stripThinkBlocks } from '../lib/llm';
import { getLiveStatusForName } from './live_cc';
import {
  readProjects,
  projectsHash,
  recordObservedCwdsBatch,
  type ProjectEntity
} from '../lib/projects';
import { loadProjectKnowledge, type ProjectKnowledgeEntry } from '../lib/project_knowledge';
import { buildActorIndex } from '../lib/team_roster';
import type { Event } from '../types/events';

const CACHE_FILE = join(PATHS.root, 'cc_summary_cache.json');
const DAY_MS = 24 * 60 * 60 * 1000;
const LOOKBACK_MS = 7 * DAY_MS;

// Status enum simplified per leader direction: "调研中" collapses into "进行中".
// Only 3 states ship to the UI: 卡住 / 进行中 / 已完成. Legacy cached items
// emitted by the LLM with status="调研中" are coerced to "进行中" in parseSummary.
export type WorkItemStatus = '进行中' | '卡住' | '已完成';
const STATUS_SET = new Set<WorkItemStatus>(['进行中', '卡住', '已完成']);
const STATUS_RANK: Record<WorkItemStatus, number> = { 卡住: 0, 进行中: 1, 已完成: 2 };

export interface WorkItem {
  title: string; // ≤~14 汉字 — the thread
  repo: string; // short repo / project name, or '' if unknown
  status: WorkItemStatus;
  detail: string; // one or two sentences — what changed / where stuck / next step
  // §3.3 attribution — LLM-constrained to {registry id} ∪ "new:<name>" ∪ "unclear".
  // parseSummary downgrades projectId → "unclear" if attribution_evidence is missing
  // (§0.5 discipline 2). Optional on the interface so legacy cached entries still type.
  projectId?: string;
  attribution_evidence?: string; // ≤200 chars, evidence quote justifying the projectId
}

export interface WorkSummary {
  headline: string; // ≤~16 汉字, name-free — the roster one-liner
  items: WorkItem[]; // 卡住 first, then 进行中, 已完成 last; ≤8
  generatedAt: string;
  stale?: boolean; // true if the LLM was unreachable and this is a prior cached value
}

interface CacheEntry {
  marker: string;
  headline: string;
  items: WorkItem[];
  generatedAt: string;
  // ISO of the last LLM-down fallback service. Set when getWorkSummary
  // returned this entry with stale=true. Cleared when a fresh LLM call
  // succeeds. workboard.ts surfaces a `degraded: 'llm-stale'` banner when
  // any cached entry has staleAt within the recent window.
  staleAt?: string;
}
type CacheFile = Record<string, CacheEntry>;

async function readCache(): Promise<CacheFile> {
  try {
    return JSON.parse(await fs.readFile(CACHE_FILE, 'utf8')) as CacheFile;
  } catch {
    return {};
  }
}
async function writeCache(c: CacheFile): Promise<void> {
  try {
    await fs.writeFile(CACHE_FILE, JSON.stringify(c, null, 2), 'utf8');
  } catch {
    // best-effort cache; a write failure just means we recompute next time
  }
}

const SYSTEM = `You are the leader's assistant. Given a team member's Claude Code activity over the last 7 days (sessions, tool calls, bash commands, stuck signals, commits, PRs, meeting action items) plus a live snapshot (repo, branch, context usage, current hook), produce a per-thread, grouped-by-status work list.

Output ONE JSON object only — no markdown, no commentary, no code fences:
{
  "headline": "<one phrase, ≤ 12 English words, what they're doing this week. No name, no period. Skimmable at a glance.>",
  "items": [
    {
      "title": "<short noun phrase, ≤ 10 English words, names the work thread>",
      "repo": "<repo / project short name (e.g. TeamBrain); empty string \\"\\" if unclear from data>",
      "status": "<exactly one of: 进行中 / 卡住 / 已完成   (internal status enum — keep as Chinese tokens; the UI maps to In progress / Blocked / Done)>",
      "detail": "<1–2 English sentences. Concrete: which files changed / where they're stuck / what's next. Only cite the supplied events, never invent.>",
      "projectId": "<must be one of: an id from the 'project registry' below; OR \\"new:<proposed-slug>\\" for genuinely new work; OR \\"unclear\\" when you can't tell>",
      "attribution_evidence": "<≤ 200 chars, quote a real event / cwd / file path. If you have no quotable evidence, set projectId to \\"unclear\\" — don't fake it.>"
    }
  ]
}

Output language: ENGLISH for headline / title / detail / attribution_evidence. We ship to a global audience; do not produce Chinese strings even if the source events are mostly Chinese — translate concisely. Keep proper nouns (repo names, branch names, library names) in their original form.

Rules:
- Sort items by urgency — Blocked first, In progress next, Done last (max 2 done items). ≤ 8 items total.
- Multiple threads for the same repo are fine (same repo field; the UI groups them).
- Cite only the supplied data. Don't fabricate progress percentages, deadlines, or state words. If a thread is uncertain, set status to "进行中" and write "data insufficient to judge" in detail.
- **Don't return "data insufficient" lazily.** Only return {"headline":"data insufficient","items":[]} when total tool_called events ≤ 3 in 7d AND no session-start events. Even when cwd is all [redacted] / system dirs, even when only WebFetch / Write / Task* tools were used (no coding), you MUST summarize the work patterns as items (projectId="unclear", repo="", title describes the tool behavior like "Web research crawl", "Doc drafting", "TodoWrite task planning"). The leader needs to see SOMETHING for every active member.
- detail is plain prose. No field-name echo. No markdown.
- projectId multi-signal rule (**one project = one GitHub repo**; need ≥ 2 of these 4 signals to fix a projectId; a single signal is not enough):
  ① **Work text** — detail / event quote names an owner/repo (e.g. "hrdAI3/RocketTeam", "libz-renlab-ai/TeamBrain"), a git remote, PR / Issue number, or a commit hash that maps to a repo → very strong signal.
  ② **Member's recent GH activity** — has this member committed / PR'd / issued on that repo recently? (Look at source=github events or repo names in file paths.) If the work text says X but the member never touched X repo → downgrade or use new:.
  ③ **Work semantics** — do the changed files / bash commands / tool calls match that repo's GH About description?
  ④ **cwd segments** — path segments matching the registry's cwd-leaf samples / team aliases (lowest-priority signal). **Ignore cwd=[redacted]. Ignore cwd=tmp/var/private and similar system dirs.**
  - ①+② both hit → must use that projectId. Don't use unclear.
  - ① or ② alone + ③ consistent → use that projectId.
  - Only ④ hits (and ①②③ missing or contradictory) → use unclear. cwd alone is unreliable.
  - Clearly new direction with no matching registry repo → \\"new:<proposed-slug>\\" (kebab-case, matching existing GH repo naming style).
  - Member has no GH activity / cwd=[redacted] / work text doesn't name a repo → unclear. Don't guess.
- **Anti-aggressive matching**: literal word overlap ≠ same project. E.g. "romantic matching"/心动 is NOT social-intelligence (the registry's "Social World Model" project). A "Maya article" is NOT the Maya OS project. Decide "same semantic" by "doing the same thing", not "shares a token".
- Every non-unclear projectId needs attribution_evidence (≤ 200 chars). Quote real text from events / cwd / file paths. Don't invent.
- **Don't lean on cwd alone**. One project = one GitHub repo. Attribute by combining: ① the work conversation itself (commit msg / PR / file paths / tool calls) ② the member's GH repo history ③ slack channel ④ cwd (last priority; ignore cwd=[redacted]). Need multi-source corroboration; if cwd alone hits but ②③ contradict, take ②③.`;

function clampHeadline(s: string): string {
  let t = String(s).replace(/\*\*|__|`|^#{1,6}\s+/g, '').replace(/[。.\s]+$/, '').trim();
  // Models love to answer "≤16 汉字" with a comma list — the headline should be
  // one phrase, so if it lists clauses, keep just the first.
  const seg = t.search(/[、，]/);
  if (seg >= 6 && seg <= 36) t = t.slice(0, seg).trim();
  if (t.length <= 42) return t;
  const sub = t.slice(0, 42);
  const sp = sub.lastIndexOf(' ');
  return `${sp > 20 ? sub.slice(0, sp) : sub}…`;
}
function clampTitle(s: string): string {
  const t = String(s).replace(/\*\*|__|`/g, '').replace(/[。.\s]+$/, '').trim();
  return t.length <= 28 ? t : `${t.slice(0, 28)}…`;
}
function cleanDetail(s: string): string {
  return String(s).replace(/\*\*|__/g, '').replace(/`([^`]+)`/g, '$1').replace(/\s+/g, ' ').trim();
}
function shortRepo(s: unknown): string {
  if (typeof s !== 'string') return '';
  const t = s.trim();
  if (!t) return '';
  // If they passed a path ("D:/TeamBrain", ".../TeamBrain/.claude/..."), take a
  // sensible leaf.
  const parts = t.split(/[\\/]+/).filter(Boolean);
  if (parts.length <= 1) return t.slice(0, 28);
  const markerIdx = parts.findIndex((p) => p === '.claude' || p === '.codex' || p === 'worktrees');
  const leaf = markerIdx > 0 ? parts[markerIdx - 1] : parts[parts.length - 1];
  return (leaf ?? t).slice(0, 28);
}

// §3.3 attribution evidence clamp. Mirrors clampTitle / cleanDetail style.
// ≤200 chars, no markdown, single-line. Empty → empty (caller downgrades the
// item's projectId to "unclear" per §0.5 discipline 2).
function clampAttributionEvidence(s: unknown): string {
  if (typeof s !== 'string') return '';
  const t = s.replace(/\*\*|__/g, '').replace(/`([^`]+)`/g, '$1').replace(/\s+/g, ' ').trim();
  return t.length <= 200 ? t : t.slice(0, 200);
}

// Constrain projectId per §0.5 discipline 1: only {registry id} ∪ "new:<name>"
// ∪ "unclear" allowed. Anything else gets regularized to "unclear". An empty
// or missing attribution_evidence also forces "unclear" — no rationale, no
// attribution.
//
// Deterministic alias rescue: if the LLM emits `new:Pace` but `Pace` already
// matches a registered alias (case-insensitive, slug-form), we coerce it back
// to the registered id. The LLM shouldn't be allowed to "propose a new
// project" when one with that exact name already exists in the registry.
function constrainProjectId(
  raw: unknown,
  evidence: string,
  registry: Set<string>,
  aliasIndex: Map<string, string>
): { projectId: string; evidence: string } {
  if (!evidence) return { projectId: 'unclear', evidence: '' };
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return { projectId: 'unclear', evidence };
  if (s === 'unclear') return { projectId: 'unclear', evidence: '' };
  if (s.startsWith('new:')) {
    const proposed = s.slice(4).trim();
    if (proposed.length === 0 || proposed.length > 60) {
      return { projectId: 'unclear', evidence: '' };
    }
    const rescued = lookupAliasId(proposed, aliasIndex);
    if (rescued) return { projectId: rescued, evidence };
    return { projectId: `new:${proposed}`, evidence };
  }
  if (registry.has(s)) return { projectId: s, evidence };
  // Maybe the LLM emitted a name instead of the registered id (e.g. "Pace"
  // rather than "pace"). Try the alias index as a last-resort rescue.
  const rescued = lookupAliasId(s, aliasIndex);
  if (rescued) return { projectId: rescued, evidence };
  return { projectId: 'unclear', evidence: '' };
}

function normalizeForAlias(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[\s_/\\]+/g, '-')
    .replace(/[^a-z0-9-]+/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function lookupAliasId(s: string, aliasIndex: Map<string, string>): string | null {
  const direct = aliasIndex.get(s.toLowerCase().trim());
  if (direct) return direct;
  const slug = normalizeForAlias(s);
  return aliasIndex.get(slug) ?? null;
}

// Pull the first balanced-ish JSON object out of arbitrary model text (M2.7 may
// prepend reasoning even with json mode; defensive).
function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
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
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function parseSummary(
  raw: string,
  registryIds: Set<string>,
  aliasIndex: Map<string, string>
): { headline: string; items: WorkItem[] } | null {
  const text = stripThinkBlocks(raw).trim();
  const jsonStr = extractJsonObject(text);
  if (!jsonStr) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(jsonStr);
  } catch {
    return null;
  }
  if (typeof obj !== 'object' || obj === null) return null;
  const o = obj as Record<string, unknown>;
  const headline = clampHeadline(typeof o.headline === 'string' ? o.headline : '');
  const rawItems = Array.isArray(o.items) ? o.items : [];
  const items: WorkItem[] = [];
  for (const it of rawItems) {
    if (typeof it !== 'object' || it === null) continue;
    const r = it as Record<string, unknown>;
    const title = clampTitle(typeof r.title === 'string' ? r.title : '');
    const detail = cleanDetail(typeof r.detail === 'string' ? r.detail : '');
    if (!title && !detail) continue;
    // Coerce: any legacy "调研中" or unknown LLM output → 进行中. STATUS_SET no
    // longer contains 调研中, so this also catches it.
    const rawStatus = typeof r.status === 'string' ? r.status : '';
    const status: WorkItemStatus = STATUS_SET.has(rawStatus as WorkItemStatus)
      ? (rawStatus as WorkItemStatus)
      : '进行中';
    // §0.5 discipline 1 + 2 enforced here, not in the prompt. LLM can return
    // anything; this gate is what makes the contract real.
    const evidence = clampAttributionEvidence(r.attribution_evidence);
    const { projectId, evidence: keptEvidence } = constrainProjectId(
      r.projectId,
      evidence,
      registryIds,
      aliasIndex
    );
    items.push({
      title: title || detail.slice(0, 20),
      repo: shortRepo(r.repo),
      status,
      detail,
      projectId,
      attribution_evidence: keptEvidence
    });
  }
  // Stable sort by status rank (卡住 → 进行中 → 已完成), preserving the
  // model's intra-status ordering. Cap 已完成 at 2, total at 8.
  items.sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status]);
  let doneSeen = 0;
  const trimmed = items.filter((it) => (it.status === '已完成' ? ++doneSeen <= 2 : true)).slice(0, 8);
  if (!headline && trimmed.length === 0) return null;
  return { headline: headline || '数据不足', items: trimmed };
}

interface AgentSlice {
  events: Event[];
  latestTs: string | null;
}

function sliceForAgent(all: Event[], name: string, actorIndex: Map<string, string>): AgentSlice {
  const cutoff = Date.now() - LOOKBACK_MS;
  const rel = all.filter((e) => {
    const t = Date.parse(e.ts);
    if (Number.isNaN(t) || t < cutoff) return false;
    if (e.subject.kind === 'agent' && e.subject.ref === name) return true;
    if (e.actor === name) return true;
    // Fold raw / unknown:* actor strings (baked in before the roster knew the
    // identifier) back to the canonical name via the actor index.
    if (typeof e.actor === 'string' && actorIndex.get(e.actor.toLowerCase()) === name) return true;
    return false;
  });
  rel.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const latestTs = rel.length > 0 ? rel[rel.length - 1].ts : null;
  return { events: rel, latestTs };
}

// Registry block fed to the LLM. Three sources stitched together:
//   1. canonical registry (projects.json): id, GH-repo name, aliases, GH About
//   2. curated knowledge overlay (project_knowledge.json): team-natural name
//      (Maya / Matrix / TeamBrain / modelForecast / neuro), synopsis, owners,
//      contributors, related_topics — only present for hand-blessed projects
//   3. observed_cwds — best leaf hints (post-deny-list, see DENY_LEAF below).
//
// Without (2), the LLM only sees GH names (`agent-game-platform`) and has no
// way to know the team calls it "Maya". Mis-attribution at scale is the
// result. Format gives the LLM the team-natural name FIRST so it's the
// salient match key.
function buildRegistryPrompt(
  projects: ProjectEntity[],
  knowledge: Record<string, ProjectKnowledgeEntry>
): string {
  if (projects.length === 0) return '（登记表为空。所有 projectId 应该是 "unclear" 或 "new:..."。）';
  // Pre-compute lowercase curated alias → knownName index so we can detect
  // which registry rows belong to which curated project.
  const curatedHitsForProject = (p: ProjectEntity): string | null => {
    const keys: string[] = [p.name.toLowerCase(), ...(p.aliases ?? []).map((s) => s.toLowerCase())];
    for (const cwd of p.observed_cwds ?? []) {
      const leaf = leafOf(cwd);
      if (leaf) keys.push(leaf.toLowerCase());
    }
    for (const [knownName, entry] of Object.entries(knowledge)) {
      const knownAliases = new Set<string>([knownName.toLowerCase(), ...(entry.aliases ?? []).map((s) => s.toLowerCase())]);
      if (keys.some((k) => knownAliases.has(k))) return knownName;
    }
    return null;
  };
  const lines: string[] = [];
  for (const p of projects) {
    if (p.status === 'archived') continue;
    const known = curatedHitsForProject(p);
    const aliasPart = p.aliases.length > 0 ? ` GH-aliases=${p.aliases.slice(0, 6).join(',')}` : '';
    if (known) {
      const entry = knowledge[known];
      // Team-natural name leads — that's how people refer to the project.
      lines.push(`- id=${p.id}  团队叫法="${known}"  GH-name=${p.name}${aliasPart}`);
      if (entry.synopsis) lines.push(`  团队描述: ${entry.synopsis.slice(0, 240)}`);
      if (entry.aliases?.length) lines.push(`  团队别名: ${entry.aliases.join(' | ')}`);
      if (entry.owners?.length) lines.push(`  owner: ${entry.owners.join(', ')}`);
    } else {
      lines.push(`- id=${p.id} name=${p.name}${aliasPart}`);
      if (p.description) lines.push(`  描述: ${p.description.slice(0, 240)}`);
    }
    const cleanCwds = (p.observed_cwds ?? [])
      .map(leafOf)
      .filter((l): l is string => !!l && !isDenyLeaf(l))
      .slice(0, 5);
    if (cleanCwds.length > 0) lines.push(`  cwd 叶子样本: ${cleanCwds.join(' | ')}`);
  }
  return lines.join('\n');
}

// §C — deterministic cwd-segment → canonical registry id. Used to pin
// projectId before LLM scoring. Match priority:
//   1. Exact lowercase match against canonical name / aliases.
//   2. Exact lowercase match against curated knownName / curated aliases —
//      then mapped to the canonical row whose name/aliases/cwd-leaves
//      overlap with curated's alias set (same join as buildRegistryPrompt).
// First hit wins. Misses (the seg names a real project but neither registry
// nor curated knows about it yet) are dropped — better silent than wrong.
function resolveCwdSegToProjectIds(
  segs: string[],
  registry: ProjectEntity[],
  knowledge: Record<string, ProjectKnowledgeEntry>
): Map<string, string> {
  const out = new Map<string, string>();
  // pass 1 — canonical
  const canonicalIdx = new Map<string, string>();
  for (const p of registry) {
    if (p.status === 'archived') continue;
    canonicalIdx.set(p.name.toLowerCase(), p.id);
    for (const a of p.aliases ?? []) canonicalIdx.set(a.toLowerCase(), p.id);
  }
  // pass 2 — curated knownName → canonical id (first overlapping canonical)
  const curatedIdx = new Map<string, string>();
  for (const [knownName, entry] of Object.entries(knowledge)) {
    const curatedAliases = new Set<string>([knownName.toLowerCase(), ...(entry.aliases ?? []).map((s) => s.toLowerCase())]);
    let targetId: string | null = null;
    for (const p of registry) {
      if (p.status === 'archived') continue;
      const candidate = new Set<string>([p.name.toLowerCase(), ...(p.aliases ?? []).map((s) => s.toLowerCase())]);
      for (const cwd of p.observed_cwds ?? []) {
        const lf = leafOf(cwd);
        if (lf) candidate.add(lf.toLowerCase());
      }
      let overlap = 0;
      for (const k of candidate) if (curatedAliases.has(k)) overlap++;
      if (overlap > 0) { targetId = p.id; break; }
    }
    if (!targetId) continue;
    for (const a of curatedAliases) curatedIdx.set(a, targetId);
  }
  // pass 3 — knowledge entry that doesn't bind to ANY registry row → surface
  // as `new:<knownName>`. Without this, an agent like 黄运樟 whose cwd leaves
  // are all `Maya0` / `maya内容生产` (a real project, just not in registry
  // because nobody registered the GitHub repo yet) gets resolved to nothing
  // → the LLM grabs the most-similar-looking tracked id (`agent-game-platform`
  // because "Agent" appears in its description) → wrong project forever. By
  // emitting `new:Maya` here, the work routes through the untracked-project
  // rollup instead.
  const knowledgeOnlyIdx = new Map<string, string>();
  for (const [knownName, entry] of Object.entries(knowledge)) {
    const aliases = new Set<string>([knownName.toLowerCase(), ...(entry.aliases ?? []).map((s) => s.toLowerCase())]);
    // Skip if this knowledge entry DID bind to a registry row in pass 2.
    let bound = false;
    for (const a of aliases) if (curatedIdx.has(a)) { bound = true; break; }
    if (bound) continue;
    for (const a of aliases) knowledgeOnlyIdx.set(a, `new:${knownName}`);
  }
  for (const seg of segs) {
    const low = seg.toLowerCase();
    const hit = canonicalIdx.get(low) ?? curatedIdx.get(low) ?? knowledgeOnlyIdx.get(low);
    if (hit) out.set(seg, hit);
  }
  return out;
}

// Extracted: take a cwd path like "D:\hrdai\team" → "team". Used by both the
// registry prompt builder and the observed_cwds deny-filter.
function leafOf(p: string): string | null {
  if (!p) return null;
  const norm = String(p).replace(/\\/g, '/').replace(/^[A-Za-z]:/, '');
  const parts = norm.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? null;
}

// Deny-list for cwd writeback (§3.5) and registry-prompt cwd samples.
// Generic system / scratch / personal-home leaves that, if attributed to a
// registry project's observed_cwds, would corrupt future cwd→project lookups.
// Anything matching one of these patterns is dropped at write time and not
// shown to the LLM as a project's "binding cwd sample".
const DENY_LEAF_LITERAL = new Set(
  [
    'tmp', 'temp', 'var', 'private', 'users', 'user', 'home', 'desktop', 'documents',
    'downloads', 'system32', 'projects', 'workspace', 'workspaces', 'src', 'public',
    '[redacted]', 'redacted', '.claude', '.codex', '.cursor', '.git', '.gstack',
    'worktrees', 'work', 'node_modules', 'dist', 'build', 'out',
    'neuro', 'asus', 'zhangziyi', 'tianhaoxuan' // Windows usernames (C:\Users\X), not projects
  ]
);
const DENY_LEAF_PATTERN = [
  /^night-shift-e2e-/i,
  /^deep-smoke-/i,
  /^claude-shell-/i,
  /^worktree-/i,
  /^\.tmp/i
];
function isDenyLeaf(leaf: string): boolean {
  const low = leaf.toLowerCase();
  if (DENY_LEAF_LITERAL.has(low)) return true;
  if (DENY_LEAF_PATTERN.some((re) => re.test(leaf))) return true;
  // Pure-digit leaves ("2026", "001") are noise from path numbering.
  if (/^\d{1,4}$/.test(leaf)) return true;
  return false;
}

function buildContext(
  slice: AgentSlice,
  live: Awaited<ReturnType<typeof getLiveStatusForName>>,
  registry: ProjectEntity[],
  knowledge: Record<string, ProjectKnowledgeEntry>
): {
  text: string;
  dominantPid: string | null;
  cwdBackedPids: Set<string>;
  // Every tracked pid that ANY cwd/path-mining seg or bigram resolved to,
  // regardless of share threshold. Used by coercion as a hard filter: if the
  // LLM picks a tracked pid that's not in here, the agent simply didn't touch
  // that repo this week (赵艺霖 → socialmind hallucinated from the word
  // "社媒" in a task title; his cwd is renlab/thesis, has zero socialmind
  // touch). Wider than cwdBackedPids (which is 10%-share-and-up).
  cwdResolvedPids: Set<string>;
} {
  const lines: string[] = [];
  let dominantPidOut: string | null = null;
  let cwdBackedPidsOut = new Set<string>();
  let cwdResolvedPidsOut = new Set<string>();
  if (live?.current) {
    const c = live.current;
    lines.push(
      `# 实时快照\n仓库目录=${c.cwd ?? '?'} 分支=${c.git_branch ?? '?'} 模型=${c.model ?? '?'} 当前hook=${c.event ?? '?'} 上下文用量=${typeof c.context_pct === 'number' ? Math.round(c.context_pct * 100) + '%' : '?'} 会话健康=${c.session_health ?? '?'} 本会话工具调用=${c.tool_calls_total ?? '?'}(失败${c.tool_calls_failed ?? '?'}) 改动文件=${c.files_touched ?? '?'} 距上次动作=${c.stale_seconds ?? '?'}秒`
    );
  }
  // cwd-distribution: cwd path-segments seen across this agent's 7d sessions,
  // ranked by frequency. Strongest signal for "what project they're actually
  // in" — far more reliable than the LLM guessing from work titles. Generic
  // / scratch leaves (tmp, [redacted], system32, etc.) filtered out. Multiple
  // path segments per cwd are checked so "E:\jingtong\001\Maya" registers
  // "Maya" not just "001".
  const cwdSegFreq = new Map<string, number>();
  // Also track adjacent-segment bigrams ("hrdai/team") — a bigram is far more
  // specific than a lone generic leaf ("team") and lets a curated alias like
  // "hrdai/team" bind without poisoning every "team" subdir elsewhere.
  const cwdBigramFreq = new Map<string, number>();
  let cwdTotal = 0;
  const addBigrams = (segs: string[], weight: number): void => {
    const tail = segs.slice(-3);
    for (let i = 0; i < tail.length; i++) {
      if (!isDenyLeaf(tail[i])) cwdSegFreq.set(tail[i], (cwdSegFreq.get(tail[i]) ?? 0) + weight);
      if (i > 0) {
        const bg = `${tail[i - 1]}/${tail[i]}`.toLowerCase();
        cwdBigramFreq.set(bg, (cwdBigramFreq.get(bg) ?? 0) + weight);
      }
    }
  };
  // Path regex for mining file paths out of tool-call quotes. cwd often sits at
  // a parent dir (e.g. claude launched from D:\hrdai, work happens in
  // D:\hrdai\team) so the cwd leaf alone is ambiguous — the file paths in the
  // commands are the real signal. Captures `<parent>/<child>` 2-grams.
  const PATH_RE = /(?:[A-Za-z]:)?[\/\\]?([\w.-]+)[\/\\]([\w.-]+)/g;
  for (const e of slice.events) {
    if (e.type !== 'cc.session_started' && e.type !== 'cc.tool_called') continue;
    const cwd = e.evidence.fields?.cwd;
    if (typeof cwd === 'string' && cwd) {
      cwdTotal += 1;
      addBigrams(cwd.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '').split('/').filter(Boolean), 1);
    }
    // Mine file paths from the command/quote — weight 1 like a cwd hit so a
    // dir referenced 100× in commands carries real signal.
    const q = e.evidence.quote;
    if (typeof q === 'string' && q) {
      let m: RegExpExecArray | null;
      PATH_RE.lastIndex = 0;
      let hits = 0;
      while ((m = PATH_RE.exec(q)) !== null && hits < 12) {
        const bg = `${m[1]}/${m[2]}`.toLowerCase();
        if (!isDenyLeaf(m[2])) cwdBigramFreq.set(bg, (cwdBigramFreq.get(bg) ?? 0) + 1);
        hits += 1;
      }
    }
  }
  if (cwdSegFreq.size > 0 || cwdBigramFreq.size > 0) {
    const ranked = [...cwdSegFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
    const rankedBg = [...cwdBigramFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    lines.push(`# 该成员 7d cwd 路径段分布（去噪后，频次排序）\n${ranked.map(([s, n]) => `  ${s}(${n})`).join(' ')}`);

    // §C — deterministic cwd → projectId resolver. Tests bigrams first (more
    // specific) then single segs. Runs before LLM so the prompt carries
    // authoritative binding hints. The LLM is still in charge of *whether* an
    // item exists; we pin the projectId once it does.
    const segToPid = resolveCwdSegToProjectIds(
      [...rankedBg.map(([s]) => s), ...ranked.map(([s]) => s)],
      registry,
      knowledge
    );
    // Resolved tracked pids — used downstream as a hard filter against LLM
    // hallucinations ("read a string about it in a task title, never touched
    // the actual repo").
    for (const pid of segToPid.values()) cwdResolvedPidsOut.add(pid);
    // Dominant-project detection: aggregate every resolved bigram/seg hit by
    // projectId, then pick the leader. Most of an agent's path hits are
    // repo-INTERNAL subpaths (src/app, tests/predict, private/tasks…) that
    // don't match the repo-root alias, so a raw "% of all hits" bar misses.
    // Instead: the resolved leader wins if it has ≥25% of total cwd hits OR
    // is ≥3× the second-place resolved pid. Stops the LLM grabbing an
    // unrelated repo name it merely read in a grep (戴昊然 → "socialmind").
    const pidScore = new Map<string, number>();
    const bump = (pid: string | undefined, n: number): void => {
      if (pid) pidScore.set(pid, (pidScore.get(pid) ?? 0) + n);
    };
    for (const [bg, n] of rankedBg) bump(segToPid.get(bg), n);
    for (const [sg, n] of ranked) bump(segToPid.get(sg), n);
    const scored = [...pidScore.entries()].sort((a, b) => b[1] - a[1]);
    const scoreTotal = scored.reduce((s, [, n]) => s + n, 0);
    // cwd-backed pids: any project the agent's own cwd/paths land in with a
    // meaningful share (≥10% of resolved hits). These are legit destinations.
    // Includes both registry ids AND `new:<name>` (from resolver pass 3 for
    // knowledge-only projects without a registry row).
    const cwdBackedPids = new Set<string>();
    for (const [pid, n] of scored) if (scoreTotal > 0 && n / scoreTotal >= 0.1) cwdBackedPids.add(pid);

    // Dominant — TRACKED id only (untracked sibling never serves as coercion
    // target; coercion target = the agent's main tracked battlefield where we
    // park their `unclear` work).
    const trackedScored = scored.filter(([pid]) => !pid.startsWith('new:'));
    const trackedBacked = [...cwdBackedPids].filter((p) => !p.startsWith('new:'));
    let dominantPid: string | null = null;
    if (trackedBacked.length === 1) {
      dominantPid = trackedBacked[0];
    } else if (trackedScored.length > 0 && cwdTotal > 0) {
      const [topPid, topN] = trackedScored[0];
      const secondN = trackedScored[1]?.[1] ?? 0;
      if (topN / cwdTotal >= 0.25 || topN >= 3 * Math.max(secondN, 1)) dominantPid = topPid;
    }
    dominantPidOut = dominantPid;

    // §sibling-roots — surface unresolved sibling directories under a known
    // workspace as `new:<child>` candidates. Generic (no per-project regex):
    // group every bigram by its parent; for each parent that already has ≥1
    // resolved child (= a known workspace container like `lll/`), promote
    // other children with ≥30 hits and ≥5% parent share to `new:<child>`.
    const SIBLING_MIN_HITS = 30;
    const SIBLING_MIN_PARENT_SHARE = 0.05;
    const byParent = new Map<string, { resolved: Set<string>; children: Map<string, number>; total: number }>();
    for (const [bg, n] of cwdBigramFreq.entries()) {
      const [parent, child] = bg.split('/');
      if (!parent || !child) continue;
      if (isDenyLeaf(parent) || isDenyLeaf(child)) continue;
      let g = byParent.get(parent);
      if (!g) { g = { resolved: new Set(), children: new Map(), total: 0 }; byParent.set(parent, g); }
      g.children.set(child, (g.children.get(child) ?? 0) + n);
      g.total += n;
      if (segToPid.has(bg) || segToPid.has(child)) g.resolved.add(child);
    }
    const siblingRoots: Array<{ parent: string; child: string; hits: number; share: number }> = [];
    for (const [parent, g] of byParent) {
      if (g.resolved.size === 0) continue;
      for (const [child, n] of g.children) {
        if (g.resolved.has(child)) continue;
        if (n < SIBLING_MIN_HITS) continue;
        const share = g.total > 0 ? n / g.total : 0;
        if (share < SIBLING_MIN_PARENT_SHARE) continue;
        siblingRoots.push({ parent, child, hits: n, share });
      }
    }
    siblingRoots.sort((a, b) => b.hits - a.hits);
    for (const s of siblingRoots) {
      cwdBackedPids.add(`new:${s.child}`);
      cwdResolvedPidsOut.add(`new:${s.child}`);
    }

    cwdBackedPidsOut = cwdBackedPids;
    if (segToPid.size > 0) {
      const hints = [...segToPid.entries()].map(([seg, pid]) => `  "${seg}" → ${pid}`);
      lines.push(`# cwd → projectId 候选映射（参考信号，需与工作文本交叉验证；若工作内容明显不属于该 repo，忽略此映射）\n${hints.join('\n')}`);
    }
    if (siblingRoots.length > 0) {
      lines.push(
        `# 兄弟项目根（同 workspace 下、有真实活动量、但未登记的平级目录）：\n` +
        siblingRoots.map((s) => `  "${s.parent}/${s.child}" 触达 ${s.hits}次（占该 workspace ${Math.round(s.share * 100)}%）→ 用 projectId "new:${s.child}"`).join('\n') +
        `\n如果某条工作明显发生在某个兄弟根（detail 反复出现该目录名、改/测的文件路径都在它下面），请把那条 item 的 projectId 设为 "new:<child>"，不要并到主项目里。`
      );
    }
    if (cwdBackedPids.size > 0) {
      const tracked = [...cwdBackedPids].filter((p) => !p.startsWith('new:'));
      const untracked = [...cwdBackedPids].filter((p) => p.startsWith('new:'));
      const parts: string[] = [];
      if (tracked.length > 0) parts.push(`tracked: [${tracked.join(', ')}]`);
      if (untracked.length > 0) parts.push(`untracked siblings: [${untracked.join(', ')}]`);
      lines.push(`# ⚠ 该成员本周 cwd/文件路径主要落在这些项目: ${parts.join(' · ')}。每条 item 的 projectId 必须从这个集合里选（除非工作文本明确是另一个登记表项目或全新方向）。不要因为 grep/读文件扫到别的项目名（如 socialmind / agent-game-platform）就改归属——读到 ≠ 在做。同一周跨多个上述项目（包括 untracked 兄弟根）是正常的，逐条按工作实际落地分别归属，不要全部塞进单一主项目。`);
    }
  }
  const informative = slice.events.filter((e) => e.type !== 'cc.raw_blob');
  const sessions = informative.filter((e) => e.type === 'cc.session_started' || e.type === 'cc.session_ended' || e.type === 'cc.stuck_signal');
  if (sessions.length > 0) {
    lines.push('# 会话（旧→新）');
    for (const e of sessions.slice(-30)) {
      const f = e.evidence.fields ?? {};
      const q = (e.evidence.quote ?? '').replace(/\s+/g, ' ').slice(0, 200);
      if (e.type === 'cc.session_started') lines.push(`- ${e.ts} 开始 cwd=${f.cwd ?? ''} branch=${f.gitBranch ?? ''} model=${f.model ?? ''}`);
      else if (e.type === 'cc.session_ended') lines.push(`- ${e.ts} 结束 工具=${JSON.stringify(f.toolCounts ?? {})}`);
      else lines.push(`- ${e.ts} ⚠卡点 | ${q}`);
    }
  }
  const recent = informative.filter((e) => e.type === 'cc.tool_called').slice(-150);
  if (recent.length > 0) {
    lines.push('# 近期工具调用 / Bash 命令（旧→新）');
    for (const e of recent) {
      const f = e.evidence.fields ?? {};
      const q = (e.evidence.quote ?? '').replace(/\s+/g, ' ').slice(0, 180);
      lines.push(`- ${e.ts} ${f.tool ?? '?'}${f.gitBranch ? ' [' + f.gitBranch + ']' : ''}${q ? ' | ' + q : ''}`);
    }
  }
  const other = informative.filter((e) => !e.type.startsWith('cc.')).slice(-40);
  if (other.length > 0) {
    lines.push('# 其他事件（GitHub / 任务 / 会议，旧→新）');
    for (const e of other) {
      const q = (e.evidence.quote ?? '').replace(/\s+/g, ' ').slice(0, 200);
      lines.push(`- ${e.ts} ${e.source}/${e.type}${q ? ' | ' + q : ''}`);
    }
  }
  if (lines.length === (live?.current ? 1 : 0)) lines.push('（没有可用的会话 / 工具事件）');
  return {
    text: lines.join('\n'),
    dominantPid: dominantPidOut,
    cwdBackedPids: cwdBackedPidsOut,
    cwdResolvedPids: cwdResolvedPidsOut
  };
}

// Returns null when there's genuinely nothing to summarize (no events, no live
// session) — the caller should then render nothing.
export async function getWorkSummary(name: string): Promise<WorkSummary | null> {
  const [all, live, registry, registryDigest, knowledge, actorIndex] = await Promise.all([
    readAllEvents(),
    getLiveStatusForName(name),
    readProjects(),
    projectsHash(),
    loadProjectKnowledge(),
    buildActorIndex()
  ]);
  const slice = sliceForAgent(all, name, actorIndex);
  if (slice.events.length === 0 && !live?.current) return null;

  // §C stable cache. Old marker keyed on the live session_id + exact latestTs,
  // so an ACTIVE agent (events streaming every few seconds) churned the marker
  // constantly → the monitor re-ran the LLM every tick → the summary flickered
  // (e.g. 戴昊然 momentarily empty on a bad roll). Now we bucket latestTs into
  // 10-minute windows and DROP the volatile session_id: within a 10-min window
  // the marker is stable → cache hit → no needless regen. Registry / curated
  // knowledge changes still bust it (correctness). 10 min is fresh enough for a
  // workboard glance while killing the churn.
  const TENMIN = 10 * 60 * 1000;
  const bucket = slice.latestTs ? Math.floor(Date.parse(slice.latestTs) / TENMIN) : 0;
  const knowledgeDigest = String(JSON.stringify(knowledge).length) + ':' + Object.keys(knowledge).sort().join(',');
  // ATTRIBUTION_VERSION — bump whenever attribution logic changes (prompt
  // rules, cwd resolver, coercion filters, sibling-roots detector, etc.).
  // Without this in the marker, an old cache entry survives a code change and
  // serves stale attributions forever — exactly what made 栾蕊加 stay on
  // matrix-riven after the read-not-done filter shipped. Treat this like a
  // schema-version: any logic change → bump.
  const ATTRIBUTION_VERSION = 'v5-en';
  const marker = `${ATTRIBUTION_VERSION}|${bucket}|${registryDigest}|${knowledgeDigest}`;
  const cache = await readCache();
  const hit = cache[name];
  const cacheValid = hit && Array.isArray(hit.items) && typeof hit.headline === 'string';
  if (cacheValid && hit!.marker === marker) {
    return { headline: hit!.headline, items: hit!.items, generatedAt: hit!.generatedAt };
  }
  // On LLM down, mark the existing cache entry as stale (persisted), so
  // workboard's degradation banner has a real signal to react to.
  const fallback = async (): Promise<WorkSummary | null> => {
    if (!cacheValid) return null;
    const nowIso = new Date().toISOString();
    cache[name] = { ...hit!, staleAt: nowIso };
    await writeCache(cache);
    return {
      headline: hit!.headline,
      items: hit!.items,
      generatedAt: hit!.generatedAt,
      stale: true
    };
  };

  const registryIds = new Set(registry.projects.filter((p) => p.status === 'active').map((p) => p.id));
  // Build alias → canonical-id index so parseSummary can rescue LLM outputs
  // like "new:Pace" → "pace", "Maya" → "agent-game-platform", "Matrix" →
  // "renlabhomepage" (canonical Matrix bucket). Sources, in priority order:
  //   - registry id / name / aliases (canonical)
  //   - curated knownName + curated aliases — mapped onto the canonical
  //     registry id whose own name/aliases/cwd-leaves overlap with curated
  //     aliases (same matching as buildRegistryPrompt's curatedHitsForProject).
  //     When multiple canonical rows curate-match the same knownName
  //     (Matrix → renlabhomepage + verdict), prefer the one with the most
  //     cwd-leaf hits or the first in registry order.
  const aliasIndex = new Map<string, string>();
  for (const p of registry.projects) {
    if (p.status === 'archived') continue;
    const keys = new Set<string>();
    const push = (s: string): void => {
      if (!s) return;
      keys.add(s.toLowerCase().trim());
      keys.add(normalizeForAlias(s));
    };
    push(p.id);
    push(p.name);
    for (const a of p.aliases) push(a);
    for (const k of keys) {
      if (k.length >= 2) aliasIndex.set(k, p.id);
    }
  }
  // Layer curated knownName → canonical id. Walk each curated entry; pick
  // the first active canonical row whose name/aliases/cwd-leaves intersect
  // curated's alias set. Only set aliasIndex entries that don't already
  // exist — canonical aliases take precedence over curated when they collide.
  for (const [knownName, entry] of Object.entries(knowledge)) {
    const curatedSet = new Set<string>([knownName.toLowerCase(), ...(entry.aliases ?? []).map((s) => s.toLowerCase())]);
    let targetId: string | null = null;
    for (const p of registry.projects) {
      if (p.status === 'archived') continue;
      const candidate = new Set<string>([p.name.toLowerCase(), ...(p.aliases ?? []).map((s) => s.toLowerCase())]);
      for (const cwd of p.observed_cwds ?? []) {
        const leaf = leafOf(cwd);
        if (leaf) candidate.add(leaf.toLowerCase());
      }
      let overlap = 0;
      for (const k of candidate) if (curatedSet.has(k)) overlap++;
      if (overlap > 0) { targetId = p.id; break; }
    }
    if (!targetId) continue;
    const pushCurated = (s: string): void => {
      const low = s.toLowerCase().trim();
      const slug = normalizeForAlias(s);
      if (low.length >= 2 && !aliasIndex.has(low)) aliasIndex.set(low, targetId!);
      if (slug.length >= 2 && !aliasIndex.has(slug)) aliasIndex.set(slug, targetId!);
    };
    pushCurated(knownName);
    for (const a of entry.aliases ?? []) pushCurated(a);
  }
  const registrySection = buildRegistryPrompt(registry.projects, knowledge);
  const ctx = buildContext(slice, live, registry.projects, knowledge);

  let raw: string;
  try {
    raw = await llmCall({
      system: SYSTEM,
      // M2.7 reasons before answering — give it room to finish and emit valid
      // JSON, or we'd parse truncated scratchpad.
      maxTokens: 3500,
      temperature: 0.3,
      jsonMode: true,
      user:
        `团队成员：${name}\n\n` +
        `# 当前项目登记表\n${registrySection}\n\n` +
        `${ctx.text}\n\n按规定的 JSON 结构输出 ${name} 的 Claude Code 工作清单。`
    });
  } catch {
    return fallback();
  }
  const parsed = parseSummary(raw, registryIds, aliasIndex);
  if (!parsed) return fallback();
  // cwd-backed coercion: the LLM sometimes picks a repo name it merely READ in
  // a grep/file scan (戴昊然 → socialmind; 李博泽 → renlabhomepage) instead of
  // where the work actually happened. Rule:
  //   - pid ∈ cwdBackedPids → KEEP (legit; honors 1-repo-1-project even when
  //     someone splits across Matrix-Riven/Sharon/Viki in one week).
  //   - pid is `new:` → KEEP (genuinely new direction).
  //   - pid is `unclear` and a dominant exists → fill with dominant.
  //   - pid is a registry id NOT in cwdBackedPids → coerce to dominant (it's a
  //     read-not-done hallucination). If no dominant, leave as the LLM had it.
  if (ctx.cwdBackedPids.size > 0) {
    for (const it of parsed.items) {
      const pid = it.projectId ?? 'unclear';
      if (pid.startsWith('new:')) continue;
      if (ctx.cwdBackedPids.has(pid)) continue;
      const target = pid === 'unclear' ? ctx.dominantPid : (ctx.dominantPid ?? null);
      if (target && target !== pid) {
        it.projectId = target;
        it.attribution_evidence =
          (it.attribution_evidence ? it.attribution_evidence + ' ' : '') +
          '[系统校正：归到本周 cwd 主导项目]';
      }
    }
  }
  // Read-not-done filter — independent of cwdBackedPids (which is empty when
  // the agent works mostly in untracked dirs like 赵艺霖's renlab/thesis).
  // If the LLM picked a TRACKED registry id that no cwd / path-mining hit ever
  // resolved to, that's "saw the word in a task title, never touched the
  // repo" (赵艺霖 → socialmind from "社媒包" in a filename; cwd is renlab,
  // zero socialmind activity). Force `unclear` so the work surfaces as
  // untracked instead of polluting a real project's card.
  for (const it of parsed.items) {
    const pid = it.projectId ?? 'unclear';
    if (pid === 'unclear') continue;
    if (pid.startsWith('new:')) continue;
    if (!registryIds.has(pid)) continue; // already an orphan id, leave alone
    if (ctx.cwdResolvedPids.has(pid)) continue;
    it.projectId = 'unclear';
    it.attribution_evidence =
      (it.attribution_evidence ? it.attribution_evidence + ' ' : '') +
      '[系统校正：cwd 未触达该 repo，疑似仅在文本中读到]';
  }
  // Anti-regression guard: work_summary LLM calls are non-deterministic
  // (temp 0.3) and occasionally return "数据不足" / empty items even when the
  // agent clearly has work this week. The monitor loop re-runs on a timer, so
  // one bad roll would wipe a good cached attribution. If the fresh parse is
  // empty but we have a prior cache entry WITH items, keep the prior — only
  // overwrite empty-with-empty or empty-with-content. (A genuinely-idle agent
  // stays empty; no prior items to preserve.)
  if (parsed.items.length === 0 && cacheValid && (hit!.items?.length ?? 0) > 0) {
    return { headline: hit!.headline, items: hit!.items, generatedAt: hit!.generatedAt };
  }
  const generatedAt = new Date().toISOString();
  // Fresh LLM success: clear staleAt so workboard's banner clears for this
  // agent. Explicit `staleAt: undefined` (vs omitting) so the JSON round-trip
  // doesn't keep an old value when merged into an existing object literal.
  cache[name] = {
    marker,
    headline: parsed.headline,
    items: parsed.items,
    generatedAt,
    staleAt: undefined
  };
  await writeCache(cache);

  // §3.5 observed_cwds writeback — every confident attribution leaves a
  // cwd→projectId crumb so anomaly attribution (§2.4.2) can do cheap lookups
  // without re-asking the LLM. Skip "unclear" and "new:*" — those projects
  // either don't have a stable id or haven't been resolved yet.
  void recordObservedCwdsFromItems(parsed.items, live?.current?.cwd, slice).catch((err) => {
    console.warn('[work_summary] observed_cwds writeback failed:', (err as Error).message);
  });

  return { headline: parsed.headline, items: parsed.items, generatedAt };
}

// Walk the parsed items and feed each confident (registry-resolved) projectId
// the cwds we saw for this agent — live snapshot cwd + every session-started
// event's cwd in the 7-day slice. The projects lib dedupes; idempotent.
async function recordObservedCwdsFromItems(
  items: WorkItem[],
  liveCwd: string | null | undefined,
  slice: AgentSlice
): Promise<void> {
  const confidentIds = new Set<string>();
  for (const it of items) {
    const pid = it.projectId;
    if (!pid) continue;
    if (pid === 'unclear') continue;
    if (pid.startsWith('new:')) continue;
    confidentIds.add(pid);
  }
  if (confidentIds.size === 0) return;
  const cwds = new Set<string>();
  if (typeof liveCwd === 'string' && liveCwd.length > 0) cwds.add(liveCwd);
  for (const e of slice.events) {
    if (e.type !== 'cc.session_started') continue;
    const c = e.evidence.fields?.cwd;
    if (typeof c === 'string' && c.length > 0) cwds.add(c);
  }
  if (cwds.size === 0) return;
  const nowIso = new Date().toISOString();
  const cwdArr = [...cwds];
  // One mutex+atomic write instead of N×M. Previously a single agent refresh
  // with 3 pids × 5 cwds = 15 sequential rewrites of projects.json; across
  // 24 agents per cron tick that was 360 rewrites.
  await recordObservedCwdsBatch(
    [...confidentIds].map((projectId) => ({ projectId, cwds: cwdArr })),
    nowIso
  );
}

// Headlines only, straight from cache — no LLM calls. The /status roster uses
// this to show a one-line "在做什么" hint for active agents without paying for
// a generation on every poll. May be slightly stale; the detail page has the
// fresh full breakdown.
export async function readCachedHeadlines(): Promise<Map<string, { headline: string; generatedAt: string }>> {
  const cache = await readCache();
  const out = new Map<string, { headline: string; generatedAt: string }>();
  for (const [name, e] of Object.entries(cache)) {
    if (e?.headline) out.set(name, { headline: e.headline, generatedAt: e.generatedAt });
  }
  return out;
}

// Same shape, but with the per-thread items too — the /status roster uses this
// to show the parallel work streams (one line per item) under each active name.
// `staleAt` is propagated so workboard.ts can flip `degraded: 'llm-stale'`
// when the LLM has been unreachable for any agent within the recent window.
export async function readCachedSummaries(): Promise<
  Map<string, { headline: string; items: WorkItem[]; generatedAt: string; staleAt?: string }>
> {
  const cache = await readCache();
  const out = new Map<
    string,
    { headline: string; items: WorkItem[]; generatedAt: string; staleAt?: string }
  >();
  for (const [name, e] of Object.entries(cache)) {
    if (e?.headline) {
      out.set(name, {
        headline: e.headline,
        items: Array.isArray(e.items) ? e.items : [],
        generatedAt: e.generatedAt,
        staleAt: e.staleAt
      });
    }
  }
  return out;
}

// Warm the cache for everyone who's currently active/idle — meant to be called
// at the tail of `bun run sync` so the roster's hints are fresh. Sequential to
// avoid hammering the LLM; best-effort (errors swallowed).
export async function refreshActiveWorkSummaries(names: string[]): Promise<{ refreshed: number; failed: number }> {
  let refreshed = 0;
  let failed = 0;
  for (const name of names) {
    try {
      const r = await getWorkSummary(name);
      if (r && !r.stale) refreshed++;
      else if (!r) failed++;
    } catch {
      failed++;
    }
  }
  return { refreshed, failed };
}
