import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, mkdirSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { AddressInfo } from 'node:net';
import { acquireInstanceLock, onShutdown, runShutdown } from './lifecycle.ts';
import { openDb } from './db.ts';
import { createBus } from './bus.ts';
import { createStore } from './store.ts';

const MAIN = join(import.meta.dirname, 'main.ts');

test('second instance on same port rejects', async () => {
  const a = createServer();
  await acquireInstanceLock(a, 0);
  const port = (a.address() as AddressInfo).port;
  await assert.rejects(acquireInstanceLock(createServer(), port), { message: `daemon already running on 127.0.0.1:${port}` });
  a.close();
});

test('hooks run in reverse; hung hook is cut at graceMs', async () => {
  const order: number[] = [];
  onShutdown(() => { order.push(1); });
  onShutdown(() => new Promise(() => {})); // never resolves
  onShutdown(() => { order.push(3); });
  const server = createServer();
  await acquireInstanceLock(server, 0);
  const db = openDb(':memory:');
  const t0 = Date.now();
  await runShutdown({ server, db, graceMs: 100 });
  assert.deepEqual(order, [3]); // hook 1 is behind the hung one
  assert.ok(Date.now() - t0 < 2000);
  assert.ok(!db.isOpen);
  assert.ok(!server.listening);
});

function tmpRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'factory-'));
  execFileSync('git', ['init', '-q', root]);
  return root;
}

async function startDaemon(root: string) {
  const child = spawn(process.execPath, [MAIN, '--root', root, '--port', '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
  const [line] = (await once(createInterface({ input: child.stdout! }), 'line')) as [string];
  const m = line.match(/^factory daemon listening on (http:\/\/127\.0\.0\.1:\d+) \(root (.+)\)$/);
  assert.ok(m, line);
  return { child, base: m[1] };
}

test('smoke: daemon starts, serves health, exits 0 on SIGTERM', async () => {
  const root = tmpRepo();
  const { child, base } = await startDaemon(root);
  const health = await (await fetch(`${base}/api/health`)).json();
  assert.equal(health.ok, true);
  child.kill('SIGTERM');
  const [code] = await once(child, 'exit');
  assert.equal(code, 0);
  assert.ok(existsSync(join(root, '.factory/live/factory.db')));
});

test('seeds live DB from committed DB', async () => {
  const root = tmpRepo();
  mkdirSync(join(root, '.factory'));
  const db = openDb(join(root, '.factory/factory.db'));
  createStore(db, createBus()).createItem({ title: 'seeded' });
  db.close();
  const { child, base } = await startDaemon(root);
  try {
    const items = await (await fetch(`${base}/api/items`)).json();
    assert.deepEqual(items.map((i: { title: string }) => i.title), ['seeded']);
  } finally {
    child.kill('SIGTERM');
    await once(child, 'exit');
  }
});
