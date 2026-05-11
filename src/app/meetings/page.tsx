'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  Calendar,
  FileText,
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
      toast.push('文件超过 2MB 上限', 'error');
      return;
    }
    try {
      const text = await file.text();
      if (!text.trim()) {
        toast.push('文件为空', 'error');
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
    <div className="px-12 py-10 max-w-[1100px] mx-auto">
      <Link
        href="/sources"
        className="text-caption text-ink-muted hover:text-ink inline-flex items-center gap-1 mb-3"
      >
        <ArrowLeft size={12} /> 数据接入
      </Link>

      <header className="flex items-end justify-between mb-8">
        <div className="max-w-2xl">
          <div className="eyebrow mb-2">Rocket Team / 数据接入 / 会议记录</div>
          <h1 className="display-title">会议记录</h1>
          <p className="prose-warm text-body text-ink-muted mt-3">
            系统读取的真实会议纪要。每位成员的画像、每次推演里 agent 引用的证据都来自这里。
          </p>
        </div>
        <button onClick={() => setUploadOpen(true)} className="btn-coral inline-flex items-center gap-1.5">
          <Plus size={13} /> 追加 context
        </button>
      </header>

      {meetings && meetings.length > 0 && (
        <section className="mb-6 grid grid-cols-3 gap-px bg-rule rounded-xl overflow-hidden border border-rule">
          <Stat label="会议总数" value={meetings.length} />
          <Stat label="累计行数" value={totalLines.toLocaleString()} accent />
          <Stat
            label="覆盖时间"
            value={
              meetings.filter((m) => m.date).length > 0
                ? `${meetings.filter((m) => m.date).slice(-1)[0]?.date} – ${meetings.filter((m) => m.date)[0]?.date}`
                : '未标注日期'
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
          placeholder="搜索会议标题或文件名…"
          className="w-full pl-9 pr-3 py-2.5 bg-paper-card border border-rule rounded-lg text-[14px] text-ink outline-none focus:border-coral-mute placeholder:text-ink-quiet"
        />
      </div>

      {!meetings && (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="card-surface p-4 animate-pulse h-16" />
          ))}
        </div>
      )}

      {filtered && filtered.length === 0 && meetings && meetings.length > 0 && (
        <div className="rounded-xl border border-dashed border-rule p-10 text-center bg-paper-card">
          <p className="text-body text-ink-muted">没有匹配的会议。</p>
        </div>
      )}

      {meetings && meetings.length === 0 && (
        <div className="rounded-xl border border-dashed border-rule p-10 text-center bg-paper-card">
          <p className="text-body text-ink-muted">
            <span className="font-mono">team/context/meeting/</span> 下没有会议文件。
          </p>
        </div>
      )}

      {filtered && filtered.length > 0 && (
        <ul className="space-y-2">
          {filtered.map((m) => (
            <li key={m.file}>
              <button
                onClick={() => setActive(m)}
                className="w-full text-left card-surface p-4 hover:shadow-soft hover:border-rule-strong transition-all flex items-start gap-3"
              >
                <div className="w-9 h-9 rounded-md bg-paper-subtle border border-rule-soft flex items-center justify-center shrink-0">
                  <FileText size={14} className="text-coral" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-serif text-[15.5px] text-ink leading-tight truncate">
                    {m.title}
                  </div>
                  <div className="flex items-center gap-2 mt-1 text-[11px] text-ink-quiet">
                    {m.date && (
                      <>
                        <Calendar size={10} />
                        <span className="font-mono">{m.date}</span>
                        <span className="text-ink-ghost">·</span>
                      </>
                    )}
                    <span className="font-mono">{m.sizeKb} KB</span>
                    <span className="text-ink-ghost">·</span>
                    <span className="font-mono">{m.lineCount} 行</span>
                  </div>
                </div>
                <div className="text-[11px] text-coral self-center shrink-0">查看 →</div>
              </button>
            </li>
          ))}
        </ul>
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
                <h2 className="font-serif text-[17px] text-ink leading-tight">追加 context</h2>
                <p className="text-caption text-ink-quiet leading-tight mt-0.5">
                  贴入新会议片段或一手观察。系统会扫描所有相关成员，每条画像变化你逐条确认。
                </p>
              </div>
              <button
                onClick={() => setUploadOpen(false)}
                className="text-ink-quiet hover:text-ink"
                aria-label="关闭"
              >
                <X size={16} />
              </button>
            </header>
            <textarea
              value={contextText}
              onChange={(e) => setContextText(e.target.value)}
              rows={6}
              autoFocus
              placeholder="粘贴一段新会议片段、一手观察…"
              className="w-full bg-paper-card border border-rule rounded-lg px-3 py-2.5 font-serif text-[14.5px] leading-relaxed text-ink outline-none resize-y placeholder:text-ink-quiet focus:border-coral-mute"
            />
            <div className="flex items-center justify-between mt-3 pt-3 border-t border-rule-soft">
              <button
                onClick={() => fileRef.current?.click()}
                className="btn-ghost text-caption inline-flex items-center gap-1.5"
              >
                <Upload size={11} /> 上传 .txt / .md
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
                    toast.push('请贴入或上传内容', 'error');
                    return;
                  }
                  setPreviewContext(contextText);
                  setUploadOpen(false);
                }}
                disabled={!contextText.trim()}
                className="btn-coral"
              >
                扫描并预览改动
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
            toast.push('画像批量更新完成', 'success');
            void refresh();
          }}
        />
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  accent
}: {
  label: string;
  value: number | string;
  accent?: boolean;
}) {
  return (
    <div className="bg-paper-card px-5 py-4">
      <div className={`font-serif text-[28px] leading-none ${accent ? 'text-coral' : 'text-ink'}`}>
        {value}
      </div>
      <div className="eyebrow mt-2">{label}</div>
    </div>
  );
}
