'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState, useEffect } from 'react';
import {
  Search,
  Plus,
  Users,
  ListChecks,
  Database,
  Settings,
  Network,
  X,
  Rocket,
  type LucideIcon
} from 'lucide-react';
import { cn } from './utils';
import { useNewTask } from './NewTaskModal';

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  count?: number | undefined;
}

interface SidebarProps {
  memberCount: number;
}

export function Sidebar({ memberCount }: SidebarProps) {
  const pathname = usePathname();
  const [searchOpen, setSearchOpen] = useState(false);
  const { open: openNewTask } = useNewTask();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setSearchOpen(true);
      }
      if (e.key === 'Escape') setSearchOpen(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const workspaceNav: NavItem[] = [
    { href: '/agents', label: '成员', icon: Users, count: memberCount },
    { href: '/tasks', label: '任务', icon: ListChecks },
    { href: '/org', label: '组织架构', icon: Network },
    { href: '/sources', label: '数据接入', icon: Database }
  ];

  const configureNav: NavItem[] = [{ href: '/settings', label: '设置', icon: Settings }];

  return (
    <>
      {/* Sticky on scroll: parent flex item + h-screen + sticky top-0 */}
      <aside className="w-[252px] shrink-0 bg-paper-subtle border-r border-rule sticky top-0 self-start h-screen flex flex-col">
        <div className="px-3 pt-4 pb-3 border-b border-rule">
          <div className="flex items-center gap-2.5 px-2">
            <div
              aria-hidden
              className="w-7 h-7 rounded-lg bg-coral text-white flex items-center justify-center shrink-0"
            >
              <Rocket size={14} strokeWidth={2.5} />
            </div>
            <div className="min-w-0">
              <div className="font-serif text-[15px] leading-tight text-ink">Rocket Team</div>
              <div className="text-[10.5px] font-mono text-ink-quiet tracking-wide">团队协作系统</div>
            </div>
          </div>
        </div>

        <div className="px-2 pt-3">
          <button
            onClick={() => setSearchOpen(true)}
            className="w-full flex items-center gap-2 px-2.5 py-2 rounded-md text-sidebar text-ink-muted hover:bg-paper-deep transition-colors"
          >
            <Search size={14} />
            <span>搜索</span>
            <kbd className="ml-auto font-mono text-[10px] px-1.5 py-0.5 rounded bg-paper-card border border-rule text-ink-quiet">
              ⌘K
            </kbd>
          </button>
          <button
            onClick={openNewTask}
            className="w-full flex items-center gap-2 px-2.5 py-2 rounded-md text-sidebar text-ink-muted hover:bg-paper-deep transition-colors"
          >
            <Plus size={14} />
            <span>新任务</span>
            <kbd className="ml-auto font-mono text-[10px] px-1.5 py-0.5 rounded bg-paper-card border border-rule text-ink-quiet">
              ⌘N
            </kbd>
          </button>
        </div>

        <Section label="工作区" items={workspaceNav} pathname={pathname} />
        <Section label="配置" items={configureNav} pathname={pathname} />

        <div className="mt-auto px-5 py-4 border-t border-rule">
          <p className="font-serif text-[13px] leading-snug text-ink-muted italic">
            完成比完美更重要。
          </p>
          <p className="font-mono text-[9.5px] text-ink-quiet tracking-wide mt-1">
            ROCKET TEAM
          </p>
        </div>
      </aside>

      {searchOpen && <SearchModal onClose={() => setSearchOpen(false)} />}
    </>
  );
}

