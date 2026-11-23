# L2 · sf5 — Loop engine

> Child of umbrella **software-factory** (`../software-factory/PRD.md`). Integrates **sf0** (store, bus, config, lifecycle), **sf1** (`runSession`, worktrees, `fake-omp`), and **sf2** (forge, queue, state committer, `fake-gh`). The umbrella's "v0 loop template" section and Execution facts are normative.

## Objective

The scheduler and the hard-coded `change` loop template. Together they turn a `queued` work item into a merged PR, with these steps:

**build** → **test** → **cross-family review** → **PR** → **merge gate** → **merge** → **retro**

This includes:
- attempt and round limits;
- failure gates;
- container roll-up;
- recovery after a daemon restart;
- the executor and reviewer prompts.

**Done when:**
- An end-to-end test drives a queued item through the whole loop. It uses `fake-omp` (scenario `edit`), `fake-gh`, and a bare local `origin`, and approves the merge gate over HTTP. The item ends `done`, the change is on `origin/main`, the worktree and branch are gone, a retro row exists, and a `factory: state` commit is on `origin/main`.
- Failure paths are tested the same way: test failure then retry, review "changes" then rework, an exhausted failure gate, merge-gate reject, and a restart mid-run.

## Motivation

This is the factory's core loop, and the bootstrap milestone: once it works, sf6 can point the factory at its own backlog. Lessons the design takes from prior art:

