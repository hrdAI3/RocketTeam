// Workboard — project-axis rollup of the team's Claude Code work.
//
// Demo version: groups the LLM-extracted WorkItem[] by their `repo` field
// directly (no project registry, no multi-signal matcher — that's the
// long-term plan in UX-PROJECT-FIRST.md). A small alias map collapses a few
// known repos into one project. Output is deliberately anonymous *per work
// thread*, but each card now carries a single accountable owner so the
// leader knows who to ping; the anonymity rule was always about NOT putting
// member names on individual threads, not about hiding ownership entirely.

import { getRosterView } from './cc_status';
import { readCachedSummaries, type WorkItem as SummaryWorkItem } from './work_summary';
import { readProjects } from '../lib/projects';
import { loadProjectKnowledge, lookupProject, type ProjectKnowledgeEntry } from '../lib/project_knowledge';
import { readRoster, type Member } from '../lib/team_roster';
import type { Anomaly } from '../types/events';

type WorkItemStatus = '进行中' | '卡住' | '已完成';
export type ProjectStatus = 'blocked' | 'active' | 'wrapping' | 'dormant';

export interface DemoWorkItem {
  title: string;
  status: WorkItemStatus;
  detail: string; // one or two sentences — what changed / where stuck / next step
}
export interface ProjectCard {
  key: string; // normalized grouping key
  name: string; // display name
  workItems: DemoWorkItem[]; // anonymous per thread (no per-thread owner)
  ccCount: number; // distinct contributors = "N CC" (anonymous capacity signal)
  lastActivityAt: string | null;
  status: ProjectStatus;
  // Curated owner (project_knowledge.json) if present, else the top
  // contributor by item count. null when neither is resolvable.
  owner: string | null;
}
// An inferred (untracked) project — CC work that has no registry home but
// clearly clusters around a name/repo/person. Rendered with the SAME card
// visual as ProjectCard, badged UNTRACKED.
export interface UntrackedProject {
  key: string;
  name: string;
  owner: string | null;
  workItems: DemoWorkItem[];
  ccCount: number;
  lastActivityAt: string | null;
}
export interface UnclusteredItem {
  title: string;
  status: WorkItemStatus;
  // The CC operator the work belongs to. The /status/unclustered drill-down
  // shows this so leader knows who to talk to; anonymity rule applies only
  // to the project-axis glance (/status/projects), not the unclustered list
  // (the whole point of which is "leader, here's who has unsorted work").
  ownerName?: string;
  // One-line detail from the LLM work-summary — what changed / where stuck.
  detail?: string;
  // ISO of the work's repo hint, when present.
  repo?: string;
}
// Per §6 degradation table.
export type DegradedReason =
  | 'empty-registry'
  | 'collector-down'
  | 'llm-stale';

export interface WorkboardView {
  projects: ProjectCard[];
  unclustered: UnclusteredItem[];
  // Per-inferred-project rollup of the unclustered Entries. The flat
  // `unclustered` array is kept for the drill-in page / backwards compat;
  // this is the per-project grouping the board renders as UNTRACKED cards.
  untrackedProjects: UntrackedProject[];
  anomalies: Anomaly[];
  aggregate: { totalProjects: number; stuck: number };
  degraded?: DegradedReason;
}

// Demo-only: collapse these repos into one project.
const REPO_ALIASES: Record<string, string> = {
  teambrain: 'matrix',
  matrix: 'matrix',
  'matrix-recording': 'matrix',
  'matrix-riven': 'matrix'
};
const ALIAS_TARGETS = new Set(Object.values(REPO_ALIASES));

function normalizeKey(repo: string): string {
  const k = repo.trim().toLowerCase();
  return REPO_ALIASES[k] ?? k;
}

// Pure status rule (§2.3 debounced version).
function projectStatus(items: DemoWorkItem[]): ProjectStatus {
  const stuck = items.filter((i) => i.status === '卡住').length;
  if (stuck >= 2) return 'blocked';
  const ongoing = items.filter((i) => i.status === '进行中');
  const done = items.filter((i) => i.status === '已完成');
  if (ongoing.length === 0 && done.length > 0) return 'wrapping';
  if (ongoing.length === 0) return 'dormant';
  return 'active';
}

