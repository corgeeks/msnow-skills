import { useEffect, useState } from 'react';
import { fetchJson, type Activity, type EventType, type Path } from './api.ts';

let source: EventSource | undefined;
const events = () => (source ??= new EventSource('/events'));
export const ACTIVITY_LIMIT = 200;

export function useResource<T>(url: Path<T> | null, { refetchOn }: { refetchOn: EventType[] }): { data?: T; error?: Error } {
  const [state, setState] = useState<{ url?: string; data?: T; error?: Error }>({});
  const [tick, setTick] = useState(0);
  const types = refetchOn.join(' ');
  useEffect(() => {
    const es = events(), bump = () => setTick((t) => t + 1), names = [...types.split(' ').filter(Boolean), 'open'];
    names.forEach((n) => es.addEventListener(n, bump));
    return () => names.forEach((n) => es.removeEventListener(n, bump));
  }, [types]);
  useEffect(() => {
    if (!url) return;
    const ac = new AbortController();
    fetchJson(url, ac.signal).then(
      (data) => setState({ url, data }),
      (error: Error) => { if (!ac.signal.aborted) setState((s) => ({ url, data: s.url === url ? s.data : undefined, error })); });
    return () => ac.abort(); // a newer event supersedes an in-flight fetch
  }, [url, tick]);
  return state.url === url ? { data: state.data, error: state.error } : {}; // no stale data across URLs
}

/** This run's `activity` frames since mount, oldest→newest, capped to the last ACTIVITY_LIMIT. */
export function useActivity(runId: number): Activity[] {
  const [lines, setLines] = useState<Activity[]>([]);
  useEffect(() => {
    setLines([]);
    const es = events();
    const onActivity = (e: MessageEvent<string>) => {
      const a = JSON.parse(e.data) as Activity;
      if (a.run_id === runId) setLines((l) => [...l, a].slice(-ACTIVITY_LIMIT));
    };
    es.addEventListener('activity', onActivity);
    return () => es.removeEventListener('activity', onActivity);
  }, [runId]);
  return lines;
}
