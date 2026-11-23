import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { openDb } from './db.ts';
import { createBus } from './bus.ts';
import { createStore } from './store.ts';
import { runSession } from './omp.ts';
import * as worktrees from './worktrees.ts';
import { DEFAULT_CONFIG } from '../shared/config.ts';
import { createEngine, validateReviewerMapping } from './engine.ts';
import { INTERRUPTED, type ChangeContext } from './template-change.ts';
import { makeRepos } from '../../test/fixtures/git-repos.ts';
import type { Forge } from './forge.ts';

async function until(cond: () => boolean, ms = 3000) {
  for (const end = Date.now() + ms; !cond(); await sleep(10)) if (Date.now() > end) throw new Error('timed out');
}

function setup(t: TestContext, maxParallel = 2) {
  const repos = makeRepos();
  const db = openDb(join(repos.dir, 'f.db'));
  const bus = createBus();
  const store = createStore(db, bus);
  const config = structuredClone(DEFAULT_CONFIG);
  config.loop.maxParallel = maxParallel;
  const calls: { ctx: ChangeContext; resolve: () => void }[] = [];
  const runChange = (ctx: ChangeContext) => {
    const { promise, resolve } = Promise.withResolvers<void>();
    calls.push({ ctx, resolve });
    return promise;
  };
  const forge = { fetch: async () => {} } as unknown as Forge;
  const engine = createEngine({
    store, bus, config, paths: { root: repos.root, sessionsDir: join(repos.dir, 'sessions') }, runSession,
    worktrees, forge, committer: { flush: async () => {} }, runChange, tickMs: 60_000,
  });
  t.after(async () => { await engine.stop(); db.close(); rmSync(repos.dir, { recursive: true, force: true }); });
  const runIds = () => calls.map((c) => c.ctx.runId);
  const pausedRun = (itemId: number) => {
    const r = store.createRun({ item_id: itemId, template: 'change' });
    store.transitionRun(r.id, 'pending', 'running');
    store.transitionRun(r.id, 'running', 'paused');
    return r;
  };
  return { repos, store, engine, calls, runIds, pausedRun };
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
