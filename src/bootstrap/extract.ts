// 2-phase bootstrap. Eng review 5C.
//
//   Phase 1 (10 LLM calls): for each meeting transcript -> per-member summary
//   Phase 2 (4 LLM calls):  for each target member     -> full profile
//
// Total ~14 calls. Designed for ~5 demo target members against ~10 meeting
// transcripts. Larger teams should switch to a chunked retrieval strategy
// (TODOS.md).

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { PATHS } from '../lib/paths';
import { writeProfile } from '../lib/agents';
import { llmJSON } from '../lib/llm';
import { appendTimelineEvent } from '../lib/timeline';
import {
  PHASE1_SYSTEM,
  phase1UserPrompt,
  PHASE2_SYSTEM,
  phase2UserPrompt
} from './prompts';
import type { PersonalAgentProfile, EnergyLevel, BootstrapStatus } from '../types/index';
import { ENERGY_LEVELS } from '../types/index';

export interface OrgEntry {
  name: string;
  dept: string;
  role: string;
  join_date: string | null;
}

export interface BootstrapTarget {
  name: string;
  dept: string;
  role: string;
  join_date: string | null;
}

export interface BootstrapOptions {
  targets: BootstrapTarget[];
  // Optional progress callback. Called between phases and per-item.
  onProgress?: (status: BootstrapStatus) => void;
  // AbortSignal so the caller can cancel a long bootstrap run.
  signal?: AbortSignal;
}

export interface Phase1Result {
  meeting: string;
  per_member: Record<
    string,
    {
      spoke?: boolean;
      topics?: string[];
      responsibilities_mentioned?: string[];
      strengths_evidence?: string[];
      energy_or_state_signals?: string[];
      interaction_summary?: string;
    }
  >;
}

// Default targets per design.md / ROADMAP.md: 4 重点 demo 成员.
// Real names live in private/source-data/targets.ts (gitignored). Public
// fallback at private.example/source-data/targets.ts uses placeholder names.
// Rest of the org chart is reachable via parseOrgChart.
export { DEFAULT_TARGETS } from '@private/source-data/targets';

// Parse the team's org chart (`team/context/org/组织架构.txt`). Used by the
// /api/bootstrap endpoint when no target list is supplied.
export async function parseOrgChart(): Promise<OrgEntry[]> {
  const orgFile = join(PATHS.contextOrg, '组织架构.txt');
  let raw: string;
  try {
    raw = await fs.readFile(orgFile, 'utf8');
  } catch {
    return [];
  }
  const lines = raw.split(/\r?\n/);
  const entries: OrgEntry[] = [];
  let currentDept = '';
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('-')) {
      // Member entry under a dept. Format: -<name>(可选括号说明)
      const after = line.slice(1).trim();
      const parenStart = after.indexOf('（');
      const name = parenStart === -1 ? after : after.slice(0, parenStart).trim();
      const role =
        parenStart === -1
          ? '团队成员'
          : after.slice(parenStart + 1, after.lastIndexOf('）')).trim();
      entries.push({ name, dept: currentDept, role, join_date: null });
    } else if (!line.includes('（老板）')) {
      // Section header
      currentDept = line;
    } else {
      // Boss line — single line, no leading dash in the source.
      const before = line.slice(0, line.indexOf('（'));
      entries.push({ name: before.trim(), dept: '老板', role: '老板', join_date: null });
    }
  }
  return entries;
}

async function listMeetingFiles(): Promise<string[]> {
  try {
    const files = await fs.readdir(PATHS.contextMeeting);
    return files.filter((f) => f.endsWith('.txt')).sort();
  } catch {
    return [];
  }
}

async function readMeeting(filename: string): Promise<string> {
  return fs.readFile(join(PATHS.contextMeeting, filename), 'utf8');
}

function checkAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const err = new Error('Bootstrap aborted by user');
    err.name = 'AbortError';
    throw err;
  }
}

// Phase 1 — produce per-meeting × per-member summaries.
async function runPhase1(
  meetingFiles: string[],
  memberNames: string[],
  signal?: AbortSignal,
  onProgress?: (status: BootstrapStatus) => void
): Promise<Phase1Result[]> {
  const results: Phase1Result[] = [];
  for (let i = 0; i < meetingFiles.length; i++) {
    checkAborted(signal);
    const filename = meetingFiles[i];
    onProgress?.({
      phase: 1,
      current: i + 1,
      total: meetingFiles.length,
      message: `Phase 1: 摘要会议 ${filename}`,
      started_at: new Date().toISOString()
    });
    try {
      const meetingText = await readMeeting(filename);
      const result = await llmJSON<Phase1Result>({
        system: PHASE1_SYSTEM,
        user: phase1UserPrompt(filename, meetingText, memberNames),
        signal,
        // M2.7 reasoning model uses many tokens for <think> chain-of-thought.
        // Keep generous budget so the answer fits AFTER the reasoning.
        maxTokens: 6000,
        temperature: 0.3,
        maxRetries: 2
      });
      results.push(result);
    } catch (err) {
      // One bad meeting should not kill the whole bootstrap. Log and skip.
      console.warn(`[bootstrap phase 1] skipping ${filename}: ${(err as Error).message}`);
    }
  }
  return results;
}

