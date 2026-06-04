import { NextRequest, NextResponse } from 'next/server';

// Gate every request through cookie auth.
//
// NOTE: middleware runs in Edge runtime. The session check here must be the
// minimal HMAC verification — same algorithm as `src/lib/auth.ts` but
// duplicated inline because the Edge runtime can't import Node `crypto`'s
// `scrypt`. HMAC + base64 are Web Crypto compatible.

const PUBLIC_PATHS = [
  '/login',
  '/api/auth/login',
  '/api/auth/logout',
  '/api/auth/me'
];

const SESSION_COOKIE = 'team-session';

function b64urlDecode(s: string): Uint8Array {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function constantEq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function verifyTokenEdge(token: string, secret: string): Promise<{ username: string } | null> {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  let payloadBytes: Uint8Array;
  let sigBytes: Uint8Array;
  try {
    payloadBytes = b64urlDecode(parts[0]);
    sigBytes = b64urlDecode(parts[1]);
  } catch {
    return null;
  }
  const enc = new TextEncoder();
  const secretHash = await crypto.subtle.digest('SHA-256', enc.encode(secret));
  const key = await crypto.subtle.importKey('raw', secretHash, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expected = new Uint8Array(await crypto.subtle.sign('HMAC', key, payloadBytes));
  if (!constantEq(expected, sigBytes)) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(payloadBytes)) as { u?: string; e?: number };
    if (typeof payload.u !== 'string' || typeof payload.e !== 'number') return null;
    if (payload.e < Date.now()) return null;
    return { username: payload.u };
  } catch {
    return null;
  }
}

export async function middleware(req: NextRequest): Promise<Response> {
  const { pathname } = req.nextUrl;

  // Public allowlist
  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + '/'))) {
    return NextResponse.next();
  }
  // Static + framework internals
  if (
    pathname.startsWith('/_next') ||
    pathname.startsWith('/static') ||
    pathname === '/favicon.ico' ||
    pathname === '/robots.txt'
  ) {
    return NextResponse.next();
  }

  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    // Hard fail: refuse to serve without secret configured.
    return new NextResponse(
      'SESSION_SECRET not configured — refusing to serve. Set the env var and restart.',
      { status: 500 }
    );
  }

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const session = token ? await verifyTokenEdge(token, secret) : null;
  if (!session) {
    // API routes return JSON 401; pages redirect to /login.
    if (pathname.startsWith('/api/')) {
      return new NextResponse(JSON.stringify({ error: 'unauthenticated' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    const loginUrl = new URL('/login', req.url);
    loginUrl.searchParams.set('next', pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next|favicon.ico|robots.txt).*)']
};
