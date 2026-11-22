# Implementation Log

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

