// §3.6 — project profile. Builds and evolves the durable "About this project"
// layer (vocabulary / goals / key_people / open_questions) that the detail
// page renders default-collapsed in its About section.
//
// Pipeline:
//   - bootstrapProjectProfile(id): runs once per project — LLM scan over the
//     project's last 90 days of events. Used right after the resolver mints
//     a new id.
//   - evolveProjectProfile(id): incremental. Runs at the same cadence as
//     project_extraction. LLM sees only recent (default 14d) evidence + the
//     existing profile; outputs additions / supersessions.
//
// Discipline strap (§0.5):
//   1. Constrained output — values constrained by the schema below; any
//      malformed ProfileFact gets dropped at parse time.
//   2. EvidenceRef required — empty evidence array drops the fact.
//   3. `goals` requires ≥2 independent evidence sources to mint
//      (independent = different source_id, or ≥7 days apart on same source_id).
//
// Staleness is rendered, NOT swept here. The detail page reads
// `last_evidence_ts` and dims/archives per §3.6.2.

import { readEventsWindow } from '../lib/events';
import { llmCall, stripThinkBlocks } from '../lib/llm';
import {
  readProjects,
  updateProjects,
  type KeyPersonFact,
  type ProfileFact,
  type ProjectEntity,
  type ProjectProfile,
  type VocabularyFact
} from '../lib/projects';
import type { Event } from '../types/events';
import type { EvidenceRef } from '../types';

const DAY_MS = 24 * 60 * 60 * 1000;
const BOOTSTRAP_WINDOW_DAYS = 90;
const EVOLVE_WINDOW_DAYS = 14;
const GOAL_INDEPENDENT_DAYS = 7;
const MAX_EVENT_LINES = 800;

const VALID_SOURCES = new Set([
  'cc_session',
  'slack',
  'github',
  'meeting',
  'task_outcome',
  'self_report',
  'override',
  'org_chart'
]);

const SYSTEM_BOOTSTRAP = `你是项目画像分析师。我给你一个项目和它最近 90 天的相关事件。提取 4 个字段：

输出 JSON：
{
  "vocabulary":     [ { "term": "<术语>", "definition": "<≤200 字解释>", "evidence": [<EvidenceRef[]>] } ],
  "goals":          [ { "value": "<≤200 字目标描述>", "evidence": [<≥2 条独立 EvidenceRef>] } ],
  "key_people":     [ { "name": "<人名>", "role": "<可选 ≤40 字角色>", "evidence": [<EvidenceRef[]>] } ],
  "open_questions": [ { "value": "<≤200 字未答问题>", "evidence": [<EvidenceRef[]>] } ]
}

EvidenceRef 格式（每条必带）：
{ "source": "cc_session|slack|github|meeting", "source_id": "seq:<num>", "quote": "<≤200 字引文>", "extracted_at": "<空字符串，系统填>" }

要求：
- 每条 fact 必带至少 1 条 evidence。空 evidence 的条目不要输出。
- "goals" 必带 ≥2 条 EvidenceRef，且来自不同 source_id（不同文件 / 会议 / PR）或同 source_id 但相隔 ≥ 7 天。
- 不要编造没见过的术语 / 人名 / 目标。看不出就空数组 \`[]\`。
- "role" 只在 evidence 明示时填。`;

const SYSTEM_EVOLVE = `你是项目画像维护者。我给你当前画像 + 最近 ${EVOLVE_WINDOW_DAYS} 天的新事件。

输出 JSON：
{
  "add": {
    "vocabulary":     [ { "term", "definition", "evidence" } ],
    "goals":          [ { "value", "evidence" } ],
    "key_people":     [ { "name", "role?", "evidence" } ],
    "open_questions": [ { "value", "evidence" } ]
  },
  "supersede": [
    { "field": "vocabulary|goals|key_people|open_questions", "old_key": "<term|value|name>", "new_key": "<term|value|name>", "reason": "<≤200 字理由>" }
  ]
}

要求：
- 只输出"看到新证据"的 add；evidence 必带。
- "goals" add 仍然必须 ≥2 条独立 evidence。
- supersede 用于显式否定（"目标改为 X" / "Y 不再是 key_people"）。不显式否定就不要 supersede。
- 不要 remove；旧值靠 staleness 自然 archive。`;

function summarizeEvent(e: Event): string {
  const q = (e.evidence.quote ?? '').replace(/\s+/g, ' ').slice(0, 220);
  const fields = e.evidence.fields ?? {};
  const cwd = typeof fields.cwd === 'string' ? fields.cwd : '';
  const repo = typeof fields.repo === 'string' ? fields.repo : '';
  const tags = [cwd && `cwd=${cwd}`, repo && `repo=${repo}`].filter(Boolean);
  return `seq:${e.seq} ${e.ts} ${e.source}/${e.type}${tags.length ? ` [${tags.join(' ')}]` : ''}${q ? ' | ' + q : ''}`;
}

