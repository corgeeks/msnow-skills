# Implementation Log

## 2026-11-22T19:00:00 - Debounced state committer

**Status**: Completed

**Summary**: Added `createStateCommitter` (milestone filter, unref'd debounce timer, single queued flush job that syncs `.factory/main` with `git()` directly, snapshots and integrity-checks the DB, commits unsigned via `DAEMON_COMMIT_FLAGS`, pushes `HEAD:main`, one retry on a racing remote). Wired queue, forge, `ensureMainWorktree`, committer and shutdown flush into `main.ts`.

**Changes Made**:
- `factory/src/daemon/state-commit.ts` - Created: createStateCommitter
- `factory/src/daemon/state-commit.test.ts` - Created: debounce, filter, forced, nothing staged, retry, double failure, truncation, stop
- `factory/src/daemon/main.ts` - Modified: queue/forge/committer wiring, startup worktree, shutdown flush
- `factory/src/daemon/lifecycle.test.ts` - Modified: daemon tests use `makeRepos()` (startup now needs `origin`); smoke test asserts the `shutdown` state commit

**Notes**: Deviations: (1) retry regex adds `incorrect old value`. A remote that moves during the push (the spec's pre-push-hook race) gets `[remote rejected] … (incorrect old value provided)`, which the spec regex misses. (2) On failure, a `flush(reason)` reason is kept in `pending` with the milestones, so "the batch stays pending" includes it. Startup runs `ensureMainWorktree` before `acquireInstanceLock`, as the spec orders, so a second daemon resets `.factory/main` before it exits.

---

## 2026-11-22T18:00:00 - GitHub forge and fake gh

**Status**: Completed

**Summary**: Added `createForge` (queued fetch/sync/ensureMainWorktree/push/delete/merge via unqueued private helpers; unqueued gh open/comment/view/close with `--body-file` temp files), offline `fake-gh.ts`, and `makeRepos()` fixture.

**Changes Made**:
- `factory/src/daemon/forge.ts` - Created: PrState, createForge, Forge
- `factory/src/daemon/forge.test.ts` - Created: worktree, sync, branch/PR/merge flow, UNKNOWN retry, close/delete, queue ordering
- `factory/test/fakes/fake-gh.ts` - Created: offline gh (pr create/comment/view/merge/close)
- `factory/test/fixtures/git-repos.ts` - Created: bare origin + user clone fixture
- `factory/src/daemon/git.ts` - Modified: added `DAEMON_COMMIT_FLAGS` (factory identity + `commit.gpgsign=false`)

**Notes**: Per user policy, factory commits are unsigned; fixture sets `commit.gpgsign=false` in `root`. `ensureMainWorktree` runs `worktree prune` before `add` so a deleted dir with stale admin data recovers. `worktrees.ts` has its own `COMMIT_FLAGS`; could reuse `DAEMON_COMMIT_FLAGS`.

---

## 2026-11-22T17:00:00 - Git exec helper and queue

**Status**: Completed

**Summary**: Added `git()` execFileSync wrapper with typed `GitError` (stderr/args/status) and `createQueue()` promise-chain FIFO that survives failed jobs.

**Changes Made**:
- `factory/src/daemon/git.ts` - Created: git, GitError, Queue, createQueue
- `factory/src/daemon/git.test.ts` - Created: exec, error, env, FIFO, failure isolation, sync return tests

**Notes**: Spec test used `rev-parse --abbrev-ref HEAD` on a fresh repo, which fails on an unborn branch; test uses `symbolic-ref --short HEAD` instead.

---
