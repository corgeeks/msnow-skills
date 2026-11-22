# L1 · sf3 — CLI and PRD import

> Child of umbrella **software-factory** (`../software-factory/PRD.md`). It builds on the **sf0** contracts (`../sf0-factory-core/PRD.md`): the HTTP API, `POST /api/items/batch`, and the item statuses including `queued`.

## Objective

Build the `factory` command-line client and the YAML PRD importer.

- The CLI talks only to the daemon's HTTP API. It never opens the DB.
- The importer turns a PRD directory (`PRD.md` + `tasks.yaml` + `specs/`) into one transactional batch of work items and dependency edges. It handles ordinary PRDs, umbrella PRDs, and stub children with no tasks.
- `factory start` is the explicit dispatch switch (`ready → queued`).

**Done when:**
- `factory import docs/prd/software-factory --dry-run` prints the item tree that a real import would create.
- A real import into a test daemon produces exactly that tree, and re-running the import creates nothing.
- Every command below works against a test daemon.

## Motivation

The importer is how the bootstrap hands over: sf6 imports this repo's remaining PRDs into the factory, and after that YAML PRDs are retired. The CLI is the human's v0 control surface for start, status, and approve/reject, because the v0 UI is read-only.

## Implementation Details

### Architecture

#### Commands (`src/cli/main.ts`; `bin: {"factory": "src/cli/main.ts"}` with a `#!/usr/bin/env node` shebang)

| Command | Behaviour |
|---|---|
| `factory daemon [--port n]` | Runs `src/daemon/main.ts` in the foreground (spawned with `stdio: 'inherit'`) and forwards SIGINT/SIGTERM to it |
| `factory status [--json]` | Shows counts by status, `active` items with their current run and node, open gates (id, item, kind, question), and `queued` items waiting on dependencies |
| `factory show <id>` | Shows an item: fields, parent, children, deps, runs with node rows, and open gates |
| `factory add --title T [--type task] [--parent id] [--body B] [--spec path] [--tier t] [--test-cmd c] [--depends-on 1,2] [--ready]` | Creates one item. It is `draft` unless `--ready` is given. |
| `factory import <prd-dir> [--dry-run]` | Builds the batch, then either prints it as an indented tree or POSTs it to `/api/items/batch` and prints `created N, skipped M` |
| `factory start <id…> \| --all` | Transitions `ready → queued` for the given leaf items, or for every `ready` leaf. For a container (an item with children), it queues all of its `ready` descendant leaves. |
| `factory approve <gate-id> [--note N]` / `factory reject <gate-id> [--note N]` | `POST /api/gates/:id/decision` |

- **Daemon address**: `--port`, else `.factory/config.json` `port` (through `loadConfig` and `resolvePaths` from sf0), at `127.0.0.1`. A refused connection prints `factory daemon is not running — start it with: factory daemon` and exits 2.
- **Exit codes**: 0 on success, 1 for an API error (prints `error.code: message`), 2 when the daemon is unreachable, 64 for a usage error.
- **Argument parsing**: `node:util` `parseArgs`. Output is plain text, with `--json` on `status` and `show` for scripts.
- **Installation**: `npm link --prefix factory` puts `factory` on PATH. Node resolves the symlink to the real path in the repo (outside `node_modules`), so type stripping applies; the first task verifies this. The documented fallback is `node factory/src/cli/main.ts`.

#### Importer (`src/cli/import.ts`)

```ts
export function buildImportBatch(prdDir: string, root: string): BatchItem[]; // pure apart from file reads + yq
```

- **YAML**: `tasks.yaml` is read through the prd skill's own compatibility layer. It runs `bash -c 'source "$1" && yaml_to_json "$2"' _ <root>/skills/prd/scripts/lib/yq-compat.sh <file>`, which works with either yq flavor and adds no npm dependency. A missing yq or jq fails with the install hint that `require_yaml_tools` prints.
- **Mapping**:

