import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

// Relative time string (Chinese): "5 分钟前", "2 小时前", "3 天前", "刚刚".
export function ago(iso: string | undefined | null): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const seconds = Math.max(0, (Date.now() - t) / 1000);
  if (seconds < 30) return '刚刚';
  if (seconds < 60) return `${Math.floor(seconds)} 秒前`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.floor(minutes)} 分钟前`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.floor(hours)} 小时前`;
  const days = hours / 24;
  if (days < 30) return `${Math.floor(days)} 天前`;
  const months = days / 30;
  return `${Math.floor(months)} 个月前`;
}

export function formatPercent(n: number, digits = 0): string {
  return `${(n * 100).toFixed(digits)}%`;
}
