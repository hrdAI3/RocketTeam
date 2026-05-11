// Team resource registry. Stores shared accounts / API keys / licenses /
// domains as first-class data. Sensitive fields encrypted via the same vault
// key as Slack credentials.

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import crypto from 'node:crypto';
import { PATHS, safeJoin } from './paths';
import { atomicWriteJSON } from '../_lib/file-io';
import type { TeamResource } from '../types/index';

const RES_DIR = PATHS.resources;

function vaultKey(): Buffer {
  // M0 hardening: explicit key only, no MINIMAX_API_KEY / plaintext fallback.
  // Prefer dedicated RESOURCES_VAULT_KEY; fall back to SLACK_VAULT_KEY
  // transitionally so existing encrypted resources still decrypt.
  const seed = process.env.RESOURCES_VAULT_KEY ?? process.env.SLACK_VAULT_KEY;
  if (!seed) {
    throw new Error(
      'RESOURCES_VAULT_KEY (or SLACK_VAULT_KEY transitional fallback) environment ' +
        'variable is required for resource credential encryption. Set it to a long ' +
        'random string and keep it stable across deployments.'
    );
  }
  return crypto.createHash('sha256').update(seed).digest();
}

export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', vaultKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join('.');
}

export function decryptSecret(payload: string): string | null {
  try {
    const [ivB, tagB, encB] = payload.split('.');
    if (!ivB || !tagB || !encB) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', vaultKey(), Buffer.from(ivB, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB, 'base64'));
    const dec = Buffer.concat([decipher.update(Buffer.from(encB, 'base64')), decipher.final()]);
    return dec.toString('utf8');
  } catch {
    return null;
  }
}

export function newResourceId(): string {
  return `RES-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

function resourcePath(id: string): string {
  if (id.includes('/') || id.includes('\\') || id.includes('..')) {
    throw new Error(`Invalid resource id: ${id}`);
  }
  return safeJoin(RES_DIR, `${id}.json`);
}

export async function listResources(): Promise<TeamResource[]> {
  try {
    const files = await fs.readdir(RES_DIR);
    const out: TeamResource[] = [];
    for (const f of files.filter((n) => n.endsWith('.json'))) {
      try {
        const raw = await fs.readFile(join(RES_DIR, f), 'utf8');
        const r = JSON.parse(raw) as TeamResource;
        // Strip credential before returning.
        const { credential_encrypted: _drop, ...safe } = r;
        out.push(safe as TeamResource);
      } catch {
        /* skip corrupted */
      }
    }
    out.sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''));
    return out;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

export async function getResource(id: string, includeSecret: boolean = false): Promise<TeamResource | null> {
  try {
    const raw = await fs.readFile(resourcePath(id), 'utf8');
    const r = JSON.parse(raw) as TeamResource;
    if (!includeSecret) {
      const { credential_encrypted: _drop, ...safe } = r;
      return safe as TeamResource;
    }
    return r;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function saveResource(r: TeamResource): Promise<void> {
  await atomicWriteJSON(resourcePath(r.id), r);
}

export async function deleteResource(id: string): Promise<void> {
  try {
    await fs.unlink(resourcePath(id));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

// Reveal credential — separate endpoint to gate exposure.
export async function revealCredential(id: string): Promise<string | null> {
  const r = await getResource(id, true);
  if (!r?.credential_encrypted) return null;
  return decryptSecret(r.credential_encrypted);
}
