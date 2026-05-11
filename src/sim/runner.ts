// MiroFish-style 4-round dual-track simulation runner.
//
// Round 0: config_generator picks eligible pool + splittable
// Round 1: BID — parallel within track, both tracks run concurrently
// Round 2: DEFER + RECOMMEND_SPLIT — sequential within track (each agent sees prior R2 actions)
// Round 3: OBJECT + COMMIT — sequential within track; converges if all COMMIT/DEFER + no OBJECT
// Round 4 (Report Agent) handled in src/report/agent.ts
//
// Persists SimulationRunState to team/sim-replays/{sim_id}.json after each round.

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { PATHS } from '../lib/paths';
import { appendTimelineEvent } from '../lib/timeline';
import { atomicWriteJSON } from '../_lib/file-io';
import { generateSimConfig } from './config_generator';
import { executeAgentAction } from './action_executor';
import { isCancelled } from './event_bus';
import type { SimulationConfig, SimulationRunState, RoundSummary, AgentAction, Track } from '../types/index';

export type SimEvent =
  | { type: 'sim_started'; sim_id: string; config: SimulationConfig }
  | { type: 'round_started'; sim_id: string; round_num: 1 | 2 | 3 | 4; track: Track }
  | { type: 'action'; sim_id: string; action: AgentAction }
  | { type: 'round_completed'; sim_id: string; round_num: 1 | 2 | 3 | 4; track: Track }
  | { type: 'sim_completed'; sim_id: string; state: SimulationRunState }
  | { type: 'sim_failed'; sim_id: string; error: string };

export interface RunSimulationOptions {
  task_id: string;
  task_description: string;
  // Optional pre-allocated sim_id. When omitted the runner generates one.
  // Pass-in case: caller wants to subscribe to the event bus before runner starts.
  sim_id?: string;
  // Eisenhower + brief metadata — passed through to config_generator so the
  // PMA can bias eligibility based on quadrant + effort + quality.
  importance?: 'high' | 'low';
  urgency?: 'high' | 'low';
  estimated_effort_days?: number;
  quality_bar?: 'demo' | 'internal' | 'external';
  onEvent?: (event: SimEvent) => void;
  signal?: AbortSignal;
}

const SIM_REPLAYS_DIR = PATHS.simReplays;