// Pick events that look like they belong to a given project. Cheap filter:
// any event whose cwd / repo / quote / fields mentions the project name,
// any alias, or sits in the project's observed_cwds.
function eventTouchesProject(e: Event, project: ProjectEntity): boolean {
  const cwd = typeof e.evidence.fields?.cwd === 'string' ? e.evidence.fields.cwd : '';
  if (cwd) {
    for (const known of project.observed_cwds) {
      if (cwd === known || cwd.startsWith(known + '/') || cwd.startsWith(known + '\\')) {
        return true;
      }
    }
  }
  const needles = [project.id, project.name, ...project.aliases].map((s) => s.toLowerCase());
  const hay = JSON.stringify({
    quote: e.evidence.quote ?? '',
    fields: e.evidence.fields ?? {},
    type: e.type,
    actor: e.actor ?? ''
  }).toLowerCase();
  return needles.some((n) => n.length >= 3 && hay.includes(n));
}

function buildEventsForProject(
  events: Event[],
  project: ProjectEntity,
  windowDays: number
): string {
  const cutoff = Date.now() - windowDays * DAY_MS;
  const filtered = events
    .filter((e) => {
      const t = Date.parse(e.ts);
      if (!Number.isFinite(t) || t < cutoff) return false;
      return eventTouchesProject(e, project);
    })
    .slice(-MAX_EVENT_LINES);
  if (filtered.length === 0) return '（窗口内未见相关事件）';
  return filtered.map(summarizeEvent).join('\n');
}

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

function clampLine(s: unknown, max: number): string {
  if (typeof s !== 'string') return '';
  return s.replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalizeEvidence(raw: unknown, now: string): EvidenceRef | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const source = typeof r.source === 'string' ? r.source : '';
  if (!VALID_SOURCES.has(source)) return null;
  const source_id = typeof r.source_id === 'string' && r.source_id.length > 0 ? r.source_id : '';
  const quote = clampLine(r.quote, 200);
  if (!source_id || !quote) return null;
  return {
    source: source as EvidenceRef['source'],
    source_id,
    quote,
    extracted_at:
      typeof r.extracted_at === 'string' && r.extracted_at.length > 0 ? r.extracted_at : now
  };
}

function parseEvidenceArray(raw: unknown, now: string): EvidenceRef[] {
  if (!Array.isArray(raw)) return [];
  const out: EvidenceRef[] = [];
  for (const r of raw) {
    const norm = normalizeEvidence(r, now);
    if (norm) out.push(norm);
  }
  return out;
}

// §3.6.3 — independent evidence test. Two refs count as independent if they
// differ on source_id, OR share source_id but extracted_at is ≥ 7d apart.
function hasIndependentEvidence(refs: EvidenceRef[]): boolean {
  if (refs.length < 2) return false;
  for (let i = 0; i < refs.length; i++) {
    for (let j = i + 1; j < refs.length; j++) {
      const a = refs[i];
      const b = refs[j];
      if (a.source_id !== b.source_id) return true;
      const ta = Date.parse(a.extracted_at);
      const tb = Date.parse(b.extracted_at);
      if (
        Number.isFinite(ta) &&
        Number.isFinite(tb) &&
        Math.abs(ta - tb) >= GOAL_INDEPENDENT_DAYS * DAY_MS
      ) {
        return true;
      }
    }
  }
  return false;
}

function maxEvidenceTs(refs: EvidenceRef[], fallback: string): string {
  let max = '';
  for (const r of refs) {
    if (r.extracted_at > max) max = r.extracted_at;
  }
  return max || fallback;
}

interface RawFact {
  value?: unknown;
  term?: unknown;
  definition?: unknown;
  name?: unknown;
  role?: unknown;
  evidence?: unknown;
}

