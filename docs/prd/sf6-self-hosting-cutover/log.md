# Implementation Log

## 2026-11-23 - Land v0 on main

**Status**: Completed

**Summary**: The human merged PR #5 with a merge commit (`9e06241`, two parents), so the per-task history is on `main`.

**Changes Made**:
- Removed `includeIf.onbranch:feat/software-factory.path` from `.git/config` and deleted `.git/unsigned-feature-branch.inc`. `commit.gpgsign` resolves to `true` again.
- Fast-forwarded local `main` with `git fetch origin main:main`, then switched to it. `factory/` is present.

---

## 2026-11-22T20:00:00 - Extract architecture doc

**Status**: Completed

**Summary**: Wrote `docs/factory/architecture.md` (448 lines, 9 sections, 40 ADR entries D-01..D-40) from the umbrella and sf0–sf6 PRDs and logs, verified against the code.

**Changes Made**:
- `docs/factory/architecture.md` - Created: living design doc and decision log

**Notes**:
- Checked against code: every `work_items`/`item_deps`/`runs`/`node_runs`/`gates`/`events`/`retros`/`meta` column vs `db.ts` MIGRATIONS[0]; every enum vs `shared/types.ts`; loop rules, budgets, gates, recovery, containment vs `template-change.ts`/`engine.ts`; RPC/flags vs `omp.ts`; gh vs `forge.ts`; commit flow + retry regex vs `state-commit.ts`/`git.ts`; config defaults vs `config.ts`; startup/shutdown order vs `main.ts`/`lifecycle.ts`; routes, 413, `?after=` vs `http.ts`; CLI exit codes vs `cli/main.ts`.
- PRD vs code disagreements (code wins): `meta` is key/value, not `meta(schema_version)`; `node_runs` and `gates` have `id` PKs; `work_items.priority` and `runs.pr_url` added; `events.seq` AUTOINCREMENT; `queued` item status; `NodeStatus.skipped` unused; sf2 log says `ensureMainWorktree` runs before the instance lock, but `main.ts` now takes the lock first; failure-gate approve raises limits multiplicatively (limit × (1+approvals)), not reset; no systemd unit is shipped; SSE replay query param is `after`.
- Deviation: commit/push criterion not done; the orchestrator commits after the v0 PR merges. README untouched. `grep docs/prd` on the doc returns nothing.

---

## 2026-11-22 - Land v0 on main

**Status**: In Progress (blocked: awaiting human merge)

**Done so far**:
- Tests (109 pass, 1 skipped) and typecheck are clean on `feat/software-factory`.
- Pushed `feat/software-factory` and opened PR #5: https://github.com/corgeeks/msnow-skills/pull/5

**Resume from**: once `gh pr view 5 --json state` reports `MERGED` (merge commit), remove `includeIf.onbranch:feat/software-factory.path` from `.git/config`, delete `.git/unsigned-feature-branch.inc`, then `git switch main && git pull --ff-only`, and verify `git config --get commit.gpgsign` is `true`.

---
