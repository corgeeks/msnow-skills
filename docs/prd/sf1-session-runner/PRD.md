# L1 · sf1 — Session runner

> Child of umbrella **software-factory** (`../software-factory/PRD.md`). It builds on the **sf0** contracts (`../sf0-factory-core/PRD.md`). The decisions and execution facts recorded in the umbrella apply here.

## Objective

Give the daemon two building blocks:

1. **`omp.ts`**: run one prompt in one `omp --mode rpc` session inside a given directory and return a structured outcome. The outcome covers completion, abort, error, timeout, cost cap, or crash, plus cost, final assistant text, and the transcript path. While the session runs, the runner streams compact tool-activity lines.
2. **`worktrees.ts`**: create, inspect, commit in, and remove the per-attempt git worktrees that executors work in.

**Done when:**
- Both modules are covered by deterministic tests against a **fake omp** and temporary git repos.
- An opt-in live smoke test (`FACTORY_LIVE_OMP=1`) passes against the real omp.

## Motivation

sf5 (the loop engine) runs every build and review through these two modules. The session runner is where the untrustworthy parts of agent execution are contained:
- wall-clock timeouts, which `--max-time` cannot signal;
- cost caps;
- crashes and orphaned processes.

The worktree manager keeps parallel executors isolated. It also keeps abandoned work recoverable.

## Implementation Details

### Architecture

#### `src/daemon/omp.ts`

```ts
export interface SessionOptions {
  cwd: string;                 // worktree path
  model: string;               // e.g. "anthropic/claude-sonnet-5-5"
  sessionDir: string;          // paths.sessionsDir
  maxCostUsd: number;          // passed as --max-cost
  timeoutMs: number;           // enforced by the runner, NOT --max-time
  appendSystemPrompt?: string; // passed as --append-system-prompt
  command?: string[];          // default ['omp']; tests pass ['node', 'test/fakes/fake-omp.ts']
  onActivity?: (text: string) => void;
  graceMs?: { ready?: number; exit?: number; abort?: number }; // defaults 30000 / 10000 / 15000; tests shrink them
}
export type SessionStatus = 'completed' | 'aborted' | 'error' | 'timeout' | 'cost_cap' | 'crashed';
export interface SessionOutcome {
  status: SessionStatus;
  error: string | null;
  finalText: string;           // text of the last assistant message_end
  costUsd: number;             // get_session_stats.data.cost (0 if unavailable)
  sessionId: string | null;
  sessionFile: string | null;  // get_state.data.sessionFile
}
export function runSession(prompt: string, opts: SessionOptions): Promise<SessionOutcome>;
export function killAllSessions(signal?: NodeJS.Signals): void; // main.ts registers this via onShutdown
```

- **One prompt per session.** A rework round, or a resume after a restart, starts a new session in the same worktree with a prompt that says so. v0 has no multi-turn steering.
- **Spawn**: `command[0]` is launched with `command.slice(1)` and the flags `--mode rpc --no-ui --approval-mode yolo --model <m> --cwd <cwd> --session-dir <dir> --max-cost <usd> [--append-system-prompt <s>]`, with `detached: true` and stdio `['pipe','pipe','pipe']`. The pid is tracked in a module-level registry. stderr goes to a ring buffer (last 64 KiB), which is used in `crashed` errors.
- **Protocol**:
  1. Read stdout as NDJSON and wait for `{"type":"ready"}`. If it doesn't arrive within `graceMs.ready` (30 s), the status is `crashed`.
  2. Send `{"id":"p1","type":"prompt","message":…}` and wait for `prompt_result` with `id: "p1"`.
  3. After the result, send `get_state` and `get_session_stats` and read `sessionFile`, `sessionId`, and `cost`.
  4. Close stdin. Allow `graceMs.exit` (10 s) for the process to exit, then SIGKILL the process group.
  - Replies to `get_state` and `get_session_stats` are matched by `id`. Their envelope (verified on omp 19.1.0) is `{"type":"response","id","command","success","data"}`.
  - Unknown frame types are ignored. Unparseable lines are skipped and counted.
- **Status mapping:**

  | `prompt_result` / condition | `SessionStatus` |
  |---|---|
  | `completed` | `completed` |
  | `aborted` | `aborted` |
  | `error` with `error.code === 'cost_cap'` | `cost_cap` |
  | other `error` | `error` (message from `error.message`) |
  | Runner's timer fires | Send `{"type":"abort"}` → `timeout`. If no `prompt_result` arrives within `graceMs.abort` (15 s), SIGKILL the process group; status is still `timeout`. A `prompt_result` that arrives after the timer fired still yields `timeout`. |
  | Process exits before `prompt_result`, including when `killAllSessions` kills it | `crashed`, with the stderr tail |

  `completed` never means the task succeeded. sf5 decides that by running tests.
