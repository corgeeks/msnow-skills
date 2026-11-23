# GitHub forge and fake gh

## Objective

Create `factory/src/daemon/forge.ts`, the daemon's only owner of shared git/GitHub state:
- the detached worktree `.factory/main` at `origin/main` (create, sync);
- fetch, branch push, and remote branch deletion;
- the PR lifecycle through `gh`: open, comment, view, squash-merge pinned to a head SHA, and close.

Also create `factory/test/fakes/fake-gh.ts`, an offline `gh` stand-in reused by sf5, and the shared repo fixture used by sf2 and sf5 tests.

## Suggested Model

Standard: `anthropic/claude-sonnet-5-5` — mostly command plumbing against a fixed contract; the care points are queue re-entrancy and the fake's merge semantics.

## Context

Code changes reach `main` through PRs while the state committer pushes the DB to the same branch. All of those writes go through one `Queue` so they never race. The user's checkout at `root` is never checked out, reset, or committed; only `fetch`, `worktree` admin, `push --delete`, and `gh` run there.

### Parent PRD

- **PRD**: sf2-git-github-forge
- **PRD Path**: `docs/prd/sf2-git-github-forge/PRD.md`. Architecture → `src/daemon/forge.ts`, gh rules, and Test fakes are normative.

### Related Tasks

- **Depends on**: "Git exec helper and queue" — `git(cwd, args, o?): string`, `GitError{stderr, args}`, `Queue`, `createQueue()`.
- **Parallel sibling**: "Debounced state committer". It does not take a forge; `main.ts` (its task) calls `createForge({ root, mainWorktree, queue })` and `ensureMainWorktree()`. Export `export type Forge = ReturnType<typeof createForge>;` for sf5. The committer imports the fixture `makeRepos()` below.
- **Blocks / cross-slice**: sf5 loop engine calls `fetch`, `pushBranch`, `openPr`, `commentPr`, `prState`, `mergePr`, `syncMain`, `deleteRemoteBranch`, `closePr`, `ensureMainWorktree`, and runs `fake-gh` in its tests. sf0 `resolvePaths()` supplies `root` and `mainWorktree`.

## Acceptance Criteria

**forge.ts** — exports `PrState`, `createForge`, and `Forge`, with this contract verbatim:

```ts
export interface PrState { number: number; state: 'OPEN' | 'CLOSED' | 'MERGED'; mergeable: string; mergeStateStatus: string; headRefOid: string; checks: number }
export function createForge(o: { root: string; mainWorktree: string; queue: Queue; ghCommand?: string[] }): {
  ensureMainWorktree(): Promise<void>; fetch(): Promise<void>; syncMain(): Promise<void>;
  pushBranch(worktreePath: string, branch: string): Promise<void>;
  openPr(o: { branch: string; title: string; body: string }): Promise<{ number: number; url: string }>;
  commentPr(n: number, body: string): Promise<void>; prState(n: number): Promise<PrState>;
  mergePr(n: number, headSha: string): Promise<void>; closePr(n: number, comment?: string): Promise<void>;
  deleteRemoteBranch(branch: string): Promise<void>;
};
```

