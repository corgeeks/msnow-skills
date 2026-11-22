# L0 · sf0 — Factory core

> Child of umbrella **software-factory** (`../software-factory/PRD.md`). The umbrella's cross-cutting decisions (stack, git topology, model roster, loop template) apply here and are not repeated.

## Objective

Create the `factory/` package and the parts every other slice builds on:

- the package scaffold;
- the `.factory/config.json` loader;
- the shared domain types;
- the `node:sqlite` schema, migrations, and CAS store;
- the `VACUUM INTO` snapshot;
- the daemon process (single instance via port bind, graceful shutdown, shutdown-hook registry);
- the localhost HTTP JSON API for work items, dependencies, runs, gates, and events;
- the SSE `/events` stream with `Last-Event-ID` replay;
- static serving of the built UI.

**Done when:**
- `node factory/src/daemon/main.ts` starts a daemon that serves the API on `127.0.0.1:<port>`.
- A second instance exits with a clear "already running" error.
- Items created over the API appear in the live DB and stream over SSE.
- `npm test --prefix factory` and `npm run typecheck --prefix factory` pass.

## Motivation

Every other slice depends on sf0's data shapes:
- sf1 writes node results and events;
- sf2 snapshots the DB;
- sf3 calls the API;
- sf4 renders it;
- sf5 drives the state machine.

Fixing the schema, the status enums, the store's transition rules, and the API contract first lets L1 run as four parallel slices without negotiating contracts.

## Implementation Details

### Architecture

#### Module layout

```
factory/
├── package.json            # private, "type": "module", engines.node ">=24.15"
├── tsconfig.json           # noEmit, nodenext, erasableSyntaxOnly, verbatimModuleSyntax, allowImportingTsExtensions
└── src/
    ├── shared/
    │   ├── types.ts        # domain types + status unions (the contract for every slice)
    │   └── config.ts       # load/validate .factory/config.json with defaults
    └── daemon/
        ├── paths.ts        # repo root + .factory/* path resolution
        ├── db.ts           # open live DB, migrations, tx(), snapshot()
        ├── store.ts        # typed repository; every mutation appends an event
        ├── bus.ts          # in-process pub/sub of appended events
        ├── http.ts         # createApiServer(): JSON API + /events SSE + static UI
        ├── lifecycle.ts    # acquireInstanceLock(), onShutdown(), installSignalHandlers()
        └── main.ts         # entrypoint wiring
```

The daemon and CLI have no runtime dependencies. Dev dependencies are `typescript` and `@types/node` only.

#### Schema (migration 1)

```sql
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
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
);
```

**Work-item status:**

| Status | Meaning |
|---|---|
| `draft` | Not ready to work |
| `ready` | Planned and startable, but the engine ignores it until it is explicitly started |
| `queued` | Started by `factory start`. The engine dispatches it once every dependency is `done`, within `loop.maxParallel`. |
| `active` | A run is in flight |
| `blocked` | A failure gate is open |
| `done` | Finished |
| `cancelled` | Abandoned |

- Statuses change only through `store.transition*()`, which does `UPDATE … WHERE id=? AND status=?` and throws `ConflictError` unless `changes === 1`. This is a compare-and-swap (CAS) update, modeled on Archon.
- Dependency insertion rejects cycles. Before inserting, it runs a recursive CTE that checks whether `depends_on_id` can already reach `item_id`.
- Every store mutation appends exactly one event in the same transaction, then publishes it on `bus` after commit. v0 event types are `item.created`, `item.updated`, `run.created`, `run.updated`, `node.updated`, `gate.opened`, `gate.closed`, and `retro.recorded`.
- Executor token streams are **not** stored. Only lifecycle events go in, so the committed DB stays small.

#### Live DB and snapshot

- `openDb(path)` sets `PRAGMA journal_mode=WAL`, `foreign_keys=ON`, and the `timeout: 5000` busy timeout. It then applies the migrations in order and records `meta.schema_version`. Migrations are forward-only.
- `snapshot(db, dest)` deletes `dest.tmp`, runs `VACUUM INTO 'dest.tmp'` (with single quotes escaped), and renames `dest.tmp` over `dest`. The result is a single, compact, consistent file with no `-wal` or `-shm`. Committing it is sf2's job.
- On startup, `main.ts` seeds a missing `.factory/live/factory.db` from the committed `.factory/factory.db`, or creates it fresh if neither exists.

#### HTTP API (JSON; errors are `{"error":{"code","message"}}` with 400/404/409)

Response shapes: lists are bare JSON arrays, and nested collections are full objects, not ids.

