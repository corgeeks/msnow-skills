# Retro computation

## Objective

Implement `retro.ts`: a pure, deterministic `computeRetro(run, nodeRuns, findings)` that turns a finished run's persisted rows into the `Retro` record the `change` loop stores with `store.recordRetro`. No LLM, no I/O.

## Suggested Model

Light: `anthropic/claude-haiku-5-5` — one small pure function over typed rows with fully specified rules.

## Context

The retro step closes every `change` run: after merge, after a merge-gate reject, and after a failure-gate reject. It feeds the umbrella's learning loop (failures, findings, rework, cost, time). This v0 version only summarizes rows; knowledge-edit proposals are later work.

### Parent PRD

- **PRD**: sf5-loop-engine
- **PRD Path**: `docs/prd/sf5-loop-engine/PRD.md`. Step 8 (retro) of the `change` state machine is normative.

### Related Tasks

- **Depends on**: sf0 "Scaffold package, config, and shared types" (`Run`, `NodeRun`, `Retro` in `src/shared/types.ts`).
- **Parallel sibling**: "Executor and reviewer prompts" (no shared code).
- **Blocks**: "change loop state machine", which relies on exactly:
  `computeRetro(run: Run, nodeRuns: NodeRun[], findings: string[]): Retro`
  The state machine collects `findings` (all review findings in order, including containment and no-verdict findings), calls `computeRetro`, may set `notes` (self-hosting restart hint), then calls `store.recordRetro`.

## Acceptance Criteria

- [ ] `factory/src/daemon/retro.ts` exports `computeRetro(run: Run, nodeRuns: NodeRun[], findings: string[]): Retro`.
- [ ] Only node runs with `run_id === run.id` are considered, sorted by `iteration ASC, id ASC`; input order does not matter.
- [ ] `run_id` = `run.id`.
- [ ] `failures`: one string per node run with `node` in `build`/`test` and `status === 'failed'`, formatted `` `${node} #${iteration}: ${firstLine(output) || 'no output'}` ``, each truncated to 300 characters, in `iteration, id` order. `firstLine` for test output means the first line of `output` (the state machine stores `exit <code>` there), so failures stay short.
- [ ] `findings`: the `findings` argument, copied (not the same array reference).
- [ ] `rework_count`: `max(0, distinctBuildIterations − 1)`, where build iterations are the distinct `iteration` values of `build` node runs.
- [ ] `cost_usd`: sum of `cost_usd` over all node runs, rounded to 4 decimals.
- [ ] `duration_s`: `Math.round((Date.parse(run.ended_at) − Date.parse(run.started_at)) / 1000)`. If `started_at` is null → 0. If `ended_at` is null, use the latest `ended_at` among node runs, else 0. Never negative.
- [ ] `notes`: `''` (the caller fills it).
- [ ] Same input → deeply equal output; the function does not read the clock.

## Implementation Notes

### Files to Modify

| File Path | Action | Description |
|-----------|--------|-------------|
| `factory/src/daemon/retro.ts` | Create | `computeRetro` |
| `factory/src/daemon/retro.test.ts` | Create | Tests |

### Technical Constraints

- Only `import type` from `../shared/types.ts`; no runtime imports needed.
- Erasable syntax only; `.ts` extensions.
- No `Date.now()` / `new Date()` without arguments.

### Relevant Code References

- `docs/prd/sf0-factory-core/specs/scaffold-config-types.md` — `Run`, `NodeRun`, `Retro` interfaces.
- `docs/prd/sf0-factory-core/PRD.md` — `retros` table columns.

### Code Examples

```ts
import type { NodeRun, Retro, Run } from '../shared/types.ts';
export function computeRetro(run: Run, nodeRuns: NodeRun[], findings: string[]): Retro {
  const rows = nodeRuns.filter(n => n.run_id === run.id)
    .sort((a, b) => a.iteration - b.iteration || a.id - b.id);
  // …
}
```

## Testing Requirements

Build rows with a small `nr({...})` helper in the test file.
- [ ] Happy path: build#1, test#1, review#1, pr, merge_gate, merge all completed; costs 0.01 + 0.02 → `rework_count 0`, `failures []`, `cost_usd 0.03`, duration from 60 s apart timestamps = 60.
- [ ] Test failure then retry: build#1 ok, test#1 failed (`exit 1\n…`), build#2, test#2 ok → `failures ['test #1: exit 1']`, `rework_count 1`.
- [ ] Failed build with `output: 'timeout'` → `'build #1: timeout'`; null output → `'build #1: no output'`.
- [ ] Review-only rework (review#1 changes, build#2) → `rework_count 1`, failures empty.
- [ ] Rows from another `run_id` are ignored; shuffled input gives the same result.
- [ ] `ended_at` null falls back to the last node `ended_at`; `started_at` null → 0.
- [ ] Mutating the returned `findings` does not change the argument.

## Out of Scope

- Calling `store.recordRetro`, deciding when the retro runs, or writing the restart hint (sf5 "change loop state machine").
- LLM-written retros and knowledge-edit proposals (umbrella later slices).
- Prompt rendering (sibling "Executor and reviewer prompts").
