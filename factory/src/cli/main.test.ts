import { spawn } from 'node:child_process';
import { test, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createBus } from '../daemon/bus.ts';
import { openDb } from '../daemon/db.ts';
import { createApiServer } from '../daemon/http.ts';
import { createStore, type Store } from '../daemon/store.ts';
import { main } from './main.ts';

let server: http.Server;
let store: Store;
let port: string;
const umbrella = path.join(import.meta.dirname, '../../test/fixtures/prd/umbrella');

before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-cli-'));
  const bus = createBus();
  store = createStore(openDb(path.join(dir, 'f.db')), bus);
  server = createApiServer({ store, bus, uiDir: path.join(dir, 'ui') });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = String((server.address() as AddressInfo).port);
});
after(() => server.close());

let stdout = '', stderr = '';
beforeEach(() => { stdout = ''; stderr = ''; });
// capture only while main runs; the test runner's own (Buffer) reports pass through
async function cli(args: string[]): Promise<number> {
  stdout = ''; stderr = '';
  const capture = (stream: NodeJS.WriteStream, sink: (s: string) => void) => {
    const orig = stream.write.bind(stream);
    return mock.method(stream, 'write', (s: unknown, ...a: never[]) => (typeof s === 'string' ? (sink(s), true) : orig(s as Uint8Array, ...a)));
  };
  const o = capture(process.stdout, (s) => (stdout += s));
  const e = capture(process.stderr, (s) => (stderr += s));
  try { return await main(args); } finally { o.mock.restore(); e.mock.restore(); }
}
const run = (...args: string[]) => cli([...args, '--port', port]);
const add = async (...args: string[]) => {
  stdout = '';
  assert.equal(await run('add', ...args), 0, stderr);
  return Number(stdout.trim());
};

test('add creates draft, --ready, --depends-on', async () => {
  const a = await add('--title', 'A');
  assert.equal(store.getItem(a).status, 'draft');
  const b = await add('--title', 'B', '--ready', '--depends-on', String(a), '--tier', 'light');
  assert.equal(store.getItem(b).status, 'ready');
  assert.deepEqual(store.getDeps(b).map((d) => d.id), [a]);
});

test('import dry-run, real, repeat', async () => {
  const before = store.listItems().length;
  assert.equal(await run('import', umbrella, '--dry-run'), 0, stderr);
  const lines = stdout.trim().split('\n');
  assert.ok(lines.length > 1 && lines.some((l) => l.startsWith('  ')));
  assert.equal(store.listItems().length, before);
  stdout = '';
  assert.equal(await run('import', umbrella), 0, stderr);
  assert.equal(store.listItems().length - before, lines.length);
  stdout = '';
  assert.equal(await run('import', umbrella), 0);
  assert.equal(stdout.trim(), `created 0, skipped ${lines.length}`);
  assert.equal(await run('import', '/nonexistent/prd'), 1);
});

test('start leaf, container, --all, draft conflict', async () => {
  const leaf = await add('--title', 'L', '--ready');
  assert.equal(await run('start', String(leaf)), 0);
  assert.equal(store.getItem(leaf).status, 'queued');

  const box = await add('--title', 'Box', '--type', 'group', '--ready');
  const sub = await add('--title', 'Sub', '--type', 'group', '--parent', String(box), '--ready');
  const r1 = await add('--title', 'r1', '--parent', String(sub), '--ready');
  const d1 = await add('--title', 'd1', '--parent', String(box));
  stdout = '';
  assert.equal(await run('start', String(box)), 0);
  assert.equal(stdout.trim(), 'queued 1');
  assert.equal(store.getItem(r1).status, 'queued');
  assert.equal(store.getItem(d1).status, 'draft');
  assert.equal(store.getItem(box).status, 'ready');

  stderr = '';
  assert.equal(await run('start', String(d1)), 1);
  assert.equal(stderr.trim(), `conflict: item ${d1} is draft`);

  const r2 = await add('--title', 'r2', '--parent', String(box), '--ready');
  assert.equal(await run('start', '--all'), 0);
  assert.equal(store.getItem(r2).status, 'queued');
  assert.equal(store.listItems({ status: 'ready' }).filter((i) => store.listItems({ parent_id: i.id }).length === 0).length, 0);
  assert.equal(store.getItem(box).status, 'ready');
  assert.equal(store.getItem(sub).status, 'ready');
});

test('approve/reject gates; second decision conflicts', async () => {
  const item = await add('--title', 'G');
  const r = store.createRun({ item_id: item, template: 't' });
  const g1 = store.openGate({ run_id: r.id, node: 'n', kind: 'plan', question: 'ok?' });
  const g2 = store.openGate({ run_id: r.id, node: 'n', kind: 'plan', question: 'ok?' });
  assert.equal(await run('approve', String(g1.id), '--note', 'fine'), 0);
  assert.equal(stdout.trim(), `gate ${g1.id} approved`);
  assert.equal(await run('reject', String(g2.id)), 0);
  assert.ok(store.listGates({ run_id: r.id }).every((g) => g.closed_at));
  assert.equal(await run('approve', String(g1.id)), 1);
  assert.match(stderr, /^conflict:/);
});

test('status --json and show --json keys; show 999', async () => {
  assert.equal(await run('status', '--json'), 0, stderr);
  assert.deepEqual(Object.keys(JSON.parse(stdout)).sort(), ['active', 'counts', 'gates', 'waiting']);
  stdout = '';
  assert.equal(await run('show', '1', '--json'), 0, stderr);
  assert.deepEqual(Object.keys(JSON.parse(stdout)).sort(), ['children', 'dependents', 'deps', 'item', 'runs']);
  assert.equal(await run('status'), 0);
  assert.equal(await run('show', '1'), 0);
  assert.equal(await run('show', '999'), 1);
  assert.match(stderr, /^not_found:/);
});

test('unreachable daemon exits 2', async () => {
  const s = http.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const free = String((s.address() as AddressInfo).port);
  await new Promise((r) => s.close(r));
  assert.equal(await cli(['status', '--port', free]), 2);
  assert.equal(stderr, 'factory daemon is not running — start it with: factory daemon\n');
});

test('usage errors exit 64; --help exits 0', async () => {
  for (const args of [['bogus'], ['start'], ['add'], ['add', '--title', 'x', '--tier', 'huge'], ['show', 'abc'], ['status', '--nope'], ['start', '1', '--all']]) {
    assert.equal(await run(...args), 64, args.join(' '));
  }
  assert.equal(await cli([]), 64);
  assert.equal(await cli(['--help']), 0);
  assert.match(stdout, /node factory\/src\/cli\/main\.ts/);
});

test('stdout closed early exits 0 without an unhandled error', async () => {
  const child = spawn(process.execPath, [path.join(import.meta.dirname, 'main.ts'), 'import', umbrella, '--dry-run'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d: Buffer) => (stderr += d));
  child.stdout.destroy();
  const { promise, resolve } = Promise.withResolvers<number | null>();
  child.once('close', (code) => resolve(code));
  const code = await promise;
  assert.equal(code, 0, stderr);
  assert.equal(stderr, '');
});
