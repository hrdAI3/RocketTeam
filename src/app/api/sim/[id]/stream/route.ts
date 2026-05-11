import { NextRequest } from 'next/server';
import { subscribe, isTerminal } from '@/sim/event_bus';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// GET /api/sim/[id]/stream
// SSE stream of live events for a running推演. Replays buffered events on connect,
// then pushes new events as they happen. Terminates when the run finishes.
export async function GET(req: NextRequest, { params }: { params: { id: string } }): Promise<Response> {
  const sim_id = params.id;
  const encoder = new TextEncoder();
  const sub = subscribe(sim_id);

  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          /* stream closed */
        }
      };

      // Replay buffered events first.
      for (const e of sub.buffered) send(e.type, e);

      if (isTerminal(sim_id)) {
        // Already finished — close after replay.
        sub.unsubscribe();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
        return;
      }

      // Live forwarding.
      sub.on((e) => {
        send(e.type, e);
        if (e.type === 'done' || e.type === 'error' || e.type === 'sim_failed') {
          sub.unsubscribe();
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        }
      });

      // Detach if client disconnects.
      req.signal.addEventListener('abort', () => {
        sub.unsubscribe();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },
    cancel() {
      sub.unsubscribe();
    }
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive'
    }
  });
}