- **Activity**: each `tool_execution_start` frame becomes one line, `` `${toolName} ${summary}` ``, truncated to 160 characters. The summary is `args.path ?? args.command ?? args.pattern ?? first string value`, else empty.
  - Frame shape verified on omp 19.1.0: `{"type":"tool_execution_start","toolCallId","toolName":"bash","args":{"command":"cat a.txt"}}`.
  - The last assistant `message_end` frame looks like `{"message":{"role":"assistant","content":[{"type":"text","text":"ok"}],"stopReason":"stop",…}}`, and `finalText` joins its text parts.
- **Shutdown**: `killAllSessions` sends the signal (default SIGTERM) to `-pid` for every live session. ESRCH (process already gone) is ignored.

#### `src/daemon/worktrees.ts`

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

- Every function is synchronous and uses `execFileSync('git', [...], { cwd })`. There is no shell, and errors throw with git's stderr.
- Commits made by the daemon use the author `factory <factory@localhost>`, set with `-c user.name=… -c user.email=…`. The user's git config is never changed.
- The worktree manager does not fetch. The engine calls `forge.fetch()` (sf2) before `createWorktree`, so that `base` (`origin/main`) is current. Creating a uniquely named branch while the daemon fetches is safe: git uses separate ref locks with retry.

#### Test fakes (owned by this slice; reused by sf5)

`factory/test/fakes/fake-omp.ts` is a Node script that speaks the RPC subset above. Its behaviour is chosen by the `FAKE_OMP_SCENARIO` env var:

| Scenario | Behaviour |
|---|---|
| `complete` | Emits `ready`, two `tool_execution_start` frames, an assistant `message_end` containing `FAKE_OMP_TEXT` (default `"ok"`), then `prompt_result completed` |
| `cost_cap` | `prompt_result` with status `error` and `code` `cost_cap` |
| `error` | Generic error |
| `hang` | Never answers until it receives `abort`, then sends `aborted` |
| `hang_ignore_abort` | Never answers |
| `crash` | Exits 3 after `ready` |
| `edit` | Runs the shell snippet in `FAKE_OMP_EDIT` in its cwd (e.g. write and commit a file), then completes |
| `no_ready` | Never emits `ready` |

Env hooks for every scenario:
- `FAKE_OMP_TOOLS`: a JSON array of `{toolName, args}`; overrides the two default `tool_execution_start` frames.
- `FAKE_OMP_ARGV_FILE`: if set, the fake writes its argv there as JSON, so tests can assert the flags (no `--max-time`, and `--max-cost`, `--model`, `--cwd` present).

`get_state` and `get_session_stats` return fixed values (`cost: 0.01`). The fake lives under `test/`, outside the `src/**/*.test.ts` glob, so it is never run as a test.

### Constraints

- Only `node:*` imports. No dependencies.
- The runner never writes the DB and has no knowledge of items or runs. It returns outcomes, and sf5 persists them.
- Never pass `--max-time`: it reports `completed` on expiry (verified on omp 19.1.0). The runner's own timer is the only timeout.
- Executors are spawned with `detached: true`. Every live pid is in the registry until its `exit` event.
- Tests must be deterministic and offline. Only `omp.live.test.ts` touches the real omp. It is skipped unless `FACTORY_LIVE_OMP=1`, and it uses `anthropic/claude-haiku-5-5` with `maxCostUsd: 0.05`.

### Relevant Guides

- Umbrella: Execution facts, Git topology
- `../software-factory/research.yaml`: omp RPC (including the local verification of `cost_cap` and `--max-time`) and the git worktree lifecycle
- https://github.com/can1357/oh-my-pi/blob/main/docs/rpc.md
- https://git-scm.com/docs/git-worktree

### Relevant Files

- `factory/src/daemon/omp.ts` - (Create) session runner
- `factory/src/daemon/worktrees.ts` - (Create) worktree manager
- `factory/src/daemon/omp.test.ts`, `factory/src/daemon/omp.live.test.ts`, `factory/src/daemon/worktrees.test.ts` - (Create)
- `factory/test/fakes/fake-omp.ts` - (Create) RPC fake
- `factory/src/daemon/main.ts` - (Edit) `onShutdown(() => killAllSessions())`
- `factory/src/daemon/lifecycle.ts` - (Review) `onShutdown`
- `factory/src/daemon/paths.ts` - (Review) `worktreesDir`, `sessionsDir`

## Discussion

### Live executor activity

_Should the UI show live executor activity (transient tool-call lines over SSE), nothing, or persisted per-tool events?_

Transient tool-call lines. The runner emits them through `onActivity`, and sf5 forwards them to `bus.publishActivity`. They are never persisted.

### Model routing

Inherited from the umbrella. Specs carry a Suggested Model.
