# Implementation Log

## 2026-11-22T16:05:54 - Engine scheduler, recovery, and wiring

**Status**: Completed

**Summary**: Added `engine.ts` (`createEngine` dispatch within `maxParallel`, non-overlapping ticks, container roll-up, gate resume, restart recovery, `stop()`) and `validateReviewerMapping`, wired into `main.ts`.

**Changes Made**:
- `factory/src/daemon/engine.ts` - Created: engine and reviewer-mapping validation
- `factory/src/daemon/engine.test.ts` - Created: dispatch, concurrency, attempts, deps/containers, roll-up, gate resume, recovery, validation, stop tests
- `factory/src/daemon/main.ts` - Modified: validate mapping after the instance lock, create the engine after the committer, register `engine.stop` last, then `await engine.start()`

**Notes**: `createRun` takes only `{item_id, template, attempt}`, so dispatch follows it with `updateRun({branch, worktree, started_at})` and `transitionRun('pending','running')`. `ticking` is set before dispatch runs, because store writes emit events synchronously and would otherwise start a nested tick. The engine also exposes `tick` for tests.

---

## 2026-11-22T16:03:15 - change loop state machine

**Status**: Completed

**Summary**: Added the re-entrant `change` state machine: pure `nextStep` derivation from persisted rows, plus `runChange` executing build/test/review/pr/merge_gate/merge/retro with gates, containment, CAS, and stop handling.

**Changes Made**:
- `factory/src/daemon/template-change.ts` - Created: `ChangeContext`, `INTERRUPTED`, `nextStep`, `runChange`
- `factory/src/daemon/template-change.test.ts` - Created: nextStep rule tables and runChange tests on a real store/worktree with fake-omp and a recording forge

**Notes**: Conflict with the engine spec: recovery overwrites an interrupted review row's `{pre_sha}` output with `INTERRUPTED`. To handle this, a successful build stores `{"head_sha"}` as its output, and a re-run review falls back to it. `pr_number`/`pr_url`/`head_sha` are written right after `openPr`, before the stop check, so a re-run cannot open a duplicate PR. Steps are idempotent so a crash between writes resumes cleanly: status changes are skipped when the target state is already reached, `closePr`/`mergePr` are guarded by `prState`, and `removeWorktree` only runs if the dir exists. `merge_gate` rows interrupted mid-transition are revived in place. Retro writes a `retro` node row. `ChangeContext.paths` is narrowed to `{root, sessionsDir}`, which the full paths object satisfies.

---

## 2026-11-22T15:54:18 - Executor and reviewer prompts

**Status**: Completed

**Summary**: Added executor/reviewer prompt templates and prompts.ts (render with {{var}}/{{#var}} sections, parseVerdict).

**Changes Made**:
- `factory/src/daemon/prompts/executor.md` - Created: build prompt ported from prd-worker.md without status bookkeeping
- `factory/src/daemon/prompts/reviewer.md` - Created: read-only review prompt ending in a json verdict block
- `factory/src/daemon/prompts.ts` - Created: buildExecutorPrompt, buildReviewerPrompt, parseVerdict, NO_VERDICT_FINDING
- `factory/src/daemon/prompts.test.ts` - Created: render and verdict tests

**Notes**: Sections may nest (executor nests prd_path inside spec_path). `render` is exported for the unknown-var test.

---


## 2026-11-22T15:53:51 - Retro computation

**Status**: Completed

**Summary**: Added pure deterministic `computeRetro(run, nodeRuns, findings)` and tests.

**Changes Made**:
- `factory/src/daemon/retro.ts` - Created: computeRetro
- `factory/src/daemon/retro.test.ts` - Created: tests covering all spec cases

**Notes**: Unparseable timestamps yield duration 0.

---

