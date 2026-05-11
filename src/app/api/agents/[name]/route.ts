import { NextRequest, NextResponse } from 'next/server';
import { getState, updateState } from '@/lib/agents';
import { parseOrgChart } from '@/bootstrap/extract';
import type { Operation } from 'fast-json-patch';

export const dynamic = 'force-dynamic';

interface Params {
  params: { name: string };
}

export async function GET(_req: NextRequest, { params }: Params): Promise<Response> {
  try {
    const name = decodeURIComponent(params.name);
    const [profile, org] = await Promise.all([getState(name), parseOrgChart()]);
    const orgEntry = org.find((e) => e.name === name);
    if (orgEntry) {
      return NextResponse.json({
        ...profile,
        dept: orgEntry.dept || profile.dept,
        role: orgEntry.role || profile.role
      });
    }
    return NextResponse.json(profile);
  } catch (err) {
    const msg = (err as Error).message;
    const status = msg.includes('not found') ? 404 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}

export async function PATCH(req: NextRequest, { params }: Params): Promise<Response> {
  try {
    const body = (await req.json()) as { patches?: Operation[] };
    if (!Array.isArray(body.patches)) {
      return NextResponse.json({ error: 'body.patches must be an array of JSON Patch ops' }, { status: 400 });
    }
    const next = await updateState(decodeURIComponent(params.name), body.patches);
    return NextResponse.json(next);
  } catch (err) {
    const msg = (err as Error).message;
    const status = msg.includes('not allowed') ? 422 : msg.includes('not found') ? 404 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}
