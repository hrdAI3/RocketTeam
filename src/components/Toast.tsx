'use client';

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { cn } from './utils';

interface ToastItem {
  id: string;
  message: string;
  variant?: 'default' | 'success' | 'error';
}

interface ToastContextValue {
  push: (message: string, variant?: ToastItem['variant']) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside ToastProvider');
  return ctx;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const push = useCallback((message: string, variant: ToastItem['variant'] = 'default') => {
    const id = Math.random().toString(36).slice(2);
    setItems((prev) => [...prev, { id, message, variant }]);
    setTimeout(() => setItems((prev) => prev.filter((t) => t.id !== id)), 3500);
  }, []);

  return (
    <ToastContext.Provider value={{ push }}>
      {children}
      <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2" role="status" aria-live="polite">
        {items.map((t) => (
          <div
            key={t.id}
            className={cn(
              'rounded-md border px-3 py-2 text-body shadow-modal max-w-sm',
              t.variant === 'success' && 'bg-bg border-accent-success text-text-primary',
              t.variant === 'error' && 'bg-bg border-accent-danger text-text-primary',
              (!t.variant || t.variant === 'default') && 'bg-text-primary border-text-primary text-text-inverse'
            )}
          >
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
