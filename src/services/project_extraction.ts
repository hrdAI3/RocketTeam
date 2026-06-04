// §3.2 Project extraction pass.
//
// Periodic LLM scan over a sliding window of `events.jsonl` (all 4 sources
// unified). Output = `ProjectProposal[]` — `{ proposed_name, description,
// evidence_refs, observed_surface_names }`. Proposals are NOT written
// directly to `projects.json`; they go through the identity resolver
// (§3.4) which does dedup + stable id allocation.
//
// Cost: one LLM call per pass (not per project). Cadence: tail of
// `bun run sync`, or standalone via `tools/audit-resolver.ts`.

import { readEventsWindow } from '../lib/events';
import { llmCall, stripThinkBlocks } from '../lib/llm';
import type { Event } from '../types/events';
import type { EvidenceRef } from '../types';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_WINDOW_DAYS = 30;
const MAX_EVENT_LINES = 600; // keep prompt context tractable

export interface ProjectProposal {
  proposed_name: string;
  description: string; // ≤ 500 chars — enough for the resolver + future attribution prompt
  evidence_refs: EvidenceRef[]; // required ≥ 1 (§0.5 discipline 2)
  observed_surface_names: string[]; // alias / cwd-segment / repo names seen for this project
}

const SYSTEM = `你是 leader 安子岩团队的项目识别助手。我会给你近期事件流（CC 会话日志、会议摘要、Slack 消息、GitHub PR）。你的任务：识别团队"正在推进的项目"——同目标的一组活动，可以横跨多源，不要求有仓库。

输出严格的 JSON：
{
  "projects": [
    {
      "proposed_name": "<人话项目名，例如 Matrix / Maya / Talk HTML Skill>",
      "description": "<一两句话说明项目是什么、当前在干嘛，≤500 字符，必须只引用我给你的事件>",
      "evidence_refs": [
        {
          "source": "<只能是这五个之一：cc_session / slack / github / meeting / task_outcome>",
          "source_id": "<事件的 seq 数字字符串，例如 \\"seq:1234\\">",
          "quote": "<≤200 字符的引文，从事件 evidence.quote / evidence.fields 摘出来>",
          "extracted_at": "<本次跑的 ISO 时间，由系统填，留空也行>"
        }
      ],
      "observed_surface_names": ["<这个项目在事件里出现过的表面名、仓库名、cwd 末段>"]
    }
  ]
}

要求：
- 一个项目至少 1 条 evidence_ref；evidence_refs 为空的项目**不要输出**。
- 不要编造目标 / deadline / 进度 / 负责人，只描述"在干什么"。
- 不要把 1 次性 / 单 PR 的小动作单列为项目（除非确实是新立项的种子）。
- 同一个项目的不同表面名（"matrix" / "matrix-recording" / "teambrain"）尽量都列进 observed_surface_names。
- 数据不足以确认是项目 → 不要输出。空项目列表合法。`;

interface BuildOptions {
  windowDays?: number;
  maxLines?: number;
}

function summarizeEvent(e: Event): string {
  const q = (e.evidence.quote ?? '').replace(/\s+/g, ' ').slice(0, 200);
  const fields = e.evidence.fields ?? {};
  const cwd = typeof fields.cwd === 'string' ? fields.cwd : '';
  const repo = typeof fields.repo === 'string' ? fields.repo : '';
  const tool = typeof fields.tool === 'string' ? fields.tool : '';
  const path = typeof fields.path === 'string' ? fields.path : '';
  const tags: string[] = [];
  if (cwd) tags.push(`cwd=${cwd}`);
  if (repo) tags.push(`repo=${repo}`);
  if (tool) tags.push(`tool=${tool}`);
  if (path) tags.push(`path=${path}`);
  const tail = tags.length > 0 ? ` [${tags.join(' ')}]` : '';
  return `seq:${e.seq} ${e.ts} ${e.source}/${e.type}${tail}${q ? ' | ' + q : ''}`;
}

