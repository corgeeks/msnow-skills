import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from './db.ts';
import { createBus } from './bus.ts';
import { ConflictError, CycleError, createStore } from './store.ts';
import type { FactoryEvent } from '../shared/types.ts';

function setup() {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'factory-store-')), 'f.db'));
  const bus = createBus();
  const seen: FactoryEvent[] = [];
  bus.subscribe((e) => seen.push(e));
  return { db, bus, seen, store: createStore(db, bus) };
}

test('transitionItem is CAS; loser throws ConflictError and emits nothing', () => {
  const { store, seen } = setup();
  const a = store.createItem({ title: 'a', status: 'ready' });
  store.transitionItem(a.id, 'ready', 'active');
  assert.throws(() => store.transitionItem(a.id, 'ready', 'active'), ConflictError);
  assert.equal(store.getItem(a.id).status, 'active');
  assert.equal(store.listEvents().filter((e) => e.type === 'item.updated').length, 1);
  assert.equal(seen.filter((e) => e.type === 'item.updated').length, 1);
});

test('addDep rejects cycles and self-deps', () => {
  const { store } = setup();
  const [a, b, c] = ['a', 'b', 'c'].map((title) => store.createItem({ title }).id);
  store.addDep(a, b);
  store.addDep(b, c);
  assert.throws(() => store.addDep(c, a), CycleError);
  assert.throws(() => store.addDep(a, a), CycleError);
  assert.deepEqual(store.getDeps(a).map((i) => i.id), [b]);
  assert.deepEqual(store.getDependents(c).map((i) => i.id), [b]);
});

test('dispatchableItems: queued, deps done, priority order', () => {
  const { store } = setup();
  const dep = store.createItem({ title: 'dep', status: 'queued' });
  const blocked = store.createItem({ title: 'blocked', status: 'queued', priority: 9, depends_on: [dep.id] });
  const lo = store.createItem({ title: 'lo', status: 'queued', priority: 1 });
  store.createItem({ title: 'ready', status: 'ready', priority: 99 });
  const ids = () => store.dispatchableItems().map((i) => i.id);
  assert.deepEqual(ids(), [lo.id, dep.id]);
  assert.equal(store.listItems({ status: 'queued' }).find((i) => i.id === blocked.id)!.open_deps, 1);
  store.transitionItem(dep.id, 'queued', 'done');
  assert.deepEqual(ids(), [blocked.id, lo.id]);
  assert.equal(store.getItemDetail(blocked.id).deps[0].id, dep.id);
});

test('createItemsBatch resolves refs, is idempotent, and rolls back on cycle', () => {
  const { store, seen } = setup();
  const batch = [
    { ref: 'kid', title: 'kid', parent_ref: 'epic', depends_on_refs: ['dep'], source_ref: 's:kid' },
    { ref: 'epic', title: 'epic', type: 'epic', source_ref: 's:epic' },
    { ref: 'dep', title: 'dep', source_ref: 's:dep' },
  ];
  const r1 = store.createItemsBatch(batch);
  assert.deepEqual(r1.created, ['kid', 'epic', 'dep']);
  assert.equal(store.getItem(r1.ids.kid).parent_id, r1.ids.epic);
  assert.deepEqual(store.getDeps(r1.ids.kid).map((i) => i.id), [r1.ids.dep]);
  assert.deepEqual(store.getChildren(r1.ids.epic).map((i) => i.id), [r1.ids.kid]);

  const r2 = store.createItemsBatch(batch);
  assert.deepEqual(r2, { ids: r1.ids, created: [], skipped: ['kid', 'epic', 'dep'] });

  const before = store.listItems().length;
  const n = seen.length;
  assert.throws(() => store.createItemsBatch([
    { ref: 'x', title: 'x', depends_on_refs: ['y'] },
    { ref: 'y', title: 'y', depends_on_refs: ['x'] },
  ]), CycleError);
  assert.equal(store.listItems().length, before);
  assert.equal(seen.length, n);
});

test('bus receives events in seq order, nothing on rollback', () => {
  const { store, seen } = setup();
  const a = store.createItem({ title: 'a' });
  store.updateItem(a.id, { title: 'a2' });
  const run = store.createRun({ item_id: a.id, template: 't' });
  const nr = store.createNodeRun({ run_id: run.id, node: 'build' });
  store.transitionNodeRun(nr.id, 'pending', 'running');
  store.recordRetro({ run_id: run.id, failures: ['f'], findings: [], rework_count: 0, cost_usd: 0, duration_s: 1, notes: '' });
  const n = seen.length;
  assert.throws(() => store.transitionRun(run.id, 'running', 'completed'), ConflictError);
  assert.equal(seen.length, n);
  assert.deepEqual(seen.map((e) => e.seq), store.listEvents().map((e) => e.seq));
  assert.deepEqual(seen.map((e) => e.seq), [...seen.map((e) => e.seq)].sort((x, y) => x - y));
  assert.deepEqual(store.listEvents().at(-1)!.data.failures, ['f']);
  assert.deepEqual(store.getRetro(run.id)!.failures, ['f']);
  assert.equal(seen[1].data.title, 'a2');
});

test('decideGate twice throws ConflictError', () => {
  const { store } = setup();
  const run = store.createRun({ item_id: store.createItem({ title: 'a' }).id, template: 't' });
  const g = store.openGate({ run_id: run.id, node: 'merge', kind: 'merge', question: 'ok?' });
  assert.equal(store.listGates({ open: true }).length, 1);
  assert.equal(store.decideGate(g.id, 'approve', 'lgtm').decision, 'approve');
  assert.throws(() => store.decideGate(g.id, 'reject'), ConflictError);
  assert.equal(store.listGates({ open: true }).length, 0);
  assert.equal(store.listGates().length, 1);
});

test('listGates carries the run PR', () => {
  const { store } = setup();
  const run = store.createRun({ item_id: store.createItem({ title: 'a' }).id, template: 't' });
  store.openGate({ run_id: run.id, node: 'merge', kind: 'merge', question: 'ok?' });
  assert.equal(store.listGates()[0].pr_url, null);
  store.updateRun(run.id, { pr_number: 7, pr_url: 'https://example.test/pull/7' });
  assert.deepEqual(store.listGates().map((g) => [g.pr_number, g.pr_url]), [[7, 'https://example.test/pull/7']]);
});

test('listRunGates is uncapped while listGates caps at 100', () => {
  const { store } = setup();
  const run = store.createRun({ item_id: store.createItem({ title: 'a' }).id, template: 't' });
  for (let i = 0; i < 101; i++) store.decideGate(store.openGate({ run_id: run.id, node: 'merge', kind: 'merge', question: 'ok?' }).id, 'approve', `n${i}`);
  assert.equal(store.listGates({ run_id: run.id }).length, 100);
  const all = store.listRunGates(run.id);
  assert.equal(all.length, 101);
  assert.equal(all[0].note, 'n0');
});
