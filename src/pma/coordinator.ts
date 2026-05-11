// Project Management Agent coordinator. Eng review 3A + 7A.
//
//   1. listAgents()
//   2. for each agent: askAgent(name, "可以接这个吗？") in parallel
//      - Promise.allSettled (one fail does NOT poison the run)
//      - 12s AbortController per call (env: ASK_AGENT_TIMEOUT_MS)
//      - timeouts produce a fallback AgentResponse so synthesis still runs
//   3. PMA synthesis call streams rationale (UI sees tokens arrive)
//   4. decideTop1() applies the deterministic decision rules
//   5. Append timeline event + (optionally) save Task.

import { listAgents, askAgent } from '../lib/agents';
import { llmStream, stripThinkBlocks } from '../lib/llm';
import { decideTop1 } from './decision';
import { PMA_SYSTEM, pmaSynthesisUserPrompt } from './system_prompts';
import { appendTimelineEvent } from '../lib/timeline';
import { saveTask, newTaskId } from '../lib/tasks';
import type { AgentResponse, PMADecision, Task } from '../types/index';

export interface CoordinateOptions {
  taskDescription: string;
  // Optional callback invoked as PMA synthesis tokens stream in. If omitted,
  // the call still runs but UI will see a single response at the end.
  onSynthesisToken?: (token: string) => void;
  // External AbortSignal so an HTTP request that's been canceled by the
  // browser can stop the LLM calls in flight.
  signal?: AbortSignal;
}

export interface CoordinateResult {
  decision: PMADecision;
  task: Task;
  latencies: {
    ask_phase_ms: number;
    synthesis_ms: number;
    total_ms: number;
  };
}

const ASK_TIMEOUT_MS = parseInt(process.env.ASK_AGENT_TIMEOUT_MS ?? '12000', 10);
const SYNTH_TIMEOUT_MS = parseInt(process.env.PMA_SYNTHESIS_TIMEOUT_MS ?? '20000', 10);

function withTimeout(parentSignal: AbortSignal | undefined, ms: number): { signal: AbortSignal; cancel: () => void } {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  if (parentSignal) {
    if (parentSignal.aborted) ctrl.abort();
    else parentSignal.addEventListener('abort', () => ctrl.abort(), { once: true });
  }
  return {
    signal: ctrl.signal,
    cancel: () => clearTimeout(timer)
  };
}

export async function pmaPredictAssignee(opts: CoordinateOptions): Promise<CoordinateResult> {
  const start = Date.now();
  const agents = await listAgents();
  if (agents.length === 0) {
    const decision: PMADecision = {
      task_description: opts.taskDescription,
      top1: null,
      top1_capability: null,
      top1_load: null,
      confidence: 0,
      rationale: '当前没有任何 personal agent 可询问。请先 bootstrap。',
      alternatives: [],
      all_responses: [],
      reason_if_null: 'no_agents',
      ts: new Date().toISOString()
    };
    const task = await persistTask(decision);
    return {
      decision,
      task,
      latencies: { ask_phase_ms: 0, synthesis_ms: 0, total_ms: Date.now() - start }
    };
  }

  // Phase 1: parallel ask. Each call gets its own timeout window.
  // Promise.allSettled is critical — one slow / failing agent must not abort
  // the others. The fallback AgentResponse keeps synthesis honest.
  const askStart = Date.now();
  const askResults = await Promise.allSettled(
    agents.map(async (name) => {
      const { signal, cancel } = withTimeout(opts.signal, ASK_TIMEOUT_MS);
      try {
        return await askAgent(name, opts.taskDescription, signal);
      } finally {
        cancel();
      }
    })
  );
  const askPhaseMs = Date.now() - askStart;

  const responses: AgentResponse[] = askResults.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    const reason = (r.reason as Error)?.message ?? 'unknown failure';
    return {
      agent_name: agents[i],
      capability_fit: null,
      load_fit: null,
      reason: `agent rejected: ${reason}`,
      fallback: true
    };
  });

  // Phase 2: synthesis. Stream tokens to caller as the model thinks.
  const synthStart = Date.now();
  let rationale = '';
  try {
    const { signal, cancel } = withTimeout(opts.signal, SYNTH_TIMEOUT_MS);
    try {
      rationale = await llmStream({
        system: PMA_SYSTEM,
        user: pmaSynthesisUserPrompt(opts.taskDescription, responses),
        signal,
        temperature: 0.5,
        maxTokens: 600,
        onToken: (token) => {
          opts.onSynthesisToken?.(token);
        }
      });
    } finally {
      cancel();
    }
  } catch (err) {
    rationale = `[synthesis failed: ${(err as Error).message}]`;
  }
  const synthMs = Date.now() - synthStart;

  // Apply deterministic decision rules. Strip <think> blocks from rationale —
  // M2.7 emits chain-of-thought that the human user doesn't want to see in
  // the UI. The streamed tokens already showed reasoning; the saved rationale
  // is the answer-only text.
  const decision = decideTop1({
    task_description: opts.taskDescription,
    responses,
    rationale: stripThinkBlocks(rationale)
  });

  const task = await persistTask(decision);

  await appendTimelineEvent({
    ts: decision.ts,
    type: 'task_predicted',
    task_id: task.id,
    agent_name: decision.top1 ?? undefined,
    summary: decision.top1
      ? `${task.id} → ${decision.top1}（置信度 ${(decision.confidence * 100).toFixed(0)}%）`
      : `${task.id} → 无明确合适人选`,
    detail: { reason_if_null: decision.reason_if_null }
  });

  console.log(
    `[pma] task=${task.id} agents=${agents.length} ask=${askPhaseMs}ms synth=${synthMs}ms total=${
      Date.now() - start
    }ms`
  );

  return {
    decision,
    task,
    latencies: { ask_phase_ms: askPhaseMs, synthesis_ms: synthMs, total_ms: Date.now() - start }
  };
}

async function persistTask(decision: PMADecision): Promise<Task> {
  const id = newTaskId();
  const now = new Date().toISOString();
  const task: Task = {
    id,
    description: decision.task_description,
    decision,
    status: 'predicted',
    created_at: now,
    updated_at: now
  };
  await saveTask(task);
  return task;
}
