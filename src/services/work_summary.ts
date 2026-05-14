// "What is this person's Claude Code working on" — a structured, system-built
// digest read off the raw event stream (sessions, tool calls, Bash commands,
// stuck signals, commits, PRs, meeting action items) + the live snapshot.
//
// The model returns an itemized JSON breakdown: a one-line headline (used on the
// /status roster) plus a list of work threads, each tagged with the repo and a
// status (进行中 / 卡住 / 调研中 / 已完成). The per-agent detail page renders the
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
import type { Event } from '../types/events';

const CACHE_FILE = join(PATHS.root, 'cc_summary_cache.json');
const DAY_MS = 24 * 60 * 60 * 1000;
const LOOKBACK_MS = 7 * DAY_MS;

export type WorkItemStatus = '进行中' | '卡住' | '调研中' | '已完成';
const STATUS_SET = new Set<WorkItemStatus>(['进行中', '卡住', '调研中', '已完成']);
const STATUS_RANK: Record<WorkItemStatus, number> = { 卡住: 0, 进行中: 1, 调研中: 2, 已完成: 3 };

export interface WorkItem {
  title: string; // ≤~14 汉字 — the thread
  repo: string; // short repo / project name, or '' if unknown
  status: WorkItemStatus;
  detail: string; // one or two sentences — what changed / where stuck / next step
}

export interface WorkSummary {
  headline: string; // ≤~16 汉字, name-free — the roster one-liner
  items: WorkItem[]; // 卡住 first, then 进行中 / 调研中 / 已完成; ≤8
  generatedAt: string;
  stale?: boolean; // true if the LLM was unreachable and this is a prior cached value
}

