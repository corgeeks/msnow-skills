# Daemon lifecycle and entrypoint

## Objective

Implement the daemon process shell in three files:

- `paths.ts` resolves the repo root and every `.factory/*` path.
- `lifecycle.ts` provides the port-bind single-instance lock, the shutdown hook registry, and the signal handlers.
- `main.ts` is the entrypoint. It loads config, seeds and opens the live DB, wires the store, bus, and HTTP server, then listens on `127.0.0.1:<port>`.

## Suggested Model

Standard: `anthropic/claude-sonnet-5-5`. The process-lifecycle patterns are given verbatim from research.

## Context

Exactly one daemon runs per repo. It is the only writer of the live DB. Later slices hook into it:

- sf1 registers a shutdown hook that kills executor process groups.
- sf2 owns `.factory/main`.
- sf5 starts the engine from `main.ts`.

Keep `main.ts` small and readable. Later slices will add lines to it.

### Parent PRD

- **PRD**: sf0-factory-core
- **PRD Path**: `docs/prd/sf0-factory-core/PRD.md`. See Process lifecycle, Live DB and snapshot, and Config. The umbrella's Git topology table defines the paths.

### Related Tasks

- **Depends on**: SQLite database and store; Scaffold package, config, and shared types
- **Blocks**: sf1, sf2, sf3, sf5
- **Runs in parallel with**: HTTP API, SSE, and static UI serving. Import `createApiServer` from `./http.ts` with the signature `createApiServer({ store, bus, uiDir }): http.Server`. If that file doesn't exist yet when you start, write against this signature anyway; do not implement it.

## Acceptance Criteria

### paths.ts

- [ ] Exports `resolvePaths(root?: string)`.
- [ ] When no root is given, it uses `git rev-parse --show-toplevel` via `execFileSync`.
- [ ] Returns `{ root, factoryDir, configFile, committedDb, liveDir, liveDb, mainWorktree, worktreesDir, sessionsDir, uiDir }`, matching the umbrella Git topology table. `uiDir` is `<root>/factory/ui/dist`.

### lifecycle.ts

- [ ] Exports `acquireInstanceLock(server: http.Server, port: number): Promise<void>`.
  - It listens on `127.0.0.1:port`.
  - On `EADDRINUSE` it rejects with `Error('daemon already running on 127.0.0.1:<port>')`.
  - The listening HTTP server itself is the lock. There is no pidfile.
- [ ] Exports `onShutdown(fn: () => Promise<void> | void): void`, which registers hooks that run in reverse registration order.
- [ ] Exports `installSignalHandlers({ server, db, graceMs = 10_000 })`. On SIGTERM or SIGINT, it runs once and does the following in order:
  1. Stops accepting connections and closes idle ones.
  2. Runs the hooks under a shared `graceMs` deadline.
  3. Closes the DB.
  4. Calls `process.exit(0)`.
  - A second signal while shutdown is in progress is ignored.
- [ ] Exports `runShutdown()` for tests. It runs the same sequence except `process.exit`.

### main.ts

- [ ] Runnable as `node factory/src/daemon/main.ts [--root <dir>] [--port <n>]`.
- [ ] Startup:
  1. Resolve the paths.
  2. `loadConfig(configFile)`. The `--port` flag overrides the config value.
  3. Create `liveDir`.
  4. If `liveDb` is missing and `committedDb` exists, copy the committed DB to `liveDb`.
  5. `openDb(liveDb)`, `createBus()`, `createStore()`.
  6. `createApiServer({ store, bus, uiDir })`.
  7. `acquireInstanceLock(server, port)`.
  8. `installSignalHandlers`.
  9. Log one line, `factory daemon listening on http://127.0.0.1:<port> (root <root>)`.
- [ ] If the instance lock fails, print the error to stderr and exit with code 1.

## Implementation Notes

### Files to Modify

| File Path | Action | Description |
|-----------|--------|-------------|
| `factory/src/daemon/paths.ts` | Create | Path resolution |
| `factory/src/daemon/lifecycle.ts` | Create | Lock, hooks, signals |
| `factory/src/daemon/main.ts` | Create | Entrypoint |
| `factory/src/daemon/lifecycle.test.ts` | Create | Tests |
| `factory/package.json` | Edit | Add script `"daemon": "node src/daemon/main.ts"` |

### Technical Constraints

- Imports are limited to `node:*` and sibling modules.
- No pidfile, no `SO_REUSEPORT`, no daemonizing or forking. The daemon runs in the foreground; systemd or the user backgrounds it.
- Parse argv with `node:util` `parseArgs`.

### Relevant Code References

- `docs/prd/software-factory/research.yaml`: the single-instance daemon question (lock + shutdown snippets, systemd unit)
- `factory/src/daemon/db.ts`, `store.ts`, `bus.ts`
- `factory/src/shared/config.ts`

### Code Examples

```ts
server.once('error', (e: NodeJS.ErrnoException) =>
  reject(e.code === 'EADDRINUSE' ? new Error(`daemon already running on 127.0.0.1:${port}`) : e));
server.listen({ port, host: '127.0.0.1' }, () => resolve());
```

## Testing Requirements

- [ ] Two `http.Server`s call `acquireInstanceLock` on the same free port. The second rejects with the "already running" message.
- [ ] `onShutdown` hooks run in reverse order during `runShutdown()`. A hook that never resolves is cut off at `graceMs`, and `runShutdown` still resolves.
- [ ] Smoke test: spawn `node src/daemon/main.ts --root <tmp git repo> --port 0`. This requires port 0 support, where the printed line shows the actual port. Wait for the log line, `GET /api/health` returns `ok: true`, then SIGTERM. The process exits 0 and `.factory/live/factory.db` exists.
- [ ] Seeding: with only a committed DB that contains one item present, `GET /api/items` on a fresh start returns that item.

## Out of Scope

- Committing or pushing the snapshot, and managing `.factory/main` (sf2)
- Executor processes and their cleanup hook (sf1)
- The loop engine (sf5)
- A systemd unit file. It is documented in research and gets added in sf6 docs if wanted.