- **Code decides when work is done** (Archon `until_bash`). A session reporting `completed` is never treated as success.
- **One builder plus one cross-family reviewer** (ai-software-factory's simplification after 140 nodes caused false stops).
- **Human gates only where they matter** (merge, failures).

## Implementation Details

### Architecture

#### Modules

```
src/daemon/
├── engine.ts              # createEngine(deps) → { start(), stop() }: dispatch, recovery, roll-up
├── template-change.ts     # runChange(ctx): the change loop as a re-entrant state machine
├── prompts.ts             # buildExecutorPrompt / buildReviewerPrompt / parseVerdict
├── prompts/executor.md    # ported from skills/prd/agents/prd-worker.md (daemon owns statuses)
├── prompts/reviewer.md
└── retro.ts               # computeRetro(run, nodeRuns, findings) — deterministic, no LLM
```

#### Dispatch (`engine.ts`)

- **Wake-ups**: the engine wakes on bus events (`item.updated`, `gate.closed`, `run.updated`) and on a 5 s interval.
- **Capacity**: `free = config.loop.maxParallel − (count of runs with status 'running')`.
- **For each of the first `free` items from `store.dispatchableItems()`**:
  1. `transitionItem(id, 'queued', 'active')`. A `ConflictError` means another tick took the item; skip it.
  2. `attempt = (max attempt for the item) + 1`.
  3. `forge.fetch()`, then `createWorktree(root, {itemId, attempt, base: 'origin/main'})`.
  4. `createRun({item_id, template: 'change', attempt, branch, worktree, status: 'running'})`.
  5. Launch `runChange(ctx)` without awaiting it, and keep the promise in an in-memory map.
- **Container roll-up**: after any item reaches `done`, `cancelled`, or `blocked`, every ancestor container (an item with children) is recomputed:

  | Children | Container status |
  |---|---|
  | All `done` or `cancelled` | `done` |
  | Any `active`, `queued`, or `blocked` | `active` |
  | Otherwise | Unchanged |

- **Self-hosting note**: after a merge whose diff touches `factory/`, log `daemon code changed on main — restart the daemon to pick it up` and record it in the run's `retro.recorded` event data. The daemon does not restart itself in v0.

#### The `change` state machine (`template-change.ts`)

Each node writes `node_runs` rows: `node` is one of `build`, `test`, `review`, `pr`, `merge_gate`, `merge`, `retro`, and `iteration` starts at 1 and increments on each rework. **The next step is derived from the persisted `node_runs`**, not from in-memory state. That is what makes `runChange` re-entrant after a restart. The nodes in order:

1. **build**
   - Model: `roles.executor[item.tier ?? 'standard']`.
   - Runs `runSession(buildExecutorPrompt(...), {cwd: worktree, timeoutMs: caps.sessionMinutes·60000, maxCostUsd: caps.sessionCostUsd, onActivity: t => bus.publishActivity({run_id, node: 'build', text: t, at})})`.
   - After the session, the daemon runs `commitAll(worktree, "factory: #<id> <title>")` to capture leftover changes.
   - **Success** requires a session status of `completed` and `commitsAhead(worktree, 'origin/main') > 0`.
   - A `timeout`, `cost_cap`, `error`, or `crashed` status, or zero commits ahead, is a failed build. Its `output` stores the reason.
2. **test**
   - The daemon runs `sh -c <item.test_cmd ?? config.defaultTestCmd>` in the worktree, with a 10-minute timeout. It records the exit code and the last 200 lines of output.
   - Exit 0 passes. Anything else fails, and the failure output is fed into the next build prompt.
3. **Build/test loop**: on a build or test failure, the next iteration's build starts, up to `loop.maxBuildAttempts` (3) build iterations in total. When they are exhausted, a **failure gate** opens (see Gates).
4. **review**
   - Model: `roles.reviewer[family(builderModel)]`, where `family` is the provider prefix before `/`, so the reviewer is always from the other model family. A missing mapping is a config error at startup.
   - The reviewer runs with `buildReviewerPrompt` (diff `origin/main...HEAD`, spec, acceptance criteria, test output).
   - `parseVerdict(finalText)` takes the **last** fenced `json` block, shaped `{ "verdict": "approve" | "changes", "findings": string[] }`. An unparseable block counts as `changes`, with finding `"reviewer returned no parseable verdict"`.
   - **Containment**: after the review, if `!isClean(worktree)` or HEAD moved, the daemon runs `resetHard` back to the pre-review SHA and adds the finding `"reviewer modified the worktree (reverted)"`.
   - `changes` starts the next build iteration, with the findings in the prompt. Review rounds are capped at `loop.maxReviewRounds` (2); after that, a **failure gate** opens.
5. **pr**
   - `forge.pushBranch`, then `forge.openPr({title: "#<id> <title>", body})`. The body holds the item body, a spec link, the test summary, and the review verdict.
   - Then `forge.commentPr(n, verdict as markdown)`.
   - The run stores `pr_number`, `pr_url` (from `openPr`), and `head_sha`.
6. **merge_gate**
   - Opens a gate: `kind 'merge'`, question `"Merge PR #<n> for #<id> <title>?"`, recommendation `"approve — tests pass, <reviewer model> approved"`.
   - The run waits in `paused` until the gate closes.
7. **merge**, on approve
   - `forge.mergePr(n, head_sha)`, then `forge.syncMain()`, then `removeWorktree(root, worktree, {deleteBranch: branch})`, then `forge.deleteRemoteBranch(branch)`.
   - Then: item → `done`, run → `completed`, and `committer.flush('merged #<id>')`.
8. **retro**: `computeRetro` produces the following, then `store.recordRetro`:
   - `failures`: the reasons for each failed build or test;
   - `findings`: every review finding;
   - `rework_count`: build iterations − 1;
   - `cost_usd`: the sum over node runs;
   - `duration_s`: from the run's start to its end.

#### Gates

| Gate | Opens when | approve | reject |
|---|---|---|---|
| `merge` | PR opened | Merge (step 7) | `forge.closePr(n, note)`, remove worktree and branch, run → `cancelled`, item → `ready` (the human edits the spec, then runs `factory start` again), retro |
| `failure` | Build or test attempts or review rounds exhausted | **Retry**: new iteration budget in the **same** worktree. The run continues from `build`, and the gate note is appended to the prompt. | Item → `blocked`, then `cancelled` after the decision. Run → `failed`. Worktree **kept** for inspection. Retro. |

While a failure gate is open, the item is `blocked` and the run is `paused`.

#### Restart recovery (`engine.start()`)

1. `pruneWorktrees(root)`.
2. For every run with status `running`, mark any `running` node_run `failed` with output `interrupted by daemon restart`. Then relaunch `runChange` for the run. Because the state machine reads `node_runs`, it resumes at the interrupted node. A resumed build gets the executor prompt's resume section: "a previous session was interrupted; inspect `git log` and the working tree and continue."
3. Runs in `paused` wait for their gate. The `gate.closed` handler resumes them.

#### Prompts (`prompts/*.md`, rendered with simple `{{var}}` substitution)

- **executor.md** is ported from `skills/prd/agents/prd-worker.md`.
  - **Keep**: read the spec, gather context, implement within scope, respect Out of Scope, verify the acceptance criteria, run the tests, commit with clear messages.
  - **Drop**: the status script, log.md checkpoints, and the JSON output format. The daemon owns status, and the transcript is the log.
  - **Inputs**: item title and body, the spec file contents (if `spec_path`), the parent PRD path, the test command, the iteration number, the previous failure output and review findings, and a resume flag.
- **reviewer.md**: review the diff against the spec's acceptance criteria and Out of Scope; run the tests if useful. **Do not modify files.** End with exactly one fenced `json` verdict block.

### Constraints

- Only `node:*` imports.
- Every state change goes through store CAS transitions. A `ConflictError` is logged and the current step is abandoned. It is never retried blindly.
- Exactly one `runChange` per run per process, guarded by the in-memory map.
- The engine never runs `gh`, and never spawns `git` itself. It uses sf1's `worktrees`, sf2's `forge` and `queue`, and sf2's `git()` helper. `git()` is used only for read-only diffs (`origin/main...HEAD`, the `touches factory/` check) and for the reviewer-containment `reset --hard <preSha>`. The test command runs through `sh -c` in the worktree.
- **Clarifications settled while writing the specs:**
  - `loop.maxBuildAttempts` counts only failed builds and failed tests. Review rework is counted separately against `loop.maxReviewRounds`. Approving a failure gate raises both limits; it does not reset the counters.
  - A node interrupted by a restart re-runs in its existing `node_runs` row (`failed → running`). The interruption does not cost a build attempt.
  - Dispatch skips any item that has children: containers are only ever rolled up.
  - The self-hosting restart hint is computed in `runChange`, before the worktree is removed. It is stored as `touches_factory` in the merge node's output and written to the retro `notes`, so it appears in the `retro.recorded` event data. `computeRetro`'s caller supplies `notes`.
  - After `engine.stop()`, `runChange` stops writing state (`ctx.stopped()`). Sessions killed during shutdown are therefore re-run on restart, not counted as failed builds. `engine.stop()` does not wait for in-flight runs.
- Tests are offline and deterministic. They use `fake-omp`, `fake-gh`, a bare `origin`, and a temp clone as `root`.
- Wiring goes into `main.ts`. Startup order:
  1. Validate the reviewer mapping.
  2. `forge.ensureMainWorktree()`. sf2 already wires this into `main.ts`; do not add a second call, only keep it before `engine.start()`.
  3. The committer, created by sf2's wiring, exists.
  4. `engine.start()`.

  - **Shutdown** must run in this order: `engine.stop()` (stop dispatching), then `killAllSessions()`, then the committer's `stop()` and `flush('shutdown')`. Hooks run in reverse registration order, so `main.ts` registers them in this order: committer hook, then `killAllSessions`, then `engine.stop`. sf5 reorders the existing `onShutdown` lines in `main.ts` if needed.

### Relevant Guides

- Umbrella: the v0 loop template diagram and Execution facts
- sf0 PRD: the schema, statuses, and store API. sf1 PRD: `runSession`, worktrees, fake-omp. sf2 PRD: forge, committer, fake-gh.
- `skills/prd/agents/prd-worker.md`: the source of the executor prompt
- `skills/prd/workflows/WorkPRD.md`: resume-first semantics, mirrored by restart recovery
- Archon state model (reference): https://github.com/coleam00/Archon/blob/dev/packages/workflows/src/schemas/node-state.ts

### Relevant Files

- `factory/src/daemon/{engine,template-change,prompts,retro}.ts` - (Create)
- `factory/src/daemon/prompts/{executor,reviewer}.md` - (Create)
- `factory/src/daemon/{engine,template-change,prompts,retro}.test.ts` - (Create)
- `factory/src/daemon/e2e.test.ts` - (Create) the full-loop tests
- `factory/src/daemon/main.ts` - (Edit) engine wiring
- `skills/prd/agents/prd-worker.md` - (Review)

## Discussion

### Dispatch policy and parallelism

_When does a ready item start, and how many executors may run at once?_

Explicit start: `factory start` marks items `queued`, and the engine then dispatches them as their dependencies finish. At most 2 executors run in parallel (`loop.maxParallel`).

### Self-modification

_The factory's first target is itself. Should the daemon restart itself when merged changes touch `factory/`?_

v0 default: no. It logs a restart hint and records it in the retro. Auto-restart is deferred to the v1 backlog if it proves necessary.
