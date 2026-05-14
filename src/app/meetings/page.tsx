'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  ChevronRight,
  Plus,
  Search,
  Upload,
  X,
  type LucideIcon
} from 'lucide-react';
import { useToast } from '../../components/Toast';
import { MeetingViewer } from '../../components/MeetingViewer';
import { MultiEvolutionPreview } from '../../components/MultiEvolutionPreview';
import type { Department } from '@/types';

interface MeetingMeta {
  file: string;
  title: string;
  date?: string;
  sizeKb: number;
  lineCount: number;
  source?: 'meeting' | 'slack';
}

export default function MeetingsPage() {
  const toast = useToast();
  const [meetings, setMeetings] = useState<MeetingMeta[] | null>(null);
  const [active, setActive] = useState<MeetingMeta | null>(null);
  const [query, setQuery] = useState('');
  const [uploadOpen, setUploadOpen] = useState(false);
  const [contextText, setContextText] = useState('');
  const [previewContext, setPreviewContext] = useState<string | null>(null);
  const [deptMap, setDeptMap] = useState<Record<string, Department>>({});
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    const [mRes, aRes] = await Promise.all([
      fetch('/api/meetings', { cache: 'no-store' }),
      fetch('/api/agents', { cache: 'no-store' })
    ]);
    if (mRes.ok) {
      const d = (await mRes.json()) as { meetings: MeetingMeta[] };
      setMeetings(d.meetings);
    }
    if (aRes.ok) {
      const d = (await aRes.json()) as { agents: Array<{ name: string; dept?: Department }> };
      const m: Record<string, Department> = {};
      for (const a of d.agents) if (a.dept) m[a.name] = a.dept;
      setDeptMap(m);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    document.title = 'Meetings · Rocket Team';
  }, []);

  const filtered = useMemo(() => {
    if (!meetings) return null;
    const q = query.trim().toLowerCase();
    if (!q) return meetings;
    return meetings.filter(
      (m) => m.title.toLowerCase().includes(q) || m.file.toLowerCase().includes(q)
    );
  }, [meetings, query]);

  const totalLines = (meetings ?? []).reduce((acc, m) => acc + m.lineCount, 0);

  const handleFileUpload = async (file: File) => {
    if (file.size > 2 * 1024 * 1024) {
      toast.push('File exceeds 2 MB limit', 'error');
      return;
    }
    try {
      const text = await file.text();
      if (!text.trim()) {
        toast.push('File is empty', 'error');
        return;
      }
      setContextText(text);
      setPreviewContext(text);
      setUploadOpen(false);
    } catch (err) {
      toast.push((err as Error).message, 'error');
    }
  };

  return (
    <div className="px-12 py-10 max-w-[1040px] mx-auto">
      <header className="flex items-end justify-between mb-8">
        <div className="max-w-2xl">
          <div className="eyebrow mb-2">
            Rocket Team / <Link href="/sources" className="hover:text-ink-muted transition-colors">Sources</Link> / Meetings
          </div>
          <h1 className="display-title">Meetings</h1>
          <p className="prose-warm text-body text-ink-muted mt-3">
            Meeting notes the system has read. Every member&apos;s profile and every piece of evidence cited during a simulation traces back to one of these.
          </p>
        </div>
        <button onClick={() => setUploadOpen(true)} className="btn-coral inline-flex items-center gap-1.5">
          <Plus size={13} /> Append context
        </button>
      </header>

      {meetings && meetings.length > 0 && (
        <section className="mb-6 grid grid-cols-3 gap-px bg-rule rounded-xl overflow-hidden border border-rule">
          <Stat label="Meetings" value={meetings.length} />
          <Stat label="Total lines" value={totalLines.toLocaleString()} />
          <Stat
            label="Coverage"
            value={
              meetings.filter((m) => m.date).length > 0
                ? `${meetings.filter((m) => m.date).slice(-1)[0]?.date} – ${meetings.filter((m) => m.date)[0]?.date}`
                : 'No date'
            }
          />
        </section>
      )}

      <div className="relative mb-4">
        <Search
          size={14}
          className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-quiet pointer-events-none"
        />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search title or filename…"
          className="w-full pl-9 pr-3 py-2.5 bg-paper-card border border-rule rounded-lg text-[14px] text-ink outline-none focus:border-coral-mute placeholder:text-ink-quiet"
        />
      </div>

      {!meetings && (
        <div className="rounded-xl border border-rule overflow-hidden divide-y divide-rule">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-11 bg-paper-card animate-pulse" />
          ))}
        </div>
      )}

      {filtered && filtered.length === 0 && meetings && meetings.length > 0 && (
        <div className="rounded-xl border border-dashed border-rule p-10 text-center bg-paper-card">
          <p className="text-body text-ink-muted">No matching meetings.</p>
        </div>
      )}

      {meetings && meetings.length === 0 && (
        <div className="rounded-xl border border-dashed border-rule p-10 text-center bg-paper-card">
          <p className="text-body text-ink-muted">
            No meeting files in <span className="font-mono">team/context/meeting/</span>.
          </p>
        </div>
      )}

      {filtered && filtered.length > 0 && (
        <div className="rounded-xl border border-rule overflow-hidden divide-y divide-rule">
          {filtered.map((m) => (
            <button
              key={m.file}
              onClick={() => setActive(m)}
              className="w-full text-left bg-paper-card hover:bg-paper-subtle transition-colors flex items-center gap-4 px-4 py-3"
            >
              <span className="font-serif text-[15px] text-ink leading-tight truncate flex-1 min-w-0">{m.title}</span>
              <span className="font-mono text-[11.5px] shrink-0 w-14 tabular-nums text-ink-quiet">
                {m.date ?? <span className="text-ink-ghost">—</span>}
              </span>
              <span className="font-mono text-[11.5px] text-ink-quiet shrink-0 w-16 text-right tabular-nums">{m.lineCount} line{m.lineCount === 1 ? '' : 's'}</span>
              <ChevronRight size={14} className="text-ink-quiet shrink-0" />
            </button>
          ))}
        </div>
      )}

      <MeetingViewer
        file={active?.file ?? null}
        title={active?.title}
        date={active?.date}
        onClose={() => setActive(null)}
      />

      {uploadOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 backdrop-blur-sm animate-fade-in"
          onClick={() => setUploadOpen(false)}
        >
          <div
            className="card-warm shadow-modal w-[640px] p-5 animate-slide-up"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="flex items-start justify-between mb-4">
              <div>
                <h2 className="font-serif text-[17px] text-ink leading-tight">Append context</h2>
                <p className="text-caption text-ink-quiet leading-tight mt-0.5">
                  Paste a new meeting snippet or firsthand observation. The system scans all affected members; you confirm each profile change one by one.
                </p>
              </div>
              <button
                onClick={() => setUploadOpen(false)}
                className="text-ink-quiet hover:text-ink"
                aria-label="Close"
              >
                <X size={16} />
              </button>
            </header>
            <textarea
              value={contextText}
              onChange={(e) => setContextText(e.target.value)}
              rows={6}
              autoFocus
              placeholder="Paste a new meeting snippet or firsthand observation…"
              className="w-full bg-paper-card border border-rule rounded-lg px-3 py-2.5 font-serif text-[14.5px] leading-relaxed text-ink outline-none resize-y placeholder:text-ink-quiet focus:border-coral-mute"
            />
            <div className="flex items-center justify-between mt-3 pt-3 border-t border-rule-soft">
              <button
                onClick={() => fileRef.current?.click()}
                className="btn-ghost text-caption inline-flex items-center gap-1.5"
              >
                <Upload size={11} /> Upload .txt / .md
              </button>
              <input
                ref={fileRef}
                type="file"
                accept=".txt,.md"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void handleFileUpload(f);
                  e.target.value = '';
                }}
              />
              <button
                onClick={() => {
                  if (!contextText.trim()) {
                    toast.push('Paste or upload content first', 'error');
                    return;
                  }
                  setPreviewContext(contextText);
                  setUploadOpen(false);
                }}
                disabled={!contextText.trim()}
                className="btn-coral"
              >
                Scan and preview changes
              </button>
            </div>
          </div>
        </div>
      )}

      {previewContext && (
        <MultiEvolutionPreview
          open
          context={previewContext}
          deptMap={deptMap}
          onClose={() => setPreviewContext(null)}
          onApplied={() => {
            setPreviewContext(null);
            setContextText('');
            toast.push('Profiles updated', 'success');
            void refresh();
          }}
        />
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="bg-paper-card px-5 py-4">
      <div className="font-serif text-[26px] leading-none text-ink tabular-nums">{value}</div>
      <div className="eyebrow mt-2">{label}</div>
    </div>
  );
}
