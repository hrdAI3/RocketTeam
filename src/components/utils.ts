import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

// Relative time string: "just now", "5m ago", "2h ago", "3d ago", "2mo ago".
export function ago(iso: string | undefined | null): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const seconds = Math.max(0, (Date.now() - t) / 1000);
  if (seconds < 30) return 'just now';
  if (seconds < 60) return `${Math.floor(seconds)}s ago`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.floor(minutes)}m ago`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.floor(hours)}h ago`;
  const days = hours / 24;
  if (days < 30) return `${Math.floor(days)}d ago`;
  const months = days / 30;
  return `${Math.floor(months)}mo ago`;
}

export function formatPercent(n: number, digits = 0): string {
  return `${(n * 100).toFixed(digits)}%`;
}

// Department enums are stored in Chinese on the wire; this maps them to the
// English labels shown in the UI. Unknown values pass through unchanged.
const DEPT_LABEL: Record<string, string> = {
  老板: 'Leadership',
  研发: 'Engineering',
  产品: 'Product',
  职能: 'Operations',
  运营: 'Growth',
  其他: 'Other'
};
export function deptLabel(dept: string | undefined | null): string {
  if (!dept) return '';
  return DEPT_LABEL[dept] ?? dept;
}
