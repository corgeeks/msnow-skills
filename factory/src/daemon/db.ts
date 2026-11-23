import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';

export const MIGRATIONS: string[] = [
  `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE work_items (
  id          INTEGER PRIMARY KEY,
  parent_id   INTEGER REFERENCES work_items(id),
  type        TEXT NOT NULL DEFAULT 'task',
  title       TEXT NOT NULL,
  body        TEXT NOT NULL DEFAULT '',
  spec_path   TEXT,
  tier        TEXT CHECK (tier IN ('heavy','standard','light')),
  test_cmd    TEXT,
  priority    INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'draft'
              CHECK (status IN ('draft','ready','queued','active','blocked','done','cancelled')),
  source_ref  TEXT UNIQUE,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE item_deps (
  item_id       INTEGER NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  depends_on_id INTEGER NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  PRIMARY KEY (item_id, depends_on_id),
  CHECK (item_id <> depends_on_id)
);
CREATE TABLE runs (
  id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES work_items(id),
  template TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
         CHECK (status IN ('pending','running','paused','completed','failed','cancelled')),
  branch TEXT, worktree TEXT, pr_number INTEGER, pr_url TEXT, head_sha TEXT,
  cost_usd REAL NOT NULL DEFAULT 0, started_at TEXT, ended_at TEXT,
  UNIQUE (item_id, attempt)
);
CREATE TABLE node_runs (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  node TEXT NOT NULL,
  iteration INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending'
         CHECK (status IN ('pending','running','completed','failed','skipped')),
  model TEXT, session_file TEXT, cost_usd REAL NOT NULL DEFAULT 0, output TEXT,
  started_at TEXT, ended_at TEXT,
  UNIQUE (run_id, node, iteration)
);
CREATE TABLE gates (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  node TEXT NOT NULL,
  kind TEXT NOT NULL,                 -- v0: 'merge' | 'failure'; free text so sf12 needs no migration
  question TEXT NOT NULL, recommendation TEXT,
  opened_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  closed_at TEXT, decision TEXT CHECK (decision IN ('approve','reject')), note TEXT
);
CREATE INDEX gates_open ON gates(run_id) WHERE closed_at IS NULL;
CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER, run_id INTEGER, node TEXT,
  type TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE retros (
  run_id INTEGER PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  failures TEXT NOT NULL DEFAULT '[]', findings TEXT NOT NULL DEFAULT '[]',
  rework_count INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0,
  duration_s INTEGER NOT NULL DEFAULT 0, notes TEXT NOT NULL DEFAULT ''
);`,
  // v2: gates.decision gains 'override'. SQLite cannot alter a CHECK, so rebuild the table (nothing references gates).
  `CREATE TABLE gates_new (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  node TEXT NOT NULL,
  kind TEXT NOT NULL,
  question TEXT NOT NULL, recommendation TEXT,
  opened_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  closed_at TEXT, decision TEXT CHECK (decision IN ('approve','reject','override')), note TEXT
);
INSERT INTO gates_new (id, run_id, node, kind, question, recommendation, opened_at, closed_at, decision, note)
  SELECT id, run_id, node, kind, question, recommendation, opened_at, closed_at, decision, note FROM gates;
DROP TABLE gates;
ALTER TABLE gates_new RENAME TO gates;
CREATE INDEX gates_open ON gates(run_id) WHERE closed_at IS NULL;`,
];

export function schemaVersion(db: DatabaseSync): number {
  const hasMeta = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='meta'`).get();
  if (!hasMeta) return 0;
  const row = db.prepare(`SELECT value FROM meta WHERE key='schema_version'`).get() as { value: string } | undefined;
  return row ? Number(row.value) : 0;
}

export function openDb(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path, { timeout: 5000 });
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
  for (let v = schemaVersion(db); v < MIGRATIONS.length; v++) {
    tx(db, () => {
      db.exec(MIGRATIONS[v]);
      db.prepare(`INSERT INTO meta (key, value) VALUES ('schema_version', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(v + 1));
    });
  }
  return db;
}

let savepoints = 0;

/** BEGIN IMMEDIATE … COMMIT; nested calls use SAVEPOINTs. Rolls back and rethrows on error. */
export function tx<T>(db: DatabaseSync, fn: () => T): T {
  if (db.isTransaction) {
    const sp = `sp_${++savepoints}`;
    db.exec(`SAVEPOINT ${sp}`);
    try {
      const r = fn();
      db.exec(`RELEASE ${sp}`);
      return r;
    } catch (e) {
      db.exec(`ROLLBACK TO ${sp}; RELEASE ${sp}`);
      throw e;
    }
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw e;
  }
}

/** Compact, consistent single-file copy at `dest` (no -wal/-shm). */
export function snapshot(db: DatabaseSync, dest: string): void {
  const tmp = dest + '.tmp';
  rmSync(tmp, { force: true });
  db.exec(`VACUUM INTO '${tmp.replaceAll("'", "''")}'`);
  const t = new DatabaseSync(tmp);
  try { t.exec('PRAGMA journal_mode=DELETE'); } finally { t.close(); }
  renameSync(tmp, dest);
}
