import { NextRequest } from 'next/server';
import { llmJSON } from '@/lib/llm';
import type { TaskBrief, QualityBar, TaskKind, AIEligibility, CollabTopology } from '@/types';

const TASK_KINDS: TaskKind[] = ['code','research','writing','design','comms','ops','experiment','strategy','mixed'];
const AI_ELIG: AIEligibility[] = ['full','assisted','human_only'];
const COLLAB: CollabTopology[] = ['solo','split','pair'];

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

interface ParseInput {
  description: string;
  prior?: Partial<TaskBrief>; // already-collected fields from earlier turns
  user_answer?: string; // user's answer to a follow-up question
  awaiting_field?: keyof TaskBrief; // which field we asked about
}

interface ParseOutput {
  extracted: Partial<TaskBrief>;
  missing_required: Array<keyof TaskBrief>;
  next_question?: {
    field: keyof TaskBrief;
    prompt: string; // natural-language ask
    field_type: 'date' | 'number' | 'select' | 'boolean';
    options?: string[]; // for select / boolean
  };
  ready_to_submit: boolean;
}

const REQUIRED: Array<keyof TaskBrief> = [
  'description',
  'deadline',
  'estimated_effort_days',
  'quality_bar',
  'importance',
  'urgency'
];

export async function POST(req: NextRequest): Promise<Response> {
  let body: ParseInput = { description: '' };
  try {
    body = (await req.json()) as ParseInput;
  } catch {
    return new Response(JSON.stringify({ error: 'invalid JSON' }), { status: 400 });
  }
  const description = (body.description ?? '').trim();
  if (!description) {
    return new Response(JSON.stringify({ error: 'description required' }), { status: 400 });
  }

  const today = new Date().toISOString().slice(0, 10);
  const prior = body.prior ?? {};

  // Extract via LLM
  let extracted: Partial<TaskBrief> = { description };
  try {
    const llmOut = await llmJSON<{
      deadline?: string;
      start_at?: string;
      estimated_effort_days?: number;
      quality_bar?: QualityBar;
      importance?: 'high' | 'low';
      urgency?: 'high' | 'low';
      inputs_ready?: boolean;
      failure_cost?: 'soft' | 'hard';
      stakeholders?: string[];
      dependencies?: string[];
      task_kind?: TaskKind;
      ai_eligibility?: AIEligibility;
      collab_topology?: CollabTopology;
      required_skills?: string[];
    }>({
      system: `你是任务字段提取助手。从中文任务描述里抽取可解析的关键字段。

只输出 JSON。允许字段全部 optional，能确定的才填，不确定不要瞎猜，不要写"未提供"或类似占位。

字段说明：
- deadline: ISO 日期 YYYY-MM-DD。中文里 "5/20" / "5月20日" 都是 ${today.slice(0, 4)}-05-20；"下周三" / "周三" 等模糊时间也尝试解析（基于今天 ${today}）。
- start_at: 同上，开始日期。
- estimated_effort_days: 数字（人天）。"1 天 / 2 天 / 半天 / 0.5 天 / 一周 = 5 天"。
- quality_bar: "demo" | "internal" | "external"。"demo 演示" → demo；"内部交付 / 内部用" → internal；"对外 / 客户级 / 公司官网" → external。
- importance: "high" | "low"。任务对业务/团队/产品的影响力。"客户合同 / 战略级 / 营收相关 / 必须做对" → high；"内部 nice-to-have / 优化 / 工具改进" → low。
- urgency: "high" | "low"。死线紧张程度。"今天 / 明天 / 本周末 / 死线必须按时" → high；"还有 1+ 周 / 排期内 / 不紧急" → low。
- inputs_ready: 任务描述里说"已经有...材料 / 现成的"等 → true；"需要先调研" → false。
- failure_cost: "客户合同 / 死线必须" → "hard"；"内部 demo / 演示" → "soft"。
- stakeholders: 提到的需要 review / 合作的人或部门。
- dependencies: 提到的前置依赖。
- task_kind: 任务性质，单选其一: code (编码/重构/修 bug) | research (调研/学习/数据) | writing (文档/PR/邮件/帖子) | design (视觉/交互) | comms (跨团队沟通/客户对话) | ops (跑批/后台操作) | experiment (实验/A-B) | strategy (战略决策) | mixed (多模态需拆分)。
- ai_eligibility: AI agent 适合度。code/ops/research/writing 默认 "assisted"，纯编码批处理 "full"；comms/strategy 默认 "human_only"。
- collab_topology: solo (单干) | split (拆子任务) | pair (实时结对)。多模态/大任务 → split；编码/写作 → solo；研发跨人协作 → pair。
- required_skills: 任务需要的具体技能 / 工具关键词，2-6 个。例如 ["React","Tailwind","SSR"] / ["数据分析","SQL"] / ["客户沟通","商务谈判"]。`,
      user: `今天是 ${today}。

任务描述：${description}

${
  body.user_answer && body.awaiting_field
    ? `\n用户刚才回答了关于 ${body.awaiting_field} 的问题：${body.user_answer}\n请把这条回答合并到对应字段。`
    : ''
}

${
  Object.keys(prior).length > 0
    ? `已知字段（不要重复抽，但可校正）：${JSON.stringify(prior)}`
    : ''
}

输出 JSON。`,
      maxTokens: 800,
      temperature: 0.2,
      maxRetries: 1
    });

    extracted = { ...prior, description, ...cleanExtracted(llmOut) };
    console.log('[tasks/parse] llm raw:', JSON.stringify(llmOut), '→ cleaned:', JSON.stringify(cleanExtracted(llmOut)));
  } catch (err) {
    // LLM failed — fall through with just description + prior.
    console.warn('[tasks/parse] llm failed:', (err as Error).message);
    extracted = { ...prior, description };
  }

  // Deterministic description scan — last resort. Pulls signals directly from
  // raw description text using regex so we are not 100% reliant on LLM. Only
  // fills fields that are still empty after LLM + cleanExtracted.
  scanDescriptionFallback(extracted, description, today);

  // Deterministic fallback: if user just answered a specific field and LLM
  // failed to normalize it back, parse the raw answer here. Prevents the
  // dreaded "keep asking the same question" loop.
  if (body.user_answer && body.awaiting_field) {
    const ans = body.user_answer.trim();
    const f = body.awaiting_field;
    if (f === 'deadline' || f === 'start_at') {
      const iso = parseDateAnswer(ans, today);
      if (iso) (extracted as Record<string, unknown>)[f] = iso;
    } else if (f === 'estimated_effort_days') {
      const n = parseNumberAnswer(ans);
      if (n !== null) extracted.estimated_effort_days = n;
    } else if (f === 'quality_bar') {
      const q = parseQualityAnswer(ans);
      if (q) extracted.quality_bar = q;
    } else if (f === 'importance') {
      const v = parseHighLowAnswer(ans, 'importance');
      if (v) extracted.importance = v;
    } else if (f === 'urgency') {
      const v = parseHighLowAnswer(ans, 'urgency');
      if (v) extracted.urgency = v;
    } else if (f === 'inputs_ready') {
      const b = parseBoolAnswer(ans);
      if (b !== null) extracted.inputs_ready = b;
    } else if (f === 'failure_cost') {
      if (/hard|硬|必须|不能/i.test(ans)) extracted.failure_cost = 'hard';
      else if (/soft|软|可推/i.test(ans)) extracted.failure_cost = 'soft';
    }
  }

  // Compute missing required
  const missing_required = REQUIRED.filter((k) => {
    const v = (extracted as Record<string, unknown>)[k];
    if (v === undefined || v === null) return true;
    if (typeof v === 'string' && !v.trim()) return true;
    return false;
  });

  let next_question: ParseOutput['next_question'];
  if (missing_required.length > 0) {
    const f = missing_required[0];
    next_question = questionFor(f, description);
  }

  const out: ParseOutput = {
    extracted,
    missing_required,
    next_question,
    ready_to_submit: missing_required.length === 0
  };
  return new Response(JSON.stringify(out), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}

function cleanExtracted(raw: Record<string, unknown>): Partial<TaskBrief> {
  const out: Partial<TaskBrief> = {};
  if (typeof raw.deadline === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.deadline)) {
    out.deadline = raw.deadline;
  }
  if (typeof raw.start_at === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.start_at)) {
    out.start_at = raw.start_at;
  }
  if (typeof raw.estimated_effort_days === 'number' && raw.estimated_effort_days > 0) {
    out.estimated_effort_days = raw.estimated_effort_days;
  }
  if (raw.quality_bar === 'demo' || raw.quality_bar === 'internal' || raw.quality_bar === 'external') {
    out.quality_bar = raw.quality_bar;
  }
  if (raw.importance === 'high' || raw.importance === 'low') out.importance = raw.importance;
  if (raw.urgency === 'high' || raw.urgency === 'low') out.urgency = raw.urgency;
  if (typeof raw.inputs_ready === 'boolean') out.inputs_ready = raw.inputs_ready;
  if (raw.failure_cost === 'soft' || raw.failure_cost === 'hard') out.failure_cost = raw.failure_cost;
  if (Array.isArray(raw.stakeholders)) {
    out.stakeholders = (raw.stakeholders as unknown[])
      .filter((x): x is string => typeof x === 'string')
      .slice(0, 8);
  }
  if (Array.isArray(raw.dependencies)) {
    out.dependencies = (raw.dependencies as unknown[])
      .filter((x): x is string => typeof x === 'string')
      .slice(0, 6);
  }
  if (typeof raw.task_kind === 'string' && TASK_KINDS.includes(raw.task_kind as TaskKind)) {
    out.task_kind = raw.task_kind as TaskKind;
  }
  if (typeof raw.ai_eligibility === 'string' && AI_ELIG.includes(raw.ai_eligibility as AIEligibility)) {
    out.ai_eligibility = raw.ai_eligibility as AIEligibility;
  }
  if (typeof raw.collab_topology === 'string' && COLLAB.includes(raw.collab_topology as CollabTopology)) {
    out.collab_topology = raw.collab_topology as CollabTopology;
  }
  if (Array.isArray(raw.required_skills)) {
    out.required_skills = (raw.required_skills as unknown[])
      .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
      .slice(0, 6);
  }
  return out;
}

