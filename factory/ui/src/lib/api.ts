import type { WorkItem, ItemSummary, ItemDetail, Run, RunDetail, NodeRun, Gate, Activity, EventType, ItemStatus, RunStatus, NodeStatus } from '../../../src/shared/types.ts';
export type { WorkItem, ItemSummary, ItemDetail, Run, RunDetail, NodeRun, Gate, Activity, EventType, ItemStatus, RunStatus, NodeStatus };

export type Path<T> = string & { readonly __response: T }; // phantom: ties a URL to its response type
const path = <T>(p: string) => p as Path<T>;

export const api = {
  items: () => path<ItemSummary[]>('/api/items'),
  item: (id: number) => path<ItemDetail>(`/api/items/${id}`),
  runs: () => path<Run[]>('/api/runs'),
  run: (id: number) => path<RunDetail>(`/api/runs/${id}`),
  gates: () => path<Gate[]>('/api/gates'), // open first, then closed by closed_at desc (server limit 100)
};

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function fetchJson<T>(url: Path<T>, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal });
  const body = await res.json().catch(() => undefined);
  if (!res.ok) {
    const e = body?.error;
    throw new ApiError(res.status, e?.code ?? 'http_error', e?.message ?? `${res.status} ${res.statusText}`);
  }
  return body as T;
}
