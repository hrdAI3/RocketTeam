import { NextRequest } from 'next/server';
import { computeEvolutionDiff } from '@/evolution/diff';
import { listAgents, getState } from '@/lib/agents';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// POST /api/evolution/multi-preview
// Body: { context: string }
// Streams SSE events: candidate (per agent considered) → diff (per agent with changes) → done
//
// Strategy: only run diff for agents whose name appears in the context, plus all
// 'deep' tier agents (they care about everything). Skip stub-tier (no baseline to
// compare against). Cap total to 8 agents to bound cost.
export async function POST(req: NextRequest): Promise<Response> {
  let body: { context?: string } = {};
  try {
    body = (await req.json()) as { context?: string };
  } catch {
    return new Response(JSON.stringify({ error: 'invalid JSON' }), { status: 400 });
  }
  const context = (body.context ?? '').trim();
  if (!context) {
    return new Response(JSON.stringify({ error: 'context required' }), { status: 400 });
  }

  // Pick candidate agents.
  const allNames = await listAgents();
  const profiles = await Promise.all(
    allNames.map(async (n) => {
      try {
        return await getState(n);
      } catch {
        return null;
      }
    })
  );
  const valid = profiles.filter((p): p is NonNullable<typeof p> => Boolean(p));
  const mentioned = new Set<string>();
  for (const p of valid) {
    if (context.includes(p.name)) mentioned.add(p.name);
    for (const alias of p.transcript_misspellings ?? []) {
      if (alias && context.includes(alias)) mentioned.add(p.name);
    }
  }
  // Add deep tier agents (top eligibility — they're load-bearing).
  for (const p of valid) {
    if (p.tier === 'deep') mentioned.add(p.name);
  }
  const candidates = valid.filter((p) => mentioned.has(p.name)).slice(0, 8);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          /* closed */
        }
      };

      send('start', { candidates: candidates.map((c) => c.name), total: candidates.length });

      // Run sequentially to bound concurrent LLM load.
      for (const p of candidates) {
        send('candidate', { agent_name: p.name });
        try {
          const diff = await computeEvolutionDiff(p.name, context, req.signal);
          if (diff.patches.length > 0) {
            send('diff', { agent_name: p.name, diff });
          } else {
            send('no_change', { agent_name: p.name });
          }
        } catch (err) {
          send('agent_error', { agent_name: p.name, error: (err as Error).message });
        }
      }

      send('done', {});
      controller.close();
    },
    cancel() {
      // Client closed — abort already propagated via req.signal.
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
