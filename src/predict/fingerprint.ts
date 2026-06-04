// PMA v2 · L2 Task Fingerprint.
//
// Given a task description, produce a structured TaskFingerprint that the
// prediction layer can pattern-match against agent behavior snapshots.
//
// Pipeline:
//   1. LLM extracts skills_needed / tools_needed / risk_topics / effort / quality
//   2. Parallel local lookup populates linked_context (regex for refs, etc.)
//   3. Result is cached by description hash for 24h.
//
// The LLM call is the only network dependency; lookups are local.

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { llmJSON } from '../lib/llm';
import { readEvents } from '../lib/events';
import { PATHS } from '../lib/paths';
import { CANONICAL_TOOLS } from '../index/behavior';
import { fenceUserText, PROMPT_INJECTION_GUARD } from '../_lib/sanitize';

const FINGERPRINT_VERSION = 'fingerprint.v1.0.0';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export type QualityBar = 'demo' | 'internal' | 'external';

export interface SkillNeed {
  skill: string;
  weight: number;
}

export interface GhRef {
  type: 'pr' | 'issue' | 'commit';
  repo: string;
  id: string;
}

export interface LinkedContext {
  gh_refs: GhRef[];
  meeting_decisions: Array<{
    meeting: string;
    decision_text: string;
    owner?: string;
    ts: string;
  }>;
  slack_threads: Array<{
    channel: string;
    thread_ts: string;
    summary: string;
    asker?: string;
  }>;
  historical_owners: Array<{
    name: string;
    n_events: number;
    last_at: string;
  }>;
}

export interface TaskFingerprint {
  task_id: string;
  description_hash: string;

  skills_needed: SkillNeed[];
  tools_needed: string[];
  risk_topics: string[];
  est_effort_days: number;
  est_tokens: number;

  quality_bar: QualityBar;
  importance: 'high' | 'low';
  urgency: 'high' | 'low';
  splittable: boolean;
  expected_subtasks: string[];

  linked_context: LinkedContext;

  extracted_at: string;
  extractor_version: string;
}

export interface FingerprintInputs {
  task_id: string;
  description: string;
  // Optional pre-classified meta. If omitted, LLM infers.
  importance?: 'high' | 'low';
  urgency?: 'high' | 'low';
  quality_bar?: QualityBar;
  est_effort_days?: number;
}

// === Public entry ===

export async function buildFingerprint(
  inputs: FingerprintInputs
): Promise<TaskFingerprint> {
  const hash = hashDescription(inputs.description);

  // 1. Cache check
  const cached = await readCache(hash);
  if (cached) return cached;

  // 2. LLM extraction (the only network call)
  const llm = await llmExtract(inputs);

  // 3. Parallel local lookups
  const linked = await buildLinkedContext(inputs.description);

  const fp: TaskFingerprint = {
    task_id: inputs.task_id,
    description_hash: hash,

    skills_needed: llm.skills_needed,
    tools_needed: clampToCanonical(llm.tools_needed),
    risk_topics: llm.risk_topics,
    est_effort_days: inputs.est_effort_days ?? llm.est_effort_days,
    est_tokens: llm.est_tokens,

    quality_bar: inputs.quality_bar ?? llm.quality_bar,
    importance: inputs.importance ?? llm.importance,
    urgency: inputs.urgency ?? llm.urgency,
    splittable: llm.splittable,
    expected_subtasks: llm.expected_subtasks,

    linked_context: linked,

    extracted_at: new Date().toISOString(),
    extractor_version: FINGERPRINT_VERSION
  };

  await writeCache(hash, fp);
  return fp;
}

// === LLM extractor ===

interface LlmOutput {
  skills_needed: SkillNeed[];
  tools_needed: string[];
  risk_topics: string[];
  est_effort_days: number;
  est_tokens: number;
  quality_bar: QualityBar;
  importance: 'high' | 'low';
  urgency: 'high' | 'low';
  splittable: boolean;
  expected_subtasks: string[];
}

