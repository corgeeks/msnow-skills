# PRD importer

## Objective

Implement `buildImportBatch(prdDir, root): BatchItem[]` in `factory/src/cli/import.ts`. It turns a YAML PRD directory (`PRD.md` + `tasks.yaml` + `specs/`) into one flat, ordered batch of work items with parent and dependency refs, ready to POST to `/api/items/batch`. It handles ordinary PRDs, umbrella PRDs (recursing into children), `plan_after_prior` levels, and stub children with no `tasks.yaml`.

## Suggested Model

Standard: `anthropic/claude-sonnet-5-5` — a pure tree walk with well-specified mapping and dependency rules; no concurrency or I/O beyond file reads and one subprocess.

## Context

The importer is the bootstrap hand-over: sf6 imports this repo's remaining PRDs into the factory, then YAML PRDs are retired. It must mirror the prd skill's semantics (top-level entries are sequential, subtasks are parallel, umbrella leaves are child PRDs) so the factory's DAG matches what WorkPRD would have done. Idempotency comes from stable `source_ref`s plus sf0's batch semantics (existing `source_ref` → skipped).

### Parent PRD

- **PRD**: sf3-cli-and-import
- **PRD Path**: `docs/prd/sf3-cli-and-import/PRD.md`. The "Importer" section of Architecture is normative.

### Related Tasks

- **Depends on**: sf0 "Scaffold package, config, and shared types" (package, `Tier`), sf0 "SQLite database and store" (`BatchItem` and `createItemsBatch` semantics).
- **Runs in parallel with**: "factory CLI". The CLI's `import` command calls exactly `buildImportBatch(prdDir: string, root: string): BatchItem[]` and either prints the result as a tree (`--dry-run`) or POSTs `{items}` to `/api/items/batch`. Do not write CLI code.
- **Blocks**: sf6 self-hosting cutover (imports `docs/prd/software-factory`).

## Acceptance Criteria

- [ ] `factory/src/cli/import.ts` exports `buildImportBatch(prdDir: string, root: string): BatchItem[]`. `prdDir` may be relative to `process.cwd()` or absolute; `root` is the repo root (used for the yq-compat path and for repo-relative `spec_path`).
- [ ] Each returned item has the sf0 `BatchItem` shape (below). `ref` equals `source_ref`, so refs are unique and stable. Parents appear before their children in the array.
- [ ] Mapping follows the table below exactly (types, titles, bodies, `source_ref`, statuses, `spec_path`, `tier`).
- [ ] Dependencies follow the rules below. Only leaves (`task` items, and stub `prd` leaves) have non-empty `depends_on_refs`; containers (`prd` with tasks, `umbrella`, `group`) never do.
- [ ] YAML is read only via the yq-compat invocation below. If yq or jq is missing, it throws an `Error` whose message contains the `require_yaml_tools` hint text (captured from stderr).
- [ ] A missing `PRD.md` in `prdDir`, or a leaf spec under `specs/` that does not exist, throws an `Error` naming the path.
- [ ] Running it on `docs/prd/software-factory` succeeds and produces: one `umbrella`, groups for `L1 · Adapters and surfaces` and `L4 · v1 backlog …`, `prd` items for sf0–sf5 with their tasks, and draft stub `prd` leaves for sf6–sf12.
- [ ] Only `node:*` imports; `import type` for `BatchItem`/`Tier`.

## Implementation Notes

### Files to Modify

| File Path | Action | Description |
|-----------|--------|-------------|
| `factory/src/cli/import.ts` | Create | `buildImportBatch` and private helpers |
| `factory/src/cli/import.test.ts` | Create | Fixture-based tests |
| `factory/test/fixtures/prd/**` | Create | Fixture PRD dirs (below) |

### BatchItem (sf0 contract)

sf0 exports `BatchItem` from `factory/src/shared/types.ts` (`import type { BatchItem, Tier } from '../shared/types.ts'`); do not redeclare it:

```ts
export interface BatchItem {
  ref: string; parent_ref?: string; depends_on_refs?: string[];
  type?: string; title: string; body?: string; spec_path?: string | null; tier?: Tier | null;
  test_cmd?: string | null; priority?: number; status?: ItemStatus; source_ref?: string | null;
}
```

The importer always sets `ref`, `type`, `title`, `body`, `spec_path`, `tier`, `status`, `source_ref`, plus `parent_ref`/`depends_on_refs` where applicable.

### Mapping