export function buildExtractionPrompt(events: Event[], opts?: BuildOptions): string {
  const win = (opts?.windowDays ?? DEFAULT_WINDOW_DAYS) * DAY_MS;
  const cutoff = Date.now() - win;
  const recent = events
    .filter((e) => {
      const t = Date.parse(e.ts);
      return Number.isFinite(t) && t >= cutoff;
    })
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const slice = recent.slice(-(opts?.maxLines ?? MAX_EVENT_LINES));
  const lines = slice.map(summarizeEvent);
  if (lines.length === 0) lines.push('（窗口内无事件）');
  return lines.join('\n');
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

function normalizeEvidence(raw: unknown, now: string): EvidenceRef | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const source = typeof r.source === 'string' ? r.source : '';
  if (!VALID_SOURCES.has(source)) return null;
  const source_id = typeof r.source_id === 'string' && r.source_id.length > 0 ? r.source_id : '';
  if (!source_id) return null;
  const quote = typeof r.quote === 'string' ? r.quote.slice(0, 200) : '';
  if (!quote) return null;
  return {
    source: source as EvidenceRef['source'],
    source_id,
    quote,
    extracted_at: typeof r.extracted_at === 'string' && r.extracted_at ? r.extracted_at : now
  };
}

export function parseExtractionOutput(raw: string): ProjectProposal[] {
  const text = stripThinkBlocks(raw).trim();
  const jsonStr = extractJsonObject(text);
  if (!jsonStr) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null) return [];
  const root = (parsed as Record<string, unknown>).projects;
  if (!Array.isArray(root)) return [];
  const now = new Date().toISOString();
  const out: ProjectProposal[] = [];
  for (const item of root) {
    if (typeof item !== 'object' || item === null) continue;
    const it = item as Record<string, unknown>;
    const proposed_name =
      typeof it.proposed_name === 'string' ? it.proposed_name.trim().slice(0, 60) : '';
    if (!proposed_name) continue;
    const description =
      typeof it.description === 'string' ? it.description.trim().slice(0, 500) : '';
    const evRaw = Array.isArray(it.evidence_refs) ? it.evidence_refs : [];
    const evidence_refs: EvidenceRef[] = [];
    for (const e of evRaw) {
      const norm = normalizeEvidence(e, now);
      if (norm) evidence_refs.push(norm);
    }
    // Discipline 2: drop proposals without evidence.
    if (evidence_refs.length === 0) continue;
    const surfacesRaw = Array.isArray(it.observed_surface_names) ? it.observed_surface_names : [];
    const observed_surface_names = surfacesRaw
      .map((s) => (typeof s === 'string' ? s.trim() : ''))
      .filter((s): s is string => s.length > 0 && s.length <= 80);
    out.push({ proposed_name, description, evidence_refs, observed_surface_names });
  }
  return out;
}

export async function runProjectExtraction(opts?: BuildOptions): Promise<ProjectProposal[]> {
  // Window matches buildExtractionPrompt's internal filter — stream only that
  // window so we don't materialize the entire events.jsonl just to drop most
  // of it inside the filter (file is now ≈ Node's max-string limit).
  const winDays = opts?.windowDays ?? DEFAULT_WINDOW_DAYS;
  const sinceIso = new Date(Date.now() - winDays * DAY_MS).toISOString();
  const events = await readEventsWindow({ since: sinceIso });
  const userPrompt = buildExtractionPrompt(events, opts);
  // If the window is empty we don't need to burn a call.
  if (userPrompt.startsWith('（窗口内无事件')) return [];
  const raw = await llmCall({
    system: SYSTEM,
    user: `近 ${opts?.windowDays ?? DEFAULT_WINDOW_DAYS} 天事件（旧→新）：\n${userPrompt}\n\n按规定 JSON 输出。`,
    temperature: 0.2,
    maxTokens: 4000,
    jsonMode: true
  });
  return parseExtractionOutput(raw);
}