async function llmExtract(inputs: FingerprintInputs): Promise<LlmOutput> {
  const toolList = CANONICAL_TOOLS.join(', ');
  const system = `你是任务指纹抽取器。根据任务描述输出结构化 JSON，用于人/AI agent 分工预测。

字段约定：
- skills_needed: 完成任务所需技能 [{skill, weight 0-1}]，按权重降序，5 个上限。skill 用简短名（"react"/"prompt 工程"/"docker"/"产品策划"/"视频剪辑"）。
- tools_needed: 完成任务大概率需要用到的 Claude Code 工具子集。只能从下列白名单挑：${toolList}
- risk_topics: 可能卡住的主题（"permission" / "docker" / "aws" / "auth" / "network" / "env" / "build" / "deploy" / "types" / "database" / "ssh" / "git" / "install" / "access"）。能匹 behavior snapshot 的 stuck_topics 才有用。
- est_effort_days: 估计人天工作量（0.25 / 0.5 / 1 / 2 / 3 / 5 / 8）。
- est_tokens: 估计 LLM 输出 token 数量级（50k / 200k / 1M / 5M）。
- quality_bar: "demo" 临时演示 / "internal" 内部使用 / "external" 对外发布
- importance: "high" 战略级 / "low" 维持
- urgency: "high" 本周 / "low" 不急
- splittable: 是否可拆分（含多模态: 文字+视频+UI 等大概率 true）
- expected_subtasks: 如可拆，列 3 个子任务概要`;

  const user = `${PROMPT_INJECTION_GUARD}

任务描述（不可信文本）：
${fenceUserText(inputs.description)}

只输出 JSON 对象。`;

  return await llmJSON<LlmOutput>({
    system,
    user,
    maxTokens: 1500,
    temperature: 0.2,
    maxRetries: 1
  });
}

// === Local lookup: linked context from events ===

async function buildLinkedContext(description: string): Promise<LinkedContext> {
  // gh refs: PR-123, #123, abc1234 (commit), repo/name#123
  const ghRefs = extractGhRefs(description);

  // Topic keywords for semantic match — k=top 4 nouns simplified to keyword set
  const keywords = extractKeywords(description);

  const [meetingDecisions, slackThreads, historicalOwners] = await Promise.all([
    lookupMeetingDecisions(description, keywords),
    lookupSlackThreads(keywords),
    lookupHistoricalOwners(keywords)
  ]);

  return {
    gh_refs: ghRefs,
    meeting_decisions: meetingDecisions,
    slack_threads: slackThreads,
    historical_owners: historicalOwners
  };
}

