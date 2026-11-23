# Self-hosted README loop

## Objective

Prove the bootstrap. The factory daemon, running on this repository, takes one real work item through the full `change` loop and merges it to `main`. The item is "Document the factory in README.md". Every node runs for real, every artifact is verified, and every problem the run finds is recorded.

## Suggested Model

Standard: `anthropic/claude-sonnet-5-5`. This task operates and observes a live system, waits on a human gate, and diagnoses any failures. (The executor *inside* the factory runs as `light`.)

## Context

This is the acceptance test of the whole software-factory program: "use software-factory to make changes to software-factory". The loop is the v0 `change` template (sf5): build (omp executor) → test (`npm test --prefix factory`) → review (`openai-codex/gpt-6.2-sol`) → PR → merge gate (human) → `gh pr merge --squash` → retro, with a `factory: state` commit on `main`.

### Parent PRD

- **PRD**: sf6-self-hosting-cutover
- **PRD Path**: `docs/prd/sf6-self-hosting-cutover/PRD.md`. The "Self-hosted loop runbook" section and the README item body are normative.

### Related Tasks

- **Depends on**: Land v0 on main
- **Blocks**: Import program and retire docs/prd
- **Runs in parallel with**: Extract architecture doc. It edits only `docs/factory/architecture.md`, so it can't conflict with the README PR.

## Acceptance Criteria

- [ ] The user checkout is on an up-to-date `main`, and `npm run build:ui --prefix factory` succeeds.
- [ ] The daemon is started from the repo root with `node factory/src/daemon/main.ts` as a long-lived service, and prints `factory daemon listening on http://127.0.0.1:7317`. `.factory/main` exists, detached at `origin/main`.
- [ ] The item is created with `node factory/src/cli/main.ts add --type task --tier light --ready --title "Document the factory in README.md" --body "<the README item body from the PRD, verbatim>"`, then `start <id>`.
- [ ] Nodes progress in order: build → test → review → pr. The run's `pr_url` points to a PR on `corgeeks/msnow-skills` whose diff touches only `README.md`.
- [ ] **Human gate**: the merge gate opens. Report the gate id and PR URL and stop as `blocked: awaiting merge-gate decision`. The human runs `factory approve <gate-id>`, or `reject` with a note. On reject, or on a failure gate, record the reason and resume once the human has decided. The task completes only when an item reaches `done` through a real merge.
- [ ] Verified after the merge:
  - the item is `done`;
  - the run is `completed` with `pr_number`, `pr_url`, and `head_sha`;
  - the `retros` row has a non-negative `cost_usd`;
  - `git log origin/main` has the squash commit and a `factory: state (…)` commit;
  - `.factory/worktrees/` has no entry for the item;
  - the remote branch `factory/<id>-<n>` is deleted;
  - the user checkout's working tree was untouched during the run.
- [ ] A short "First self-hosted run" section in the sf6 log records the timings, the per-node cost, the total cost, the review verdict, and every anomaly (anything surprising, even if it didn't block). These become L4 bug items later.
- [ ] The daemon stays running for the Import task, or is stopped with SIGTERM and restarted there.

## Implementation Notes

### Technical Constraints

- Do not edit factory code during this task. If the loop hits a bug, stop, record it, and ask the human whether to fix it by hand on `main` (restarting the daemon afterwards) or to retry.
- Do not approve gates yourself.
- The daemon owns `.factory/main`. Never touch it by hand.

### Relevant Code References

- `factory/src/cli/main.ts`: CLI usage
- `factory/src/daemon/template-change.ts`: node order and gate semantics
- `.factory/config.json`: roles and caps

## Testing Requirements

- [ ] The verification checklist above, run by hand with `factory status`, `factory show <id>`, `GET /api/runs/<id>`, `git log origin/main`, and `git worktree list`.
- [ ] Visual check: the UI at `http://127.0.0.1:7317` shows the item `done`, the run timeline, and the closed gate.

## Out of Scope

- Importing the YAML program and deleting `docs/prd` (Import task)
- Fixing anomalies the run finds (L4 items)