- [ ] `fetch()` (queued): `git(root, ['fetch', 'origin', '--prune'])`.
- [ ] `syncMain()` (queued): fetch, then in `mainWorktree`: `reset --hard origin/main` and `clean -fd`.
- [ ] `ensureMainWorktree()` (queued): fetch; if `mainWorktree` is not a registered worktree (missing dir), `git(root, ['worktree', 'add', '--detach', mainWorktree, 'origin/main'])`; otherwise sync as above. Calling it twice is a no-op the second time apart from the sync, and HEAD is detached (`git -C .factory/main symbolic-ref -q HEAD` fails).
- [ ] Queued methods call **unqueued private helpers** for fetch/sync internally. Calling a public queued method from inside a queued job would deadlock the FIFO; never do it.
- [ ] `pushBranch(wt, branch)` (queued): `git(wt, ['push', '--force-with-lease', 'origin', branch])`.
- [ ] `deleteRemoteBranch(branch)` (queued): `git(root, ['push', 'origin', '--delete', branch])`; a `GitError` whose stderr matches `/remote ref does not exist/` resolves; other errors propagate.
- [ ] gh rules for every `gh` call:
  - `execFileSync(cmd[0], [...cmd.slice(1), ...args])` with `cwd: root`, `env: { ...process.env, GH_PROMPT_DISABLED: '1' }`, utf8; `cmd = o.ghCommand ?? ['gh']`.
  - Non-zero exit throws an `Error` whose message contains the gh args and stderr.
  - PRs are addressed by number only, never branch name. `--delete-branch` is never passed. Base is always `main`.
  - Bodies/comments go through `--body-file <tmp>` (a file under `fs.mkdtempSync(os.tmpdir())`, removed in `finally`), never inline.
- [ ] `openPr`: `gh pr create --base main --head <branch> --title <title> --body-file <f>`; stdout's last line is the URL; `number` is parsed from `/pull/(\d+)$` (throw if absent).
- [ ] `commentPr`: `gh pr comment <n> --body-file <f>`.
- [ ] `closePr(n, comment?)`: `gh pr close <n>`, plus `--comment <comment>` when given.
- [ ] `prState(n)`: `gh pr view <n> --json number,state,mergeable,mergeStateStatus,headRefOid,statusCheckRollup`; `checks = statusCheckRollup.length`. If `mergeable === 'UNKNOWN'`, retry up to 5 more times, 2 s apart, then return whatever the last view said. `gh pr checks` is never used.
- [ ] `mergePr(n, sha)` (queued): `gh pr merge <n> --squash --match-head-commit <sha>`, then poll `prState(n)` (1 s interval) until `state === 'MERGED'`; if not merged within 30 s, throw. A gh failure (e.g. SHA mismatch) rejects.
- [ ] `prState`, `openPr`, `commentPr`, `closePr` are not queued (they do not touch local refs).

**fake-gh.ts** — `node factory/test/fakes/fake-gh.ts <args>`; env `FAKE_GH_REMOTE` (bare repo path), `FAKE_GH_STATE` (JSON file, created if missing):
- [ ] State shape: `{ next: number, prs: { [n]: { number, branch, title, body, state, comments: string[], unknownViews?: number } } }`.
- [ ] `pr create --base main --head B --title T --body-file F`: fails (exit 1) if `B` is not on the remote (`git ls-remote`); else records `OPEN` PR `next++` and prints `https://github.com/fake/repo/pull/<n>`.
- [ ] `pr comment N --body-file F`: appends the file text to `comments`.
- [ ] `pr view N --json <fields>`: prints JSON with `number`, `state`, `mergeable` (`'UNKNOWN'` while `unknownViews > 0`, decrementing it; else `'MERGEABLE'`), `mergeStateStatus: 'CLEAN'`, `headRefOid` (current remote SHA of `B`, or the recorded SHA once merged/deleted), `statusCheckRollup: []`.
- [ ] `pr merge N --squash --match-head-commit S`: exit 1 with `head commit mismatch` on stderr if `S` ≠ remote `B`; else in a scratch clone of the remote: checkout `main`, `merge --squash origin/B`, commit `"<T> (#N)"` with the factory identity, push `main`, record `MERGED`. The branch is not deleted.
- [ ] `pr close N [--comment C]`: records `CLOSED` (and the comment).
- [ ] Unknown subcommands or flags (including `--delete-branch`) exit 2 with a message on stderr; an unknown PR number exits 1.

**Fixture** — `factory/test/fixtures/git-repos.ts` exports `makeRepos(): { dir, origin, root, mainWorktree }`:
- [ ] `origin` = `git init --bare -b main`; `root` = clone of it with `user.name/email` set, an initial commit (`README.md` plus `.gitignore` listing `.factory/main/` and `.factory/live/`) pushed to `main`; `mainWorktree = <root>/.factory/main` (not created).

