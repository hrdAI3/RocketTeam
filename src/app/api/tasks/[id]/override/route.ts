import { NextRequest, NextResponse } from 'next/server';
import { getTask, saveTask } from '@/lib/tasks';
import { listAgents, updateState, getState } from '@/lib/agents';
import { appendTimelineEvent } from '@/lib/timeline';
import { appendEvent } from '@/lib/events';
import { getToken, postDM } from '@/lib/slack';
import type { EvidenceRef, PMADecisionV2 } from '@/types';

export const dynamic = 'force-dynamic';

interface Params {
  params: { id: string };
}

// POST /api/tasks/:id/override
// Body: { override_to: string, reason?: string }
//
// Per ARCHITECTURE-v2-mirofish § 6.5, an override triggers 4-layer memory writeback.
// We implement layers 1 (episodic — timeline) and 2 (semantic — profile patches)
// inline. Layers 3 (procedural skills) and 4 (reflective sim-replay annotation)
// are deferred to v1.
export async function POST(req: NextRequest, { params }: Params): Promise<Response> {
  try {
    const body = (await req.json()) as { override_to?: string; reason?: string };
    const target = (body.override_to ?? '').trim();
    if (!target) {
      return NextResponse.json({ error: 'override_to required' }, { status: 400 });
    }
    const task = await getTask(params.id);
    if (!task) return NextResponse.json({ error: 'task not found' }, { status: 404 });
    if (!task.decision) {
      return NextResponse.json({ error: '推演未完成，无法改派' }, { status: 400 });
    }

    const oldTop1 =
      'top1' in task.decision
        ? task.decision.top1 ?? null
        : (task.decision as PMADecisionV2).decomposition?.[0]?.assignee ?? null;
    const reason = body.reason?.slice(0, 500) ?? '';
    const now = new Date().toISOString();

    task.status = 'overridden';
    task.override_to = target;
    task.override_reason = reason;
    task.updated_at = now;
    await saveTask(task);

    // Layer 1 · episodic
    const sim_id_ref =
      task.decision && 'sim_replay_id' in task.decision
        ? task.decision.sim_replay_id
        : undefined;
    await appendTimelineEvent({
      ts: now,
      type: 'task_overridden',
      task_id: task.id,
      agent_name: target,
      summary: `${task.id} 被 override: ${oldTop1 ?? '(无)'} → ${target}`,
      detail: { reason, sim_id: sim_id_ref }
    });
    // Mirror into the unified events stream so the Anomaly Engine sees overrides
    // without needing to read the legacy timeline.jsonl.
    await appendEvent({
      ts: now,
      source: 'system',
      type: 'task.overridden',
      subject: { kind: 'task', ref: task.id },
      actor: 'leader',
      evidence: {
        quote: reason,
        fields: { from: oldTop1 ?? null, to: target, sim_id: sim_id_ref }
      }
    });

    // Layer 2 · semantic — patch both profiles' recent_overrides arrays.
    const evidenceForTarget: EvidenceRef = {
      source: 'override',
      source_id: `task/${task.id}`,
      quote: `经理把任务 「${task.description}」 override 给我${reason ? '，原因：' + reason : ''}。`.slice(0, 200),
      extracted_at: now
    };
    // Sweep: remove any prior workload.active entry for this task from ALL
    // profiles except the new target. Then add to target.
    try {
      const allNames = await listAgents();
      for (const n of allNames) {
        if (n === target) continue;
        try {
          const p = await getState(n);
          const before = p.workload?.active ?? [];
          const after = before.filter((a) => (a as { proj_id?: string }).proj_id !== task.id);
          if (after.length !== before.length) {
            await updateState(n, [
              { op: 'replace', path: '/workload/active', value: after }
            ]);
          }
        } catch {
          /* ignore individual sweep failures */
        }
      }
      // Patch target.
      const targetProfile = await getState(target);
      const already = (targetProfile.workload?.active ?? []).some(
        (a) => (a as { proj_id?: string }).proj_id === task.id
      );
      const ops: Array<{ op: string; path: string; value: unknown }> = [
        { op: 'add', path: '/recent_overrides/-', value: evidenceForTarget }
      ];
      if (!already) {
        const next = [
          ...(targetProfile.workload?.active ?? []),
          {
            proj_id: task.id,
            role: `承接（改派）：${task.description.slice(0, 60)}`,
            evidence: [evidenceForTarget]
          }
        ];
        ops.push({ op: 'replace', path: '/workload/active', value: next });
      }
      await updateState(target, ops as Parameters<typeof updateState>[1]);
    } catch (err) {
      console.warn(`[override] could not patch ${target}:`, (err as Error).message);
    }

    if (oldTop1 && oldTop1 !== target) {
      const evidenceForOld: EvidenceRef = {
        source: 'override',
        source_id: `task/${task.id}`,
        quote: `任务「${task.description}」原推荐我，经理 override 给 ${target}${reason ? '，原因：' + reason : ''}。`.slice(0, 200),
        extracted_at: now
      };
      try {
        await updateState(oldTop1, [
          { op: 'add', path: '/recent_overrides/-', value: evidenceForOld }
        ]);
      } catch (err) {
        console.warn(`[override] could not patch ${oldTop1}:`, (err as Error).message);
      }
    }

    // Slack DM the new assignee (and optionally the displaced top1).
    void notifyOverrideAsync(task.id, task.description, task.deadline, target, oldTop1, reason);

    return NextResponse.json(task);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

async function notifyOverrideAsync(
  taskId: string,
  description: string,
  deadline: string | undefined,
  target: string,
  oldTop1: string | null,
  reason: string
): Promise<void> {
  void oldTop1;
  console.log(`[override] notifyOverrideAsync target=${target} task=${taskId}`);
  try {
    const token = await getToken();
    if (!token) {
      console.warn('[override] slack token missing → skip DM');
      return;
    }
    const baseUrl = process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000';
    const targetText =
      `🔄 任务改派给你\n` +
      `任务: ${description}\n` +
      `${deadline ? `死线: ${deadline}\n` : ''}` +
      `${oldTop1 ? `原推荐: ${oldTop1}\n` : ''}` +
      `${reason ? `原因: ${reason}\n` : ''}` +
      `详情: ${baseUrl}/tasks (任务 ID ${taskId})`;
    const ok = await postDM(token, target, targetText).catch((e) => {
      console.warn('[override] postDM threw:', (e as Error).message);
      return false;
    });
    console.log(`[override] postDM target=${target} ok=${ok}`);
  } catch (err) {
    console.warn('[override] slack notify failed:', (err as Error).message);
  }
}
