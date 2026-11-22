# Implementation Log

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
