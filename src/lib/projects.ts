// Project registry — `private/projects.json` read/write + cwd lookup index.
//
// Schema lives in UX-PROJECT-FIRST.md §0.3 / §3.4. Four concurrent writers
// (resolver, work_summary's observed_cwds append, leader overrides, archival
// sweep) are coordinated through `withMutex(PROJECTS_MUTEX_KEY)` + tmp+rename
// atomic writes (§3.1).
//
// Identity is "append-mostly": id and name are sticky after first mint; later
// proposals enrich (add alias, add evidence, append observed_cwds, bump
// last_attributed_at) but never rewrite the canonical fields.

import { promises as fs } from 'node:fs';
import crypto from 'node:crypto';
import { PATHS } from './paths';
import { withMutex } from './mutex';
import { atomicWriteJSON } from '../_lib/file-io';
import type { EvidenceRef } from '../types';

export const PROJECTS_MUTEX_KEY = 'projects:write';

export interface ResolutionLogEntry {
  at: string; // ISO
  action: 'mint' | 'enrich' | 'merge' | 'fast-prefix' | 'fast-name' | 'override';
  proposed_name: string;
  resolved_id: string;
  reason: string; // <= 200 chars
}

export interface ProjectOverride {
  at: string;
  kind: 'split' | 'merge' | 'rename' | 'archive';
  target_id?: string; // for merge
  new_name?: string; // for rename
  reason: string;
}

// §3.6 — project profile types. ProfileFact carries a value + evidence_refs
// (§0.5 discipline 2) + last_evidence_ts for staleness UI (§3.6.2). Optional
// `archived: true` lets evolve mark old values stale-archived without losing
// them — `superseded_by` chains to the value that replaced this one.
export interface ProfileFact {
  value: string;
  evidence: EvidenceRef[];
  last_evidence_ts: string;
  archived?: boolean;
  superseded_by?: string;
}
export interface VocabularyFact extends ProfileFact {
  term: string;
  definition: string;
}
export interface KeyPersonFact extends ProfileFact {
  name: string;
  role?: string;
}
export interface ProjectProfile {
  vocabulary: VocabularyFact[];
  goals: ProfileFact[];
  key_people: KeyPersonFact[];
  open_questions: ProfileFact[];
}

export interface ProjectEntity {
  id: string;
  name: string;
  status: 'active' | 'archived';
  aliases: string[];
  description: string;
  evidence_refs: EvidenceRef[];
  observed_cwds: string[];
  first_seen_at: string;
  last_attributed_at: string;
  resolution_log: ResolutionLogEntry[];
  overrides: ProjectOverride[];
  // §3.6 profile. Optional on disk so S1/S2 entries (pre-profile) are valid.
  profile?: ProjectProfile;
}

export interface ProjectsFile {
  version: 1;
  projects: ProjectEntity[];
}

const EMPTY: ProjectsFile = { version: 1, projects: [] };

export async function readProjects(): Promise<ProjectsFile> {
  try {
    const raw = await fs.readFile(PATHS.projects, 'utf8');
    const parsed = JSON.parse(raw) as Partial<ProjectsFile>;
    if (parsed?.version === 1 && Array.isArray(parsed.projects)) {
      return parsed as ProjectsFile;
    }
    return EMPTY;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY;
    throw err;
  }
}

export async function writeProjects(file: ProjectsFile): Promise<void> {
  await withMutex(PROJECTS_MUTEX_KEY, async () => {
    await atomicWriteJSON(PATHS.projects, file);
  });
}

// Concurrent-safe read-modify-write. The mutator receives a fresh copy each
// time, returns the next state. Callers should not retain refs across the
// await boundary. Mutex serializes; tmp+rename guarantees the file never
// observes a half-written state from another process.
export async function updateProjects(
  mutate: (current: ProjectsFile) => Promise<ProjectsFile> | ProjectsFile
): Promise<ProjectsFile> {
  return withMutex(PROJECTS_MUTEX_KEY, async () => {
    let current: ProjectsFile;
    try {
      const raw = await fs.readFile(PATHS.projects, 'utf8');
      const parsed = JSON.parse(raw) as Partial<ProjectsFile>;
      current =
        parsed?.version === 1 && Array.isArray(parsed.projects)
          ? (parsed as ProjectsFile)
          : { version: 1, projects: [] };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      current = { version: 1, projects: [] };
    }
    const next = await mutate(current);
    await atomicWriteJSON(PATHS.projects, next);
    return next;
  });
}

export async function getProjectById(id: string): Promise<ProjectEntity | null> {
  const file = await readProjects();
  return file.projects.find((p) => p.id === id) ?? null;
}

