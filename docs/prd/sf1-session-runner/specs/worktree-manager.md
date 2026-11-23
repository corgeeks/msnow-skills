# Worktree manager

## Objective

Create `factory/src/daemon/worktrees.ts`: synchronous helpers that create, inspect, commit in, and remove the per-attempt git worktrees executors work in, plus `worktrees.test.ts` covering them against temporary git repos.

## Suggested Model

Standard: `anthropic/claude-sonnet-5-5` — thin, well-specified wrappers over `git`; the only subtle parts are locked-worktree removal and `-z` porcelain parsing.

## Context

Each executor attempt runs in its own locked worktree at `<root>/.factory/worktrees/<itemId>-<attempt>` on branch `factory/<itemId>-<attempt>`, branched from `origin/main`. Isolation keeps parallel executors apart; locking keeps abandoned work recoverable (not pruned) until the daemon removes it. The manager never fetches: sf5 calls `forge.fetch()` (sf2) first so `base` is current. Creating a uniquely named branch concurrently with a fetch is safe (separate ref locks with retry).

### Parent PRD

- **PRD**: sf1-session-runner
- **PRD Path**: `docs/prd/sf1-session-runner/PRD.md`. The `worktrees.ts` Architecture section is normative; umbrella Git topology and Execution facts (git) apply.

### Related Tasks

- **Depends on**: sf0 "Scaffold package, config, and shared types" (package, test script). `paths.worktreesDir` from sf0 "Daemon lifecycle and entrypoint" equals `<root>/.factory/worktrees`; this module derives the same path from `root` and does not import `paths.ts`.
- **Parallel sibling**: "omp RPC session runner and fake" — no shared code. The runner receives a worktree path as `SessionOptions.cwd: string`.
- **Blocks**: sf5 loop engine (create before a build session, `commitAll`/`commitsAhead` after, `resetHard` after review, `removeWorktree` after merge/abandon); sf0/sf5 startup `pruneWorktrees`; sf2 forge pushes the branch named in `Worktree.branch`.

## Acceptance Criteria

**API (verbatim from the PRD)**

```ts
export interface Worktree { path: string; branch: string }
export function createWorktree(root: string, o: { itemId: number; attempt: number; base: string }): Worktree;
  // path = <root>/.factory/worktrees/<itemId>-<attempt>, branch = factory/<itemId>-<attempt>
  // git worktree add --lock --reason "factory item <id> attempt <n>" -b <branch> <path> <base>
export function removeWorktree(root: string, path: string, o: { deleteBranch: string | null }): void;
  // git worktree unlock; git worktree remove --force; then git branch -D <branch> if given
export function pruneWorktrees(root: string): void;             // git worktree prune
export function listWorktrees(root: string): Array<Worktree & { locked: boolean; prunable: boolean }>;
  // parsed from `git worktree list --porcelain -z`; only entries under .factory/worktrees/
export function commitAll(path: string, message: string): string | null; // add -A + commit; returns sha or null if clean
export function headSha(path: string): string;
export function commitsAhead(path: string, base: string): number;     // git rev-list --count <base>..HEAD
export function isClean(path: string): boolean;                       // git status --porcelain is empty
export function resetHard(path: string): void;                        // reset --hard HEAD && clean -fd (reviewer clean-up)
```

