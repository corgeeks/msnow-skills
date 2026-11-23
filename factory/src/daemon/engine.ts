import { ConflictError } from './store.ts';
import { runChange as realRunChange, INTERRUPTED, type ChangeContext } from './template-change.ts';
import type * as Worktrees from './worktrees.ts';
import type { Config, FactoryEvent, ItemStatus } from '../shared/types.ts';

export type EngineDeps = Omit<ChangeContext, 'runId' | 'stopped'> & {
  worktrees: ChangeContext['worktrees'] & Pick<typeof Worktrees, 'createWorktree' | 'pruneWorktrees'>;
  runChange?: typeof realRunChange;
  tickMs?: number;
};

export function validateReviewerMapping(config: Config): void {
  for (const model of Object.values(config.roles.executor)) {
    const f = model.split('/')[0];
    if (!config.roles.reviewer[f]) throw new Error(`config error: roles.reviewer has no entry for family "${f}" (executor ${model})`);
  }
}

const now = () => new Date().toISOString();
const log = (msg: string, e?: unknown) => console.error(`engine: ${msg}${e ? `: ${(e as Error).message ?? e}` : ''}`);

export function createEngine(deps: EngineDeps) {
  const { store, config, paths, forge, worktrees: wt, bus } = deps;
  const runChange = deps.runChange ?? realRunChange;
  const inFlight = new Map<number, Promise<void>>();
  let stopped = false;
  let ticking: Promise<void> | undefined;
  let again = false;
  let unsubscribe: (() => void) | undefined;
  let timer: NodeJS.Timeout | undefined;

  const ctxDeps = { ...deps };
  delete ctxDeps.runChange;
  delete ctxDeps.tickMs;

  function launch(runId: number) {
    if (stopped || inFlight.has(runId)) return;
    const p = runChange({ ...ctxDeps, runId, stopped: () => stopped })
      .catch((e) => log(`run ${runId} failed`, e))
      .finally(() => inFlight.delete(runId));
    inFlight.set(runId, p);
  }

  async function dispatch() {
    const free = config.loop.maxParallel - store.listRuns({}).filter((r) => r.status === 'running').length;
    const items = store.dispatchableItems().filter((i) => store.getChildren(i.id).length === 0).slice(0, Math.max(0, free));
    for (const item of items) {
      if (stopped) return;
      try {
        store.transitionItem(item.id, 'queued', 'active');
      } catch (e) {
        if (e instanceof ConflictError) { log(`item ${item.id} already taken`, e); continue; }
        throw e;
      }
      try {
        const attempt = Math.max(0, ...store.listRuns({ item_id: item.id }).map((r) => r.attempt)) + 1;
        await forge.fetch();
        const w = wt.createWorktree(paths.root, { itemId: item.id, attempt, base: 'origin/main' });
        const run = store.createRun({ item_id: item.id, template: 'change', attempt });
        store.updateRun(run.id, { branch: w.branch, worktree: w.path, started_at: now() });
        store.transitionRun(run.id, 'pending', 'running');
        launch(run.id);
      } catch (e) {
        log(`dispatch of item ${item.id} failed`, e);
        try { store.transitionItem(item.id, 'active', 'queued'); } catch (e2) { log(`requeue of item ${item.id} failed`, e2); }
      }
    }
  }

  /** Never overlaps: a request during a tick runs exactly one more tick afterwards. */
  function tick(): Promise<void> {
    if (stopped) return Promise.resolve();
    if (ticking) { again = true; return ticking; }
    const { promise, resolve } = Promise.withResolvers<void>();
    ticking = promise; // set before dispatch runs: its store writes emit events that re-enter tick() synchronously
    void (async () => {
      try {
        do { again = false; await dispatch(); } while (again && !stopped);
      } catch (e) {
        log('tick failed', e);
      } finally {
        ticking = undefined;
        resolve();
      }
    })();
    return promise;
  }

  function rollUp(itemId: number) {
    let id = store.getItem(itemId).parent_id;
    while (id !== null) {
      const parent = store.getItem(id);
      const kids = store.getChildren(id).map((c) => c.status);
      const target: ItemStatus | undefined = kids.every((s) => s === 'done' || s === 'cancelled') ? 'done'
        : kids.some((s) => s === 'active' || s === 'queued' || s === 'blocked') ? 'active' : undefined;
      if (target && target !== parent.status) {
        try { store.transitionItem(id, parent.status, target); } catch (e) {
          if (e instanceof ConflictError) { log(`roll-up of item ${id} conflicted`, e); return; }
          throw e;
        }
      }
      id = parent.parent_id;
    }
  }

  function onEvent(e: FactoryEvent) {
    if (stopped) return;
    try {
      if (e.type === 'item.updated' && e.item_id !== null && ['done', 'cancelled', 'blocked'].includes(e.data.status as string)) rollUp(e.item_id);
      if (e.type === 'gate.closed' && e.run_id !== null && store.getRun(e.run_id).status === 'paused') launch(e.run_id);
    } catch (err) {
      log(`handling ${e.type} failed`, err);
    }
    if (e.type === 'item.updated' || e.type === 'gate.closed' || e.type === 'run.updated') void tick();
  }

  return {
    async start() {
      wt.pruneWorktrees(paths.root);
      for (const run of store.listRuns({})) {
        if (run.status === 'running') {
          for (const n of store.listNodeRuns(run.id)) {
            if (n.status !== 'running') continue;
            store.transitionNodeRun(n.id, 'running', 'failed');
            store.updateNodeRun(n.id, { output: INTERRUPTED, ended_at: now() });
          }
          launch(run.id);
        } else if (run.status === 'paused') {
          const gates = store.listGates({ run_id: run.id });
          const last = gates.reduce<(typeof gates)[number] | undefined>((m, g) => (!m || g.id > m.id ? g : m), undefined);
          if (last?.closed_at) launch(run.id);
        }
      }
      unsubscribe = bus.subscribe(onEvent);
      timer = setInterval(() => void tick(), deps.tickMs ?? 5000);
      await tick();
    },
    async stop() {
      stopped = true;
      unsubscribe?.();
      clearInterval(timer);
      await ticking;
    },
    /** @internal for tests */
    tick,
  };
}
