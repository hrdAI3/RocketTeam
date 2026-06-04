'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState, useEffect } from 'react';
import {
  Search,
  Activity,
  FolderKanban,
  Database,
  Settings,
  Rocket,
  Users,
  LogOut,
  ArrowRight,
  MessagesSquare,
  LineChart,
  Target,
  Compass,
  type LucideIcon
} from 'lucide-react';
import { cn } from './utils';

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const [searchOpen, setSearchOpen] = useState(false);
  const [modKey, setModKey] = useState('Ctrl');
  const [currentUser, setCurrentUser] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/auth/me', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (j?.username) setCurrentUser(j.username);
      })
      .catch(() => {});
  }, []);

  const onLogout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.replace('/login');
    router.refresh();
  };

  useEffect(() => {
    if (typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)) setModKey('⌘');
  }, []);

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

  // Three things, flat. /status = the leader's daily glance (Workboard, project
  // axis). /tasks = the record of CLI-dispatched tasks + sim predictions —
  // renamed "Dispatch" so it doesn't collide with the new project workboard
  // (which is the real "Projects" axis now). /sources = source config. No
  // "deep" section, no Team. Task dispatch itself is CLI-only.
  // Order = the leader's daily flow, grouped by purpose:
  //   monitor (Status → Team → Evaluation)  →  act (Dispatch)  →
  //   plumbing (Sources → Messages).
  // Status is the landing glance; Team + Evaluation are the people views;
  // Dispatch is where you assign; Sources + Messages are system/comms.
  // Ordered by visit frequency within each group: monitor people (Status →
  // Team → Evaluation) → act (Dispatch) → comms you check often (Messages) →
  // set-once data config (Sources), which sits last next to Settings since
  // both are configure-and-forget.
  const nav: NavItem[] = [
    { href: '/status', label: 'Status', icon: Activity },
    { href: '/status/vision', label: 'Vision', icon: Compass },
    { href: '/status/goals', label: 'Goals', icon: Target },
    { href: '/team', label: 'Team', icon: Users },
    { href: '/evaluation', label: 'Evaluation', icon: LineChart },
    { href: '/tasks', label: 'Dispatch', icon: FolderKanban },
    { href: '/messages', label: 'Messages', icon: MessagesSquare },
    { href: '/sources', label: 'Sources', icon: Database }
  ];

  // After all hooks: hide sidebar on the login screen for a full-bleed
  // signin page. Placed here (not earlier) to keep hook order stable.
  if (pathname === '/login') return null;

  return (
    <>
      {/* Sticky on scroll: parent flex item + h-screen + sticky top-0 */}
      <aside className="w-[240px] shrink-0 bg-paper-subtle border-r border-rule sticky top-0 self-start h-screen flex flex-col">
        <div className="px-3 pt-5 pb-4 border-b border-rule">
          <div className="flex items-center gap-2.5 px-2">
            <div
              aria-hidden
              className="w-7 h-7 rounded-lg bg-coral text-white flex items-center justify-center shrink-0"
            >
              <Rocket size={14} strokeWidth={2.5} />
            </div>
            <div className="min-w-0">
              <div className="font-serif text-[15px] leading-tight text-ink">Rocket Team</div>
            </div>
          </div>
        </div>

        <div className="px-2 pt-3">
          <button
            onClick={() => setSearchOpen(true)}
            className="w-full flex items-center gap-2 px-2.5 py-2 rounded-md text-sidebar text-ink-muted hover:bg-paper-deep transition-colors"
          >
            <Search size={14} />
            <span>Search</span>
            <kbd className="ml-auto font-mono text-[10px] px-1.5 py-0.5 rounded bg-paper-card border border-rule text-ink-quiet">
              {modKey} K
            </kbd>
          </button>
        </div>

        <nav className="px-2 pt-3 space-y-0.5">
          {nav.map((item) => {
            const active = pathname === item.href || pathname.startsWith(item.href + '/');
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  'w-full flex items-center gap-2.5 px-2.5 py-2 rounded-md text-sidebar transition-colors',
                  active
                    ? 'bg-coral-subtle text-coral-deep font-semibold'
                    : 'text-ink-muted hover:bg-paper-deep hover:text-ink'
                )}
              >
                <Icon size={15} strokeWidth={active ? 2.4 : 2} />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="mt-auto px-2 pb-3 pt-3 border-t border-rule space-y-0.5">
          {currentUser && (
            <div className="px-2.5 py-1 text-[10px] uppercase tracking-wider text-ink-quiet">
              Signed in as <span className="text-ink-muted normal-case">{currentUser}</span>
            </div>
          )}
          <Link
            href="/settings"
            className={cn(
              'w-full flex items-center gap-2.5 px-2.5 py-2 rounded-md text-sidebar transition-colors',
              pathname === '/settings'
                ? 'bg-coral-subtle text-coral-deep font-semibold'
                : 'text-ink-quiet hover:bg-paper-deep hover:text-ink'
            )}
          >
            <Settings size={15} strokeWidth={2} />
            <span>Settings</span>
          </Link>
          <button
            onClick={onLogout}
            className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-md text-sidebar text-ink-quiet hover:bg-paper-deep hover:text-ink transition-colors"
          >
            <LogOut size={15} strokeWidth={2} />
            <span>Sign out</span>
          </button>
        </div>
      </aside>

      {searchOpen && <SearchModal onClose={() => setSearchOpen(false)} />}
    </>
  );
}

type HitType = 'member' | 'project' | 'task' | 'meeting' | 'page';
interface SearchHit {
  type: HitType;
  label: string;
  sub?: string;
  href: string;
}

