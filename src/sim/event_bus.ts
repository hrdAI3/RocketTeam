// In-memory event bus for live推演 streaming.
//
// Server runs the simulation in the background (independent of any single
// HTTP request). Clients subscribe via /api/sim/[id]/stream — the bus replays
// buffered events on subscribe so late joiners catch up, then forwards live
// events as the runner emits them.
//
// Buffer is per-sim_id and capped. When a sim emits 'sim_completed' or
// 'sim_failed' or 'decision' (terminal), the buffer is retained for ~10
// minutes so users can re-attach after navigation, then GC'd.

import { EventEmitter } from 'node:events';
import type { SimEvent } from './runner';

export type LiveEvent =
  | SimEvent
  | { type: 'synthesizing'; sim_id: string }
  | { type: 'decision'; sim_id: string; task: unknown }
  | { type: 'done'; sim_id: string; task_id: string }
  | { type: 'error'; sim_id: string; error: string };

interface SimBuffer {
  events: LiveEvent[];
  terminal: boolean;
  finishedAt?: number;
}

// Hoist to globalThis so Next.js dev-mode HMR (which reloads modules) does
// not wipe the buffer + emitter mid-run. In production this just behaves
// like a normal singleton.
declare global {
  // eslint-disable-next-line no-var
  var __simEventBus: { buffers: Map<string, SimBuffer>; emitter: EventEmitter } | undefined;
}

const _g = (globalThis as unknown as { __simEventBus?: { buffers: Map<string, SimBuffer>; emitter: EventEmitter } });
if (!_g.__simEventBus) {
  const em = new EventEmitter();
  em.setMaxListeners(64);
  _g.__simEventBus = { buffers: new Map(), emitter: em };
}
const buffers = _g.__simEventBus.buffers;
const emitter = _g.__simEventBus.emitter;

const RETAIN_MS = 10 * 60 * 1000;

export function publish(sim_id: string, event: LiveEvent): void {
  let buf = buffers.get(sim_id);
  if (!buf) {
    buf = { events: [], terminal: false };
    buffers.set(sim_id, buf);
  }
  buf.events.push(event);
  if (event.type === 'sim_completed' || event.type === 'sim_failed' || event.type === 'done' || event.type === 'error') {
    buf.terminal = true;
    buf.finishedAt = Date.now();
    setTimeout(() => {
      const b = buffers.get(sim_id);
      if (b && b.terminal && b.finishedAt && Date.now() - b.finishedAt >= RETAIN_MS) {
        buffers.delete(sim_id);
      }
    }, RETAIN_MS + 1000).unref?.();
  }
  emitter.emit(sim_id, event);
}

export interface Subscription {
  buffered: LiveEvent[];
  unsubscribe: () => void;
  on: (cb: (e: LiveEvent) => void) => void;
}

export function subscribe(sim_id: string): Subscription {
  const buf = buffers.get(sim_id);
  const buffered = buf ? [...buf.events] : [];
  let listener: ((e: LiveEvent) => void) | null = null;
  return {
    buffered,
    on(cb) {
      if (listener) emitter.off(sim_id, listener);
      listener = cb;
      emitter.on(sim_id, listener);
    },
    unsubscribe() {
      if (listener) emitter.off(sim_id, listener);
      listener = null;
    }
  };
}

export function isTerminal(sim_id: string): boolean {
  return buffers.get(sim_id)?.terminal ?? false;
}

// Cancellation registry — runner / executor check this each round.
const cancelled = new Set<string>();
export function requestCancel(sim_id: string): void {
  cancelled.add(sim_id);
  publish(sim_id, { type: 'error', sim_id, error: '用户取消推演' });
}
export function isCancelled(sim_id: string): boolean {
  return cancelled.has(sim_id);
}
