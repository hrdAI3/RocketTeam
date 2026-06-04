import { NextResponse } from 'next/server';
import { clearSessionCookieValue } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function POST(): Promise<Response> {
  return new NextResponse(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': clearSessionCookieValue()
    }
  });
}
