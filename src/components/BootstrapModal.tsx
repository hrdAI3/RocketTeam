'use client';

import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { BootstrapStatus } from '@/types';

interface BootstrapModalProps {
  open: boolean;
  clear: boolean;
  onClose: () => void;
  onDone: (result: { agents_created: string[]; meetings_processed: number; errors: string[] }) => void;
}

export function BootstrapModal({ open, clear, onClose, onDone }: BootstrapModalProps) {
  // Stable ref so the SSE-subscribing useEffect does NOT re-run every time
  // the parent re-renders (which would abort + re-fetch the bootstrap stream).
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  }, [onDone]);
  const [phase1, setPhase1] = useState({ current: 0, total: 0 });
  const [phase2, setPhase2] = useState({ current: 0, total: 0 });
  const [message, setMessage] = useState('启动中…');
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [done, setDone] = useState(false);
  const [aborted, setAborted] = useState(false);

  useEffect(() => {
    if (!open) {
      setPhase1({ current: 0, total: 0 });
      setPhase2({ current: 0, total: 0 });
      setMessage('启动中…');
      setError(null);
      setElapsed(0);
      setDone(false);
      setAborted(false);
      return;
    }

    const ctrl = new AbortController();
    const start = Date.now();
    const tick = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000);

    (async () => {
      try {
        const res = await fetch('/api/bootstrap', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clear }),
          signal: ctrl.signal
        });
        if (!res.ok || !res.body) {
          throw new Error(`Bootstrap failed: ${res.status}`);
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
          const { done: streamDone, value } = await reader.read();
          if (streamDone) break;
          buffer += decoder.decode(value, { stream: true });
          // Parse SSE frames
          const frames = buffer.split('\n\n');
          buffer = frames.pop() ?? '';
          for (const frame of frames) {
            const lines = frame.split('\n');
            let event = 'progress';
            let data = '';
            for (const line of lines) {
              if (line.startsWith('event: ')) event = line.slice(7).trim();
              else if (line.startsWith('data: ')) data += line.slice(6);
            }
            if (!data) continue;
            try {
              const parsed = JSON.parse(data);
              if (event === 'progress') {
                const status = parsed as BootstrapStatus;
                setMessage(status.message);
                if (status.phase === 1) setPhase1({ current: status.current, total: status.total });
                else if (status.phase === 2) setPhase2({ current: status.current, total: status.total });
              } else if (event === 'done') {
                setDone(true);
                clearInterval(tick);
                onDoneRef.current(parsed);
                return;
              } else if (event === 'error') {
                setError(parsed.error ?? 'Unknown error');
                clearInterval(tick);
                return;
              }
            } catch {
              // Skip malformed frames.
            }
          }
        }
      } catch (err) {
        if (!ctrl.signal.aborted) {
          setError((err as Error).message);
        }
        clearInterval(tick);
      }
    })();

    return () => {
      ctrl.abort();
      clearInterval(tick);
      setAborted(true);
    };
    // Intentional: omit onDone from deps. We use the ref above so the parent's
    // closure identity does not retrigger this effect mid-stream.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, clear]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 backdrop-blur-sm animate-fade-in"
      role="dialog"
      aria-modal="true"
    >
      <div className="card-warm shadow-modal w-[480px] p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-serif text-[18px] text-ink">正在生成团队画像</h2>
          {!done && !error && (
            <button
              onClick={onClose}
              className="text-ink-quiet hover:text-ink"
              aria-label="取消生成"
            >
              <X size={16} />
            </button>
          )}
        </div>

        <ProgressBar label="阶段一 · 摘要会议" current={phase1.current} total={phase1.total} />
        <ProgressBar label="阶段二 · 抽取画像" current={phase2.current} total={phase2.total} />

        <div className="mt-4 text-caption text-ink-muted">
          {error ? (
            <span className="text-rust">{error}</span>
          ) : aborted ? (
            <span>已取消</span>
          ) : done ? (
            <span className="text-forest">完成</span>
          ) : (
            <>
              <span>{message}</span>
              <span className="ml-2 font-mono">· 已用 {elapsed}s</span>
            </>
          )}
        </div>

        {error && (
          <div className="mt-4 flex justify-end">
            <button onClick={onClose} className="btn-ghost text-caption">
              关闭
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function ProgressBar({ label, current, total }: { label: string; current: number; total: number }) {
  const pct = total > 0 ? Math.min(100, (current / total) * 100) : 0;
  return (
    <div className="mb-3">
      <div className="flex items-center justify-between mb-1">
        <span className="text-body text-ink">{label}</span>
        <span className="text-caption text-ink-quiet font-mono">
          {current}/{total || '?'}
        </span>
      </div>
      <div className="h-1.5 bg-paper-deep rounded-sm overflow-hidden">
        <div
          className="h-full bg-coral transition-all"
          style={{ width: `${pct}%` }}
          aria-valuenow={Math.round(pct)}
          aria-valuemin={0}
          aria-valuemax={100}
          role="progressbar"
        />
      </div>
    </div>
  );
}
