// PMA v2 prediction endpoint. Replaces /api/tasks for the "dispatch from
// inside a CC session" workflow — leader types a slash command, that
// command POSTs here, response renders in their CC chat.
//
// POST /api/predict/v2
//   body: { description, importance?, urgency?, stream? }
//
// Returns PMADecisionV2 (JSON) or, when stream=true, a text/event-stream
// where data: lines are synthesis tokens and the final event is `done`
// with the full decision payload.

import { NextRequest, NextResponse } from 'next/server';
import { pmaPredictV2 } from '@/pma/coordinator_v2';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest): Promise<Response> {
  try {
    const body = (await req.json()) as {
      description?: string;
      importance?: 'high' | 'low';
      urgency?: 'high' | 'low';
      stream?: boolean;
      task_id?: string;
    };
    const description = (body.description ?? '').trim();
    if (!description) {
      return NextResponse.json({ error: 'description required' }, { status: 400 });
    }
    if (description.length > 4000) {
      return NextResponse.json(
        { error: 'description too long (max 4000 chars)' },
        { status: 400 }
      );
    }
    const task_id = body.task_id ?? `cc-${Date.now().toString(36)}`;

    if (body.stream) {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          try {
            const decision = await pmaPredictV2({
              task_id,
              description,
              importance: body.importance,
              urgency: body.urgency,
              signal: req.signal,
              onSynthesisToken: (token) => {
                controller.enqueue(
                  encoder.encode(`data: ${JSON.stringify({ type: 'token', token })}\n\n`)
                );
              }
            });
            controller.enqueue(
              encoder.encode(
                `event: done\ndata: ${JSON.stringify({ type: 'done', decision })}\n\n`
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

    const decision = await pmaPredictV2({
      task_id,
      description,
      importance: body.importance,
      urgency: body.urgency,
      signal: req.signal
    });
    return NextResponse.json({ decision });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