function parseProfile(raw: string, now: string): ProjectProfile {
  const text = stripThinkBlocks(raw).trim();
  const jsonStr = extractJsonObject(text);
  const empty: ProjectProfile = { vocabulary: [], goals: [], key_people: [], open_questions: [] };
  if (!jsonStr) return empty;
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return empty;
  }
  if (typeof parsed !== 'object' || parsed === null) return empty;
  const o = parsed as Record<string, unknown>;

  const out: ProjectProfile = { ...empty };
  if (Array.isArray(o.vocabulary)) {
    for (const it of o.vocabulary as RawFact[]) {
      const term = clampLine(it.term, 60);
      const definition = clampLine(it.definition, 200);
      const evidence = parseEvidenceArray(it.evidence, now);
      if (!term || !definition || evidence.length === 0) continue;
      out.vocabulary.push({
        term,
        definition,
        value: definition,
        evidence,
        last_evidence_ts: maxEvidenceTs(evidence, now)
      } satisfies VocabularyFact);
    }
  }
  if (Array.isArray(o.goals)) {
    for (const it of o.goals as RawFact[]) {
      const value = clampLine(it.value, 200);
      const evidence = parseEvidenceArray(it.evidence, now);
      // §3.6.3 dual-evidence gate.
      if (!value || !hasIndependentEvidence(evidence)) continue;
      out.goals.push({
        value,
        evidence,
        last_evidence_ts: maxEvidenceTs(evidence, now)
      } satisfies ProfileFact);
    }
  }
  if (Array.isArray(o.key_people)) {
    for (const it of o.key_people as RawFact[]) {
      const name = clampLine(it.name, 40);
      const role = clampLine(it.role, 40);
      const evidence = parseEvidenceArray(it.evidence, now);
      if (!name || evidence.length === 0) continue;
      out.key_people.push({
        name,
        role: role || undefined,
        value: name,
        evidence,
        last_evidence_ts: maxEvidenceTs(evidence, now)
      } satisfies KeyPersonFact);
    }
  }
  if (Array.isArray(o.open_questions)) {
    for (const it of o.open_questions as RawFact[]) {
      const value = clampLine(it.value, 200);
      const evidence = parseEvidenceArray(it.evidence, now);
      if (!value || evidence.length === 0) continue;
      out.open_questions.push({
        value,
        evidence,
        last_evidence_ts: maxEvidenceTs(evidence, now)
      } satisfies ProfileFact);
    }
  }
  return out;
}

export async function bootstrapProjectProfile(id: string): Promise<ProjectProfile | null> {
  const file = await readProjects();
  const project = file.projects.find((p) => p.id === id);
  if (!project) return null;
  // Bootstrap window is 90d. Stream only that — avoids the soon-to-OOM
  // full-file load (events.jsonl ≈ Node's max-string limit).
  const sinceIso = new Date(Date.now() - BOOTSTRAP_WINDOW_DAYS * DAY_MS).toISOString();
  const events = await readEventsWindow({ since: sinceIso });
  const userPrompt = buildEventsForProject(events, project, BOOTSTRAP_WINDOW_DAYS);
  if (userPrompt.startsWith('（窗口内未见')) return null;
  const now = new Date().toISOString();
  const raw = await llmCall({
    system: SYSTEM_BOOTSTRAP,
    user:
      `项目：${project.name} (id=${project.id})\n` +
      (project.description ? `描述：${project.description}\n` : '') +
      `aliases: ${project.aliases.join(', ') || '（无）'}\n\n` +
      `# 近 ${BOOTSTRAP_WINDOW_DAYS} 天事件\n${userPrompt}\n\n按规定 JSON 输出。`,
    temperature: 0.2,
    maxTokens: 4500,
    jsonMode: true
  });
  const profile = parseProfile(raw, now);
  await updateProjects((current) => {
    const p = current.projects.find((q) => q.id === id);
    if (!p) return current;
    p.profile = profile;
    return current;
  });
  return profile;
}

interface SupersedeEntry {
  field: 'vocabulary' | 'goals' | 'key_people' | 'open_questions';
  oldKey: string;
  newKey: string;
  reason: string;
}

interface ParsedEvolve {
  add: ProjectProfile;
  supersede: SupersedeEntry[];
}

function parseEvolve(raw: string, now: string): ParsedEvolve {
  const text = stripThinkBlocks(raw).trim();
  const jsonStr = extractJsonObject(text);
  const empty: ParsedEvolve = {
    add: { vocabulary: [], goals: [], key_people: [], open_questions: [] },
    supersede: []
  };
  if (!jsonStr) return empty;
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return empty;
  }
  if (typeof parsed !== 'object' || parsed === null) return empty;
  const o = parsed as Record<string, unknown>;
  const out: ParsedEvolve = empty;
  if (o.add && typeof o.add === 'object') {
    out.add = parseProfile(JSON.stringify(o.add), now);
  }
  if (Array.isArray(o.supersede)) {
    for (const s of o.supersede) {
      if (typeof s !== 'object' || s === null) continue;
      const r = s as Record<string, unknown>;
      const field = r.field;
      if (
        field !== 'vocabulary' &&
        field !== 'goals' &&
        field !== 'key_people' &&
        field !== 'open_questions'
      ) {
        continue;
      }
      const oldKey = clampLine(r.old_key, 200);
      const newKey = clampLine(r.new_key, 200);
      const reason = clampLine(r.reason, 200);
      if (!oldKey || !newKey || !reason) continue;
      out.supersede.push({ field, oldKey, newKey, reason });
    }
  }
  return out;
}

