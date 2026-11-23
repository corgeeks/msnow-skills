import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS, openDb, schemaVersion, snapshot, tx } from './db.ts';

const tmp = () => mkdtempSync(join(tmpdir(), "factory-db-'q"));
const count = (db: DatabaseSync, t: string) => (db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n;

test('migrations apply once; reopen is a no-op', () => {
  const path = join(tmp(), 'nested', 'f.db');
  openDb(path).close();
  const db = openDb(path);
  assert.equal(schemaVersion(db), MIGRATIONS.length);
  assert.equal(schemaVersion(db), 1);
  assert.equal((db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode, 'wal');
  assert.equal((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys, 1);
  db.close();
});

test('tx commits, rolls back, and nests via savepoint', () => {
  const db = openDb(join(tmp(), 'f.db'));
  const ins = (t: string) => db.prepare(`INSERT INTO work_items (title) VALUES (?)`).run(t);
  tx(db, () => { ins('a'); });
  assert.throws(() => tx(db, () => { ins('b'); throw new Error('x'); }), /x/);
  tx(db, () => {
    ins('c');
    assert.throws(() => tx(db, () => { ins('d'); throw new Error('inner'); }));
  });
  assert.deepEqual(db.prepare('SELECT title FROM work_items ORDER BY id').all().map((r) => r.title), ['a', 'c']);
  assert.equal(db.isTransaction, false);
});

test('snapshot produces a standalone copy and overwrites', () => {
  const dir = tmp();
  const db = openDb(join(dir, 'live.db'));
  const dest = join(dir, 'snap.db');
  db.prepare(`INSERT INTO work_items (title) VALUES ('a')`).run();
  snapshot(db, dest);
  db.prepare(`INSERT INTO work_items (title) VALUES ('b')`).run();
  snapshot(db, dest);
  const ro = new DatabaseSync(dest, { readOnly: true });
  assert.equal(count(ro, 'work_items'), 2);
  assert.equal(count(ro, 'events'), count(db, 'events'));
  assert.equal((ro.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode, 'delete');
  ro.close();
  for (const s of ['-wal', '-shm', '.tmp']) assert.equal(existsSync(dest + s), false, s);
});
