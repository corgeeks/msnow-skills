# change loop state machine

## Objective

Implement `template-change.ts`: `runChange(ctx)` drives one `change` run through **build → test → review → pr → merge_gate → merge → retro**, with build/review limits, failure and merge gates, reviewer containment, and activity forwarding. It is **re-entrant**: every call derives the next step from persisted `node_runs`, `gates`, and the run row, so the engine can call it again after a restart or a gate decision and it continues where it stopped.

## Suggested Model

Heavy: `anthropic/claude-opus-5-5` — a persisted, re-entrant state machine with CAS transitions, gate semantics, and crash-resume edge cases.

## Context

The engine (sibling "Engine scheduler, recovery, and wiring") creates the run (status `running`, `branch`, `worktree` set, item already `active`) and launches `runChange` without awaiting it. It relaunches `runChange` after restart recovery and on `gate.closed`. `runChange` returns when the run is terminal or waiting on an open gate.

### Parent PRD

- **PRD**: sf5-loop-engine
- **PRD Path**: `docs/prd/sf5-loop-engine/PRD.md`. "The `change` state machine", "Gates", and "Constraints" are normative; umbrella "v0 loop template" too.

### Related Tasks

- **Depends on**:
  - "Executor and reviewer prompts": `buildExecutorPrompt(v: ExecutorVars)`, `buildReviewerPrompt(v: ReviewerVars)`, `parseVerdict(finalText): Verdict`, `NO_VERDICT_FINDING`.
  - "Retro computation": `computeRetro(run, nodeRuns, findings): Retro`.
  - sf0 "SQLite database and store" (store API, `ConflictError`, `bus.publishActivity`).
  - sf1 "omp RPC session runner and fake" (`runSession`, `SessionOutcome`, `fake-omp`), "Worktree manager" (`commitAll`, `commitsAhead`, `headSha`, `isClean`, `resetHard`, `removeWorktree`).
  - sf2 "GitHub forge and fake gh" (forge), "Debounced state committer" (`committer.flush`), "Git exec helper and queue" (`git()`).
- **Blocks**: "Engine scheduler, recovery, and wiring" (calls `runChange(ctx)` with a `ChangeContext`); "End-to-end loop tests".

## Acceptance Criteria

**Derivation (`nextStep`)**
- [ ] A pure exported `nextStep(s: { run: Run; nodeRuns: NodeRun[]; gates: Gate[]; retro: boolean; config: Config }): Step` decides the step; `runChange` loops `load → nextStep → execute` until the step is `wait` or `done`. No step state is kept in memory between iterations.
- [ ] Rules, first match wins (`it` = highest `build` iteration, 0 if none; `latestGate` = gate with max id):
  1. A node run with `status 'failed'` and `output === INTERRUPTED` (`'interrupted by daemon restart'`) → re-run **that row in place** (`transitionNodeRun(id,'failed','running')`, same iteration); a build re-run passes `resume: true`.
  2. Run `completed`/`cancelled`/`failed`: `retro` if no retro row, else `done`.
  3. `latestGate` open → `wait` (ensure run `paused`; return).
  4. `merge` node run completed → finalize (`item → done`, `run → completed`) if not yet, then `retro`.
  5. `merge_gate` node run `running`: no gate for node `merge_gate` → `open_merge_gate`; gate closed `approve` → `merge`; `reject` → `merge_reject`. `merge_gate` completed and `merge` not completed → `merge`.
  6. `pr` completed → `merge_gate`. `review` approve at iteration `it` (and no `pr` row) → `pr`.
  7. `latestGate` is a closed `failure` gate with `reject` → `failure_reject`.
  8. `it === 0` → `build(1)`. build `it` completed, no test `it` → `test(it)`. test `it` passed, no review `it` → `review(it)`.
  9. build `it` failed or test `it` failed: if `failedBuilds >= maxBuildAttempts × (1 + approvedFailureGates(node ∈ build,test))` → `open_failure_gate(node)`; else `build(it+1)`.
  10. review `it` verdict `changes`: if `reviewChanges >= maxReviewRounds × (1 + approvedFailureGates(node = review))` → `open_failure_gate('review')`; else `build(it+1)`.
- [ ] `failedBuilds` counts build iterations whose build or test row is `failed`; review reworks do not consume build attempts. Approving a failure gate grants a fresh budget (the counts are cumulative, the thresholds grow), and the iteration number keeps increasing.