// Most frequent ownerName in a group (ties → first encountered). Null when
// the group is empty (e.g. seeded card with no work this period).
function mostFrequentOwner(group: Entry[]): string | null {
  const freq = new Map<string, number>();
  for (const e of group) {
    if (!e.ownerName) continue;
    freq.set(e.ownerName, (freq.get(e.ownerName) ?? 0) + 1);
  }
  const top = [...freq.entries()].sort((a, b) => b[1] - a[1])[0];
  return top ? top[0] : null;
}

// Owner for a project card: curated owner from project_knowledge.json when
// present, else the top contributor in the group by item count.
function resolveOwner(
  name: string,
  group: Entry[],
  knowledge: Record<string, ProjectKnowledgeEntry>
): string | null {
  const hit = lookupProject(knowledge, name);
  const curated = hit?.entry.owners?.[0];
  if (curated) return curated;
  return mostFrequentOwner(group);
}

const STATUS_RANK: Record<ProjectStatus, number> = {
  blocked: 0,
  active: 1,
  wrapping: 2,
  dormant: 3
};

const ITEM_RANK: Record<WorkItemStatus, number> = {
  卡住: 0,
  进行中: 1,
  已完成: 2
};

interface Entry {
  title: string;
  status: WorkItemStatus;
  detail: string;
  repo: string;
  projectId: string;
  attributionEvidence: string;
  ownerName: string;
  lastActivityAt: string | null;
}