function newSimId(): string {
  return `sim_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

async function persistSim(state: SimulationRunState): Promise<void> {
  await atomicWriteJSON(join(SIM_REPLAYS_DIR, `${state.sim_id}.json`), state);
}

export async function readSimReplay(sim_id: string): Promise<SimulationRunState | null> {
  try {
    const raw = await fs.readFile(join(SIM_REPLAYS_DIR, `${sim_id}.json`), 'utf8');
    return JSON.parse(raw) as SimulationRunState;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

async function runRoundForTrack(
  config: SimulationConfig,
  state: SimulationRunState,
  track: Track,
  round_num: 1 | 2 | 3 | 4,
  parallel: boolean,
  opts: RunSimulationOptions
): Promise<RoundSummary> {
  opts.onEvent?.({ type: 'round_started', sim_id: state.sim_id, round_num, track });
  const startTs = new Date().toISOString();
  const actions: AgentAction[] = [];

  if (parallel) {
    const settled = await Promise.allSettled(
      config.eligible_agents.map((agent_name) =>
        executeAgentAction(
          {
            config,
            track,
            agent_name,
            round_num,
            round_summaries: { rounds_a: state.rounds_a, rounds_b: state.rounds_b },
            current_round_so_far: []
          },
          opts.signal
        )
      )
    );
    for (const r of settled) {
      if (r.status === 'fulfilled') {
        actions.push(r.value);
        opts.onEvent?.({ type: 'action', sim_id: state.sim_id, action: r.value });
      }
    }
  } else {
    for (const agent_name of config.eligible_agents) {
      try {
        const a = await executeAgentAction(
          {
            config,
            track,
            agent_name,
            round_num,
            round_summaries: { rounds_a: state.rounds_a, rounds_b: state.rounds_b },
            current_round_so_far: actions
          },
          opts.signal
        );
        actions.push(a);
        opts.onEvent?.({ type: 'action', sim_id: state.sim_id, action: a });
      } catch (err) {
        console.warn(`[sim] ${agent_name} R${round_num} ${track} failed: ${(err as Error).message}`);
      }
    }
  }

  const endTs = new Date().toISOString();
  // R3 converges when everyone COMMITs or DEFERs. R4 (reflection) is always
  // marked converged once it emits — it's the consolidation pass.
  const converged =
    (round_num === 3 && actions.every((a) => a.action_type === 'COMMIT' || a.action_type === 'DEFER')) ||
    round_num === 4;
  const summary: RoundSummary = {
    round_num,
    track,
    start_ts: startTs,
    end_ts: endTs,
    active_agents: config.eligible_agents,
    actions,
    converged
  };

  if (track === 'optimistic') state.rounds_a.push(summary);
  else state.rounds_b.push(summary);

  opts.onEvent?.({ type: 'round_completed', sim_id: state.sim_id, round_num, track });
  await persistSim(state);
  return summary;
}

export function newSimulationId(): string {
  return newSimId();
}

export async function runSimulation(opts: RunSimulationOptions): Promise<SimulationRunState> {
  const sim_id = opts.sim_id ?? newSimId();
  const config = await generateSimConfig({
    task_id: opts.task_id,
    task_description: opts.task_description,
    importance: opts.importance,
    urgency: opts.urgency,
    estimated_effort_days: opts.estimated_effort_days,
    quality_bar: opts.quality_bar
  });
  const state: SimulationRunState = {
    sim_id,
    status: 'running',
    config,
    current_round: 0,
    rounds_a: [],
    rounds_b: [],
    started_at: new Date().toISOString()
  };
  opts.onEvent?.({ type: 'sim_started', sim_id, config });
  await appendTimelineEvent({
    ts: state.started_at,
    type: 'sim_started',
    sim_id,
    task_id: opts.task_id,
    summary: `推演 ${sim_id} 启动 · ${config.eligible_agents.length} 位候选成员 · ${config.splittable ? '可拆分' : '单人承接'}`,
    detail: { eligible: config.eligible_agents }
  });
  await persistSim(state);

  try {
    // Single-strategy mode (replaces dual-track optimistic/skeptical).
    // Number of rounds depends on chosen strategy:
    //   concentrated (P0): 3 rounds — quick converge
    //   delegate (P1): 2 rounds — fast handoff
    //   stretch_review (P2): 4 rounds — full deliberation + reflection
    //   ai_batch (P3): 2 rounds — capacity check
    const totalRounds = config.rounds;
    for (let r = 1; r <= totalRounds; r++) {
      if (isCancelled(sim_id)) {
        throw new Error('用户取消推演');
      }
      state.current_round = r;
      await runRoundForTrack(
        config,
        state,
        'optimistic',
        r as 1 | 2 | 3 | 4,
        r === 1,
        opts
      );
    }

    state.status = 'completed';
    state.finished_at = new Date().toISOString();
    await persistSim(state);
    await appendTimelineEvent({
      ts: state.finished_at,
      type: 'sim_completed',
      sim_id,
      task_id: opts.task_id,
      summary: `推演 ${sim_id} 完成 · 共 ${state.rounds_a.length + state.rounds_b.length} 轮记录`
    });
    opts.onEvent?.({ type: 'sim_completed', sim_id, state });
    return state;
  } catch (err) {
    state.status = 'failed';
    state.error = (err as Error).message;
    state.finished_at = new Date().toISOString();
    await persistSim(state);
    opts.onEvent?.({ type: 'sim_failed', sim_id, error: state.error });
    throw err;
  }
}