interface CacheEntry {
  marker: string;
  headline: string;
  items: WorkItem[];
  generatedAt: string;
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

const SYSTEM = `你是 leader 安子岩的助手。根据这个团队成员的 Claude Code 最近 7 天的事件（会话、工具调用、Bash 命令、卡点信号、commit、PR、会议 action item）和当前实时快照（仓库、分支、上下文用量、当前 hook），把他的 Claude Code 在做什么整理成「一条一条、分门别类」的工作清单。

只输出一个 JSON 对象，不要 markdown、不要解释、不要代码块围栏，结构如下：
{
  "headline": "<不超过 16 个汉字的一句话，写整体在干嘛，不带人名、不带句号，能让 leader 扫一眼就懂>",
  "items": [
    {
      "title": "<不超过 14 个汉字的工作线名字，名词短语>",
      "repo": "<仓库 / 项目的短名，例如 TeamBrain；如果数据里看不出就用空字符串 \\"\\">",
      "status": "<只能是这四个之一：进行中 / 卡住 / 调研中 / 已完成>",
      "detail": "<一到两句中文，具体到改了哪些文件 / 卡在哪 / 下一步是什么；只引用给的数据>"
    }
  ]
}

要求：
- items 按重要性排序——「卡住」的排最前，然后「进行中」「调研中」，「已完成」放最后且最多列 2 条；总共不超过 8 条。
- 同一个仓库的工作线可以拆成几条 item（它们 repo 字段相同，前端会自动归到一组）。
- 只引用我给你的数据，不许编造进度百分比、deadline、状态词；某条不确定就 status 用「调研中」、detail 写「数据不足以判断」。
- 如果整个人的数据都不足以判断，返回 {"headline":"数据不足","items":[]}。
- detail 写人话，不要复述字段名，不要 markdown。`;

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

function parseSummary(raw: string): { headline: string; items: WorkItem[] } | null {
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
    const status: WorkItemStatus = STATUS_SET.has(r.status as WorkItemStatus) ? (r.status as WorkItemStatus) : '进行中';
    items.push({ title: title || detail.slice(0, 20), repo: shortRepo(r.repo), status, detail });
  }
  // Stable sort by status rank (卡住 → 进行中 → 调研中 → 已完成), preserving the
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

function sliceForAgent(all: Event[], name: string): AgentSlice {
  const cutoff = Date.now() - LOOKBACK_MS;
  const rel = all.filter((e) => {
    const t = Date.parse(e.ts);
    if (Number.isNaN(t) || t < cutoff) return false;
    if (e.subject.kind === 'agent' && e.subject.ref === name) return true;
    if (e.actor === name) return true;
    return false;
  });
  rel.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const latestTs = rel.length > 0 ? rel[rel.length - 1].ts : null;
  return { events: rel, latestTs };
}

function buildContext(slice: AgentSlice, live: Awaited<ReturnType<typeof getLiveStatusForName>>): string {
  const lines: string[] = [];
  if (live?.current) {
    const c = live.current;
    lines.push(
      `# 实时快照\n仓库目录=${c.cwd ?? '?'} 分支=${c.git_branch ?? '?'} 模型=${c.model ?? '?'} 当前hook=${c.event ?? '?'} 上下文用量=${typeof c.context_pct === 'number' ? Math.round(c.context_pct * 100) + '%' : '?'} 会话健康=${c.session_health ?? '?'} 本会话工具调用=${c.tool_calls_total ?? '?'}(失败${c.tool_calls_failed ?? '?'}) 改动文件=${c.files_touched ?? '?'} 距上次动作=${c.stale_seconds ?? '?'}秒`
    );
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
  return lines.join('\n');
}

// Returns null when there's genuinely nothing to summarize (no events, no live
// session) — the caller should then render nothing.
export async function getWorkSummary(name: string): Promise<WorkSummary | null> {
  const [all, live] = await Promise.all([readAllEvents(), getLiveStatusForName(name)]);
  const slice = sliceForAgent(all, name);
  if (slice.events.length === 0 && !live?.current) return null;

  // Cache key is the newest event ts + the current live session id (NOT the
  // snapshot's `ts`, which is wall-clock-now-ish and would invalidate the
  // cache on every poll → an LLM call on every page refresh). New session →
  // new id → regen; running session refresh → same id → cache hit.
  const marker = `${slice.latestTs ?? ''}|${live?.current?.session_id ?? ''}`;
  const cache = await readCache();
  const hit = cache[name];
  const cacheValid = hit && Array.isArray(hit.items) && typeof hit.headline === 'string';
  if (cacheValid && hit!.marker === marker) {
    return { headline: hit!.headline, items: hit!.items, generatedAt: hit!.generatedAt };
  }
  const fallback = (): WorkSummary | null =>
    cacheValid ? { headline: hit!.headline, items: hit!.items, generatedAt: hit!.generatedAt, stale: true } : null;

  let raw: string;
  try {
    raw = await llmCall({
      system: SYSTEM,
      // M2.7 reasons before answering — give it room to finish and emit valid
      // JSON, or we'd parse truncated scratchpad.
      maxTokens: 3500,
      temperature: 0.3,
      jsonMode: true,
      user: `团队成员：${name}\n\n${buildContext(slice, live)}\n\n按规定的 JSON 结构输出 ${name} 的 Claude Code 工作清单。`
    });
  } catch {
    return fallback();
  }
  const parsed = parseSummary(raw);
  if (!parsed) return fallback();
  const generatedAt = new Date().toISOString();
  cache[name] = { marker, headline: parsed.headline, items: parsed.items, generatedAt };
  await writeCache(cache);
  return { headline: parsed.headline, items: parsed.items, generatedAt };
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
export async function readCachedSummaries(): Promise<
  Map<string, { headline: string; items: WorkItem[]; generatedAt: string }>
> {
  const cache = await readCache();
  const out = new Map<string, { headline: string; items: WorkItem[]; generatedAt: string }>();
  for (const [name, e] of Object.entries(cache)) {
    if (e?.headline) {
      out.set(name, { headline: e.headline, items: Array.isArray(e.items) ? e.items : [], generatedAt: e.generatedAt });
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
