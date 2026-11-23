import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { tx } from './db.ts';
import type { Bus } from './bus.ts';
import type {
  BatchItem, BatchResult, EventType, FactoryEvent, Gate, GateDecision, GateWithPr, ItemDetail, ItemStatus,
  ItemSummary, NodeRun, NodeStatus, Retro, Run, RunStatus, WorkItem,
} from '../shared/types.ts';

export class ConflictError extends Error { readonly code = 'conflict'; }
export class CycleError extends Error {
  readonly code = 'cycle';
  constructor(itemId: number, dependsOnId: number) {
    super(`dependency ${itemId} -> ${dependsOnId} would create a cycle`);
  }
}
export class NotFoundError extends Error { readonly code = 'not_found'; }

export type NewItem = Omit<BatchItem, 'ref' | 'parent_ref' | 'depends_on_refs'> & {
  parent_id?: number | null; depends_on?: number[];
};
export type ItemPatch = Partial<Pick<WorkItem, 'type' | 'title' | 'body' | 'spec_path' | 'tier' | 'test_cmd' | 'priority'>>;
export interface NewRun { item_id: number; template: string; attempt?: number }
export type RunPatch = Partial<Pick<Run, 'branch' | 'worktree' | 'pr_number' | 'pr_url' | 'head_sha' | 'cost_usd' | 'started_at' | 'ended_at'>>;
export interface NewNodeRun { run_id: number; node: string; iteration?: number; model?: string | null; session_file?: string | null }
export type NodeRunPatch = Partial<Pick<NodeRun, 'model' | 'session_file' | 'cost_usd' | 'output' | 'started_at' | 'ended_at'>>;
export interface NewGate { run_id: number; node: string; kind: string; question: string; recommendation?: string | null }

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`;
const ITEM_COLS = ['type', 'title', 'body', 'spec_path', 'tier', 'test_cmd', 'priority'] as const;
const RUN_COLS = ['branch', 'worktree', 'pr_number', 'pr_url', 'head_sha', 'cost_usd', 'started_at', 'ended_at'] as const;
const NODE_COLS = ['model', 'session_file', 'cost_usd', 'output', 'started_at', 'ended_at'] as const;

interface Scope { item_id?: number | null; run_id?: number | null; node?: string | null }
type Row = Record<string, SQLInputValue>;

export type Store = ReturnType<typeof createStore>;

export function createStore(db: DatabaseSync, bus: Bus) {
  const pending: FactoryEvent[] = [];
  const one = <T>(sql: string, ...p: SQLInputValue[]) => db.prepare(sql).get(...p) as T | undefined;
  const all = <T>(sql: string, ...p: SQLInputValue[]) => db.prepare(sql).all(...p) as T[];

  // Committed events publish strictly in queue (= sequence) order: a subscriber that writes while
  // events drain only appends to the queue, so its events can never overtake unpublished ones.
  let draining = false;
  function drain(): void {
    if (draining) return;
    draining = true;
    try { while (pending.length) bus.publish(pending.shift()!); } finally { draining = false; }
  }

  /** Runs a mutation in a tx; publishes its queued events after the outermost commit. */
  function mutate<T>(fn: () => T): T {
    const outer = !db.isTransaction;
    const mark = pending.length;
    let r: T;
    try {
      r = tx(db, fn);
    } catch (e) {
      pending.length = mark;
      throw e;
    }
    if (outer) drain();
    return r;
  }

  function emit(type: EventType, s: Scope, data: Record<string, unknown>): void {
    const row = one<FactoryEvent & { data: string }>(
      `INSERT INTO events (item_id, run_id, node, type, data) VALUES (?, ?, ?, ?, ?) RETURNING *`,
      s.item_id ?? null, s.run_id ?? null, s.node ?? null, type, JSON.stringify(data))!;
    pending.push({ ...row, data: JSON.parse(row.data) });
  }

  function must<T>(row: T | undefined, what: string): T {
    if (row === undefined) throw new NotFoundError(`${what} not found`);
    return row;
  }

  /** Whitelisted-column UPDATE; returns the changed fields. */
  function patch(table: string, id: number, cols: readonly string[], p: object, touch: boolean): Row {
    const changed: Row = {};
    for (const [k, v] of Object.entries(p)) if (cols.includes(k) && v !== undefined) changed[k] = v as SQLInputValue;
    const keys = Object.keys(changed);
    if (!keys.length) return changed;
    const set = keys.map((k) => `${k} = ?`).concat(touch ? [`updated_at = ${NOW}`] : []).join(', ');
    const res = db.prepare(`UPDATE ${table} SET ${set} WHERE id = ?`).run(...keys.map((k) => changed[k]), id);
    if (res.changes !== 1) throw new NotFoundError(`${table} ${id} not found`);
    return changed;
  }

  function cas(table: string, id: number, from: string, to: string, touch: string): void {
    const res = db.prepare(`UPDATE ${table} SET status = ?, ${touch} WHERE id = ? AND status = ?`).run(to, id, from);
    if (res.changes !== 1) throw new ConflictError(`${table} ${id} is not '${from}'`);
  }

  const reaches = db.prepare(`
    WITH RECURSIVE r(id) AS (
      SELECT depends_on_id FROM item_deps WHERE item_id = ?
      UNION SELECT d.depends_on_id FROM item_deps d JOIN r ON d.item_id = r.id)
    SELECT 1 FROM r WHERE id = ? LIMIT 1`);
  function insertDep(itemId: number, dependsOnId: number): void {
    if (itemId === dependsOnId || reaches.get(dependsOnId, itemId)) throw new CycleError(itemId, dependsOnId);
    db.prepare(`INSERT OR IGNORE INTO item_deps (item_id, depends_on_id) VALUES (?, ?)`).run(itemId, dependsOnId);
  }

  function insertItem(i: NewItem): number {
    const row = one<{ id: number }>(
      `INSERT INTO work_items (parent_id, type, title, body, spec_path, tier, test_cmd, priority, status, source_ref)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      i.parent_id ?? null, i.type ?? 'task', i.title, i.body ?? '', i.spec_path ?? null, i.tier ?? null,
      i.test_cmd ?? null, i.priority ?? 0, i.status ?? 'draft', i.source_ref ?? null)!;
    return row.id;
  }

  const getItem = (id: number): WorkItem => must(one<WorkItem>(`SELECT * FROM work_items WHERE id = ?`, id), `item ${id}`);
  const getRun = (id: number): Run => must(one<Run>(`SELECT * FROM runs WHERE id = ?`, id), `run ${id}`);
  const getNodeRun = (id: number): NodeRun => must(one<NodeRun>(`SELECT * FROM node_runs WHERE id = ?`, id), `node run ${id}`);
  const getGate = (id: number): Gate => must(one<Gate>(`SELECT * FROM gates WHERE id = ?`, id), `gate ${id}`);

  function emitCreated(id: number, depends_on: number[]): WorkItem {
    const item = getItem(id);
    emit('item.created', { item_id: id }, { ...item, depends_on });
    return item;
  }

  return {
    /** Runs `fn` as one transaction; events from its writes publish after commit. */
    atomic: mutate,

    // ── items ──
    createItem(i: NewItem): WorkItem {
      return mutate(() => {
        const id = insertItem(i);
        for (const d of i.depends_on ?? []) insertDep(id, d);
        return emitCreated(id, i.depends_on ?? []);
      });
    },

    /** One transaction; refs resolve within the batch; existing `source_ref`s are skipped. */
    createItemsBatch(items: BatchItem[]): BatchResult {
      return mutate(() => {
        const res: BatchResult = { ids: {}, created: [], skipped: [] };
        for (const b of items) {
          if (b.ref in res.ids) throw new ConflictError(`duplicate ref '${b.ref}'`);
          const existing = b.source_ref != null
            ? one<{ id: number }>(`SELECT id FROM work_items WHERE source_ref = ?`, b.source_ref) : undefined;
          if (existing) { res.ids[b.ref] = existing.id; res.skipped.push(b.ref); continue; }
          res.ids[b.ref] = insertItem(b);
          res.created.push(b.ref);
        }
        const resolve = (ref: string) => must(res.ids[ref], `batch ref '${ref}'`);
        const byRef = new Map(items.map((b) => [b.ref, b]));
        for (const ref of res.created) {
          const b = byRef.get(ref)!;
          if (b.parent_ref !== undefined) {
            db.prepare(`UPDATE work_items SET parent_id = ? WHERE id = ?`).run(resolve(b.parent_ref), res.ids[ref]);
          }
          for (const d of b.depends_on_refs ?? []) insertDep(res.ids[ref], resolve(d));
        }
        for (const ref of res.created) {
          emitCreated(res.ids[ref], (byRef.get(ref)!.depends_on_refs ?? []).map(resolve));
        }
        return res;
      });
    },

    getItem,

    listItems(f: { status?: ItemStatus; parent_id?: number; type?: string } = {}): ItemSummary[] {
      return all<ItemSummary>(
        `SELECT w.*, (SELECT count(*) FROM item_deps d JOIN work_items x ON x.id = d.depends_on_id
                      WHERE d.item_id = w.id AND x.status <> 'done') AS open_deps
         FROM work_items w
         WHERE (?1 IS NULL OR w.status = ?1) AND (?2 IS NULL OR w.parent_id = ?2) AND (?3 IS NULL OR w.type = ?3)
         ORDER BY w.id`,
        f.status ?? null, f.parent_id ?? null, f.type ?? null);
    },

    getItemDetail(id: number): ItemDetail {
      return {
        item: getItem(id),
        deps: all<WorkItem>(`SELECT w.* FROM item_deps d JOIN work_items w ON w.id = d.depends_on_id WHERE d.item_id = ? ORDER BY w.id`, id),
        dependents: all<WorkItem>(`SELECT w.* FROM item_deps d JOIN work_items w ON w.id = d.item_id WHERE d.depends_on_id = ? ORDER BY w.id`, id),
        children: all<WorkItem>(`SELECT * FROM work_items WHERE parent_id = ? ORDER BY id`, id),
        runs: all<Run>(`SELECT * FROM runs WHERE item_id = ? ORDER BY id`, id),
      };
    },

    updateItem(id: number, p: ItemPatch): WorkItem {
      return mutate(() => {
        const changed = patch('work_items', id, ITEM_COLS, p, true);
        emit('item.updated', { item_id: id }, changed);
        return getItem(id);
      });
    },

    transitionItem(id: number, from: ItemStatus, to: ItemStatus): WorkItem {
      return mutate(() => {
        cas('work_items', id, from, to, `updated_at = ${NOW}`);
        emit('item.updated', { item_id: id }, { status: to, from });
        return getItem(id);
      });
    },

    // ── dependencies ──
    addDep(itemId: number, dependsOnId: number): void {
      mutate(() => {
        insertDep(itemId, dependsOnId);
        emit('item.updated', { item_id: itemId }, { depends_on: dependsOnId });
      });
    },
    removeDep(itemId: number, dependsOnId: number): void {
      mutate(() => {
        const res = db.prepare(`DELETE FROM item_deps WHERE item_id = ? AND depends_on_id = ?`).run(itemId, dependsOnId);
        if (res.changes !== 1) throw new NotFoundError(`dependency ${itemId} -> ${dependsOnId} not found`);
        emit('item.updated', { item_id: itemId }, { depends_on: dependsOnId, removed: true });
      });
    },
    getDeps: (id: number) => all<WorkItem>(`SELECT w.* FROM item_deps d JOIN work_items w ON w.id = d.depends_on_id WHERE d.item_id = ? ORDER BY w.id`, id),
    getDependents: (id: number) => all<WorkItem>(`SELECT w.* FROM item_deps d JOIN work_items w ON w.id = d.item_id WHERE d.depends_on_id = ? ORDER BY w.id`, id),
    getChildren: (id: number) => all<WorkItem>(`SELECT * FROM work_items WHERE parent_id = ? ORDER BY id`, id),

    /** Queued items whose deps are all done, highest priority first. */
    dispatchableItems(): WorkItem[] {
      return all<WorkItem>(
        `SELECT w.* FROM work_items w
         WHERE w.status = 'queued' AND NOT EXISTS (
           SELECT 1 FROM item_deps d JOIN work_items x ON x.id = d.depends_on_id
           WHERE d.item_id = w.id AND x.status <> 'done')
         ORDER BY w.priority DESC, w.id ASC`);
    },

    // ── runs ──
    createRun(r: NewRun): Run {
      return mutate(() => {
        const attempt = r.attempt
          ?? one<{ n: number }>(`SELECT coalesce(max(attempt), 0) + 1 AS n FROM runs WHERE item_id = ?`, r.item_id)!.n;
        const run = one<Run>(`INSERT INTO runs (item_id, template, attempt) VALUES (?, ?, ?) RETURNING *`,
          r.item_id, r.template, attempt)!;
        emit('run.created', { item_id: run.item_id, run_id: run.id }, { ...run });
        return run;
      });
    },
    getRun,
    listRuns(f: { item_id?: number } = {}): Run[] {
      return all<Run>(`SELECT * FROM runs WHERE (?1 IS NULL OR item_id = ?1) ORDER BY id`, f.item_id ?? null);
    },
    updateRun(id: number, p: RunPatch): Run {
      return mutate(() => {
        const changed = patch('runs', id, RUN_COLS, p, false);
        const run = getRun(id);
        emit('run.updated', { item_id: run.item_id, run_id: id }, changed);
        return run;
      });
    },
    transitionRun(id: number, from: RunStatus, to: RunStatus): Run {
      return mutate(() => {
        cas('runs', id, from, to, `started_at = coalesce(started_at, ${NOW})`);
        const run = getRun(id);
        emit('run.updated', { item_id: run.item_id, run_id: id }, { status: to, from });
        return run;
      });
    },

    // ── node runs ──
    createNodeRun(n: NewNodeRun): NodeRun {
      return mutate(() => {
        const nr = one<NodeRun>(
          `INSERT INTO node_runs (run_id, node, iteration, model, session_file) VALUES (?, ?, ?, ?, ?) RETURNING *`,
          n.run_id, n.node, n.iteration ?? 1, n.model ?? null, n.session_file ?? null)!;
        emit('node.updated', { item_id: getRun(n.run_id).item_id, run_id: n.run_id, node: n.node }, { ...nr });
        return nr;
      });
    },
    updateNodeRun(id: number, p: NodeRunPatch): NodeRun {
      return mutate(() => {
        const changed = patch('node_runs', id, NODE_COLS, p, false);
        const nr = getNodeRun(id);
        emit('node.updated', { item_id: getRun(nr.run_id).item_id, run_id: nr.run_id, node: nr.node }, changed);
        return nr;
      });
    },
    transitionNodeRun(id: number, from: NodeStatus, to: NodeStatus): NodeRun {
      return mutate(() => {
        cas('node_runs', id, from, to, `started_at = coalesce(started_at, ${NOW})`);
        const nr = getNodeRun(id);
        emit('node.updated', { item_id: getRun(nr.run_id).item_id, run_id: nr.run_id, node: nr.node }, { status: to, from });
        return nr;
      });
    },
    listNodeRuns: (runId: number) => all<NodeRun>(`SELECT * FROM node_runs WHERE run_id = ? ORDER BY id`, runId),

    // ── gates ──
    openGate(g: NewGate): Gate {
      return mutate(() => {
        const gate = one<Gate>(
          `INSERT INTO gates (run_id, node, kind, question, recommendation) VALUES (?, ?, ?, ?, ?) RETURNING *`,
          g.run_id, g.node, g.kind, g.question, g.recommendation ?? null)!;
        emit('gate.opened', { item_id: getRun(g.run_id).item_id, run_id: g.run_id, node: g.node }, { ...gate });
        return gate;
      });
    },
    decideGate(id: number, decision: GateDecision, note?: string): Gate {
      return mutate(() => {
        const res = db.prepare(`UPDATE gates SET decision = ?, note = ?, closed_at = ${NOW} WHERE id = ? AND closed_at IS NULL`)
          .run(decision, note ?? null, id);
        const gate = getGate(id);
        if (res.changes !== 1) throw new ConflictError(`gate ${id} is already closed`);
        emit('gate.closed', { item_id: getRun(gate.run_id).item_id, run_id: gate.run_id, node: gate.node },
          { id, decision, note: gate.note, closed_at: gate.closed_at });
        return gate;
      });
    },
    /** open=true: open gates only. Otherwise open first, then closed by closed_at desc, max 100. */
    listGates(f: { open?: boolean; run_id?: number } = {}): GateWithPr[] {
      return all<GateWithPr>(
        `SELECT g.*, r.pr_number, r.pr_url FROM gates g JOIN runs r ON r.id = g.run_id
         WHERE (?1 IS NULL OR g.run_id = ?1) AND (?2 = 0 OR g.closed_at IS NULL)
         ORDER BY g.closed_at IS NOT NULL, g.closed_at DESC, g.id LIMIT 100`,
        f.run_id ?? null, f.open ? 1 : 0);
    },

    /** Every gate of a run, oldest first; uncapped (unlike listGates) so engine decisions and prompts see the full history. */
    listRunGates: (runId: number) => all<Gate>(`SELECT * FROM gates WHERE run_id = ? ORDER BY id`, runId),

    // ── retros ──
    recordRetro(r: Retro): void {
      mutate(() => {
        db.prepare(`INSERT INTO retros (run_id, failures, findings, rework_count, cost_usd, duration_s, notes)
                    VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(r.run_id, JSON.stringify(r.failures), JSON.stringify(r.findings), r.rework_count, r.cost_usd, r.duration_s, r.notes);
        emit('retro.recorded', { item_id: getRun(r.run_id).item_id, run_id: r.run_id }, { ...r });
      });
    },
    getRetro(runId: number): Retro | undefined {
      const row = one<Retro & { failures: string; findings: string }>(`SELECT * FROM retros WHERE run_id = ?`, runId);
      return row && { ...row, failures: JSON.parse(row.failures), findings: JSON.parse(row.findings) };
    },

    // ── events ──
    listEvents(f: { after?: number; limit?: number } = {}): FactoryEvent[] {
      return all<FactoryEvent & { data: string }>(`SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?`,
        f.after ?? 0, f.limit ?? 100).map((e) => ({ ...e, data: JSON.parse(e.data) }));
    },
  };
}
