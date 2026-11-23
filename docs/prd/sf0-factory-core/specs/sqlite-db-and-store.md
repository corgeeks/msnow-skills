# SQLite database and store

## Objective

Implement the live database layer and the typed store:
- `db.ts` handles opening the DB, migrations, transactions, and snapshots.
- `bus.ts` is in-process pub/sub.
- `store.ts` is the only code that mutates factory state. It does CAS status transitions, cycle-checked dependencies, and the ready-item query, and every mutation emits exactly one event.

## Suggested Model

Heavy: `anthropic/claude-opus-5-5`. This module is the contract every other slice depends on: transactional and concurrency semantics, a recursive cycle check, and event ordering.

## Context

The daemon is the single writer of the factory DB. Its WAL-mode DB lives at `.factory/live/factory.db`, and the committed copy is produced by `snapshot()`. Later slices depend on this module:
- sf1 (session runner) and sf5 (loop engine) update runs, node runs, and gates through the store.
- The HTTP API exposes it.
- The UI consumes its events over SSE.

### Parent PRD

- **PRD**: sf0-factory-core
- **PRD Path**: `docs/prd/sf0-factory-core/PRD.md`. The Schema and Live DB and snapshot sections are normative.

### Related Tasks

- **Depends on**: Scaffold package, config, and shared types (`src/shared/types.ts`)
- **Blocks**: HTTP API, SSE, and static UI serving; Daemon lifecycle and entrypoint

## Acceptance Criteria

**`db.ts`**
- [ ] It exports `openDb(path: string): DatabaseSync`, which creates parent dirs and then sets `journal_mode=WAL` and `foreign_keys=ON` with busy `timeout: 5000`.
- [ ] `openDb` applies the migrations from a `MIGRATIONS: string[]` array whose index + 1 is the version. It runs them inside a transaction and records `meta.schema_version`.
- [ ] Reopening an up-to-date DB does nothing.
- [ ] It exports `tx<T>(db, fn: () => T): T`. This runs `BEGIN IMMEDIATE`, then `COMMIT`; it runs `ROLLBACK` and rethrows if `fn` throws, and supports nesting through SAVEPOINT.
- [ ] It exports `snapshot(db, dest: string): void`:
  - removes `dest + '.tmp'`;
  - runs `VACUUM INTO` the tmp path, escaping `'` as `''`;
  - sets `journal_mode=DELETE` on the tmp file;
  - renames it over `dest`.
  - The resulting file opens read-only, has identical row counts, and no `dest-wal` or `dest-shm` sits beside it.

**`bus.ts`**
- [ ] It exports `createBus()`, which is synchronous and returns:
  - `publish(e: FactoryEvent): void` and `subscribe(fn): () => void` for persisted events;
  - `publishActivity(a: Activity): void` and `subscribeActivity(fn): () => void` for **transient** activity lines.
  - `Activity` is `{run_id: number; node: string; text: string; at: string}` and is exported from `src/shared/types.ts`.
  - Activity is never written to the DB.

**`store.ts`**
- [ ] It exports `createStore(db, bus)` with typed methods covering:
  - items: `createItem`, `createItemsBatch`, `getItem`, `listItems({status?, parent_id?, type?})` (returns `ItemSummary[]`, with `open_deps` computed in the same query), `getItemDetail(id)` (returns `ItemDetail`), `updateItem`, `transitionItem(id, from, to)`;
  - dependencies: `addDep(itemId, dependsOnId)`, `getDeps`, `getDependents`, `getChildren`;
  - `dispatchableItems()`: items with `status='queued'` whose dependencies are all `done`, ordered by `priority DESC, id ASC`;
  - runs: `createRun`, `getRun`, `listRuns({item_id?})`, `updateRun`, `transitionRun(id, from, to)`;
  - node runs: `createNodeRun`, `updateNodeRun`, `transitionNodeRun(id, from, to)`, `listNodeRuns(runId)`;
  - gates: `openGate`, `decideGate(id, decision, note?)`, `listGates({open?, run_id?})`;
  - `recordRetro`;
  - events: `listEvents({after?, limit?})`.