## Implementation Notes

### Files to Modify

| File Path | Action | Description |
|-----------|--------|-------------|
| `factory/src/daemon/forge.ts` | Create | Forge as above |
| `factory/src/daemon/forge.test.ts` | Create | Tests below |
| `factory/test/fakes/fake-gh.ts` | Create | Offline gh |
| `factory/test/fixtures/git-repos.ts` | Create | Bare origin + user clone fixture |

### Technical Constraints

- Only `node:*` runtime imports; erasable TS, `.ts` import extensions, `import type`.
- Reuse `git()` from `./git.ts`; do not spawn git another way. Commits in the fake use `-c user.name=factory -c user.email=factory@localhost`.
- Never run `checkout`, `reset`, `commit`, or `merge` with `cwd: root`.
- `ghCommand` in tests: `[process.execPath, '<abs>/factory/test/fakes/fake-gh.ts']`; pass `FAKE_GH_*` via `process.env` set in the test.

### Relevant Code References

- `docs/prd/sf2-git-github-forge/PRD.md`: Architecture (forge, gh rules, Test fakes), Constraints
- `docs/prd/software-factory/PRD.md`: Git topology table, Execution facts (gh and git bullets)
- `docs/prd/software-factory/research.yaml`: gh non-interactive PR flow, git worktrees
- `docs/prd/sf5-loop-engine/PRD.md`: merge step 7 call order (`mergePr` → `syncMain` → remove worktree → `deleteRemoteBranch`)

### Code Examples

```ts
const run = <T>(fn: () => T) => o.queue.run(fn);
const fetchNow = () => { git(o.root, ['fetch', 'origin', '--prune']); };
const syncNow = () => { fetchNow(); git(o.mainWorktree, ['reset', '--hard', 'origin/main']); git(o.mainWorktree, ['clean', '-fd']); };
// public: fetch: () => run(fetchNow), syncMain: () => run(syncNow), ...
```

## Testing Requirements

`forge.test.ts` (`node:test`, `node:assert/strict`, offline, temp dirs from `makeRepos()`, fake gh with a temp `FAKE_GH_STATE`):
- [ ] `ensureMainWorktree()` creates `.factory/main` detached at `origin/main`; a second call succeeds; after a new commit is pushed to origin from another clone, a third call moves `.factory/main` to it. `root`'s HEAD, branch, and status are unchanged throughout.
- [ ] `syncMain()` discards a dirty file and an untracked file in `.factory/main`.
- [ ] Branch flow: create branch `factory/1-1` in a worktree, commit, `pushBranch`; `openPr` returns `{number: 1, url: …/pull/1}`; `commentPr` appears in the fake state; `prState(1)` returns `OPEN`, `MERGEABLE`, `checks: 0`, `headRefOid` = branch SHA.
- [ ] `mergePr(1, wrongSha)` rejects and the PR stays `OPEN`; `mergePr(1, sha)` resolves, `prState` is `MERGED`, and after `syncMain()` the file is present in `.factory/main`.
- [ ] `prState` with `unknownViews: 1` seeded returns `MERGEABLE` after one retry (≈2 s).
- [ ] `closePr(n, 'nope')` → `CLOSED`.
- [ ] `deleteRemoteBranch` removes the ref from origin; a second call resolves.
- [ ] Queue usage: while a long job holds the queue, `syncMain()` does not start until it finishes.

## Out of Scope

- `git.ts` itself ("Git exec helper and queue").
- `state-commit.ts` and all `main.ts` wiring ("Debounced state committer").
- Executor worktree create/remove and local branch deletion (sf1); deciding when to push/merge/close (sf5).
- Real GitHub calls, check status interpretation beyond `checks` count, auth handling.
