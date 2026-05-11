import { NextRequest, NextResponse } from 'next/server';
import { listTasks } from '@/lib/tasks';
import { pmaPredictAssignee } from '@/pma/coordinator';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  try {
    const tasks = await listTasks();
    return NextResponse.json({ tasks });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

// POST /api/tasks
// Body: { description: string, stream?: boolean }
//
// If stream=true, returns a text/event-stream where each `data:` line is
// a chunk of the PMA synthesis. The final event is `event: done` with the
// full PMADecision JSON. The UI uses this for the "watch tokens arrive"
// effect; CLI / non-streaming clients can omit `stream`.
export async function POST(req: NextRequest): Promise<Response> {
  try {
    const body = (await req.json()) as { description?: string; stream?: boolean };
    const description = (body.description ?? '').trim();
    if (!description) {
      return NextResponse.json({ error: 'description required' }, { status: 400 });
    }
    if (description.length > 4000) {
      return NextResponse.json({ error: 'description too long (max 4000 chars)' }, { status: 400 });
    }

    if (body.stream) {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          try {
            const result = await pmaPredictAssignee({
              taskDescription: description,
              signal: req.signal,
              onSynthesisToken: (token) => {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'token', token })}\n\n`));
              }
            });
            controller.enqueue(
              encoder.encode(`event: done\ndata: ${JSON.stringify({ type: 'done', task: result.task, latencies: result.latencies })}\n\n`)
            );
          } catch (err) {
            controller.enqueue(
              encoder.encode(`event: error\ndata: ${JSON.stringify({ error: (err as Error).message })}\n\n`)
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

    const result = await pmaPredictAssignee({ taskDescription: description, signal: req.signal });
    return NextResponse.json({ task: result.task, latencies: result.latencies });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
