import { NextRequest } from 'next/server';
import { runSimulation, newSimulationId } from '@/sim/runner';
import { synthesizeDecision } from '@/report/agent';
import { saveTask, newTaskId } from '@/lib/tasks';
import { publish } from '@/sim/event_bus';
import type { Task, TaskBrief, QualityBar } from '@/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

interface StartBody {
  description?: string;
  start_at?: string;
  deadline?: string;
  estimated_effort_days?: number;
  quality_bar?: QualityBar;
  importance?: 'high' | 'low';
  urgency?: 'high' | 'low';
  dependencies?: string[];
  inputs_ready?: boolean;
  failure_cost?: 'soft' | 'hard';
  stakeholders?: string[];
}

// POST /api/sim/start
// Body: TaskBrief (description required, others optional)
// Returns: { sim_id, task_id } immediately, then runs in background.
// Live events streamed via GET /api/sim/[id]/stream.
export async function POST(req: NextRequest): Promise<Response> {
  let body: StartBody = {};
  try {
    body = (await req.json()) as StartBody;
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 });
  }
  const description = (body.description ?? '').trim();
  if (!description) {
    return new Response(JSON.stringify({ error: 'description required' }), { status: 400 });
  }
  if (/[À-ÿ]{2,}/.test(description) || /�/.test(description)) {
    return new Response(
      JSON.stringify({
        error: 'description contains invalid encoding (expected UTF-8). Resend with UTF-8 charset.'
      }),
      { status: 400, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
    );
  }

  const brief: TaskBrief = {
    description,
    start_at: body.start_at,
    deadline: body.deadline,
    estimated_effort_days:
      typeof body.estimated_effort_days === 'number' ? body.estimated_effort_days : undefined,
    quality_bar: body.quality_bar,
    importance: body.importance,
    urgency: body.urgency,
    dependencies: Array.isArray(body.dependencies) ? body.dependencies : undefined,
    inputs_ready: typeof body.inputs_ready === 'boolean' ? body.inputs_ready : undefined,
    failure_cost: body.failure_cost,
    stakeholders: Array.isArray(body.stakeholders) ? body.stakeholders : undefined
  };

  const task_id = newTaskId();
  const sim_id = newSimulationId();

  // Persist a placeholder Task immediately so it shows on the board as "推演中".
  // The decision field is null until Report Agent fills it in.
  const initialNow = new Date().toISOString();
  const placeholder: Task = {
    ...brief,
    id: task_id,
    decision: null,
    status: 'predicting',
    sim_id,
    created_at: initialNow,
    updated_at: initialNow
  };
  await saveTask(placeholder).catch((err) => {
    console.warn('[sim/start] failed to write placeholder task:', (err as Error).message);
  });

  // Background run. Hold a module-scope reference so Node does not GC the
  // pending promise after we return the response (Next.js Node runtime can
  // abandon dangling promises if no one keeps a reference).
  console.log(`[sim/start] kicking off ${sim_id} for task ${task_id}`);
  const work = (async () => {
    console.log(`[sim/start] background work entered for ${sim_id}`);
    try {
      const state = await runSimulation({
        sim_id,
        task_id,
        task_description: description,
        importance: brief.importance,
        urgency: brief.urgency,
        estimated_effort_days: brief.estimated_effort_days,
        quality_bar: brief.quality_bar,
        onEvent: (e) => {
          publish(e.sim_id, e);
        }
      });

      publish(state.sim_id, { type: 'synthesizing', sim_id: state.sim_id });
      const decision = await synthesizeDecision(state, undefined, brief);

      const now = new Date().toISOString();
      const task: Task = {
        ...brief,
        id: task_id,
        decision,
        status: 'predicted',
        sim_id,
        created_at: placeholder.created_at,
        updated_at: now
      };
      await saveTask(task);

      publish(state.sim_id, { type: 'decision', sim_id: state.sim_id, task });
      publish(state.sim_id, { type: 'done', sim_id: state.sim_id, task_id });
    } catch (err) {
      const message = (err as Error).message;
      console.error(`[sim/start] background run ${sim_id} failed:`, message);
      publish(sim_id, { type: 'error', sim_id, error: message });
      // Mark placeholder as failed so the task board doesn't show "推演中" forever.
      try {
        const { getTask } = await import('@/lib/tasks');
        const existing = await getTask(task_id);
        if (existing && existing.status === 'predicting') {
          existing.status = 'completed';
          existing.updated_at = new Date().toISOString();
          await saveTask(existing);
        }
      } catch {
        /* ignore */
      }
    }
  })();

  return new Response(JSON.stringify({ sim_id, task_id }), {
    headers: { 'Content-Type': 'application/json' }
  });
}
