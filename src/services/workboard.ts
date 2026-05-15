// Workboard — project-axis rollup of the team's Claude Code work.
//
// Demo version: groups the LLM-extracted WorkItem[] by their `repo` field
// directly (no project registry, no multi-signal matcher — that's the
// long-term plan in UX-PROJECT-FIRST.md). A small alias map collapses a few
// known repos into one project. Output is deliberately anonymous: project
// cards carry work threads + a CC count, never member names.

import { getRosterView } from './cc_status';
import { readCachedSummaries } from './work_summary';
import type { Anomaly } from '../types/events';

type WorkItemStatus = '进行中' | '卡住' | '调研中' | '已完成';
export type ProjectStatus = 'blocked' | 'active' | 'wrapping' | 'dormant';

export interface DemoWorkItem {
  title: string;
  status: WorkItemStatus;
  detail: string; // one or two sentences — what changed / where stuck / next step
}
export interface ProjectCard {
  key: string; // normalized grouping key
  name: string; // display name
  workItems: DemoWorkItem[]; // no owner / member name — anonymity is structural
  ccCount: number; // distinct contributors = "N CC" (anonymous capacity signal)
  lastActivityAt: string | null;
  status: ProjectStatus;
}
export interface UnclusteredItem {
  title: string;
  status: WorkItemStatus;
}
export interface WorkboardView {
  projects: ProjectCard[];
  unclustered: UnclusteredItem[];
  anomalies: Anomaly[]; // passed through from getRosterView, rendered at top
  aggregate: { totalProjects: number; stuck: number };
}

// Demo-only: collapse these repos into one project. The long-term plan
// replaces this with a registered project + multi-signal matcher.
const REPO_ALIASES: Record<string, string> = {
  teambrain: 'matrix',
  matrix: 'matrix',
  'matrix-recording': 'matrix'
};
const ALIAS_TARGETS = new Set(Object.values(REPO_ALIASES));

function normalizeKey(repo: string): string {
  const k = repo.trim().toLowerCase();
  return REPO_ALIASES[k] ?? k;
}

// Pure status rule. Demo: a single 卡住 item turns the card red so the red
// card shows up in the demo video — the long-term plan debounces at ≥2.
function projectStatus(items: DemoWorkItem[]): ProjectStatus {
  if (items.some((i) => i.status === '卡住')) return 'blocked';
  const ongoing = items.filter((i) => i.status === '进行中' || i.status === '调研中');
  const done = items.filter((i) => i.status === '已完成');
  if (ongoing.length === 0 && done.length > 0) return 'wrapping';
  if (ongoing.length === 0) return 'dormant';
  return 'active';
}

const STATUS_RANK: Record<ProjectStatus, number> = {
  blocked: 0,
  active: 1,
  wrapping: 2,
  dormant: 3
};

// Work-thread sort within a card: 卡住 → 进行中 → 调研中 → 已完成, so the top
// of a card (and the visible-before-"+N more" slice) always leads with what
// matters.
const ITEM_RANK: Record<WorkItemStatus, number> = {
  卡住: 0,
  进行中: 1,
  调研中: 2,
  已完成: 3
};

interface Entry {
  title: string;
  status: WorkItemStatus;
  detail: string;
  repo: string;
  ownerName: string;
  lastActivityAt: string | null;
}

export async function getWorkboardView(): Promise<WorkboardView> {
  // Demo deviation from the plan: read the work-summary cache directly rather
  // than going through getRosterView().roster, which caps workItems at 3/person
  // and drops 已完成. The cache holds the full LLM breakdown (≤8/person), which
  // makes the project cards substantial enough to demo. getRosterView is still
  // called — for the anomalies and the per-member last-activity timestamps.
  const [{ roster, anomalies }, summaries] = await Promise.all([
    getRosterView(),
    readCachedSummaries()
  ]);
  const lastByName = new Map(roster.map((r) => [r.name, r.lastSessionAt]));

  const entries: Entry[] = [];
  for (const [name, summ] of summaries) {
    for (const wi of summ.items) {
      entries.push({
        title: wi.title,
        status: wi.status,
        detail: wi.detail,
        repo: wi.repo,
        ownerName: name,
        lastActivityAt: lastByName.get(name) ?? summ.generatedAt ?? null
      });
    }
  }

  // Group by normalized repo key; empty repo → unclustered.
  const unclustered: UnclusteredItem[] = [];
  const groups = new Map<string, Entry[]>();
  for (const e of entries) {
    if (e.repo.trim() === '') {
      unclustered.push({ title: e.title, status: e.status });
      continue;
    }
    const key = normalizeKey(e.repo);
    const arr = groups.get(key) ?? [];
    arr.push(e);
    groups.set(key, arr);
  }

  const projects: ProjectCard[] = [];
  for (const [key, group] of groups) {
    // Display name: an alias target uses the alias key itself; otherwise the
    // most frequent original repo string (ties → longest).
    let name: string;
    if (ALIAS_TARGETS.has(key)) {
      name = key;
    } else {
      const freq = new Map<string, number>();
      for (const e of group) {
        const raw = e.repo.trim();
        freq.set(raw, (freq.get(raw) ?? 0) + 1);
      }
      name = [...freq.entries()].sort((a, b) =>
        b[1] !== a[1] ? b[1] - a[1] : b[0].length - a[0].length
      )[0][0];
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
      status: projectStatus(items)
    });
  }

  // Sort: blocked → active → wrapping → dormant; within tier, most recent first.
  projects.sort((a, b) => {
    const r = STATUS_RANK[a.status] - STATUS_RANK[b.status];
    if (r !== 0) return r;
    const ta = a.lastActivityAt ? Date.parse(a.lastActivityAt) : 0;
    const tb = b.lastActivityAt ? Date.parse(b.lastActivityAt) : 0;
    return tb - ta;
  });

  // Unclustered: 卡住 first so a stuck loose thread isn't buried.
  unclustered.sort((a, b) => ITEM_RANK[a.status] - ITEM_RANK[b.status]);

  return {
    projects,
    unclustered,
    anomalies,
    aggregate: {
      totalProjects: projects.length,
      stuck: projects.filter((p) => p.status === 'blocked').length
    }
  };
}

// One project's full card by its grouping key — backs the project detail page.
// Recomputes the whole view (cheap at this team size) and picks one out; the
// ProjectCard already carries the complete, uncapped workItems list.
export async function getProjectDetail(id: string): Promise<ProjectCard | null> {
  const { projects } = await getWorkboardView();
  return projects.find((p) => p.key === id) ?? null;
}
