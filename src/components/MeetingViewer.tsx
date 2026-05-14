'use client';

import { useEffect, useState } from 'react';
import { X, FileText, Clock, Loader2 } from 'lucide-react';

interface MeetingViewerProps {
  file: string | null;
  title?: string;
  date?: string;
  onClose: () => void;
}

export function MeetingViewer({ file, title, date, onClose }: MeetingViewerProps) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!file) return;
    setLoading(true);
    setError(null);
    setContent(null);
    fetch(`/api/meetings/${encodeURIComponent(file)}`, { cache: 'no-store' })
      .then(async (r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        const data = (await r.json()) as { content: string };
        setContent(data.content);
      })
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoading(false));
  }, [file]);

  if (!file) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 backdrop-blur-sm animate-fade-in"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="card-warm shadow-modal w-[860px] max-h-[85vh] flex flex-col animate-slide-up"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-3 px-6 py-4 border-b border-rule">
          <div className="flex items-start gap-3 min-w-0">
            <div className="w-8 h-8 rounded-md bg-paper-subtle border border-rule flex items-center justify-center shrink-0">
              <FileText size={14} className="text-coral" />
            </div>
            <div className="min-w-0">
              <h2 className="font-serif text-[17px] text-ink leading-tight truncate">
                {title || file.replace(/\.txt$/, '')}
              </h2>
              <div className="flex items-center gap-2 text-[11px] text-ink-quiet mt-0.5">
                {date && (
                  <>
                    <Clock size={10} />
                    <span className="font-mono">{date}</span>
                    <span className="text-ink-ghost">·</span>
                  </>
                )}
                <span className="font-mono truncate">{file}</span>
              </div>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-ink-quiet hover:text-ink shrink-0"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          {loading && (
            <div className="flex items-center gap-2 text-body text-ink-muted">
              <Loader2 size={14} className="animate-spin" />
              Loading…
            </div>
          )}
          {error && (
            <div className="text-body text-rust">Failed to load: {error}</div>
          )}
          {content && (
            <pre className="font-serif text-[14.5px] leading-relaxed text-ink whitespace-pre-wrap break-words">
              {content}
            </pre>
          )}
        </div>

        <footer className="px-6 py-3 border-t border-rule-soft text-[11px] text-ink-quiet flex items-center gap-2">
          <span>This is the raw meeting transcript the system has read. Every piece of profile evidence is extracted from here.</span>
        </footer>
      </div>
    </div>
  );
}
