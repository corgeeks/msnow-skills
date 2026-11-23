import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { openDb } from './db.ts';
import { createBus } from './bus.ts';
import { createStore } from './store.ts';
import { createApiServer } from './http.ts';

async function setup(t: { after: (fn: () => unknown) => void }, withIndex = true) {
  const dir = mkdtempSync(join(tmpdir(), 'factory-http-'));
  const uiDir = join(dir, 'ui');
  mkdirSync(uiDir);
  if (withIndex) writeFileSync(join(uiDir, 'index.html'), '<p>INDEX</p>');
  const bus = createBus();
  const store = createStore(openDb(join(dir, 'f.db')), bus);
  const server = createApiServer({ store, bus, uiDir, root: dir });
  assert.equal(server.listening, false);
  server.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: await res.json() as any };
  };
  return { store, bus, base, call };
}

/** Reads SSE frames until `n` id'd frames arrived. */
async function sse(url: string, n: number, headers: Record<string, string> = {}, onOpen?: () => unknown) {
  const ac = new AbortController();
  const res = await fetch(url, { headers, signal: ac.signal });
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  await onOpen?.();
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let text = '';
  const frames = () => text.split('\n\n').filter((f) => f.includes('id: '));
  while (frames().length < n) text += (await reader.read()).value;
  ac.abort();
  return { text, ids: frames().map((f) => Number(/id: (\d+)/.exec(f)![1])) };
}

test('health, items CRUD, PATCH CAS, validation, unknown route', async (t) => {
  const { call } = await setup(t);
  const h = await call('GET', '/api/health');
  assert.equal(h.json.ok, true);
  assert.equal(h.json.pid, process.pid);
  assert.ok(h.json.schemaVersion >= 1);

  const a = await call('POST', '/api/items', { title: 'a', status: 'ready', tier: 'light' });
  assert.equal(a.status, 200);
  const b = await call('POST', '/api/items', { title: 'b', depends_on: [a.json.id] });
  const list = await call('GET', '/api/items');
  assert.deepEqual(list.json.map((i: any) => i.open_deps), [0, 1]);
  assert.equal((await call('GET', '/api/items?status=ready')).json.length, 1);
  const detail = await call('GET', `/api/items/${b.json.id}`);
  assert.equal(detail.json.deps[0].id, a.json.id);

  const p = await call('PATCH', `/api/items/${a.json.id}`, { title: 'A', status: 'active', from: 'ready' });
  assert.equal(p.json.title, 'A');
  assert.equal(p.json.status, 'active');
  const c = await call('PATCH', `/api/items/${a.json.id}`, { status: 'done', from: 'ready' });
  assert.deepEqual([c.status, c.json.error.code], [409, 'conflict']);

  assert.equal((await call('PATCH', `/api/items/${a.json.id}`, { status: 'done' })).status, 400);
  assert.equal((await call('POST', '/api/items', { title: 'x', tier: 'huge' })).json.error.code, 'bad_request');
  assert.equal((await call('GET', '/api/items?status=nope')).status, 400);
  assert.equal((await call('GET', '/api/items/999')).json.error.code, 'not_found');
  assert.equal((await call('GET', '/api/nope')).status, 404);
  const big = await call('POST', '/api/items', { title: 'x', body: 'y'.repeat(1 << 20) });
  assert.equal(big.status, 413);
});

test('batch is idempotent; cycle → 409 cycle; unknown dep → 404', async (t) => {
  const { call } = await setup(t);
  const items = [{ ref: 'p', title: 'p', source_ref: 's:p' }, { ref: 'c', title: 'c', parent_ref: 'p', depends_on_refs: ['p'], source_ref: 's:c' }];
  const r1 = await call('POST', '/api/items/batch', { items });
  assert.deepEqual(r1.json.created.sort(), ['c', 'p']);
  const r2 = await call('POST', '/api/items/batch', { items });
  assert.deepEqual(r2.json.ids, r1.json.ids);
  assert.deepEqual(r2.json.skipped.sort(), ['c', 'p']);
  assert.deepEqual(r2.json.created, []);

  const cyc = await call('POST', `/api/items/${r1.json.ids.p}/deps`, { depends_on: r1.json.ids.c });
  assert.deepEqual([cyc.status, cyc.json.error.code], [409, 'cycle']);
  assert.equal((await call('POST', `/api/items/${r1.json.ids.p}/deps`, { depends_on: 999 })).status, 404);
});

