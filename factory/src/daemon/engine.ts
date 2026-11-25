import { ConflictError } from './store.ts';
import { git } from './git.ts';
import { runChange as realRunChange, runTest, INTERRUPTED, type ChangeContext } from './template-change.ts';
import type * as Worktrees from './worktrees.ts';
import type { Config, FactoryEvent, ItemStatus, MainHealth } from '../shared/types.ts';

export type EngineDeps = Omit<ChangeContext, 'runId' | 'stopped'> & {
  worktrees: ChangeContext['worktrees'] & Pick<typeof Worktrees, 'createWorktree' | 'pruneWorktrees'>;
  runChange?: typeof realRunChange;
  tickMs?: number;
  /** Minimum ms between origin fetches for the main-health check (default 60 s). */
  mainPollMs?: number;
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
  delete ctxDeps.mainPollMs;

  // Main health: one default-test run per origin/main SHA, cached in memory.
  type MainResult = Omit<MainHealth, 'sha'> & { exit_code: number; output: string };
  const mainResults = new Map<string, MainResult>();
  let main: MainHealth | undefined;
  let lastFetch = 0;
  const mainPollMs = deps.mainPollMs ?? 60_000;

  const abort = new AbortController();

  /** A commit that only touches the state DB cannot change test outcomes. `--no-renames` so a rename cannot hide a second path; an empty diff (same tree, other SHA) is not state-only. */
  function stateOnly(cwd: string, from: string, to: string): boolean {
    try {
      const files = git(cwd, ['diff', '--name-only', '--no-renames', from, to]).split('\n').filter(Boolean);
      return files.length === 1 && files[0] === '.factory/factory.db';
    } catch { return false; }
  }

  /**
   * Syncs `.factory/main` (in the forge queue) and tests it unless its SHA, or its code, was already tested.
   * Fetches at most once per `mainPollMs`; a green main is not re-fetched while nothing is dispatchable.
   * Returns the SHA when main is green (the dispatch base), else undefined. Throws on infra errors, so dispatch stays closed.
   */
  async function checkMain(dispatchable: boolean): Promise<string | undefined> {
    const green = () => (!stopped && main?.status === 'green' ? main.sha : undefined);
    if (main && (Date.now() - lastFetch < mainPollMs || (main.status === 'green' && !dispatchable))) return green();
    lastFetch = Date.now();
    await forge.withMain(async ({ sha, path }) => {
      let r = mainResults.get(sha);
      if (!r) {
        const prev = main && stateOnly(path, main.sha, sha) ? mainResults.get(main.sha) : undefined;
        if (prev) r = prev;
        else {
          const t = await runTest(config.defaultTestCmd, path, abort.signal);
          if (stopped) return; // killed by stop(): the result is meaningless
          r = { status: t.code === 0 ? 'green' : 'red', checked_at: now(), exit_code: t.code, output: t.tail.split('\n').slice(-50).join('\n') };
        }
        mainResults.set(sha, r);
        if (r.status === 'red') store.recordEvent('main.red', { sha, exit_code: r.exit_code, output: r.output });
      }
      if (main?.status === 'red' && r.status === 'green') store.recordEvent('main.green', { sha });
      main = { sha, status: r.status, checked_at: r.checked_at };
    });
    return green();
  }

  function launch(runId: number) {
    if (stopped || inFlight.has(runId)) return;
    const p = runChange({ ...ctxDeps, runId, stopped: () => stopped })
      .catch((e) => log(`run ${runId} failed`, e))
      .finally(() => inFlight.delete(runId));
    inFlight.set(runId, p);
  }

  async function dispatch() {
    // Health first, every tick; eligibility and capacity are re-read after the (slow) check.
    const eligible = () => {
      const free = config.loop.maxParallel - store.listRuns({}).filter((r) => r.status === 'running').length;
      return store.dispatchableItems().filter((i) => store.getChildren(i.id).length === 0).slice(0, Math.max(0, free));
    };
    const base = await checkMain(eligible().length > 0);
    if (!base) return;
    const items = eligible();
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
        const w = wt.createWorktree(paths.root, { itemId: item.id, attempt, base }); // the tested SHA, never a moving origin/main
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
      abort.abort();
      unsubscribe?.();
      clearInterval(timer);
      await ticking;
    },
    mainHealth: (): MainHealth | undefined => main,
    /** @internal for tests */
    tick,
  };
}