export async function getWorkboardView(): Promise<WorkboardView> {
  const [{ roster, anomalies }, summaries, registry, knowledge, rosterFile] = await Promise.all([
    getRosterView(),
    readCachedSummaries(),
    readProjects(),
    loadProjectKnowledge(),
    readRoster()
  ]);
  const lastByName = new Map(roster.map((r) => [r.name, r.lastSessionAt]));
  const registryById = new Map(registry.projects.map((p) => [p.id, p]));
  const registryEmpty = registry.projects.length === 0;
  // Departed members must NOT show up on the workboard — their items linger
  // in the work_summary cache for days after they leave (cache marker is
  // bucket-based, not roster-status-based). Filter them out at entry-load
  // time so they're absent from both tracked + untracked rollups, /status
  // attention rows, and aging trackers downstream.
  const leftNames = new Set(
    rosterFile.members.filter((m: Member) => m.status === 'left').map((m: Member) => m.name)
  );

  const entries: Entry[] = [];
  for (const [name, summ] of summaries) {
    if (leftNames.has(name)) continue;
    for (const wi of summ.items) {
      entries.push({
        title: wi.title,
        status: wi.status,
        detail: wi.detail,
        repo: wi.repo,
        projectId: (wi as SummaryWorkItem).projectId ?? 'unclear',
        attributionEvidence: (wi as SummaryWorkItem).attribution_evidence ?? '',
        ownerName: name,
        lastActivityAt: lastByName.get(name) ?? summ.generatedAt ?? null
      });
    }
  }

  // Per-operator dominant project — fold their `unclear` items into it to
  // prevent the false archive nag. `new:*` are NOT folded here: by the time
  // they reach us, work_summary has already proven the sibling root has
  // independent activity mass, and folding would un-do that signal.
  const dominantByOperator = new Map<string, string>();
  if (!registryEmpty) {
    const pidsByOp = new Map<string, Map<string, number>>();
    for (const e of entries) {
      const pid = e.projectId;
      if (!pid || pid === 'unclear' || pid.startsWith('new:') || !registryById.has(pid)) continue;
      const m = pidsByOp.get(e.ownerName) ?? new Map<string, number>();
      m.set(pid, (m.get(pid) ?? 0) + 1);
      pidsByOp.set(e.ownerName, m);
    }
    for (const [op, m] of pidsByOp) {
      const sorted = [...m.entries()].sort((a, b) => b[1] - a[1]);
      if (sorted.length === 1 || (sorted.length > 1 && sorted[0][1] > sorted[1][1])) {
        dominantByOperator.set(op, sorted[0][0]);
      }
    }
  }

  // Project-axis grouping (§3.3).
  const unclustered: UnclusteredItem[] = [];
  // Keep raw entries that fell through so we can group them into per-inferred-
  // project cards below. UnclusteredItem itself is compact for the drill-in;
  // the rollup needs projectId / lastActivityAt off the originals.
  const unclusteredEntries: Entry[] = [];
  const groups = new Map<string, Entry[]>();
  for (const e of entries) {
    let bucketKey: string | null = null;
    const pid = e.projectId;
    if (registryEmpty) {
      if (e.repo.trim() !== '') bucketKey = normalizeKey(e.repo);
    } else if (pid && pid !== 'unclear' && !pid.startsWith('new:') && registryById.has(pid)) {
      bucketKey = pid;
    } else if (pid === 'unclear' && dominantByOperator.has(e.ownerName)) {
      // Only `unclear` folds into operator's dominant tracked project.
      // `new:*` is preserved → routes through to unclusteredEntries → becomes
      // its own UNTRACKED card below.
      bucketKey = dominantByOperator.get(e.ownerName)!;
    } else if (
      pid &&
      !pid.startsWith('new:') &&
      pid !== 'unclear' &&
      !registryById.has(pid)
    ) {
      // LLM cited an id the registry forgot.
      bucketKey = null;
    }
    if (bucketKey === null) {
      unclustered.push({
        title: e.title,
        status: e.status,
        ownerName: e.ownerName,
        detail: e.detail,
        repo: e.repo
      });
      unclusteredEntries.push(e);
      continue;
    }
    const arr = groups.get(bucketKey) ?? [];
    arr.push(e);
    groups.set(bucketKey, arr);
  }

  // Seed: every active registry project gets a card.
  if (!registryEmpty) {
    for (const p of registry.projects) {
      if (p.status !== 'active') continue;
      if (groups.has(p.id)) continue;
      groups.set(p.id, []);
    }
  }

  const projects: ProjectCard[] = [];
  for (const [key, group] of groups) {
    let name: string;
    const registryProject = registryById.get(key);
    if (registryProject) {
      name = registryProject.name;
    } else if (ALIAS_TARGETS.has(key)) {
      name = key;
    } else {
      const freq = new Map<string, number>();
      for (const e of group) {
        const raw = e.repo.trim();
        if (raw) freq.set(raw, (freq.get(raw) ?? 0) + 1);
      }
      const top = [...freq.entries()].sort((a, b) =>
        b[1] !== a[1] ? b[1] - a[1] : b[0].length - a[0].length
      )[0];
      name = top ? top[0] : key;
    }

    const items: DemoWorkItem[] = group
      .map((e) => ({ title: e.title, status: e.status, detail: e.detail }))
      .sort((a, b) => ITEM_RANK[a.status] - ITEM_RANK[b.status]);
    const ccCount = new Set(group.map((e) => e.ownerName)).size;
    const lastActivityAt =
      group
        .map((e) => e.lastActivityAt)
        .filter((t): t is string => t !== null)
        .sort()
        .at(-1) ?? null;

    projects.push({
      key,
      name,
      workItems: items,
      ccCount,
      lastActivityAt,
      status: projectStatus(items),
      owner: resolveOwner(name, group, knowledge)
    });
  }

  projects.sort((a, b) => {
    const r = STATUS_RANK[a.status] - STATUS_RANK[b.status];
    if (r !== 0) return r;
    const ta = a.lastActivityAt ? Date.parse(a.lastActivityAt) : 0;
    const tb = b.lastActivityAt ? Date.parse(b.lastActivityAt) : 0;
    return tb - ta;
  });

  unclustered.sort((a, b) => ITEM_RANK[a.status] - ITEM_RANK[b.status]);

  // §untracked-projects — group unclusteredEntries into inferred-project
  // cards. Priority:
  //   1. projectId `new:<name>` → key = name (sibling-roots detector already
  //      proved this is its own thing).
  //   2. non-empty repo hint → key = normalized repo.
  //   3. else → key = `misc:<ownerName>` (per-person catch-all).
  const untrackedGroups = new Map<string, Entry[]>();
  for (const e of unclusteredEntries) {
    let key: string;
    // Defensive: an LLM that emits `new:unclear` or a repo string literally
    // equal to "unclear" must not become a project card called "unclear" —
    // route to the per-person misc catch-all instead.
    const newToken = e.projectId.startsWith('new:') ? e.projectId.slice(4) : '';
    const repoToken = (e.repo ?? '').trim().toLowerCase();
    const isJunk = (t: string): boolean => !t || t === 'unclear' || t === 'new' || t === 'misc';
    if (newToken && !isJunk(newToken.toLowerCase())) {
      key = newToken;
    } else if (repoToken && !isJunk(repoToken)) {
      key = normalizeKey(e.repo);
    } else {
      key = `misc:${e.ownerName || 'unknown'}`;
    }
    const arr = untrackedGroups.get(key) ?? [];
    arr.push(e);
    untrackedGroups.set(key, arr);
  }
  const untrackedProjects: UntrackedProject[] = [];
  for (const [key, group] of untrackedGroups) {
    const items: DemoWorkItem[] = group
      .map((e) => ({ title: e.title, status: e.status, detail: e.detail }))
      .sort((a, b) => ITEM_RANK[a.status] - ITEM_RANK[b.status]);
    const ccCount = new Set(group.map((e) => e.ownerName)).size;
    const lastActivityAt =
      group
        .map((e) => e.lastActivityAt)
        .filter((t): t is string => t !== null)
        .sort()
        .at(-1) ?? null;
    // Named inferred project → use its key as display name (meme-weather,
    // resume-detector, etc.). misc:* catch-all → name is just `未分类工作`;
    // the owner row carries the person. Previously we used `Other · <name>`
    // which duplicated the owner (the row showed both the prefixed name and
    // the owner column → two copies of the same name).
    const displayName = key.startsWith('misc:') ? 'Unclustered' : key;
    untrackedProjects.push({
      key,
      name: displayName,
      owner: mostFrequentOwner(group),
      workItems: items,
      ccCount,
      lastActivityAt
    });
  }
  // Sort all untracked projects strictly by recency. Misc catch-alls used to
  // be forced to the bottom on "least actionable" grounds — but if someone's
  // misc bucket is the freshest signal of the day (just touched 52m ago vs a
  // named project last seen 3d ago), demoting it hides what's actually live.
  untrackedProjects.sort((a, b) => {
    const ta = a.lastActivityAt ? Date.parse(a.lastActivityAt) : 0;
    const tb = b.lastActivityAt ? Date.parse(b.lastActivityAt) : 0;
    return tb - ta;
  });

  const ghAnomalies = deriveUnattributedAnomaly(unclustered);

  let degraded: DegradedReason | undefined;
  if (registryEmpty) {
    degraded = 'empty-registry';
  } else {
    const sixHoursAgo = Date.now() - 6 * 60 * 60 * 1000;
    for (const summ of summaries.values()) {
      const at = summ.staleAt;
      if (typeof at === 'string' && Date.parse(at) >= sixHoursAgo) {
        degraded = 'llm-stale';
        break;
      }
    }
  }

  return {
    projects,
    unclustered,
    untrackedProjects,
    anomalies: [...anomalies, ...ghAnomalies],
    aggregate: {
      totalProjects: projects.length,
      stuck: projects.filter((p) => p.status === 'blocked').length
    },
    degraded
  };
}

