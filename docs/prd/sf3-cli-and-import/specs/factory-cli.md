# factory CLI

## Objective

Implement the `factory` command-line client: `factory/src/cli/main.ts` (argument parsing, commands, output, exit codes) and `factory/src/cli/client.ts` (fetch wrapper and error mapping). Every command talks only to the daemon's HTTP API. Wire the `bin` entry and verify that `npm link --prefix factory` yields a working `factory` on PATH.

## Suggested Model

Standard: `anthropic/claude-sonnet-5-5` — a thin HTTP client over a fixed API, with clear command and exit-code contracts.

## Context

The CLI is the human's v0 control surface (the v0 UI is read-only): start the daemon, import PRDs, add items, explicitly start work (`ready → queued`), check status, and decide gates. It never opens the DB and never touches git.

### Parent PRD

- **PRD**: sf3-cli-and-import
- **PRD Path**: `docs/prd/sf3-cli-and-import/PRD.md`. The "Commands" section of Architecture is normative.

### Related Tasks

- **Depends on**: sf0 "HTTP API, SSE, and static UI serving" (`createApiServer({ store, bus, uiDir }): http.Server` and the API table), sf0 "Daemon lifecycle and entrypoint" (`src/daemon/main.ts`, `--port`, `resolvePaths`), sf0 "Scaffold package, config, and shared types" (`loadConfig`, types), sf0 "SQLite database and store" (`openDb`, `createStore`, `createBus` for test setup).
- **Runs in parallel with**: "PRD importer". Import `buildImportBatch(prdDir: string, root: string): BatchItem[]` from `./import.ts` by that signature; if the file isn't there yet, write against it anyway and do not implement it.
- **Blocks**: sf6 self-hosting cutover.

## Acceptance Criteria

- [ ] `factory/package.json` has `"bin": {"factory": "src/cli/main.ts"}`; `main.ts` starts with `#!/usr/bin/env node` and is executable (`chmod +x`).
- [ ] `main.ts` exports `main(argv: string[]): Promise<number>` (returns the exit code; writes to `process.stdout`/`process.stderr`) and runs it only when executed directly (`if (import.meta.main) process.exitCode = await main(process.argv.slice(2))`).
- [ ] Parsing uses `node:util` `parseArgs` (`strict: true`, `allowPositionals: true`). Unknown command/flag, missing required arg, or non-integer id → usage message on stderr, exit **64**.
- [ ] **Port**: `--port n` (global flag on every command), else `loadConfig(resolvePaths().configFile).port` (default 7317). Host is always `127.0.0.1`.
- [ ] **Exit codes**: 0 success; 1 API error, printing `<error.code>: <error.message>` to stderr; 2 daemon unreachable (connection refused), printing exactly `factory daemon is not running — start it with: factory daemon`; 64 usage.
- [ ] `client.ts` exports `createClient(port: number)` with `get(path)`, `post(path, body)`, `patch(path, body)` returning parsed JSON; non-2xx throws `ApiError {status, code, message}` from `{"error":{code,message}}`; `ECONNREFUSED` (on `err.cause.code`) throws `DaemonUnreachableError`. `main` maps them to exit 1 / 2.
- [ ] Commands, each against the sf0 API:

| Command | Behaviour |
|---|---|
| `daemon [--port n]` | `spawn(process.execPath, [<abs path to src/daemon/main.ts>, ...(port ? ['--port', n] : [])], {stdio: 'inherit'})`; forwards SIGINT/SIGTERM to the child; returns the child's exit code. No API call. |
| `status [--json]` | `GET /api/items` (`ItemSummary[]`: WorkItem + `open_deps`), `GET /api/gates?open=1` (`Gate[]`), and for each `active` item `GET /api/items/:id` then `GET /api/runs/:id` for its latest run (`{run, node_runs, gates}`). Prints counts by status; `active` items with current run id, `pr_url` if set, and its `running` node; open gates (id, item, kind, question); `queued` items with `open_deps > 0`. `--json` prints one object `{counts, active, gates, waiting}`. |
| `show <id> [--json]` | `GET /api/items/:id` (`{item, deps, dependents, children, runs}`), then `GET /api/runs/:id` for each run (`{run, node_runs, gates}`). Prints item fields, parent, children, deps, dependents, each run (status, attempt, `pr_url`) with its node rows, and open gates. `--json` prints `{item, deps, dependents, children, runs: [{run, node_runs, gates}]}`. |
| `add --title T [--type task] [--parent id] [--body B] [--spec path] [--tier t] [--test-cmd c] [--depends-on 1,2] [--ready]` | `POST /api/items` with `status: 'ready'` only if `--ready` (else `draft`), `depends_on: number[]`. `--tier` must be `heavy\|standard\|light` (else 64). Prints the new id. |
| `import <prd-dir> [--dry-run]` | `buildImportBatch(prdDir, resolvePaths().root)`. `--dry-run`: print an indented tree (2 spaces per depth, `type title [status] (source_ref)`, plus `← deps: <refs>` when present); no API call. Otherwise `POST /api/items/batch` with `{items}` and print `created N, skipped M`. Importer errors (missing yq, bad dir) → stderr, exit 1. |
| `start <id…> \| --all` | `GET /api/items` once; children = items whose `parent_id` is the id. For each given id: a leaf → itself; a container → every `ready` descendant leaf. `--all` → every `ready` leaf. For each target: `PATCH /api/items/:id {status:'queued', from:'ready'}`. Prints `queued N`. A given leaf not in `ready` → exit 1 with `conflict: item <id> is <status>`. `--all` with ids, or neither → 64. |
| `approve <gate-id> [--note N]` / `reject …` | `POST /api/gates/:id/decision {decision, note?}` → `Gate`. Prints `gate <id> approved/rejected`. 409 → exit 1. |

