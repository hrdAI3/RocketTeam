import { NextRequest } from 'next/server';
import { runBootstrap, DEFAULT_TARGETS, parseOrgChart, type BootstrapTarget } from '@/bootstrap/extract';
import { deleteAllAgents } from '@/lib/agents';
import type { BootstrapStatus } from '@/types';

export const dynamic = 'force-dynamic';

// POST /api/bootstrap
// Body: { clear?: boolean, targets?: BootstrapTarget[] }
//
// Streams progress events as text/event-stream. The UI's BootstrapModal
// subscribes to this and renders the 2-phase progress bars.
export async function POST(req: NextRequest): Promise<Response> {
  let body: { clear?: boolean; targets?: BootstrapTarget[] } = {};
  try {
    body = (await req.json()) as { clear?: boolean; targets?: BootstrapTarget[] };
  } catch {
    // Empty body OK; use defaults.
  }

  const targets =
    body.targets && body.targets.length > 0
      ? body.targets
      : await resolveDefaultTargets();

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (status: BootstrapStatus, eventName = 'progress') => {
        controller.enqueue(encoder.encode(`event: ${eventName}\ndata: ${JSON.stringify(status)}\n\n`));
      };
      try {
        if (body.clear) {
          const cleared = await deleteAllAgents();
          send({
            phase: 'idle',
            current: 0,
            total: 0,
            message: `Cleared ${cleared} existing agents`,
            started_at: new Date().toISOString()
          });
        }

        const result = await runBootstrap({
          targets,
          signal: req.signal,
          onProgress: (status) => send(status)
        });

        controller.enqueue(
          encoder.encode(
            `event: done\ndata: ${JSON.stringify({
              agents_created: result.profiles.map((p) => p.name),
              meetings_processed: result.meetings_processed,
              errors: result.errors
            })}\n\n`
          )
        );
      } catch (err) {
        controller.enqueue(
          encoder.encode(
            `event: error\ndata: ${JSON.stringify({ error: (err as Error).message })}\n\n`
          )
        );
      } finally {
        controller.close();
      }
    }
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    }
  });
}

// Resolve the bootstrap target list. If org chart is parseable AND contains
// our 4 demo targets, prefer it (so dept/role come from the org chart, not
// from hardcoded fallbacks). Otherwise use DEFAULT_TARGETS.
async function resolveDefaultTargets(): Promise<BootstrapTarget[]> {
  const org = await parseOrgChart();
  if (org.length === 0) return DEFAULT_TARGETS;
  const targetNames = DEFAULT_TARGETS.map((t) => t.name);
  const found = org.filter((e) => targetNames.includes(e.name));
  if (found.length < targetNames.length) {
    // Org chart missing some targets — fall back to hardcoded list, but
    // overlay any role/dept info we did find.
    return DEFAULT_TARGETS.map((t) => {
      const match = found.find((f) => f.name === t.name);
      return match ? { ...t, dept: match.dept, role: match.role } : t;
    });
  }
  return found;
}
