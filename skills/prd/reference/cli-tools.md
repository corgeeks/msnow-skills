# Scripts
# Reference documentation for PRD workflow scripts

The following scripts are available in the `scripts/` directory relative to the skill root. All paths below are relative to the skill directory.

**YAML tooling:** every script works with either the Go (mikefarah) or Python (kislyuk) `yq` — `scripts/lib/yq-compat.sh` detects which is installed and adapts. `jq` is always required. (Python yq strips comments from `tasks.yaml` on status updates; see DEPENDENCIES.md.)

## PRD Management

### `scripts/list-prds.sh`

Lists all PRDs with their status. Returns JSON output.

```bash
scripts/list-prds.sh
# Output: [{"name": "my-feature", "status": "in-progress", "completed": 3, "total": 5,
#           "is_umbrella": false, "umbrella_parent": null}, ...]
```

**Statuses**:
- `draft` - No tasks completed
- `in-progress` - At least one but not all tasks completed
- `complete` - All tasks completed
- `no-tasks` - No tasks.yaml or no tasks defined

**Umbrella tags** (every entry):
- `is_umbrella` - `true` if this PRD's leaves point at child PRDs (a program tracker)
- `umbrella_parent` - the umbrella PRD that owns this one as a child slice, else `null`

## Task Management

### `scripts/task-status.sh <prd-name>`

Returns JSON describing task counts by status for a specific PRD.

```bash
scripts/task-status.sh my-feature
# Output: {"draft": 2, "defined": 3, "in-progress": 0, "completed": 1, "total": 6}
```

**Statuses**: `draft` (spec not written) → `defined` (ready to implement) → `in-progress` (a session started it but did not finish) → `completed`.

### `scripts/get-task.sh <prd-name> <task-name>`

Returns full task details including status, spec path, and file locations.

```bash
scripts/get-task.sh my-feature "Implement API endpoint"
# Output:
# {
#   "name": "Implement API endpoint",
#   "description": "Create the login endpoint",
#   "status": "defined",
#   "spec": "specs/implement-api-endpoint.md",
#   "spec_path": ".claude/prds/my-feature/specs/implement-api-endpoint.md",
#   "spec_exists": true,
#   "parent": null,
#   "prd_name": "my-feature",
#   "prd_path": ".claude/prds/my-feature/PRD.md",
#   "log_path": ".claude/prds/my-feature/log.md",
#   "log_exists": true,
#   "found": true
# }
```

### `scripts/list-prd-draft-tasks.sh <prd-name>`

Lists all leaf tasks (tasks without subtasks) that are in draft status.

```bash
scripts/list-prd-draft-tasks.sh my-feature
# Output: [{"name": "Implement API endpoint", "description": "...", "spec": "specs/implement-api-endpoint.md", "parent": null}, ...]
```

### `scripts/list-defined-tasks.sh <prd-name>`

Lists all tasks with `defined` status that are ready for implementation.

```bash
scripts/list-defined-tasks.sh my-feature
# Output: [{"name": "Implement API endpoint", "description": "...", "spec": "specs/implement-api-endpoint.md", "parent": null}, ...]
```

### `scripts/list-in-progress-tasks.sh <prd-name>`

Lists all leaf/subtask tasks with `in-progress` status — work a previous session
started but did not finish. A resuming session picks these up FIRST.

```bash
scripts/list-in-progress-tasks.sh my-feature
# Output: [{"name": "Implement API endpoint", "description": "...", "spec": "specs/implement-api-endpoint.md", "parent": null}, ...]
```

### `scripts/update-task-status.sh <prd-name> <task-name> <new-status>`

Updates the status of a specific task.

```bash
scripts/update-task-status.sh my-feature "Implement API endpoint" in-progress
# Valid statuses: draft, defined, in-progress, completed
```

**Auto-roll-up:** if the PRD is a child of one or more umbrella PRDs, this also
re-syncs those umbrellas so their derived leaf statuses never drift (a worker
completing a child task updates the umbrella automatically). Set
`PRD_NO_UMBRELLA_SYNC=1` to suppress it; `sync-umbrella.sh` sets that internally to
avoid a sync loop.

## Umbrella PRDs

### `scripts/umbrella-status.sh <umbrella-prd-name>`

The status board for a slate: per child, its dependency `level`, `plan_status`
(`ready-to-plan`|`requires-work`|`planned`) and `work_status`
(`needs-scaffold`|`needs-plan`|`ready`|`started`|`complete`), computed **live** from
each child's `tasks.yaml`. Read-only. Render it as `| Level | PRD | Plan | Work |`.
The `next_plan_level` / `next_work_level` pointers give the next dependency level to
plan / work, so "plan (or work) the next one" needs no hand computation. Errors
(exit 2) on a non-umbrella PRD — use `task-status.sh` for those.

