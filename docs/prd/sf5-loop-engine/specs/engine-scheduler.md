# Engine scheduler, recovery, and wiring

## Objective

Implement `engine.ts` — `createEngine(deps) → { start(), stop() }` — which dispatches `queued` items into `change` runs within `loop.maxParallel`, rolls up container status, resumes runs when gates close, and recovers interrupted runs after a daemon restart. Wire it into `main.ts` with the PRD's startup and shutdown order.

## Suggested Model

Heavy: `anthropic/claude-opus-5-5` — concurrent dispatch with CAS races, crash recovery, and process-lifecycle ordering.

## Context

The engine owns *when* runs start and resume; `runChange` (sibling "change loop state machine") owns *what* a run does. Exactly one `runChange` promise may exist per run per process.

### Parent PRD

- **PRD**: sf5-loop-engine
- **PRD Path**: `docs/prd/sf5-loop-engine/PRD.md`. "Dispatch", "Restart recovery", and "Constraints" (startup order, `onShutdown`) are normative.

### Related Tasks

- **Depends on**:
  - "change loop state machine": `runChange(ctx: ChangeContext): Promise<void>`, `ChangeContext`, `INTERRUPTED = 'interrupted by daemon restart'`.
  - sf0 "SQLite database and store" (`dispatchableItems`, `transitionItem`, `listRuns`, `createRun`, `listNodeRuns`, `transitionNodeRun`, `updateNodeRun`, `getChildren`, `listGates`, `ConflictError`, `bus.subscribe`), "Daemon lifecycle and entrypoint" (`main.ts`, `onShutdown`).
  - sf1 "Worktree manager" (`createWorktree`, `pruneWorktrees`), "omp RPC session runner and fake" (`killAllSessions`).
  - sf2 "GitHub forge and fake gh" (`forge.fetch`, `ensureMainWorktree`), "Debounced state committer".
- **Blocks**: "End-to-end loop tests".

## Acceptance Criteria

**API**
- [ ] `createEngine(deps: EngineDeps): { start(): Promise<void>; stop(): Promise<void> }` where `EngineDeps = Omit<ChangeContext, 'runId' | 'stopped'> & { worktrees: ChangeContext['worktrees'] & Pick<typeof import('./worktrees.ts'), 'createWorktree'|'pruneWorktrees'>; runChange?: typeof runChange; tickMs?: number }` (`runChange` and `tickMs` injectable for tests; defaults: real `runChange`, 5000). Each launch passes `{...deps, runId, stopped: () => this engine's stopped flag}`.
- [ ] `validateReviewerMapping(config): void` is exported: for each executor model, `config.roles.reviewer[family(model)]` must exist, else throw `config error: roles.reviewer has no entry for family "<f>" (executor <model>)`.

**Dispatch (`tick`)**
- [ ] Ticks run on `start()`, on bus events `item.updated`, `gate.closed`, `run.updated`, and every `tickMs`. Ticks never overlap: a tick requested while one runs sets a `again` flag and one more tick runs afterwards.
- [ ] `free = config.loop.maxParallel − listRuns({}).filter(r => r.status === 'running').length`. `paused` runs do not count.
- [ ] For each of the first `free` items of `store.dispatchableItems()` that has **no children** (containers are never dispatched; see gaps):
  1. `transitionItem(id,'queued','active')`; on `ConflictError` log and skip.
  2. `attempt = max(attempt over listRuns({item_id: id})) + 1` (1 if none).
  3. `await forge.fetch()`, then `createWorktree(paths.root, {itemId, attempt, base:'origin/main'})`.
  4. `createRun({item_id, template:'change', attempt, branch, worktree, status:'running', started_at: now})`.
  5. Launch `runChange({...deps, runId})` unawaited; store the promise in `inFlight: Map<runId, Promise>`, deleting the entry in `finally`; a rejection is logged, never unhandled.
  - If step 3 or 4 throws: log, `transitionItem(id,'active','queued')`, continue with the next item.
- [ ] A `UNIQUE(item_id, attempt)` violation from `createRun` is handled like step-3 failure.

**Gate resume**
- [ ] On `gate.closed` with `run_id`, if the run is `paused` and not in `inFlight`, launch `runChange` for it (same map). Never launch a second promise for a run in `inFlight`.

**Container roll-up**
- [ ] On `item.updated` whose new status is `done`, `cancelled`, or `blocked`, walk `parent_id` up to the root; for each ancestor compute from `getChildren`:

  | Children | Container status |
  |---|---|
  | All `done` or `cancelled` | `done` |
  | Any `active`, `queued`, or `blocked` | `active` |
  | Otherwise | unchanged |

  and apply it with `transitionItem(id, current, target)` when different; `ConflictError` is logged and the walk stops.

**Restart recovery (`start()`)**
- [ ] Order: `pruneWorktrees(root)`; for every run with status `running`: each `running` node run → `transitionNodeRun(id,'running','failed')` + `updateNodeRun(id,{output: INTERRUPTED, ended_at})`, then launch `runChange` (resumes at the interrupted node; a build gets the resume prompt). `paused` runs are left alone and resume via `gate.closed`; a `paused` run whose latest gate is already closed (decision landed while the daemon was down) is launched too. Then subscribe to the bus, start the interval, run the first tick.
- [ ] Recovery runs before any dispatch, so recovered runs count against capacity.

