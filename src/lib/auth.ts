// Minimal cookie-based auth for the team dashboard. Single-purpose:
// gate the whole UI behind a login form. No third-party deps — Node's
// built-in `crypto` does the password hashing (scrypt) and session
// signing (HMAC-SHA256).
//
// Session token format:
//   <base64url(payload)>.<base64url(hmac_sha256(payload, SECRET))>
//   payload = JSON {u: username, e: expiresMsEpoch}
//
// Cookie: HttpOnly, SameSite=Lax, 30-day TTL, Secure when behind HTTPS.

import { promises as fs } from 'node:fs';
import crypto from 'node:crypto';
import { join } from 'node:path';
import { PATHS } from './paths';

const USERS_PATH = join(PATHS.root, 'users.json');
const SESSION_COOKIE = 'team-session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const SCRYPT_N = 16384;
const SCRYPT_r = 8;
const SCRYPT_p = 1;
const KEY_LEN = 64;

interface UserRecord {
  username: string;
  salt: string; // base64
  hash: string; // base64
  added_at: string; // ISO
}

interface UsersFile {
  users: UserRecord[];
}

function getSecret(): Buffer {
  const seed = process.env.SESSION_SECRET;
  if (!seed) {
    throw new Error(
      'SESSION_SECRET env var is required. Set to a long random string (>= 32 chars).'
    );
  }
  return crypto.createHash('sha256').update(seed).digest();
}

export async function loadUsers(): Promise<UsersFile> {
  try {
    const raw = await fs.readFile(USERS_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Partial<UsersFile>;
    return { users: parsed.users ?? [] };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { users: [] };
    throw err;
  }
}

async function saveUsers(file: UsersFile): Promise<void> {
  const tmp = USERS_PATH + '.tmp.' + process.pid;
  await fs.writeFile(tmp, JSON.stringify(file, null, 2) + '\n', { mode: 0o600 });
  await fs.rename(tmp, USERS_PATH);
}

export function hashPassword(password: string, saltB64?: string): { hash: string; salt: string } {
  const salt = saltB64 ? Buffer.from(saltB64, 'base64') : crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_r,
    p: SCRYPT_p,
    maxmem: 64 * 1024 * 1024
  });
  return { hash: derived.toString('base64'), salt: salt.toString('base64') };
}

export function verifyPassword(password: string, user: UserRecord): boolean {
  const { hash } = hashPassword(password, user.salt);
  // Constant-time compare
  const a = Buffer.from(hash, 'base64');
  const b = Buffer.from(user.hash, 'base64');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export async function findUser(username: string): Promise<UserRecord | null> {
  const file = await loadUsers();
  const u = file.users.find((x) => x.username === username);
  return u ?? null;
}

export async function addOrUpdateUser(username: string, password: string): Promise<void> {
  const file = await loadUsers();
  const { hash, salt } = hashPassword(password);
  const idx = file.users.findIndex((u) => u.username === username);
  const rec: UserRecord = { username, salt, hash, added_at: new Date().toISOString() };
  if (idx >= 0) file.users[idx] = rec;
  else file.users.push(rec);
  await saveUsers(file);
}

// === Session tokens ===

function b64urlEncode(buf: Buffer | string): string {
  const b = typeof buf === 'string' ? Buffer.from(buf, 'utf8') : buf;
  return b.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function b64urlDecode(s: string): Buffer {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}

export function issueSession(username: string): { token: string; expiresAt: Date } {
  const expiresMs = Date.now() + SESSION_TTL_MS;
  const payload = JSON.stringify({ u: username, e: expiresMs });
  const sig = crypto.createHmac('sha256', getSecret()).update(payload).digest();
  return {
    token: `${b64urlEncode(payload)}.${b64urlEncode(sig)}`,
    expiresAt: new Date(expiresMs)
  };
}

export function verifySession(token: string | undefined | null): { username: string } | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  let payloadBuf: Buffer;
  let sigBuf: Buffer;
  try {
    payloadBuf = b64urlDecode(parts[0]);
    sigBuf = b64urlDecode(parts[1]);
  } catch {
    return null;
  }
  const expected = crypto.createHmac('sha256', getSecret()).update(payloadBuf).digest();
  if (expected.length !== sigBuf.length) return null;
  if (!crypto.timingSafeEqual(expected, sigBuf)) return null;
  try {
    const payload = JSON.parse(payloadBuf.toString('utf8')) as { u?: string; e?: number };
    if (typeof payload.u !== 'string' || typeof payload.e !== 'number') return null;
    if (payload.e < Date.now()) return null;
    return { username: payload.u };
  } catch {
    return null;
  }
}

// Cookie helpers

export const SESSION_COOKIE_NAME = SESSION_COOKIE;

export function sessionCookieValue(token: string, expiresAt: Date): string {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Expires=${expiresAt.toUTCString()}`
  ];
  if (process.env.NODE_ENV === 'production') parts.push('Secure');
  return parts.join('; ');
}

export function clearSessionCookieValue(): string {
  return [
    `${SESSION_COOKIE}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0'
  ].join('; ');
}