`requires-work` and `blocked_plan_levels` come from the `plan_after_prior` level
gate (see `reference/prd-spec.md`, "Planning that depends on earlier
implementation"): an unplanned child in a gated level reads as `requires-work`
until every earlier level is implemented, then flips to `ready-to-plan`.

```bash
scripts/umbrella-status.sh combat-next-v2
# Output: {
#   "prd": "combat-next-v2",
#   "children": [{"level":0,"level_name":"L0 · Contract","prd":"f0-combat-contract",
#                 "plan_status":"planned","work_status":"complete","child_prd_exists":true,
#                 "counts":{"draft":0,"defined":0,"in-progress":0,"completed":7,"total":7}}, ...],
#   "levels": [...],
#   "summary": {"children":12,"levels":4,"planned":8,"ready_to_plan":1,"requires_work":1,
#               "ready":2,"started":1,"complete":5},
#   "next_plan_level": {"level":1,"name":"...","children":["f3-spatial-index"]},
#   "blocked_plan_levels": [{"level":2,"name":"L2 · Polish","children":["f8-tuning"],
#                            "waiting_on":[{"level":1,"name":"L1 · Foundation"}]}],
#   "next_work_level": {"level":1,"name":"...","ready":["f3-..."],"started":["f1-..."],"needs_plan":[]}
# }
```

### `scripts/init-umbrella-children.sh <umbrella-prd-name> [--child <name>]`

Scaffolds a stub `PRD.md` for each umbrella leaf whose child PRD doesn't exist yet
(Objective/Motivation seeded from the leaf; the rest left as planning
placeholders). With `--child`, scaffolds only that one. Idempotent — existing
child PRDs are left untouched — and it changes no statuses. Run it right after an
umbrella is shaped, then plan each child.

```bash
scripts/init-umbrella-children.sh combat-next-v2
# Output: {"umbrella": "combat-next-v2", "created": ["f2-foo"],
#          "skipped": ["f0-combat-contract","f1-live-authority-loop"],
#          "created_count": 1, "skipped_count": 2}
```

### `scripts/sync-umbrella.sh <umbrella-prd-name>`

Recomputes an umbrella PRD's leaf statuses from the live progress of its child
PRDs. An umbrella leaf's `spec` points at a child `PRD.md` (e.g.
`../f0-combat-contract/PRD.md`); this script reads each child's task-status and
maps it back:

| Child state | Umbrella leaf becomes |
|-------------|-----------------------|
| no tasks / still being planned | `draft` |
| fully planned, nothing started | `defined` |
| some tasks completed or in-progress | `in-progress` |
| all tasks completed | `completed` |

It is idempotent and leaves non-umbrella leaves (specs under `specs/`) untouched,
so it is safe to run on any PRD. You rarely need to call it directly now that
`update-task-status.sh` auto-rolls-up, but it's the manual escape hatch (and what
the optional `hooks/sync-umbrellas.sh` runs after a hand edit to a child
`tasks.yaml`).

```bash
scripts/sync-umbrella.sh combat-next-v2
# Output: {"prd": "combat-next-v2", "child_refs": 12, "changed": 1,
#          "tasks": [{"name": "...", "child": "f0-combat-contract",
#                     "from": "defined", "to": "completed", "changed": true,
#                     "child_status": {"draft":0,"defined":0,"in-progress":0,"completed":7,"total":7}}, ...]}
```

## Research Management

### `scripts/research-status.sh <prd-name>`

Returns JSON describing research question status for a specific PRD.

```bash
scripts/research-status.sh my-feature
# Output: {"draft": 1, "complete": 4, "total": 5}
```

### `scripts/get-unanswered-research.sh <prd-name>`

Returns JSON array of unanswered research questions (those without an `answer` field).

```bash
scripts/get-unanswered-research.sh my-feature
# Output: [{"text": "What library should we use for auth?", "mode": "answer"}, ...]
```

Each question includes:
- `text` - The research question
- `mode` - Either `answer` (quick search) or `deep-research` (comprehensive analysis)

## Validation

### `scripts/validate-prd.sh <prd-name>`

Validates a PRD's `tasks.yaml` and `research.yaml` against the JSON schemas under
`schemas/`, and confirms every task past the `draft` stage has an existing spec
file (for umbrella leaves, that the child `PRD.md` exists). Exits non-zero and
prints the problems if anything is invalid. Workflows call this after writing
those files. The same checks are available as PostToolUse hooks (`hooks/`) that
run automatically on every edit once wired into settings.json — see the
repository README.

```bash
scripts/validate-prd.sh my-feature
# Output: PRD 'my-feature' is valid.
```

Requires `check-jsonschema` in addition to `jq`/`yq`.
