// Single-agent single-action LLM call. Used by runner.ts for every cell
// of the simulation matrix (round × track × agent).
//
// Returns a structured AgentAction. On parse failure, returns a fallback
// BID with capability_fit=null so the run can continue.

import { llmCall, tryParseJSON } from '../lib/llm';
import { getState } from '../lib/agents';
import { trackSystem, profileBlock, round1BidPrompt, round2Prompt, round3Prompt, round4ReflectPrompt } from './system_prompts';
import type { AgentAction, AgentActionPayload, ActionType, EvidenceRef, Track, RoundSummary, TeamMemberProfile, SimulationConfig } from '../types/index';

function parseTimeoutEnv(raw: string | undefined, defaultMs: number): number {
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : defaultMs;
}
const PER_CALL_TIMEOUT_MS = parseTimeoutEnv(process.env.PER_CALL_TIMEOUT_MS, 60_000);

export interface ActionContext {
  config: SimulationConfig;
  track: Track;
  agent_name: string;
  round_num: 1 | 2 | 3 | 4;
  round_summaries: { rounds_a: RoundSummary[]; rounds_b: RoundSummary[] };
  current_round_so_far: AgentAction[];
}

function withTimeout(parent: AbortSignal | undefined, ms: number): { signal: AbortSignal; cancel: () => void } {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  if (parent) {
    if (parent.aborted) ctrl.abort();
    else parent.addEventListener('abort', () => ctrl.abort(), { once: true });
  }
  return { signal: ctrl.signal, cancel: () => clearTimeout(timer) };
}

export async function executeAgentAction(
  ctx: ActionContext,
  parentSignal?: AbortSignal
): Promise<AgentAction> {
  const start = Date.now();
  const { config, track, agent_name, round_num, round_summaries, current_round_so_far } = ctx;

  let profile: TeamMemberProfile;
  try {
    profile = await getState(agent_name);
  } catch (err) {
    return makeFallback(ctx, `profile unavailable: ${(err as Error).message}`, Date.now() - start);
  }

  const userPrompt = buildRoundPrompt(round_num, config, round_summaries, current_round_so_far, track, agent_name);
  const system = `${trackSystem(track, config.strategy)}

${profileBlock(profile)}`;

  // Two attempts max — M2.7 sometimes returns malformed JSON or transient
  // network glitches. The second attempt uses the same prompt; the LLM is
  // not deterministic so it may produce a parseable result.
  let text = '';
  let lastErr = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    const { signal, cancel } = withTimeout(parentSignal, PER_CALL_TIMEOUT_MS);
    try {
      text = await llmCall({ system, user: userPrompt, signal, maxTokens: 1200, temperature: 0.5 });
      cancel();
      if (text && text.trim().length > 0) break;
      lastErr = 'empty response';
    } catch (err) {
      cancel();
      lastErr = (err as Error).message ?? 'unknown';
      // AbortError from parent cancellation should not trigger retry.
      if (parentSignal?.aborted) {
        return makeFallback(ctx, 'parent aborted', Date.now() - start);
      }
      // Otherwise retry once (only on attempt 1).
      if (attempt < 2) continue;
      return makeFallback(ctx, `llm error after retry: ${lastErr}`, Date.now() - start);
    }
  }
  if (!text) {
    return makeFallback(ctx, `no text after retry: ${lastErr}`, Date.now() - start);
  }

  const parsed = tryParseJSON<Record<string, unknown>>(text);
  if (!parsed) {
    return makeFallback(ctx, 'agent returned unparseable response', Date.now() - start);
  }

  const action = coerceAction(parsed, agent_name, round_num, track);
  return {
    ...action,
    ts: new Date().toISOString(),
    latency_ms: Date.now() - start
  };
}

function buildRoundPrompt(
  round_num: 1 | 2 | 3 | 4,
  config: SimulationConfig,
  rs: { rounds_a: RoundSummary[]; rounds_b: RoundSummary[] },
  current: AgentAction[],
  track: Track,
  agent_name?: string
): string {
  const rounds = track === 'optimistic' ? rs.rounds_a : rs.rounds_b;
  if (round_num === 1) return round1BidPrompt(config.task_description);

  const r1 = rounds.find((r) => r.round_num === 1);
  const recap1 = r1?.actions.map((a) => formatActionForRecap(a)).join('\n') ?? '(R1 数据缺)';

  if (round_num === 2) {
    const soFar = current.map((a) => formatActionForRecap(a)).join('\n');
    return round2Prompt(config.task_description, config.splittable, recap1, soFar);
  }

  const r2 = rounds.find((r) => r.round_num === 2);
  const recap12 =
    recap1 + '\n\n# Round 2\n' + (r2?.actions.map((a) => formatActionForRecap(a)).join('\n') ?? '(R2 数据缺)');

  if (round_num === 3) {
    const soFar = current.map((a) => formatActionForRecap(a)).join('\n');
    return round3Prompt(config.task_description, recap12, soFar);
  }

  // Round 4 — reflection. Find this agent's R1 BID for delta computation.
  const r3 = rounds.find((r) => r.round_num === 3);
  const recap123 =
    recap12 +
    '\n\n# Round 3\n' +
    (r3?.actions.map((a) => formatActionForRecap(a)).join('\n') ?? '(R3 数据缺)');
  const myR1 = r1?.actions.find((a) => a.agent_name === agent_name && a.action_type === 'BID');
  const myR1Block =
    myR1 && myR1.payload.type === 'BID'
      ? `# 你在 R1 时的 BID\ncapability_fit=${myR1.payload.capability_fit} load_fit=${myR1.payload.load_fit} collab_fit=${myR1.payload.collab_fit}\n理由：${myR1.payload.reason}`
      : '# 你在 R1 没有给出 BID（可能 fallback）';
  return round4ReflectPrompt(config.task_description, recap123, myR1Block);
}