function keyOf(field: SupersedeEntry['field'], fact: ProfileFact): string {
  if (field === 'vocabulary') return (fact as VocabularyFact).term;
  if (field === 'key_people') return (fact as KeyPersonFact).name;
  return fact.value;
}

function mergeAdds<T extends ProfileFact>(
  existing: T[],
  adds: T[],
  keyFn: (f: T) => string
): T[] {
  const known = new Set(existing.map(keyFn));
  for (const a of adds) {
    const k = keyFn(a);
    if (known.has(k)) {
      // bump last_evidence_ts on the existing entry; append unique evidence.
      const e = existing.find((x) => keyFn(x) === k)!;
      if (a.last_evidence_ts > e.last_evidence_ts) e.last_evidence_ts = a.last_evidence_ts;
      const seen = new Set(e.evidence.map((r) => r.source_id + '|' + r.quote.slice(0, 60)));
      for (const r of a.evidence) {
        const k2 = r.source_id + '|' + r.quote.slice(0, 60);
        if (!seen.has(k2)) {
          e.evidence.push(r);
          seen.add(k2);
        }
      }
      e.archived = false;
      e.superseded_by = undefined;
    } else {
      existing.push(a);
      known.add(k);
    }
  }
  return existing;
}

export async function evolveProjectProfile(id: string): Promise<ProjectProfile | null> {
  const file = await readProjects();
  const project = file.projects.find((p) => p.id === id);
  if (!project) return null;
  if (!project.profile) {
    // Project never bootstrapped — fall through to bootstrap which is heavier
    // but is the correct first step.
    return bootstrapProjectProfile(id);
  }
  // Evolve window is 14d. Stream only that.
  const sinceIso = new Date(Date.now() - EVOLVE_WINDOW_DAYS * DAY_MS).toISOString();
  const events = await readEventsWindow({ since: sinceIso });
  const userPrompt = buildEventsForProject(events, project, EVOLVE_WINDOW_DAYS);
  if (userPrompt.startsWith('（窗口内未见')) {
    return project.profile;
  }
  const now = new Date().toISOString();
  const raw = await llmCall({
    system: SYSTEM_EVOLVE,
    user:
      `项目：${project.name} (id=${project.id})\n\n` +
      `# 当前画像\n${JSON.stringify(project.profile, null, 2)}\n\n` +
      `# 近 ${EVOLVE_WINDOW_DAYS} 天新事件\n${userPrompt}\n\n按规定 JSON 输出。`,
    temperature: 0.2,
    maxTokens: 3500,
    jsonMode: true
  });
  const parsed = parseEvolve(raw, now);

  await updateProjects((current) => {
    const p = current.projects.find((q) => q.id === id);
    if (!p || !p.profile) return current;
    const prof = p.profile;
    mergeAdds(prof.vocabulary, parsed.add.vocabulary, (f) => f.term);
    mergeAdds(prof.goals, parsed.add.goals, (f) => f.value);
    mergeAdds(prof.key_people, parsed.add.key_people, (f) => f.name);
    mergeAdds(prof.open_questions, parsed.add.open_questions, (f) => f.value);
    for (const s of parsed.supersede) {
      const list = prof[s.field] as ProfileFact[];
      const old = list.find((f) => keyOf(s.field, f) === s.oldKey);
      if (old) {
        old.archived = true;
        old.superseded_by = s.newKey;
      }
    }
    return current;
  });
  const after = await readProjects();
  return after.projects.find((q) => q.id === id)?.profile ?? null;
}

// Run evolve over every active project. Called from `bun run sync` tail.
export async function evolveAllProjectProfiles(): Promise<{
  evolved: number;
  bootstrapped: number;
  errors: Array<{ id: string; error: string }>;
}> {
  const file = await readProjects();
  let evolved = 0;
  let bootstrapped = 0;
  const errors: Array<{ id: string; error: string }> = [];
  for (const p of file.projects) {
    if (p.status === 'archived') continue;
    try {
      if (p.profile) {
        await evolveProjectProfile(p.id);
        evolved++;
      } else {
        await bootstrapProjectProfile(p.id);
        bootstrapped++;
      }
    } catch (err) {
      errors.push({ id: p.id, error: (err as Error).message });
    }
  }
  return { evolved, bootstrapped, errors };
}