| Source | Item | Fields |
|---|---|---|
| A PRD directory | `type: 'prd'`, or `'umbrella'` if any leaf `spec` ends in `PRD.md` | `title`: the first `# ` heading of `PRD.md`; `body`: the `## Objective` section; `spec_path`: the repo-root-relative `PRD.md`; `source_ref`: `prd:<dir-name>`; `status`: `ready`. This also applies to recursed children; the umbrella leaf's stored status is ignored. |
| A top-level entry with `subtasks` | `type: 'group'`, parent is the PRD item | `title`/`body` from `name`/`description`; `source_ref`: `prd:<dir>#<name>`; `status`: `ready` |
| A leaf task (spec under `specs/`) | `type: 'task'`, parent is the PRD or group item | `title`: `name`; `body`: `description`; `spec_path`: repo-root-relative; `tier`: from the first line after the spec's `## Suggested Model` heading (`Heavy`, `Standard`, or `Light`, case-insensitive), else null; `status`: `draft→draft`, `defined→ready`, `in-progress→ready`, `completed→done`; `source_ref`: `prd:<dir>#<name>` |
| An umbrella leaf (spec ends in `PRD.md`) | Recurse into the child directory; its PRD item's parent is the umbrella item | If the child has no `tasks.yaml`, it becomes a single `type: 'prd'` leaf item with `status: 'draft'`. These are the v1 backlog stubs, and the factory plans them later. |

- **Dependencies** mirror the skill's semantics. Top-level entries are sequential, and subtasks run in parallel.
  - Inside a PRD, every leaf under top-level entry *k* depends on every leaf under entry *k−1*.
  - In an umbrella, every leaf under level *k* depends on every leaf under level *k−1*, flattened through children.
  - Leaves of a level gated by `plan_after_prior` get the same edges.
  - Only leaves carry dependencies. Containers (`prd`, `umbrella`, `group`) are never dispatched; sf5 rolls their status up.
- **Idempotency**: every `source_ref` is stable, so re-importing skips existing items (sf0 batch semantics). Changing statuses on re-import is out of scope.

### Constraints

- Only `node:*` imports, plus the external `bash`, `yq`, and `jq` that the prd skill already requires.
- The CLI never touches the DB or git.
- `buildImportBatch` is a pure function of the files on disk. Its tests use fixture PRD dirs under `factory/test/fixtures/prd/`: an ordinary PRD, an umbrella with two levels, a `plan_after_prior` level, and a stub child with no `tasks.yaml`.
- The CLI's tests start a real daemon in-process: `createApiServer` on port 0 with a temp DB, the sf0 pattern.

### Relevant Guides

- `skills/prd/reference/prd-spec.md`: the `tasks.yaml` structure, umbrella PRDs, and `plan_after_prior`
- `skills/prd/schemas/tasks.schema.json`: the import input contract
- `skills/prd/scripts/lib/umbrella-lib.sh`: how umbrella leaves are detected and resolved (`ul_leaves`)
- sf0 PRD: the HTTP API table and the batch semantics

### Relevant Files

- `factory/src/cli/main.ts`, `factory/src/cli/client.ts` (fetch wrapper and error mapping), `factory/src/cli/import.ts` - (Create)
- `factory/src/cli/{import,main}.test.ts` - (Create)
- `factory/test/fixtures/prd/**` - (Create) importer fixtures
- `factory/package.json` - (Edit) `bin`
- `skills/prd/scripts/lib/yq-compat.sh` - (Review) `yaml_to_json`

## Discussion

### Dispatch policy

_When does a ready item actually start?_

Only after an explicit `factory start <id…|--all>`, which marks it `queued`. From then on the engine dispatches it automatically once its dependencies are `done`, within `loop.maxParallel` (2).

### YAML parsing

_Add an npm YAML parser, or reuse the skill's yq layer?_

Reuse `skills/prd/scripts/lib/yq-compat.sh`. It adds no dependency, yq and jq are already required by the skill, and the importer becomes obsolete once YAML PRDs are retired.