function stableId(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function deriveUnattributedAnomaly(unclustered: UnclusteredItem[]): Anomaly[] {
  const ongoing = unclustered.filter((u) => u.status !== '已完成');
  if (ongoing.length === 0) return [];
  const nowIso = new Date().toISOString();
  return ongoing.map((u) => ({
    id: `project.unattributed:${stableId(u.title)}`,
    rule: 'project.unattributed',
    subject: { kind: 'task' as const, ref: u.title },
    status: 'open' as const,
    severity_hint: 'next-glance' as const,
    triggered_at: nowIso,
    last_seen_at: nowIso,
    evidence_event_seqs: [],
    suggested_actions: [
      {
        id: 'register-project',
        label: 'Register a project / GitHub repo for this thread',
        tool: 'noop'
      }
    ]
  }));
}

export interface ProjectDetail extends ProjectCard {
  profile?: import('../lib/projects').ProjectProfile;
  description?: string;
}

export async function getProjectDetail(id: string): Promise<ProjectDetail | null> {
  const [{ projects: cards }, registry] = await Promise.all([
    getWorkboardView(),
    readProjects()
  ]);
  const card = cards.find((p) => p.key === id);
  if (!card) return null;
  const entity = registry.projects.find((p) => p.id === id);
  return {
    ...card,
    profile: entity?.profile,
    description: entity?.description
  };
}
