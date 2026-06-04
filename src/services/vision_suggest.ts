// Vision-driven goal suggester — the "leader LEADS, not just tracks" piece.
//
// On demand (LLM cost — never auto), reads the two strategic-drift gaps and
// proposes concrete GOALS that close them:
//   - drift projects (active commits, serving NO goal) → frame as a goal
//   - vision areas with no execution → mapped to drift work that plausibly serves them
//
// APPROVAL-BASED: this only PROPOSES. The leader Accepts (→ POST /api/goals
// create, tagged vision_area_id) or Dismisses. Nothing is auto-created.
//
// GROUNDING (hard): every suggestion must link >=1 REAL drift project_id (a goal
// requires >=1 project) and its vision_area_id must be an EXISTING area id (or
// null = leader picks). Any proposal whose links don't validate is DROPPED — the
// LLM cannot invent a project or an area.
//
// MEMORY: reuses goalsView()/visionView() (bounded streamEvents); never reads
// events directly.

import { llmCall } from '../lib/llm';
import { goalsView } from './goal_progress';
import { visionView } from './vision_progress';

export interface GoalSuggestion {
  title: string;
  description: string;
  linked_project_ids: string[];   // validated ⊆ drift project ids (all active)
  linked_project_names: string[]; // display
  vision_area_id: string | null;  // validated existing area id, or null (leader picks)
  vision_area_title: string | null;
  rationale: string;              // grounded "why", references real drift/area
}

export interface SuggestView {
  suggestions: GoalSuggestion[];
  drift_count: number;       // how many drift projects fed the suggester
  area_gap_count: number;    // areas with no execution
  generated_at: string;      // ISO
}

const SYSTEM = `你是团队 leader 的战略参谋。团队有「愿景区(vision area = 战略赌注)」「目标(goal)」「项目(project)」三层。
现状里有两类战略漂移:
  1) drift 项目:有真实近期 commit、但不服务任何目标(执行无战略)
  2) 空愿景区:有战略赌注、但没有任何目标在推进它(战略无执行)
你的任务:把 drift 项目「目标化」,并尽量映射到最匹配的现有愿景区,从而同时弥合两类漂移。

规则(硬):
- 每条建议必须 link 至少 1 个真实的 drift 项目 id(目标必须有项目支撑)。只能用我给你的 drift 项目 id,禁止编造。
- vision_area_id 只能是我给你的现有愿景区 id;若没有合适的区,填 null(由 leader 再选)。禁止编造区 id。
- 相关的 drift 项目可以合并进一条目标(如同属一个产品方向)。
- 标题精炼可执行(动词开头,如「上线 X」「打磨 Y 体验」),描述一句话说清要达成什么。
- 不要为不在 drift 列表里的东西建议目标。没有合适建议就返回空数组。
输出 JSON: {"suggestions":[{"title","description","linked_project_ids":[...],"vision_area_id":<id 或 null>,"rationale"}]}`;