- [ ] `npm link --prefix factory` then `factory --help` works from another cwd (type stripping applies because Node resolves the bin symlink to the repo path, outside `node_modules`). Record the outcome in the task's completion notes; if it fails, document the fallback `node factory/src/cli/main.ts` in `--help` output and make no workaround.
- [ ] Only `node:*` imports; never imports `node:sqlite`, `db.ts`, or `store.ts` outside tests.

## Implementation Notes

### Files to Modify

| File Path | Action | Description |
|-----------|--------|-------------|
| `factory/src/cli/main.ts` | Create | Entry, parseArgs, commands, output |
| `factory/src/cli/client.ts` | Create | fetch wrapper, `ApiError`, `DaemonUnreachableError` |
| `factory/src/cli/main.test.ts` | Create | Tests against an in-process daemon |
| `factory/package.json` | Edit | `bin` |

### Technical Constraints

- Global `fetch` (Node 24) only; JSON bodies with `content-type: application/json`.
- `POST /api/items/batch` returns `BatchResult {ids: Record<ref, id>, created: ref[], skipped: ref[]}` (`factory/src/shared/types.ts`); print `created ${created.length}, skipped ${skipped.length}`.
- Usage text lists every command and the fallback invocation; `--help`/no args prints it to stdout with exit 0 for `--help`, 64 for no args.
- Exit by returning a code from `main`; never call `process.exit` inside command code (tests call `main` in-process).
- Erasable TS only; `.ts` import extensions; `import type` for types.

### Relevant Code References

- `docs/prd/sf0-factory-core/PRD.md` — HTTP API table, error shape, statuses
- `docs/prd/sf0-factory-core/specs/http-api-sse.md` — `createApiServer`, batch and gate behaviour
- `docs/prd/sf0-factory-core/specs/daemon-lifecycle.md` — `resolvePaths`, `main.ts --port`
- `docs/prd/sf3-cli-and-import/specs/prd-importer.md` — `buildImportBatch` output shape

### Code Examples

```ts
// test setup (sf0 pattern)
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-cli-'));
const bus = createBus();
const store = createStore(openDb(path.join(dir, 'f.db')), bus);
const server = createApiServer({ store, bus, uiDir: path.join(dir, 'ui') });
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const port = (server.address() as AddressInfo).port;
const code = await main(['status', '--json', '--port', String(port)]);
```

## Testing Requirements

All in `main.test.ts`, in-process daemon on port 0 with a temp DB; capture stdout/stderr by stubbing `process.stdout.write`/`process.stderr.write` per test.

- [ ] `add --title X` creates a `draft`; `--ready` creates `ready`; `--depends-on` creates edges (verified via the store).
- [ ] `import factory/test/fixtures/prd/umbrella --dry-run` prints a tree and creates nothing; a real import creates exactly the dry-run's item count; a second import prints `created 0, skipped <n>`.
- [ ] `start <leaf>` moves `ready → queued`; `start <container>` queues only `ready` descendant leaves; `start --all` queues every `ready` leaf and no containers; `start` on a `draft` leaf → exit 1.
- [ ] `approve`/`reject` close a gate created through the store; deciding again → exit 1 with `conflict:`.
- [ ] `status --json` and `show <id> --json` return the documented keys; `show 999` → exit 1 `not_found:`.
- [ ] Unreachable: listen then close a server to get a free port; any command → exit 2 and the exact message.
- [ ] Usage: unknown command, `start` with no ids, `add` without `--title`, `--tier huge` → 64.
- [ ] `daemon` is not tested by spawning; npm link is verified manually (record the result).

## Out of Scope

- `buildImportBatch` internals ("PRD importer").
- Any API endpoint or store change (sf0); dispatching queued items (sf5).
- UI (sf4/sf7); a systemd unit; shell completion; colour output.
- Editing items beyond `add`/`start` (no `cancel`, `edit` commands in v0).