// Scan raw description for regex-detectable signals. Only fills fields that
// are still missing after LLM. Cheap insurance against LLM normalization
// failures (e.g. LLM returns "5/20" instead of "2026-05-20").
function scanDescriptionFallback(brief: Partial<TaskBrief>, description: string, today: string) {
  if (!brief.deadline) {
    const iso = parseDateAnswer(description, today);
    if (iso) brief.deadline = iso;
  }
  if (brief.estimated_effort_days === undefined) {
    // Look for explicit "X 人天 / X 天 / 半天 / 一周"
    const m = description.match(/([0-9]+(?:\.[0-9]+)?)\s*(?:人天|人日|天)/);
    if (m) {
      const n = parseFloat(m[1]);
      if (n > 0 && n < 100) brief.estimated_effort_days = n;
    } else {
      const n = parseNumberAnswer(description);
      if (n !== null) brief.estimated_effort_days = n;
    }
  }
  if (!brief.quality_bar) {
    const q = parseQualityAnswer(description);
    if (q) brief.quality_bar = q;
  }
  if (!brief.importance) {
    const v = parseHighLowAnswer(description, 'importance');
    if (v) brief.importance = v;
    // Quality_bar=external implies high importance (customer-facing).
    else if (brief.quality_bar === 'external') brief.importance = 'high';
    else if (brief.quality_bar === 'demo') brief.importance = 'low';
  }
  if (!brief.urgency) {
    // If deadline parsed and within 3 days, urgent.
    if (brief.deadline) {
      const days = Math.round((new Date(brief.deadline).getTime() - new Date(today).getTime()) / 86400000);
      if (days <= 3) brief.urgency = 'high';
      else if (days >= 7) brief.urgency = 'low';
    }
    if (!brief.urgency) {
      const v = parseHighLowAnswer(description, 'urgency');
      if (v) brief.urgency = v;
    }
  }
}

