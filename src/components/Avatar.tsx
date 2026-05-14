'use client';

import { cn } from './utils';
import type { Department } from '@/types';

// Dept-tinted avatar. The initial circle anchors every name on the page so
// people are recognizable as people, not strings. Color comes from department —
// 产品 = coral (signature), 研发 = sky, 职能 = forest, 运营 = amber, 老板 = ink.

const DEPT_PALETTE: Record<Department, { bg: string; border: string; text: string; ring: string }> = {
  产品: { bg: 'bg-white', border: 'border-rule', text: 'text-ink', ring: 'ring-rule' },
  研发: { bg: 'bg-sky/12', border: 'border-sky/40', text: 'text-sky', ring: 'ring-sky/30' },
  职能: { bg: 'bg-forest/12', border: 'border-forest/40', text: 'text-forest', ring: 'ring-forest/30' },
  运营: { bg: 'bg-amber/12', border: 'border-amber/40', text: 'text-amber', ring: 'ring-amber/30' },
  老板: { bg: 'bg-ink-soft/12', border: 'border-ink-soft/40', text: 'text-ink-soft', ring: 'ring-ink-soft/30' },
};

const SIZES = {
  xs: { box: 'w-5 h-5', text: 'text-[9.5px]' },
  sm: { box: 'w-7 h-7', text: 'text-[11px]' },
  md: { box: 'w-9 h-9', text: 'text-[13px]' },
  lg: { box: 'w-11 h-11', text: 'text-[16px]' },
  xl: { box: 'w-14 h-14', text: 'text-[20px]' }
} as const;

export function Avatar({
  name,
  dept = '产品',
  size = 'md',
  className,
  ringed = false
}: {
  name: string;
  dept?: Department | string;
  size?: keyof typeof SIZES;
  className?: string;
  ringed?: boolean;
}) {
  const initial = nameInitial(name);
  const palette =
    DEPT_PALETTE[dept as Department] ?? { bg: 'bg-paper-subtle', border: 'border-rule', text: 'text-ink', ring: 'ring-rule' };
  const s = SIZES[size];

  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex items-center justify-center rounded-full border font-serif font-medium select-none shrink-0',
        s.box,
        s.text,
        palette.bg,
        palette.border,
        palette.text,
        ringed && `ring-2 ring-offset-1 ring-offset-paper-card ${palette.ring}`,
        className
      )}
      title={name}
    >
      {initial}
    </span>
  );
}

// For Chinese names, show the family name (first char). For English names,
// show the first letter capitalized. For empty → ?
function nameInitial(name: string): string {
  if (!name) return '?';
  // First codepoint, handles surrogate pairs.
  const ch = Array.from(name)[0] ?? '?';
  // Latin → uppercase. CJK and others → as-is.
  const code = ch.codePointAt(0) ?? 0;
  return code < 128 ? ch.toUpperCase() : ch;
}

// Inline member badge — avatar + name. Use everywhere a person is mentioned
// in a sentence-ish flow (recommendations, action cards, decomposition assignees).
export function MemberInline({
  name,
  dept,
  size = 'sm',
  emphasis = false
}: {
  name: string;
  dept?: Department | string;
  size?: keyof typeof SIZES;
  emphasis?: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 align-middle">
      <Avatar name={name} dept={dept} size={size} />
      <span
        className={cn(
          'font-serif',
          emphasis ? 'text-ink font-semibold' : 'text-ink',
          size === 'xs' && 'text-[12px]',
          size === 'sm' && 'text-[13.5px]',
          size === 'md' && 'text-[15px]',
          size === 'lg' && 'text-[17px]'
        )}
      >
        {name}
      </span>
    </span>
  );
}

// Compact card. Use in /org grid, decomposition, anywhere a person sits in a row.
export function MemberChip({
  name,
  dept,
  role,
  rightSlot,
  href,
  active = false
}: {
  name: string;
  dept?: Department | string;
  role?: string;
  rightSlot?: React.ReactNode;
  href?: string;
  active?: boolean;
}) {
  const Inner = (
    <div
      className={cn(
        'group relative flex items-center gap-3 rounded-xl border px-3 py-2.5 transition-all',
        'bg-paper-card border-rule-soft hover:border-rule-strong hover:shadow-card hover:-translate-y-px'
      )}
    >
      {active && (
        <span
          aria-hidden
          className="absolute top-2.5 right-2.5 w-1.5 h-1.5 rounded-full bg-coral"
          title="Profile built"
        />
      )}
      <Avatar name={name} dept={dept} size="md" />
      <div className="min-w-0 flex-1">
        <div className="font-serif text-[15.5px] leading-tight text-ink truncate tracking-tight">
          {name}
        </div>
        {role && (
          <div className="text-[10.5px] uppercase tracking-[0.06em] text-ink-quiet truncate leading-tight mt-0.5 font-mono">
            {role}
          </div>
        )}
      </div>
      {rightSlot && <div className="shrink-0">{rightSlot}</div>}
    </div>
  );

  if (href) {
    return (
      <a href={href} className="block">
        {Inner}
      </a>
    );
  }
  return Inner;
}
