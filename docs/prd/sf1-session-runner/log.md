# Implementation Log

## 2026-11-22T12:30:00 - Worktree manager

**Status**: Completed

**Summary**: Added synchronous git worktree helpers (create/remove/prune/list with `-z` porcelain parsing, commitAll, headSha, commitsAhead, isClean, resetHard) and tests against temp repos.

**Changes Made**:
- `factory/src/daemon/worktrees.ts` - Created: worktree manager
- `factory/src/daemon/worktrees.test.ts` - Created: tests over temp bare-origin + clone fixtures

**Notes**: Reuses sf2's exported `git()` helper from `git.ts` (its errors include stderr) instead of a second private copy. The daemon commit flags live in one `COMMIT_FLAGS` constant and include `-c commit.gpgsign=false`. Full `npm test` had one failure, in `forge.test.ts`, which is sf2's file and was still in progress.

---

## 2026-11-22T12:00:00 - omp RPC session runner and fake

**Status**: Completed

**Summary**: Added `runSession`/`killAllSessions` (omp RPC runner with ready/timeout/abort/exit timers, process-group kill, stderr ring buffer), the `fake-omp.ts` RPC fake, deterministic tests for every SessionStatus, an opt-in live smoke test, and the main.ts shutdown hook.

**Changes Made**:
- `factory/src/daemon/omp.ts` - Created: session runner and live-pid registry
- `factory/src/daemon/omp.test.ts` - Created: deterministic tests against the fake
- `factory/src/daemon/omp.live.test.ts` - Created: smoke test, skipped unless FACTORY_LIVE_OMP=1
- `factory/test/fakes/fake-omp.ts` - Created: RPC fake driven by FAKE_OMP_* env
- `factory/src/daemon/main.ts` - Modified: `onShutdown(() => killAllSessions())`

**Notes**: Runner waits for both get_state/get_session_stats replies (bounded by graceMs.exit) before closing stdin. The edit test snippet adds `-c commit.gpgsign=false` because global SSH signing hangs the commit. Live test not run.

---