- [ ] Every `transition*` runs `UPDATE … SET status=?, updated_at=… WHERE id=? AND status=?`. If `changes !== 1` it throws `ConflictError` (exported, `code = 'conflict'`) and emits no event.
- [ ] `decideGate` on an already-closed gate throws `ConflictError`.
- [ ] `addDep` throws `CycleError` (exported, `code = 'cycle'`) when `dependsOnId` can already reach `itemId`, using a recursive CTE over `item_deps`. Self-dependencies are rejected too.
- [ ] `createItemsBatch(items: BatchItem[])` runs in one transaction.
  - Each `BatchItem` has a client `ref`, an optional `parent_ref` and `depends_on_refs`, plus the create fields.
  - Refs resolve within the batch.
  - An item whose `source_ref` already exists is skipped and returns its existing id, which makes re-import idempotent.
  - The method returns `BatchResult` (`{ids, created, skipped}`, from `src/shared/types.ts`).
  - Any error rolls back the whole batch.
- [ ] Every successful mutation appends exactly one `events` row inside the same transaction, of the matching `EventType`, with `item_id`/`run_id`/`node` set where applicable and `data` holding the changed fields. After commit it calls `bus.publish` with the full `FactoryEvent` (data parsed). Nothing is published on rollback.
- [ ] JSON columns (`events.data`, `retros.failures`/`findings`) are stored as text and returned parsed.
- [ ] Errors are exported: `ConflictError`, `CycleError`, and `NotFoundError` (`code = 'not_found'`). The HTTP layer maps them to 409, 409, and 404.

## Implementation Notes

### Files to Modify

| File Path | Action | Description |
|-----------|--------|-------------|
| `factory/src/daemon/db.ts` | Create | Open, migrate, tx, snapshot |
| `factory/src/daemon/bus.ts` | Create | Pub/sub |
| `factory/src/daemon/store.ts` | Create | Repository |
| `factory/src/daemon/db.test.ts` | Create | Tests |
| `factory/src/daemon/store.test.ts` | Create | Tests |

### Technical Constraints

- Use `import { DatabaseSync } from 'node:sqlite'`. There is no `.transaction()` helper, so write `tx()`.
- Use prepared statements, with no string-concatenated values. The only exception is the `VACUUM INTO` path literal, which must be escaped.
- `updated_at` uses `strftime('%Y-%m-%dT%H:%M:%fZ','now')`.
- Use the schema SQL from the PRD verbatim as migration 1.
- Only the store mutates state. Do not export raw write helpers.

### Relevant Code References

- `docs/prd/sf0-factory-core/PRD.md`: Schema, work-item status table, Live DB and snapshot
- `factory/src/shared/types.ts`: return types
- Archon CAS pattern (reference): `claimPendingWorkflowRun` in https://github.com/coleam00/Archon/blob/dev/packages/core/src/db/workflow-run-transitions.ts

### Code Examples

```ts
// cycle check: can `to` already reach `from`?
const reaches = db.prepare(`
  WITH RECURSIVE r(id) AS (
    SELECT depends_on_id FROM item_deps WHERE item_id = ?
    UNION SELECT d.depends_on_id FROM item_deps d JOIN r ON d.item_id = r.id)
  SELECT 1 FROM r WHERE id = ? LIMIT 1`);
if (from === to || reaches.get(to, from)) throw new CycleError(from, to);
```

## Testing Requirements

- [ ] Migrations run on a fresh DB, re-running them is a no-op, and `schema_version` is 1.
- [ ] `snapshot()`: after inserts, the snapshot file opens with the same counts, and no `-wal`/`-shm` files exist next to `dest`. Overwriting an existing `dest` works.
- [ ] Two `transitionItem(id, 'ready', 'active')` calls: the first succeeds and the second throws `ConflictError`. Exactly one `item.updated` event is recorded.
- [ ] `addDep` A→B, then B→C, then C→A throws `CycleError`, and so does a self-dependency.
- [ ] `dispatchableItems()` returns only `queued` items. It excludes an item with a dependency that isn't `done` and includes it once the dependency is done. `ready` items are never returned. Priority ordering holds.
- [ ] `createItemsBatch` resolves parent and dependency refs. Re-running the same batch creates nothing new and returns the same ids. A batch containing a cycle rolls back completely, with zero items created.
- [ ] Bus subscribers receive events in `seq` order, and receive nothing for a rolled-back mutation.
- [ ] `decideGate` twice: the second call throws `ConflictError`.

## Out of Scope

- HTTP, SSE, the daemon process, and git commits of the snapshot (sf2)
- Engine logic about *when* to transition (sf5)
- Additional migrations beyond migration 1
