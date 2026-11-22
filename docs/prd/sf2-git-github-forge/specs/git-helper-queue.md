# Git exec helper and queue

## Objective

Create `factory/src/daemon/git.ts` with two primitives that every other git/GitHub operation in the daemon builds on:
- `git(cwd, args, o?)`: a synchronous `execFileSync` wrapper that returns trimmed stdout and throws a typed `GitError` carrying `stderr` and `args`.
- `createQueue()`: a strict FIFO queue that runs one job at a time, where a failing job does not stall the jobs behind it.

## Suggested Model

Standard: `anthropic/claude-sonnet-5-5` — a small, well-specified module; the only subtlety is keeping the promise chain alive after a rejection.

## Context

The factory's committed DB and its merged code both land on `main`. Merges, state commits, fetches, and pushes must never interleave, so the daemon funnels all of them through one in-process FIFO (umbrella: "One git queue"). This task supplies that queue and the exec helper; the forge and state committer are built on top of it in parallel.

### Parent PRD

- **PRD**: sf2-git-github-forge
- **PRD Path**: `docs/prd/sf2-git-github-forge/PRD.md`. The Architecture section `src/daemon/git.ts` is normative.

### Related Tasks

- **Depends on**: sf0 "Scaffold package, config, and shared types" (the `factory/` package, `node --test` setup, TS rules).
- **Blocks**: "GitHub forge and fake gh" and "Debounced state committer". Both import exactly:
  - `git(cwd: string, args: string[], o?: { env?: NodeJS.ProcessEnv }): string`
  - `GitError` (with `stderr: string`, `args: string[]`)
  - `interface Queue { run<T>(fn: () => Promise<T> | T): Promise<T> }` and `createQueue(): Queue`
- **Cross-slice**: sf1 worktree helpers and sf5 loop engine use `git()` and the same `Queue` instance created in `main.ts`.

## Acceptance Criteria

- [ ] `factory/src/daemon/git.ts` exports `git`, `GitError`, `Queue` (type), and `createQueue` with the signatures above, verbatim.
- [ ] `git()` calls `execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })` and returns stdout with surrounding whitespace trimmed. With no `o.env`, it inherits `process.env`; with `o.env`, that object is used as given (callers spread `process.env` themselves).
- [ ] On non-zero exit (or spawn failure), `git()` throws a `GitError` whose `message` includes `git <args joined by space>` and the trimmed stderr, with properties `stderr` (string, `''` if none), `args` (the original array), and `status` (exit code or `null`).
- [ ] `GitError extends Error`, `name === 'GitError'`, and `instanceof GitError` holds for thrown errors.
- [ ] `createQueue().run(fn)` starts `fn` only after every previously enqueued job has settled; at most one job runs at any time.
- [ ] Jobs start in enqueue order, and each `run()` promise resolves/rejects with its own job's result/error.
- [ ] A job that throws synchronously, or returns a rejected promise, rejects only its own `run()` promise; the next job still runs.
- [ ] Sync return values (non-promise) are supported.
- [ ] No unhandled-rejection warnings are produced by the internal chain when a job fails.

## Implementation Notes

### Files to Modify

| File Path | Action | Description |
|-----------|--------|-------------|
| `factory/src/daemon/git.ts` | Create | `git()`, `GitError`, `Queue`, `createQueue()` |
| `factory/src/daemon/git.test.ts` | Create | Tests below |

### Technical Constraints

- Node ≥ 24.15 type stripping: erasable syntax only (no `enum`, no parameter properties, no namespaces), `.ts` import extensions, `import type` for type-only imports.
- Only `node:*` runtime imports (`node:child_process`). No dependencies.
- `GitError` must set fields with plain assignments in the constructor (parameter properties are not erasable).
- Do not add retries, timeouts, logging, or an identity default to `git()`. The daemon commit identity (`-c user.name=factory -c user.email=factory@localhost`) is passed in `args` by callers.
- The queue is a promise chain (`tail = tail.then(job, job)`-style or equivalent with a swallowed tail), not a polling loop or array scheduler.

### Relevant Code References

- `docs/prd/sf2-git-github-forge/PRD.md`: Architecture → `src/daemon/git.ts`, Constraints
- `docs/prd/software-factory/PRD.md`: Git topology, "One git queue", Execution facts (git bullet)
- `docs/prd/sf0-factory-core/specs/sqlite-db-and-store.md`: style reference for module + test layout

### Code Examples

```ts
import { execFileSync } from 'node:child_process';

export class GitError extends Error {
  stderr: string; args: string[]; status: number | null;
  constructor(args: string[], stderr: string, status: number | null) {
    super(`git ${args.join(' ')} failed: ${stderr}`);
    this.name = 'GitError'; this.args = args; this.stderr = stderr; this.status = status;
  }
}

export interface Queue { run<T>(fn: () => Promise<T> | T): Promise<T> }

export function createQueue(): Queue {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    run(fn) {
      const p = tail.then(() => fn());
      tail = p.catch(() => {}); // keep the chain alive after a failure
      return p;
    },
  };
}
```

## Testing Requirements

`factory/src/daemon/git.test.ts` with `node:test` + `node:assert/strict`, temp dirs via `fs.mkdtempSync(os.tmpdir())`, offline:
- [ ] `git(tmp, ['init', '-q', '-b', 'main'])` then `git(tmp, ['rev-parse', '--abbrev-ref', 'HEAD'])` returns `'main'` (trimmed, no newline).
- [ ] `git(tmp, ['rev-parse', 'nope'])` throws `GitError` with `args` deep-equal to `['rev-parse', 'nope']`, non-empty `stderr`, and a non-zero `status`.
- [ ] `o.env` is honoured: `git(tmp, ['var', 'GIT_AUTHOR_IDENT'], { env: { ...process.env, GIT_AUTHOR_NAME: 'x', GIT_AUTHOR_EMAIL: 'x@y' } })` contains `x <x@y>`.
- [ ] FIFO + exclusivity: enqueue three async jobs with descending `setTimeout` delays that push start/end markers; the log is `s1,e1,s2,e2,s3,e3`.
- [ ] Failure isolation: job 1 throws synchronously, job 2 returns a rejected promise, job 3 returns `42`; `run` promises reject/reject/resolve `42`, and job 3 runs.
- [ ] Sync return: `await q.run(() => 'x') === 'x'`.

## Out of Scope

- `forge.ts` (fetch, `.factory/main`, push, `gh`): "GitHub forge and fake gh".
- `state-commit.ts` and `main.ts` wiring: "Debounced state committer".
- Worktree creation/removal for executors (sf1), and the loop engine (sf5).
- Any async/spawn-based git variant, retries, or timeouts.