- [ ] Every function is synchronous and uses `execFileSync('git', [...], { cwd, encoding: 'utf8' })`. No shell. Failures throw an `Error` whose message contains git's stderr.
- [ ] `createWorktree` runs exactly the documented command from `cwd: root`, creating `.factory/worktrees/` if needed, and returns the absolute `path` and `branch`. The new worktree is locked with reason `factory item <id> attempt <n>`, HEAD equals `base`.
- [ ] `createWorktree` for an existing `<itemId>-<attempt>` throws (git's error); it never overwrites.
- [ ] `removeWorktree` unlocks (tolerating "not locked"), removes with `--force` even when dirty, then `git branch -D <deleteBranch>` when non-null. With `deleteBranch: null` the branch survives.
- [ ] `listWorktrees` parses `git worktree list --porcelain -z`: records separated by an empty field (`\0\0`), fields `worktree <path>`, `HEAD <sha>`, `branch refs/heads/<name>`, `detached`, `locked[ <reason>]`, `prunable[ <reason>]`. Returns only entries whose path is under `<root>/.factory/worktrees/`; `branch` has `refs/heads/` stripped (`''` if detached); `locked`/`prunable` are booleans. Lock reasons containing spaces or newlines do not break parsing.
- [ ] `commitAll` runs `git add -A`, returns `null` if nothing is staged, else commits with `git -c user.name=factory -c user.email=factory@localhost commit -m <message>` and returns the new HEAD sha. The repo's/user's git config is never written.
- [ ] `headSha` returns `rev-parse HEAD` trimmed; `commitsAhead` returns `rev-list --count <base>..HEAD` as a number; `isClean` is true iff `status --porcelain` output is empty (untracked files count as dirty).
- [ ] `resetHard` runs `reset --hard HEAD` then `clean -fd`; afterwards `isClean` is true and committed work is kept.

## Implementation Notes

### Files to Modify

| File Path | Action | Description |
|-----------|--------|-------------|
| `factory/src/daemon/worktrees.ts` | Create | Worktree manager |
| `factory/src/daemon/worktrees.test.ts` | Create | Tests over temp repos |

### Technical Constraints

- Only `node:*` imports (`node:child_process`, `node:fs`, `node:path`). Erasable TS, `.ts` extensions, `import type`.
- One private `git(cwd, args)` helper; no class, no options beyond the PRD signatures.
- Daemon identity is passed per command via `-c`; never `git config`. Tests must not depend on the developer's global identity either: set `GIT_CONFIG_GLOBAL=/dev/null` style isolation only inside tests if needed, never in the module.
- No fetch, push, or network. No locking or queueing here (the git queue is sf2's).
- Compare paths after `path.resolve`/`fs.realpathSync` on both sides (temp dirs may be symlinked, e.g. `/tmp`).

### Relevant Code References

- `docs/prd/sf1-session-runner/PRD.md` — Architecture `worktrees.ts`
- `docs/prd/software-factory/PRD.md` — Git topology table, Execution facts (git: `--lock`, prune on startup, only the daemon fetches)
- `docs/prd/software-factory/research.yaml` — git worktree lifecycle entry
- https://git-scm.com/docs/git-worktree — porcelain format, `-z`, `--lock --reason`

### Code Examples

```ts
// porcelain -z: each field NUL-terminated, records end with an extra NUL
const recs = out.split('\0\0').filter(Boolean).map((r) => r.split('\0'));
```

## Testing Requirements

`worktrees.test.ts`, `node:test` + `node:assert/strict`, offline. Fixture per test (or per suite): `mkdtemp`, `git init --bare origin.git`, `git clone origin.git root`, an initial commit pushed to `origin/main` (commit with explicit `-c user.name/-c user.email`), so `base = 'origin/main'` resolves.
- [ ] `createWorktree(root, {itemId: 7, attempt: 1, base: 'origin/main'})` returns `{path: <root>/.factory/worktrees/7-1, branch: 'factory/7-1'}`; dir exists; `headSha(path)` equals `origin/main`'s sha; `listWorktrees` shows it `locked: true`, `prunable: false`.
- [ ] Creating the same item/attempt twice throws.
- [ ] `listWorktrees` excludes the main checkout and a worktree added outside `.factory/worktrees/`; a lock reason with a space parses correctly.
- [ ] `commitAll` on a clean tree returns `null`; after writing a file returns a 40-hex sha equal to `headSha`; the commit's author is `factory <factory@localhost>` (`git log -1 --format='%an <%ae>'`); `git config user.name` in the clone is unchanged/unset; `commitsAhead(path, 'origin/main') === 1`.
- [ ] `isClean` false with an untracked file; `resetHard` removes untracked files and tracked edits, keeps the commit, then `isClean` is true.
- [ ] `removeWorktree` on a **locked, dirty** worktree with `deleteBranch: 'factory/7-1'` removes the dir, the listing entry, and the branch; with `deleteBranch: null` the branch remains.
- [ ] `pruneWorktrees`: delete an **unlocked** worktree's dir manually → listed `prunable: true` → after prune it is gone. A locked worktree whose dir was deleted survives prune.
- [ ] A git failure (e.g. bad `base`) throws an error whose message contains git's stderr.

## Out of Scope

- Fetching, pushing, PRs, merging, the git queue, `.factory/main` (sf2 forge).
- Deciding when to create/remove worktrees or retry attempts; calling prune on startup (sf5 / daemon wiring).
- Running omp sessions ("omp RPC session runner and fake").
- CLI and UI views of worktrees (sf3, sf4).