| Source | Item |
|---|---|
| PRD directory `<dir>` | `type: 'umbrella'` if any leaf `spec` ends in `PRD.md`, else `'prd'`. `title`: first `# ` heading of `PRD.md` (text after `# `). `body`: the `## Objective` section (text up to the next `## `, trimmed). `source_ref`: `prd:<dir-name>`. `status: 'ready'`. `spec_path`: repo-relative `PRD.md`. |
| Top-level entry with `subtasks` | `type: 'group'`, parent = the PRD/umbrella item. `title`/`body` = `name`/`description`. `source_ref`: `prd:<dir-name>#<name>`. `status: 'ready'`. |
| Leaf with spec under `specs/` | `type: 'task'`, parent = PRD item or group. `title`/`body` = `name`/`description`. `spec_path`: repo-root-relative (`path.relative(root, resolved)`). `tier`: parsed (below) or `null`. `status`: `draft→draft`, `defined→ready`, `in-progress→ready`, `completed→done`. `source_ref`: `prd:<dir-name>#<name>`. |
| Umbrella leaf (spec ends in `PRD.md`) | Resolve the child dir (`path.dirname` of the spec, relative to the umbrella dir — same as `ul_leaves`' `child_dir`). The umbrella leaf's stored `status` is ignored. If it has `tasks.yaml`: recurse; the child's PRD item is `ready` and its parent is the umbrella item or group. Otherwise: a single `type: 'prd'` leaf, `status: 'draft'`, title/body/spec_path from the child `PRD.md` as above, `source_ref: prd:<child-dir-name>`. |

**Tier parse**: in the spec file, find the line `## Suggested Model`; take the first non-blank line after it; if it starts with `Heavy`, `Standard`, or `Light` (case-insensitive, word boundary), lower-case it to a `Tier`. Otherwise, or with no such section, `null`.

### Dependencies

Define *leaves(entry)* as the dispatchable leaves under an entry: a `task` item, a stub `prd` leaf, or — for a recursed child PRD or a group — every such leaf below it, flattened.

- **Within a PRD**: every leaf under top-level entry *k* depends on every leaf under entry *k−1*. Subtasks of one entry have no edges among themselves.
- **Within an umbrella**: identical rule at the level boundary, flattened through children: every leaf under level *k* (including every leaf inside each child PRD of that level) depends on every leaf under level *k−1*. These edges are added on top of each child's own internal edges.
- **`plan_after_prior`**: such a level gets exactly the same edges; the flag adds no extra edges and is not otherwise represented.
- Edges reference leaves only by `ref`. No duplicates within one item's `depends_on_refs`.

### YAML invocation

```ts
import { execFileSync } from 'node:child_process';
const lib = path.join(root, 'skills/prd/scripts/lib/yq-compat.sh');
const json = execFileSync('bash',
  ['-c', 'source "$1" && require_yaml_tools && yaml_to_json "$2"', '_', lib, tasksFile],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
```

On non-zero exit, rethrow with the captured stderr as the message. `JSON.parse` the result; an empty/non-array document means no entries.

### Technical Constraints

- Pure apart from file reads and the yq subprocess: no network, no DB, no git, no writes.
- Deterministic ordering: walk entries in YAML order, depth-first, parent before children.
- Erasable TS only; `.ts` import extensions.

### Relevant Code References

- `skills/prd/scripts/lib/yq-compat.sh:49-75` — `require_yaml_tools`, `yaml_to_json`
- `skills/prd/scripts/lib/umbrella-lib.sh:58-83` — `ul_leaves`: level indexing, `plan_after_prior`, `child_dir` resolution
- `skills/prd/reference/prd-spec.md:130-225` — umbrella PRDs and `plan_after_prior`
- `skills/prd/schemas/tasks.schema.json` — input contract
- `docs/prd/sf0-factory-core/specs/sqlite-db-and-store.md` — `createItemsBatch` semantics
- `docs/prd/software-factory/tasks.yaml` — real umbrella acceptance input

## Testing Requirements

Fixtures under `factory/test/fixtures/prd/` (each `PRD.md` has a `# ` title and `## Objective`):
- `ordinary/`: 3 top-level entries — a leaf (`Heavy` spec, `defined`), a group with 2 parallel subtasks (`Light` spec `completed`, no-model spec `draft`), a leaf (`in-progress`).
- `umbrella/`: L0 leaf → `child-a/PRD.md` (has `tasks.yaml` with 2 sequential tasks); L1 group with `child-b` (has tasks) and `child-stub` (no `tasks.yaml`); L2 `plan_after_prior: true` leaf → `child-late` (no `tasks.yaml`). Children live under `umbrella/` (e.g. `umbrella/children/child-a/`) so the fixture is self-contained.

Tests (`import.test.ts`, `root` = repo root so the real yq-compat lib is used):
- [ ] Ordinary: types, titles, bodies, statuses (`defined→ready`, `completed→done`, `draft→draft`, `in-progress→ready`), tiers (`heavy`, `light`, `null`), repo-relative `spec_path`, `source_ref`s, `parent_ref`s.
- [ ] Ordinary deps: both subtasks depend on entry 0's leaf; entry 2's leaf depends on both subtasks; subtasks have no edge between them; group/PRD items have no deps.
- [ ] Umbrella: root is `umbrella`; `child-a`'s PRD item parent is the umbrella; `child-b`'s is the L1 group; stub is a `prd` leaf `draft`; every `child-b` leaf and the stub depend on every `child-a` leaf; `child-late` depends on every L1 leaf (plan_after_prior gets the same edges); `child-a`'s second task still depends on its first.
- [ ] Every `parent_ref` and `depends_on_refs` entry names a `ref` earlier in the array; refs are unique.
- [ ] Calling twice yields deep-equal output.
- [ ] Missing yq/jq: run with `PATH` pointing at a temp dir containing only `bash` (symlink) and assert the thrown message mentions yq; skip with `t.skip` if `bash` can't be located.
- [ ] Smoke: `buildImportBatch('docs/prd/software-factory', root)` contains `prd:software-factory` (type `umbrella`) and `prd:sf12-configurable-gates` (type `prd`, `draft`).

## Out of Scope

- CLI parsing, printing the tree, POSTing the batch ("factory CLI").
- The batch endpoint and idempotent skip logic (sf0).
- Updating statuses of existing items on re-import (PRD: out of scope).
- Container status roll-up and dispatch (sf5); `factory start` (CLI).
- Adding an npm YAML parser.
