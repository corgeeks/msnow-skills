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
  assert.equal((db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode, 'wal');
  assert.equal((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys, 1);
  db.close();
});

test('v2 migration keeps gates and allows decision override', () => {
  const path = join(tmp(), 'f.db');
  const old = new DatabaseSync(path);
  old.exec(MIGRATIONS[0]);
  old.exec(`INSERT INTO meta VALUES ('schema_version', '1');
    INSERT INTO work_items (id, title) VALUES (1, 't');
    INSERT INTO runs (id, item_id, template, attempt) VALUES (1, 1, 'change', 1);
    INSERT INTO gates (id, run_id, node, kind, question, decision, closed_at) VALUES (5, 1, 'test', 'failure', 'q', 'approve', 'x'), (6, 1, 'merge_gate', 'merge', 'q', NULL, NULL)`);
  old.close();
  const db = openDb(path);
  assert.deepEqual(db.prepare('SELECT id, decision FROM gates ORDER BY id').all().map((r) => ({ ...r })), [{ id: 5, decision: 'approve' }, { id: 6, decision: null }]);
  db.prepare(`UPDATE gates SET decision = 'override' WHERE id = 6`).run();
  assert.throws(() => db.prepare(`UPDATE gates SET decision = 'bogus' WHERE id = 6`).run());
  assert.equal(count(db, 'sqlite_master WHERE name = \'gates_open\''), 1);
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
