# Debounced state committer

## Objective

Create `factory/src/daemon/state-commit.ts`: a committer that watches the bus for milestone events and, after a debounce (or when forced), snapshots the live DB into `.factory/main/.factory/factory.db`, verifies it, commits it, and pushes `HEAD:main`, retrying once on a non-fast-forward rejection. Wire the queue, forge, and committer into `factory/src/daemon/main.ts`.

## Suggested Model

Heavy: `anthropic/claude-opus-5-5` — timer/queue interplay, a retry path against a racing remote, and data-loss rules (summaries kept on failure) are easy to get subtly wrong.

## Context

The factory's source of truth is the committed `.factory/factory.db` on `main`. The daemon writes the live WAL DB; this module turns it into commits at milestones (60 s debounce) and immediately after a merge (sf5 calls `flush('merged #<id>')`). Every step runs inside one job on the shared `Queue` so it never interleaves with a PR merge or branch push.

### Parent PRD

- **PRD**: sf2-git-github-forge
- **PRD Path**: `docs/prd/sf2-git-github-forge/PRD.md`. Architecture → `src/daemon/state-commit.ts` is normative; Discussion "DB commit cadence" fixes the cadence.

### Related Tasks

- **Depends on**: "Git exec helper and queue" — `git(cwd, args, o?): string`, `GitError{stderr, args}`, `Queue`, `createQueue()`.
- **Parallel sibling**: "GitHub forge and fake gh". `main.ts` relies on `createForge({ root, mainWorktree, queue })` and `ensureMainWorktree(): Promise<void>`; tests rely on the fixture `factory/test/fixtures/git-repos.ts` → `makeRepos(): { dir, origin, root, mainWorktree }`. If the fixture is missing when you start, create it exactly as that spec defines. The committer itself never imports `forge.ts`.
- **sf0**: `snapshot(db, dest)` from `db.ts`; `Bus` (`subscribe(fn): () => void`) from `bus.ts`; `FactoryEvent` from `src/shared/types.ts`; `onShutdown(fn)` from `lifecycle.ts`; `config.git.{stateCommitPrefix, stateCommitDebounceSec}`; `resolvePaths()` → `mainWorktree`.
- **Blocks**: sf5 loop engine (calls `committer.flush('merged #<id>')` after a merge; adds its own wiring to `main.ts` after this).

## Acceptance Criteria

- [ ] Exports, verbatim:
  ```ts
  export function createStateCommitter(o: {
    db: DatabaseSync; bus: Bus; queue: Queue; mainWorktree: string;
    prefix: string; debounceSec: number;
  }): { flush(reason?: string): Promise<void>; stop(): void };
  ```
- [ ] **Milestone filter** (via `bus.subscribe`); every other event is ignored (no summary, no timer):
  | Event | Condition | Summary |
  |---|---|---|
  | `run.created` | always | `#<item> run <run> started` |
  | `run.updated` | `data.status` ∈ `completed`,`failed`,`cancelled` | `#<item> run <run> <status>` |
  | `run.updated` | `data.pr_number` is a number | `#<item> PR #<pr_number> opened` |
  | `gate.opened` | always | `#<item> gate opened (<data.kind ?? node>)` |
  | `gate.closed` | always | `#<item> gate closed (<data.decision>)` |
  | `retro.recorded` | always | `#<item> retro` |
  `<item>` is `event.item_id` (`?` if null), `<run>` is `event.run_id`. A `run.updated` matching both rows adds both summaries.
- [ ] Each milestone appends to `pending` and (re)arms one `setTimeout(debounceSec * 1000)` (cleared first; `unref()`ed). On fire it calls `flush()`.
- [ ] **`flush(reason?)`** clears the timer, then runs exactly one `queue.run` job; within it, take `batch = [...pending, reason?]` (reason appended when given):
  1. Sync (same commands as `forge.syncMain`): in `mainWorktree`, `git fetch origin --prune`, `reset --hard origin/main`, `clean -fd`. Use `git()` directly, **not** `forge.syncMain()`: awaiting a queued method inside a queued job deadlocks the FIFO.
  2. `mkdirSync(<mainWorktree>/.factory, { recursive: true })`; `snapshot(db, <mainWorktree>/.factory/factory.db)`.
  3. Verify: open the file with `new DatabaseSync(path, { readOnly: true })`; `PRAGMA integrity_check` must return a single row `ok`; close. Otherwise throw.
  4. `git add .factory/factory.db`; if `git diff --cached --quiet` exits 0, nothing staged → drop the batch from `pending` and return.
  5. Commit with `-c user.name=factory -c user.email=factory@localhost commit -m "<prefix> (<batch joined ', '>)"`; the parenthesized text is truncated to 200 chars (199 + `…`). With an empty batch, the message is just `<prefix>`.
  6. `git push origin HEAD:main`.