// ---- Deterministic answer parsers ----

function parseDateAnswer(raw: string, today: string): string | null {
  const todayDate = new Date(today + 'T00:00:00Z');
  const yr = todayDate.getUTCFullYear();
  // "2026-05-20" passthrough
  let m = raw.match(/(\d{4})[-\/年]?(\d{1,2})[-\/月]?(\d{1,2})/);
  if (m) {
    const [, y, mo, d] = m;
    return `${y.padStart(4, '0')}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  // "5/20" / "5-20" / "5月20" / "5月20日"
  m = raw.match(/(\d{1,2})[-\/月](\d{1,2})/);
  if (m) {
    const [, mo, d] = m;
    return `${yr}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  // 今天 / 明天 / 后天 / 大后天
  if (/今天|今日/.test(raw)) return today;
  if (/明天|明日/.test(raw)) return offsetDate(todayDate, 1);
  if (/后天/.test(raw)) return offsetDate(todayDate, 2);
  if (/大后天/.test(raw)) return offsetDate(todayDate, 3);
  // 下周X / 本周X
  const dowMatch = raw.match(/(本|下|这)周([一二三四五六日天])/);
  if (dowMatch) {
    const map: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 };
    const target = map[dowMatch[2]];
    const cur = todayDate.getUTCDay();
    const offset = dowMatch[1] === '下' ? 7 - cur + target : (target - cur + 7) % 7;
    return offsetDate(todayDate, offset || 7);
  }
  return null;
}

