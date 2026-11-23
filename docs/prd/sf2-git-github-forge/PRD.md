# L1 · sf2 — Git and GitHub forge

> Child of umbrella **software-factory** (`../software-factory/PRD.md`). It builds on the **sf0** contracts (`../sf0-factory-core/PRD.md`). The decisions recorded in the umbrella apply here, in particular the daemon checkout, merge path, push policy, and execution facts.

## Objective

Own every git and GitHub operation that touches shared state:

- the daemon's worktree at `.factory/main` (detached at `origin/main`);
- a single FIFO queue that serializes those operations;
- branch pushes;
- the PR lifecycle via `gh`: create, comment, view, squash-merge pinned to a head SHA, and close;
- the debounced **state committer**, which snapshots the live DB into `.factory/main/.factory/factory.db`, commits it, and pushes `HEAD:main`.

**Done when** deterministic tests pass against a local bare `origin` and a **fake `gh`**, covering:
- PR open, comment, merge;
- state commits (debounced and forced);
- a non-fast-forward push retry;
- idempotent setup of `.factory/main`.

## Motivation

The factory's state lives on `main` in a committed binary DB, while its code changes arrive through PRs. Both write to the same branch. If any merge, state commit, or push races another, `main` gets corrupted or loses state. One owner with one queue makes that impossible, and keeps the user's checkout untouched.

## Implementation Details

### Architecture

#### `src/daemon/git.ts`

```ts
export function git(cwd: string, args: string[], o?: { env?: NodeJS.ProcessEnv }): string; // execFileSync, trimmed stdout, throws GitError{stderr, args}
export interface Queue { run<T>(fn: () => Promise<T> | T): Promise<T> }               // strict FIFO, one at a time; a failing job doesn't stall the queue
export function createQueue(): Queue;
```

Daemon commits use the identity `-c user.name=factory -c user.email=factory@localhost`.

#### `src/daemon/forge.ts`

```ts
export interface PrState { number: number; state: 'OPEN' | 'CLOSED' | 'MERGED'; mergeable: string; mergeStateStatus: string; headRefOid: string; checks: number }
export type Forge = ReturnType<typeof createForge>;
// Public forge methods are queued. Inside its own jobs, the forge uses private unqueued helpers;
// a queued job must never await another queued method (the FIFO would deadlock).
export function createForge(o: {
  root: string; mainWorktree: string; queue: Queue; ghCommand?: string[]; // default ['gh']
}): {
  ensureMainWorktree(): Promise<void>; // queued: fetch; if missing `git worktree add --detach <mainWorktree> origin/main`; else syncMain
  fetch(): Promise<void>;              // queued: git fetch origin --prune (run from root)
  syncMain(): Promise<void>;           // queued: fetch + `git -C .factory/main reset --hard origin/main` + clean -fd
  pushBranch(worktreePath: string, branch: string): Promise<void>; // queued: git -C <wt> push --force-with-lease origin <branch>
  openPr(o: { branch: string; title: string; body: string }): Promise<{ number: number; url: string }>;
  commentPr(n: number, body: string): Promise<void>;
  prState(n: number): Promise<PrState>;
  mergePr(n: number, headSha: string): Promise<void>; // queued; gh pr merge n --squash --match-head-commit sha; then poll prState until MERGED (≤30 s) else throw
  closePr(n: number, comment?: string): Promise<void>;
  deleteRemoteBranch(branch: string): Promise<void>; // queued: git push origin --delete <branch>; a missing ref is not an error
};
```