// Stable digest of the registry — fed into work_summary cache marker so
// attribution re-runs when the registry shifts in a way the LLM would care
// about. Deliberately NARROW: id + name + status only. Aliases and
// description churn on every enrichment (extraction normalizes raw surfaces
// differently each pass), and re-warming all 24 agents on every alias bump
// would dominate cron cost without changing attribution decisions (the LLM
// gets the live registry inline in the prompt either way).
export async function projectsHash(): Promise<string> {
  const file = await readProjects();
  const canonical = file.projects.map((p) => ({
    id: p.id,
    name: p.name,
    status: p.status
  }));
  return crypto
    .createHash('sha1')
    .update(JSON.stringify(canonical))
    .digest('hex')
    .slice(0, 12);
}

// cwd → projectId lookup. Used by anomaly attribution (§2.4.2) — cheap, no
// LLM. Exact match wins; else longest-prefix match across all observed_cwds.
// Ambiguous (cwd appears under multiple projects) → returns the most recent
// by last_attributed_at; still ambiguous → null.
export async function lookupProjectByCwd(cwd: string): Promise<string | null> {
  if (!cwd) return null;
  const norm = normalizeCwd(cwd);
  const file = await readProjects();
  const exactHits: ProjectEntity[] = [];
  const prefixHits: Array<{ project: ProjectEntity; prefix: string }> = [];
  for (const p of file.projects) {
    if (p.status === 'archived') continue;
    for (const c of p.observed_cwds) {
      const cn = normalizeCwd(c);
      if (cn === norm) {
        exactHits.push(p);
        break;
      }
      if (norm.startsWith(cn + '/') || norm.startsWith(cn + '\\')) {
        prefixHits.push({ project: p, prefix: cn });
        break;
      }
    }
  }
  if (exactHits.length === 1) return exactHits[0].id;
  if (exactHits.length > 1) return pickByRecency(exactHits);
  if (prefixHits.length === 0) return null;
  // Longest matching prefix wins; tie → most recent.
  prefixHits.sort((a, b) => b.prefix.length - a.prefix.length);
  const top = prefixHits[0].prefix.length;
  const finalists = prefixHits.filter((h) => h.prefix.length === top).map((h) => h.project);
  return finalists.length === 1 ? finalists[0].id : pickByRecency(finalists);
}

function pickByRecency(list: ProjectEntity[]): string | null {
  if (list.length === 0) return null;
  const sorted = [...list].sort(
    (a, b) => Date.parse(b.last_attributed_at) - Date.parse(a.last_attributed_at)
  );
  // Strict tie at exactly the same ts → null (safe failure direction, per §3.5).
  if (
    sorted.length > 1 &&
    Date.parse(sorted[0].last_attributed_at) === Date.parse(sorted[1].last_attributed_at)
  ) {
    return null;
  }
  return sorted[0].id;
}

function normalizeCwd(s: string): string {
  return s.trim().replace(/[\\/]+$/, '').toLowerCase();
}

// Slug helpers used by the resolver when minting a new id. Kept here so any
// other writer (override → rename, etc.) mints the same way.
const SLUG_RE = /[^a-z0-9-]+/g;

export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/[\s_/\\]+/g, '-')
    .replace(SLUG_RE, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return base || 'project';
}

export function uniqueSlug(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  // Last-resort: random suffix (essentially never reachable).
  return `${base}-${crypto.randomBytes(2).toString('hex')}`;
}

// Deny-list applied at observed_cwds writeback (§3.5). A cwd whose leaf
// segment matches one of these patterns adds zero binding signal — they're
// generic scratch / system / personal-home / test-fixture dirs that any
// project might transiently land in. Letting them accumulate corrupts
// future cwd→project lookups (e.g. /tmp/deep-smoke-X → mypet) and crowds
// out real binding leaves in registry-prompt's "cwd-leaf samples" section.
const WRITEBACK_DENY_LEAVES = new Set(
  [
    'tmp', 'temp', 'var', 'private', 'users', 'user', 'home', 'desktop', 'documents',
    'downloads', 'system32', 'projects', 'workspace', 'workspaces', 'src', 'public',
    '[redacted]', 'redacted', '.claude', '.codex', '.cursor', '.git', '.gstack',
    'worktrees', 'work', 'node_modules', 'dist', 'build', 'out',
    'neuro', 'asus', 'zhangziyi', 'tianhaoxuan', '19723', // Windows usernames (C:\Users\X), not projects
    'thesis', 'renlab', 'research', 'personal' // personal / generic-lab containers, not a project name
  ]
);
const WRITEBACK_DENY_PATTERNS = [
  /^night-shift-e2e-/i,
  /^deep-smoke-/i,
  /^claude-shell-/i,
  /^worktree-/i,
  /^\.tmp/i,
  // Meeting / note dirs in any language — scratch context, never a project root.
  /(会议|纪要|meeting|briefing|memo|notes)$/i
];
// Whole-path deny: a home-directory ROOT (C:\Users\X, /home/x) is never a
// project root even if its leaf segment slipped past WRITEBACK_DENY_LEAVES (a
// username we don't know yet). isDenyCwd tests this against the normalized
// full path, not just the leaf.
const WRITEBACK_DENY_PATH_PATTERNS = [
  /^[a-z]:[\\/]users[\\/][^\\/]+$/i, // Windows home root: c:\users\someone
  /^[\\/]home[\\/][^\\/]+$/i // POSIX home root: /home/someone
];
function isDenyCwd(cwd: string): boolean {
  const norm = normalizeCwd(cwd);
  // Whole-path deny first — home-dir roots regardless of leaf.
  if (WRITEBACK_DENY_PATH_PATTERNS.some((re) => re.test(norm))) return true;
  const segs = norm.split(/[\\/]+/).filter(Boolean);
  const leaf = segs[segs.length - 1] ?? '';
  if (!leaf) return true;
  const low = leaf.toLowerCase();
  if (WRITEBACK_DENY_LEAVES.has(low)) return true;
  if (WRITEBACK_DENY_PATTERNS.some((re) => re.test(leaf))) return true;
  if (/^\d{1,4}$/.test(leaf)) return true; // pure-digit leaves
  return false;
}

