import { NextRequest, NextResponse } from 'next/server';
import { getTask, saveTask } from '@/lib/tasks';
import { getState, updateState } from '@/lib/agents';
import { appendTimelineEvent } from '@/lib/timeline';
import { appendEvent } from '@/lib/events';
import { getToken, postDM } from '@/lib/slack';
import type { PMADecisionV2, EvidenceRef } from '@/types';

export const dynamic = 'force-dynamic';

interface Params {
  params: { id: string };
}

// POST /api/tasks/:id/accept
// Body: {} — no body required.
// Marks task status = 'accepted'. Idempotent.
export async function POST(_req: NextRequest, { params }: Params): Promise<Response> {
  const task = await getTask(params.id);
  if (!task) return NextResponse.json({ error: 'task not found' }, { status: 404 });
  if (task.status === 'accepted') {
    return NextResponse.json(task);
  }
  if (task.status === 'overridden') {
    return NextResponse.json({ error: '任务已被改派，无法直接采纳' }, { status: 400 });
  }
  if (!task.decision) {
    return NextResponse.json({ error: '推演未完成，无法采纳' }, { status: 400 });
  }

  const now = new Date().toISOString();
  task.status = 'accepted';
  task.updated_at = now;
  await saveTask(task);

  // Collect every assignee (top1 OR all decomposition.assignee).
  const assignees = new Set<string>();
  const v2 = task.decision as PMADecisionV2;
  if (v2.decomposition && v2.decomposition.length > 0) {
    for (const s of v2.decomposition) {
      if (s.assignee) assignees.add(s.assignee);
    }
  } else if ('top1' in task.decision && task.decision.top1) {
    assignees.add(task.decision.top1);
  }

  // Append to each assignee's workload.active (so /agents reflects reality).
  for (const name of assignees) {
    try {
      const profile = await getState(name);
      const already = (profile.workload?.active ?? []).some(
        (a) => (a as { proj_id?: string }).proj_id === task.id
      );
      if (already) continue;
      const evidence: EvidenceRef = {
        source: 'task_outcome',
        source_id: `task/${task.id}`,
        quote: `承接：${task.description.slice(0, 120)}`,
        extracted_at: now
      };
      const role = `承接任务 ${task.id}：${task.description.slice(0, 60)}`;
      const next = [
        ...(profile.workload?.active ?? []),
        { proj_id: task.id, role, evidence: [evidence] }
      ];
      await updateState(name, [
        { op: 'replace', path: '/workload/active', value: next }
      ]);
    } catch (err) {
      console.warn(`[accept] failed to update ${name} workload:`, (err as Error).message);
    }
  }

  const top1 =
    task.decision && 'top1' in task.decision
      ? task.decision.top1 ?? null
      : v2.decomposition?.[0]?.assignee ?? null;

  await appendTimelineEvent({
    ts: now,
    type: 'task_accepted',
    task_id: task.id,
    agent_name: top1 ?? undefined,
    summary: `${task.id} 已采纳：${[...assignees].join('、') || '(未指派)'}`
  });
  // Mirror into the unified events stream so the Anomaly Engine sees accepts.
  await appendEvent({
    ts: now,
    source: 'system',
    type: 'task.accepted',
    subject: { kind: 'task', ref: task.id },
    actor: 'leader',
    evidence: { fields: { assignees: [...assignees], top1: top1 ?? null } }
  });

  // Fire Slack DM to each assignee. Non-blocking — UI returns even if Slack fails.
  void notifyAssigneesAsync(task.id, task.description, task.deadline, [...assignees]);

  return NextResponse.json(task);
}

async function notifyAssigneesAsync(
  taskId: string,
  description: string,
  deadline: string | undefined,
  names: string[]
): Promise<void> {
  try {
    const token = await getToken();
    if (!token) return; // slack not connected
    const baseUrl = process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000';
    for (const name of names) {
      const text =
        `🚀 你被指派新任务\n` +
        `任务: ${description}\n` +
        `${deadline ? `死线: ${deadline}\n` : ''}` +
        `详情: ${baseUrl}/tasks (任务 ID ${taskId})`;
      await postDM(token, name, text).catch(() => false);
    }
  } catch (err) {
    console.warn('[accept] slack notify failed:', (err as Error).message);
  }
}
