// team:today briefing builder.
// Aggregates open anomalies + recent leader.flag + 7d high-signal events,
// hands it to an LLM, returns markdown briefing in three tiers.
//
// Note: the LLM is told NOT to invent anomalies — every act-now/next-glance
// item must reference an anomaly_id in the input.

import { llmCall, stripThinkBlocks } from '../lib/llm';
import { readAllEvents } from '../lib/events';
import { listOpenAnomalies } from '../anomaly/store';
import type { Event } from '../types/events';
import type { Anomaly } from '../types/events';

const DAY = 24 * 60 * 60 * 1000;

export interface TodayInput {
  anomalies: Anomaly[];
  recentSignals: Event[];
  generatedAt: string;
  lastRunAt?: string | null;
}

export interface TodayResult {
  markdown: string;
  inputSummary: {
    anomalies: number;
    signals: number;
  };
  generatedAt: string;
}

const SYSTEM_PROMPT = `你是 leader 安子岩的 Chief of Staff brief 助手。你的产出是一份每日简报，分三档：

# act-now（警告）
被 leader 当下放下手头去处理的事。每条必须引用 anomaly_id。
建议优先包含：
- severity_hint = 'act-now' 的 anomaly
- 24h 内重复 'seen' 多次的 anomaly

# next-glance（提醒）
下次 CC 间隙看的事。

# fyi（知会）
长期累积/低紧急的事。

输出要求：
1. 严格 markdown
2. 每条事项标题用 emoji + 一句话主旨
3. 第二行起列证据片段（来源 + 引文 + 链接）
4. 末尾列出 2-3 个 MCP 建议命令（格式 \`team:resolve <id> <action>\` 或 \`team:ask <agent> "..."\`）
5. 三档不重复同一 anomaly
6. **不要编造**：每条 act-now/next-glance 必须有 anomaly_id 锚；fyi 可来源 events 但需注明来源
7. 用第二人称对 leader 说话（「你」）
8. 简洁，全文 ≤ 1500 字

如果没有任何 anomaly：briefing 头部「今天无异常 ✓」+ 顶部期间累计 digest（events 数 / 派任务数）。`;

function pickRecentEvents(events: Event[], window = 7 * DAY): Event[] {
  const cutoff = Date.now() - window;
  return events.filter((e) => new Date(e.ts).getTime() >= cutoff);
}

function pickHighSignal(events: Event[]): Event[] {
  // Keep events likely to inform the briefing: cc session activity, PR/commit,
  // slack mention summary, meeting action items. Drop pure noise like
  // gh.commit_pushed if there are too many — cap to N per agent.
  const keepTypes = new Set<string>([
    'cc.session_started',
    'cc.session_ended',
    'cc.stuck_signal',
    'gh.pr_opened',
    'gh.pr_merged',
    'gh.review_requested',
    'slack.mention',
    'meeting.action_item',
    'meeting.decision',
    'task.created',
    'task.dispatched',
    'task.accepted',
    'task.overridden'
  ]);
  return events.filter((e) => keepTypes.has(e.type)).slice(-200);
}

function buildUserPrompt(input: TodayInput): string {
  const parts: string[] = [];
  parts.push(`# 当前时间`);
  parts.push(input.generatedAt);
  if (input.lastRunAt) {
    parts.push(`\n上次 team:today 跑：${input.lastRunAt}`);
  }
  parts.push(`\n# 当前 open anomalies (${input.anomalies.length} 条)`);
  if (input.anomalies.length === 0) {
    parts.push('— 无');
  } else {
    for (const a of input.anomalies) {
      parts.push(
        `- id=${a.id} rule=${a.rule} severity=${a.severity_hint} subject=${a.subject.kind}:${a.subject.ref} triggered=${a.triggered_at} last_seen=${a.last_seen_at}`
      );
      if (a.evidence_event_seqs.length > 0) {
        parts.push(`  evidence_seqs=${a.evidence_event_seqs.slice(-5).join(',')}`);
      }
      if (a.suggested_actions.length > 0) {
        parts.push(
          `  suggested_actions=${a.suggested_actions
            .map((s) => `${s.id}(${s.tool})`)
            .join(', ')}`
        );
      }
    }
  }
  parts.push(`\n# 近 7 天关键 events（${input.recentSignals.length} 条，含 CC / GitHub / Slack / Meeting / Task lifecycle）`);
  const grouped = groupBy(input.recentSignals, (e) => e.source);
  for (const [src, list] of Object.entries(grouped)) {
    parts.push(`\n## ${src} (${list.length})`);
    for (const e of list.slice(-20)) {
      const subj = `${e.subject.kind}:${e.subject.ref}`;
      const q = (e.evidence.quote ?? '').slice(0, 80).replace(/\s+/g, ' ');
      parts.push(`- ${e.ts} ${e.type} ${subj}${q ? ' | ' + q : ''}`);
    }
  }
  parts.push('\n请生成 markdown briefing。');
  return parts.join('\n');
}

function groupBy<T, K extends string>(list: T[], key: (item: T) => K): Record<K, T[]> {
  const out = {} as Record<K, T[]>;
  for (const item of list) {
    const k = key(item);
    if (!out[k]) out[k] = [];
    out[k].push(item);
  }
  return out;
}

export async function buildTodayInput(opts?: { lastRunAt?: string | null }): Promise<TodayInput> {
  const [anomalies, allEvents] = await Promise.all([listOpenAnomalies(), readAllEvents()]);
  const recent = pickRecentEvents(allEvents);
  return {
    anomalies,
    recentSignals: pickHighSignal(recent),
    generatedAt: new Date().toISOString(),
    lastRunAt: opts?.lastRunAt ?? null
  };
}

export async function runToday(opts?: {
  lastRunAt?: string | null;
  signal?: AbortSignal;
}): Promise<TodayResult> {
  const input = await buildTodayInput({ lastRunAt: opts?.lastRunAt });
  const user = buildUserPrompt(input);
  const raw = await llmCall({
    system: SYSTEM_PROMPT,
    user,
    temperature: 0.3,
    maxTokens: 2500,
    signal: opts?.signal
  });
  const markdown = stripThinkBlocks(raw).trim();
  return {
    markdown,
    generatedAt: input.generatedAt,
    inputSummary: {
      anomalies: input.anomalies.length,
      signals: input.recentSignals.length
    }
  };
}