**Nodes** (each creates `node_runs` row `{node, iteration, status:'running', model?}`, then sets `status`, `output`, `cost_usd`, `session_file`, `ended_at` via `updateNodeRun`/`transitionNodeRun`)
- [ ] **build**: model `config.roles.executor[item.tier ?? 'standard']`; `ctx.runSession(buildExecutorPrompt(vars), {cwd: run.worktree, model, sessionDir: paths.sessionsDir, timeoutMs: caps.sessionMinutes*60000, maxCostUsd: caps.sessionCostUsd, onActivity})`; then `commitAll(worktree, "factory: #<id> <title>")`. **Success** iff `outcome.status === 'completed'` and `commitsAhead(worktree,'origin/main') > 0`. Failure `output`: the status (`timeout`, `cost_cap`, `error: <msg>`, `crashed: <msg>`, `aborted`) or `no commits ahead of origin/main`.
- [ ] **test**: `sh -c <item.test_cmd ?? config.defaultTestCmd>` in the worktree via async `spawn` (stdout+stderr in arrival order), 10-minute timeout (kill → treated as failure `exit timeout`). `output` = `exit <code>\n<last 200 lines>`. Exit 0 → completed; else failed.
- [ ] **review**: model `config.roles.reviewer[family(builderModel)]` (`family` = text before the first `/`). `preSha = headSha(worktree)` is stored in the row's `output` as `{"pre_sha": …}` at creation. Prompt vars: diff `git(worktree, ['diff','origin/main...HEAD'])`, spec, test output of test `it`. After the session: `parseVerdict(finalText)`; **containment**: if `!isClean(worktree) || headSha(worktree) !== preSha` → `git(worktree,['reset','--hard',preSha])`, `resetHard(worktree)`, append finding `'reviewer modified the worktree (reverted)'`. Row `output` = JSON `{pre_sha, verdict, findings}`; status `completed` for both verdicts (the verdict, not the status, drives rework). A non-`completed` session → verdict `changes` with finding `reviewer session <status>`. An interrupted review re-run first applies containment against the stored `pre_sha`.
- [ ] **pr**: `forge.pushBranch(worktree, branch)`; if `run.pr_number` is null, `forge.openPr({branch, title: "#<id> <title>", body})` and `updateRun({pr_number: number, pr_url: url, head_sha: headSha(worktree)})`; `forge.commentPr(n, verdictMarkdown)`. Body (markdown): item body; `Spec: <spec_path>` (omitted if null); `## Tests` with `<test_cmd>` and `exit 0` plus the last 20 output lines in a fence; `## Review` with reviewer model, verdict, findings bullets.
- [ ] **merge_gate**: row `running`, `openGate({run_id, node:'merge_gate', kind:'merge', question:"Merge PR #<n> for #<id> <title>?", recommendation:"approve — tests pass, <reviewer model> approved"})`, `transitionRun(running→paused)`, return.
- [ ] **merge** (after approve: `transitionRun(paused→running)`, merge_gate row → completed): capture `touches_factory` = `git(worktree,['diff','--name-only','origin/main...HEAD'])` has a line starting `factory/` (before anything is removed); if `forge.prState(n).state !== 'MERGED'` then `forge.mergePr(n, run.head_sha)`; `forge.syncMain()`; `removeWorktree(paths.root, worktree, {deleteBranch: branch})`; `forge.deleteRemoteBranch(branch)`; merge row completed with `output` JSON `{touches_factory}`; `transitionItem(active→done)`; `transitionRun(running→completed)` + `ended_at`; `committer.flush('merged #<id>')`. An interrupted merge re-run whose worktree is already gone reads `touches_factory` as `false`.
- [ ] **retro**: collect findings from all review rows in order, `computeRetro`, and when the merge row's `touches_factory` is true set `notes` to `'daemon code changed on main — restart the daemon to pick it up'` and `console.log` the same line; `store.recordRetro` (its `retro.recorded` event data carries `notes`).

**Gates**
- [ ] `open_failure_gate(node)`: `openGate({kind:'failure', node, question:"#<id> <title>: <node> failed <n> times. Retry?", recommendation:"reject — inspect worktree <path>"})`, item `active→blocked`, run `running→paused`.
- [ ] Failure **approve** (on resume): item `blocked→active`, run `paused→running`, continue with `build(it+1)`; the gate `note` goes into the executor prompt `gate_note`. **reject**: item `blocked→cancelled`, run `paused→failed` + `ended_at`, worktree and branch **kept**, retro.
- [ ] Merge **reject**: `forge.closePr(n, note)`, `removeWorktree(root, worktree, {deleteBranch: branch})`, `forge.deleteRemoteBranch(branch)`, merge_gate row failed, run `paused→cancelled` + `ended_at`, item `active→ready`, retro.

