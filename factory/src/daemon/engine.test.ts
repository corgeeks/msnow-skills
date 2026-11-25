import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { openDb } from './db.ts';
import { createBus } from './bus.ts';
import { createStore } from './store.ts';
import { runSession } from './omp.ts';
import * as worktrees from './worktrees.ts';
import { DEFAULT_CONFIG } from '../shared/config.ts';
import { createEngine, validateReviewerMapping } from './engine.ts';
import { INTERRUPTED, runChange as realRunChange, type ChangeContext } from './template-change.ts';
import { makeRepos } from '../../test/fixtures/git-repos.ts';
import { createForge } from './forge.ts';
import { createQueue, git } from './git.ts';

async function until(cond: () => boolean, ms = 3000) {
  for (const end = Date.now() + ms; !cond(); await sleep(10)) if (Date.now() > end) throw new Error('timed out');
}

function setup(t: TestContext, maxParallel = 2, failFirst = false, mainPollMs = 0, clock?: () => number) {
  const repos = makeRepos();
  const db = openDb(join(repos.dir, 'f.db'));
  const bus = createBus();
  const store = createStore(db, bus);
  const config = structuredClone(DEFAULT_CONFIG);
  config.loop.maxParallel = maxParallel;
  // Red while BROKEN exists on main; each run is logged outside the worktree.
  const testLog = join(repos.dir, 'main-tests.log');
  config.defaultTestCmd = `echo run >> ${testLog}; echo broken main; test ! -e BROKEN`;
  git(repos.root, ['worktree', 'add', '--detach', repos.mainWorktree, 'origin/main']);
  const calls: { ctx: ChangeContext; resolve: () => void }[] = [];
  const runChange = (ctx: ChangeContext) => {
    const { promise, resolve } = Promise.withResolvers<void>();
    calls.push({ ctx, resolve });
    // Real runChange whose build session throws unexpectedly; later calls hang like the stub.
    if (failFirst && calls.length === 1) return realRunChange({ ...ctx, runSession: () => { throw new Error('boom'); } });
    return promise;
  };
  const queue = createQueue();
  const forge = createForge({ root: repos.root, mainWorktree: repos.mainWorktree, queue });
  const engine = createEngine({
    store, bus, config, paths: { root: repos.root, sessionsDir: join(repos.dir, 'sessions') }, runSession,
    worktrees, forge, committer: { flush: async () => {} }, runChange, tickMs: 60_000, mainPollMs, clock,
  });
  t.after(async () => { await engine.stop(); db.close(); rmSync(repos.dir, { recursive: true, force: true }); });
  const runIds = () => calls.map((c) => c.ctx.runId);
  const pausedRun = (itemId: number) => {
    const r = store.createRun({ item_id: itemId, template: 'change' });
    store.transitionRun(r.id, 'pending', 'running');
    store.transitionRun(r.id, 'running', 'paused');
    return r;
  };
  const testRuns = () => { try { return readFileSync(testLog, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } };
  /** Commits `files` (null = delete) to the clone and pushes to origin/main. */
  const pushMain = (files: Record<string, string | null>) => {
    for (const [f, body] of Object.entries(files)) {
      if (body === null) rmSync(join(repos.root, f)); else { mkdirSync(join(repos.root, f, '..'), { recursive: true }); writeFileSync(join(repos.root, f), body); }
    }
    git(repos.root, ['add', '-A', '--', ...Object.keys(files)]); // not -A alone: dispatch leaves worktrees under .factory/
    git(repos.root, ['commit', '-m', 'change']);
    git(repos.root, ['push', 'origin', 'main']);
    return git(repos.root, ['rev-parse', 'HEAD']);
  };
  const mainEvents = () => store.listEvents().filter((e) => e.type.startsWith('main.'));
  return { repos, config, store, engine, calls, runIds, pausedRun, testRuns, pushMain, mainEvents, queue };
}

test('dispatches up to maxParallel, then more as runs finish', async (t) => {
  const { store, engine, calls } = setup(t);
  const ids = [1, 2, 3].map((n) => store.createItem({ title: `i${n}`, status: 'queued' }).id);
  await engine.start();
  assert.equal(calls.length, 2);
  assert.equal(store.getItem(ids[2]).status, 'queued');
  assert.deepEqual(store.listRuns({}).map((r) => [r.item_id, r.status]), [[ids[0], 'running'], [ids[1], 'running']]);
  calls[0].resolve();
  store.transitionRun(calls[0].ctx.runId, 'running', 'completed');
  await until(() => calls.length === 3);
  assert.equal(store.getItem(ids[2]).status, 'active');
});

test('concurrent ticks dispatch each item once', async (t) => {
  const { store, engine, calls } = setup(t, 5);
  store.createItem({ title: 'a', status: 'queued' });
  store.createItem({ title: 'b', status: 'queued' });
  await Promise.all([engine.tick(), engine.tick()]);
  assert.equal(calls.length, 2);
  assert.deepEqual(store.listRuns({}).map((r) => r.item_id).sort(), [1, 2]);
});

test('new attempt after a prior run', async (t) => {
  const { store, engine, repos } = setup(t);
  const item = store.createItem({ title: 'a', status: 'queued' });
  const old = store.createRun({ item_id: item.id, template: 'change', attempt: 1 });
  store.transitionRun(old.id, 'pending', 'cancelled');
  await engine.tick();
  const run = store.listRuns({ item_id: item.id }).at(-1)!;
  assert.equal(run.attempt, 2);
  assert.equal(run.worktree, join(repos.root, '.factory', 'worktrees', `${item.id}-2`));
  assert.equal(run.branch, `factory/${item.id}-2`);
  assert.ok(run.started_at);
});

test('undone deps and containers are not dispatched', async (t) => {
  const { store, engine, calls } = setup(t);
  const dep = store.createItem({ title: 'dep', status: 'ready' });
  store.createItem({ title: 'waits', status: 'queued', depends_on: [dep.id] });
  const parent = store.createItem({ title: 'container', status: 'queued' });
  store.createItem({ title: 'child', status: 'draft', parent_id: parent.id });
  await engine.tick();
  assert.equal(calls.length, 0);
});

test('container roll-up walks to the root', async (t) => {
  const { store, engine } = setup(t);
  const gp = store.createItem({ title: 'gp', status: 'active' });
  const p = store.createItem({ title: 'p', status: 'active', parent_id: gp.id });
  const c1 = store.createItem({ title: 'c1', status: 'active', parent_id: p.id });
  const c2 = store.createItem({ title: 'c2', status: 'active', parent_id: p.id });
  const q = store.createItem({ title: 'q', status: 'ready' });
  store.createItem({ title: 'd1', status: 'done', parent_id: q.id });
  const d2 = store.createItem({ title: 'd2', status: 'active', parent_id: q.id });
  await engine.start();
  store.transitionItem(c1.id, 'active', 'done');
  assert.equal(store.getItem(p.id).status, 'active');
  store.transitionItem(c2.id, 'active', 'cancelled');
  assert.equal(store.getItem(p.id).status, 'done');
  assert.equal(store.getItem(gp.id).status, 'done');
  store.transitionItem(d2.id, 'active', 'blocked');
  assert.equal(store.getItem(q.id).status, 'active');
});

test('gate.closed resumes a paused run once', async (t) => {
  const { store, engine, runIds, pausedRun } = setup(t);
  const item = store.createItem({ title: 'a', status: 'blocked' });
  const run = pausedRun(item.id);
  const g1 = store.openGate({ run_id: run.id, node: 'merge_gate', kind: 'merge', question: 'q?' });
  const g2 = store.openGate({ run_id: run.id, node: 'merge_gate', kind: 'merge', question: 'q2?' });
  await engine.start();
  assert.deepEqual(runIds(), []);
  store.decideGate(g1.id, 'approve');
  store.decideGate(g2.id, 'approve');
  assert.deepEqual(runIds(), [run.id]);
});

test('recovery fails interrupted nodes and relaunches before dispatch', async (t) => {
  const { store, engine, runIds, pausedRun } = setup(t);
  const a = store.createItem({ title: 'a', status: 'active' });
  const run = store.createRun({ item_id: a.id, template: 'change' });
  store.transitionRun(run.id, 'pending', 'running');
  const nr = store.createNodeRun({ run_id: run.id, node: 'build' });
  store.transitionNodeRun(nr.id, 'pending', 'running');
  const b = store.createItem({ title: 'b', status: 'blocked' });
  const open = pausedRun(b.id);
  store.openGate({ run_id: open.id, node: 'build', kind: 'failure', question: 'q?' });
  const c = store.createItem({ title: 'c', status: 'active' });
  const decided = pausedRun(c.id);
  store.decideGate(store.openGate({ run_id: decided.id, node: 'build', kind: 'failure', question: 'q?' }).id, 'approve');
  const queued = store.createItem({ title: 'd', status: 'queued' });
  await engine.start();
  const row = store.listNodeRuns(run.id)[0];
  assert.equal(row.status, 'failed');
  assert.equal(row.output, INTERRUPTED);
  assert.ok(row.ended_at);
  const fresh = store.listRuns({ item_id: queued.id })[0].id;
  assert.deepEqual(runIds(), [run.id, decided.id, fresh]);
});

test('validateReviewerMapping rejects an unmapped executor family', () => {
  const config = structuredClone(DEFAULT_CONFIG);
  validateReviewerMapping(config);
  config.roles.executor.light = 'acme/tiny';
  assert.throws(() => validateReviewerMapping(config), /roles\.reviewer has no entry for family "acme" \(executor acme\/tiny\)/);
});

test('stop() does not wait for runs and silences the engine', async (t) => {
  const { store, engine, calls, pausedRun } = setup(t);
  store.createItem({ title: 'a', status: 'queued' });
  const b = store.createItem({ title: 'b', status: 'blocked' });
  const run = pausedRun(b.id);
  const g = store.openGate({ run_id: run.id, node: 'build', kind: 'failure', question: 'q?' });
  await engine.start();
  assert.equal(calls.length, 1);
  await engine.stop();
  assert.equal(calls[0].ctx.stopped(), true);
  const late = store.createItem({ title: 'late', status: 'queued' });
  store.decideGate(g.id, 'approve');
  await engine.tick();
  await sleep(30);
  assert.equal(calls.length, 1);
  assert.equal(store.getItem(late.id).status, 'queued');
});

test('an unexpected node error frees the slot', async (t) => {
  const { store, engine, calls } = setup(t, 1, true);
  const [a, b] = ['a', 'b'].map((title) => store.createItem({ title, status: 'queued' }));
  await engine.start();
  await until(() => calls.length === 2); // b dispatched at maxParallel 1 once a's run failed
  assert.equal(store.getRun(1).status, 'failed');
  assert.equal(store.getItem(a.id).status, 'ready');
  assert.equal(store.getItem(b.id).status, 'active');
  assert.equal(store.getRetro(1)?.notes, 'node build errored: boom');
});

test('red main blocks dispatch and emits main.red once per SHA', async (t) => {
  const { store, engine, calls, testRuns, pushMain, mainEvents } = setup(t);
  const sha = pushMain({ BROKEN: 'x' });
  const item = store.createItem({ title: 'a', status: 'queued' });
  await engine.tick();
  await engine.tick();
  assert.equal(calls.length, 0);
  assert.equal(store.getItem(item.id).status, 'queued');
  assert.equal(testRuns(), 1);
  const [e, ...rest] = mainEvents();
  assert.equal(rest.length, 0);
  assert.equal(e.type, 'main.red');
  assert.equal(e.data.sha, sha);
  assert.equal(e.data.exit_code, 1);
  assert.match(String(e.data.output), /broken main/);
  assert.deepEqual({ sha: engine.mainHealth()?.sha, status: engine.mainHealth()?.status }, { sha, status: 'red' });
});

test('a fix on origin/main resumes dispatch and emits main.green', async (t) => {
  const { store, engine, calls, pushMain, mainEvents } = setup(t);
  pushMain({ BROKEN: 'x' });
  store.createItem({ title: 'a', status: 'queued' });
  await engine.tick();
  assert.equal(calls.length, 0);
  const fixed = pushMain({ BROKEN: null });
  await engine.tick();
  assert.equal(calls.length, 1);
  assert.deepEqual(mainEvents().map((e) => e.type), ['main.red', 'main.green']);
  assert.equal(engine.mainHealth()?.sha, fixed);
  assert.equal(engine.mainHealth()?.status, 'green');
});

test('a factory.db-only commit reuses the previous main result; a code commit re-tests', async (t) => {
  const { store, engine, testRuns, pushMain } = setup(t, 5);
  store.createItem({ title: 'a', status: 'queued' });
  await engine.tick();
  assert.equal(testRuns(), 1);
  store.createItem({ title: 'b', status: 'queued' });
  const dbSha = pushMain({ '.factory/factory.db': 'state' });
  await engine.tick();
  assert.equal(testRuns(), 1);
  assert.equal(engine.mainHealth()?.sha, dbSha);
  store.createItem({ title: 'c', status: 'queued' });
  pushMain({ '.factory/factory.db': 'state2', 'src.txt': 'code' });
  await engine.tick();
  assert.equal(testRuns(), 2);
});

test('health refreshes on a tick with nothing dispatchable', async (t) => {
  const { engine, pushMain, mainEvents } = setup(t);
  pushMain({ BROKEN: 'x' });
  await engine.tick();
  assert.equal(engine.mainHealth()?.status, 'red');
  const fixed = pushMain({ BROKEN: null });
  await engine.tick();
  assert.deepEqual({ sha: engine.mainHealth()?.sha, status: engine.mainHealth()?.status }, { sha: fixed, status: 'green' });
  assert.deepEqual(mainEvents().map((e) => e.type), ['main.red', 'main.green']);
});

test('the worktree is created from the checked SHA', async (t) => {
  const { store, engine, calls, pushMain } = setup(t);
  const sha = pushMain({ ok: 'x' });
  store.createItem({ title: 'a', status: 'queued' });
  await engine.tick();
  assert.equal(engine.mainHealth()?.sha, sha);
  assert.equal(git(calls[0].ctx.paths.root, ['rev-parse', 'factory/1-1']), sha);
});

test('stop() kills a running main check', async (t) => {
  const { store, engine, config } = setup(t);
  config.defaultTestCmd = 'sleep 30';
  store.createItem({ title: 'a', status: 'queued' });
  void engine.tick();
  await sleep(300);
  const started = Date.now();
  await engine.stop();
  assert.ok(Date.now() - started < 5000);
  assert.equal(engine.mainHealth(), undefined);
});

test('a factory.db-only commit on red main emits main.red for the new SHA without re-running the command', async (t) => {
  const { store, engine, testRuns, pushMain, mainEvents } = setup(t);
  const red = pushMain({ BROKEN: 'x' });
  store.createItem({ title: 'a', status: 'queued' });
  await engine.tick();
  const dbSha = pushMain({ '.factory/factory.db': 'state' });
  await engine.tick();
  await engine.tick();
  assert.equal(testRuns(), 1);
  assert.deepEqual(mainEvents().map((e) => [e.type, e.data.sha, e.data.exit_code]), [['main.red', red, 1], ['main.red', dbSha, 1]]);
  assert.match(String(mainEvents()[1].data.output), /broken main/);
  assert.equal(engine.mainHealth()?.sha, dbSha);
});

test('origin is fetched at most once per poll interval', async (t) => {
  const { store, engine, calls, pushMain } = setup(t, 5, false, 60_000);
  const first = pushMain({ ok: '1' });
  store.createItem({ title: 'a', status: 'queued' });
  await engine.tick();
  pushMain({ BROKEN: 'x' });
  store.createItem({ title: 'b', status: 'queued' });
  await engine.tick();
  assert.equal(engine.mainHealth()?.sha, first);
  assert.equal(calls.length, 2); // dispatched on the cached green result
});

test('a green main is not fetched while nothing is dispatchable', async (t) => {
  const { store, engine, pushMain } = setup(t);
  const first = pushMain({ ok: '1' });
  await engine.tick();
  pushMain({ ok: '2' });
  await engine.tick();
  assert.equal(engine.mainHealth()?.sha, first);
  store.createItem({ title: 'a', status: 'queued' });
  await engine.tick();
  assert.notEqual(engine.mainHealth()?.sha, first);
});

test('red main keeps polling at the poll interval so main.green fires', async (t) => {
  let now = 0;
  const { engine, pushMain, mainEvents } = setup(t, 2, false, 60_000, () => now);
  pushMain({ BROKEN: 'x' });
  await engine.tick();
  pushMain({ BROKEN: null });
  await engine.tick();
  assert.equal(engine.mainHealth()?.status, 'red'); // within the interval: no fetch
  now = 60_000;
  await engine.tick();
  assert.deepEqual(mainEvents().map((e) => e.type), ['main.red', 'main.green']);
});

test('a failed fetch with no cached result is not retried within the poll interval', async (t) => {
  let now = 0;
  const { repos, store, engine } = setup(t, 2, false, 60_000, () => now);
  store.createItem({ title: 'a', status: 'queued' });
  const good = git(repos.root, ['remote', 'get-url', 'origin']);
  git(repos.root, ['remote', 'set-url', 'origin', join(repos.dir, 'missing.git')]);
  await engine.tick();
  git(repos.root, ['remote', 'set-url', 'origin', good]);
  now = 59_999;
  await engine.tick();
  assert.equal(engine.mainHealth(), undefined);
  now = 60_000;
  await engine.tick();
  assert.equal(engine.mainHealth()?.status, 'green');
});

test('the poll interval counts from the fetch, not from the request that waited in the forge queue', async (t) => {
  let now = 0;
  const { store, engine, queue, pushMain } = setup(t, 2, false, 60_000, () => now);
  const first = pushMain({ ok: '1' });
  store.createItem({ title: 'a', status: 'queued' });
  const gate = Promise.withResolvers<void>();
  const held = queue.run(() => gate.promise);
  const ticking = engine.tick();
  now = 100_000;
  gate.resolve();
  await held;
  await ticking;
  pushMain({ ok: '2' });
  now = 130_000;
  await engine.tick();
  assert.equal(engine.mainHealth()?.sha, first); // 30 s after the fetch: no new fetch
  now = 160_000;
  store.createItem({ title: 'b', status: 'queued' });
  await engine.tick();
  assert.notEqual(engine.mainHealth()?.sha, first);
});