export async function suggestGoals(): Promise<SuggestView> {
  const [gview, vview] = await Promise.all([goalsView(), visionView()]);
  const drift = gview.drift; // active projects serving no goal
  const areas = vview.areas; // existing areas (curated)
  const areaGaps = vview.areas_without_goals;
  const generated_at = new Date().toISOString();

  // Nothing to frame → no LLM call.
  if (drift.length === 0) {
    return { suggestions: [], drift_count: 0, area_gap_count: areaGaps.length, generated_at };
  }

  // Key by LOWERCASED id — the LLM frequently normalizes ids to lowercase
  // (e.g. echoes "renlabhomepage" for project_id "renlabHomepage"), so exact
  // match would drop every grounded proposal. We resolve back to the canonical
  // project_id/area_id from the matched entry.
  const driftById = new Map(drift.map((d) => [d.project_id.toLowerCase(), d]));
  const areaById = new Map(areas.map((a) => [a.area_id.toLowerCase(), a]));

  const facts = [
    '# Drift 项目(有 commit、无目标 — 待目标化)',
    ...drift.map((d) => `- id="${d.project_id}" name="${d.name}" commits_7d=${d.commits_7d}`),
    '',
    '# 现有愿景区(可作为 vision_area_id)',
    areas.length
      ? areas
          .map(
            (a) =>
              `- id="${a.area_id}" title="${a.title}"${a.description ? ` — ${a.description}` : ''}${a.target ? ` 🎯${a.target}` : ''}`
          )
          .join('\n')
      : '(暂无愿景区 — 所有建议 vision_area_id 填 null)',
    '',
    `# 其中 ${areaGaps.length} 个区目前没有任何目标在推进(优先把 drift 映射过去)`,
    areaGaps.map((a) => `- id="${a.area_id}" title="${a.title}"`).join('\n')
  ].join('\n');

  let parsed: { suggestions?: unknown[] } = {};
  try {
    const raw = await llmCall({
      system: SYSTEM,
      user: facts + '\n\n按规定 JSON 输出目标建议。',
      jsonMode: true,
      temperature: 0.4,
      // Generous budget: the active provider is a REASONING model that emits a
      // <think> block BEFORE the JSON — too small a budget truncates the JSON
      // mid-object and the parse silently fails (→ empty suggestions).
      maxTokens: 4000
    });
    // Strip any <think>…</think> reasoning preamble, then extract the JSON
    // object (also skips a ```json fence via the brace scan).
    const clean = raw.replace(/<think>[\s\S]*?<\/think>/gi, '');
    const start = clean.indexOf('{');
    const end = clean.lastIndexOf('}');
    if (start >= 0 && end > start) parsed = JSON.parse(clean.slice(start, end + 1));
  } catch {
    parsed = {};
  }

  const rawList = Array.isArray(parsed.suggestions) ? parsed.suggestions : [];
  const suggestions: GoalSuggestion[] = [];
  for (const it of rawList) {
    const r = it as Record<string, unknown>;
    const title = typeof r.title === 'string' ? r.title.trim() : '';
    if (!title) continue;

    // GROUNDING: keep only project ids that are REAL drift projects (active).
    const ids = Array.isArray(r.linked_project_ids) ? r.linked_project_ids : [];
    const validIds: string[] = [];
    const validNames: string[] = [];
    for (const pid of ids) {
      const d = typeof pid === 'string' ? driftById.get(pid.toLowerCase()) : undefined;
      if (d && !validIds.includes(d.project_id)) {
        validIds.push(d.project_id);
        validNames.push(d.name);
      }
    }
    if (validIds.length === 0) continue; // a goal needs >=1 real project — drop hallucinations

    // GROUNDING: vision_area_id must be an existing area, else null.
    let areaId: string | null = null;
    let areaTitle: string | null = null;
    if (typeof r.vision_area_id === 'string') {
      const a = areaById.get(r.vision_area_id.toLowerCase());
      if (a) {
        areaId = a.area_id;
        areaTitle = a.title;
      }
    }

    suggestions.push({
      title: title.slice(0, 80),
      description: typeof r.description === 'string' ? r.description.slice(0, 200) : '',
      linked_project_ids: validIds,
      linked_project_names: validNames,
      vision_area_id: areaId,
      vision_area_title: areaTitle,
      rationale: typeof r.rationale === 'string' ? r.rationale.slice(0, 200) : ''
    });
  }

  // Don't propose the same drift project twice across suggestions (first wins) —
  // keeps the leader from accepting two goals that claim the same work.
  const claimed = new Set<string>();
  const deduped = suggestions.filter((s) => {
    const fresh = s.linked_project_ids.filter((id) => !claimed.has(id));
    if (fresh.length === 0) return false;
    s.linked_project_ids = fresh;
    s.linked_project_names = s.linked_project_ids.map((id) => driftById.get(id.toLowerCase())?.name ?? id);
    fresh.forEach((id) => claimed.add(id));
    return true;
  });

  return {
    suggestions: deduped,
    drift_count: drift.length,
    area_gap_count: areaGaps.length,
    generated_at
  };
}