// Affinity gate for observed_cwds writeback. A cwd may only bind to a project
// if ANY path segment matches that project's name / alias (case-insensitive,
// org prefix stripped from `org/repo` aliases). Without this, a single LLM
// hallucination ("赵艺霖 工作 = socialmind" because the title says 社媒)
// writes the agent's UNRELATED cwds (D:\renlab, D:\thesis) onto the project's
// observed_cwds → the next LLM call sees those cwds as binding samples for
// socialmind → confirms the hallucination → loop. With the gate, only
// path-confirmed cwds bind: cwd must literally have `/socialmind/` in it.
function projectBindingTokens(p: ProjectEntity): Set<string> {
  const out = new Set<string>();
  out.add(p.name.toLowerCase());
  for (const a of p.aliases ?? []) {
    const low = a.toLowerCase();
    out.add(low);
    const slash = low.lastIndexOf('/');
    if (slash >= 0) out.add(low.slice(slash + 1)); // strip org/ prefix
  }
  // Anything generic/denied is never a binding token — protects against an
  // alias accidentally being a deny-leaf (no current row, but defensive).
  for (const t of [...out]) if (WRITEBACK_DENY_LEAVES.has(t)) out.delete(t);
  return out;
}
function cwdBindsToProject(cwd: string, tokens: Set<string>): boolean {
  if (tokens.size === 0) return false;
  const norm = normalizeCwd(cwd);
  for (const seg of norm.split('/').filter(Boolean)) {
    if (tokens.has(seg.toLowerCase())) return true;
  }
  return false;
}

// Append a (cwd → project) observation. Mutex+atomic. Idempotent: known cwd
// is a no-op except for bumping last_attributed_at. Deny-listed leaves
// (see WRITEBACK_DENY_*) are dropped here — last_attributed_at still bumps
// since the project was touched, but no leaf binds.
export async function recordObservedCwd(
  projectId: string,
  cwd: string,
  ts: string
): Promise<void> {
  if (!cwd) return;
  const deny = isDenyCwd(cwd);
  await updateProjects((file) => {
    const p = file.projects.find((q) => q.id === projectId);
    if (!p) return file;
    if (!deny) {
      const tokens = projectBindingTokens(p);
      if (cwdBindsToProject(cwd, tokens)) {
        const norm = normalizeCwd(cwd);
        const seen = new Set(p.observed_cwds.map(normalizeCwd));
        if (!seen.has(norm)) p.observed_cwds.push(norm);
      }
    }
    if (!p.last_attributed_at || ts > p.last_attributed_at) p.last_attributed_at = ts;
    return file;
  });
}

// Batched version of recordObservedCwd — accepts multiple (projectId, cwd[])
// pairs and persists them in a single mutex+atomic write. work_summary.ts uses
// this so a per-agent refresh with N confident pids × M cwds doesn't take
// N×M sequential mutex acquisitions (= N×M atomic rewrites of projects.json).
export async function recordObservedCwdsBatch(
  pairs: Array<{ projectId: string; cwds: string[] }>,
  ts: string
): Promise<void> {
  if (pairs.length === 0) return;
  const cleaned = pairs
    .map((p) => ({ projectId: p.projectId, cwds: p.cwds.filter((c) => c.length > 0) }))
    .filter((p) => p.cwds.length > 0);
  if (cleaned.length === 0) return;
  await updateProjects((file) => {
    for (const { projectId, cwds } of cleaned) {
      const p = file.projects.find((q) => q.id === projectId);
      if (!p) continue;
      const seen = new Set(p.observed_cwds.map(normalizeCwd));
      const tokens = projectBindingTokens(p);
      for (const cwd of cwds) {
        if (isDenyCwd(cwd)) continue;
        // Affinity gate — see projectBindingTokens for rationale.
        if (!cwdBindsToProject(cwd, tokens)) continue;
        const norm = normalizeCwd(cwd);
        if (!seen.has(norm)) {
          p.observed_cwds.push(norm);
          seen.add(norm);
        }
      }
      if (!p.last_attributed_at || ts > p.last_attributed_at) p.last_attributed_at = ts;
    }
    return file;
  });
}