function Section({ label, items, pathname }: { label: string; items: NavItem[]; pathname: string }) {
  return (
    <div className="px-2 py-3">
      <div className="px-2.5 pb-1.5 eyebrow">{label}</div>
      <ul className="space-y-0.5">
        {items.map((item) => {
          const active = pathname === item.href || pathname.startsWith(item.href + '/');
          const Icon = item.icon;
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                className={cn(
                  'w-full flex items-center gap-2 px-2.5 py-2 rounded-md text-sidebar transition-colors',
                  active
                    ? 'bg-coral-subtle text-coral-deep font-semibold'
                    : 'text-ink-muted hover:bg-paper-deep hover:text-ink'
                )}
              >
                <Icon size={14} strokeWidth={active ? 2.4 : 2} />
                <span>{item.label}</span>
                {typeof item.count === 'number' && (
                  <span className="ml-auto font-mono text-[10px] text-ink-quiet">{item.count}</span>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

interface SearchHit {
  type: 'member' | 'task' | 'meeting';
  label: string;
  sub?: string;
  href: string;
}

function SearchModal({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [activeIdx, setActiveIdx] = useState(0);

  // Build index once when opened.
  const [index, setIndex] = useState<SearchHit[] | null>(null);
  useEffect(() => {
    void (async () => {
      try {
        const [a, t, m] = await Promise.all([
          fetch('/api/agents', { cache: 'no-store' }).then((r) => r.json()),
          fetch('/api/tasks', { cache: 'no-store' }).then((r) => r.json()),
          fetch('/api/meetings', { cache: 'no-store' }).then((r) => r.json())
        ]);
        const idx: SearchHit[] = [];
        for (const ag of (a.agents ?? []) as Array<{ name: string; role?: string; dept?: string }>) {
          if (ag.name) {
            idx.push({
              type: 'member',
              label: ag.name,
              sub: [ag.dept, ag.role].filter(Boolean).join(' · '),
              href: `/agents/${encodeURIComponent(ag.name)}`
            });
          }
        }
        for (const tk of (t.tasks ?? []) as Array<{ id: string; description: string }>) {
          idx.push({
            type: 'task',
            label: tk.description.slice(0, 60),
            sub: tk.id,
            href: `/tasks`
          });
        }
        for (const mt of (m.meetings ?? []) as Array<{ file: string; title: string; date?: string }>) {
          idx.push({
            type: 'meeting',
            label: mt.title,
            sub: mt.date,
            href: `/sources`
          });
        }
        setIndex(idx);
      } catch {
        setIndex([]);
      }
    })();
  }, []);

  useEffect(() => {
    if (!index) return;
    const q = query.trim().toLowerCase();
    if (!q) {
      setHits([]);
      return;
    }
    setHits(
      index
        .filter(
          (h) =>
            h.label.toLowerCase().includes(q) || (h.sub ?? '').toLowerCase().includes(q)
        )
        .slice(0, 12)
    );
    setActiveIdx(0);
  }, [query, index]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-ink/30 pt-32 backdrop-blur-sm animate-fade-in"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="bg-paper-card rounded-xl shadow-modal w-[600px] border border-rule overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActiveIdx((i) => Math.min(hits.length - 1, i + 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActiveIdx((i) => Math.max(0, i - 1));
          } else if (e.key === 'Enter') {
            const hit = hits[activeIdx];
            if (hit) {
              router.push(hit.href);
              onClose();
            }
          }
        }}
      >
        <div className="flex items-center gap-3 px-5 py-4 border-b border-rule">
          <Search size={18} className="text-ink-quiet" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索成员、任务、会议…"
            className="flex-1 bg-transparent outline-none text-body text-ink placeholder:text-ink-quiet"
          />
          <kbd className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-paper border border-rule text-ink-quiet">
            esc
          </kbd>
          <button onClick={onClose} aria-label="关闭" className="text-ink-quiet hover:text-ink">
            <X size={16} />
          </button>
        </div>
        <div className="max-h-[400px] overflow-y-auto">
          {hits.length === 0 && (
            <div className="px-5 py-10 text-center text-caption text-ink-quiet">
              {index === null ? '加载中…' : query ? '没有找到匹配' : '输入开始搜索'}
            </div>
          )}
          {hits.map((h, i) => {
            const active = i === activeIdx;
            return (
              <button
                key={`${h.type}-${h.href}-${i}`}
                onClick={() => {
                  router.push(h.href);
                  onClose();
                }}
                onMouseEnter={() => setActiveIdx(i)}
                className={cn(
                  'w-full text-left flex items-center gap-3 px-5 py-2.5 transition-colors',
                  active ? 'bg-coral-subtle' : 'hover:bg-paper-subtle'
                )}
              >
                <span
                  className={cn(
                    'text-[10.5px] uppercase tracking-wide font-mono px-1.5 py-0.5 rounded shrink-0',
                    h.type === 'member'
                      ? 'bg-paper-subtle text-coral'
                      : h.type === 'task'
                        ? 'bg-paper-subtle text-sky'
                        : 'bg-paper-subtle text-forest'
                  )}
                >
                  {h.type === 'member' ? '成员' : h.type === 'task' ? '任务' : '会议'}
                </span>
                <span className="font-serif text-[14px] text-ink truncate flex-1">{h.label}</span>
                {h.sub && (
                  <span className="text-[11px] text-ink-quiet truncate shrink-0">{h.sub}</span>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
