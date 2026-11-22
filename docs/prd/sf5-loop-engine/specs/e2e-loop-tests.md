# End-to-end loop tests

## Objective

Write `factory/src/daemon/e2e.test.ts`: six offline, deterministic scenarios that run the real store, bus, HTTP API, forge, state committer, worktrees, engine, and `runChange` together against a bare local `origin`, `fake-omp`, and `fake-gh`, and prove the PRD's "Done when" end to end.

## Suggested Model

Heavy: `anthropic/claude-opus-5-5` — multi-process git fixtures, async event-driven assertions, and a mid-run restart.

## Context

Each sibling has unit tests; this task proves they compose. Any real defect found in engine/state-machine code is fixed in this task (it owns no other files); spec deviations are reported, not papered over in tests.

### Parent PRD

- **PRD**: sf5-loop-engine
- **PRD Path**: `docs/prd/sf5-loop-engine/PRD.md`. "Done when" and "Constraints" (offline tests) are normative.

### Related Tasks

- **Depends on**: "change loop state machine" (`runChange`, `ChangeContext.runSession`, `stopped`), "Engine scheduler, recovery, and wiring" (`createEngine(deps)`, `start`, `stop`, `tickMs`); sf1 `runSession` (`SessionOptions.command`, `graceMs`, `killAllSessions`) and `factory/test/fakes/fake-omp.ts` (scenarios `complete`, `edit`, `hang`, …; env `FAKE_OMP_SCENARIO`, `FAKE_OMP_TEXT`, `FAKE_OMP_EDIT`, `FAKE_OMP_TOOLS`, `FAKE_OMP_ARGV_FILE`); sf2 `factory/test/fixtures/git-repos.ts` `makeRepos()`, `factory/test/fakes/fake-gh.ts` (`FAKE_GH_REMOTE`, `FAKE_GH_STATE`), `createForge({ghCommand})`, `createStateCommitter`; sf0 `createApiServer`, `createStore`, `openDb`.
- **Blocks**: sf6 (self-hosting) bootstrap.

## Acceptance Criteria

- [ ] `e2e.test.ts` contains the six scenarios below; all pass under `npm test --prefix factory` with no network and no real `omp`/`gh`.
- [ ] A shared `setupFactory(t, opts)` helper (in `factory/test/e2e-harness.ts`) builds per test:
  - `makeRepos()` (bare origin, user clone as `root`, initial commit on `main`); the harness then commits `factory/README.md` and a passing `test.sh` from a scratch clone and pushes to `main`, then `git -C root pull`;
  - `paths` for `root`; `openDb(paths.liveDb)`, store, bus;
  - forge with `ghCommand: ['node', <abs fake-gh.ts>]`, env `FAKE_GH_REMOTE=<origin>`, `FAKE_GH_STATE=<tmp>/gh.json`, `GH_PROMPT_DISABLED=1`;
  - committer with `debounceSec` 3600 (only forced flushes commit);
  - config: defaults with `loop.maxParallel 1`, `caps.sessionMinutes 1`, `defaultTestCmd: 'sh test.sh'`;
  - engine with a recording `runSession` wrapper and `tickMs: 50`; `createApiServer` listening on `127.0.0.1:0`.
  - **Per-session fake behaviour**: the wrapper calls sf1's `runSession(prompt, {...opts, command: ['env', ...vars, 'node', <abs fake-omp.ts>], graceMs: {ready: 2000, exit: 500, abort: 500}})`, where `vars` (`FAKE_OMP_SCENARIO=…`, `FAKE_OMP_TEXT=…`, `FAKE_OMP_EDIT=…`) come from the scenario's `script(call)` function, given `{role: 'build' | 'review', n}` (role from whether `opts.model` is the executor or the reviewer model; `n` = 1-based count per role). The wrapper pushes `{role, n, prompt}` to `f.prompts` for prompt assertions. `process.env` is never mutated.
- [ ] Waiting uses a `waitFor(pred, timeoutMs = 15000)` poll on the store (50 ms); no fixed sleeps.
- [ ] Gates are decided over HTTP: `POST /api/gates/:id/decision` with `{decision, note?}` → 200.
- [ ] Cleanup: `engine.stop()`, server close, DB close, temp dir removed, in `t.after`.

### Scenarios

Default script: builder `edit` with `FAKE_OMP_EDIT='echo x > factory/feature-<n>.txt && git add -A && git commit -qm feat'`; reviewer `complete` with `FAKE_OMP_TEXT` = a fenced `json` block `{"verdict":"approve","findings":[]}`. `test.sh` failure is driven by marker files in the temp dir.

