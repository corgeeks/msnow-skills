# omp RPC session runner and fake

## Objective

Create `factory/src/daemon/omp.ts`. It runs exactly one prompt in one `omp --mode rpc` session inside a given worktree and returns a structured `SessionOutcome`. While it runs, it streams compact tool-activity lines. Also create the RPC fake `factory/test/fakes/fake-omp.ts`, deterministic tests that reach every `SessionStatus`, an opt-in live smoke test, and the `main.ts` shutdown hook that kills live sessions.

## Suggested Model

Heavy: `anthropic/claude-opus-5-5` — process-group lifecycle, three interacting timers, NDJSON stream handling and crash/timeout races are easy to get subtly wrong.

## Context

sf5 (loop engine) runs every build and review through `runSession`. The runner contains the untrustworthy parts of agent execution: wall-clock timeouts (`--max-time` reports `completed` on expiry, so it is never used), cost caps, crashes, and orphaned processes. The runner never touches the DB and knows nothing about items or runs; sf5 persists the outcome and forwards `onActivity` lines to `bus.publishActivity`. One prompt per session: rework and resume start a new session in the same worktree.

### Parent PRD

- **PRD**: sf1-session-runner
- **PRD Path**: `docs/prd/sf1-session-runner/PRD.md`. The `omp.ts` and Test fakes Architecture sections are normative; umbrella `docs/prd/software-factory/PRD.md` Execution facts apply.

### Related Tasks

- **Depends on**: sf0 "Scaffold package, config, and shared types" (package, tsconfig, test script); sf0 "Daemon lifecycle and entrypoint" (`onShutdown(fn: () => Promise<void> | void): void` in `lifecycle.ts`, `main.ts`, `paths.sessionsDir`).
- **Parallel sibling**: "Worktree manager" — no shared code. The `edit` fake scenario only needs a git repo in `cwd`; build it in the test with plain `git` calls, not with `worktrees.ts`.
- **Blocks**: sf5 loop engine, which calls `runSession(prompt, opts)` and reuses `test/fakes/fake-omp.ts` via `command: ['node', '<abs>/test/fakes/fake-omp.ts']` plus `FAKE_OMP_*` env vars.

## Acceptance Criteria

**API (verbatim from the PRD)**

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

**Spawn**
- [ ] Spawns `command[0]` with `[...command.slice(1), '--mode','rpc','--no-ui','--approval-mode','yolo','--model',m,'--cwd',cwd,'--session-dir',dir,'--max-cost',String(usd)]`, plus `'--append-system-prompt', s` only when given. `--max-time` is never passed.
- [ ] `spawn` options: `detached: true`, `stdio: ['pipe','pipe','pipe']`, `cwd: opts.cwd`. The pid enters a module-level registry and leaves it only on the child's `exit` event.
- [ ] stderr is kept in a ring buffer holding the last 64 KiB (older bytes dropped); its tail is included in `crashed` errors.

**Protocol**
- [ ] stdout is drained continuously and split into NDJSON lines. Unknown `type`s are ignored; unparseable lines are skipped and counted (count included in `crashed` error text is enough; no other API).
- [ ] Waits for `{"type":"ready"}`; if absent after `graceMs.ready` (default 30000) → SIGKILL group, `crashed`.
- [ ] Sends `{"id":"p1","type":"prompt","message":prompt}` and waits for the `prompt_result` frame whose `id` is `"p1"` (the intermediate `response` ack is ignored).
- [ ] After `prompt_result`, sends `get_state` and `get_session_stats` (with their own ids). Replies use the envelope `{"type":"response","id","command","success","data"}` (verified on omp 19.1.0) and are matched by `id`; read `data.sessionFile`, `data.sessionId`, `data.cost`. Missing or `success: false` replies leave `null`/`null`/`0`; they never change `status`.
- [ ] Then closes stdin, allows `graceMs.exit` (default 10000) for exit, then `process.kill(-pid, 'SIGKILL')`. `runSession` resolves only after the child has exited.
- [ ] `runSession` never rejects for session failures; every path resolves to a `SessionOutcome`.

**Status mapping**

| `prompt_result` / condition | `status` | `error` |
|---|---|---|
| `completed` | `completed` | `null` |
| `aborted` | `aborted` | `null` |
| `error`, `error.code === 'cost_cap'` | `cost_cap` | `error.message` |
| other `error` | `error` | `error.message` |
| runner timer (`timeoutMs`) fires | send `{"type":"abort"}` → `timeout`; no `prompt_result` within `graceMs.abort` (default 15000) → SIGKILL group, still `timeout` | non-null, mentions timeout |
| process exits before `prompt_result`, including when `killAllSessions` kills it | `crashed` | exit code/signal + stderr tail |

- [ ] A `prompt_result` arriving after the timer fired (e.g. `aborted` in reply to our abort) still yields `timeout`. `completed` means only that omp finished, never that the task succeeded.

**Activity and final text**
- [ ] Each `tool_execution_start` frame calls `onActivity` with `` `${toolName} ${summary}` `` truncated to 160 chars, where `summary = args.path ?? args.command ?? args.pattern ?? <first string value in args> ?? ''`.
- [ ] `finalText` joins the `text` parts of the **last** `message_end` whose `message.role === 'assistant'`; `''` if none.

**Shutdown**
- [ ] `killAllSessions(signal = 'SIGTERM')` calls `process.kill(-pid, signal)` for every registered pid, ignoring `ESRCH`.
- [ ] `factory/src/daemon/main.ts` imports `killAllSessions` and registers `onShutdown(() => killAllSessions())`.

**Fake** — `factory/test/fakes/fake-omp.ts`, behaviour chosen by `FAKE_OMP_SCENARIO`:

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