// Static page-jump entries — always available, even with no query. Mirrors the
// "GO TO" rows in the Rocket Team design CmdK.
const PAGE_HITS: SearchHit[] = [
  { type: 'page', label: 'Workboard', sub: '/status', href: '/status' },
  { type: 'page', label: 'All projects', sub: '/status/projects', href: '/status/projects' },
  { type: 'page', label: 'Vision', sub: '/status/vision', href: '/status/vision' },
  { type: 'page', label: 'Goals', sub: '/status/goals', href: '/status/goals' },
  { type: 'page', label: 'Dispatch', sub: '/tasks', href: '/tasks' },
  { type: 'page', label: 'Team', sub: '/team', href: '/team' },
  { type: 'page', label: 'Sources', sub: '/sources', href: '/sources' },
  { type: 'page', label: 'Evaluation', sub: '/evaluation', href: '/evaluation' },
  { type: 'page', label: 'Messages', sub: '/messages', href: '/messages' },
  { type: 'page', label: 'Settings', sub: '/settings', href: '/settings' }
];

const TYPE_LABEL: Record<HitType, string> = {
  member: 'MEMBER',
  project: 'PROJECT',
  task: 'TASK',
  meeting: 'MEETING',
  page: 'GO TO'
};
const TYPE_TONE: Record<HitType, string> = {
  member: 'text-coral',
  project: 'text-plum',
  task: 'text-sky',
  meeting: 'text-forest',
  page: 'text-ink-quiet'
};

function SearchModal({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const [index, setIndex] = useState<SearchHit[] | null>(null);

  // Build index once when opened. Members + projects + tasks + meetings.
  useEffect(() => {
    void (async () => {
      try {
        const [a, ctx, t, m] = await Promise.all([
          fetch('/api/agents', { cache: 'no-store' }).then((r) => r.json()),
          fetch('/api/team/context', { cache: 'no-store' }).then((r) => r.json()).catch(() => ({})),
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
              href: `/team/${encodeURIComponent(ag.name)}`
            });
          }
        }
        for (const p of (ctx.projects ?? []) as Array<{ id: string; name: string; curated?: boolean; top_contributors?: unknown[] }>) {
          if (p.id && p.name && !p.id.startsWith('virtual:')) {
            idx.push({
              type: 'project',
              label: p.name,
              sub: p.curated ? 'curated' : 'project',
              href: `/status/project/${encodeURIComponent(p.id)}`
            });
          }
        }
        for (const tk of (t.tasks ?? []) as Array<{ id: string; description: string }>) {
          idx.push({ type: 'task', label: tk.description.slice(0, 60), sub: tk.id, href: `/tasks` });
        }
        for (const mt of (m.meetings ?? []) as Array<{ file: string; title: string; date?: string }>) {
          idx.push({ type: 'meeting', label: mt.title, sub: mt.date, href: `/sources` });
        }
        setIndex(idx);
      } catch {
        setIndex([]);
      }
    })();
  }, []);

  // Empty query → default suggestions (pages + first projects). Typed query →
  // fuzzy-contains across the whole index.
  const hits = (() => {
    const all = [...PAGE_HITS, ...(index ?? [])];
    const q = query.trim().toLowerCase();
    if (!q) {
      const projects = (index ?? []).filter((h) => h.type === 'project').slice(0, 4);
      return [...PAGE_HITS, ...projects];
    }
    return all
      .filter((h) => h.label.toLowerCase().includes(q) || (h.sub ?? '').toLowerCase().includes(q))
      .slice(0, 12);
  })();

  useEffect(() => {
    setActiveIdx(0);
  }, [query]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-ink/30 pt-32 backdrop-blur-sm animate-fade-in"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="bg-paper-card rounded-xl shadow-modal w-[620px] max-w-[92vw] border border-rule overflow-hidden"
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
            placeholder="搜索成员、项目、任务，或跳转页面…"
            className="flex-1 bg-transparent outline-none text-body text-ink placeholder:text-ink-quiet"
          />
          <kbd className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-paper border border-rule text-ink-quiet">
            esc
          </kbd>
        </div>
        <div className="max-h-[420px] overflow-y-auto">
          {hits.length === 0 && (
            <div className="px-5 py-10 text-center text-caption text-ink-quiet">
              {index === null ? 'Loading…' : 'No matches'}
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
                    'text-[9.5px] uppercase tracking-[0.06em] font-mono px-1.5 py-0.5 rounded shrink-0 bg-paper-subtle text-center w-[58px]',
                    TYPE_TONE[h.type]
                  )}
                >
                  {TYPE_LABEL[h.type]}
                </span>
                <span className="font-serif text-[14px] text-ink truncate flex-1">{h.label}</span>
                {h.sub && (
                  <span className="text-[11px] text-ink-quiet truncate shrink-0 max-w-[240px]">{h.sub}</span>
                )}
                {active && <ArrowRight size={14} className="text-coral shrink-0" />}
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-4 px-5 py-2 border-t border-rule bg-paper-subtle text-[11px] text-ink-quiet">
          <span className="flex items-center gap-1">
            <kbd className="font-mono px-1.5 py-px rounded bg-paper-card border border-rule">↑↓</kbd> navigate
          </span>
          <span className="flex items-center gap-1">
            <kbd className="font-mono px-1.5 py-px rounded bg-paper-card border border-rule">↵</kbd> open
          </span>
          <span className="ml-auto tabular-nums">{hits.length} result{hits.length === 1 ? '' : 's'}</span>
        </div>
      </div>
    </div>
  );
}