function offsetDate(base: Date, days: number): string {
  const d = new Date(base.getTime() + days * 86400000);
  return d.toISOString().slice(0, 10);
}

function parseNumberAnswer(raw: string): number | null {
  // "0.5" / "1" / "2 天" / "半天" / "一周"
  if (/半天/.test(raw)) return 0.5;
  if (/一周|1\s*周|一星期/.test(raw)) return 5;
  if (/两周|2\s*周/.test(raw)) return 10;
  const m = raw.match(/(\d+(?:\.\d+)?)/);
  if (m) {
    const n = parseFloat(m[1]);
    if (n > 0 && n < 100) return n;
  }
  // 中文数字一二三四五六
  const cnMap: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  for (const [k, v] of Object.entries(cnMap)) {
    if (raw.includes(k + '天') || raw.includes(k + '人天')) return v;
  }
  return null;
}

function parseQualityAnswer(raw: string): 'demo' | 'internal' | 'external' | null {
  if (/demo|演示/i.test(raw)) return 'demo';
  if (/external|对外|客户|公开|公司官网|线上/i.test(raw)) return 'external';
  if (/internal|内部|团队/i.test(raw)) return 'internal';
  return null;
}

function parseHighLowAnswer(raw: string, kind: 'importance' | 'urgency'): 'high' | 'low' | null {
  if (kind === 'importance') {
    if (/重要|战略|关键|高|business|client|客户|合同/i.test(raw)) return 'high';
    if (/不重要|常规|nice|低|可有可无/i.test(raw)) return 'low';
  } else {
    if (/紧急|今天|明天|马上|立即|快|高|hard|死线/i.test(raw)) return 'high';
    if (/不紧急|不急|排期|低|宽松/i.test(raw)) return 'low';
  }
  if (/^high$/i.test(raw)) return 'high';
  if (/^low$/i.test(raw)) return 'low';
  return null;
}

function parseBoolAnswer(raw: string): boolean | null {
  if (/是|有|就绪|ok|yes|true|准备好/i.test(raw)) return true;
  if (/否|没|未|no|false|没准备/i.test(raw)) return false;
  return null;
}

function questionFor(
  field: keyof TaskBrief,
  description: string
): NonNullable<ParseOutput['next_question']> {
  switch (field) {
    case 'deadline':
      return {
        field,
        prompt: '这件事的截止日期是？',
        field_type: 'date'
      };
    case 'estimated_effort_days':
      return {
        field,
        prompt: '预估需要多少人天来做？',
        field_type: 'number'
      };
    case 'quality_bar':
      return {
        field,
        prompt: '交付到什么质量级别？',
        field_type: 'select',
        options: ['demo', 'internal', 'external']
      };
    case 'importance':
      return {
        field,
        prompt: '这件事重要吗？影响业务 / 战略级 → 重要；常规优化 / nice-to-have → 不重要',
        field_type: 'select',
        options: ['high', 'low']
      };
    case 'urgency':
      return {
        field,
        prompt: '这件事紧急吗？死线在 3 天内或者 hard 死线 → 紧急；还有 1+ 周或排期内 → 不紧急',
        field_type: 'select',
        options: ['high', 'low']
      };
    default:
      return { field, prompt: `请补充 ${field}`, field_type: 'date' };
  }
}