Env hooks (any scenario):
- `FAKE_OMP_TOOLS`: a JSON array of `{toolName, args}`; overrides the two default `tool_execution_start` frames.
- `FAKE_OMP_ARGV_FILE`: if set, the fake writes its argv there as JSON, so tests can assert the flags.

- [ ] The fake reads `--cwd` (ignores other flags), writes one stderr line on start, answers `get_state` and `get_session_stats` with the response envelope above (fixed `sessionFile`/`sessionId`, `cost: 0.01`), and exits when stdin closes. `hang_ignore_abort` and `no_ready` also ignore stdin close, so the SIGKILL paths are real.

## Implementation Notes

### Files to Modify

| File Path | Action | Description |
|-----------|--------|-------------|
| `factory/src/daemon/omp.ts` | Create | `runSession`, `killAllSessions`, registry |
| `factory/src/daemon/omp.test.ts` | Create | Deterministic tests against the fake |
| `factory/src/daemon/omp.live.test.ts` | Create | Smoke test, skipped unless `FACTORY_LIVE_OMP=1` |
| `factory/test/fakes/fake-omp.ts` | Create | RPC fake (outside the `src/**/*.test.ts` glob) |
| `factory/src/daemon/main.ts` | Edit | `onShutdown(() => killAllSessions())` |

### Technical Constraints

- Only `node:*` imports (`node:child_process`, `node:readline` or manual line splitting, `node:path`). No dependencies. Erasable TS only, `.ts` import extensions, `import type` for types.
- `graceMs` fields default independently (`opts.graceMs?.ready ?? 30_000`, etc.); no other timing knobs.
- Clear every timer on every path so the event loop is never held open after resolve.
- Match `get_state`/`get_session_stats` replies by request `id` (envelope above; see https://github.com/can1357/oh-my-pi/blob/main/docs/rpc.md).
- Writes to a stdin that has closed (crashed child) must not throw unhandled `EPIPE`; attach an `error` listener on `child.stdin`.

### Relevant Code References

- `docs/prd/sf1-session-runner/PRD.md` — Architecture `omp.ts`, Test fakes, Constraints
- `docs/prd/software-factory/PRD.md` — Execution facts (RPC, `--max-time`, detached spawn)
- `docs/prd/software-factory/research.yaml` — omp RPC entry, local `cost_cap` verification
- `factory/src/daemon/lifecycle.ts` — `onShutdown`
- `factory/src/daemon/main.ts` — hook registration site

### Code Examples

```ts
// verified on omp 19.1.0
{"type":"tool_execution_start","toolCallId":"t1","toolName":"bash","args":{"command":"cat a.txt"}}
{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"ok"}],"stopReason":"stop"}}
{"id":"p1","type":"prompt_result","status":"error","error":{"code":"cost_cap","message":"…"}}
```

```ts
function killGroup(pid: number, sig: NodeJS.Signals): void {
  try { process.kill(-pid, sig); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; }
}
```

## Testing Requirements

`omp.test.ts`, `node:test` + `node:assert/strict`, temp dirs for `cwd`/`sessionDir`, `command: ['node', <abs path to fake>]`, scenario via `process.env` per test (run tests serially or pass env through spawn inheritance carefully):
- [ ] `complete`: `status 'completed'`, `finalText 'ok'` (and custom `FAKE_OMP_TEXT`), `costUsd 0.01`, `sessionFile`/`sessionId` match the fake's values, `onActivity` received exactly two lines in the `` `${toolName} ${summary}` `` format.
- [ ] Activity via `FAKE_OMP_TOOLS`: a long `args.command` yields a line of exactly 160 chars; `{path, command}` uses `path`; `args` with only a non-standard string key uses that value; empty `args` yields exactly `` `${toolName} ` `` (PRD template, trailing space kept).
- [ ] `cost_cap` → `cost_cap`; `error` → `error` with the fake's message.
- [ ] `hang` with `timeoutMs: 200` → `timeout` (the fake's late `aborted` does not change it), resolves well under 1 s.
- [ ] `hang_ignore_abort` with `timeoutMs: 200`, `graceMs: { abort: 300, exit: 300 }` → `timeout` after SIGKILL; the fake pid is gone (`process.kill(pid, 0)` throws `ESRCH`).
- [ ] `no_ready` with `graceMs: { ready: 300 }` → `crashed`, pid gone.
- [ ] `crash` → `crashed`, `error` contains the fake's stderr line.
- [ ] `edit` in a temp git repo with `FAKE_OMP_EDIT='echo x > f && git add f && git -c user.name=t -c user.email=t@t commit -qm x'` → `completed` and the repo has the new commit.
- [ ] Argv via `FAKE_OMP_ARGV_FILE`: `--max-time` absent; `--max-cost`, `--model`, `--cwd` present with the given values; `--append-system-prompt` appears only when set.
- [ ] `killAllSessions()` during a `hang_ignore_abort` session kills the group; the pending `runSession` resolves `crashed`; calling it again with nothing live does not throw.

`omp.live.test.ts`: `test(..., { skip: process.env.FACTORY_LIVE_OMP !== '1' })`, real `omp`, `model: 'anthropic/claude-haiku-5-5'`, `maxCostUsd: 0.05`, `timeoutMs: 120_000`, prompt "Reply with exactly: ok". Asserts `completed`, non-empty `finalText`, `costUsd > 0`, `sessionFile` exists on disk.

## Out of Scope

- Worktree creation, commits, and cleanup ("Worktree manager").
- Persisting outcomes, runs, node runs, or activity; deciding task success; rework prompts (sf5 loop engine).
- Multi-turn steering, resume of an existing omp session, model routing (umbrella/sf5).
- Forge/fetch/push (sf2); CLI (sf3); UI activity display (sf4).
