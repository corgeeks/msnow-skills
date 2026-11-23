import type { Activity, FactoryEvent } from '../shared/types.ts';

export interface Bus {
  publish(e: FactoryEvent): void;
  subscribe(fn: (e: FactoryEvent) => void): () => void;
  /** Transient activity lines; never persisted. */
  publishActivity(a: Activity): void;
  subscribeActivity(fn: (a: Activity) => void): () => void;
}

export function createBus(): Bus {
  const events = new Set<(e: FactoryEvent) => void>();
  const activity = new Set<(a: Activity) => void>();
  return {
    publish(e) { for (const fn of events) fn(e); },
    subscribe(fn) { events.add(fn); return () => { events.delete(fn); }; },
    publishActivity(a) { for (const fn of activity) fn(a); },
    subscribeActivity(fn) { activity.add(fn); return () => { activity.delete(fn); }; },
  };
}
