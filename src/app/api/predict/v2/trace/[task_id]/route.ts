// GET /api/predict/v2/trace/<task_id>
//
// Returns the full PMADecisionV2, behavior snapshots used at predict time,
// and related events. Trace UI uses all three to render the reasoning chain.

import { NextResponse } from 'next/server';
import { getTask } from '@/lib/tasks';
import { readEvents } from '@/lib/events';
import { loadOrBuildSnapshots } from '@/predict/snapshot_loader';

export const dynamic = 'force-dynamic';

export async function GET(
  _req: Request,
  ctx: { params: { task_id: string } }
): Promise<Response> {
  try {
    const { task_id } = ctx.params;
    const task = await getTask(task_id);
    if (!task) return NextResponse.json({ error: 'task not found' }, { status: 404 });

    const events = await readEvents({ subjectKind: 'task', subjectRef: task_id });

    // Load whichever snapshot file the prediction used. We don't pin to that
    // exact file yet (path stored in behavior_snapshot_ref); fall back to
    // current latest. Acceptable until M3.C calibration adds per-task pin.
    const bundle = await loadOrBuildSnapshots({ windowDays: 30 });
    const snapshots = Object.fromEntries(bundle.snapshots);

    return NextResponse.json({
      task,
      events,
      snapshots,
      snapshot_meta: {
        as_of: bundle.as_of,
        window_days: bundle.window_days,
        source_path: bundle.source_path
      }
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
