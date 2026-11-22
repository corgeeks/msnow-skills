# Implementation Log

## 2026-11-22T17:00:00 - Git exec helper and queue

**Status**: Completed

**Summary**: Added `git()` execFileSync wrapper with typed `GitError` (stderr/args/status) and `createQueue()` promise-chain FIFO that survives failed jobs.

**Changes Made**:
- `factory/src/daemon/git.ts` - Created: git, GitError, Queue, createQueue
- `factory/src/daemon/git.test.ts` - Created: exec, error, env, FIFO, failure isolation, sync return tests

**Notes**: Spec test used `rev-parse --abbrev-ref HEAD` on a fresh repo, which fails on an unborn branch; test uses `symbolic-ref --short HEAD` instead.

---
