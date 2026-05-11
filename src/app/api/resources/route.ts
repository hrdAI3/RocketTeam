import { NextRequest } from 'next/server';
import {
  listResources,
  saveResource,
  newResourceId,
  encryptSecret
} from '@/lib/resources';
import type { TeamResource, ResourceType } from '@/types';

export const dynamic = 'force-dynamic';

const VALID_TYPES: ResourceType[] = [
  'account',
  'api_key',
  'license',
  'domain',
  'subscription',
  'cloud',
  'cert',
  'other'
];

export async function GET(): Promise<Response> {
  const resources = await listResources();
  return json({ resources });
}

export async function POST(req: NextRequest): Promise<Response> {
  let body: Partial<TeamResource> & { credential_plaintext?: string } = {};
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid JSON' }, 400);
  }
  const name = (body.name ?? '').trim();
  if (!name) return json({ error: 'name required' }, 400);
  const type = body.type as ResourceType | undefined;
  if (!type || !VALID_TYPES.includes(type)) return json({ error: 'invalid type' }, 400);
  const vendor = (body.vendor ?? '').trim();
  if (!vendor) return json({ error: 'vendor required' }, 400);

  const now = new Date().toISOString();
  const r: TeamResource = {
    id: newResourceId(),
    type,
    name,
    vendor,
    identifier: body.identifier?.trim() || undefined,
    credential_encrypted: body.credential_plaintext?.trim()
      ? encryptSecret(body.credential_plaintext.trim())
      : undefined,
    owners: Array.isArray(body.owners) ? body.owners.filter((x) => typeof x === 'string') : [],
    users_with_access: Array.isArray(body.users_with_access)
      ? body.users_with_access.filter((x) => typeof x === 'string')
      : [],
    monthly_cost_cny:
      typeof body.monthly_cost_cny === 'number' && body.monthly_cost_cny >= 0
        ? body.monthly_cost_cny
        : undefined,
    expires_at:
      typeof body.expires_at === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.expires_at)
        ? body.expires_at
        : undefined,
    metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : undefined,
    notes: body.notes?.trim() || undefined,
    created_at: now,
    updated_at: now
  };
  await saveResource(r);
  // Strip secret before returning.
  const { credential_encrypted: _drop, ...safe } = r;
  return json(safe);
}

function json(data: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}