function formatActionForRecap(a: AgentAction): string {
  const p = a.payload;
  switch (p.type) {
    case 'BID':
      return `${a.agent_name}: BID cap=${p.capability_fit} load=${p.load_fit} collab=${p.collab_fit} 「${p.reason}」`;
    case 'DEFER':
      return `${a.agent_name}: DEFER → ${p.recommend} 「${p.reason}」`;
    case 'RECOMMEND_SPLIT':
      return `${a.agent_name}: SPLIT [${p.subtasks
        .map((s) => `${s.subtask}→${s.assignee}`)
        .join(' | ')}]`;
    case 'OBJECT':
      return `${a.agent_name}: OBJECT against「${p.against}」「${p.reason}」`;
    case 'COMMIT':
      return `${a.agent_name}: COMMIT 「${p.subtask}」`;
    case 'REFINED_BID':
      return `${a.agent_name}: REFINED_BID cap=${p.capability_fit}(${p.delta_capability >= 0 ? '+' : ''}${p.delta_capability}) load=${p.load_fit}(${p.delta_load >= 0 ? '+' : ''}${p.delta_load}) collab=${p.collab_fit}(${p.delta_collab >= 0 ? '+' : ''}${p.delta_collab}) 「${p.reason}」`;
  }
}

function coerceAction(
  raw: Record<string, unknown>,
  agent_name: string,
  round_num: 1 | 2 | 3 | 4,
  track: Track
): Omit<AgentAction, 'ts' | 'latency_ms'> {
  const at = raw.action_type as string;
  // Capture evidence_cited the LLM emitted. We trust LLM source_ids here;
  // Report Agent does post-validation against actual profile evidence.
  const evidence: EvidenceRef[] = Array.isArray(raw.evidence_cited)
    ? (raw.evidence_cited as unknown[])
        .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
        .slice(0, 4)
        .map((sid) => ({
          source: sid.startsWith('slack/') ? 'self_report' : 'meeting',
          source_id: sid,
          quote: typeof raw.reason === 'string' ? raw.reason.slice(0, 120) : '',
          extracted_at: new Date().toISOString()
        }))
    : [];
  let payload: AgentActionPayload;
  let actionType: ActionType;

  switch (at) {
    case 'BID':
      actionType = 'BID';
      payload = {
        type: 'BID',
        capability_fit: clamp(raw.capability_fit, 0),
        load_fit: clamp(raw.load_fit, 0),
        collab_fit: clamp(raw.collab_fit, 5),
        reason: typeof raw.reason === 'string' ? raw.reason : ''
      };
      break;
    case 'DEFER':
      actionType = 'DEFER';
      payload = {
        type: 'DEFER',
        recommend: typeof raw.recommend === 'string' ? raw.recommend : '',
        reason: typeof raw.reason === 'string' ? raw.reason : ''
      };
      break;
    case 'RECOMMEND_SPLIT':
      actionType = 'RECOMMEND_SPLIT';
      payload = {
        type: 'RECOMMEND_SPLIT',
        subtasks: Array.isArray(raw.subtasks)
          ? (raw.subtasks as Array<Record<string, unknown>>).slice(0, 6).map((s) => ({
              subtask: String(s.subtask ?? ''),
              assignee: String(s.assignee ?? ''),
              reason: String(s.reason ?? '')
            }))
          : [],
        reason: typeof raw.reason === 'string' ? raw.reason : ''
      };
      break;
    case 'OBJECT':
      actionType = 'OBJECT';
      payload = {
        type: 'OBJECT',
        against: typeof raw.against === 'string' ? raw.against : '',
        reason: typeof raw.reason === 'string' ? raw.reason : ''
      };
      break;
    case 'COMMIT':
      actionType = 'COMMIT';
      payload = {
        type: 'COMMIT',
        subtask: typeof raw.subtask === 'string' ? raw.subtask : '',
        reason: typeof raw.reason === 'string' ? raw.reason : ''
      };
      break;
    case 'REFINED_BID': {
      actionType = 'REFINED_BID';
      const cap = clamp(raw.capability_fit, 0);
      const ld = clamp(raw.load_fit, 0);
      const col = clamp(raw.collab_fit, 5);
      payload = {
        type: 'REFINED_BID',
        capability_fit: cap,
        load_fit: ld,
        collab_fit: col,
        delta_capability: typeof raw.delta_capability === 'number' ? Math.round(raw.delta_capability) : 0,
        delta_load: typeof raw.delta_load === 'number' ? Math.round(raw.delta_load) : 0,
        delta_collab: typeof raw.delta_collab === 'number' ? Math.round(raw.delta_collab) : 0,
        reason: typeof raw.reason === 'string' ? raw.reason : ''
      };
      break;
    }
    default:
      // Unknown action type → fall back to BID with null fits.
      actionType = 'BID';
      payload = { type: 'BID', capability_fit: 0, load_fit: 0, collab_fit: 0, reason: 'unknown action_type' };
  }

  return { round_num, track, agent_name, action_type: actionType, payload, evidence_cited: evidence, success: true };
}

function clamp(n: unknown, def: number): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return def;
  return Math.max(0, Math.min(10, Math.round(n)));
}

function makeFallback(ctx: ActionContext, reason: string, latency_ms: number): AgentAction {
  return {
    round_num: ctx.round_num,
    ts: new Date().toISOString(),
    track: ctx.track,
    agent_name: ctx.agent_name,
    action_type: 'BID',
    payload: { type: 'BID', capability_fit: 0, load_fit: 0, collab_fit: 0, reason: `[fallback] ${reason}` },
    evidence_cited: [],
    latency_ms,
    success: false
  };
}
