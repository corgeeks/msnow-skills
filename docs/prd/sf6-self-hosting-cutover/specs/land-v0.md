# Land v0 on main

## Objective

Get `feat/software-factory` (sf0–sf5 plus the planning docs) onto `origin/main` through a reviewed PR merged with a **merge commit**. Then clean up the branch-only unsigned-commit config and leave the user checkout on an up-to-date `main`.

## Suggested Model

Light: `anthropic/claude-haiku-5-5`. This is a mechanical git and gh runbook with one human gate.

## Context

Executors branch from `origin/main`, and the daemon's `.factory/main` is detached at `origin/main`. Until v0 is on `main`, the factory cannot run on itself: the executor's `npm test --prefix factory` would find no `factory/` directory.

### Parent PRD

- **PRD**: sf6-self-hosting-cutover
- **PRD Path**: `docs/prd/sf6-self-hosting-cutover/PRD.md`

### Related Tasks

- **Depends on**: sf0–sf5, all complete
- **Blocks**: Self-hosted README loop; Extract architecture doc

## Acceptance Criteria

- [ ] `npm test --prefix factory` and `npm run typecheck --prefix factory` pass on `feat/software-factory` before you push.
- [ ] `git push -u origin feat/software-factory` succeeds.
- [ ] A PR `feat: software factory v0 (sf0–sf5)` is open against `main`. It is created with `gh pr create --base main --head feat/software-factory --title … --body-file …`. The body summarizes sf0–sf5, how to run the tests, and the unsigned-commit policy, and links `docs/prd/software-factory/PRD.md`.
- [ ] **Human gate**: the human reviews the PR and merges it with a **merge commit**. Do not merge it yourself. Record the PR URL in the log and stop as `blocked: awaiting human merge` until `gh pr view <n> --json state` reports `MERGED`.
- [ ] After the merge:
  - `git config --local --unset includeIf.onbranch:feat/software-factory.path` and `rm .git/unsigned-feature-branch.inc`;
  - `git switch main && git pull --ff-only`;
  - `git config --get commit.gpgsign` prints the user's global value (`true`).
- [ ] `git log --oneline origin/main` shows the merge commit and the per-task history.

## Implementation Notes

### Files to Modify

| File Path | Action | Description |
|-----------|--------|-------------|
| `.git/config` | Edit (local) | Remove the `includeIf.onbranch:feat/software-factory.path` entry |
| `.git/unsigned-feature-branch.inc` | Delete | Branch-scoped `commit.gpgsign=false` |

### Technical Constraints

- Never force-push and never merge the PR yourself.
- Never change the global git config.
- If the push is rejected, stop and report. Do not rebase without asking.

## Testing Requirements

- [ ] The test suite passes before the push.
- [ ] After the merge, `ls factory/src/daemon/main.ts` succeeds on `main`, and `git status` is clean.

## Out of Scope

- Starting the daemon (Self-hosted README loop)
- Any code change