// Phase 2 — for each member, combine relevant phase-1 entries into a full profile.
async function runPhase2(
  targets: BootstrapTarget[],
  phase1Results: Phase1Result[],
  signal?: AbortSignal,
  onProgress?: (status: BootstrapStatus) => void
): Promise<PersonalAgentProfile[]> {
  const profiles: PersonalAgentProfile[] = [];
  for (let i = 0; i < targets.length; i++) {
    checkAborted(signal);
    const target = targets[i];
    onProgress?.({
      phase: 2,
      current: i + 1,
      total: targets.length,
      message: `Phase 2: 抽取 ${target.name} profile`,
      started_at: new Date().toISOString()
    });

    // Filter phase-1 to entries that mention this member.
    type RelevantEntry = { meeting: string; summary: unknown };
    const relevant: RelevantEntry[] = phase1Results
      .map<RelevantEntry | null>((r) => {
        const entry = r.per_member?.[target.name];
        return entry ? { meeting: r.meeting, summary: entry as unknown } : null;
      })
      .filter((e): e is RelevantEntry => e !== null);

    if (relevant.length === 0) {
      // Member never appeared in any meeting. Generate a minimal profile.
      profiles.push(minimalProfile(target));
      continue;
    }

    try {
      const raw = await llmJSON<Record<string, unknown>>({
        system: PHASE2_SYSTEM,
        user: phase2UserPrompt(target.name, target.dept, target.role, target.join_date, relevant),
        signal,
        // M2.7 reasoning may use 3-4k tokens before answer. 6000 leaves room.
        maxTokens: 6000,
        temperature: 0.4,
        maxRetries: 2
      });
      profiles.push(normalizeProfile(raw, target, relevant.map((r) => r.meeting)));
    } catch (err) {
      console.warn(`[bootstrap phase 2] minimal profile for ${target.name}: ${(err as Error).message}`);
      profiles.push(minimalProfile(target));
    }
  }
  return profiles;
}

// Note: bootstrap/extract.ts in v2 is deprecated for primary seeding —
// `bun run seed` writes 24 curated profiles. This path is kept so the
// /api/bootstrap UI button still has something to call. It writes lite-tier
// v2 stubs only; real persona narratives come from seed.ts.

function minimalProfile(t: BootstrapTarget): PersonalAgentProfile {
  return {
    name: t.name,
    dept: (t.dept as PersonalAgentProfile['dept']) ?? '产品',
    role: t.role,
    join_date: t.join_date,
    tier: 'lite',
    bio: '',
    persona: '该成员暂无 evidence。待 evolution 累积。',
    capabilities: { domains: [], skills: [] },
    workload: { active: [], blocked_on: [], hard_constraints: [] },
    energy: { current: 'unknown', evidence: [] },
    collab: { pairs_well_with: [], pairs_poorly_with: [] },
    trajectory: { learning_focus: [], stretch_appetite: 'unknown', evidence: [] },
    transcript_misspellings: [],
    recent_overrides: [],
    recent_praises: [],
    recent_objections: [],
    _meta: {
      schema_version: 2,
      bootstrapped_at: new Date().toISOString(),
      evolution_count: 0,
      source_files: [],
      eligible_for_query: true
    }
  };
}

function normalizeProfile(
  _raw: Record<string, unknown>,
  target: BootstrapTarget,
  sourceFiles: string[]
): PersonalAgentProfile {
  // v2 bootstrap LLM path is deprecated. Return a lite stub with source files.
  return {
    ...minimalProfile(target),
    _meta: {
      schema_version: 2,
      bootstrapped_at: new Date().toISOString(),
      evolution_count: 0,
      source_files: sourceFiles,
      eligible_for_query: true
    }
  };
}

export async function runBootstrap(opts: BootstrapOptions): Promise<{
  profiles: PersonalAgentProfile[];
  meetings_processed: number;
  errors: string[];
}> {
  const { targets, onProgress, signal } = opts;
  const meetingFiles = await listMeetingFiles();
  const errors: string[] = [];

  if (meetingFiles.length === 0) {
    errors.push('No meeting files found in team/context/meeting/');
  }

  const memberNames = targets.map((t) => t.name);

  const phase1 = await runPhase1(meetingFiles, memberNames, signal, onProgress);
  const phase2 = await runPhase2(targets, phase1, signal, onProgress);

  for (const profile of phase2) {
    try {
      await writeProfile(profile);
    } catch (err) {
      errors.push(`write ${profile.name}: ${(err as Error).message}`);
    }
  }

  await appendTimelineEvent({
    ts: new Date().toISOString(),
    type: 'bootstrap',
    summary: `画像生成完成：${phase2.length} 位成员 · 来源 ${meetingFiles.length} 份会议`,
    detail: { agents: phase2.map((p) => p.name), errors }
  });

  onProgress?.({
    phase: 'done',
    current: phase2.length,
    total: phase2.length,
    message: `Bootstrap done: ${phase2.length} agents`,
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString()
  });

  return { profiles: phase2, meetings_processed: meetingFiles.length, errors };
}