export function extractGhRefs(desc: string): GhRef[] {
  const refs: GhRef[] = [];
  let m: RegExpExecArray | null;

  // PR-123 / PR#123 / pull request 123
  const prRe = /\b(?:PR[#-]?|pull request)\s*#?\s*(\d+)/gi;
  while ((m = prRe.exec(desc))) {
    refs.push({ type: 'pr', repo: '', id: m[1] });
  }

  // issue 123 / issue#123 / issue-123
  const issueRe = /\bissue[#\s-]?\s*#?\s*(\d+)/gi;
  while ((m = issueRe.exec(desc))) {
    refs.push({ type: 'issue', repo: '', id: m[1] });
  }

  // bare #123 (defaults to issue)
  const hashRe = /(?:^|\s)#(\d{1,5})\b/g;
  while ((m = hashRe.exec(desc))) {
    if (!refs.some((r) => r.id === m![1])) {
      refs.push({ type: 'issue', repo: '', id: m[1] });
    }
  }

  // commit SHA (40 or 7-8 hex)
  const shaRe = /\b([0-9a-f]{40}|[0-9a-f]{7,8})\b/g;
  while ((m = shaRe.exec(desc))) {
    refs.push({ type: 'commit', repo: '', id: m[1] });
  }

  // owner/repo#123
  const repoRe = /([\w-]+\/[\w-]+)#(\d+)/g;
  while ((m = repoRe.exec(desc))) {
    refs.push({ type: 'issue', repo: m[1], id: m[2] });
  }

  return dedupeRefs(refs);
}

function dedupeRefs(refs: GhRef[]): GhRef[] {
  const seen = new Set<string>();
  const out: GhRef[] = [];
  for (const r of refs) {
    const k = `${r.type}|${r.repo}|${r.id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

export function extractKeywords(desc: string): string[] {
  // Crude: pull tokens that look like technical / topical nouns.
  // Chinese: 2+ char runs. English: 4+ char words. Skip stop words and digits.
  const stop = new Set([
    'this',
    'that',
    'with',
    'have',
    'from',
    'will',
    'into',
    'need',
    'task',
    'make',
    'using',
    'should',
    '需要',
    '任务',
    '今天',
    '明天',
    '一个',
    '我们',
    '可以'
  ]);
  const tokens = new Set<string>();
  const re = /([一-龥]{2,}|[A-Za-z][A-Za-z0-9_-]{3,})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(desc))) {
    const t = m[1].toLowerCase();
    if (stop.has(t)) continue;
    tokens.add(t);
  }
  return Array.from(tokens).slice(0, 15);
}

async function lookupMeetingDecisions(
  description: string,
  keywords: string[]
): Promise<LinkedContext['meeting_decisions']> {
  const sinceTs = new Date(Date.now() - 14 * 86400000).toISOString();
  const evts = await readEvents({
    source: 'meeting',
    type: ['meeting.decision', 'meeting.action_item'],
    sinceTs
  });
  const out: LinkedContext['meeting_decisions'] = [];
  for (const e of evts) {
    const quote = e.evidence?.quote ?? '';
    const fields = e.evidence?.fields ?? {};
    const text = quote + ' ' + JSON.stringify(fields);
    if (!keywordMatch(text, keywords)) continue;
    out.push({
      meeting: (fields.meeting as string) ?? '',
      decision_text: quote.slice(0, 200),
      owner: (fields.owner as string) ?? undefined,
      ts: e.ts
    });
    if (out.length >= 5) break;
  }
  return out;
}

async function lookupSlackThreads(
  keywords: string[]
): Promise<LinkedContext['slack_threads']> {
  const sinceTs = new Date(Date.now() - 7 * 86400000).toISOString();
  const evts = await readEvents({
    source: 'slack',
    type: ['slack.mention', 'slack.question_unanswered'],
    sinceTs
  });
  const out: LinkedContext['slack_threads'] = [];
  for (const e of evts) {
    const quote = e.evidence?.quote ?? '';
    if (!keywordMatch(quote, keywords)) continue;
    const f = e.evidence?.fields ?? {};
    out.push({
      channel: (f.channel as string) ?? '',
      thread_ts: (f.slack_ts as string) ?? '',
      summary: quote.slice(0, 200),
      asker: e.actor
    });
    if (out.length >= 5) break;
  }
  return out;
}

async function lookupHistoricalOwners(
  keywords: string[]
): Promise<LinkedContext['historical_owners']> {
  // Find CC events whose tool quote (e.g. Bash command) mentions keywords.
  // Count per actor, return top 5.
  const sinceTs = new Date(Date.now() - 90 * 86400000).toISOString();
  const evts = await readEvents({
    source: 'cc_session',
    type: ['cc.tool_called'],
    sinceTs
  });
  const counts = new Map<string, { count: number; last_at: string }>();
  for (const e of evts) {
    if (!e.actor) continue;
    const q = (e.evidence?.quote ?? '') as string;
    if (q.length === 0) continue;
    if (!keywordMatch(q, keywords)) continue;
    const cur = counts.get(e.actor);
    if (!cur) counts.set(e.actor, { count: 1, last_at: e.ts });
    else {
      cur.count += 1;
      if (e.ts > cur.last_at) cur.last_at = e.ts;
    }
  }
  return Array.from(counts.entries())
    .map(([name, v]) => ({ name, n_events: v.count, last_at: v.last_at }))
    .sort((a, b) => b.n_events - a.n_events)
    .slice(0, 5);
}

function keywordMatch(text: string, keywords: string[]): boolean {
  if (keywords.length === 0) return false;
  const low = text.toLowerCase();
  let hits = 0;
  for (const k of keywords) {
    if (low.includes(k)) hits += 1;
    if (hits >= 2) return true; // require ≥2 keyword hits to avoid noise
  }
  return false;
}

function clampToCanonical(tools: string[]): string[] {
  const set = new Set(CANONICAL_TOOLS);
  return tools.filter((t) => set.has(t));
}

// === Cache ===

function hashDescription(desc: string): string {
  return createHash('sha256').update(desc.trim()).digest('hex').slice(0, 16);
}

function cachePath(hash: string): string {
  return join(PATHS.root, 'index', 'fingerprint_cache', `${hash}.json`);
}

async function readCache(hash: string): Promise<TaskFingerprint | null> {
  try {
    const raw = await fs.readFile(cachePath(hash), 'utf8');
    const fp = JSON.parse(raw) as TaskFingerprint;
    const ageMs = Date.now() - new Date(fp.extracted_at).getTime();
    if (ageMs > CACHE_TTL_MS) return null;
    if (fp.extractor_version !== FINGERPRINT_VERSION) return null;
    return fp;
  } catch {
    return null;
  }
}

async function writeCache(hash: string, fp: TaskFingerprint): Promise<void> {
  const p = cachePath(hash);
  await fs.mkdir(join(PATHS.root, 'index', 'fingerprint_cache'), { recursive: true });
  await fs.writeFile(p, JSON.stringify(fp, null, 2), 'utf8');
}