1. **Happy path to merged**: create item (`test_cmd` null) and transition `ready→queued`.
   - Assert: merge gate opens (`kind 'merge'`, question `Merge PR #1 for #<id> <title>?`); run `paused`; approve over HTTP.
   - Then: item `done`; run `completed` with `pr_number`, non-empty `pr_url` (equal to fake-gh's returned URL), `head_sha`, `ended_at`; node runs build/test/review/pr/merge_gate/merge all `completed` at iteration 1; `git ls-tree origin/main` contains `factory/feature-1.txt`; worktree dir `<root>/.factory/worktrees/<id>-1` gone, `git branch --list factory/<id>-1` empty in `root`, `git ls-remote origin factory/<id>-1` empty; retro row with `rework_count 0`, `failures []`; `git log origin/main --format=%s` contains a subject starting `factory: state`; `fake-gh` state shows the PR `MERGED`; retro `notes` contains the restart hint (the change touched `factory/`).
2. **Test failure then retry**: `test.sh` fails while `$T/fail-once` exists and deletes it.
   - Assert: build#1 completed, test#1 failed with output starting `exit 1`, build#2 and test#2 completed; `f.prompts` build `n=2` contains the test#1 output; after approve: retro `rework_count 1`, `failures ['test #1: exit 1']`.
3. **Review changes then rework**: reviewer `n=1` returns verdict `changes` with finding `"rename x"`, `n=2` approves.
   - Assert: review#1 output verdict `changes`, build#2 exists, review#2 `approve`; PR opened once; retro `findings` contains `rename x`.
4. **Exhausted failure gate**: `test.sh` exits 1 while `$T/fail` exists.
   - Assert: 3 build/test iterations, then a `failure` gate opens (node `test`); item `blocked`, run `paused`. Reject over HTTP → item `cancelled`, run `failed`, worktree directory **still exists**, no PR in fake-gh state, retro row with 3 failures. Sub-case: approve with note `"try harder"` after removing `$T/fail` → build#4 runs in the **same** worktree path, `f.prompts` build `n=4` contains `try harder`, and the run reaches the merge gate.
5. **Merge-gate reject**: as scenario 1 up to the merge gate, then reject with note `"wrong approach"`.
   - Assert: fake-gh PR `CLOSED`; run `cancelled`; item `ready`; worktree and local/remote branch gone; `origin/main` lacks `factory/feature-1.txt`; retro row exists.
6. **Restart mid-run**: builder `n=1` uses scenario `hang`, later builds use the default `edit`.
   - Wait for the build node run `running`; run the real shutdown order `await engine.stop()` then `killAllSessions()` (simulates daemon shutdown); wait until the hung fake exits; mark nothing by hand. Create a **new** engine on the same DB/root and `start()`.
   - Assert: build#1 row was set `failed` with `interrupted by daemon restart` then re-run in place and `completed` (same iteration 1, no build#2); the resumed prompt contained the resume section; the run reaches the merge gate; approve → item `done`.

## Implementation Notes

### Files to Modify

| File Path | Action | Description |
|-----------|--------|-------------|
| `factory/src/daemon/e2e.test.ts` | Create | Six scenarios |
| `factory/test/e2e-harness.ts` | Create | `setupFactory`, `waitFor`, git helpers |

### Technical Constraints

- `node:test` + `node:assert/strict`; temp dirs via `fs.mkdtempSync`; port 0; only `node:*` imports.
- Git commands in tests use `execFileSync('git', …)` with `-c user.name=t -c user.email=t@t`.
- Tests run sequentially within the file (`{ concurrency: 1 }`): each test has its own temp dir and port, but `killAllSessions` is process-global.
- No test-only branches in production code; if a scenario needs an injection point that does not exist, report it.
- Prompt content (gate note, failure output, resume section) is asserted from `f.prompts`, never by inspecting fake-omp internals.

### Relevant Code References

- `docs/prd/sf1-session-runner/PRD.md` — fake-omp scenarios.
- `docs/prd/sf2-git-github-forge/PRD.md` — fake-gh env and behaviour, committer flush steps.
- `docs/prd/sf0-factory-core/PRD.md` — HTTP gate decision endpoint.
- `docs/prd/sf5-loop-engine/specs/change-state-machine.md` — node outputs and rules asserted here.

### Code Examples

```ts
test('happy path to merged', async t => {
  const f = await setupFactory(t, { edit: 'echo x > factory/feature-1.txt && git add -A && git commit -qm feat' });
  const item = f.store.createItem({ title: 'add feature', body: 'b' });
  f.store.transitionItem(item.id, 'draft', 'ready'); f.store.transitionItem(item.id, 'ready', 'queued');
  const gate = await f.waitFor(() => f.store.listGates({ open: true })[0]);
  await f.decide(gate.id, 'approve');
  await f.waitFor(() => f.store.getItem(item.id).status === 'done');
});
```

## Testing Requirements

- [ ] All six scenarios pass three runs in a row (`node --test --test-concurrency=1 src/daemon/e2e.test.ts`) with no flakes.
- [ ] The full suite runtime of this file stays under 60 s.
- [ ] No files are left in the OS temp dir after the run.

## Out of Scope

- Unit-level coverage of `nextStep`, engine dispatch, prompts, retro (owned by siblings).
- Changes to fake-omp/fake-gh behaviour (sf1/sf2); request them from their owners.
- Live `omp`/GitHub tests; UI; CLI (`factory start` is simulated via store transitions).