- [ ] If step 6 throws a `GitError` whose stderr matches `/non-fast-forward|\[rejected\]|fetch first/`, redo steps 1–6 once. A second failure, or any other error in the job, is logged to stderr (`factory: state commit failed: …`) and the batch **stays** in `pending`; `flush()` resolves (never rejects).
- [ ] On success only the batch entries are removed from `pending`; milestones arriving during the job stay pending and re-arm the timer.
- [ ] `stop()` clears the timer and unsubscribes; later events do nothing. `flush()` still works after `stop()`.
- [ ] **main.ts wiring**, after `createStore()` and before `createApiServer()`:
  1. `const queue = createQueue(); const forge = createForge({ root, mainWorktree, queue });`
  2. `await forge.ensureMainWorktree()`; on failure print to stderr and exit 1.
  3. `const committer = createStateCommitter({ db, bus, queue, mainWorktree, prefix: config.git.stateCommitPrefix, debounceSec: config.git.stateCommitDebounceSec })`.
  4. `onShutdown(async () => { committer.stop(); await committer.flush('shutdown'); })`. The DB is still open when it runs, because `installSignalHandlers` closes the DB only after all hooks.
  `queue`, `forge`, and `committer` stay in scope for sf5's later wiring.

## Implementation Notes

### Files to Modify

| File Path | Action | Description |
|-----------|--------|-------------|
| `factory/src/daemon/state-commit.ts` | Create | Committer |
| `factory/src/daemon/state-commit.test.ts` | Create | Tests below |
| `factory/src/daemon/main.ts` | Edit | Queue, forge, committer, startup sync, shutdown flush |

### Technical Constraints

- Only `node:*` imports (`node:sqlite`, `node:fs`, `node:path`); erasable TS, `.ts` extensions, `import type` for `Bus`, `Queue`, `FactoryEvent`, `DatabaseSync` type.
- Never touch `root`'s checkout; all git here runs in `mainWorktree`. `.factory/main` stays detached; push only via `HEAD:main`.
- No retries beyond the single non-fast-forward retry; no backoff.
- Never await queued forge methods (or any `queue.run`) inside the flush job.

### Relevant Code References

- `docs/prd/sf2-git-github-forge/PRD.md`: `state-commit.ts` section, Constraints, Discussion
- `docs/prd/sf0-factory-core/specs/sqlite-db-and-store.md`: `snapshot()`, bus, event `data` = changed fields
- `docs/prd/sf0-factory-core/specs/daemon-lifecycle.md`: `main.ts` startup order, `onShutdown` reverse order
- `docs/prd/sf5-loop-engine/PRD.md`: merge step calls `committer.flush('merged #<id>')`

## Testing Requirements

`state-commit.test.ts` (`node:test`, `node:assert/strict`, offline). Setup: `makeRepos()`; `git worktree add --detach <mainWorktree> origin/main` from `root`; `openDb` a temp live DB, `createBus()`, `createStore()`; `createQueue()`; `debounceSec: 0.05`.
- [ ] Debounce: two milestones (`run.created` and a gate open) within the window → exactly one new commit on origin `main`, message `factory: state (#1 run 1 started, #1 gate opened (merge))`; the committed `.factory/factory.db` opens with matching row counts.
- [ ] Ignored events: an `item.updated` and a `node.updated` arm nothing (no commit after 200 ms).
- [ ] Forced: `flush('merged #1')` without waiting commits immediately with that reason in the message.
- [ ] Nothing staged: a second `flush()` with no DB changes creates no commit and resolves.
- [ ] Non-fast-forward retry: a `pre-push` hook in `root/.git/hooks` that, on its first run only (marker file), pushes a commit from a second clone to origin `main` → flush still lands; origin `main` contains both the foreign commit and the state commit.
- [ ] Double failure: the hook pushes a foreign commit every time → flush resolves, stderr is logged, no state commit on origin, summaries kept; remove the hook, `flush()` → message contains the earlier summaries.
- [ ] Truncation: many milestones → parenthesized text is exactly 200 chars ending in `…`.
- [ ] `stop()`: a milestone after `stop()` produces no commit.

## Out of Scope

- `git.ts` ("Git exec helper and queue"); `forge.ts`, `fake-gh.ts`, and the fixture ("GitHub forge and fake gh").
- Seeding the live DB from the committed file at startup (sf0 daemon lifecycle).
- Calling `flush` after merges, engine start/stop, reviewer validation (sf5).
- Committing anything other than `.factory/factory.db`.