- **gh rules** (from research):
  - Always non-interactive: `--title` plus `--body-file` (a temp file); set `GH_PROMPT_DISABLED=1`.
  - Run from `root`.
  - Address PRs by number, never by branch name.
  - **Never** pass `--delete-branch`. sf5 removes the worktree and branch after the merge is confirmed (cli/cli#14537).
  - `checks` comes from `statusCheckRollup | length` via `gh pr view --json number,state,mergeable,mergeStateStatus,headRefOid,statusCheckRollup`. `gh pr checks` exits 1 when a PR has no checks, so it is not used.
  - `mergeable: UNKNOWN` means GitHub hasn't computed mergeability yet. `prState` retries 5 times, 2 s apart, before returning it.
- The base branch is always `main`, and the repo is resolved by `gh` from the `origin` remote.

#### `src/daemon/state-commit.ts`

```ts
export function createStateCommitter(o: {
  db: DatabaseSync; bus: Bus; queue: Queue; mainWorktree: string;
  prefix: string; debounceSec: number; // config.git.*
}): { flush(reason?: string): Promise<void>; stop(): void };
```

- It subscribes to `bus`. A **milestone** is one of the following events:
  - `run.created`;
  - `run.updated` that changes `status` to `completed`, `failed`, or `cancelled`, or sets `pr_number`;
  - `gate.opened`;
  - `gate.closed`;
  - `retro.recorded`.
- Each milestone adds a short summary (`#<item> run <n> failed`, `#<item> gate opened (merge)`, and so on) to a pending list and (re)arms a `debounceSec` timer. Other events are ignored.
- `flush()` (on timer, or forced by sf5 after a merge) runs one queued job. Inside that job, git runs directly through `git()`; it must not call queued forge methods.
  1. Sync: `git fetch origin --prune`, then in `.factory/main` run `reset --hard origin/main` and `clean -fd`.
  2. `snapshot(db, <mainWorktree>/.factory/factory.db)`.
  3. `git add .factory/factory.db`.
  4. If nothing is staged, stop.
  5. `git commit -m "<prefix> (<summaries joined by ', '>)"`, truncating the summary to 200 characters with `…`.
  6. `git push origin HEAD:main`.
  - If the push is rejected as non-fast-forward, re-run the sync from step 1 and repeat steps 2–6 once. A second failure is logged to stderr and the pending summaries are kept for the next flush. `flush()` never rejects.
- Before committing, it verifies the snapshot opens and `PRAGMA integrity_check` returns `ok`.

#### Test fakes (owned by this slice; reused by sf5)

`factory/test/fakes/fake-gh.ts` is a Node script that implements `pr create`, `pr comment`, `pr view --json …`, `pr merge … --squash --match-head-commit`, and `pr close` against a bare repo given in `FAKE_GH_REMOTE`. PR state is kept in a JSON file at `FAKE_GH_STATE`.
- `merge` squash-merges the branch into `main` inside a scratch clone, pushes to the bare remote, and records `MERGED`.
- A SHA mismatch fails with exit 1, the way real `gh` does.
- `statusCheckRollup` is always `[]`.

### Constraints

- Only `node:*` imports. No dependencies.
- Every operation that writes `.factory/main`, fetches, merges, or pushes goes through the one `Queue`. Executors never push. sf5 calls `pushBranch`.
- The user's checkout is never modified: no checkout, reset, or commit at `root`. The only things that run at `root` are `fetch`, `worktree` admin commands, and `gh`.
- `.factory/main` stays detached, because the user's checkout normally has `main` checked out and a branch can be checked out in only one worktree.
- Tests are offline. They use a temp bare repo as `origin`, a temp "user" clone as `root`, and `fake-gh`.

### Relevant Guides

- Umbrella: Git topology, Execution facts (gh and git bullets)
- `../software-factory/research.yaml`: answers on gh's non-interactive PR flow, git worktrees, and SQLite committed to git
- https://cli.github.com/manual/gh_pr_merge
- https://cli.github.com/manual/gh_pr_view
- https://git-scm.com/docs/git-worktree

### Relevant Files

- `factory/src/daemon/git.ts`, `forge.ts`, `state-commit.ts` - (Create)
- `factory/src/daemon/{git,forge,state-commit}.test.ts` - (Create)
- `factory/test/fakes/fake-gh.ts` - (Create)
- `factory/test/fixtures/git-repos.ts` - (Create) `makeRepos()`: a temp bare `origin`, a user clone as `root`, and an initial commit on `main`. The forge and committer tests share it, and sf5 reuses it.
- `factory/src/daemon/main.ts` - (Edit) create the queue, forge, and committer; call `ensureMainWorktree()` at startup; register `committer.flush('shutdown')` + `stop()` via `onShutdown`
- `factory/src/daemon/db.ts` - (Review) `snapshot()`

## Discussion

### DB commit cadence

_Commit at milestones with a debounce, only after merges or gate decisions, or at every milestone?_

At milestones, with a 60 s debounce, and immediately after a merge. The message prefix is `factory: state`.
