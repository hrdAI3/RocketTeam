'use client';

import { useState, FormEvent, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Rocket, Lock } from 'lucide-react';

function LoginForm() {
  const router = useRouter();
  const search = useSearchParams();
  const next = search?.get('next') ?? '/status';
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setError(j.error ?? `Login failed (${res.status})`);
        return;
      }
      router.replace(next);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-paper px-6">
      <div className="w-full max-w-[400px]">
        <div className="flex items-center gap-3 mb-8">
          <div className="w-9 h-9 rounded-lg bg-coral text-white flex items-center justify-center">
            <Rocket size={18} strokeWidth={2.5} />
          </div>
          <div>
            <div className="font-serif text-[20px] text-ink leading-none">Rocket Team</div>
            <div className="text-[11px] text-ink-quiet mt-0.5 uppercase tracking-wider">
              Internal · sign in to continue
            </div>
          </div>
        </div>

        <form onSubmit={submit} className="space-y-4">
          <label className="block">
            <span className="text-[11px] uppercase tracking-wider text-ink-muted mb-1.5 block">
              Username
            </span>
            <input
              autoFocus
              type="text"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full px-3 py-2 rounded-md border border-rule bg-paper-card text-[14px] text-ink focus:border-coral focus:outline-none transition-colors"
              required
            />
          </label>
          <label className="block">
            <span className="text-[11px] uppercase tracking-wider text-ink-muted mb-1.5 block">
              Password
            </span>
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-3 py-2 rounded-md border border-rule bg-paper-card text-[14px] text-ink focus:border-coral focus:outline-none transition-colors"
              required
            />
          </label>
          {error && (
            <div className="rounded-md border border-coral/40 bg-coral/5 px-3 py-2 text-[12.5px] text-coral-deep">
              {error}
            </div>
          )}
          <button
            type="submit"
            disabled={loading || !username || !password}
            className="w-full inline-flex items-center justify-center gap-2 bg-coral text-white px-4 py-2 rounded-md text-[13.5px] font-medium hover:bg-coral-deep disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <Lock size={13} />
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <p className="text-[11px] text-ink-quiet mt-6 leading-relaxed">
          Team-internal access only. Need an account?{' '}
          Ask the admin to run{' '}
          <code className="font-mono text-[11px] px-1 py-0.5 bg-paper-subtle rounded">
            bun tools/add_user.ts &lt;username&gt;
          </code>{' '}
          on the host.
        </p>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