test('DELETE dep removes the edge; missing edge → 404', async (t) => {
  const { call } = await setup(t);
  const a = await call('POST', '/api/items', { title: 'a' });
  const b = await call('POST', '/api/items', { title: 'b', depends_on: [a.json.id] });
  const url = `/api/items/${b.json.id}/deps/${a.json.id}`;
  const d = await call('DELETE', url);
  assert.deepEqual([d.status, d.json], [200, { ok: true }]);
  assert.deepEqual((await call('GET', `/api/items/${b.json.id}`)).json.deps, []);
  const again = await call('DELETE', url);
  assert.deepEqual([again.status, again.json.error.code], [404, 'not_found']);
});

test('runs and gates; deciding twice → 409', async (t) => {
  const { call, store } = await setup(t);
  const item = store.createItem({ title: 'g' });
  const run = store.createRun({ item_id: item.id, template: 't' });
  const gate = store.openGate({ run_id: run.id, node: 'n', kind: 'k', question: 'q?' });
  assert.equal((await call('GET', `/api/runs?item=${item.id}`)).json.length, 1);
  const rd = await call('GET', `/api/runs/${run.id}`);
  assert.equal(rd.json.gates[0].id, gate.id);
  assert.deepEqual(rd.json.node_runs, []);
  assert.equal((await call('GET', '/api/gates?open=1')).json.length, 1);
  assert.equal((await call('POST', `/api/gates/${gate.id}/decision`, { decision: 'approve' })).json.decision, 'approve');
  const again = await call('POST', `/api/gates/${gate.id}/decision`, { decision: 'reject' });
  assert.deepEqual([again.status, again.json.error.code], [409, 'conflict']);
  assert.equal((await call('GET', '/api/gates?open=1')).json.length, 0);
  assert.ok((await call('GET', '/api/events?after=0&limit=2')).json.length === 2);
});

test('override is a 400 on a cost gate', async (t) => {
  const { call, store } = await setup(t);
  const item = store.createItem({ title: 'g' });
  const run = store.createRun({ item_id: item.id, template: 't' });
  const gate = store.openGate({ run_id: run.id, node: 'build', kind: 'failure', question: `Item #${item.id} has spent $2 (cap $2). Continue?` });
  const res = await call('POST', `/api/gates/${gate.id}/decision`, { decision: 'override' });
  assert.deepEqual([res.status, res.json.error.code], [400, 'bad_request']);
  assert.equal((await call('GET', '/api/gates?open=1')).json.length, 1);
});

test('SSE: live frames, activity without id, replay from Last-Event-ID', async (t) => {
  const { call, base, bus } = await setup(t);
  const live = await sse(`${base}/events`, 1, {}, async () => {
    bus.publishActivity({ run_id: 1, node: 'n', text: 'hi', at: 'now' });
    await call('POST', '/api/items', { title: 'one' });
  });
  assert.match(live.text, /^retry: 3000/);
  assert.match(live.text, /event: activity\ndata: \{"run_id":1/);
  assert.match(live.text, /id: 1\nevent: item.created\ndata: /);

  for (const title of ['two', 'three']) await call('POST', '/api/items', { title });
  const replay = await sse(`${base}/events`, 3, { 'Last-Event-ID': '1' }, () => call('POST', '/api/items', { title: 'four' }));
  assert.deepEqual(replay.ids, [2, 3, 4]);
});

test('static: SPA fallback, missing asset 404, traversal guard, not-built note', async (t) => {
  const { base } = await setup(t);
  const spa = await fetch(`${base}/runs/5`);
  assert.equal(await spa.text(), '<p>INDEX</p>');
  assert.equal(spa.headers.get('cache-control'), 'no-cache');
  assert.equal((await fetch(`${base}/assets/missing.js`)).status, 404);
  for (const p of ['/../etc/passwd', '/%2e%2e/%2e%2e/etc/passwd', '/..%2f..%2fetc%2fpasswd']) {
    const r = await fetch(base + p);
    const body = await r.text();
    assert.ok(!body.includes('root:'), p);
    if (r.status === 200) assert.equal(body, '<p>INDEX</p>');
  }
  const bare = await setup(t, false);
  assert.match(await (await fetch(`${bare.base}/`)).text(), /UI not built/);
});
