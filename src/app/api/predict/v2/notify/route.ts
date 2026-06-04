// POST /api/predict/v2/notify
//   body: { task_id, override_to?, note? }
//
// After leader sees a v2 prediction, they call this to actually push the
// task to the assignee via slack DM. Separation of "predict" from "dispatch"
// keeps prediction read-only and lets leader sanity-check before sending.
//
// Side effects:
//   - slack DM to top1 (or override_to if leader overrode) with task summary
//   - emit `task.assigned` event so calibration can later join outcome
//   - update task status: predicted → accepted

import { NextRequest, NextResponse } from 'next/server';
import { getTask, saveTask } from '@/lib/tasks';
import { getToken, postDM } from '@/lib/slack';
import { appendEvent } from '@/lib/events';
import { appendTimelineEvent } from '@/lib/timeline';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest): Promise<Response> {
  try {
    const body = (await req.json()) as {
      task_id?: string;
      override_to?: string;
      note?: string;
    };
    const task_id = (body.task_id ?? '').trim();
    if (!task_id) return NextResponse.json({ error: 'task_id required' }, { status: 400 });

    const task = await getTask(task_id);
    if (!task) return NextResponse.json({ error: 'task not found' }, { status: 404 });

    const assignee = (body.override_to ?? '').trim() || task.decision?.top1;
    if (!assignee) {
      return NextResponse.json(
        { error: 'no assignee — prediction returned null and no override_to provided' },
        { status: 400 }
      );
    }

    // Compose slack DM
    const lines: string[] = [];
    lines.push(`📌 *新任务派发* (${task_id})`);
    lines.push(`> ${task.description}`);
    if (task.decision && 'calibrated_confidence' in task.decision) {
      const conf = (task.decision.calibrated_confidence * 100).toFixed(0);
      lines.push(`系统推荐你承接, 置信度 ${conf}%。`);
    }
    if (task.decision?.alternatives && task.decision.alternatives.length > 0) {
      lines.push(`备选承接人: ${task.decision.alternatives.join(', ')}`);
    }
    if (task.decision && 'fingerprint' in task.decision && task.decision.fingerprint) {
      const fp = task.decision.fingerprint;
      if (fp.est_effort_days) lines.push(`预估工作量: ${fp.est_effort_days} 人天`);
      if (fp.risk_topics?.length) lines.push(`风险主题: ${fp.risk_topics.join(', ')}`);
    }
    // Trajectory hint for top1 only — leader's "预防针"
    if (task.decision && 'candidates' in task.decision) {
      const cand = task.decision.candidates.find((c) => c.name === assignee);
      const traj = cand?.score_trajectory;
      if (traj && traj.predicted_stuck_topics.length > 0) {
        const hint = traj.predicted_stuck_topics
          .map((s) => `${s.topic} ${(s.p * 100).toFixed(0)}%`)
          .join(', ');
        lines.push(`⚠️ 预测卡点: ${hint} — 建议先排查`);
      }
    }
    if (body.note) lines.push(`\nLeader 备注: ${body.note}`);
    lines.push(`\n回复 "收到" 或在团队 UI 上接受 / 拒绝。`);
    const text = lines.join('\n');

    // Send via slack
    const token = await getToken();
    let dm_sent = false;
    let dm_error: string | undefined;
    if (!token) {
      dm_error = 'no slack token configured';
    } else {
      try {
        dm_sent = await postDM(token, assignee, text);
        if (!dm_sent) dm_error = 'postDM returned false (no slack mapping for name?)';
      } catch (err) {
        dm_error = (err as Error).message;
      }
    }

    // Persist override + bump status
    const now = new Date().toISOString();
    if (body.override_to && body.override_to !== task.decision?.top1) {
      task.override_to = body.override_to;
      task.override_reason = body.note ?? 'leader override at notify time';
    }
    task.status = 'accepted'; // leader has acted on prediction
    task.updated_at = now;
    await saveTask(task);

    // Emit task.assigned event for calibration loop
    await appendEvent({
      source: 'system',
      type: 'task.assigned',
      subject: { kind: 'task', ref: task_id },
      actor: assignee,
      evidence: {
        fields: {
          assignee,
          predicted_top1: task.decision?.top1 ?? null,
          override: !!body.override_to,
          dm_sent,
          dm_error,
          note: body.note ?? null
        }
      }
    });

    await appendTimelineEvent({
      ts: now,
      type: 'task_dispatched',
      task_id,
      agent_name: assignee,
      summary: `${task_id} 派给 ${assignee}${body.override_to ? ' (leader 覆盖)' : ''}${
        dm_sent ? ' ✓ slack 已送达' : dm_error ? ` ✗ ${dm_error}` : ''
      }`
    });

    return NextResponse.json({
      task_id,
      assignee,
      dm_sent,
      dm_error: dm_error ?? null,
      task
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