**stop()**
- [ ] Unsubscribes, clears the interval, and sets a `stopped` flag so no tick, gate resume, or launch happens afterwards. It does **not** await in-flight `runChange` promises (it runs before `killAllSessions`, so awaiting would stall shutdown); interrupted runs stay `running` and are recovered on next start. Returns after any tick in progress finishes.

**main.ts wiring**
- [ ] Startup order: `validateReviewerMapping(config)` (exit 1 with the message on failure) → sf2's existing `await forge.ensureMainWorktree()` (do **not** add a second call; only ensure it precedes the engine) → sf2's existing committer (reuse it; do not create another) → `createEngine({store, bus, config, paths, runSession, worktrees, forge, committer})` → `await engine.start()`.
- [ ] Shutdown runs `engine.stop()` → `killAllSessions()` → committer `stop()` + `flush('shutdown')`. Because hooks run in reverse, `main.ts` registers them in the order: committer hook, then `onShutdown(() => killAllSessions())`, then `onShutdown(() => engine.stop())`; reorder the existing sf1/sf2 `onShutdown` lines if needed.

**Self-hosting restart hint**
- [ ] The PRD lists the hint under dispatch, but the diff is only knowable inside the run before the worktree is removed, so it is implemented once in `runChange` (merge records `touches_factory`, retro logs `daemon code changed on main — restart the daemon to pick it up` and stores it in `notes`, which lands in the `retro.recorded` event data). The engine never restarts the daemon and adds no code for this; the e2e tests assert the hint.

## Implementation Notes

### Files to Modify

| File Path | Action | Description |
|-----------|--------|-------------|
| `factory/src/daemon/engine.ts` | Create | Dispatch, roll-up, gate resume, recovery |
| `factory/src/daemon/engine.test.ts` | Create | Tests |
| `factory/src/daemon/main.ts` | Edit | Validation, engine start, shutdown hook order |

### Technical Constraints

- Only `node:*` runtime imports; erasable syntax; `.ts` imports.
- No git/gh calls: worktrees via `deps.worktrees`, fetch via `deps.forge`.
- All status changes via store CAS; `ConflictError` is logged and the step abandoned, never retried blindly.
- Bus handlers are synchronous; they only schedule ticks/launches (no `await` inside the subscriber).
- Event `data` for `item.updated` holds the changed fields, so `data.status` is the new status (sf0 store spec).

### Relevant Code References

- `docs/prd/sf0-factory-core/specs/sqlite-db-and-store.md` — `dispatchableItems`, transitions, events.
- `docs/prd/sf0-factory-core/specs/daemon-lifecycle.md` — `onShutdown` reverse order, `main.ts`.
- `docs/prd/sf1-session-runner/PRD.md` — `createWorktree` path/branch naming, `pruneWorktrees`.
- `skills/prd/workflows/WorkPRD.md` — "Step 0: Resume Interrupted Work FIRST", mirrored by recovery.

### Code Examples

```ts
const free = deps.config.loop.maxParallel - deps.store.listRuns({}).filter(r => r.status === 'running').length;
for (const item of deps.store.dispatchableItems().filter(i => deps.store.getChildren(i.id).length === 0).slice(0, Math.max(0, free))) {
  try { deps.store.transitionItem(item.id, 'queued', 'active'); }
  catch (e) { if (e instanceof ConflictError) { log(e); continue; } throw e; }
  // attempt, fetch, worktree, createRun, launch
}
```

## Testing Requirements

Use a real store on a temp DB, a temp `root` clone of a bare origin, a fake forge (`fetch` resolves), and an injected `runChange` stub that records calls and resolves on demand.
- [ ] `maxParallel 2`, 3 queued items → 2 runs created, third stays `queued`; resolving one stub and marking its run `completed` dispatches the third.
- [ ] Two concurrent ticks (call internal tick twice without awaiting) → each item dispatched once, one run per item.
- [ ] Item with a prior run `attempt 1` → new run `attempt 2`, worktree `<root>/.factory/worktrees/<id>-2`, branch `factory/<id>-2`.
- [ ] Item with an undone dependency is not dispatched; container items are never dispatched.
- [ ] Roll-up: parent with children `done`+`cancelled` → `done`; one child `blocked` → `active`; grandparent updated too.
- [ ] `gate.closed` for a paused run launches `runChange` once; a second event while in flight does not.
- [ ] Recovery: seed a `running` run with a `running` build node run → after `start()` the node run is `failed` with `INTERRUPTED` and `runChange` was called for that run before any new dispatch; a `paused` run with an open gate is not launched.
- [ ] `validateReviewerMapping` throws for a config whose executor family has no reviewer.
- [ ] `stop()` resolves while a `runChange` stub is still pending; afterwards no ticks fire and a `gate.closed` event launches nothing; `ctx.stopped()` passed to `runChange` returns `true`.

## Out of Scope

- Node logic, gates' approve/reject effects, retro, PR body (sibling "change loop state machine").
- Full loop runs with fake-omp/fake-gh ("End-to-end loop tests").
- Forge/committer internals (sf2), session runner (sf1), HTTP gate decisions (sf0).
- Auto-restarting the daemon after self-modifying merges (v1).
