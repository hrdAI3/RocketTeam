import { NextRequest, NextResponse } from 'next/server';
import { computeEvolutionDiff, applyEvolutionDiff } from '@/evolution/diff';
import type { EvolutionDiff } from '@/types';

export const dynamic = 'force-dynamic';

// POST /api/evolution?action=preview
// Body: { agent_name: string, context: string }
// Returns: EvolutionDiff (no write).
//
// POST /api/evolution?action=apply
// Body: EvolutionDiff (the previewed diff, possibly user-edited).
// Writes updated profile and appends timeline event.
export async function POST(req: NextRequest): Promise<Response> {
  const url = new URL(req.url);
  const action = url.searchParams.get('action') ?? 'preview';

  try {
    if (action === 'preview') {
      const body = (await req.json()) as { agent_name?: string; context?: string };
      if (!body.agent_name || !body.context) {
        return NextResponse.json(
          { error: 'agent_name and context required' },
          { status: 400 }
        );
      }
      const diff = await computeEvolutionDiff(body.agent_name, body.context, req.signal);
      return NextResponse.json(diff);
    }

    if (action === 'apply') {
      const body = (await req.json()) as EvolutionDiff;
      if (!body.agent_name || !Array.isArray(body.patches)) {
        return NextResponse.json({ error: 'invalid diff body' }, { status: 400 });
      }
      const next = await applyEvolutionDiff(body.agent_name, body);
      return NextResponse.json(next);
    }

    return NextResponse.json({ error: `unknown action: ${action}` }, { status: 400 });
  } catch (err) {
    const msg = (err as Error).message;
    const status = msg.includes('not allowed') ? 422 : msg.includes('not found') ? 404 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}