| Method + path | Request → response |
|---|---|
| `GET /api/health` | → `{ok, pid, schemaVersion}` |
| `GET /api/items?status=&parent=&type=` | → `ItemSummary[]`, which is `WorkItem` plus `open_deps: number`: the count of dependencies not yet `done`, computed in the same query |
| `GET /api/items/:id` | → `{item: WorkItem, deps: WorkItem[], dependents: WorkItem[], children: WorkItem[], runs: Run[]}` |
| `POST /api/items` | `BatchItem` fields without `ref`/`parent_ref`/`depends_on_refs`, plus `parent_id?`, `depends_on?: number[]` → `WorkItem` |
| `POST /api/items/batch` | `{items: BatchItem[]}` → `BatchResult` `{ids: {ref→id}, created: ref[], skipped: ref[]}`. One transaction. `parent_ref` and `depends_on_refs` resolve within the batch, and `status` may be set. Items whose `source_ref` already exists are skipped. |
| `PATCH /api/items/:id` | `{title?, body?, tier?, test_cmd?, priority?, status?, from?}`. A status change needs `from` and returns 409 on conflict → `WorkItem` |
| `POST /api/items/:id/deps` | `{depends_on: number}` → `{ok: true}`. Returns 409 on a cycle. |
| `GET /api/runs?item=` | → `Run[]` |
| `GET /api/runs/:id` | → `{run: Run, node_runs: NodeRun[], gates: Gate[]}` |
| `GET /api/gates?open=1` | → `Gate[]`. With `open=1`, only open gates. Without it, all gates: open first, then closed by `closed_at` desc, `limit` 100. |
| `POST /api/gates/:id/decision` | `{decision, note?}` → `Gate`. Returns 409 if the gate is already closed. |
| `GET /api/events?after=&limit=` | → `FactoryEvent[]` (paged event log) |
| `GET /events` | SSE (`id: seq`, `event: type`, `data: JSON`). Replays events after `Last-Event-ID`, sends a 15 s `: ping` heartbeat, and sends `retry: 3000`. |
| `GET /*` | Static files from `factory/ui/dist` with SPA fallback. A missing asset that has an extension returns 404. If `dist` is absent, a short HTML note says to build the UI. |

`ItemSummary`, `ItemDetail`, and `RunDetail` are exported from `src/shared/types.ts` next to the other types.

`createApiServer({ store, bus, uiDir }): http.Server` has no listen side effects; `main.ts` calls listen. The API binds only to `127.0.0.1`.

#### Process lifecycle

- `acquireInstanceLock(port)` binds `127.0.0.1:port`. On `EADDRINUSE` it rejects with `daemon already running on 127.0.0.1:<port>`. The HTTP server itself is the lock.
- `onShutdown(fn)` registers async cleanup hooks; sf1 registers process-group killing here. `installSignalHandlers()` runs on SIGTERM/SIGINT: it stops accepting connections, runs the hooks with a 10 s grace period, closes the DB, and calls `process.exit(0)`.

#### Config (`.factory/config.json`, committed; every key optional, defaults in `config.ts`)

```json
{
  "port": 7317,
  "roles": {
    "planner": "anthropic/claude-opus-5-5",
    "executor": { "heavy": "anthropic/claude-opus-5-5", "standard": "anthropic/claude-sonnet-5-5", "light": "anthropic/claude-haiku-5-5" },
    "reviewer": { "anthropic": "openai-codex/gpt-6.2-sol", "openai-codex": "anthropic/claude-opus-5-5" }
  },
  "caps": { "sessionMinutes": 30, "sessionCostUsd": 5 },
  "loop": { "maxBuildAttempts": 3, "maxReviewRounds": 2, "maxParallel": 2 },
  "git": { "stateCommitPrefix": "factory: state", "stateCommitDebounceSec": 60 },
  "defaultTestCmd": "npm test --prefix factory"
}
```

An unknown key or a wrong type fails at startup with the key path in the message.

### Constraints

- Node ≥ 24.15. Everything in the umbrella's TypeScript constraints applies: erasable syntax only, `.ts` import extensions, `import type`, no build step.
- Runtime code imports only `node:*` modules. `ui/` is sf4's and is not created here.
- The daemon is the only process that opens the live DB. The CLI and UI go through HTTP.
- Status columns change only through store CAS helpers, never through ad-hoc `UPDATE`s elsewhere.
- Item IDs are plain integers (see Discussion). There is no key prefix.
- Tests use `node:test` and `node:assert/strict` with temp dirs (`fs.mkdtempSync`) and port `0`. They never touch the real `.factory/`.
- `.factory/.gitignore` ignores `main/`, `live/`, `worktrees/`, and `sessions/`. `factory/.gitignore` ignores `node_modules/` and `ui/dist/`.

### Relevant Guides

- Umbrella `../software-factory/PRD.md`: Architecture (process model, git topology, data-model sketch) and the Execution facts section
- `../software-factory/research.yaml`: answers on `node:sqlite`, SQLite snapshots, type stripping, SSE + static serving, and the daemon lifecycle
- https://nodejs.org/docs/latest-v24.x/api/sqlite.html
- https://nodejs.org/docs/latest-v24.x/api/typescript.html
- https://nodejs.org/docs/latest-v24.x/api/test.html
- https://html.spec.whatwg.org/multipage/server-sent-events.html

### Relevant Files

- `factory/package.json`, `factory/tsconfig.json`, `factory/.gitignore` - (Create) package scaffold
- `factory/src/shared/types.ts`, `factory/src/shared/config.ts` - (Create) contract + config
- `factory/src/daemon/{paths,db,store,bus,http,lifecycle,main}.ts` - (Create) daemon core
- `factory/src/**/*.test.ts` - (Create) tests next to the modules they cover
- `.factory/config.json`, `.factory/.gitignore` - (Create)
- `skills/prd/scripts/lib/prd-root.sh` - (Review) pattern for root resolution, mirrored in `paths.ts` (`git rev-parse --show-toplevel`)

## Discussion

### Work-item ID format

_JIRA-style keys (`SF-1`), plain integers, or ULIDs? IDs appear in branch names, PR titles, CLI commands, and UI URLs._

Plain integers.

### Model routing

_Inherited from the umbrella: which harness and models implement this PRD?_

omp through WorkPRD. Heavy is `anthropic/claude-opus-5-5`, Standard is `anthropic/claude-sonnet-5-5`, and Light is `anthropic/claude-haiku-5-5`.
