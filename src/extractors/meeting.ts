// Meeting extractor.
// For each transcript in team/private/context/meeting/*.txt:
//   - hash the content; skip if already processed
//   - LLM extract: action_items + name_mentioned + decisions
//   - emit one event per item
//
// We use llmJSON for a single round-trip structured extraction. State is held
// in PATHS.syncState/meeting.json mapping {file → contentHash}.

import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { appendEvents, readSyncState, writeSyncState } from '../lib/events';
import { llmJSON } from '../lib/llm';
import { PATHS } from '../lib/paths';
import { listMeetings, readMeeting } from '../lib/meetings';
import type { NewEvent } from '../lib/events';

const SYNC_STATE_KEY = 'meeting';

interface SyncState {
  files: Record<string, { hash: string; processedAt: string }>;
}

interface ExtractedMeeting {
  action_items?: Array<{ owner?: string; task: string; quote?: string }>;
  name_mentioned?: Array<{ name: string; context?: string; quote?: string }>;
  decisions?: Array<{ desc: string; quote?: string }>;
}

const EXTRACT_SYSTEM = `你是会议纪要结构化助手。
读完一段会议 transcript，抽取三类信息：

1. action_items: 谁要做什么。owner 是人名（缺省置空字符串）；task 一句话说明任务；quote 引用原文片段（≤80 字）。
2. name_mentioned: 被点名/讨论的人。name 是人名；context 简短说明涉及内容；quote 引用原文片段。
3. decisions: 当场做出的决定。desc 一句话总结；quote 引用原文片段。

输出严格 JSON，字段命名与上一致。如某类为空，返回空数组。`;

function buildExtractUser(content: string): string {
  // Slice long transcripts to keep token cost bounded.
  const MAX = 18000;
  const sliced = content.length > MAX ? content.slice(0, MAX) + '\n...[truncated]' : content;
  return `请按 JSON schema 抽取以下会议内容：\n\n${sliced}`;
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export interface MeetingSyncSummary {
  filesScanned: number;
  filesProcessed: number;
  eventsEmitted: number;
  errors: Array<{ file: string; error: string }>;
}

export async function syncMeetings(): Promise<MeetingSyncSummary> {
  const summary: MeetingSyncSummary = {
    filesScanned: 0,
    filesProcessed: 0,
    eventsEmitted: 0,
    errors: []
  };
  const state = (await readSyncState<SyncState>(SYNC_STATE_KEY)) ?? { files: {} };
  const meetings = await listMeetings();
  summary.filesScanned = meetings.length;

  for (const m of meetings) {
    try {
      const content = await readMeeting(m.file);
      if (content === null) continue;
      const hash = sha256(content);
      if (state.files[m.file]?.hash === hash) continue; // unchanged

      const extracted = await runExtraction(content);
      const events = toEvents(m.file, m.date, m.title, extracted);
      if (events.length > 0) await appendEvents(events);
      summary.eventsEmitted += events.length;
      summary.filesProcessed++;
      state.files[m.file] = { hash, processedAt: new Date().toISOString() };
    } catch (err) {
      summary.errors.push({ file: m.file, error: (err as Error).message });
    }
  }

  await writeSyncState(SYNC_STATE_KEY, state);
  return summary;
}

async function runExtraction(content: string): Promise<ExtractedMeeting> {
  const out = await llmJSON<ExtractedMeeting>({
    system: EXTRACT_SYSTEM,
    user: buildExtractUser(content),
    temperature: 0.2,
    maxTokens: 4000
  });
  return out ?? {};
}

function toEvents(
  file: string,
  date: string | undefined,
  title: string,
  ext: ExtractedMeeting
): NewEvent[] {
  const out: NewEvent[] = [];
  const ts = isoFromDate(date) ?? new Date().toISOString();
  const meetingRef = file; // unique enough
  const baseSubject = { kind: 'meeting' as const, ref: meetingRef };
  for (const a of ext.action_items ?? []) {
    const ownerName = (a.owner ?? '').trim();
    out.push({
      ts,
      source: 'meeting',
      type: 'meeting.action_item',
      subject: ownerName ? { kind: 'agent', ref: ownerName } : baseSubject,
      evidence: {
        quote: a.quote?.slice(0, 200),
        fields: { task: a.task, owner: ownerName || null, meeting: title, file }
      },
      raw_ref: join('meeting', file)
    });
  }
  for (const n of ext.name_mentioned ?? []) {
    const name = (n.name ?? '').trim();
    if (!name) continue;
    out.push({
      ts,
      source: 'meeting',
      type: 'meeting.name_mentioned',
      subject: { kind: 'agent', ref: name },
      evidence: {
        quote: n.quote?.slice(0, 200),
        fields: { context: n.context, meeting: title, file }
      },
      raw_ref: join('meeting', file)
    });
  }
  for (const d of ext.decisions ?? []) {
    out.push({
      ts,
      source: 'meeting',
      type: 'meeting.decision',
      subject: baseSubject,
      evidence: { quote: d.quote?.slice(0, 200), fields: { desc: d.desc, meeting: title, file } },
      raw_ref: join('meeting', file)
    });
  }
  return out;
}

function isoFromDate(mmdd: string | undefined): string | null {
  if (!mmdd) return null;
  const [m, d] = mmdd.split('-');
  if (!m || !d) return null;
  const y = new Date().getFullYear();
  return new Date(`${y}-${m}-${d}T00:00:00Z`).toISOString();
}

// Silence lint about unused import — fs may be needed by future implementations
// reading raw files directly (currently routed through lib/meetings.readMeeting).
void fs;
void PATHS;