**Cross-cutting**
- [ ] `onActivity` forwards every line as `bus.publishActivity({run_id, node, text, at: new Date().toISOString()})` for `build` and `review`; nothing is persisted.
- [ ] Every status change uses store CAS. A `ConflictError` is logged with run id and step, and `runChange` returns (no retry). Any other thrown error marks the current node run `failed` with the message and returns, leaving the run `running` for the engine's next restart (logged).
- [ ] Run `cost_usd` is updated to the node-run sum after every session.
- [ ] **Shutdown**: after every awaited session/test/forge call, if `ctx.stopped()` is true, `runChange` returns **without writing** (the node run stays `running`, so restart recovery marks it interrupted and re-runs it in place instead of burning an attempt on a `crashed` outcome caused by `killAllSessions`).
- [ ] Sessions go only through `ctx.runSession(prompt, opts)`. The engine passes sf1's `runSession`; tests pass a wrapper that can vary `opts.command` (e.g. `['env', 'FAKE_OMP_SCENARIO=…', 'node', fakeOmp]`), add small `opts.graceMs`, and record prompts.

## Implementation Notes

### Files to Modify

| File Path | Action | Description |
|-----------|--------|-------------|
| `factory/src/daemon/template-change.ts` | Create | `ChangeContext`, `nextStep`, `runChange` |
| `factory/src/daemon/template-change.test.ts` | Create | Tests |

### Technical Constraints

- Only `node:*` runtime imports plus sibling `.ts` modules; `import type` for types; erasable syntax.
- No direct `git`/`gh` spawning: use `ctx.worktrees`, `ctx.forge`, and sf2's `git()` for the two read-only diff calls and the containment reset (see gaps). The only spawned process is `sh -c <test_cmd>`.
- `runChange` must be safe to call on a run in any state; calling it twice sequentially on a finished run is a no-op.

### Relevant Code References

- `docs/prd/sf0-factory-core/specs/sqlite-db-and-store.md` — store methods, `ConflictError`, bus.
- `docs/prd/sf1-session-runner/PRD.md` — `SessionOptions`, `SessionOutcome`, worktree functions, fake-omp scenarios.
- `docs/prd/sf2-git-github-forge/PRD.md` — forge, committer.

### Code Examples

```ts
export interface ChangeContext {
  runId: number; stopped: () => boolean;
  store: Store; bus: Bus; config: Config; paths: Paths;
  runSession: typeof runSession;
  worktrees: Pick<typeof import('./worktrees.ts'), 'commitAll'|'commitsAhead'|'headSha'|'isClean'|'resetHard'|'removeWorktree'>;
  forge: Forge /* sf2: ReturnType<typeof createForge> */; committer: { flush(reason?: string): Promise<void> };
}
export const INTERRUPTED = 'interrupted by daemon restart';
export function nextStep(s: StepInput): Step;
export function runChange(ctx: ChangeContext): Promise<void>;
```

## Testing Requirements

Use `makeRepos()` from `factory/test/fixtures/git-repos.ts` (bare origin, user clone as `root`), a real `createWorktree`, a `runSession` wrapper calling sf1's `runSession` with `command: ['env', <scenario vars>, 'node', <abs fake-omp.ts>]` and `graceMs: {ready: 2000, exit: 500, abort: 500}`, and a recording fake forge/committer (`factory/test/fakes/` helpers allowed).
- [ ] `nextStep` table tests for each rule above, including: 3 failed builds → failure gate; approved failure gate → `build(4)`; 2 `changes` reviews with `maxReviewRounds 2` → failure gate; review rework does not consume build budget; interrupted row → in-place re-run with resume.
- [ ] build with fake-omp `complete` and no edit → build failed `no commits ahead of origin/main`; with `edit` → completed.
- [ ] `test_cmd: 'exit 1'` → output starts `exit 1`; the next build prompt contains it.
- [ ] Reviewer `edit` scenario writing a file and committing → HEAD back at pre-SHA, worktree clean, finding `reviewer modified the worktree (reverted)` present; the parsed verdict itself is unchanged.
- [ ] Merge gate open → run `paused`, `runChange` returns; decide approve → re-call → forge `mergePr` called with `head_sha`, item `done`, worktree dir gone, `committer.flush` called, retro row present.
- [ ] Merge reject → `closePr`, run `cancelled`, item `ready`. Failure reject → item `cancelled`, run `failed`, worktree still exists.
- [ ] Activity lines from fake-omp arrive on `bus.subscribeActivity` with `node 'build'`.
- [ ] A pre-set `ConflictError` (item moved to `cancelled` externally) makes `runChange` return without further writes.

## Out of Scope

- Dispatch, attempt numbering, worktree creation, roll-up, restart marking of interrupted rows, `gate.closed` subscription, `main.ts` (sibling "Engine scheduler, recovery, and wiring").
- Prompt text and verdict parsing ("Executor and reviewer prompts"); retro math ("Retro computation").
- Full multi-module loop tests ("End-to-end loop tests").
- Plan gates, other templates, auto-restart of the daemon (later slices).
