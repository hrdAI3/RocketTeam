import { NextRequest } from 'next/server';
import {
  getResource,
  saveResource,
  deleteResource,
  encryptSecret
} from '@/lib/resources';
import type { TeamResource } from '@/types';

export const dynamic = 'force-dynamic';

interface Params {
  params: { id: string };
}

export async function GET(_req: NextRequest, { params }: Params): Promise<Response> {
  const r = await getResource(params.id);
  if (!r) return json({ error: 'not found' }, 404);
  return json(r);
}

export async function PATCH(req: NextRequest, { params }: Params): Promise<Response> {
  const existing = await getResource(params.id, true);
  if (!existing) return json({ error: 'not found' }, 404);

  let body: Partial<TeamResource> & { credential_plaintext?: string } = {};
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid JSON' }, 400);
  }

  const next: TeamResource = {
    ...existing,
    name: body.name?.trim() || existing.name,
    vendor: body.vendor?.trim() || existing.vendor,
    identifier: body.identifier !== undefined ? body.identifier?.trim() || undefined : existing.identifier,
    owners: Array.isArray(body.owners) ? body.owners.filter((x) => typeof x === 'string') : existing.owners,
    users_with_access: Array.isArray(body.users_with_access)
      ? body.users_with_access.filter((x) => typeof x === 'string')
      : existing.users_with_access,
    monthly_cost_cny:
      typeof body.monthly_cost_cny === 'number' ? body.monthly_cost_cny : existing.monthly_cost_cny,
    expires_at:
      body.expires_at !== undefined
        ? typeof body.expires_at === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.expires_at)
          ? body.expires_at
          : undefined
        : existing.expires_at,
    metadata: body.metadata !== undefined ? body.metadata : existing.metadata,
    notes: body.notes !== undefined ? body.notes?.trim() || undefined : existing.notes,
    updated_at: new Date().toISOString()
  };
  if (body.credential_plaintext !== undefined) {
    next.credential_encrypted = body.credential_plaintext.trim()
      ? encryptSecret(body.credential_plaintext.trim())
      : undefined;
  }
  await saveResource(next);
  const { credential_encrypted: _drop, ...safe } = next;
  return json(safe);
}

export async function DELETE(_req: NextRequest, { params }: Params): Promise<Response> {
  await deleteResource(params.id);
  return json({ ok: true });
}

function json(data: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}
